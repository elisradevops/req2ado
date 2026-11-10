# ingestion/app/survey/orchestrator_llm_client.py
from __future__ import annotations

import json
import logging
import re
import time
from typing import Any, Callable

import httpx
from json_repair import repair_json

from app.job_cancel import raise_if_cancelled
from app.otel import get_tracer
from app.prompts import load_prompt
from app.section_analysis_options import DEFAULT_SECTION_ANALYSIS_OPTIONS, SectionAnalysisOptions

from app.survey._response_schemas import (
    checklist_definitions_schema,
    checklist_extraction_schema,
    distill_title_schema,
    duplicate_cluster_verdict_schema,
    duplicate_pair_verdict_schema,
    leftover_assignment_schema,
    kb_document_profile_schema,
    kb_category_consolidation_schema,
    score_explanation_schema,
    kb_document_relevance_schema,
    root_group_names_schema,
    rule_conformance_schema,
    root_grouping_schema,
    section_analysis_schema,
    section_skeleton_schema,
    trace_links_schema,
)
from app.config import settings
from app.survey.keyed_calls import (
    KeyedMode,
    describe_output,
    drop_possibly_cut_last_entry,
    output_lead,
    run_keyed,
    schema_for,
    wrap_scalar_entries,
)
from app.survey.keyed_specs import (
    AUTHOR_CONTENT_SPEC,
    EPIC_FEATURE_SCORING_SPEC,
    FIGURE_TABLE_MAPPING_SPEC,
    KB_RELEVANCE_SPEC,
    PARENT_SUMMARY_SPEC,
    SCORING_SPEC,
    SYNTHESIS_SPEC,
    TITLE_TAGS_SPEC,
)
from app.leveling.live_context import current_stage_counter, live_emitter_for, notice
from app.leveling.live_stream import DraftingDisplay
from app.leveling.model_caps import output_token_budget
from app.logging_context import current_job_id
from app.survey.llm_cache import LlmResponseCache, cache_key
from app.workitem.model import RequirementTag

logger = logging.getLogger(__name__)
_tracer = get_tracer()

_NATIVE_ADO_LINK_PREFIXES = ("System.", "Microsoft.VSTS.")


def _is_native_ado_link_type(reference_name: str) -> bool:
    return reference_name.startswith(_NATIVE_ADO_LINK_PREFIXES)


_JSON_FENCE_PATTERN = re.compile(r"^```(?:json)?\s*\n?(.*?)\n?```$", re.DOTALL)
# Same fence shape, NOT anchored to the whole string -- confirmed live (real
# job failure, qwen3.6:35b via analyze_section_agentic): unlike the other
# schema-constrained calls in this module, the agentic tool-calling path
# gets a free-form conversational reply, so nothing stops the model from
# prefacing the fence with prose ("Based on the analysis... here is the
# synthesized work-item tree:\n\n```json\n{...}\n```") -- the anchored
# pattern above never matches that shape at all, and the caller's
# subsequent raw_decode() then fails on the leading prose, crashing the
# whole SURVEY job.
_JSON_FENCE_ANYWHERE_PATTERN = re.compile(r"```(?:json)?\s*\n?(.*?)\n?```", re.DOTALL)

# httpx's default timeout (5s total) is far too short for a real local LLM —
# observed directly: a 12b-class Ollama model took several minutes to over
# ten minutes for a single cold-start inference depending on GPU/CPU
# contention on this box (subsequent warm calls are much faster, but the
# first call in a job's lifetime is not guaranteed warm, and Ollama evicts
# an idle model from memory after a few minutes by default).
#
# Sourced from settings (config.py) rather than a bare literal so it can be
# tuned per-deployment without a code change -- same numeric default as
# before this was configurable. See config.py's own doc comment for this
# rung's place in the wider SURVEY call ladder.
_LLM_REQUEST_TIMEOUT_SECONDS = settings.llm_request_timeout_seconds
# Returned by _chat_json_streaming when the call must be made the plain way.
_NOT_STREAMED = object()

# Caps output length (forwarded as maxTokens -> OpenAI-compat max_tokens ->
# Ollama's num_predict) on the three call sites that lost response_format
# (see _response_schemas.py's module docstring -- their array schemas hit
# a GBNF grammar-cost cliff). Those calls are now fully unconstrained, and
# a reasoning/"thinking" model (confirmed live: qwen3:4b) can generate an
# effectively unbounded hidden chain-of-thought before its actual answer --
# observed 40+ minute single calls with no cap in place. This does not fix
# the verbosity (see docs/runbook.md or session notes on model choice for
# that), it only bounds worst-case latency.
#
# First attempt at 8000 was too low -- observed live: a real ~200-node
# branch got cut off mid-array (genuine truncation, not just malformed
# JSON _parse_json_object can recover from) at node 40. A 150-line
# synthetic benchmark used 13,972 total tokens (thinking + answer
# combined); a real 200-line branch with denser content plausibly needs
# 18,000-20,000+. Raised to 20000 -- still a real ceiling against genuine
# runaway generation, but with headroom for a full branch-sized response
# instead of guaranteeing truncation.
_MAX_OUTPUT_TOKENS = 20000

# extract_quality_checklist: a checklist definition is a small,
# self-contained part of a document (a table or short list), not something
# that needs whole-document comprehension -- caps worst-case input size for
# this structured-extraction call. ~12,000 chars covers several pages of
# real checklist content with margin.
_CHECKLIST_EXTRACTION_MAX_CHARS = 12_000

# extract_quality_checklist's own output sanity bounds -- a real checklist
# is a short, named list of categories, not prose. Guards two distinct
# failure modes at once: (1) untrusted KB document text steering the
# extraction into returning something huge/garbled (security-adjacent --
# this stored value is replayed verbatim into every future scoring prompt
# for documents citing this KB source), and (2) a nonsense extraction (too
# few/many items) silently corrupting every later scoring call, since
# _parse_category_scores only validates score VALUES, never that the KEYS
# are sensible.
_CHECKLIST_MIN_ITEMS = 2
_CHECKLIST_MAX_ITEMS = 30
_CHECKLIST_MIN_ITEM_CHARS = 2
# extract_quality_checklist_definitions's own per-item bound -- a stated
# definition/pass-condition is prose, not a bare category name, so this is
# deliberately much larger than _CHECKLIST_MAX_ITEM_CHARS below (which
# bounds the NAME used verbatim as a categoryScores key -- see that
# method's own docstring for why names must stay short). Over-length
# values are TRUNCATED, not dropped (see _sanitize_checklist_definitions),
# since a trimmed real quote is still useful, unlike a malformed score.
_CHECKLIST_DEFINITION_MAX_CHARS = 280
_CHECKLIST_MAX_ITEM_CHARS = 60

# Retry policy for a TRANSIENT /llm/chat failure only (429/5xx) -- confirmed
# real gap: a single 500 from the LLM backend (observed live, host under
# memory pressure) previously killed an entire multi-hour SURVEY job
# outright, with zero retry anywhere in the whole chain (orchestrator's own
# OpenAI client has maxRetries:0 by deliberate design -- see
# openwebui.client.ts's own comment on why a non-idempotent, multi-minute
# call must never be blindly retried at that layer). This is NOT that same
# mistake: retries are bounded (2 extra attempts, not a storm), scoped to
# 429/5xx/network errors only (never a successful-but-slow response), and
# sit ABOVE the per-chunk fail-open safety nets in scoring.py/id_tree_builder.py
# -- most transient blips should never even reach those nets now.
_RETRYABLE_CHAT_STATUS_CODES = frozenset({429, 500, 502, 503, 504})
_MAX_CHAT_RETRY_ATTEMPTS = 3
_CHAT_RETRY_BACKOFF_SECONDS = (2.0, 8.0)
# A retryable status that arrives only AFTER the call has already run this
# long is not a transient blip: it is a call that hung (an upstream that
# returned an empty reply or dropped the connection around the ~300 s mark --
# prod job 0b9a134f lost ~15 minutes per scoring batch re-sending an identical
# request three times, twice). Re-sending the same request only multiplies the
# wait, so the failure is returned to the caller, which can split the work
# into smaller calls instead. Fast failures keep the 2 s / 8 s backoff.
_SLOW_FAILURE_SECONDS = 120.0


def _strip_json_fence(content: str) -> str:
    """Local models (Ollama included — the golden test's real target) often
    wrap JSON in markdown fences despite being explicitly told not to. Strip
    a single leading/trailing fence if present; otherwise return unchanged.
    Cheap insurance against a single fenced response failing an entire job."""
    stripped = content.strip()
    match = _JSON_FENCE_PATTERN.match(stripped)
    if match:
        return match.group(1).strip()
    match = _JSON_FENCE_ANYWHERE_PATTERN.search(stripped)
    if match:
        return match.group(1).strip()
    # Confirmed real failure, live (infer_trace_links, qwen3.6:35b, the
    # largest single-call payload in this module -- 554 nodes serialized):
    # the model prefaced its reply with bare prose and NO markdown fence at
    # all ("Based on the provided nodes..."), so neither fence pattern
    # above matches, and the caller's raw_decode() then fails at position 0
    # on the word "Based" -- crashing trace-link inference for the whole
    # job. Same "no prose" instruction violation the fence-anywhere pattern
    # already tolerates, just without the fence. If the content doesn't
    # already start with a JSON value, find the first '[' or '{' and slice
    # from there -- if no bracket exists anywhere, return unchanged so
    # _parse_json_object still raises its own honest error rather than
    # silently returning something meaningless.
    if stripped[:1] not in ("[", "{"):
        bracket_positions = [i for i in (stripped.find("["), stripped.find("{")) if i != -1]
        if bracket_positions:
            return stripped[min(bracket_positions):].strip()
    return stripped


def _parse_json_object(content: str):
    """Local models occasionally append stray trailing content after an
    otherwise complete, valid JSON value (observed live: qwen3:4b emitting
    one extra closing brace). A plain `json.loads` rejects the whole
    response even though the actual JSON value is intact. `raw_decode`
    parses only the first valid JSON value and reports where it stopped,
    so trailing garbage after a genuinely complete value no longer fails
    the whole job. A response that's malformed from the start (e.g. cut off
    mid-value) still raises -- this is tolerance for trailing noise, not a
    truncation fix.

    One further tolerance, confirmed live and deterministic at
    temperature=0 against a real 679-block AirPro document: an
    object-wrapped-array `responseSchema` (section_analysis_schema, see
    analyze_section) can make Ollama's grammar-constrained decoder stop
    generation exactly ONE character short of complete valid JSON -- the
    "nodes" array itself closes correctly, but the outer object's own
    final closing brace is never emitted. Appending a single '}' and
    retrying recovers the full, otherwise well-formed response (verified:
    all 19 nodes parsed correctly once appended). This is a targeted
    tolerance for this ONE confirmed failure shape, not a general
    auto-repair engine -- a response malformed for any other reason still
    raises exactly as before.

    A third tolerance, also confirmed live and deterministic at
    temperature=0 against a real AirPro branch: the same grammar-constrained
    decoder can omit a single NODE object's own closing brace right before
    the "nodes" array's closing bracket -- e.g. `..."tags": [...]\n  ]\n}`
    instead of `..."tags": [...]\n  }\n  ]\n}`. `json.JSONDecodeError.pos`
    marks exactly where this happens: parsing the node's object hits the
    array's closing `]` where a `,` or `}` was expected. Narrowly scoped to
    this exact shape -- only retried when the error message is literally
    "Expecting ',' delimiter" AND the offending character is `]` -- inserting
    a single '}' at that position closes the truncated node object and lets
    the rest of the response parse correctly.

    A final, general-purpose fallback (json_repair, only reached once every
    narrower tolerance above has already failed): confirmed live against a
    real AirPro job that a model can embed bare, unescaped double quotes
    INSIDE a string value for emphasis -- e.g. `"...storing the "Power-ON"
    Event..."` -- which breaks the string mid-value and produces the same
    "Expecting ',' delimiter" message as the third tolerance above, but at a
    position no single-character positional fix can repair (the string
    needs re-escaping, not a missing brace). Rather than writing a new
    narrow, positional heuristic for every fresh malformation shape a local
    model happens to produce (the pattern the three tolerances above
    already show), a mature, purpose-built repair library is used as the
    LAST resort -- deliberately last, since it's a general fixer rather
    than a confirmed, understood failure shape. Its output is validated
    (must be a dict or list) before being trusted; anything else still
    raises exactly as before."""
    try:
        obj, _end = json.JSONDecoder().raw_decode(content)
    except json.JSONDecodeError as exc:
        try:
            obj, _end = json.JSONDecoder().raw_decode(content + "}")
        except json.JSONDecodeError:
            if exc.msg == "Expecting ',' delimiter" and content[exc.pos : exc.pos + 1] == "]":
                repaired = content[: exc.pos] + "}" + content[exc.pos :]
                try:
                    obj, _end = json.JSONDecoder().raw_decode(repaired)
                    return obj
                except json.JSONDecodeError:
                    pass
            try:
                obj = repair_json(content, return_objects=True)
            except Exception:
                raise ValueError(f"malformed JSON in LLM response content: {content!r}") from exc
            if not isinstance(obj, (dict, list)):
                raise ValueError(f"malformed JSON in LLM response content: {content!r}") from exc
            return obj
    return obj


# Bounds analyze_section_agentic's tool-calling loop -- a hard cap so a
# misbehaving model that keeps calling query_kb can't loop forever. 4 rounds
# comfortably covers "call once or twice, then answer" while still being a
# real ceiling against runaway generation.
_MAX_TOOL_ROUNDS = 4

QUERY_KB_TOOL = {
    "type": "function",
    "function": {
        "name": "query_kb",
        "description": (
            "Search the knowledge base for reference material relevant to this "
            "section of the document. Call this when additional context would "
            "help you correctly interpret or formalize a requirement."
        ),
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "A short natural-language search query"}},
            "required": ["query"],
        },
    },
}

# §15: full-document read tools, for when top-k similarity snippets aren't
# enough and the model needs a whole previously-ingested KB document's
# content (e.g. a referenced ICD or spec the section only mentions by name).
# Reuses this same agentic loop -- both are only wired in when the caller
# (llm_leveling._build_survey_skeleton_for_branch) supplies the corresponding
# list_documents_fn/read_document_fn closures (KB deps + tool-capable model).
LIST_KB_DOCUMENTS_TOOL = {
    "type": "function",
    "function": {
        "name": "list_kb_documents",
        "description": (
            "List the names of documents available in the knowledge base for this "
            "job's area path. Call this before read_kb_document if you don't "
            "already know the exact document name you need."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
}

READ_KB_DOCUMENT_TOOL = {
    "type": "function",
    "function": {
        "name": "read_kb_document",
        "description": (
            "Read the FULL text of one previously-ingested knowledge base document "
            "by name (see list_kb_documents) -- use this when a section references "
            "a whole external document (e.g. \"see the attached ICD\") and a "
            "similarity-searched snippet (query_kb) wouldn't give enough context."
        ),
        "parameters": {
            "type": "object",
            "properties": {"source_file": {"type": "string", "description": "The exact document name, from list_kb_documents"}},
            "required": ["source_file"],
        },
    },
}

# §3.3: lets the model pull a specific OTHER section of the CURRENT document
# (not the KB) on demand -- only wired in when llm_leveling.build_survey_tree
# found the whole document too large for one call and built a compact
# outline instead of raw full text. Numbered to match that outline's own
# 1-based section numbering (see _build_document_outline).
READ_OTHER_SECTION_TOOL = {
    "type": "function",
    "function": {
        "name": "read_other_section",
        "description": (
            "Read the FULL text of another section of THIS SAME document, by its "
            "number from the document outline above -- use this for a specific "
            "cross-reference the outline alone doesn't resolve (e.g. \"per "
            "section 3\"). Not for the knowledge base -- see read_kb_document for that."
        ),
        "parameters": {
            "type": "object",
            "properties": {"section_id": {"type": "string", "description": "The section number, from the document outline"}},
            "required": ["section_id"],
        },
    },
}

_SECTION_ANALYSIS_SYSTEM_PROMPT = load_prompt("section_analysis")


def _root_count_clause(expected_root_count: int | None) -> str:
    """Fills the __ROOT_COUNT_CLAUSE__ marker in
    _SECTION_ANALYSIS_SYSTEM_PROMPT. Defaults to today's exact single-root
    wording when `expected_root_count` is None/<2 -- byte-identical
    behavior for the overwhelmingly common case of one coherent section.

    Confirmed live: a document can define MULTIPLE independent top-level
    domains with no common ancestor (e.g. "Television Receiver" and
    "Remote Control", each its own root Epic in a human-authored reference
    hierarchy) -- yet the model still invented a single wrapping root Epic
    to merge them, EVEN THOUGH both were already individually named as
    separate qualifying Epic-type groups in the table-group hint. This is
    not a hint-visibility problem -- it's this hardcoded "at most ONE"
    rule leaving no room for a real multi-root document. Per this
    codebase's own repeatedly-confirmed finding (see _table_group_hint's
    and table_groups.py's own docstrings), a qualitative rule referencing
    the hint data alone does not reliably change structural decisions --
    only a concrete, countable instruction does. `expected_root_count` is
    computed from real document structure (count of table groups with no
    parent in the table's own ID hierarchy, see
    table_groups.TableGroupInfo.is_top_level), the same
    derived-not-guessed-number pattern topic_count already uses.

    Toned down after a confirmed live regression: the first version of
    this clause (long, repeating the count 3 times, "EXACTLY N" framed as
    the dominant instruction) caused the model to over-anchor on the root
    count specifically at the expense of overall coverage -- node count
    collapsed from 57 (single-root wording) to 23 (byte-identical across 2
    repeat runs, so a deterministic prompt-emphasis effect, not run-to-run
    variance), losing most of the section's actual Requirements. This
    version states the count ONCE, as one clause no more prominent than
    the surrounding sentence, matching the terse register of the default
    single-root wording it replaces."""
    if not expected_root_count or expected_root_count < 2:
        return (
            "At most ONE node in your entire response should have "
            "parent_temp_id null (the single section root -- usually the "
            "first Epic or Feature you emit)."
        )
    return (
        f"This section has {expected_root_count} independent top-level "
        "domains with no common ancestor -- up to "
        f"{expected_root_count} nodes may have parent_temp_id null (one "
        "per domain) instead of just one; do not merge them under an "
        "invented wrapping ancestor."
    )


def _section_analysis_system_prompt(expected_root_count: int | None = None) -> str:
    """Fills in _SECTION_ANALYSIS_SYSTEM_PROMPT's dynamic __ROOT_COUNT_CLAUSE__
    marker -- see _root_count_clause's own docstring for why this needs to
    be a real substitution rather than a static string. The base template
    contains literal JSON braces (the node-schema example), so this uses a
    plain marker + str.replace rather than str.format (which would choke on
    those braces)."""
    return _SECTION_ANALYSIS_SYSTEM_PROMPT.replace(
        "__ROOT_COUNT_CLAUSE__", _root_count_clause(expected_root_count)
    )


_SECTION_SKELETON_SYSTEM_PROMPT = load_prompt("section_skeleton")


def _section_skeleton_system_prompt(expected_root_count: int | None = None) -> str:
    """Stage-1 (structure-only) counterpart to
    _section_analysis_system_prompt -- same __ROOT_COUNT_CLAUSE__ marker,
    filled by the same _root_count_clause, since the multi-root question is
    a purely STRUCTURAL one and belongs to exactly this stage now. Same
    marker + str.replace rather than str.format, same reason (the template
    contains literal JSON braces)."""
    return _SECTION_SKELETON_SYSTEM_PROMPT.replace(
        "__ROOT_COUNT_CLAUSE__", _root_count_clause(expected_root_count)
    )


_SECTION_ANALYSIS_TOOL_HINT = (
    "\n\nYou may call the query_kb tool zero or more times first if additional "
    "reference material would help you formalize this section's requirements. "
    "Once you have what you need (or need nothing further), respond with the "
    "final JSON object described above -- not a tool call."
)

_SECTION_ANALYSIS_FULL_DOCUMENT_TOOL_HINT = (
    "\n\nIf a section references a whole external document by name (e.g. \"see "
    "the attached ICD\") rather than needing a short similarity-searched "
    "snippet, you may also call list_kb_documents to see what's available, then "
    "read_kb_document to read one in full."
)

_SECTION_ANALYSIS_OTHER_SECTION_TOOL_HINT = (
    "\n\nA compact outline of every section in THIS document is included above "
    "for orientation. If you need another section's FULL text for a specific "
    "cross-reference, call read_other_section with its number from the outline."
)

# Fallback wording for a whole-document analysis with no headings to count
# (e.g. a plain-text or table-only document) -- a "0 sections" floor would be
# nonsensical, and block-count is a poor topic proxy (it would demand one
# node per bullet, exactly what the base prompt correctly forbids
# elsewhere), so this stays qualitative-only.
_SECTION_ANALYSIS_WHOLE_DOCUMENT_HINT = (
    "\n\nNOTE: this is the COMPLETE document analyzed in a single pass, not one "
    "small section. Maintain full topical coverage across the entire document -- "
    "do not over-consolidate distinct requirements for brevity. Every distinct "
    "obligation in the source must be represented by at least one node. This "
    "overrides the 'as many or as few nodes as genuinely necessary' guidance "
    "above -- do not under-emit for brevity."
)


def _whole_document_hint(topic_count: int | None) -> str:
    """Confirmed live (3 separate runs against the same real 679-block
    document): the qualitative-only hint above does NOT change model
    behavior -- it's a soft reminder losing to the base prompt's repeated,
    specific permission to under-emit ("do NOT emit one node per bullet...
    as many or as few nodes as the section genuinely contains"). A concrete,
    countable floor tied to the document's own real heading count (computed
    once in build_survey_tree's whole-doc gate, from actual BlockKind.HEADING
    blocks -- not a guess) plus an EXPLICIT override of that permissive base
    instruction is a much stronger signal than a qualitative reminder alone.
    `topic_count` of 0/None (a headingless document -- topic_count itself
    isn't a meaningful floor there) falls back to the qualitative hint."""
    if not topic_count:
        return _SECTION_ANALYSIS_WHOLE_DOCUMENT_HINT
    return (
        "\n\nNOTE: this is the COMPLETE document analyzed in a single pass, "
        "not one small section. It contains approximately "
        f"{topic_count} distinct headed sections. Your response should "
        f"contain AT LEAST {topic_count} nodes -- at least one clearly "
        "attributable to each headed section; a section with several distinct "
        f"requirements needs several nodes, so {topic_count} is a FLOOR, not a "
        "target or a cap. This overrides the 'as many or as few nodes as "
        "genuinely necessary' guidance above -- do not under-emit for brevity. "
        f"Emitting fewer than {topic_count} nodes is acceptable ONLY where a "
        "section genuinely states no distinct requirement; never invent, pad, "
        "or duplicate content to reach the count."
    )


def _branch_topic_hint(topic_count: int | None) -> str:
    """Same countable-floor mechanism as _whole_document_hint (confirmed
    live: a concrete, countable floor beats a qualitative reminder), worded
    for a single BRANCH of a multi-branch document instead of the whole
    document -- the multi-branch path previously had no countable
    instruction at all, only the base prompt's own permissive "as many or
    as few nodes as genuinely necessary" guidance, exactly the open-ended
    judgment that contributes to run-to-run node-count variance for the
    same document. `topic_count` of 0/None (a headingless branch) falls
    back to the same qualitative hint whole-document uses when it has no
    count either."""
    if not topic_count:
        return _SECTION_ANALYSIS_WHOLE_DOCUMENT_HINT
    return (
        "\n\nNOTE: this section contains approximately "
        f"{topic_count} distinct headed sub-topics. Your response should "
        f"contain AT LEAST {topic_count} nodes -- at least one clearly "
        "attributable to each headed sub-topic; a sub-topic with several "
        f"distinct requirements needs several nodes, so {topic_count} is a "
        "FLOOR, not a target or a cap. This overrides the 'as many or as few "
        "nodes as genuinely necessary' guidance above -- do not under-emit "
        f"for brevity. Emitting fewer than {topic_count} nodes is acceptable "
        "ONLY where a sub-topic genuinely states no distinct requirement; "
        "never invent, pad, or duplicate content to reach the count."
    )


# Caps how many FEATURE-typed group labels are spelled out verbatim in the
# prompt, to bound worst-case prompt size on a huge table -- the arithmetic
# sentence below always states the TRUE full count, never the capped
# display count, so the floor itself is never understated even when the
# label list is cut. EPIC and REQUIREMENT-typed groups are NEVER subject to
# this cap (see the type-priority filtering in _table_group_hint below):
# confirmed live, a flat positional cap of 15 silently dropped two REAL
# groups from being named at all ("Media Buttons" at document-order index
# 16, a Feature; "Recovery from Communication Loss" at index 18, a
# Requirement) purely because of where they fell in table order, not
# because they were less real or less structurally significant than the
# groups that DID make the cut. Every group that stayed under the old cap
# landed correctly in that same run; every one that fell past it did not --
# a direct, confirmed correlation between "named in hint" and "became a
# real node". EPIC/REQUIREMENT groups are structurally rarer and more
# consequential than the common FEATURE case (a missed Feature-of-
# Requirements still likely surfaces its child Requirements somewhere; a
# missed Epic-of-Epics or Requirement-of-Requirements loses real structure
# outright), so only FEATURE is allowed to fall off a cap at all. Token
# cost per named group is ~10-15 tokens -- trivial against this module's
# _MAX_OUTPUT_TOKENS budget -- so this cap exists only as a sane ceiling on
# an unusually large table, not a meaningfully tight constraint.
_MAX_FEATURE_TABLE_GROUPS_NAMED = 40

# Same reasoning as _MAX_FEATURE_TABLE_GROUPS_NAMED above -- a sane ceiling
# on an unusually large requirements table, not a meaningfully tight
# constraint (token cost per named row is ~10-15 tokens). Deliberately NOT
# a cap on the numeric floor itself (topic_count's own arithmetic always
# uses the TRUE full row count -- see build_survey_tree) -- only on how
# many codes get spelled out verbatim in the hint text.
_MAX_REQUIREMENT_ROWS_NAMED = 60

# Same reasoning again, for _heading_outline_hint below -- a real document
# can have dozens of Feature-typed headings (Requirement-typed leaves are
# never named at all, see _heading_outline_hint's own docstring; live
# counts on a real large document: docs/handoff-heading-tier-detector-and-customer-id-fixes.md).
# Epic-typed entries are never capped (same policy as _table_group_hint's
# own EPIC/REQUIREMENT exemption) -- there are always far fewer of them,
# and an Epic-tier miss is the more consequential one.
_MAX_HEADING_FEATURES_NAMED = 60


def _table_group_hint(table_group_hints: list[tuple[str, str]] | None) -> str:
    """Confirmed live: a QUALITATIVE instruction alone ("use the source's
    own group label as a node when it has 2+ children", already merged
    into _SECTION_ANALYSIS_SYSTEM_PROMPT) measured ZERO effect across a
    real re-run of the same document -- identical missing-group set before
    and after. This is the concrete, countable counterpart, same proven
    pattern as _whole_document_hint/_branch_topic_hint above: state the
    real number, name the actual groups, AND state each one's own
    suggested TYPE (see table_groups.qualifying_table_groups's own
    docstring for how that's determined) -- a second confirmed real gap:
    the original version of this hint left Feature-vs-Requirement entirely
    to the model's own judgment ("matching what kind of children it has")
    and never mentioned Epic as a possibility at all, so a group-of-groups
    domain (e.g. "Television Receiver") had no signal it could become a
    nested Epic rather than being flattened into one Feature (or merged
    away entirely). Combined with (not a replacement for) the qualitative
    sentence already in the base prompt -- that sentence still supplies the
    WHY/HOW framing; this supplies the WHICH, HOW MANY, and WHAT TYPE.
    topic_count's own arithmetic (see _whole_document_hint/
    _branch_topic_hint) already includes these groups in its floor -- this
    hint only narrows down which of that floor's nodes are these specific
    named groups and what type each should be."""
    if not table_group_hints:
        return ""
    # Type-priority filtering: EPIC/REQUIREMENT groups are always named in
    # full; only FEATURE groups (the common case) are subject to a cap. See
    # _MAX_FEATURE_TABLE_GROUPS_NAMED's own comment for why.
    displayed: list[tuple[str, str]] = []
    feature_count = 0
    dropped: list[str] = []
    for label, suggested_type in table_group_hints:
        if suggested_type == "Feature":
            feature_count += 1
            if feature_count > _MAX_FEATURE_TABLE_GROUPS_NAMED:
                dropped.append(label)
                continue
        displayed.append((label, suggested_type))
    if dropped:
        logger.warning(
            "table_group_hint: %d Feature-typed group(s) dropped from the "
            "named hint past the %d cap (still counted in the numeric "
            "floor, not individually named): %s",
            len(dropped), _MAX_FEATURE_TABLE_GROUPS_NAMED, dropped,
        )
    labels_text = ", ".join(f"'{label}' ({suggested_type})" for label, suggested_type in displayed)
    if dropped:
        labels_text += f", and {len(dropped)} more"
    return (
        "\n\nNOTE: this section's source table defines "
        f"{len(table_group_hints)} structural group(s) with two or more "
        "child items of their own -- specifically, with the work-item TYPE "
        f"each one should become: {labels_text}. Each of these groups is one "
        "of the nodes counted in the floor above: your response must include "
        "a distinct node for EACH one, using EXACTLY the stated type (Epic "
        "for a group whose own children are themselves further split into "
        "sub-groups -- a large functional domain, not a flat list of "
        "requirements; Feature for a group containing distinct requirements "
        "or a mix of requirements and sub-groups; Requirement for a general "
        "statement whose children are its own specific exceptions or "
        "conditions) -- do not fold its children directly into a broader "
        "ancestor and skip past this group's own label, and do not invent a "
        "different type than the one stated. For a group stated as "
        "Requirement specifically: its own children (the exception/condition "
        "items) must ALSO each become their own child Requirement node "
        "underneath it, exactly like the Child Requirement pattern above -- "
        "do not merge them into one combined description on the parent "
        "Requirement itself; the parent's own text should state the general "
        "behavior only, with each specific sub-case as a separate child."
    )


def _requirement_row_hint(requirement_row_hints: list[tuple[str, str]] | None) -> str:
    """Same countable-instruction pattern as _table_group_hint above,
    confirmed necessary for the same reason: a qualitative instruction
    alone (the table-classification paragraph already merged into
    section_skeleton.v1.txt) is not trusted on its own to change structural
    model behavior on this codebase's own evidence. This is the concrete,
    document-derived counterpart -- state the real row count, name the
    actual per-row identifiers, and require each one to land on its own
    node's 'customer_id' verbatim. topic_count's own arithmetic (see
    build_survey_tree/qualifying_requirement_rows) already includes these
    rows in its floor -- this hint only names which of that floor's nodes
    they are and what identifier each must carry."""
    if not requirement_row_hints:
        return ""
    displayed = requirement_row_hints[:_MAX_REQUIREMENT_ROWS_NAMED]
    dropped_count = len(requirement_row_hints) - len(displayed)
    codes_text = "; ".join(
        f"'{code}' ({label})" if label else f"'{code}'" for code, label in displayed
    )
    if dropped_count:
        codes_text += f"; and {dropped_count} more"
    return (
        "\n\nNOTE: this section's source table(s) print their own literal "
        f"requirement identifier on {len(requirement_row_hints)} individual "
        "row(s), so those rows are separate requirements by the source "
        "document's own explicit numbering -- not a table of values to fold "
        f"into one node: {codes_text}. Your response must contain a distinct "
        "Requirement node for EACH of them, each carrying that exact "
        "identifier, copied character for character, in its own "
        "'customer_id'. These rows are part of the floor stated above. "
        "Merging two of them into one node, or omitting one, loses a "
        "requirement the source document explicitly numbered. Do not invent "
        "an identifier for any node not in this list, and do not renumber, "
        "reformat, extend or shorten these."
    )


def _heading_outline_hint(heading_type_hints: list[tuple[str, str]] | None) -> str:
    """Without an explicit structural hint, a document with several real
    top-tier heading sections, each grouping its own sub-section(s), can
    still fit in a single whole-document skeleton call -- the model may
    correctly Epic-type the richest section but Feature-type the others
    directly underneath it instead of promoting each to its own Epic (see
    docs/handoff-heading-tier-detector-and-customer-id-fixes.md for the
    confirmed live case). The base prompt's scope test ("could this take
    multiple sprints and cover several distinct Features on its own?") is
    a soft, content-based judgment with no explicit tie to the document's
    own heading depth.

    `heading_type_hints` comes from
    app.leveling.heading_outline.heading_outline_entries, reduced to
    (title, type) pairs -- see that function's own docstring for how type
    is determined (a bottom-up, tree-shape-derived ladder, never an
    absolute "Heading 1"/"Heading 2" number, which is why this hint's own
    wording never names a heading level either -- only the document's own
    outline). That detector honestly returns Requirement-typed entries too
    (a leaf heading whose own text IS the requirement) -- Phase 1 (this
    function) drops them before naming anything: no live evidence yet
    that any document reaching this hint needs them named, and a
    heading-heavy document would otherwise add hundreds of named items.
    The model still sees every heading's own text rendered in its section,
    so an unnamed heading is not hidden from it, only left to its own
    judgment, same as before this hint existed."""
    named = [(title, suggested_type) for title, suggested_type in (heading_type_hints or []) if suggested_type != "Requirement"]
    if not named:
        return ""
    # Type-priority filtering, same policy as _table_group_hint: Epic-typed
    # entries are always named in full; only Feature-typed entries are
    # subject to a cap.
    displayed: list[tuple[str, str]] = []
    feature_count = 0
    dropped: list[str] = []
    for title, suggested_type in named:
        if suggested_type == "Feature":
            feature_count += 1
            if feature_count > _MAX_HEADING_FEATURES_NAMED:
                dropped.append(title)
                continue
        displayed.append((title, suggested_type))
    if dropped:
        logger.warning(
            "heading_outline_hint: %d Feature title(s) dropped from the named hint "
            "past the %d cap (still counted in the numeric floor, not individually named): %s",
            len(dropped), _MAX_HEADING_FEATURES_NAMED, dropped,
        )
    labels_text = ", ".join(f"'{title}' ({suggested_type})" for title, suggested_type in displayed)
    if dropped:
        labels_text += f", and {len(dropped)} more"
    has_epic = any(suggested_type == "Epic" for _title, suggested_type in named)
    # Emitted only when the document's own outline has no grouping tier at
    # all (every named heading is a peer Feature) -- see
    # heading_outline_entries's own docstring on why this shape is left
    # exactly as-is here rather than having an Epic invented for it: a
    # uniformly Feature-topped tree is a legitimate, already-tested shape,
    # and the LATER whole-document root-regrouping pass is the
    # better-informed place to decide whether these roots deserve a
    # topical Epic, since it sees every root title at once instead of just
    # this one section.
    single_tier_clause = (
        ""
        if has_epic
        else (
            " This section's own outline has ONE tier only -- these are peer "
            "sections with no grouping heading above them in the source. Do "
            "NOT invent an Epic (one per heading, or one shared wrapper) for "
            "them; introduce an Epic here only if the section's own CONTENT "
            "genuinely groups several of them into one larger initiative, not "
            "merely because they are listed together."
        )
    )
    return (
        "\n\nNOTE: this section's own document structure already fixes part of "
        f"the type boundary for {len(named)} of its real headings: {labels_text}. "
        "Each Epic listed is its OWN separate top-level Epic -- do not merge "
        "multiple listed Epics under one shared Epic, and do not Feature-type "
        "one just because it covers less content than another. Each Feature "
        "listed belongs directly under whichever listed Epic it actually "
        "appears under in the section text -- never skip that tier, and never "
        "attach it under a different Epic than the one it appears under. A "
        "listed Feature whose own Epic is not itself listed here is a root-"
        "level node in THIS section (a later whole-document pass reconciles "
        "roots across sections, not this call). Use exactly these types for "
        "exactly these headings; a heading not listed here is still yours to "
        "judge using the general rules above." + single_tier_clause
    )


def _agentic_tools_and_hint(
    list_documents_fn: Callable[[], list[str]] | None,
    read_document_fn: Callable[[str], str | None] | None,
    read_other_section_fn: Callable[[str], str | None] | None,
) -> tuple[list[dict], str]:
    """Which tools an agentic section call offers, and the matching prompt
    hint describing them -- extracted verbatim from analyze_section_agentic
    when the skeleton-stage agentic path became a second caller of the
    identical gate. Each capability is opt-in by whether its closure was
    injected at all (see analyze_section_agentic's own docstring for the
    convention), and the full-document pair is all-or-nothing: offering
    list_kb_documents without read_kb_document would let the model name a
    document it then cannot open."""
    full_document_tools_enabled = list_documents_fn is not None and read_document_fn is not None
    other_section_tool_enabled = read_other_section_fn is not None
    tools = [QUERY_KB_TOOL]
    tool_hint = _SECTION_ANALYSIS_TOOL_HINT
    if full_document_tools_enabled:
        tools += [LIST_KB_DOCUMENTS_TOOL, READ_KB_DOCUMENT_TOOL]
        tool_hint += _SECTION_ANALYSIS_FULL_DOCUMENT_TOOL_HINT
    if other_section_tool_enabled:
        tools.append(READ_OTHER_SECTION_TOOL)
        tool_hint += _SECTION_ANALYSIS_OTHER_SECTION_TOOL_HINT
    return tools, tool_hint


def _nodes_from_parsed(parsed: object) -> list[dict]:
    """Both analyze_section and analyze_section_agentic return {"nodes": [...]}
    (see section_analysis_schema's object-wrapping rationale) -- unwrap
    defensively in case a degraded/schema-less response comes back as a bare
    array instead."""
    if isinstance(parsed, dict):
        return parsed.get("nodes", [])
    if isinstance(parsed, list):
        return parsed
    return []


def _with_kb_context(system_prompt: str, kb_context: str | None) -> str:
    if kb_context is None:
        return system_prompt
    return (
        "Reference material from the knowledge base (may be incomplete or "
        "irrelevant — use only what's genuinely helpful):\n\n"
        f"{kb_context}\n\n"
        f"{system_prompt}"
    )


def _with_authoring_standard(system_prompt: str, standard: str | None) -> str:
    """Prepends the organization's authoring standard (app.kb.profile.render_authoring_standard) to a prompt that writes
    a work item's title or description. Authoritative, unlike the soft background framing of retrieved KB text: where the
    standard and the generic guidance below disagree, the standard wins. None: the prompt is returned untouched."""
    if not standard:
        return system_prompt
    return (
        "The organization's authoring standard, taken from its own knowledge base. Follow it when you write titles and "
        "descriptions; where it disagrees with the general guidance below, the standard wins:\n\n"
        f"{standard}\n\n---\n\n{system_prompt}"
    )


def _with_kb_context_as_scoring_rubric(
    system_prompt: str, kb_context: str | None, categories_are_fixed: bool = False
) -> str:
    """Scoring-specific variant of _with_kb_context's framing -- deliberately
    STRONGER, not just "use what's helpful". For requirement-quality scoring,
    an org's own ingested KB document (e.g. a requirements-writing standard)
    isn't background material to weigh against the model's generic EARS/
    INCOSE/ISO knowledge -- if it defines its own conventions for clarity,
    testability, acceptance-criteria phrasing, etc., THOSE are what a
    reviewer at that org actually judges against, and should override the
    generic public-standard rubric wherever the two disagree. The public
    rubric only fills in dimensions the KB material doesn't address, rather
    than being applied "strictly" regardless of the org's own real
    conventions. Grounding call sites (analyze_section/agentic) intentionally
    keep _with_kb_context's softer framing -- that's about domain content
    possibly being irrelevant to a given section, a different concern from
    scoring's rubric-authority question.

    `categories_are_fixed` (True when score_requirements_for_document was
    given a pre-extracted `category_checklist`) drops the "derive your
    categoryScores key names from this material" clause -- confirmed real
    prompt contradiction otherwise: score_requirements_for_document's own
    fixed-checklist branch separately instructs "use EXACTLY these
    categories... do not add, omit, rename, or reorder any", and having
    BOTH instructions in the same prompt put a naming/deriving instruction
    right next to a "these are fixed, don't touch them" instruction. The
    fixed-checklist path is a hard, cross-run determinism requirement
    (user-reported); this framing must never suggest there's a naming
    decision left to make when one has already been made and stored."""
    if kb_context is None:
        return system_prompt
    if categories_are_fixed:
        return (
            "The following knowledge-base material was retrieved for this "
            "organization. If it defines its own requirements-writing "
            "conventions or standards, treat THOSE as the authoritative rubric "
            "for this organization -- judge how strictly each requirement meets "
            "them, not just the generic public EARS/INCOSE/ISO/IEC/IEEE 29148 "
            "criteria. Only fall back to the generic criteria/dimensions for "
            "anything this material doesn't address. (Your categoryScores key "
            "names are fixed separately below -- this material informs how you "
            "judge each one, not what the keys are.):\n\n"
            f"{kb_context}\n\n"
            f"{system_prompt}"
        )
    return (
        "The following knowledge-base material was retrieved for this "
        "organization. If it defines its own requirements-writing "
        "conventions, standards, or quality checklist, treat THOSE as the "
        "authoritative rubric for this organization -- score against them "
        "(including deriving your categoryScores key names from this "
        "material's own checklist items, see below), not just the generic "
        "public EARS/INCOSE/ISO/IEC/IEEE 29148 criteria. Only fall back to "
        "the generic criteria/dimensions for anything this material doesn't "
        "address:\n\n"
        f"{kb_context}\n\n"
        f"{system_prompt}"
    )


def _with_category_dict(entry: object) -> object:
    """A score entry with `categoryScores` as the dict (category name -> score) the scoring code reads:
    on the array wire format it arrives as a list of {"name", "score"} entries. A malformed list item is
    skipped, so the consumer's all-or-nothing check sees one fewer category rather than a crash; an
    entry that is not a dict, or already has a dict, is returned as it is."""
    if not isinstance(entry, dict) or not isinstance(entry.get("categoryScores"), list):
        return entry
    categories: dict[str, object] = {}
    for item in entry["categoryScores"]:
        if isinstance(item, dict) and isinstance(item.get("name"), str):
            categories.setdefault(item["name"].strip(), item.get("score"))
    return {**entry, "categoryScores": categories}


_COMPLETENESS_KEY = "completeness_as_requirement"


def _array_category_instruction(category_checklist: list[str] | None, kb_context: str | None) -> str:
    """The `categoryScores` paragraph for the array wire format -- the same three sources of category
    names as the map form (a stored checklist, names derived from KB material, the five generic
    dimensions), phrased for a list of {"name", "score"} entries instead of an object keyed by name."""
    entry = '{"name": <category>, "score": <integer 0-100>}'
    if category_checklist:
        # The completeness check is part of the explicit list (described below it): a model that follows the list literally
        # used to drop a key that was only mentioned in prose. An item's own list may already carry it: never twice.
        required = list(category_checklist)
        if not any(name.strip().casefold() == _COMPLETENESS_KEY for name in required):
            required.append(_COMPLETENESS_KEY)
        instruction = (
            f"'categoryScores' -- an array with EXACTLY one {entry} object for each of these categories "
            "(this organization's own ingested quality-checklist category names plus the built-in "
            "completeness_as_requirement check described below, fixed for this document -- "
            f"do not add, omit, rename, or reorder any): {json.dumps(required)} -- {len(required)} entries in "
            "total, never fewer. Each score is an independent integer 0-100 judgment (100 = fully compliant "
            "on that dimension alone); when a category does not seem to apply, still include it and give it "
            "your best-effort score instead of leaving it out.\n"
        )
    elif kb_context:
        instruction = (
            f"'categoryScores' -- an array of {entry} objects whose NAMES you derive from the "
            "organization's own ingested quality-checklist material referenced above (e.g. if it defines a "
            "checklist like Necessary, Correct level, Unambiguous, Singular, Complete, Feasible, Verifiable, "
            "Consistent, Traceable, Modifiable, use exactly those names), each score an independent integer "
            "0-100 judgment (100 = fully compliant on that dimension alone). Decide the category names ONCE "
            "from that material and use the EXACT SAME set of names, spelled identically, for every single "
            "node_id in your response -- never a different set per node, and never leave a category out of "
            "a node's list because it seems not to apply (give it a best-effort score). If the material defines no clear "
            "checklist to score against, fall back to these five generic dimensions instead: clarity, "
            "testability, atomicity, style, rationale.\n"
        )
    else:
        instruction = (
            f"'categoryScores' -- an array of EXACTLY SIX {entry} objects, one for EACH of these six "
            "dimensions, named exactly clarity, testability, atomicity, style, rationale and "
            "completeness_as_requirement -- never fewer. When a dimension does not seem to apply (for "
            "example no rationale is needed), still include it and score it 100 instead of leaving it out. "
            "100 = fully compliant on that dimension alone; judge each one on its own merits, do not just "
            "derive them mechanically from whether an issue tag was flagged:\n"
            "  - clarity: is the wording unambiguous and free of vague terms?\n"
            "  - testability: can this be objectively verified, with clear "
            "acceptance criteria?\n"
            "  - atomicity: is this ONE single requirement, not several "
            "bundled together? A bare fragment or label (see "
            "completeness_as_requirement below) is NOT atomic just because "
            "it is short -- score it low here too, not high.\n"
            "  - style: active voice, EARS-style phrasing?\n"
            "  - rationale: does it state WHY when the reason isn't "
            "self-evident?\n"
        )
    return instruction + (
        "  - completeness_as_requirement: is this a COMPLETE candidate "
        "requirement -- a subject, a modal (shall/should/must), and a "
        "verifiable predicate? A bare label, value, or table cell (e.g. "
        "'Size: 3U 1\"', 'Over-current', 'ON/OFF control') scores 0-10 here "
        "regardless of how clear or short it is. Always include this "
        "category in categoryScores, in addition to the categories above.\n"
    )


class OrchestratorLlmClient:
    """SURVEY mode's real LLM client. Calls the orchestrator's POST
    /llm/chat proxy — NEVER calls Open WebUI/Ollama directly, per the
    'backend proxy, redact-first' architecture boundary in
    docs/architecture.md's Locked Decisions.

    Every method's system prompt instructs the model to return strict JSON;
    a malformed response raises ValueError rather than silently returning
    an empty/wrong result, since a caller acting on invalid LLM output is
    worse than a loud failure."""

    def __init__(
        self,
        base_url: str,
        bearer_token: str,
        model: str | None = None,
        num_ctx: int | None = None,
        top_k: int | None = None,
        min_p: float | None = None,
        # Defaults to a fixed value (unlike num_ctx/top_k/min_p above, which
        # default to None/opt-in) -- pinning the sampler's RNG has no
        # downside/cost tradeoff the way a larger context window or a
        # model-specific repetition mitigation does, so every construction
        # site gets it automatically rather than needing to opt in one by
        # one. Real gap this closes: NO call site anywhere in this module
        # set a seed before this, and temperature=0 alone does not give
        # run-to-run determinism under llama.cpp/Ollama (batch/KV-cache
        # nondeterminism + tie-breaking) -- confirmed via the orchestrator's
        # own openwebui.client.ts, which already forwards `seed` into the
        # request but had nothing upstream of it ever supplying one. Pass
        # seed=None explicitly to opt OUT for a caller that genuinely wants
        # varied sampling (none exists today).
        seed: int | None = 42,
        # S11: caches analyze_section/score_requirements_for_document/
        # score_epics_and_features_for_document -- see LlmResponseCache's own
        # docstring. None (the default) disables caching entirely, matching
        # pre-cache behavior exactly -- every existing construction site
        # (module-level singletons in main.py that never touch these three
        # methods, and any test not exercising caching) is unaffected.
        cache: LlmResponseCache | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._bearer_token = bearer_token
        # Per-job model override (see /level's `model` query param) -- when
        # unset, the orchestrator's own /llm/chat proxy falls back to its
        # configured LLM_CHAT_MODEL default, matching pre-model-selection
        # behavior exactly.
        self._model = model
        # The answer budget for this model: the default, or its stated output ceiling when that is lower (e.g. the
        # 16,384-token `-chat` aliases). See app.leveling.model_caps.output_token_budget.
        self._max_output_tokens = output_token_budget(model)
        # Ollama's actual runtime context window (§6 of the whole-document
        # redesign) -- originally forwarded only on analyze_section/
        # analyze_section_agentic, the two calls the §3 whole-document gate
        # actually depends on being backed by a real, large-enough context
        # window. Confirmed missing (a real bug, not a deliberate omission)
        # on score_requirements_for_document/infer_trace_links/
        # judge_kb_relevance -- without it, Ollama silently truncates any
        # of those calls' input to its own small default regardless of
        # actual size, very likely the real cause of the "Quality scoring
        # returned no valid score for N node(s)" warning class. Now
        # forwarded on all five real LLM calls in this module. Sized by the
        # caller (app.main's /level route) from the SAME _resolve_caps(model)
        # budget build_survey_tree itself gates on. None (the default) omits
        # the field entirely, matching pre-num_ctx behavior exactly.
        self._num_ctx = num_ctx
        # Gemma4 repetition-collapse mitigation (confirmed upstream bug,
        # ollama/ollama#15502/#15783 -- see orchestrator's
        # LlmChatOptions.topK/minP doc comment for the full citation and why
        # repeat_penalty does NOT work as a substitute). Forwarded on the
        # same two calls as num_ctx above -- the long free-text holistic
        # analysis is exactly where the collapse was observed live. None
        # (the default) omits both fields entirely, matching pre-mitigation
        # behavior exactly.
        self._top_k = top_k
        self._min_p = min_p
        self._seed = seed
        # Set by /level when the user's KB profile has content (app.kb.profile.render_authoring_standard); None leaves every
        # prompt that writes an item exactly as it was.
        self.authoring_standard: str | None = None
        self._cache = cache
        self._transport: httpx.BaseTransport | None = None  # test-only injection seam
        # How long one call waits for the orchestrator's answer. None: the configured LLM_REQUEST_TIMEOUT_SECONDS (a job's calls run
        # for minutes). An on-demand call whose caller stops waiting sets it just past its own cap, so the connection ends with it
        # instead of the call running on with its answer thrown away.
        self.request_timeout_seconds: float | None = None

    @property
    def model(self) -> str | None:
        """Public read-only accessor for the per-job model override -- exists
        purely so llm_leveling.py's narration (`_fire`/`getattr(client,
        'model', None)`) can surface which model is doing the work on the
        running page, without this class needing to know narration exists."""
        return self._model

    def _post_chat(self, payload: dict, user_id: str | None) -> httpx.Response:
        """POSTs to /llm/chat with a short, bounded retry for a transient
        backend error (429/5xx) only -- see _RETRYABLE_CHAT_STATUS_CODES'
        own module-level doc comment for why this exists and why it's safe
        (bounded, status-gated, layered above the existing per-chunk
        fail-open nets rather than replacing them). Every one of this
        class's /llm/chat call sites should route through this instead of
        constructing its own httpx.Client + raw post -- callers still call
        `.raise_for_status()` themselves afterward, unchanged.

        `user_id` -- the orchestrator now requires an X-Req2Ado-User-Id
        header identifying which user's vaulted Open WebUI credential to
        use (no shared/global fallback credential exists any more); a
        request with a valid bearer token but a missing/unknown header is
        rejected with 401. MUST be a per-call parameter, never stored on
        `self` -- this class is constructed as a module-level singleton
        shared across every concurrent request the process handles (see
        main.py's _dedup_judge_client/_checklist_client), so storing it on
        the instance would leak one user's identity into a concurrent
        request from a different user. Omitted from the header entirely
        when falsy, mirroring how every other optional field in this
        module is conditionally included -- never sent as an empty
        string."""
        response: httpx.Response | None = None
        headers = {"Authorization": f"Bearer {self._bearer_token}"}
        if user_id:
            headers["X-Req2Ado-User-Id"] = user_id
        for attempt in range(_MAX_CHAT_RETRY_ATTEMPTS):
            raise_if_cancelled()  # a job whose caller is gone makes no further model calls
            started = time.monotonic()
            with httpx.Client(transport=self._transport, timeout=self.request_timeout_seconds or _LLM_REQUEST_TIMEOUT_SECONDS) as client:
                response = client.post(
                    f"{self._base_url}/llm/chat",
                    json=payload,
                    headers=headers,
                )
            if response.status_code not in _RETRYABLE_CHAT_STATUS_CODES:
                return response
            elapsed = time.monotonic() - started
            if elapsed >= _SLOW_FAILURE_SECONDS:
                logger.warning(
                    "/llm/chat returned %d after %.0fs -- not re-sending an identical request that already ran "
                    "that long (the caller can split it into smaller calls)", response.status_code, elapsed,
                )
                return response
            if attempt < _MAX_CHAT_RETRY_ATTEMPTS - 1:
                logger.warning(
                    "/llm/chat returned %d (attempt %d/%d) -- retrying after %.0fs",
                    response.status_code, attempt + 1, _MAX_CHAT_RETRY_ATTEMPTS,
                    _CHAT_RETRY_BACKOFF_SECONDS[attempt],
                )
                notice("server_retry", status=response.status_code)
                time.sleep(_CHAT_RETRY_BACKOFF_SECONDS[attempt])
        assert response is not None  # loop always runs >=1 iteration
        return response

    def _chat_json_streaming(
        self, payload: dict, user_id: str | None, display: DraftingDisplay,
    ) -> Any:
        """Same call as `_chat_json`'s plain path, read as a stream so the screen
        can show what the model is writing (job transparency, B7). The text it
        collects is parsed by the very same `_strip_json_fence` +
        `_parse_json_object` the plain path uses, so the result is identical; the
        observer only feeds the display.

        Returns `_NOT_STREAMED` (the caller then makes the ordinary call, which
        keeps its own retry ladder) when streaming was not possible: the request
        failed or was refused before any output arrived, the stream broke part
        way (the lane is cleared first), or it ended without the terminal line
        that proves the answer is complete."""
        raise_if_cancelled()
        headers = {"Authorization": f"Bearer {self._bearer_token}"}
        if user_id:
            headers["X-Req2Ado-User-Id"] = user_id
        parts: list[str] = []
        finished = False
        got_output = False
        finish_reason: str | None = None
        try:
            timeout = self.request_timeout_seconds or _LLM_REQUEST_TIMEOUT_SECONDS
            with httpx.Client(transport=self._transport, timeout=timeout) as client:
                with client.stream(
                    "POST", f"{self._base_url}/llm/chat/stream",
                    json={**payload, "includeDone": True}, headers=headers,
                ) as response:
                    if response.is_error:
                        notice("stream_fallback", reason="refused")
                        return _NOT_STREAMED
                    for line in response.iter_lines():
                        if not line:
                            continue
                        got_output = True
                        message = json.loads(line)
                        if message.get("done"):
                            finished = True
                            finish_reason = message.get("finishReason")
                            if message.get("finishReason") == "length":
                                logger.warning("Streamed structured LLM call ended with finishReason=length -- the answer may be incomplete")
                                notice("output_limit_reached", "warning", with_last_item=True, step="drafting")
                            continue
                        delta = message.get("delta")
                        if delta:
                            parts.append(delta)
                            display.feed(delta)
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("Streamed /llm/chat/stream call failed, using the plain call: %s", exc)
            notice("stream_fallback", reason="stream_error")
            if got_output:
                display.reset()
            return _NOT_STREAMED
        if not finished:
            logger.warning("Streamed call ended without its terminal line, using the plain call")
            notice("stream_fallback", reason="no_terminal_line")
            display.reset()
            return _NOT_STREAMED
        parsed = _parse_json_object(_strip_json_fence("".join(parts)))
        return drop_possibly_cut_last_entry(parsed) if finish_reason == "length" else parsed

    def _chat_json(
        self,
        system_prompt: str,
        user_content: str,
        *,
        schema: dict | None = None,
        max_tokens: int | None = None,
        user_id: str | None = None,
        stream_inputs: dict[str, str | None] | None = None,
        stream_stage: str | None = None,
    ) -> Any:
        """Shared payload-envelope + response-parsing shape for this class's
        simple, single-shot structured-extraction calls (schema in, JSON
        object/array out, no caching, no tracing span, no truncation
        tracking). Callers with any of that extra machinery (analyze_section*,
        score_*_for_document, author_content, map_figures_tables) build their
        own payload directly instead of using this -- see each of THEIR own
        docstrings for why. `schema=None` omits `responseSchema` entirely
        (see infer_trace_links's own comment on the array-schema grammar-cost
        cliff this supports). `user_id` -- see _post_chat's own docstring;
        forwarded straight through, never stored.

        `stream_inputs` (row id -> the owner's text for it) marks a drafting
        call that may be streamed for the live screen: it is, only when both
        LIVE_PROGRESS and LLM_STREAM_DRAFTING are on and the job has a live
        emitter. Otherwise this is exactly the plain call it always was."""
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            **({"responseSchema": schema} if schema is not None else {}),
            "think": False,
            "maxTokens": self._max_output_tokens if max_tokens is None else max_tokens,
            **({"numCtx": self._num_ctx} if self._num_ctx else {}),
            **({"topK": self._top_k} if self._top_k else {}),
            **({"minP": self._min_p} if self._min_p else {}),
            **({"seed": self._seed} if self._seed is not None else {}),
        }
        emitter = (
            live_emitter_for(current_job_id())
            if stream_inputs is not None and settings.live_progress and settings.llm_stream_drafting
            else None
        )
        if emitter is not None:
            display = DraftingDisplay(
                emitter, stream_inputs or {}, stage=stream_stage, counter=current_stage_counter(),
            )
            try:
                display.start()
                parsed = self._chat_json_streaming(payload, user_id, display)
            finally:
                display.end()
            if parsed is not _NOT_STREAMED:
                return parsed
        response = self._post_chat(payload, user_id)
        response.raise_for_status()
        body = response.json()
        finish_reason = body.get("finishReason")
        if finish_reason and finish_reason not in ("stop", "tool_calls"):
            # A normal answer ends "stop". Anything else (typically "length")
            # means the output may be incomplete -- logged so an empty or
            # partial keyed answer is no longer unexplained.
            logger.warning("Structured LLM call ended with finishReason=%s -- the answer may be incomplete", finish_reason)
        content = _strip_json_fence(body["content"])
        parsed = _parse_json_object(content)
        return drop_possibly_cut_last_entry(parsed) if finish_reason == "length" else parsed

    def infer_trace_links(
        self,
        nodes: list[dict],
        link_type_catalog: list[dict],
        kb_context: str | None = None,
        user_id: str | None = None,
    ) -> list[dict]:
        sorted_catalog = sorted(link_type_catalog, key=lambda entry: not _is_native_ado_link_type(entry["reference_name"]))
        catalog_lines = "\n".join(
            f"- {entry['reference_name']} (\"{entry['name']}\")"
            + (f": {entry['semantic_hint']}" if entry.get("semantic_hint") else "")
            for entry in sorted_catalog
        )
        nodes_json = json.dumps(nodes)
        system_prompt = load_prompt("infer_trace_links", catalog_lines=catalog_lines)
        system_prompt = _with_kb_context(system_prompt, kb_context)
        # Now schema-constrained via trace_links_schema() -- wrapped in an
        # object ({"links": [...]}), not a top-level array, to avoid the
        # same grammar-cost cliff documented in _response_schemas.py's
        # module docstring (a maxItems-bounded top-level array wedged the
        # server for 10+ minutes on a real ~200-item branch; this schema
        # has no maxItems, same as section_analysis_schema()). numCtx IS
        # forwarded (via _chat_json, when configured) -- this call
        # serializes EVERY node in the whole tree (nodes_json above), the
        # largest single payload in this module, making it the most
        # exposed call to Ollama's silent prompt truncation without an
        # explicit num_ctx (see LlmChatOptions.numCtx's own doc comment).
        # think=False: relationship inference over already-generated nodes
        # is structured extraction, not open-ended reasoning -- same
        # confirmed-live finding (3-10x wall-clock cost, no accuracy
        # benefit) as analyze_section/analyze_section_agentic and
        # score_requirements_for_document.
        result = self._chat_json(system_prompt, nodes_json, schema=trace_links_schema(), user_id=user_id)
        return result.get("links", []) if isinstance(result, dict) else []

    @staticmethod
    def _scoring_category_instruction(
        mode: KeyedMode, category_checklist: list[str] | None, kb_context: str | None,
    ) -> str:
        """The `categoryScores` paragraph of the requirement-scoring prompt. In array mode the
        categories are a list of {"name", "score"} entries (an open map is not valid strict JSON
        Schema); otherwise it is the original text, unchanged."""
        if mode == "array":
            return _array_category_instruction(category_checklist, kb_context)
        # categoryScores' key vocabulary, in priority order:
        # 1. `category_checklist` -- a FIXED, pre-extracted list (genuinely
        #    deterministic across runs, see this method's own docstring).
        # 2. `kb_context` present but no stored checklist -- best-effort
        #    live derivation from whatever KB material was retrieved (NOT
        #    guaranteed identical across runs -- a live LLM judgment call).
        # 3. Neither -- the original fixed 5-dimension scheme, byte-
        #    identical to before either capability existed.
        if category_checklist:
            checklist_json = json.dumps(category_checklist)
            category_instruction = (
                "'categoryScores' -- an object with EXACTLY these categories as "
                f"keys (this organization's own ingested quality-checklist "
                f"category names, fixed for this document -- do not add, omit, "
                f"rename, or reorder any): {checklist_json}. Each key mapped to an "
                "independent integer 0-100 judgment (100 = fully compliant on "
                "that dimension alone).\n"
            )
        elif kb_context:
            category_instruction = (
                "'categoryScores' -- an object whose KEYS you derive from the "
                "organization's own ingested quality-checklist material referenced "
                "above (e.g. if it defines a checklist like Necessary, Correct "
                "level, Unambiguous, Singular, Complete, Feasible, Verifiable, "
                "Consistent, Traceable, Modifiable, use exactly those names as your "
                "keys), each mapped to an independent integer 0-100 judgment (100 = "
                "fully compliant on that dimension alone). Decide the category "
                "names ONCE from that material and use the EXACT SAME set of keys, "
                "spelled identically, for every single node_id in your response -- "
                "never a different key set per node. If the material defines no "
                "clear checklist to score against, fall back to these five generic "
                "dimensions instead: clarity, testability, atomicity, style, "
                "rationale.\n"
            )
        else:
            category_instruction = (
                "'categoryScores' -- an object with FIVE independent integer 0-100 "
                "judgments (100 = fully compliant on that dimension alone, judge "
                "each one on its own merits, do not just derive them mechanically "
                "from whether an issue tag was flagged):\n"
                "  - clarity: is the wording unambiguous and free of vague terms?\n"
                "  - testability: can this be objectively verified, with clear "
                "acceptance criteria?\n"
                "  - atomicity: is this ONE single requirement, not several "
                "bundled together? A bare fragment or label (see "
                "completeness_as_requirement below) is NOT atomic just because "
                "it is short -- score it low here too, not high.\n"
                "  - style: active voice, EARS-style phrasing?\n"
                "  - rationale: does it state WHY when the reason isn't "
                "self-evident?\n"
            )
        # Confirmed real gap: every input to this call is assumed to already
        # be a well-formed requirement statement, so a bare table-cell
        # fragment or heading (e.g. "Size: 3U 1\"") scored as if it were one
        # -- atomicity=100, no way to flag it as not-a-requirement at all.
        # This dimension is ALWAYS added, in every category_instruction
        # branch above (fixed-5, org-checklist, or live-derived) -- it's a
        # structural completeness check, independent of whatever quality
        # dimensions the org's own checklist defines.
        category_instruction += (
            "  - completeness_as_requirement: is this a COMPLETE candidate "
            "requirement -- a subject, a modal (shall/should/must), and a "
            "verifiable predicate? A bare label, value, or table cell (e.g. "
            "'Size: 3U 1\"', 'Over-current', 'ON/OFF control') scores 0-10 here "
            "regardless of how clear or short it is. Always include this key "
            "in categoryScores, in addition to the categories above.\n"
        )
        return category_instruction

    def score_requirements_for_document(
        self,
        descriptions_by_node_id: dict[str, str],
        criteria_context: str | None = None,
        kb_context: str | None = None,
        category_checklist: list[str] | None = None,
        user_id: str | None = None,
    ) -> dict[str, dict]:
        """Batched quality-scoring call: one LLM call judging every node's
        FINAL formalized description in the branch, not one call per node —
        same batching philosophy as generate_requirements_for_document.
        Judged against EARS/INCOSE/ISO/IEC/IEEE-29148 criteria baked into
        the prompt (this codebase's general knowledge of these public
        standards). `criteria_context` (see
        app.quality.criteria_retrieval.CriteriaRetriever), when supplied,
        adds retrieved reference material the model is told to cite instead
        of relying solely on that parametric knowledge. `kb_context` (see
        app.kb.retrieval.retrieve_context), when supplied, is prepended as
        additive org-specific reference material -- the two grounding
        sources are independent and orthogonal (customer content vs quality
        criteria) and either or both may be omitted, keeping the prompt
        byte-identical to before either capability existed.

        `category_checklist` (see app.kb.checklist_extraction), when
        supplied, is a FIXED list of categoryScores key names extracted ONCE
        at KB ingestion time -- a genuine cross-run determinism guarantee
        (user-reported requirement: the SAME document run 4 times must
        yield the SAME categories), since the model is told to use this
        EXACT list rather than derive anything live. Takes priority over
        `kb_context`'s own (live, best-effort) derive-from-material
        fallback, which only applies when no stored checklist exists yet
        for the grounding document (e.g. ingested before this existed)."""
        key = None
        if self._cache is not None:
            key = cache_key(
                "score_requirements_for_document", self._model, self._num_ctx, self._top_k, self._min_p, self._seed,
                descriptions_by_node_id, criteria_context, kb_context, category_checklist,
            )
            cached = self._cache.get(key)
            if cached is not None:
                logger.info("score_requirements_for_document: cache hit, skipping LLM call")
                return cached
        spec = SCORING_SPEC

        def send(descriptions: dict, mode: KeyedMode) -> object:
            category_instruction = self._scoring_category_instruction(mode, category_checklist, kb_context)
            # Concrete, countable completeness instruction -- same confirmed-live
            # pattern as _whole_document_hint/_branch_topic_hint ("a concrete,
            # countable floor beats a qualitative reminder"). Addresses a real,
            # already-observed failure mode (llm_leveling.py's "Quality scoring
            # returned no valid score for N node(s)" warning): nothing previously
            # told the model it must cover EVERY input key, only that it must not
            # invent new ones. node_count fills BOTH occurrences of the
            # __NODE_COUNT__ marker in the template.
            system_prompt = load_prompt(
                "score_requirements_for_document",
                output_lead=output_lead(spec, mode),
                category_instruction=category_instruction,
                node_count=str(len(descriptions)),
            )
            if criteria_context:
                system_prompt += (
                    "\n\nThe following reference criteria were retrieved as most relevant "
                    f"to these requirements -- cite them in your judgment:\n{criteria_context}"
                )
            system_prompt = _with_kb_context_as_scoring_rubric(
                system_prompt, kb_context, categories_are_fixed=bool(category_checklist)
            )
            schema = schema_for(spec, mode)
            payload = {
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": json.dumps(descriptions)},
                ],
                "temperature": 0,
                **({"model": self._model} if self._model else {}),
                **({"responseSchema": schema} if schema is not None else {}),
                # Confirmed real cause of this call being extremely slow (user-
                # reported: a 83-requirement batch stalling well past normal):
                # unlike analyze_section/analyze_section_agentic (which both
                # already disable this with the identical doc comment/finding),
                # this call never set `think: False` -- a reasoning-capable
                # model (qwen3.6:35b) burns hidden chain-of-thought tokens
                # before ANY output, for EVERY one of the 83 items in one call,
                # with no observed accuracy benefit on this kind of structured-
                # extraction task. maxTokens caps worst-case output the same
                # way the other two calls already do.
                "think": False,
                "maxTokens": self._max_output_tokens,
                # Same numCtx gap as infer_trace_links/judge_kb_relevance --
                # without it, Ollama silently truncates this call's input to
                # its own small default regardless of how many requirements are
                # actually being scored. Very likely the real cause of the
                # "Quality scoring returned no valid score for N node(s)"
                # warning below: the tail of a large descriptions_by_node_id
                # JSON blob past the truncation point is never seen by the
                # model at all, so those node_ids can never appear in its
                # response no matter how well-behaved the model is.
                **({"numCtx": self._num_ctx} if self._num_ctx else {}),
                **({"topK": self._top_k} if self._top_k else {}),
                **({"minP": self._min_p} if self._min_p else {}),
                **({"seed": self._seed} if self._seed is not None else {}),
            }
            # Perf-investigation instrumentation (2026-08-01): wall time + payload
            # size per call, logged at call granularity -- lets a real job's logs
            # answer "does call duration scale with chunk size, or is it flat/
            # backend-queue-dominated" without guessing (see the performance
            # review that flagged this as unmeasured before touching
            # _SCORING_CHUNK_NODE_COUNT).
            request_chars = len(json.dumps(payload))
            started_at = time.monotonic()
            # Token counts not set -- see analyze_section's own comment on why
            # (LlmChatResult doesn't forward `usage` yet).
            with _tracer.start_as_current_span("score_requirements_for_document") as span:
                span.set_attribute("gen_ai.request.model", self._model or "default")
                span.set_attribute("gen_ai.operation.name", "chat")
                span.set_attribute("req2ado.node_count", len(descriptions))
                response = self._post_chat(payload, user_id)
                elapsed_seconds = time.monotonic() - started_at
                logger.info(
                    "score_requirements_for_document: %d node(s), %d request char(s), %.1fs wall time",
                    len(descriptions), request_chars, elapsed_seconds,
                )
                response.raise_for_status()
                body = response.json()
                parsed = _parse_json_object(_strip_json_fence(body["content"]))
            if body.get("finishReason") == "length":
                # The entry the token limit cut off may parse but be wrong; it is treated as not scored.
                parsed = drop_possibly_cut_last_entry(parsed)
            return parsed

        entries = run_keyed(send, descriptions_by_node_id, spec, model=self._model)
        result = {node_id: _with_category_dict(entry) for node_id, entry in entries.items()}
        # Only a complete answer is reused: a cached partial one would repeat the same gap on every re-run.
        if key is not None and not entries.missing:
            self._cache.set(key, result)
        return result

    def extract_quality_checklist(self, document_text: str, user_id: str | None = None) -> list[str]:
        """Runs ONCE per document, at KB ingestion time (see
        app.kb.ingest_service), never per scoring call -- the real fix for a
        confirmed real determinism gap (user-reported): asking the scoring
        model to "derive" categoryScores key names live, per call, is not a
        cross-run guarantee even at temperature=0. Extracting the checklist
        ONCE and storing it (KbVectorStore.upsert_chunk's quality_checklist
        param) makes the category set a genuine property of the ingested
        document -- every later scoring call reads the stored value instead
        of ever re-deriving it, so the SAME document run any number of times
        yields the SAME categories, guaranteed.

        Returns [] (not None) when the document genuinely defines no
        checklist -- a real, storable "checked, found nothing" signal,
        distinct from extraction never having run at all (see
        KbVectorStore.get_quality_checklist's own docstring for why that
        distinction matters). Capped input length: a checklist definition
        is a small, self-contained part of a document; this is structured
        extraction, not whole-document comprehension."""
        system_prompt = load_prompt("extract_quality_checklist")
        parsed = self._chat_json(
            system_prompt, document_text[:_CHECKLIST_EXTRACTION_MAX_CHARS],
            schema=checklist_extraction_schema(), max_tokens=2000, user_id=user_id,
        )
        # The schema asks for {"categories": [...]}; a model that still answers with the bare array is accepted.
        if isinstance(parsed, dict) and isinstance(parsed.get("categories"), list):
            parsed = parsed["categories"]
        if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
            raise ValueError(f"malformed JSON in LLM response content: {parsed!r}")
        return self._sanitize_checklist(parsed)

    def _sanitize_checklist(self, raw_items: list[str]) -> list[str]:
        """Strips/dedups/bounds a structurally-valid (list-of-strings)
        checklist extraction before it's stored and replayed into every
        future scoring prompt. Returns [] -- the module's existing "checked,
        found nothing" signal -- when the sanitized result falls outside a
        sane checklist shape, rather than raising: a bad extraction should
        degrade the same way "this document defines no checklist" already
        does, not fail the KB ingestion job it's part of. An empty input
        (the model's own genuine "no checklist here" response) returns []
        immediately, without a warning -- that is the correct, expected
        outcome, not a sanitization failure."""
        if not raw_items:
            return []
        seen_lower: set[str] = set()
        cleaned: list[str] = []
        for raw_item in raw_items:
            item = " ".join(raw_item.split())  # strips whitespace, collapses/rejects embedded newlines
            if not (_CHECKLIST_MIN_ITEM_CHARS <= len(item) <= _CHECKLIST_MAX_ITEM_CHARS):
                continue
            item_lower = item.lower()
            if item_lower in seen_lower:  # case-insensitive dedup, first-seen casing/order kept
                continue
            seen_lower.add(item_lower)
            cleaned.append(item)
        if not (_CHECKLIST_MIN_ITEMS <= len(cleaned) <= _CHECKLIST_MAX_ITEMS):
            logger.warning(
                "extract_quality_checklist produced %d usable item(s) after sanitization "
                "(raw count %d) -- outside the sane [%d, %d] range, treating as "
                "'no checklist found': %r",
                len(cleaned), len(raw_items), _CHECKLIST_MIN_ITEMS, _CHECKLIST_MAX_ITEMS,
                cleaned[:3],
            )
            return []
        return cleaned

    def extract_quality_checklist_definitions(
        self, document_text: str, category_names: list[str], user_id: str | None = None,
    ) -> dict[str, str]:
        """Best-effort SECOND extraction pass, run once at KB ingestion time
        immediately AFTER extract_quality_checklist (see
        app.kb.ingest_service), never replacing it and never run on its
        own -- `category_names` is that method's own already-sanitized,
        cross-run-deterministic output (the FIXED categoryScores key list,
        see score_requirements_for_document's own docstring for why those
        names are used VERBATIM as dict keys downstream). This pass asks the
        SAME document for whatever definition/explanation/pass-condition
        text it states for each of those ALREADY-DECIDED names -- it does
        NOT attempt to name the categories itself -- specifically so the
        returned dict's keys line up with category_names by construction,
        instead of risking a second, independent extraction drifting to
        slightly different wording for the same category (e.g.
        "Unambiguous" vs "Unambiguity") and silently failing to match up
        with the scores the reviewer actually sees.

        Returns {} (not None) for "ran, found no stated definition text for
        any of these categories" -- a document that lists only bare
        category names with no separate explanation is a genuine, common,
        EXPECTED outcome (org checklists vary widely in how much they
        write per category), not a failure. A category absent from the
        returned dict falls back to QualityGauge's generic description on
        the frontend, indistinguishable from a genuine no-checklist-at-all
        case -- see app.leveling.scoring._match_category_checklist."""
        if not category_names:
            return {}
        system_prompt = load_prompt(
            "extract_quality_checklist_definitions", category_names=json.dumps(category_names),
        )
        parsed = self._chat_json(
            system_prompt, document_text[:_CHECKLIST_EXTRACTION_MAX_CHARS],
            schema=checklist_definitions_schema(), max_tokens=2000, user_id=user_id,
        )
        if not isinstance(parsed, dict):
            raise ValueError(f"malformed JSON in LLM response content: {parsed!r}")
        return self._sanitize_checklist_definitions(parsed, category_names)

    def _sanitize_checklist_definitions(self, raw: dict, category_names: list[str]) -> dict[str, str]:
        """Tolerant of a model returning extra/misspelled keys (dropped,
        never trusted -- see extract_quality_checklist_definitions's own
        docstring for why matching against the FIXED category_names,
        case-insensitively, is safer than trusting the model's own key
        spelling verbatim) or a non-string value (dropped, same tolerant
        philosophy as _parse_category_scores). Values are TRUNCATED to
        _CHECKLIST_DEFINITION_MAX_CHARS, not dropped when over-length -- a
        trimmed real quote is still useful. An empty (whitespace-only)
        value is dropped, same as a missing one -- both mean "no real
        definition text for this category"."""
        valid_lower = {name.strip().lower(): name for name in category_names}
        result: dict[str, str] = {}
        if not isinstance(raw, dict):
            return result
        for key, value in raw.items():
            if not isinstance(key, str) or not isinstance(value, str):
                continue
            canonical_name = valid_lower.get(key.strip().lower())
            if canonical_name is None:
                continue
            definition = " ".join(value.split())  # strips whitespace, collapses embedded newlines
            if not definition:
                continue
            result[canonical_name] = definition[:_CHECKLIST_DEFINITION_MAX_CHARS]
        return result

    def score_epics_and_features_for_document(
        self, nodes_by_id: dict[str, dict], user_id: str | None = None,
    ) -> dict[str, dict]:
        """Batched Epic/Feature quality review -- the counterpart to
        score_requirements_for_document, deliberately kept as a SEPARATE
        call/prompt rather than folded into it: RequirementQualityIssue's
        closed vocabulary (ambiguous, not_testable, compound, ...) and the
        "formal shall-style requirement statement" framing describe atomic
        requirements, not what an Epic/Feature GROUPING is (see
        llm_leveling.py's own comment on why scoring was originally scoped
        to Requirement-type nodes only) -- reusing that prompt's wording
        verbatim for an Epic/Feature would judge them against a rubric that
        was never about them.

        `nodes_by_id` maps each node_id to {'type': 'Epic'|'Feature',
        'text': description} -- one call judges both types together (typical
        documents have far fewer Epics/Features than Requirements, so this
        stays cheap as one batched call rather than two). Returns node_id ->
        {'score': int, 'categoryScores': dict[str, int]} -- no 'issues' key,
        see epic_feature_scores_schema's own docstring for why."""
        key = None
        if self._cache is not None:
            key = cache_key(
                "score_epics_and_features_for_document", self._model, self._num_ctx, self._top_k, self._min_p, self._seed,
                nodes_by_id,
            )
            cached = self._cache.get(key)
            if cached is not None:
                logger.info("score_epics_and_features_for_document: cache hit, skipping LLM call")
                return cached
        spec = EPIC_FEATURE_SCORING_SPEC

        def send(nodes: dict, mode: KeyedMode) -> object:
            system_prompt = load_prompt(
                "score_epics_and_features_for_document",
                output_lead=output_lead(spec, mode),
                category_scores_form=(
                    "'categoryScores' (an array of {\"name\": <category name>, \"score\": <integer 0-100>} objects, "
                    "one for each category listed below)"
                    if mode == "array" else "'categoryScores'"
                ),
                node_count=str(len(nodes)),
            )
            schema = schema_for(spec, mode)
            payload = {
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": json.dumps(nodes)},
                ],
                "temperature": 0,
                **({"model": self._model} if self._model else {}),
                **({"responseSchema": schema} if schema is not None else {}),
                "think": False,
                "maxTokens": self._max_output_tokens,
                **({"numCtx": self._num_ctx} if self._num_ctx else {}),
                **({"topK": self._top_k} if self._top_k else {}),
                **({"minP": self._min_p} if self._min_p else {}),
                **({"seed": self._seed} if self._seed is not None else {}),
            }
            # Same perf-investigation instrumentation as
            # score_requirements_for_document -- see its own comment.
            request_chars = len(json.dumps(payload))
            started_at = time.monotonic()
            response = self._post_chat(payload, user_id)
            elapsed_seconds = time.monotonic() - started_at
            logger.info(
                "score_epics_and_features_for_document: %d node(s), %d request char(s), "
                "%.1fs wall time",
                len(nodes), request_chars, elapsed_seconds,
            )
            response.raise_for_status()
            body = response.json()
            parsed = _parse_json_object(_strip_json_fence(body["content"]))
            if body.get("finishReason") == "length":
                parsed = drop_possibly_cut_last_entry(parsed)
            return parsed

        entries = run_keyed(send, nodes_by_id, spec, model=self._model)
        result = {node_id: _with_category_dict(entry) for node_id, entry in entries.items()}
        if key is not None and not entries.missing:
            self._cache.set(key, result)
        return result

    def title_and_tags_for_rows(
        self, texts_by_row_id: dict[str, str], user_id: str | None = None,
    ) -> dict[str, dict]:
        """Backs the TitleTagClient protocol (id_tree_builder.py) -- the
        deterministic-hierarchy path's optional per-document title/tag
        enhancement pass. Confirmed real gap: `main.py`'s /level call site
        never actually constructed and passed a real TitleTagClient, so
        every deterministically-built node kept its raw
        extract_baseline_title-derived title (e.g. "The P." from "The P. S
        shall include electronic fuses...") and empty tags in production,
        even though `_apply_title_tag_pass` was fully built and tested.

        `texts_by_row_id` maps each deterministic leaf's own id to its
        (verbatim, unsynthesized) description text. Returns row_id ->
        {'title': str, 'tags': list[str]} -- a short, scannable title and
        zero or more RequirementTag values. Purely an enhancement:
        `_apply_title_tag_pass` already fails open on any exception or
        malformed/partial response, keeping the deterministic title/empty
        tags exactly as constructed."""
        spec = TITLE_TAGS_SPEC

        def send(payload: dict, mode: KeyedMode) -> object:
            # The output-format sentence and the strict schema are both generated from `spec`
            # (app.survey.keyed_calls), so the prompt and the schema cannot drift; a retry of
            # omitted ids re-enters here with just those ids.
            system_prompt = _with_authoring_standard(
                load_prompt(
                    "title_and_tags_for_rows",
                    tag_vocabulary=", ".join(t.value for t in RequirementTag),
                    row_count=str(len(payload)),
                    output_format=describe_output(spec, mode),
                ),
                self.authoring_standard,
            )
            return self._chat_json(
                system_prompt, json.dumps(payload), schema=schema_for(spec, mode), user_id=user_id,
                stream_inputs=dict(payload), stream_stage="improve",
            )

        return run_keyed(send, texts_by_row_id, spec, model=self._model)

    def summarize_parent_nodes(
        self, nodes_by_id: dict[str, dict], user_id: str | None = None,
    ) -> dict[str, dict]:
        """Backs the ParentSummaryClient protocol (id_tree_builder.py) --
        the deterministic-hierarchy path's Epic/Feature title+description
        enhancement pass. Confirmed real gap, live: an Epic/Feature's
        title AND description were both `extract_baseline_title(heading_text)`
        -- a verbatim copy of the source document's own section heading,
        identical to each other (e.g. both "Over 28V VDC input"), never
        touched by any LLM call -- TitleTagClient only ever reaches
        Requirement leaves.

        `nodes_by_id` maps each Epic/Feature node's own id to
        {'title': str (its current, possibly-verbatim title),
        'requirement_titles': list[str], 'requirement_descriptions':
        list[str]} -- EVERY descendant Requirement leaf's text, however
        deeply nested underneath this node (NOT just direct children --
        see _collect_descendant_requirement_texts's own docstring for
        why: the spec allows a Requirement nested under another
        Requirement, or an Epic nested under another Epic, and this
        node's real scope is everything underneath it, not just its
        immediate children). Returns node_id -> {'title': str,
        'description': str} -- title framed as
        ADO's own Epic ("large portfolio-level strategic goal") or Feature
        ("capability delivering direct user value") definition, description
        a DISTINCT 1-2 sentence summary of what the children collectively
        deliver, never identical to title. Purely an enhancement:
        `_apply_parent_summary_pass` already fails open on any exception or
        malformed/partial response, keeping the verbatim heading title and
        description exactly as constructed."""
        spec = PARENT_SUMMARY_SPEC

        def send(payload: dict, mode: KeyedMode) -> object:
            system_prompt = _with_authoring_standard(
                load_prompt("summarize_parent_nodes", node_count=str(len(payload)), output_format=describe_output(spec, mode)),
                self.authoring_standard,
            )
            return self._chat_json(
                system_prompt, json.dumps(payload), schema=schema_for(spec, mode), user_id=user_id,
                stream_inputs={k: v.get("title") if isinstance(v, dict) else None for k, v in payload.items()},
                stream_stage="summarize",
            )

        return run_keyed(send, nodes_by_id, spec, model=self._model)

    def synthesize_leaf_requirements(
        self, items_by_id: dict[str, dict], user_id: str | None = None,
    ) -> dict[str, dict]:
        """Backs the SynthesisClient protocol (id_tree_builder.py) -- the
        actual quality fix for the deterministic-hierarchy path's
        fragment-as-requirement problem (confirmed real, live: raw
        spec-table cells and headings like "Size: 3U 1\"" or "Over-current"
        were being emitted as standalone Requirement work items with zero
        synthesis). Reuses the exact instruction already proven in
        `_SECTION_ANALYSIS_SYSTEM_PROMPT` for the LLM-analysis path
        ("bullet/spec lists, tables synthesize into coherent requirements,
        NOT one requirement per line") -- this is the one place the
        deterministic path currently skips that synthesis entirely.

        `items_by_id` maps each flagged leaf's own id to {'text': its
        verbatim source text, 'context': a " > "-joined string of its
        parent chain's titles, root first -- informational only, not
        itself part of what gets judged}. Returns id -> {'title': str,
        'text': str, 'tags': list[str]} -- a synthesized, properly-formed
        requirement statement plus a short title and zero or more
        RequirementTag values. Purely an enhancement:
        `_apply_synthesis_pass` already fails open on any exception or
        malformed/partial response, keeping the flagged leaf's verbatim
        source text exactly as constructed."""
        spec = SYNTHESIS_SPEC

        def send(payload: dict, mode: KeyedMode) -> object:
            # The tag vocabulary is part of the generated output-format sentence (it comes from the same
            # field list as the schema), so it is not passed as a separate marker.
            system_prompt = _with_authoring_standard(
                load_prompt("synthesize_leaf_requirements", row_count=str(len(payload)), output_format=describe_output(spec, mode)),
                self.authoring_standard,
            )
            return self._chat_json(
                system_prompt, json.dumps(payload), schema=schema_for(spec, mode), user_id=user_id,
                stream_inputs={k: v.get("text") if isinstance(v, dict) else None for k, v in payload.items()},
                stream_stage="draft",
            )

        return run_keyed(send, items_by_id, spec, model=self._model)

    def distill_title(self, text: str, max_length: int, user_id: str | None = None) -> str:
        """Backs the TitleDistillationClient protocol
        (distillation/survey_title.py) -- 300553's smart-title fallback.
        `max_length` is included in the prompt as a hint, but never trusted
        to be honored: distill_survey_title (the caller) re-truncates the
        result via extract_baseline_title regardless, same "never trust an
        external response to self-enforce a hard limit" rule that function's
        own docstring documents."""
        system_prompt = load_prompt("distill_survey_title")
        parsed = self._chat_json(
            system_prompt, json.dumps({"text": text, "maxLength": max_length}), schema=distill_title_schema(),
            user_id=user_id,
        )
        return parsed["title"]

    def judge_duplicate_pair(
        self, candidate_text: str, matched_text: str, user_id: str | None = None,
    ) -> dict:
        """Backs the DuplicateJudgeClient protocol
        (check_for_duplicates.py) -- verifies a >=threshold embedding
        match against ADO's own vector store before trusting it as a real
        duplicate. Real gap closed here: `all-minilm` (this codebase's
        configured EMBED_MODEL) is a small, general-purpose sentence
        embedding -- confirmed real false-positive risk for two
        topically-adjacent but SCOPALLY DISTINCT short phrases (e.g. "UART
        and USB Ports" vs "USB Communication", both about "USB" but
        different requirement scope). Same 'redundant'/'contradictory'/
        'distinct' vocabulary as judge_duplicate_cluster's own within-job
        cluster judgment -- 'distinct' is the one that matters here (the
        candidate is genuinely a different requirement, only topically
        similar); 'redundant'/'contradictory' both mean the ADO item IS a
        real match for check_for_duplicates.py's purposes (it only answers
        "does this already exist," not conflict semantics)."""
        system_prompt = load_prompt("judge_duplicate_pair")
        return self._chat_json(
            system_prompt, json.dumps({"candidate": candidate_text, "existing": matched_text}),
            schema=duplicate_pair_verdict_schema(), user_id=user_id,
        )

    def judge_duplicate_cluster(self, texts_by_id: dict[str, str], user_id: str | None = None) -> dict:
        """Backs the ConflictJudgeClient protocol (llm_leveling.py) --
        real capability gap closed here: this codebase had NO
        conflict/contradiction detection anywhere. The existing dedup
        vector store answers "does this already exist in ADO," never "do
        these two say opposite things" -- confirmed live, real document:
        the SAME power-supply spec restated in a body section and its
        appendix produced near-duplicate embeddings for "efficiency shall
        be at least 85%" and "efficiency shall be at-least 93%", kept as
        two unrelated Requirement nodes with no signal either was wrong.

        `texts_by_id` maps each near-duplicate cluster member's own node
        id to its text (already clustered by cosine similarity by the
        caller -- this call only judges what the cluster's relationship
        actually IS, it does not do its own similarity search). Returns
        {'verdict': 'redundant'|'contradictory'|'distinct', 'conflicting_values':
        list[str]} -- 'redundant' means the statements restate the same
        fact (harmless duplication), 'contradictory' means they state
        different values for what looks like the same parameter (the real
        case this exists to catch), 'distinct' means the similarity match
        was a false positive (genuinely different requirements)."""
        system_prompt = load_prompt("judge_duplicate_cluster")
        return self._chat_json(
            system_prompt, json.dumps(texts_by_id), schema=duplicate_cluster_verdict_schema(), user_id=user_id,
        )

    def group_root_topics(self, titles_by_id: dict[str, str], user_id: str | None = None) -> dict:
        """Backs the RootGroupingClient protocol (llm_leveling.py) -- real
        gap closed here, confirmed against a real document (AirPro): a
        deterministically-built tree with no single top heading produced
        77 disconnected root nodes, unlike either external reference this
        session's investigation compared against, each of which
        synthesized ONE coherent hierarchy by regrouping topically related
        root sections (e.g. absorbing 14 separate VPX-signal root Features
        into one "VPX Utility & Management Signals" Feature).

        `titles_by_id` maps each disconnected root's own node id to its
        SHORT TITLE ONLY -- never full requirement content, since this
        call proposes STRUCTURE, not text (see _regroup_disconnected_
        roots's own docstring for why that distinction keeps this within
        the "never invent content" policy). Returns {'groups': [{'title':
        str, 'member_ids': list[str]}, ...]} -- a root id not mentioned in
        any group's member_ids is left as its own standalone root by the
        caller. A group needs at least 2 real members to matter; grouping
        every root into one bucket, or leaving every root ungrouped, are
        both valid answers when that's genuinely what the topics call
        for."""
        system_prompt = load_prompt("group_root_topics")
        return self._chat_json(
            system_prompt, json.dumps(titles_by_id), schema=root_grouping_schema(), user_id=user_id,
        )

    def judge_kb_document_relevance(self, name: str, excerpt: str, user_id: str | None = None) -> dict:
        """Backs the KB profile's relevance step (app.kb.profile): does this document help create work-item hierarchies?
        Returns {"relevant": bool, "reason": str}; raises ValueError on an answer without a boolean verdict."""
        system_prompt = load_prompt("kb_document_relevance")
        parsed = self._chat_json(
            system_prompt, json.dumps({"file_name": name, "excerpt": excerpt}, ensure_ascii=False),
            schema=kb_document_relevance_schema(), max_tokens=400, user_id=user_id,
        )
        if not isinstance(parsed, dict) or not isinstance(parsed.get("relevant"), bool):
            raise ValueError(f"malformed JSON in LLM response content: {parsed!r}")
        return {"relevant": parsed["relevant"], "reason": str(parsed.get("reason") or "")}

    def extract_kb_document_profile(self, name: str, window_text: str, user_id: str | None = None) -> dict:
        """Backs the KB profile's map step: what one window of a KB document states about quality categories, type
        definitions, writing rules and glossary terms. Malformed entries are dropped, never trusted."""
        system_prompt = load_prompt("extract_kb_document_profile")
        parsed = self._chat_json(
            system_prompt, json.dumps({"file_name": name, "text": window_text}, ensure_ascii=False),
            schema=kb_document_profile_schema(), max_tokens=4000, user_id=user_id,
        )
        if not isinstance(parsed, dict):
            raise ValueError(f"malformed JSON in LLM response content: {parsed!r}")

        def objects(key: str, *fields: str) -> list[dict]:
            return [
                {f: str(item[f]) for f in fields}
                for item in (parsed.get(key) or [])
                if isinstance(item, dict) and all(isinstance(item.get(f), str) for f in fields)
            ]

        return {
            "categories": [c for c in objects("categories", "name", "pass_condition") if c["name"].strip()],
            "type_definitions": [d for d in objects("type_definitions", "item_type", "text") if d["item_type"] in ("epic", "feature", "requirement") and d["text"].strip()],
            "rules": [r for r in (parsed.get("rules") or []) if isinstance(r, str) and r.strip()],
            "glossary": [g for g in objects("glossary", "term", "definition") if g["term"].strip()],
        }

    def consolidate_kb_categories(
        self, categories: list[dict], max_categories: int, user_id: str | None = None, preferred_names: list[str] | None = None,
    ) -> list[dict]:
        """Backs the KB profile's category merge (app.kb.profile): the same quality named differently by several documents
        (Testable / Testability) becomes one entry. Returns [{name, pass_condition, merged_from}]; malformed entries are
        dropped, an answer without a category list raises ValueError."""
        system_prompt = load_prompt("consolidate_kb_categories")
        parsed = self._chat_json(
            system_prompt, json.dumps(
                {"max_categories": max_categories, "categories": categories, **({"preferred_names": preferred_names} if preferred_names else {})},
                ensure_ascii=False,
            ),
            schema=kb_category_consolidation_schema(), max_tokens=3000, user_id=user_id,
        )
        if not isinstance(parsed, dict) or not isinstance(parsed.get("categories"), list):
            raise ValueError(f"malformed JSON in LLM response content: {parsed!r}")
        groups = []
        for item in parsed["categories"]:
            if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not item["name"].strip():
                continue
            members = [m for m in (item.get("merged_from") or []) if isinstance(m, str) and m.strip()]
            if members:
                groups.append({"name": " ".join(item["name"].split()), "pass_condition": " ".join(str(item.get("pass_condition") or "").split()), "merged_from": members})
        return groups

    def explain_category_scores(
        self, item: dict, context_text: str | None, categories: list[dict], basis: str, user_id: str | None = None,
    ) -> list[dict]:
        """Why an item got the scores it did, one short reason per category asked about (see app.kb.explain for the basis). Entries that are
        not {category, reason} strings are dropped; an answer without an explanation list raises ValueError."""
        system_prompt = load_prompt("explain_category_scores", basis=basis)
        parsed = self._chat_json(
            system_prompt, json.dumps(
                {
                    "item": item, "context": context_text, "categories": categories,
                    "reasons_language": "the language the item's description is written in",
                },
                ensure_ascii=False,
            ),
            schema=score_explanation_schema(), max_tokens=1500, user_id=user_id,
        )
        if not isinstance(parsed, dict) or not isinstance(parsed.get("explanations"), list):
            raise ValueError(f"malformed JSON in LLM response content: {parsed!r}")
        return [
            {"category": e["category"], "reason": e["reason"]}
            for e in parsed["explanations"]
            if isinstance(e, dict) and isinstance(e.get("category"), str) and isinstance(e.get("reason"), str)
        ]

    def judge_rule_conformance(self, rule: str, items: dict[str, str], user_id: str | None = None) -> dict[str, bool]:
        """Backs the KB conformance report (app.kb.conformance): does each item follow one stated writing rule? Returns
        {item id: bool} for the ids the model answered about; ids it skipped are absent, malformed entries dropped."""
        system_prompt = load_prompt("judge_rule_conformance")
        parsed = self._chat_json(
            system_prompt, json.dumps({"rule": rule, "items": items}, ensure_ascii=False),
            schema=rule_conformance_schema(), max_tokens=2000, user_id=user_id,
        )
        verdicts = parsed.get("verdicts") if isinstance(parsed, dict) else None
        if not isinstance(verdicts, list):
            raise ValueError(f"malformed JSON in LLM response content: {parsed!r}")
        return {
            str(v["id"]): v["conforms"] for v in verdicts
            if isinstance(v, dict) and str(v.get("id")) in items and isinstance(v.get("conforms"), bool)
        }

    def name_root_groups(self, titles_by_group_id: dict[str, list[str]], user_id: str | None = None) -> dict[str, str]:
        """Names groups that were already decided by a fixed rule (root_regrouping.deterministic_root_groups). The
        model only chooses wording: it cannot move, add or remove a member, so it cannot change any count. Returns
        {group_id: title}; a group the model skipped is simply absent (the caller supplies a fallback title)."""
        system_prompt = load_prompt("name_root_groups")
        result = self._chat_json(
            system_prompt, json.dumps(titles_by_group_id), schema=root_group_names_schema(), user_id=user_id,
        )
        names = result.get("names") if isinstance(result, dict) else None
        if not isinstance(names, list):
            return {}
        return {
            str(entry["group_id"]): " ".join(str(entry["title"]).split())
            for entry in names
            if isinstance(entry, dict) and "group_id" in entry and isinstance(entry.get("title"), str) and entry["title"].strip()
        }

    def assign_leftover_roots(
        self,
        leftover_titles_by_id: dict[str, str],
        group_titles_by_id: dict[str, str],
        user_id: str | None = None,
    ) -> dict:
        """Backs the RootGroupingClient protocol's second, optional method
        (llm_leveling.py) -- closes a real gap found in group_root_topics'
        own commit history: a controlled test (v1 -> v2 prompt change)
        confirmed the LOCAL model reliably misses a few titles that DO
        belong in a group it already formed, even with v2's explicit
        "re-check what you left out" instruction baked into the SAME
        single, non-reasoning generation. That self-check is prose inside
        one generation with nothing verifying it happened; this makes it a
        real second decision instead, with the already-created groups as
        actual input rather than something the model has to remember.

        `leftover_titles_by_id`/`group_titles_by_id` are both id->title
        maps, same "titles only, never full content" discipline as
        group_root_topics -- this call still only proposes STRUCTURE.
        Returns {'assignments': {leftover_id: group_id, ...}} -- a
        leftover id absent from `assignments` stays exactly where it was
        (still its own standalone root), the same "omission is a valid
        answer" contract group_root_topics' own member_ids already
        established. Invents zero new nodes: every assignment re-parents a
        real root under a group that already exists and already traces to
        real source content."""
        system_prompt = load_prompt("assign_leftover_roots")
        result = self._chat_json(
            system_prompt, json.dumps({"leftovers": leftover_titles_by_id, "groups": group_titles_by_id}),
            schema=leftover_assignment_schema(), user_id=user_id,
        )
        # The schema asks for [{id, group_id}] (a strict-compatible shape); callers read {leftover_id: group_id}.
        # A model that still answers with the older map is accepted as is.
        assignments = result.get("assignments") if isinstance(result, dict) else None
        if isinstance(assignments, list):
            folded = {
                str(entry["id"]): str(entry["group_id"])
                for entry in assignments
                if isinstance(entry, dict) and "id" in entry and "group_id" in entry
            }
            return {**result, "assignments": folded}
        return result

    def show_model(self, model: str, user_id: str | None = None) -> dict:
        """Backs the ModelCapsClient protocol (llm_leveling.py) -- a live
        Ollama /api/show lookup, proxied through the orchestrator's own
        /llm/show route (OpenWebUiClient.showModel), for a model NOT
        already in llm_leveling.py's hand-maintained `_MODEL_CAPS` table.
        Real gap closed here: every entry in that table was populated by a
        human manually running /api/show ONCE per model and hardcoding
        the result -- an unrecognized model previously got the exact same
        blanket conservative guess regardless of what it actually is.

        Returns {'context_length': int | None, 'capabilities': list[str]}
        -- `context_length` is None when the orchestrator's own lookup
        couldn't find the model's architecture-prefixed context-length
        key (an unrecognized architecture, or a non-Ollama backend that
        still answered but with no real model_info). This is a narrow
        read-only capability probe, NOT a /llm/chat call -- no
        system_prompt, no responseSchema, no model-generation cost at
        all; `_resolve_caps` (the sole caller) already fails open on any
        exception this raises, so this method itself stays a thin,
        undecorated passthrough."""
        headers = {"Authorization": f"Bearer {self._bearer_token}"}
        if user_id:
            headers["X-Req2Ado-User-Id"] = user_id
        with httpx.Client(transport=self._transport, timeout=self.request_timeout_seconds or _LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/show",
                json={"model": model},
                headers=headers,
            )
        response.raise_for_status()
        body = response.json()
        return {
            "context_length": body.get("contextLength"),
            "capabilities": body.get("capabilities") or [],
            # Present when the orchestrator got the answer from a LiteLLM proxy (limits stated per deployment).
            "max_output_tokens": body.get("maxOutputTokens"),
            "source": body.get("source"),
        }

    def judge_kb_relevance(
        self, branch_content: str, snippets: list[dict], user_id: str | None = None,
    ) -> dict[str, str]:
        """Verifies whether each KB snippet OFFERED to a branch's grounded
        calls was actually relevant to that branch's real content -- being
        above the retrieval similarity cutoff and pasted into a prompt
        (see app.kb.retrieval.retrieve_context) is not proof the model
        found it relevant, only that it was provided. `snippets` is a list
        of {source_file, text} dicts, addressed by 0-based index as a
        string key in the response (mirroring infer_hierarchy's node_id
        convention). Returns a dict mapping index -> 'relevant'/
        'not_relevant'; an index missing from the response (e.g. a
        malformed/degraded reply) is the caller's responsibility to treat
        as unknown, not a hard failure -- KB relevance judgment is an
        enhancement, never a hard dependency for a SURVEY job."""
        snippets_by_index = {
            str(i): {"source_file": s["source_file"], "text": s["text"]} for i, s in enumerate(snippets)
        }
        spec = KB_RELEVANCE_SPEC
        # Confirmed missing before this used _chat_json: this was the ONE
        # call in this module with no output cap at all -- the exact
        # unbounded-hidden-reasoning exposure _MAX_OUTPUT_TOKENS's own doc
        # comment documents (a reasoning model observed generating 40+ minute
        # single calls with no cap in place). Output here is a tiny
        # index->enum map, so _chat_json's default maxTokens is pure
        # downside-bounding, not a real content constraint. think=False
        # (also via _chat_json's default): binary relevant/not_relevant
        # judgment per snippet is structured classification, not open-ended
        # reasoning -- same confirmed-live finding as every other
        # non-conversational call in this module.
        def send(payload: dict, mode: KeyedMode) -> object:
            # A retry of omitted indices re-enters here with just those snippets.
            parsed = self._chat_json(
                load_prompt("judge_kb_relevance", output_format=describe_output(spec, mode)),
                json.dumps({"section_content": branch_content, "snippets": payload}),
                schema=schema_for(spec, mode),
                user_id=user_id,
            )
            # The prompt-only / legacy answer is {index: verdict}; read it as {index: {"verdict": ...}}.
            return wrap_scalar_entries(parsed, "verdict")

        entries = run_keyed(send, snippets_by_index, spec, model=self._model)
        return {index: entry["verdict"] for index, entry in entries.items()}

    def analyze_section(
        self,
        section_text: str,
        kb_context: str | None = None,
        *,
        options: SectionAnalysisOptions = DEFAULT_SECTION_ANALYSIS_OPTIONS,
        user_id: str | None = None,
    ) -> tuple[list[dict], bool]:
        """Single holistic SURVEY call replacing the old infer_hierarchy +
        generate_requirements_for_document pair for the whole-tree-in-one-call
        redesign. Given ONE coherent, structure-preserving markdown rendering
        of a whole section (see llm_leveling.render_section), returns the
        COMPLETE node set the model decides the section contains -- however
        many, not one per input block. This is the FALLBACK path for models
        without tool-calling support (see §5c's capability gate) -- KB context,
        when available, is a pre-computed once-per-document string threaded in
        via kb_context rather than actively retrieved. Tool-capable models use
        analyze_section_agentic instead.

        `whole_document`, when True, appends a coverage hint (see
        _whole_document_hint) -- the model is analyzing the ENTIRE document
        in one call (build_survey_tree's whole-doc gate found it fits
        budget), not one small section, and the base prompt's
        synthesis-maximizing instructions ("do NOT emit one node per bullet")
        otherwise drive over-consolidation when applied just once to
        hundreds of blocks instead of many times (once per branch/heading,
        the pre-whole-doc-gate design). `topic_count` (the document's real
        heading count, computed once in build_survey_tree) makes that hint
        quantitative -- confirmed live that a qualitative-only reminder does
        NOT change model behavior (see _whole_document_hint's docstring).

        These steering hints arrive as `options` (see
        app.section_analysis_options.SectionAnalysisOptions). This method
        honors four of its six fields -- `requirement_row_hints` and
        `heading_type_hints` landed with the two-stage skeleton split and
        are IGNORED here, exactly as they were absent from this signature
        before the bundle existed. Shared rather than split into a second
        four-field dataclass on purpose: a separate type for two fields
        would reintroduce the restatement bundling removes.

        `maxTokens` (§9 gap, confirmed live): a whole-section holistic
        response can be substantially larger than any single legacy
        per-node/per-branch-outline call, and a reasoning/"thinking" model
        (e.g. gemma4:e4b) burns hidden chain-of-thought tokens before its
        actual JSON answer -- without an explicit cap this is bounded by
        whatever small default Ollama/Open WebUI applies, silently
        truncating a real response mid-array. Observed live: a 679-block,
        6-section AirPro document's section 1 truncated at ~8.4KB
        ('Expecting , delimiter'), well under output any legacy call would
        need. Same _MAX_OUTPUT_TOKENS ceiling the other calls already
        trust for large branches.

        Returns (nodes, truncated) -- `truncated` is True when the
        orchestrator reports finishReason == 'length' (the LLM backend
        itself hit its output-token cap), a real signal a genuinely
        truncated response was NOT silently caught by _parse_json_object's
        limited (missing-final-brace-only) tolerance; the caller surfaces
        this as a branch warning rather than staying silent."""
        key = None
        if self._cache is not None:
            key = cache_key(
                # Unpacked field-by-field rather than as one `options`
                # part: cache_key serializes its *parts with default=str,
                # so handing it the dataclass would stringify the
                # instance's repr and change every key against a live
                # production cache. Field order is load-bearing. Only the
                # four fields this method honors appear here -- adding the
                # two skeleton-only ones would change the key for no
                # behavioral reason.
                "analyze_section", self._model, self._num_ctx, self._top_k, self._min_p, self._seed,
                section_text, kb_context, options.whole_document, options.topic_count,
                options.table_group_hints, options.expected_root_count,
            )
            cached = self._cache.get(key)
            if cached is not None:
                logger.info("analyze_section: cache hit, skipping LLM call")
                return cached["nodes"], cached["truncated"]
        system_prompt = _with_kb_context(
            _section_analysis_system_prompt(options.expected_root_count), kb_context
        )
        if options.whole_document:
            system_prompt += _whole_document_hint(options.topic_count)
        elif options.topic_count is not None:
            system_prompt += _branch_topic_hint(options.topic_count)
        system_prompt += _table_group_hint(options.table_group_hints)
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": section_text},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": section_analysis_schema(),
            "maxTokens": self._max_output_tokens,
            # Confirmed live (qwen3.6:35b, gemma4:31b): a reasoning-capable
            # model's hidden chain-of-thought adds 3-10x wall-clock time on
            # this holistic-JSON-extraction call with no observed accuracy
            # benefit -- disabling it via the orchestrator's `think` passthrough
            # (see LlmChatOptions.think's doc comment) is a pure win here. Not
            # applied to every LLM call in this file -- only the two SURVEY
            # section-analysis paths (this one and analyze_section_agentic)
            # this finding was actually tested against.
            "think": False,
            **({"numCtx": self._num_ctx} if self._num_ctx else {}),
            **({"seed": self._seed} if self._seed is not None else {}),
            **({"topK": self._top_k} if self._top_k else {}),
            **({"minP": self._min_p} if self._min_p else {}),
        }
        # gen_ai.* attributes follow OTel's GenAI semantic conventions.
        # Token counts are NOT set here -- the orchestrator's /llm/chat proxy
        # (LlmChatResult) doesn't forward `usage` from the underlying
        # OpenAI-compat response today, a real gap tracked separately (S6
        # only adds the tracing scaffolding; extending LlmChatResult with a
        # usage passthrough is its own small follow-up, not fabricated here).
        with _tracer.start_as_current_span("analyze_section") as span:
            span.set_attribute("gen_ai.request.model", self._model or "default")
            span.set_attribute("gen_ai.operation.name", "chat")
            response = self._post_chat(payload, user_id)
            response.raise_for_status()
            body = response.json()
            content = _strip_json_fence(body["content"])
            nodes = _nodes_from_parsed(_parse_json_object(content))
            span.set_attribute("gen_ai.response.node_count", len(nodes))
        truncated = body.get("finishReason") == "length"
        if truncated:
            notice("output_limit_reached", "warning", with_last_item=True, step="analyze")
        logger.warning(
            "analyze_section result: node_count=%d finishReason=%r truncated=%s topic_count=%r",
            len(nodes), body.get("finishReason"), truncated, options.topic_count,
        )
        # Never cache a truncated result -- it's a degraded/incomplete
        # response (the LLM backend hit its own output-token cap), and
        # caching it would durably perpetuate that instead of letting a
        # later re-run get a real, complete answer.
        if key is not None and not truncated:
            self._cache.set(key, {"nodes": nodes, "truncated": truncated})
        return nodes, truncated

    def analyze_section_agentic(
        self,
        section_text: str,
        retrieve_fn: Callable[[str], tuple[str | None, list[dict]]],
        list_documents_fn: Callable[[], list[str]] | None = None,
        read_document_fn: Callable[[str], str | None] | None = None,
        read_other_section_fn: Callable[[str], str | None] | None = None,
        *,
        options: SectionAnalysisOptions = DEFAULT_SECTION_ANALYSIS_OPTIONS,
        user_id: str | None = None,
    ) -> tuple[list[dict], list[dict], bool]:
        """Tool-calling variant of analyze_section for models that support it
        (see §5c's capability gate) -- the model actively pulls KB context via
        a query_kb tool call DURING analysis instead of us pre-computing
        relevance once per document. `retrieve_fn` is injected by the caller
        (closing over area_path/embed_client/vector_store -> retrieve_context,
        see llm_leveling._build_survey_skeleton_for_branch) so this client stays
        free of KB dependencies -- it only executes tool calls the model asks
        for. Bounded to _MAX_TOOL_ROUNDS turns so a model that keeps calling
        the tool can't loop forever. Returns (nodes, citations, truncated) --
        citations are every (source_file, similarity) hit actually retrieved
        across all query_kb calls, marked relevant by the model's own choice
        to use them (see llm_leveling's KbCitation construction); `truncated`
        -- see analyze_section's own docstring -- is True only when a FINAL
        answer round reports finishReason == 'length'; exhausting
        _MAX_TOOL_ROUNDS without ever reaching a final answer is a distinct
        failure mode (the loop gave up, not a length cap) and reports
        truncated=False.

        `list_documents_fn`/`read_document_fn` (§15) are optional, same
        injected-closure convention as `retrieve_fn` -- when supplied, the
        model additionally gets `list_kb_documents`/`read_kb_document` tools
        for reading a FULL previously-ingested KB document (see
        KbVectorStore.get_document), not just top-k similarity snippets.
        Omitting either (the pre-§15 default) is byte-identical to before
        this capability existed -- only `query_kb` is offered.

        `read_other_section_fn` (new whole-document-redesign §3) is likewise
        optional and orthogonal to the KB tools above -- it's supplied only
        on the multi-branch fallback path (llm_leveling.build_survey_tree),
        where a compact document outline is prepended to section_text and
        this closure resolves another section's FULL text by its outline
        number. Omitting it (single-branch / whole-document path, or a KB
        client with no outline built) offers no read_other_section tool.

        `whole_document`/`topic_count` -- see analyze_section's own docstring."""
        tools, tool_hint = _agentic_tools_and_hint(list_documents_fn, read_document_fn, read_other_section_fn)
        system_prompt = _section_analysis_system_prompt(options.expected_root_count) + tool_hint
        if options.whole_document:
            system_prompt += _whole_document_hint(options.topic_count)
        elif options.topic_count is not None:
            system_prompt += _branch_topic_hint(options.topic_count)
        system_prompt += _table_group_hint(options.table_group_hints)
        citations: list[dict] = []
        content, truncated, rounds_exhausted = self._run_agentic_rounds(
            system_prompt, section_text, section_analysis_schema(), tools,
            retrieve_fn, list_documents_fn, read_document_fn, read_other_section_fn,
            citations, "analyze_section_agentic", user_id,
        )
        if content:
            nodes = _nodes_from_parsed(_parse_json_object(content))
            logger.warning(
                "analyze_section_agentic result: node_count=%d truncated=%s query_kb_calls=%d topic_count=%r",
                len(nodes), truncated, len(citations), options.topic_count,
            )
            return nodes, citations, truncated
        if rounds_exhausted:
            # Exceeded _MAX_TOOL_ROUNDS without a final answer -- degrade to no
            # nodes for this branch rather than looping forever; the branch's
            # existing coverage/completeness warnings surface the gap. Not a
            # length-cap truncation (no final answer was ever reached to check
            # finishReason on) -- reported as truncated=False, a distinct
            # failure mode from analyze_section's own truncation signal.
            logger.warning("analyze_section_agentic: exceeded _MAX_TOOL_ROUNDS=%d without a final answer -- 0 nodes", _MAX_TOOL_ROUNDS)
            return [], citations, False
        # A round contradicted toolChoice:'none' (or returned neither
        # tool_calls nor content) -- extremely unlikely per the API contract,
        # but fall back to a single non-agentic analyze_section call over the
        # same section text rather than silently returning 0 nodes.
        #
        # Forwards ONLY whole_document/topic_count, NOT table_group_hints/
        # expected_root_count -- reproducing this method's pre-existing
        # behavior exactly. `options=options` here would look like the
        # obvious refactor and would silently START forwarding two hints
        # this path has never forwarded. (Contrast
        # analyze_section_skeleton_agentic, whose own fallback deliberately
        # forwards everything.) Whether that asymmetry SHOULD be closed is
        # a separate question from this refactor and is recorded as its own
        # observation in SWEEP.md; pinned down by
        # test_analyze_section_agentic_degraded_fallback_drops_the_table_
        # group_and_root_count_hints.
        fallback_nodes, fallback_truncated = self.analyze_section(
            section_text,
            kb_context=None,
            options=SectionAnalysisOptions(
                whole_document=options.whole_document, topic_count=options.topic_count,
            ),
            user_id=user_id,
        )
        return fallback_nodes, citations, fallback_truncated

    def analyze_section_skeleton(
        self,
        section_text: str,
        kb_context: str | None = None,
        *,
        options: SectionAnalysisOptions = DEFAULT_SECTION_ANALYSIS_OPTIONS,
        user_id: str | None = None,
    ) -> tuple[list[dict], bool]:
        """STAGE 1 of the two-stage SURVEY generation split: the STRUCTURE
        half of what analyze_section used to decide in one call. Given the
        same single coherent rendering of a whole section, returns the
        complete node SKELETON -- [{temp_id, type, parent_temp_id, title,
        customer_id}] -- with no requirement text, no tags, and no figure/
        table ids at all (see section_skeleton_schema and the
        section_skeleton prompt; 'customer_id' is the one deliberate
        exception -- see that schema's own docstring for why). The content
        half is authored separately, against this already-decided skeleton,
        by author_content; figure/table attachment is a separate
        whole-document mapping pass between the two.

        Every steering parameter analyze_section takes is kept and means
        exactly the same thing here, because every one of them steers a
        STRUCTURAL decision -- they now arrive bundled as `options` (see
        app.section_analysis_options.SectionAnalysisOptions, which
        documents each field, including the two this method adds over
        analyze_section: `requirement_row_hints` and `heading_type_hints`,
        each a confirmed-live gap, not a speculative knob).
        `kb_context` (the non-tool-capable path's pre-computed
        once-per-document string) stays a standalone parameter and is
        threaded in with the same soft framing analyze_section uses --
        domain material can genuinely inform where a node boundary
        belongs, not just how a requirement is worded.

        This is the FALLBACK path for models without tool-calling support;
        tool-capable models use analyze_section_skeleton_agentic instead.
        Returns (nodes, truncated) -- same contract as analyze_section's own
        return, see its docstring for what `truncated` means and why the
        caller surfaces it rather than swallowing it."""
        key = None
        if self._cache is not None:
            key = cache_key(
                # Corrected 2026-08-26: bumped to .v4 -- the heading-outline
                # hint's own wording and typing rules changed (relative,
                # tree-shape-derived typing replacing an absolute Heading
                # 1/Heading 2 map -- see heading_outline.py's own docstring).
                # cache_key covers the call's own arguments but not the
                # prompt/schema text itself, and this cache is live in
                # production with a 24h TTL -- a pre-change entry would
                # replay the old absolute-level behavior for a full day if
                # this key stayed unchanged.
                #
                # The six steering fields are unpacked individually rather
                # than passed as one `options` part on purpose: cache_key
                # serializes its *parts with default=str, so handing it the
                # dataclass would stringify the instance's repr and change
                # EVERY key -- invalidating a live production cache for no
                # reason. Field order here is load-bearing.
                "analyze_section_skeleton.v4", self._model, self._num_ctx, self._top_k, self._min_p, self._seed,
                section_text, kb_context, options.whole_document, options.topic_count,
                options.table_group_hints, options.expected_root_count,
                options.requirement_row_hints, options.heading_type_hints,
            )
            cached = self._cache.get(key)
            if cached is not None:
                logger.info("analyze_section_skeleton: cache hit, skipping LLM call")
                return cached["nodes"], cached["truncated"]
        system_prompt = _with_kb_context(
            _section_skeleton_system_prompt(options.expected_root_count), kb_context
        )
        if options.whole_document:
            system_prompt += _whole_document_hint(options.topic_count)
        elif options.topic_count is not None:
            system_prompt += _branch_topic_hint(options.topic_count)
        system_prompt += _table_group_hint(options.table_group_hints)
        system_prompt += _requirement_row_hint(options.requirement_row_hints)
        system_prompt += _heading_outline_hint(options.heading_type_hints)
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": section_text},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": section_skeleton_schema(),
            "maxTokens": self._max_output_tokens,
            # Same confirmed-live finding as analyze_section's identical doc
            # comment -- this call inherits that finding directly, being the
            # same holistic-JSON-extraction work minus the content half.
            "think": False,
            **({"numCtx": self._num_ctx} if self._num_ctx else {}),
            **({"seed": self._seed} if self._seed is not None else {}),
            **({"topK": self._top_k} if self._top_k else {}),
            **({"minP": self._min_p} if self._min_p else {}),
        }
        with _tracer.start_as_current_span("analyze_section_skeleton") as span:
            span.set_attribute("gen_ai.request.model", self._model or "default")
            span.set_attribute("gen_ai.operation.name", "chat")
            response = self._post_chat(payload, user_id)
            response.raise_for_status()
            body = response.json()
            content = _strip_json_fence(body["content"])
            nodes = _nodes_from_parsed(_parse_json_object(content))
            span.set_attribute("gen_ai.response.node_count", len(nodes))
        truncated = body.get("finishReason") == "length"
        if truncated:
            notice("output_limit_reached", "warning", with_last_item=True, step="skeleton")
        logger.warning(
            "analyze_section_skeleton result: node_count=%d finishReason=%r truncated=%s topic_count=%r",
            len(nodes), body.get("finishReason"), truncated, options.topic_count,
        )
        # Never cache a truncated result -- same reasoning as analyze_section's
        # own identical guard.
        if key is not None and not truncated:
            self._cache.set(key, {"nodes": nodes, "truncated": truncated})
        return nodes, truncated

    def analyze_section_skeleton_agentic(
        self,
        section_text: str,
        retrieve_fn: Callable[[str], tuple[str | None, list[dict]]],
        list_documents_fn: Callable[[], list[str]] | None = None,
        read_document_fn: Callable[[str], str | None] | None = None,
        read_other_section_fn: Callable[[str], str | None] | None = None,
        *,
        options: SectionAnalysisOptions = DEFAULT_SECTION_ANALYSIS_OPTIONS,
        user_id: str | None = None,
    ) -> tuple[list[dict], list[dict], bool]:
        """Tool-calling variant of analyze_section_skeleton, standing in the
        same relation to it that analyze_section_agentic does to
        analyze_section (see that method's docstring for the tool set, the
        injected-closure convention, the _MAX_TOOL_ROUNDS bound and what
        `truncated` does and does not mean).

        The tool-calling round trip stays on THIS stage, not on
        author_content, deliberately: the KB/other-section material a model
        pulls here is retrieved ONCE per branch and then handed to
        author_content as a plain pre-computed kb_context (see
        llm_leveling._author_branch_content), so both stages end up grounded
        in the same real material for the price of one agentic loop rather
        than two.

        Returns (nodes, citations, truncated) -- skeleton nodes, every
        query_kb hit actually retrieved across all rounds, and the same
        final-round length-cap signal analyze_section_agentic reports."""
        tools, tool_hint = _agentic_tools_and_hint(list_documents_fn, read_document_fn, read_other_section_fn)
        system_prompt = _section_skeleton_system_prompt(options.expected_root_count) + tool_hint
        if options.whole_document:
            system_prompt += _whole_document_hint(options.topic_count)
        elif options.topic_count is not None:
            system_prompt += _branch_topic_hint(options.topic_count)
        system_prompt += _table_group_hint(options.table_group_hints)
        system_prompt += _requirement_row_hint(options.requirement_row_hints)
        system_prompt += _heading_outline_hint(options.heading_type_hints)
        citations: list[dict] = []
        content, truncated, rounds_exhausted = self._run_agentic_rounds(
            system_prompt, section_text, section_skeleton_schema(), tools,
            retrieve_fn, list_documents_fn, read_document_fn, read_other_section_fn,
            citations, "analyze_section_skeleton_agentic", user_id,
        )
        if content:
            nodes = _nodes_from_parsed(_parse_json_object(content))
            logger.warning(
                "analyze_section_skeleton_agentic result: node_count=%d truncated=%s query_kb_calls=%d topic_count=%r",
                len(nodes), truncated, len(citations), options.topic_count,
            )
            return nodes, citations, truncated
        if rounds_exhausted:
            logger.warning(
                "analyze_section_skeleton_agentic: exceeded _MAX_TOOL_ROUNDS=%d without a final answer -- 0 nodes",
                _MAX_TOOL_ROUNDS,
            )
            return [], citations, False
        # Forward every steering hint into the degraded fallback too --
        # easy to miss since this branch is reached only on a weak/
        # misbehaving tool-capable model, exactly where these hints matter
        # most. `options=options` reproduces today's full forwarding
        # (contrast analyze_section_agentic's own fallback, which forwards
        # only two of its four hints -- a pre-existing asymmetry this
        # refactor deliberately preserves rather than silently changing).
        fallback_nodes, fallback_truncated = self.analyze_section_skeleton(
            section_text, kb_context=None, options=options, user_id=user_id,
        )
        return fallback_nodes, citations, fallback_truncated

    def author_content(
        self,
        section_text: str,
        skeleton_nodes: dict[str, dict],
        kb_context: str | None = None,
        user_id: str | None = None,
    ) -> tuple[dict[str, dict], bool]:
        """STAGE 3 of the two-stage SURVEY generation split: the CONTENT
        half of what analyze_section used to decide in one call. Given the
        same section text AND the tree that stage 1 already decided for it,
        returns each node's authored content -- and nothing else.

        `skeleton_nodes` maps each node's own id to {'type', 'title',
        'parent_id'} (the same real-node-id-keyed convention
        summarize_parent_nodes/score_epics_and_features_for_document already
        use, rather than a second temp-id space): 'parent_id' is
        informational context for authoring, NOT something this call may
        change. The prompt states the hierarchy is FIXED -- no node may be
        added, dropped, re-typed, re-parented or renamed here, because those
        decisions were already made, already repaired
        (_repair_requirement_hierarchy), and already regrouped
        whole-document (_regroup_disconnected_roots) before this call runs.

        Returns ({node_id: {'description', 'tags'}}, truncated). `truncated`
        matters at least as much here as it did on the old single call -- a
        long branch's full requirement text is exactly the payload most
        likely to hit the output-token cap -- so it is surfaced the same way
        rather than swallowed; a node the response omits is the CALLER's
        problem to degrade gracefully (see llm_leveling._author_branch_content),
        never silently dropped here.

        Response-cached on the same terms as analyze_section/
        analyze_section_skeleton (see this class's `cache` param), and for a
        sharper reason than either: splitting generation in two DOUBLED a
        document's per-branch call count, and this is the larger half of the
        pair. Caching only stage 1 would mean a re-run paid full price for
        exactly the expensive call. The key covers every input that can
        change the answer -- the section text, the already-decided skeleton
        (a different tree over the same section is a genuinely different
        request), and the grounding context."""
        key = None
        if self._cache is not None:
            key = cache_key(
                "author_content", self._model, self._num_ctx, self._top_k, self._min_p, self._seed,
                section_text, skeleton_nodes, kb_context,
            )
            cached = self._cache.get(key)
            if cached is not None:
                logger.info("author_content: cache hit, skipping LLM call")
                return cached["content"], cached["truncated"]
        spec = AUTHOR_CONTENT_SPEC
        truncated = False

        def send(nodes: dict, mode: KeyedMode) -> object:
            nonlocal truncated
            system_prompt = _with_authoring_standard(
                _with_kb_context(
                    load_prompt(
                        "author_content",
                        tag_vocabulary=", ".join(t.value for t in RequirementTag),
                        node_count=str(len(nodes)),
                        output_format=describe_output(spec, mode),
                    ),
                    kb_context,
                ),
                self.authoring_standard,
            )
            schema = schema_for(spec, mode)
            payload = {
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {
                        "role": "user",
                        "content": json.dumps({"section": section_text, "nodes": nodes}),
                    },
                ],
                "temperature": 0,
                **({"model": self._model} if self._model else {}),
                **({"responseSchema": schema} if schema is not None else {}),
                "maxTokens": self._max_output_tokens,
                # Same confirmed-live finding as the two section-analysis paths
                # this call was split out of -- structured extraction over text
                # already in the prompt, not open-ended reasoning.
                "think": False,
                **({"numCtx": self._num_ctx} if self._num_ctx else {}),
                **({"seed": self._seed} if self._seed is not None else {}),
                **({"topK": self._top_k} if self._top_k else {}),
                **({"minP": self._min_p} if self._min_p else {}),
            }
            with _tracer.start_as_current_span("author_content") as span:
                span.set_attribute("gen_ai.request.model", self._model or "default")
                span.set_attribute("gen_ai.operation.name", "chat")
                response = self._post_chat(payload, user_id)
                response.raise_for_status()
                body = response.json()
                content = _strip_json_fence(body["content"])
                parsed = _parse_json_object(content)
                span.set_attribute("gen_ai.response.node_count", len(parsed) if isinstance(parsed, dict) else 0)
            if body.get("finishReason") == "length":
                truncated = True
                # The entry the token limit cut off may have been repaired into something that parses but is
                # wrong; it is treated as not answered (the caller already degrades for an absent node).
                parsed = drop_possibly_cut_last_entry(parsed)
            return parsed

        # No retry of omitted nodes: a long branch's full text is exactly what hits the output cap, so
        # repeating it would pay twice for the same cut-off, and the caller already decides what an
        # absent node means (see llm_leveling._author_branch_content).
        result = run_keyed(send, skeleton_nodes, spec, model=self._model, retry=False)
        if truncated:
            notice("output_limit_reached", "warning", with_last_item=True, step="write")
        logger.warning(
            "author_content result: requested=%d returned=%d truncated=%s",
            len(skeleton_nodes), len(result), truncated,
        )
        # Never cache a truncated result -- same reasoning as analyze_section's
        # own identical guard.
        if key is not None and not truncated:
            self._cache.set(key, {"content": dict(result), "truncated": truncated})
        return dict(result), truncated

    def map_figures_tables(
        self, candidates: dict[str, dict], items: dict[str, dict], user_id: str | None = None,
    ) -> dict[str, dict]:
        """STAGE 2 of the two-stage SURVEY generation split: which EXACT node
        each of this document's figures/tables belongs to. Runs BETWEEN
        stage 1 (structure) and stage 3 (content) -- exact-node binding is
        impossible before the nodes exist, and pointless after their text is
        already written against a figure/table set nobody decided.

        `candidates` maps each candidate node id to {'type', 'title'} --
        TITLES ONLY, never descriptions (there are none yet at this point in
        the pipeline, and titles are what makes a whole-document candidate
        list affordable). `items` maps each figure/table id to its own
        minimal identifying info ({'kind', 'section', 'caption', and
        'columns' for a table}) -- nothing is fetched for this call that the
        pipeline doesn't already hold.

        Returns {item_id: {'node_id': str | None, 'escalate': bool}} -- the
        three outcomes the caller distinguishes (see
        figure_table_mapping_schema's own docstring): matched to a specific
        node, judged decorative/irrelevant to every node, or needing the
        whole-document escalation tier because no candidate offered here is
        its real home. Validation of a returned node_id against the real
        candidate set is the CALLER's job (llm_leveling.
        _map_figures_tables_to_nodes), the same division of labour
        author_content already documents for its own omitted-node case.

        BATCHED, never per-figure: one call carries an entire branch's
        figures AND tables (tier 1), or a whole chunk of escalated leftovers
        (tier 2). At the 918-figure scale this stage exists for, a per-figure
        call would double the already-dominant sequential vision-captioning
        cost -- so this method's cost scales with branch/chunk count, not
        figure count.

        Response-cached on the same terms as author_content/analyze_section
        (see this class's `cache` param) -- deterministic given the same
        candidates and the same items, and re-running a document is exactly
        when paying for a third per-branch call again would hurt most. An
        INCOMPLETE answer is never cached, same guard those two apply to a
        truncated one and for a sharper reason: an unanswered item silently
        becomes an exclusion downstream, so caching a partial answer would
        make that loss permanent across every re-run. No truncation flag is
        returned, unlike author_content -- the caller can already see exactly
        WHICH items went unanswered (they are simply absent from this dict),
        which is strictly more actionable than a boolean, and is how it
        decides between escalating them and reporting them."""
        key = None
        if self._cache is not None:
            key = cache_key(
                "map_figures_tables", self._model, self._num_ctx, self._top_k, self._min_p, self._seed,
                candidates, items,
            )
            cached = self._cache.get(key)
            if cached is not None:
                logger.info("map_figures_tables: cache hit, skipping LLM call")
                return cached
        spec = FIGURE_TABLE_MAPPING_SPEC
        cut_off = False

        def send(subset: dict, mode: KeyedMode) -> object:
            nonlocal cut_off
            system_prompt = load_prompt(
                "map_figures_tables", item_count=str(len(subset)), output_format=describe_output(spec, mode),
            )
            schema = schema_for(spec, mode)
            payload = {
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {
                        "role": "user",
                        "content": json.dumps({"candidates": candidates, "items": subset}),
                    },
                ],
                "temperature": 0,
                **({"model": self._model} if self._model else {}),
                **({"responseSchema": schema} if schema is not None else {}),
                "maxTokens": self._max_output_tokens,
                # Same confirmed-live finding as every other structured-extraction
                # call in this class -- classification over material already in
                # the prompt, not open-ended reasoning.
                "think": False,
                **({"numCtx": self._num_ctx} if self._num_ctx else {}),
                **({"seed": self._seed} if self._seed is not None else {}),
                **({"topK": self._top_k} if self._top_k else {}),
                **({"minP": self._min_p} if self._min_p else {}),
            }
            with _tracer.start_as_current_span("map_figures_tables") as span:
                span.set_attribute("gen_ai.request.model", self._model or "default")
                span.set_attribute("gen_ai.operation.name", "chat")
                span.set_attribute("gen_ai.request.item_count", len(subset))
                response = self._post_chat(payload, user_id)
                response.raise_for_status()
                body = response.json()
                content = _strip_json_fence(body["content"])
                parsed = _parse_json_object(content)
                span.set_attribute("gen_ai.response.item_count", len(parsed) if isinstance(parsed, dict) else 0)
            if body.get("finishReason") == "length":
                cut_off = True
                parsed = drop_possibly_cut_last_entry(parsed)
            return parsed

        # No retry of omitted items: the caller sees exactly which ones went unanswered and decides
        # between escalating them and reporting them (see _map_figures_tables_to_nodes).
        result = dict(run_keyed(send, items, spec, model=self._model, retry=False))
        # An item this response never answered for costs that item its home
        # (in the escalation tier there is no further tier to fall through
        # to), so an incomplete answer must never be reused: cached, it would
        # reproduce the SAME silent loss on every re-run of this document
        # instead of getting a real answer on retry. Both causes are treated
        # identically -- the model's own output cap (finishReason, the same
        # signal analyze_section/author_content guard their caches with) and
        # a response that simply came back short of what was asked.
        incomplete = cut_off or len(result) < len(items)
        if cut_off:
            notice("output_limit_reached", "warning", with_last_item=True, step="figures")
        logger.warning(
            "map_figures_tables result: candidates=%d requested=%d returned=%d incomplete=%s",
            len(candidates), len(items), len(result), incomplete,
        )
        if key is not None and not incomplete:
            self._cache.set(key, result)
        return result

    def _run_agentic_rounds(
        self,
        system_prompt: str,
        user_content: str,
        response_schema: dict,
        tools: list[dict],
        retrieve_fn: Callable[[str], tuple[str | None, list[dict]]],
        list_documents_fn: Callable[[], list[str]] | None,
        read_document_fn: Callable[[str], str | None] | None,
        read_other_section_fn: Callable[[str], str | None] | None,
        citations: list[dict],
        label: str,
        user_id: str | None = None,
    ) -> tuple[str | None, bool, bool]:
        """The bounded tool-calling round loop shared by every agentic
        SURVEY call (analyze_section_agentic and its skeleton counterpart) --
        extracted verbatim from analyze_section_agentic when the second
        caller appeared, deliberately preserving every decision documented at
        its original call site (see the inline comments below). Appends every
        query_kb hit to `citations` in place, exactly as before.

        Returns (final_content, truncated, rounds_exhausted): a non-None
        `final_content` is the model's raw final answer string for the
        caller to parse with its own schema's shape in mind. `rounds_exhausted`
        distinguishes the two no-answer outcomes the callers degrade
        differently for -- True when _MAX_TOOL_ROUNDS ran out with no final
        answer (degrade to nothing), False when a round returned neither
        tool_calls nor content (fall back to the non-agentic call)."""
        messages: list[dict] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ]
        for round_index in range(_MAX_TOOL_ROUNDS):
            # On the last permitted round, force a final answer instead of
            # allowing yet another tool call -- confirmed real cause of a
            # branch silently contributing 0 nodes: a model that keeps
            # calling query_kb/read_kb_document right up to the round
            # budget previously fell straight into the "exceeded
            # _MAX_TOOL_ROUNDS" branch below with no final answer ever
            # produced. toolChoice:'none' on the OpenAI-compat wire (already
            # plumbed end-to-end, just never set by any caller) tells the
            # model tool use is off the table THIS round, so it must answer.
            is_last_round = round_index == _MAX_TOOL_ROUNDS - 1
            payload = {
                "messages": messages,
                "temperature": 0,
                **({"model": self._model} if self._model else {}),
                "tools": tools,
                **({"toolChoice": "none"} if is_last_round else {}),
                # Root cause of the confirmed live JSON-malformation failures
                # (missing node-object closing brace; unescaped quote inside a
                # "text" string value): this call previously sent NO
                # responseSchema at all, unlike its analyze_section sibling --
                # an implementation gap, not a documented grammar-cost-cliff
                # omission like the three OTHER no-response_format call sites
                # in this file (see this module's header comment). Every real
                # SURVEY call on a tool-capable model (gemma4:e4b included)
                # takes THIS path, so it ran with zero grammar-level JSON
                # enforcement in production. Confirmed live and directly
                # against Ollama 0.30.10 that `tools` + `response_format`
                # coexist without error or rejection, that a genuine
                # tool-call round still returns tool_calls correctly (not
                # forced into the schema shape), and that a final-answer
                # round stays syntactically valid JSON once the schema is
                # present -- restoring the same real constraint
                # analyze_section already had all along. Passed IN by the
                # caller (rather than hardcoded to section_analysis_schema)
                # since the skeleton stage constrains the same loop to its
                # own, much lighter shape.
                "responseSchema": response_schema,
                "maxTokens": self._max_output_tokens,
                # See analyze_section's identical doc comment -- same
                # confirmed-live finding, same two SURVEY call sites.
                "think": False,
                **({"numCtx": self._num_ctx} if self._num_ctx else {}),
                **({"topK": self._top_k} if self._top_k else {}),
                **({"minP": self._min_p} if self._min_p else {}),
                **({"seed": self._seed} if self._seed is not None else {}),
            }
            response = self._post_chat(payload, user_id)
            response.raise_for_status()
            body = response.json()
            tool_calls = body.get("toolCalls")
            if tool_calls and not is_last_round:
                messages.append({"role": "assistant", "tool_calls": tool_calls})
                for call in tool_calls:
                    try:
                        args = json.loads(call["function"]["arguments"])
                    except (json.JSONDecodeError, TypeError, KeyError):
                        args = {}
                    args = args if isinstance(args, dict) else {}
                    name = call.get("function", {}).get("name")
                    tool_result = self._execute_agentic_tool_call(
                        name, args, retrieve_fn, list_documents_fn, read_document_fn, read_other_section_fn, citations
                    )
                    messages.append({"role": "tool", "tool_call_id": call["id"], "content": tool_result})
                continue
            content = _strip_json_fence(body.get("content", ""))
            if content:
                return content, body.get("finishReason") == "length", False
            # Contradicts toolChoice:'none' on the last round (or the model
            # returned neither tool_calls nor content on an earlier round) --
            # extremely unlikely per the API contract, but the CALLER falls
            # back to its own single non-agentic call over the same section
            # text rather than silently returning 0 nodes for this branch.
            logger.warning(
                "%s: round %d produced neither tool_calls nor content -- falling back to the non-agentic call",
                label, round_index,
            )
            return None, False, False
        # Exceeded _MAX_TOOL_ROUNDS without a final answer -- the caller
        # degrades to no nodes for this branch rather than looping forever;
        # the branch's existing coverage/completeness warnings surface the
        # gap. Not a length-cap truncation (no final answer was ever reached
        # to check finishReason on) -- reported as truncated=False, a
        # distinct failure mode from analyze_section's own truncation signal.
        return None, False, True

    @staticmethod
    def _execute_agentic_tool_call(
        name: str | None,
        args: dict,
        retrieve_fn: Callable[[str], tuple[str | None, list[dict]]],
        list_documents_fn: Callable[[], list[str]] | None,
        read_document_fn: Callable[[str], str | None] | None,
        read_other_section_fn: Callable[[str], str | None] | None,
        citations: list[dict],
    ) -> str:
        """Dispatches one tool call to the matching injected closure --
        factored out of the main loop so adding a tool (§15) means adding one
        branch here, not restructuring the loop itself. Tolerant of an
        unknown/unsupported tool name (a model can hallucinate one) --
        degrades to a plain string result rather than crashing the branch."""
        if name == "query_kb":
            query = args.get("query", "")
            if not query:
                return "(no query provided)"
            kb_context, hits = retrieve_fn(query)
            citations.extend(hits)
            return kb_context or "(no relevant context found)"
        if name == "list_kb_documents" and list_documents_fn is not None:
            documents = list_documents_fn()
            return ", ".join(documents) if documents else "(no documents in the knowledge base)"
        if name == "read_kb_document" and read_document_fn is not None:
            source_file = args.get("source_file", "")
            if not source_file:
                return "(no source_file provided)"
            content = read_document_fn(source_file)
            return content or f"(document {source_file!r} not found in the knowledge base)"
        if name == "read_other_section" and read_other_section_fn is not None:
            section_id = args.get("section_id", "")
            if not section_id:
                return "(no section_id provided)"
            content = read_other_section_fn(section_id)
            return content or f"(section {section_id!r} not found in the document outline)"
        return f"(unsupported tool: {name!r})"

