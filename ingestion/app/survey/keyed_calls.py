"""Keyed LLM calls: "ask about N ids, get N validated entries back".

Every pass that answers "one entry per id" (title/tag, synthesis, parent summary,
scoring, authoring, mapping, KB relevance) used to write its output contract three
times -- in the prompt prose, in a hand-built JSON schema, and in the merge code that
consumes the answer -- and each pass repeated its own parse/omission handling. The
open-map schema those passes used is not valid strict JSON Schema on Anthropic or
OpenAI/Azure (both require `additionalProperties: false`) and collapsed to `{}` in
prod; listing every key per call exceeds provider grammar/size limits. See
`keyed_schema_mode` in app.config for the three modes and why.

This module is the single owner of that contract for the passes migrated to it:

* `KeyedSpec` -- ONE description of an entry (its fields); the prompt's output-format
  sentence (`describe_output`) and the strict schema (`items_schema`) are both generated
  from it, so they cannot drift.
* the wire format -- `{"items": [{"id": "<input id>", <fields>}]}`: a fixed, tiny schema
  whatever the number of ids.
* `parse_keyed` / `normalize_keyed_result` -- tolerant reading of what a model actually
  sends back (the array format, the legacy id->entry map, one wrapper key, stray
  whitespace in ids).
* `run_keyed` -- one call, plus ONE bounded retry of the omitted ids in halves, returning
  `KeyedEntries`: a plain dict (so every existing consumer keeps working unchanged) that
  also records what was requested, what is missing and why.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Collection, Mapping
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Literal

from app.config import settings
from app.workitem.model import MODEL_KEY

logger = logging.getLogger(__name__)

KeyedMode = Literal["none", "legacy_map", "array"]


@dataclass(frozen=True)
class KeyedSpec:
    """One keyed pass's entry contract.

    `name` -- the pass name, used for the KEYED_SCHEMA_PASSES switch and in logs.
    `schema_name` -- the response schema's name.
    `fields` -- entry field name -> JSON schema of that field. All fields are required.
    `field_prompts` -- the same field names -> how the prompt describes each one
    ("'title' (string)"); must have exactly the keys of `fields`.
    `id_noun` -- what an id is called in the prompt ("row id", "node id").
    `legacy_schema` -- factory for the original open-map schema (legacy_map mode only).
    `legacy_output` -- the prompt's output-format sentence exactly as it was written before the pass
    moved here, for a pass whose entries are not objects (the default sentence says "each mapped to an
    object with ..."); used verbatim in the non-array modes.
    """

    name: str
    schema_name: str
    fields: Mapping[str, dict]
    field_prompts: Mapping[str, str]
    id_noun: str = "row id"
    legacy_schema: Callable[[], dict] | None = None
    legacy_output: str | None = None
    # Other field names that still make an entry an answer (not a cut-off fragment): an older form of the entry the caller can still read,
    # e.g. scoring's named categories beside its levels by position. Only the "is this an answer" check reads it; the prompt and the
    # schema describe `fields`.
    also_answers: tuple[str, ...] = ()

    @property
    def answer_fields(self) -> tuple[str, ...]:
        return (*self.fields, *self.also_answers)

    def __post_init__(self) -> None:
        if set(self.fields) != set(self.field_prompts):
            raise ValueError(
                f"KeyedSpec {self.name!r}: fields {sorted(self.fields)} and field_prompts "
                f"{sorted(self.field_prompts)} must name the same fields"
            )
        if "id" in self.fields:
            raise ValueError(f"KeyedSpec {self.name!r}: 'id' is reserved for the wire format")


def _forced_passes() -> set[str]:
    return {name.strip() for name in settings.keyed_schema_passes.split(",") if name.strip()}


# (pass name, model) pairs for which the array schema produced nothing usable even though the same
# call, prompt-only, did. The array schema is a documented, supported shape, but the route this
# deployment uses to reach the model (Open WebUI -> LiteLLM -> the provider) is not covered by any
# vendor's documentation, and how structured output interacts with thinking/temperature is not stated
# anywhere; so instead of assuming it works, the first time it demonstrably does not, this pair drops
# to prompt-only for the rest of the process (a restart tries the schema again).
_degraded: set[tuple[str, str | None]] = set()

# The model that answered this thread's last /llm/chat call, when a router (the gateway's `Auto`) named it; None when the answer named
# none. Set by the client on every answer and read right after `send` returns, in the same thread (production finding F7).
_answered_by: ContextVar[str | None] = ContextVar("answered_by", default=None)


def note_answered_by(model: str | None) -> None:
    """Records which model a router sent this thread's last call to (None: the answer did not say)."""
    _answered_by.set(model)


def answered_by() -> str | None:
    """The model a router sent this thread's last call to, or None when the answer did not say."""
    return _answered_by.get()
_degraded_lock = threading.Lock()


def is_degraded(spec: KeyedSpec, model: str | None) -> bool:
    with _degraded_lock:
        return (spec.name, model) in _degraded


def _mark_degraded(spec: KeyedSpec, model: str | None) -> None:
    with _degraded_lock:
        _degraded.add((spec.name, model))


def reset_degraded() -> None:
    """Forgets every degradation (tests, and an operator-driven retry via restart)."""
    with _degraded_lock:
        _degraded.clear()


def mode_for(spec: KeyedSpec, model: str | None = None) -> KeyedMode:
    """The mode this pass runs in: "array" when it is named in KEYED_SCHEMA_PASSES or the
    global default is "array" -- unless that pair has been degraded for `model` (see above) --
    else the global default."""
    wants_array = spec.name in _forced_passes() or settings.keyed_schema_mode == "array"
    if wants_array:
        return "none" if is_degraded(spec, model) else "array"
    return settings.keyed_schema_mode


def items_schema(spec: KeyedSpec) -> dict:
    """The fixed strict schema for the array wire format. Closed objects, every field
    required, no open maps, no min/max -- valid on Anthropic and OpenAI/Azure strict
    modes, and constant-size however many ids a call carries."""
    entry_properties = {"id": {"type": "string"}, **spec.fields}
    return {
        "name": spec.schema_name,
        # Every property required and every object closed, so this qualifies for strict mode -- which
        # OpenAI and Azure OpenAI need in order to actually enforce the schema.
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": entry_properties,
                        "required": list(entry_properties),
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["items"],
            "additionalProperties": False,
        },
    }


def schema_for(spec: KeyedSpec, mode: KeyedMode) -> dict | None:
    """The `responseSchema` to send for `spec` in `mode` (None = send no strict schema)."""
    if mode == "array":
        return items_schema(spec)
    if mode == "legacy_map" and spec.legacy_schema is not None:
        return spec.legacy_schema()
    return None


def _array_prefix(spec: KeyedSpec) -> str:
    return (
        f'Return ONLY a JSON object of the form {{"items": [...]}} whose "items" array has exactly one '
        f"element for EVERY {spec.id_noun} in the input, in the same order; each element is an object with "
        f'"id" (the {spec.id_noun}, copied exactly from the input)'
    )


def output_lead(spec: KeyedSpec, mode: KeyedMode) -> str:
    """Only the opening of the output-format sentence, up to where the fields start -- for a prompt
    that describes its own fields in its own words (scoring), so it still gets the wire format from
    one place. The prompt text continues with the first field."""
    if mode == "array":
        return f"{_array_prefix(spec)},"
    return f"Return ONLY a JSON object with the SAME {spec.id_noun} keys, each mapped to an object with"


def describe_output(spec: KeyedSpec, mode: KeyedMode) -> str:
    """The prompt's output-format sentence for `spec` in `mode`, generated from the same
    field list the schema is built from."""
    described = [spec.field_prompts[name] for name in spec.fields]
    fields = (
        described[0]
        if len(described) == 1
        else " and ".join(described)
        if len(described) == 2
        else ", ".join(described[:-1]) + ", and " + described[-1]
    )
    if mode == "array":
        return f"{_array_prefix(spec)} and {fields}."
    if spec.legacy_output is not None:
        return spec.legacy_output
    return f"Return ONLY a JSON object with the SAME {spec.id_noun} keys, each mapped to an object with {fields}."


def wrap_scalar_entries(parsed: object, field: str) -> object:
    """For a pass whose legacy answer maps each id to a bare value (`{"0": "relevant"}`): the same
    answer as `{"0": {field: "relevant"}}`, which is the entry shape the rest of this module reads.
    Anything else (the array format, a wrapper around such a map, garbage) is returned as it came."""
    if not isinstance(parsed, dict) or not parsed:
        return parsed
    if all(
        isinstance(value, (str, int, float, bool)) or value is None for value in parsed.values()
    ):
        return {key: {field: value} for key, value in parsed.items()}
    if len(parsed) == 1:
        ((key, inner),) = parsed.items()
        if isinstance(inner, dict) and inner and all(isinstance(v, str) for v in inner.values()):
            return {key: wrap_scalar_entries(inner, field)}
    return parsed


def normalize_keyed_result(
    result: object, requested_ids: list[str], fields: Collection[str] | None = None
) -> dict:
    """What the model sent back as a plain id -> entry dict, tolerant of the harmless
    deviations seen in practice: the array wire format (`{"items":[{"id":...}]}`, or a
    bare array of the same), the legacy id->entry map, the whole answer wrapped in one
    extra key, and stray whitespace around ids. A wrapper is only unwrapped when the
    inner object actually contains requested ids, so a genuine one-entry answer is never
    mistaken for one. Anything unusable yields {}."""
    entries = _normalize_shapes(result, requested_ids)
    if fields is None:
        return entries
    # An entry that carries none of the contract's fields is not an answer: a response cut off by the
    # token limit is repaired by the JSON reader into `{"id": "x"}` for the element it stopped in, which
    # would otherwise count as "returned" and never be asked again.
    return {
        key: value
        for key, value in entries.items()
        if isinstance(value, dict) and any(f in value for f in fields)
    }


def _normalize_shapes(result: object, requested_ids: list[str]) -> dict:
    wanted = set(requested_ids)

    def from_array(elements: object) -> dict:
        if not isinstance(elements, list):
            return {}
        entries: dict = {}
        for element in elements:
            if isinstance(element, dict) and isinstance(element.get("id"), (str, int)):
                entries.setdefault(
                    str(element["id"]).strip(), {k: v for k, v in element.items() if k != "id"}
                )
        return entries

    if isinstance(result, list):
        entries = from_array(result)
        return entries if wanted & entries.keys() else {}
    if not isinstance(result, dict):
        return {}
    if isinstance(result.get("items"), list):
        entries = from_array(result["items"])
        if wanted & entries.keys():
            return entries
    normalized = {key.strip(): value for key, value in result.items() if isinstance(key, str)}
    if wanted & normalized.keys():
        return normalized
    if len(result) == 1:
        # The whole answer under one extra key: read what is inside it the same way (each level
        # peels one wrapper, so this ends).
        inner = next(iter(result.values()))
        if isinstance(inner, (dict, list)):
            unwrapped = _normalize_shapes(inner, requested_ids)
            if wanted & unwrapped.keys():
                return unwrapped
    return normalized


def drop_possibly_cut_last_entry(parsed: object) -> object:
    """For an answer that ended because the model hit its token limit: the LAST entry may have been
    cut mid-value (and then repaired into something that parses but is wrong -- a title that stops
    half way), so it is not trusted and is asked for again. Applies to the array wire format
    (`{"items": [...]}`) and to an id -> entry map; any other shape (a verdict object, a link list)
    is returned untouched."""
    if isinstance(parsed, dict) and isinstance(parsed.get("items"), list) and parsed["items"]:
        return {**parsed, "items": parsed["items"][:-1]}
    if (
        isinstance(parsed, dict)
        and len(parsed) >= 2
        and all(isinstance(value, dict) for value in parsed.values())
    ):
        keys = list(parsed)
        return {key: parsed[key] for key in keys[:-1]}
    return parsed


def retry_omitted(
    result: dict,
    ids: list[str],
    payload: Mapping[str, object],
    send: Callable[[dict], object],
    label: str,
    fields: Collection[str] | None = None,
    accept: Callable[[str, object], bool] | None = None,
) -> tuple[dict, int]:
    """ONE bounded retry of the ids `result` lacks, in halves. Returns (merged result,
    number of extra calls made). Cost is bounded by design: only the omitted ids are
    re-sent, each half at most once, and the retry stops as soon as a half yields nothing
    -- so a systematic fault costs at most ONE extra call, not one per half. A retry call
    that raises is swallowed (fail-open, same as the pass itself): the ids stay omitted. An entry `accept` refuses counts as omitted."""
    missing = [node_id for node_id in ids if node_id not in result]
    if not missing:
        return result, 0
    middle = (len(missing) + 1) // 2
    halves = [half for half in (missing[:middle], missing[middle:]) if half]
    merged = dict(result)
    calls = 0
    for half in halves:
        calls += 1
        try:
            half_result = normalize_keyed_result(
                send({node_id: payload[node_id] for node_id in half}), half, fields
            )
        except Exception as exc:  # noqa: BLE001 -- the retry is best-effort; the ids just stay omitted
            logger.warning("%s retry for %d omitted id(s) failed: %s", label, len(half), exc)
            break
        matched = _accepted(
            {node_id: half_result[node_id] for node_id in half if node_id in half_result},
            accept,
            label,
            half,
        )
        if not matched:
            break
        merged.update(matched)
    return merged, calls


class KeyedEntries(dict):
    """`dict[id -> entry]` (so existing consumers keep working unchanged) that also
    records what was asked and how it went: `requested` ids, `missing` ids, and
    `reason` -- None when every id came back, "partial" when some did, and
    "no_matching_keys" when NONE did (a systematic failure, not an omission)."""

    requested: list[str]
    missing: list[str]
    reason: str | None
    # The mode that produced the entries, and whether it was reached by falling back from "array".
    mode: KeyedMode
    degraded: bool

    def __init__(
        self,
        entries: Mapping,
        requested: list[str],
        mode: KeyedMode = "none",
        degraded: bool = False,
    ) -> None:
        super().__init__(entries)
        self.mode = mode
        self.degraded = degraded
        self.requested = requested
        self.missing = [node_id for node_id in requested if node_id not in entries]
        if not self.missing:
            self.reason = None
        elif len(self.missing) == len(requested):
            self.reason = "no_matching_keys"
        else:
            self.reason = "partial"


def _accepted(
    entries: dict, accept: Callable[[str, object], bool] | None, label: str, ids: list[str]
) -> dict:
    """`entries` without the ones `accept` refuses; a refusal is logged on a line of its own (ids only, never content)."""
    if accept is None:
        return entries
    kept = {node_id: entry for node_id, entry in entries.items() if accept(node_id, entry)}
    refused = [node_id for node_id in ids if node_id in entries and node_id not in kept]
    if refused:
        logger.warning(
            "%s: %d entr%s refused by the caller's check: %s",
            label,
            len(refused),
            "y" if len(refused) == 1 else "ies",
            [node_id[:40] for node_id in refused[:10]],
        )
    return kept


def _usable(entries: dict, ids: list[str]) -> bool:
    return any(node_id in entries for node_id in ids)


def _noting_answering_model(send: Callable[[dict, KeyedMode], object], model: str | None) -> Callable[[dict, KeyedMode], object]:
    """`send`, with every entry of each answer noting the model that answered it (MODEL_KEY): the one a router named, else `model`."""

    def noting(payload: dict, mode: KeyedMode) -> object:
        note_answered_by(None)
        raw = send(payload, mode)
        by = answered_by() or model
        if by is not None:
            for entry in _answer_entries(raw):
                entry[MODEL_KEY] = by
        return raw

    return noting


def _answer_entries(raw: object) -> list[dict]:
    """The entry objects of an answer in the shapes normalize_keyed_result reads (array, `items`, id map, one wrapper around a map)."""
    if isinstance(raw, dict) and isinstance(raw.get("items"), list):
        raw = raw["items"]
    elif isinstance(raw, dict) and len(raw) == 1:
        (inner,) = raw.values()
        if isinstance(inner, dict) and inner and all(isinstance(value, dict) for value in inner.values()):
            raw = inner
    values = raw if isinstance(raw, list) else list(raw.values()) if isinstance(raw, dict) else []
    return [value for value in values if isinstance(value, dict)]


def run_keyed(
    send: Callable[[dict, KeyedMode], object],
    payload: Mapping[str, object],
    spec: KeyedSpec,
    model: str | None = None,
    retry: bool = True,
    accept: Callable[[str, object], bool] | None = None,
) -> KeyedEntries:
    """One keyed call: `send(payload, mode)` returns the parsed JSON the model produced (it must
    build its own request from `payload` and `mode`, so a retry can send a subset and a fallback
    can send no schema); omissions get one bounded retry (see `retry_omitted`); the outcome is
    logged once.

    Fallback: in "array" mode, when NOTHING usable comes back (an empty `items`, a different
    shape, a wrapper the parser cannot read, none of the requested ids) the same call is made once
    more prompt-only. Usable is judged BEFORE `accept`: well-formed entries the caller refuses say
    nothing about the schema, so they get the normal retry on the schema instead. If prompt-only
    does answer, this (pass, model) is degraded to prompt-only for the rest of the process, so the
    schema is not tried -- and paid for -- on every later chunk. Cost: one extra call, once.

    `retry=False` skips the retry of omitted ids, for a pass whose caller already decides what an
    absent id means (and whose calls are too large to repeat).

    `accept(id, entry)` is the caller's own check of an entry (for example that it is written in its source's script): an entry it
    refuses counts as omitted, so it gets the same one retry, and when the retry is refused too the id is absent and the caller keeps
    what it had."""
    ids = list(payload)
    if not ids:
        return KeyedEntries({}, [])
    mode = mode_for(spec, model)
    label = f"keyed call {spec.name}"
    send = _noting_answering_model(send, model)
    raw = send(dict(payload), mode)
    failed_by = answered_by() or model
    parsed = normalize_keyed_result(raw, ids, spec.answer_fields)
    first = _accepted(parsed, accept, label, ids)
    extra_calls = 0
    degraded = False
    fallback_failed = False
    if mode == "array" and not _usable(parsed, ids):
        extra_calls += 1
        fallback_raw = send(dict(payload), "none")
        fallback_parsed = normalize_keyed_result(fallback_raw, ids, spec.answer_fields)
        fallback = _accepted(fallback_parsed, accept, label, ids)
        if _usable(fallback_parsed, ids):
            # Under a router, what failed is the model the schema call was sent to; `Auto` itself is degraded only when the answer
            # did not name one (it is then its own unknown model).
            _mark_degraded(spec, failed_by)
            logger.warning(
                "keyed call %s: the array schema returned none of the %d requested ids but the same call "
                "prompt-only did -- using prompt-only for this pass on model=%s from now on (until restart)",
                spec.name,
                len(ids),
                failed_by,
            )
            mode, degraded, raw, parsed, first = "none", True, fallback_raw, fallback_parsed, fallback
        else:
            # Prompt-only got nothing either, so the schema is not the problem: no point retrying halves.
            fallback_failed = True
    merged, retried = (
        (first, 0)
        if fallback_failed or not retry
        else retry_omitted(
            first,
            ids,
            payload,
            lambda subset: send(subset, mode),
            f"{spec.name} keyed call",
            spec.answer_fields,
            accept,
        )
    )
    extra_calls += retried
    entries = KeyedEntries(
        {node_id: merged[node_id] for node_id in ids if node_id in merged}, ids, mode, degraded
    )
    logger.log(
        logging.INFO if entries.reason is None else logging.WARNING,
        "keyed call %s: mode=%s requested=%d matched=%d attempts=%d reason=%s%s",
        spec.name,
        mode,
        len(ids),
        len(entries),
        1 + extra_calls,
        entries.reason,
        " degraded=true" if degraded else "",
    )
    if entries.reason == "no_matching_keys" and not _usable(parsed, ids):
        # (When the ids did come back and the caller refused them, the refusal line above already said so.)
        # Ids only, never content, and each cut short: a model that answers in prose can put
        # document text in its "keys", which must never be copied into a log.
        sample = [str(key)[:40] for key in list(raw)[:3]] if isinstance(raw, dict) else []
        logger.warning(
            "keyed call %s: none of the %d requested ids came back (type=%s, top-level keys=%d, first keys=%s)",
            spec.name,
            len(ids),
            type(raw).__name__,
            len(raw) if isinstance(raw, dict) else 0,
            sample,
        )
    return entries
