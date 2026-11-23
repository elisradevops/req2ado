# ingestion/app/prompts/assembly.py
"""The one place that turns a prompt and its data into the messages sent to a model.

Instructions are trusted: they come only from prompt files (`load_prompt`), and a marker fills in a value code computed (a count,
the output-format sentence, a fixed vocabulary). Everything a document, a knowledge base or a user supplied is untrusted: it goes into
the USER message as a `DataBlock`, inside its own tag, never into the system prompt. A block's text cannot open or close any block of
the call, nor any authority's tag (every such tag inside it is broken, the technique orchestrator/src/modules/pipeline/document-summary.ts
uses for its one tag), so injected text cannot fake the end of one block and the start of another. The system prompt opens
with one guard preamble that names each block present and what it may be used for (its authority):

- source: the material to work on, the only source of facts and values;
- reference: knowledge-base snippets, possibly irrelevant, never a source of values;
- org_standard: the organization's writing conventions, which never change the output format, the ids or counts, or the rule
  against inventing values;
- rubric: the organization's standard for judging a requirement, authoritative for that judgment, never a source of values;
- background: context about the whole document, never a source of values.

tests/test_prompt_assembly.py fails when a messages list is built anywhere else in app/."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal

from app.prompts import _read, load_prompt, resolve_version

Authority = Literal["source", "reference", "org_standard", "rubric", "background"]
_AUTHORITIES: frozenset[str] = frozenset(
    {"source", "reference", "org_standard", "rubric", "background"}
)
_TAG_PATTERN = re.compile(r"^[a-z][a-z_]*$")
_GUARD = "fragment_prompt_guard"
# Blocks whose text is the same on every call of a prompt within a job, so a prompt cache can reuse them: knowledge-base text, the rubric,
# the organization's conventions, the document's background, and the fixed vocabularies sent as source (the scoring categories, the
# link-type catalog). Criteria retrieved per batch (reference tagged "criteria") are not: they differ from call to call.
_STABLE_AUTHORITIES = frozenset({"reference", "rubric", "org_standard", "background"})
_STABLE_SOURCE_TAGS = frozenset({"category_names", "link_types"})


def _is_stable(block: DataBlock) -> bool:
    if block.authority == "source":
        return block.tag in _STABLE_SOURCE_TAGS
    return block.authority in _STABLE_AUTHORITIES and block.tag != "criteria"


@dataclass(frozen=True)
class DataBlock:
    """Untrusted text for the user message. `tag` names the block in the prompt (defaults to the authority's name), so one call can
    carry two blocks of the same authority (the item and its tables are both `source`)."""

    authority: Authority
    content: str
    tag: str | None = None

    def __post_init__(self) -> None:
        if self.authority not in _AUTHORITIES:
            raise ValueError(f"unknown data-block authority {self.authority!r}")
        if not _TAG_PATTERN.match(self.name):
            raise ValueError(
                f"data-block tag {self.name!r} must be lower-case letters and underscores"
            )

    @property
    def name(self) -> str:
        return self.tag or self.authority


@dataclass(frozen=True)
class PromptIdentity:
    """Which prompt produced an answer: its name, the version loaded and a hash of every prompt file the call's instructions were
    built from (markers excluded, so the same files give the same hash whatever the counts were)."""

    name: str
    version: int
    sha256: str

    def as_dict(self) -> dict[str, object]:
        return {"name": self.name, "version": self.version, "sha256": self.sha256}

    def __str__(self) -> str:
        return f"{self.name}.v{self.version}@{self.sha256[:12]}"


@dataclass(frozen=True)
class PromptCall:
    """A built call: the system prompt (instructions only), any earlier turns of a conversation, and the user message (the data
    blocks, then the user's own text when there is one). The only way to make one is `build_call`."""

    identity: PromptIdentity
    system: str
    user: str
    history: tuple[tuple[str, str], ...] = ()
    # How many leading characters of `user` are the same on every call of this prompt in a job (the stable blocks, see _STABLE_BLOCKS):
    # where a prompt-cache breakpoint can go. 0 when the message starts with this call's own data.
    cache_prefix: int = 0

    def messages(self, mark_cache: bool = False) -> list[dict[str, object]]:
        """The messages. With `mark_cache` and a stable prefix (cache_prefix), the user message is two text parts that join back to
        it exactly, the first marked as a prompt-cache breakpoint."""
        user: object = self.user
        if mark_cache and self.cache_prefix > 0:
            user = [
                {"type": "text", "text": self.user[: self.cache_prefix], "cache_control": {"type": "ephemeral"}},
                {"type": "text", "text": self.user[self.cache_prefix :]},
            ]
        return [
            {"role": "system", "content": self.system},
            *({"role": role, "content": content} for role, content in self.history),
            {"role": "user", "content": user},
        ]

    def payload(self, params: Mapping[str, object], mark_cache: bool = False) -> dict[str, object]:
        """The request body: the messages plus the model parameters (temperature, schema, limits) the caller sets."""
        return {"messages": self.messages(mark_cache), **params}


@dataclass(frozen=True)
class Fragment:
    """A marker value that is itself a fragment prompt file: loaded by `build_call` and counted in the call's identity. Its own
    `markers` (code-computed values, like a count, or other fragments) fill the fragment's placeholders."""

    name: str
    markers: Mapping[str, str | Fragment] = field(default_factory=dict)

    def files(self) -> list[str]:
        """This fragment's file and every fragment nested in its markers."""
        nested = [f for v in self.markers.values() if isinstance(v, Fragment) for f in v.files()]
        return [self.name, *nested]


def render_fragment(fragment: Fragment) -> str:
    """The fragment's text, its markers filled: what `build_call` puts in place of the marker that names it."""
    filled = {
        key: render_fragment(value) if isinstance(value, Fragment) else value
        for key, value in fragment.markers.items()
    }
    return load_prompt(fragment.name, **filled)


def render_block(block: DataBlock, reserved: frozenset[str] = frozenset()) -> str:
    """`block` in its tag. Every opening or closing tag inside its text whose name is the block's own, an authority's or one of
    `reserved` (the other blocks of the call) is broken with a space, so the text cannot end its block or start another."""
    names = "|".join(sorted({block.name, *_AUTHORITIES, *reserved}))
    body = re.sub(
        rf"<\s*(/?)\s*({names})\s*>",
        lambda m: f"< {m.group(1)}{m.group(2)}>",
        block.content,
        flags=re.IGNORECASE,
    )
    return f"<{block.name}>\n{body}\n</{block.name}>"


def block_text(user: str, tag: str = "source") -> str | None:
    """The text of the first `<tag>` block in a rendered user message (what `render_block` wrapped), or None when it has none: how
    a reader of a request (a test double, the prompt evaluation harness) gets back the data a call carried."""
    match = re.search(rf"<{tag}>\n(.*?)\n</{tag}>", user, flags=re.DOTALL)
    return match.group(1) if match else None


def _guard(blocks: Sequence[DataBlock]) -> str:
    lines: list[str] = []
    seen: set[str] = set()
    for block in blocks:
        if block.name in seen:
            continue
        seen.add(block.name)
        lines.append(f"- <{block.name}>: {load_prompt(f'fragment_authority_{block.authority}')}")
    return load_prompt(_GUARD, blocks="\n".join(lines))


def build_call(
    name: str,
    *,
    blocks: Sequence[DataBlock],
    markers: Mapping[str, str | Fragment] | None = None,
    version: int | None = None,
    before: Sequence[str] = (),
    after: Sequence[str | Fragment] = (),
    history: Sequence[Mapping[str, str]] = (),
    user_text: str | None = None,
) -> PromptCall:
    """The call for prompt `name`. `markers` fill its `__NAME__` placeholders and must be values code produced, never document or
    knowledge-base text (that is what `blocks` are for); a `Fragment` value is a fragment file's text. `before` / `after` are fragment
    prompt files placed around it (an `after` entry may be a `Fragment`, for one with markers of its own). `history`
    is a conversation's earlier turns ({"role", "content"}), and `user_text` the user's own words for this turn, placed after the
    blocks."""
    if len({b.name for b in blocks}) != len({(b.name, b.authority) for b in blocks}):
        raise ValueError("one data-block tag cannot carry two authorities")
    resolved = resolve_version(name, version)
    marker_fragments = [
        f for v in (markers or {}).values() if isinstance(v, Fragment) for f in v.files()
    ]
    filled = {
        key: render_fragment(value) if isinstance(value, Fragment) else value
        for key, value in (markers or {}).items()
    }
    instructions = [
        *(load_prompt(fragment) for fragment in before),
        load_prompt(name, resolved, **filled),
        *(
            render_fragment(fragment) if isinstance(fragment, Fragment) else load_prompt(fragment)
            for fragment in after
        ),
    ]
    system = "\n\n".join([_guard(blocks), *instructions] if blocks else instructions)
    reserved = frozenset(b.name for b in blocks)
    rendered = [render_block(b, reserved) for b in blocks]
    user = "\n\n".join([*rendered, *([user_text] if user_text else [])])
    # The stable prefix: the leading run of stable blocks, ending right after the last of them (the separator belongs to the rest).
    stable = 0
    while stable < len(blocks) and _is_stable(blocks[stable]):
        stable += 1
    cache_prefix = len("\n\n".join(rendered[:stable])) if stable and stable < len(rendered) + (1 if user_text else 0) else 0
    files = [
        (name, resolved),
        *(
            (f, resolve_version(f))
            for f in (
                *before,
                *(n for a in after for n in (a.files() if isinstance(a, Fragment) else [a])),
                *marker_fragments,
            )
        ),
    ]
    if blocks:
        files += [(_GUARD, resolve_version(_GUARD))]
        files += [
            (f"fragment_authority_{a}", resolve_version(f"fragment_authority_{a}"))
            for a in sorted({b.authority for b in blocks})
        ]
    digest = hashlib.sha256()
    for file_name, file_version in sorted(files):
        digest.update(f"{file_name}.v{file_version}\0{_read(file_name, file_version)}\0".encode())
    return PromptCall(
        identity=PromptIdentity(name, resolved, digest.hexdigest()),
        system=system,
        user=user,
        history=tuple((turn["role"], turn["content"]) for turn in history),
        cache_prefix=cache_prefix,
    )
