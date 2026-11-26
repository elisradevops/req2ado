"""Short titles for the requirements a document's grammar built (app.leveling.document_grammar), in both modes.

A requirement exported from a requirements tool is a code and a sentence; its title was the sentence cut at a word boundary, which a
project manager cannot scan. One batched model call per chunk writes a short title per requirement; code keeps it only when it is
grounded -- every significant word of the title is a word of the requirement's own text (by its stem: "receives" for "shall receive"),
so no code and no invented fact; no obligation word; a few words -- and otherwise keeps the extracted title. The description is never touched: it stays the
document's words.

Fail-open: a failed or partial answer keeps the extracted titles of the requirements it did not cover, with one warning per failed chunk.
The client caches each requirement's answer by its text (OrchestratorLlmClient.requirement_titles), so a re-run of the same file asks the
model only for requirements it has not seen."""

from __future__ import annotations

import logging
import re
from collections import Counter
from typing import Protocol

from app.distillation.title import SHORTENED
from app.leveling.bounded_chunks import run_chunks_bounded
from app.leveling.grounding import significant_words
from app.workitem.model import IntegrityWarning, WarningKind, WorkItemNode, WorkItemType

logger = logging.getLogger(__name__)

# Bump when the prompt or the checks below change meaning: part of every cached answer's key.
TITLE_PASS_VERSION = "2"
CHUNK_SIZE = 150
MAX_TITLE_WORDS = 14  # the prompt asks for 3-10; values and units ("100 V to 240 V at 50 Hz or 60 Hz") count as words
MAX_TITLE_CHARS = 90

# Words a title may use to join the requirement's own words ("Speakers mute when headphones are plugged in"): never a fact of their own.
_JOINING = frozenset("a an the of to in on at for and or by with its it be is are from as into than per up under over not does both when re".split())
# Another form of the same word (owner probe, 2026-11-26: "Ethernet connection" for "shall connect", "Storage" for "be stored", "while held"
# for "is held" were refused): derivational endings, and the few irregular verb forms requirements use. Never a word of its own.
_DERIVED = ("ion", "age", "ment", "able", "ance", "ence")  # "operation" -> "operat", as "operate" -> "operat"
_IRREGULAR = {"held": "hold", "holding": "hold", "holds": "hold", "sent": "send", "kept": "keep", "built": "build", "made": "make", "ran": "run", "shown": "show"}
_DIGIT_GROUP = re.compile(r"(?<=\d)[ \u00a0\u202f](?=\d{3}\b)")
_OBLIGATION = re.compile(r"\b(shall|must|should|will)\b", re.IGNORECASE)


class RequirementTitleClient(Protocol):
    def requirement_titles(self, texts_by_id: dict[str, str], user_id: str | None = None) -> dict[str, dict]: ...


def was_shortened(node: WorkItemNode) -> bool:
    """The build cut this item's title to the Azure DevOps limit (app.distillation.title.shortened_title): it ends in the marker, and the
    text it was cut from is the first part of its description (owner rule R6)."""
    return node.title.endswith(SHORTENED) and " ".join(statement_of(node).split()).startswith(node.title[: -len(SHORTENED)])


def statement_of(node: WorkItemNode) -> str:
    """The requirement's own text: its description without the trace (after the blank line)."""
    return node.description.split("\n\n", 1)[0]


def _stem(word: str) -> str:
    if word in _IRREGULAR:
        return _IRREGULAR[word]
    if word.endswith("ies") and len(word) > 4:
        return word[:-3] + "y"
    for suffix in ("ing", "es", "ed", "s"):
        if len(word) > (4 if suffix == "ed" else 3) and word.endswith(suffix) and not (suffix == "s" and word.endswith("ss")):
            word = word[: -len(suffix)]
            break
    for suffix in _DERIVED:
        if word.endswith(suffix) and len(word) - len(suffix) >= 4:  # a short word ("nation", "image") is left whole
            word = word[: -len(suffix)]
            break
    return word[:-1] if len(word) > 3 and word.endswith("e") else word


def _stems(text: str) -> set[str]:
    # "3 000" and "3000" are one number.
    return {_stem(w) for w in significant_words(_DIGIT_GROUP.sub("", text))}


def _clean(title: object) -> str:
    return " ".join(title.split()).rstrip(".").strip() if isinstance(title, str) else ""


def refusal(title: object, statement: str) -> str | None:
    """Why code refuses the title the model wrote ("no_title", "too_long", "obligation", "ungrounded"), or None when it accepts it."""
    text = _clean(title)
    if not text:
        return "no_title"
    if len(text) > MAX_TITLE_CHARS or len(text.split()) > MAX_TITLE_WORDS:
        return "too_long"
    # No separate code check: the requirement's code is not part of its text (it is the Customer ID), so a code in the title is ungrounded.
    if _OBLIGATION.search(text):
        return "obligation"
    wanted = _stems(text) - {_stem(w) for w in _JOINING}
    return None if wanted and wanted <= _stems(statement) else "ungrounded"


def checked_title(title: object, statement: str) -> str | None:
    """The title the model wrote, if code accepts it: a few words, no code, no obligation word, and every significant word grounded in
    the requirement's own text. None otherwise (the extracted title is kept)."""
    return _clean(title) if refusal(title, statement) is None else None


def write_requirement_titles(
    nodes: list[WorkItemNode],
    client: RequirementTitleClient,
    warnings: list[IntegrityWarning],
    user_id: str | None = None,
    concurrency: int = 1,
    grammar_requirements: bool = True,
) -> int:
    """Writes a short title on every grammar-built Requirement (`verbatim`; unless `grammar_requirements` is False, the file giving each
    requirement its own title) and on every item of any type whose title the build had to shorten to the Azure DevOps limit (R6: the model
    decides how to name it), when the model's answer grounds it; returns how many it wrote. Chunks are merged in their own order, so the result
    does not depend on which chunk answers first."""
    targets = [
        n for n in nodes if grammar_requirements and n.verbatim and n.type == WorkItemType.REQUIREMENT or was_shortened(n)
    ]
    if not targets:
        return 0
    chunks = [targets[i : i + CHUNK_SIZE] for i in range(0, len(targets), CHUNK_SIZE)]
    payloads = [{n.local_id: statement_of(n) for n in chunk} for chunk in chunks]
    written = 0
    refused: Counter[str] = Counter()
    # A title that only repeats its parent's ("Picture modes" under "Picture modes") tells a reader nothing: refused (probe, 2026-11-26).
    parent_title = {n.local_id: _clean(n.title).casefold() for n in nodes}
    outcomes = run_chunks_bounded(payloads, lambda payload: client.requirement_titles(payload, user_id=user_id), concurrency)
    for chunk, outcome in zip(chunks, outcomes):
        if outcome.error is not None or not isinstance(outcome.value, dict):
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.ENHANCEMENT_CALL_FAILED,
                    f"Short titles could not be written for {len(chunk)} requirement(s); they keep the title taken from their text.",
                    node_ids=[n.local_id for n in chunk],
                    detail={"pass": "requirement_titles"},
                )
            )
            continue
        chunk_written = 0
        for node in chunk:
            entry = outcome.value.get(node.local_id)
            answer = entry.get("title") if isinstance(entry, dict) else None
            why = refusal(answer, statement_of(node))
            if why is None and _clean(answer).casefold() == parent_title.get(node.parent_local_id or ""):
                why = "repeats_parent"
            if why is not None:
                refused[why] += 1
                continue
            node.title = _clean(answer)
            chunk_written += 1
        written += chunk_written
        # An answer that gave not one usable title is a failure of the call, not a few refusals: say so, as for a call that failed outright.
        if chunk_written == 0:
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.ENHANCEMENT_CALL_FAILED,
                    f"Short titles could not be written for {len(chunk)} requirement(s): the model's answer had no title grounded in their "
                    "text. They keep the title taken from their text.",
                    node_ids=[n.local_id for n in chunk],
                    detail={"pass": "requirement_titles"},
                )
            )
    if refused:
        # Numbers only (no text: a production log must not hold the document's words), so a probe can tell why titles were kept.
        logger.info("Short titles: %d written, %d kept from the text (%s)", written, sum(refused.values()),
                    ", ".join(f"{why} {n}" for why, n in sorted(refused.items())))  # fmt: skip
    return written
