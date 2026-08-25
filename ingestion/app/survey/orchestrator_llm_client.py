# ingestion/app/survey/orchestrator_llm_client.py
from __future__ import annotations

import json
import logging
import re
import time
from typing import Callable

import httpx
from json_repair import repair_json

from app.otel import get_tracer
from app.prompts import load_prompt

from app.survey._response_schemas import (
    checklist_definitions_schema,
    checklist_extraction_schema,
    content_authoring_schema,
    distill_title_schema,
    duplicate_cluster_verdict_schema,
    duplicate_pair_verdict_schema,
    epic_feature_scores_schema,
    figure_table_mapping_schema,
    kb_relevance_schema,
    leftover_assignment_schema,
    parent_summary_schema,
    root_grouping_schema,
    scores_schema,
    section_analysis_schema,
    section_skeleton_schema,
    synthesis_schema,
    title_tags_schema,
)
from app.config import settings
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


class OrchestratorLlmClient:
    """First REAL (non-fake) implementation of SurveyRequirementClient. Calls
    the orchestrator's POST /llm/chat proxy (Part A of this phase) — NEVER
    calls Open WebUI/Ollama directly, per the 'backend proxy, redact-first'
    architecture boundary in docs/architecture.md's Locked Decisions.

    The system prompt instructs the model to return a strict JSON array of
    {text, tags} objects; a malformed response raises ValueError rather than
    silently returning an empty/wrong result, since a caller acting on
    invalid generated requirements is worse than a loud failure."""

    def __init__(
        self,
        base_url: str,
        bearer_token: str,
        model: str | None = None,
        num_ctx: int | None = None,
        top_k: int | None = None,
        min_p: float | None = None,
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
        self._cache = cache
        self._transport: httpx.BaseTransport | None = None  # test-only injection seam

    @property
    def model(self) -> str | None:
        """Public read-only accessor for the per-job model override -- exists
        purely so llm_leveling.py's narration (`_fire`/`getattr(client,
        'model', None)`) can surface which model is doing the work on the
        running page, without this class needing to know narration exists."""
        return self._model

    def _post_chat(self, payload: dict) -> httpx.Response:
        """POSTs to /llm/chat with a short, bounded retry for a transient
        backend error (429/5xx) only -- see _RETRYABLE_CHAT_STATUS_CODES'
        own module-level doc comment for why this exists and why it's safe
        (bounded, status-gated, layered above the existing per-chunk
        fail-open nets rather than replacing them). Every one of this
        class's /llm/chat call sites should route through this instead of
        constructing its own httpx.Client + raw post -- callers still call
        `.raise_for_status()` themselves afterward, unchanged."""
        response: httpx.Response | None = None
        for attempt in range(_MAX_CHAT_RETRY_ATTEMPTS):
            with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
                response = client.post(
                    f"{self._base_url}/llm/chat",
                    json=payload,
                    headers={"Authorization": f"Bearer {self._bearer_token}"},
                )
            if response.status_code not in _RETRYABLE_CHAT_STATUS_CODES:
                return response
            if attempt < _MAX_CHAT_RETRY_ATTEMPTS - 1:
                logger.warning(
                    "/llm/chat returned %d (attempt %d/%d) -- retrying after %.0fs",
                    response.status_code, attempt + 1, _MAX_CHAT_RETRY_ATTEMPTS,
                    _CHAT_RETRY_BACKOFF_SECONDS[attempt],
                )
                time.sleep(_CHAT_RETRY_BACKOFF_SECONDS[attempt])
        assert response is not None  # loop always runs >=1 iteration
        return response

    def generate_requirements(self, block_text: str) -> list[dict]:
        system_prompt = load_prompt("generate_requirements")
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": block_text},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            # No response_format here: a top-level array schema (even a
            # small-output one, since grammar cost is schema-declared, not
            # output-driven) hit Ollama's GBNF grammar-cost cliff live --
            # see _response_schemas.py's module docstring.
            "maxTokens": _MAX_OUTPUT_TOKENS,
        }
        response = self._post_chat(payload)
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        parsed = _parse_json_object(content)
        return parsed

    def infer_trace_links(
        self,
        nodes: list[dict],
        link_type_catalog: list[dict],
        kb_context: str | None = None,
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
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": nodes_json},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            # No response_format: same top-level-array grammar-cost cliff as
            # infer_hierarchy -- see _response_schemas.py's module docstring.
            # Defended by the existing reference_name-not-in-catalog filter
            # in llm_leveling.py instead.
            "maxTokens": _MAX_OUTPUT_TOKENS,
            # Confirmed missing here (unlike analyze_section/agentic, which
            # already forward this): without an explicit num_ctx, Ollama
            # silently truncates the prompt to its own small default
            # regardless of actual size (see LlmChatOptions.numCtx's own
            # doc comment) -- this call serializes EVERY node in the whole
            # tree (nodes_json above), the largest single payload in this
            # module, making it the most exposed call to that truncation.
            **({"numCtx": self._num_ctx} if self._num_ctx else {}),
            # Relationship inference over already-generated nodes is
            # structured extraction, not open-ended reasoning -- same
            # confirmed-live finding (3-10x wall-clock cost, no accuracy
            # benefit) as analyze_section/analyze_section_agentic and
            # score_requirements_for_document.
            "think": False,
        }
        response = self._post_chat(payload)
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        return _parse_json_object(content)

    def score_requirements_for_document(
        self,
        descriptions_by_node_id: dict[str, str],
        criteria_context: str | None = None,
        kb_context: str | None = None,
        category_checklist: list[str] | None = None,
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
                "score_requirements_for_document", self._model, self._num_ctx, self._top_k, self._min_p,
                descriptions_by_node_id, criteria_context, kb_context, category_checklist,
            )
            cached = self._cache.get(key)
            if cached is not None:
                logger.info("score_requirements_for_document: cache hit, skipping LLM call")
                return cached
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
            category_instruction=category_instruction,
            node_count=str(len(descriptions_by_node_id)),
        )
        if criteria_context:
            system_prompt += (
                "\n\nThe following reference criteria were retrieved as most relevant "
                f"to these requirements -- cite them in your judgment:\n{criteria_context}"
            )
        system_prompt = _with_kb_context_as_scoring_rubric(
            system_prompt, kb_context, categories_are_fixed=bool(category_checklist)
        )
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(descriptions_by_node_id)},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": scores_schema(),
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
            "maxTokens": _MAX_OUTPUT_TOKENS,
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
            span.set_attribute("req2ado.node_count", len(descriptions_by_node_id))
            response = self._post_chat(payload)
            elapsed_seconds = time.monotonic() - started_at
            logger.info(
                "score_requirements_for_document: %d node(s), %d request char(s), %.1fs wall time",
                len(descriptions_by_node_id), request_chars, elapsed_seconds,
            )
            response.raise_for_status()
            content = _strip_json_fence(response.json()["content"])
            result = _parse_json_object(content)
        if key is not None:
            self._cache.set(key, result)
        return result

    def extract_quality_checklist(self, document_text: str) -> list[str]:
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
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": document_text[:_CHECKLIST_EXTRACTION_MAX_CHARS]},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": checklist_extraction_schema(),
            "think": False,
            "maxTokens": 2000,
            **({"numCtx": self._num_ctx} if self._num_ctx else {}),
        }
        response = self._post_chat(payload)
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        parsed = _parse_json_object(content)
        if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
            raise ValueError(f"malformed JSON in LLM response content: {content!r}")
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
        self, document_text: str, category_names: list[str],
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
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": document_text[:_CHECKLIST_EXTRACTION_MAX_CHARS]},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": checklist_definitions_schema(),
            "think": False,
            "maxTokens": 2000,
            **({"numCtx": self._num_ctx} if self._num_ctx else {}),
        }
        response = self._post_chat(payload)
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        parsed = _parse_json_object(content)
        if not isinstance(parsed, dict):
            raise ValueError(f"malformed JSON in LLM response content: {content!r}")
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

    def score_epics_and_features_for_document(self, nodes_by_id: dict[str, dict]) -> dict[str, dict]:
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
                "score_epics_and_features_for_document", self._model, self._num_ctx, self._top_k, self._min_p,
                nodes_by_id,
            )
            cached = self._cache.get(key)
            if cached is not None:
                logger.info("score_epics_and_features_for_document: cache hit, skipping LLM call")
                return cached
        system_prompt = load_prompt("score_epics_and_features_for_document", node_count=str(len(nodes_by_id)))
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(nodes_by_id)},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": epic_feature_scores_schema(),
            "think": False,
            "maxTokens": _MAX_OUTPUT_TOKENS,
            **({"numCtx": self._num_ctx} if self._num_ctx else {}),
        }
        # Same perf-investigation instrumentation as
        # score_requirements_for_document -- see its own comment.
        request_chars = len(json.dumps(payload))
        started_at = time.monotonic()
        response = self._post_chat(payload)
        elapsed_seconds = time.monotonic() - started_at
        logger.info(
            "score_epics_and_features_for_document: %d node(s), %d request char(s), "
            "%.1fs wall time",
            len(nodes_by_id), request_chars, elapsed_seconds,
        )
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        result = _parse_json_object(content)
        if key is not None:
            self._cache.set(key, result)
        return result

    def title_and_tags_for_rows(self, texts_by_row_id: dict[str, str]) -> dict[str, dict]:
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
        system_prompt = load_prompt(
            "title_and_tags_for_rows",
            tag_vocabulary=", ".join(t.value for t in RequirementTag),
            row_count=str(len(texts_by_row_id)),
        )
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(texts_by_row_id)},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": title_tags_schema(),
            "think": False,
            "maxTokens": _MAX_OUTPUT_TOKENS,
            **({"numCtx": self._num_ctx} if self._num_ctx else {}),
        }
        response = self._post_chat(payload)
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        return _parse_json_object(content)

    def summarize_parent_nodes(self, nodes_by_id: dict[str, dict]) -> dict[str, dict]:
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
        system_prompt = load_prompt("summarize_parent_nodes", node_count=str(len(nodes_by_id)))
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(nodes_by_id)},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": parent_summary_schema(),
            "think": False,
            "maxTokens": _MAX_OUTPUT_TOKENS,
            **({"numCtx": self._num_ctx} if self._num_ctx else {}),
        }
        response = self._post_chat(payload)
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        return _parse_json_object(content)

    def synthesize_leaf_requirements(self, items_by_id: dict[str, dict]) -> dict[str, dict]:
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
        system_prompt = load_prompt(
            "synthesize_leaf_requirements",
            tag_vocabulary=", ".join(t.value for t in RequirementTag),
            row_count=str(len(items_by_id)),
        )
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(items_by_id)},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": synthesis_schema(),
            "think": False,
            "maxTokens": _MAX_OUTPUT_TOKENS,
            **({"numCtx": self._num_ctx} if self._num_ctx else {}),
        }
        response = self._post_chat(payload)
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        return _parse_json_object(content)

    def distill_title(self, text: str, max_length: int) -> str:
        """Backs the TitleDistillationClient protocol
        (distillation/survey_title.py) -- 300553's smart-title fallback.
        `max_length` is included in the prompt as a hint, but never trusted
        to be honored: distill_survey_title (the caller) re-truncates the
        result via extract_baseline_title regardless, same "never trust an
        external response to self-enforce a hard limit" rule that function's
        own docstring documents."""
        system_prompt = load_prompt("distill_survey_title")
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps({"text": text, "maxLength": max_length})},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": distill_title_schema(),
            "think": False,
            "maxTokens": _MAX_OUTPUT_TOKENS,
            **({"numCtx": self._num_ctx} if self._num_ctx else {}),
        }
        response = self._post_chat(payload)
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        return _parse_json_object(content)["title"]

    def judge_duplicate_pair(self, candidate_text: str, matched_text: str) -> dict:
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
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps({"candidate": candidate_text, "existing": matched_text})},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": duplicate_pair_verdict_schema(),
            "think": False,
            "maxTokens": _MAX_OUTPUT_TOKENS,
            **({"numCtx": self._num_ctx} if self._num_ctx else {}),
        }
        response = self._post_chat(payload)
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        return _parse_json_object(content)

    def judge_duplicate_cluster(self, texts_by_id: dict[str, str]) -> dict:
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
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(texts_by_id)},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": duplicate_cluster_verdict_schema(),
            "think": False,
            "maxTokens": _MAX_OUTPUT_TOKENS,
            **({"numCtx": self._num_ctx} if self._num_ctx else {}),
        }
        response = self._post_chat(payload)
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        return _parse_json_object(content)

    def group_root_topics(self, titles_by_id: dict[str, str]) -> dict:
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
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(titles_by_id)},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": root_grouping_schema(),
            "think": False,
            "maxTokens": _MAX_OUTPUT_TOKENS,
            **({"numCtx": self._num_ctx} if self._num_ctx else {}),
        }
        response = self._post_chat(payload)
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        return _parse_json_object(content)

    def assign_leftover_roots(self, leftover_titles_by_id: dict[str, str], group_titles_by_id: dict[str, str]) -> dict:
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
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps({"leftovers": leftover_titles_by_id, "groups": group_titles_by_id})},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": leftover_assignment_schema(),
            "think": False,
            "maxTokens": _MAX_OUTPUT_TOKENS,
            **({"numCtx": self._num_ctx} if self._num_ctx else {}),
        }
        response = self._post_chat(payload)
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        return _parse_json_object(content)

    def show_model(self, model: str) -> dict:
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
        with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/show",
                json={"model": model},
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
        response.raise_for_status()
        body = response.json()
        return {"context_length": body.get("contextLength"), "capabilities": body.get("capabilities") or []}

    def judge_kb_relevance(self, branch_content: str, snippets: list[dict]) -> dict[str, str]:
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
        system_prompt = load_prompt("judge_kb_relevance")
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": json.dumps({"section_content": branch_content, "snippets": snippets_by_index}),
                },
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": kb_relevance_schema(),
            # Confirmed missing here: this was the ONE call in this module
            # with no output cap at all -- the exact unbounded-hidden-
            # reasoning exposure _MAX_OUTPUT_TOKENS's own doc comment
            # documents (a reasoning model observed generating 40+ minute
            # single calls with no cap in place). Output here is a tiny
            # index->enum map, so this is pure downside-bounding, not a
            # real content constraint.
            "maxTokens": _MAX_OUTPUT_TOKENS,
            **({"numCtx": self._num_ctx} if self._num_ctx else {}),
            # Binary relevant/not_relevant judgment per snippet -- structured
            # classification, not open-ended reasoning. Same confirmed-live
            # finding as every other non-conversational call in this module.
            "think": False,
        }
        response = self._post_chat(payload)
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        return _parse_json_object(content)

    def analyze_section(
        self,
        section_text: str,
        kb_context: str | None = None,
        whole_document: bool = False,
        topic_count: int | None = None,
        table_group_hints: list[tuple[str, str]] | None = None,
        expected_root_count: int | None = None,
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
                "analyze_section", self._model, self._num_ctx, self._top_k, self._min_p,
                section_text, kb_context, whole_document, topic_count, table_group_hints, expected_root_count,
            )
            cached = self._cache.get(key)
            if cached is not None:
                logger.info("analyze_section: cache hit, skipping LLM call")
                return cached["nodes"], cached["truncated"]
        system_prompt = _with_kb_context(
            _section_analysis_system_prompt(expected_root_count), kb_context
        )
        if whole_document:
            system_prompt += _whole_document_hint(topic_count)
        elif topic_count is not None:
            system_prompt += _branch_topic_hint(topic_count)
        system_prompt += _table_group_hint(table_group_hints)
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": section_text},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": section_analysis_schema(),
            "maxTokens": _MAX_OUTPUT_TOKENS,
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
            response = self._post_chat(payload)
            response.raise_for_status()
            body = response.json()
            content = _strip_json_fence(body["content"])
            nodes = _nodes_from_parsed(_parse_json_object(content))
            span.set_attribute("gen_ai.response.node_count", len(nodes))
        truncated = body.get("finishReason") == "length"
        logger.warning(
            "analyze_section result: node_count=%d finishReason=%r truncated=%s topic_count=%r",
            len(nodes), body.get("finishReason"), truncated, topic_count,
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
        whole_document: bool = False,
        topic_count: int | None = None,
        table_group_hints: list[tuple[str, str]] | None = None,
        expected_root_count: int | None = None,
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
        system_prompt = _section_analysis_system_prompt(expected_root_count) + tool_hint
        if whole_document:
            system_prompt += _whole_document_hint(topic_count)
        elif topic_count is not None:
            system_prompt += _branch_topic_hint(topic_count)
        system_prompt += _table_group_hint(table_group_hints)
        citations: list[dict] = []
        content, truncated, rounds_exhausted = self._run_agentic_rounds(
            system_prompt, section_text, section_analysis_schema(), tools,
            retrieve_fn, list_documents_fn, read_document_fn, read_other_section_fn,
            citations, "analyze_section_agentic",
        )
        if content:
            nodes = _nodes_from_parsed(_parse_json_object(content))
            logger.warning(
                "analyze_section_agentic result: node_count=%d truncated=%s query_kb_calls=%d topic_count=%r",
                len(nodes), truncated, len(citations), topic_count,
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
        fallback_nodes, fallback_truncated = self.analyze_section(
            section_text, kb_context=None, whole_document=whole_document, topic_count=topic_count
        )
        return fallback_nodes, citations, fallback_truncated

    def analyze_section_skeleton(
        self,
        section_text: str,
        kb_context: str | None = None,
        whole_document: bool = False,
        topic_count: int | None = None,
        table_group_hints: list[tuple[str, str]] | None = None,
        expected_root_count: int | None = None,
    ) -> tuple[list[dict], bool]:
        """STAGE 1 of the two-stage SURVEY generation split: the STRUCTURE
        half of what analyze_section used to decide in one call. Given the
        same single coherent rendering of a whole section, returns the
        complete node SKELETON -- [{temp_id, type, parent_temp_id, title}]
        -- with no requirement text, no tags, and no figure/table ids at
        all (see section_skeleton_schema and the section_skeleton prompt).
        The content half is authored separately, against this
        already-decided skeleton, by author_content; figure/table
        attachment is a separate whole-document mapping pass between the
        two.

        Every steering parameter analyze_section takes is kept and means
        exactly the same thing here, because every one of them steers a
        STRUCTURAL decision: `whole_document`/`topic_count` are node-COUNT
        floors, `table_group_hints` names which groups must each become
        their own node AND with which type, `expected_root_count` is the
        multi-root permission. `kb_context` (the non-tool-capable path's
        pre-computed once-per-document string) is threaded in with the same
        soft framing analyze_section uses -- domain material can genuinely
        inform where a node boundary belongs, not just how a requirement is
        worded.

        This is the FALLBACK path for models without tool-calling support;
        tool-capable models use analyze_section_skeleton_agentic instead.
        Returns (nodes, truncated) -- same contract as analyze_section's own
        return, see its docstring for what `truncated` means and why the
        caller surfaces it rather than swallowing it."""
        key = None
        if self._cache is not None:
            key = cache_key(
                "analyze_section_skeleton", self._model, self._num_ctx, self._top_k, self._min_p,
                section_text, kb_context, whole_document, topic_count, table_group_hints, expected_root_count,
            )
            cached = self._cache.get(key)
            if cached is not None:
                logger.info("analyze_section_skeleton: cache hit, skipping LLM call")
                return cached["nodes"], cached["truncated"]
        system_prompt = _with_kb_context(
            _section_skeleton_system_prompt(expected_root_count), kb_context
        )
        if whole_document:
            system_prompt += _whole_document_hint(topic_count)
        elif topic_count is not None:
            system_prompt += _branch_topic_hint(topic_count)
        system_prompt += _table_group_hint(table_group_hints)
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": section_text},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": section_skeleton_schema(),
            "maxTokens": _MAX_OUTPUT_TOKENS,
            # Same confirmed-live finding as analyze_section's identical doc
            # comment -- this call inherits that finding directly, being the
            # same holistic-JSON-extraction work minus the content half.
            "think": False,
            **({"numCtx": self._num_ctx} if self._num_ctx else {}),
            **({"topK": self._top_k} if self._top_k else {}),
            **({"minP": self._min_p} if self._min_p else {}),
        }
        with _tracer.start_as_current_span("analyze_section_skeleton") as span:
            span.set_attribute("gen_ai.request.model", self._model or "default")
            span.set_attribute("gen_ai.operation.name", "chat")
            response = self._post_chat(payload)
            response.raise_for_status()
            body = response.json()
            content = _strip_json_fence(body["content"])
            nodes = _nodes_from_parsed(_parse_json_object(content))
            span.set_attribute("gen_ai.response.node_count", len(nodes))
        truncated = body.get("finishReason") == "length"
        logger.warning(
            "analyze_section_skeleton result: node_count=%d finishReason=%r truncated=%s topic_count=%r",
            len(nodes), body.get("finishReason"), truncated, topic_count,
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
        whole_document: bool = False,
        topic_count: int | None = None,
        table_group_hints: list[tuple[str, str]] | None = None,
        expected_root_count: int | None = None,
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
        system_prompt = _section_skeleton_system_prompt(expected_root_count) + tool_hint
        if whole_document:
            system_prompt += _whole_document_hint(topic_count)
        elif topic_count is not None:
            system_prompt += _branch_topic_hint(topic_count)
        system_prompt += _table_group_hint(table_group_hints)
        citations: list[dict] = []
        content, truncated, rounds_exhausted = self._run_agentic_rounds(
            system_prompt, section_text, section_skeleton_schema(), tools,
            retrieve_fn, list_documents_fn, read_document_fn, read_other_section_fn,
            citations, "analyze_section_skeleton_agentic",
        )
        if content:
            nodes = _nodes_from_parsed(_parse_json_object(content))
            logger.warning(
                "analyze_section_skeleton_agentic result: node_count=%d truncated=%s query_kb_calls=%d topic_count=%r",
                len(nodes), truncated, len(citations), topic_count,
            )
            return nodes, citations, truncated
        if rounds_exhausted:
            logger.warning(
                "analyze_section_skeleton_agentic: exceeded _MAX_TOOL_ROUNDS=%d without a final answer -- 0 nodes",
                _MAX_TOOL_ROUNDS,
            )
            return [], citations, False
        fallback_nodes, fallback_truncated = self.analyze_section_skeleton(
            section_text, kb_context=None, whole_document=whole_document, topic_count=topic_count,
            table_group_hints=table_group_hints, expected_root_count=expected_root_count,
        )
        return fallback_nodes, citations, fallback_truncated

    def author_content(
        self,
        section_text: str,
        skeleton_nodes: dict[str, dict],
        kb_context: str | None = None,
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
                "author_content", self._model, self._num_ctx, self._top_k, self._min_p,
                section_text, skeleton_nodes, kb_context,
            )
            cached = self._cache.get(key)
            if cached is not None:
                logger.info("author_content: cache hit, skipping LLM call")
                return cached["content"], cached["truncated"]
        system_prompt = _with_kb_context(
            load_prompt(
                "author_content",
                tag_vocabulary=", ".join(t.value for t in RequirementTag),
                node_count=str(len(skeleton_nodes)),
            ),
            kb_context,
        )
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": json.dumps({"section": section_text, "nodes": skeleton_nodes}),
                },
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": content_authoring_schema(),
            "maxTokens": _MAX_OUTPUT_TOKENS,
            # Same confirmed-live finding as the two section-analysis paths
            # this call was split out of -- structured extraction over text
            # already in the prompt, not open-ended reasoning.
            "think": False,
            **({"numCtx": self._num_ctx} if self._num_ctx else {}),
            **({"topK": self._top_k} if self._top_k else {}),
            **({"minP": self._min_p} if self._min_p else {}),
        }
        with _tracer.start_as_current_span("author_content") as span:
            span.set_attribute("gen_ai.request.model", self._model or "default")
            span.set_attribute("gen_ai.operation.name", "chat")
            response = self._post_chat(payload)
            response.raise_for_status()
            body = response.json()
            content = _strip_json_fence(body["content"])
            parsed = _parse_json_object(content)
            result = parsed if isinstance(parsed, dict) else {}
            span.set_attribute("gen_ai.response.node_count", len(result))
        truncated = body.get("finishReason") == "length"
        logger.warning(
            "author_content result: requested=%d returned=%d finishReason=%r truncated=%s",
            len(skeleton_nodes), len(result), body.get("finishReason"), truncated,
        )
        # Never cache a truncated result -- same reasoning as analyze_section's
        # own identical guard.
        if key is not None and not truncated:
            self._cache.set(key, {"content": result, "truncated": truncated})
        return result, truncated

    def map_figures_tables(self, candidates: dict[str, dict], items: dict[str, dict]) -> dict[str, dict]:
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
                "map_figures_tables", self._model, self._num_ctx, self._top_k, self._min_p,
                candidates, items,
            )
            cached = self._cache.get(key)
            if cached is not None:
                logger.info("map_figures_tables: cache hit, skipping LLM call")
                return cached
        system_prompt = load_prompt("map_figures_tables", item_count=str(len(items)))
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": json.dumps({"candidates": candidates, "items": items}),
                },
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": figure_table_mapping_schema(),
            "maxTokens": _MAX_OUTPUT_TOKENS,
            # Same confirmed-live finding as every other structured-extraction
            # call in this class -- classification over material already in
            # the prompt, not open-ended reasoning.
            "think": False,
            **({"numCtx": self._num_ctx} if self._num_ctx else {}),
            **({"topK": self._top_k} if self._top_k else {}),
            **({"minP": self._min_p} if self._min_p else {}),
        }
        with _tracer.start_as_current_span("map_figures_tables") as span:
            span.set_attribute("gen_ai.request.model", self._model or "default")
            span.set_attribute("gen_ai.operation.name", "chat")
            span.set_attribute("gen_ai.request.item_count", len(items))
            response = self._post_chat(payload)
            response.raise_for_status()
            body = response.json()
            content = _strip_json_fence(body["content"])
            parsed = _parse_json_object(content)
            result = parsed if isinstance(parsed, dict) else {}
            span.set_attribute("gen_ai.response.item_count", len(result))
        # An item this response never answered for costs that item its home
        # (in the escalation tier there is no further tier to fall through
        # to), so an incomplete answer must never be reused: cached, it would
        # reproduce the SAME silent loss on every re-run of this document
        # instead of getting a real answer on retry. Both causes are treated
        # identically -- the model's own output cap (finishReason, the same
        # signal analyze_section/author_content guard their caches with) and
        # a response that simply came back short of what was asked.
        incomplete = body.get("finishReason") == "length" or len(result) < len(items)
        logger.warning(
            "map_figures_tables result: candidates=%d requested=%d returned=%d "
            "finishReason=%r incomplete=%s",
            len(candidates), len(items), len(result), body.get("finishReason"), incomplete,
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
                "maxTokens": _MAX_OUTPUT_TOKENS,
                # See analyze_section's identical doc comment -- same
                # confirmed-live finding, same two SURVEY call sites.
                "think": False,
                **({"numCtx": self._num_ctx} if self._num_ctx else {}),
                **({"topK": self._top_k} if self._top_k else {}),
                **({"minP": self._min_p} if self._min_p else {}),
            }
            response = self._post_chat(payload)
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

