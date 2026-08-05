# ingestion/app/survey/orchestrator_llm_client.py
from __future__ import annotations

import json
import logging
import re
import time
from typing import Callable

import httpx
from json_repair import repair_json

from app.survey._response_schemas import (
    checklist_extraction_schema,
    duplicate_cluster_verdict_schema,
    duplicate_pair_verdict_schema,
    epic_feature_scores_schema,
    kb_relevance_schema,
    parent_summary_schema,
    root_grouping_schema,
    scores_schema,
    section_analysis_schema,
    synthesis_schema,
    title_tags_schema,
)
from app.workitem.model import RequirementTag

logger = logging.getLogger(__name__)

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
_LLM_REQUEST_TIMEOUT_SECONDS = 1800.0

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
_CHECKLIST_MAX_ITEM_CHARS = 60


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
# (llm_leveling._build_survey_tree_for_branch) supplies the corresponding
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

_SECTION_ANALYSIS_SYSTEM_PROMPT = (
    "You are analyzing one section of a customer requirements document. First "
    "understand the section as a whole -- its headings, prose, bullet/spec lists, "
    "tables, and figure descriptions together form coherent requirements, NOT one "
    "requirement per line. Synthesize them. Return a work-item tree for THIS "
    "section as a JSON object {\"nodes\": [...]}. Each node has: 'temp_id' (a "
    "unique short id you assign, e.g. 'n1'), 'type' (one of: Epic, Feature, "
    "Requirement), 'parent_temp_id' (the temp_id of its parent in this same "
    "array, or null for a section root), 'title' (a short, human-scannable "
    "label for this node, roughly 80 characters or less -- NOT a repeat of "
    "the full formal statement in 'text', a distinct at-a-glance summary of "
    "it), 'text' (a single formal shall-style requirement statement that "
    "folds in every related value/bullet/cell -- do NOT emit one node per "
    "bullet), and 'tags' (zero or more of: functional, "
    "non_functional, interface, performance, regulatory, safety, security, "
    "operation, maintenance, feature, behavior). Emit as many or as few nodes as "
    "the section genuinely contains. No prose, no markdown fences -- the body "
    "must be valid JSON on its own.\n\n"
    "Every figure in this section (each rendered as '[FIGURE: <description>]') "
    "that describes real technical content (dimensions, pin-outs, connections, "
    "architecture, values) must have that content reflected in at least one "
    "node's 'text' -- do not silently omit a figure's technical content just "
    "because it wasn't already phrased as a requirement.\n\n"
    "IMPORTANT on parent_temp_id: null means 'this node has no parent at all "
    "-- it is a root of the tree', NOT a placeholder or default. "
    "__ROOT_COUNT_CLAUSE__ EVERY other "
    "node -- including the LAST ones you emit, however many nodes there are -- "
    "must set parent_temp_id to an already-emitted temp_id from earlier in "
    "this same array. Do not let parent_temp_id drift to null for later nodes "
    "just because the response is long -- re-check this field for every "
    "single node before finishing.\n\n"
    "What each type actually MEANS (not just how they nest) -- use this to "
    "judge scope, not only the structural rules below: an Epic is a large "
    "body of work representing a major initiative or goal, broken down into "
    "multiple Features, that might span several sprints or even releases. A "
    "Feature is a significant piece of functionality that delivers real "
    "value to the user on its own, typically covering several distinct "
    "Requirements, and might take one or more sprints to complete. A "
    "Requirement is a single, sprint-sized, individually testable "
    "obligation. When the section's own structure doesn't make the right "
    "boundary obvious, fall back to this scope test: could this genuinely "
    "take multiple sprints and cover several distinct Features on its own? "
    "-> Epic. Does it deliver one coherent piece of user-facing value made "
    "of several testable Requirements? -> Feature. Is it one testable "
    "obligation? -> Requirement.\n\n"
    "IMPORTANT on the type hierarchy: Epic groups Features (and MAY group "
    "other Epics, see below), Feature groups Requirements. A Requirement's "
    "parent must ALWAYS be a Feature or another Requirement (a child "
    "Requirement, see below) -- never an Epic directly, and never null "
    "unless this Requirement is genuinely the section's only node. An "
    "Epic's children must ALWAYS be Features or other Epics -- never a "
    "Requirement directly. If a section's content only warrants one level "
    "below its root (e.g. a root Feature with only atomic requirements "
    "under it, no separate Epic), that is fine -- the point is never to "
    "skip a level in the chain that IS present: once you emit an Epic, "
    "every Requirement under it must go through an intermediate Feature, "
    "even a single one grouping all of that Epic's Requirements.\n\n"
    "The hierarchy is not always exactly 3 levels deep -- use these three "
    "additional structural tools whenever the section's content genuinely "
    "calls for them, not by default:\n"
    "- Nested Epic: when a section spans multiple large, clearly distinct "
    "functional domains, emit an intermediate Epic per domain under the "
    "section's own root Epic, rather than putting every Feature directly "
    "under one flat root (e.g. a 'Television Receiver' root Epic split "
    "into 'Broadcast Reception', 'System Settings', 'System Information' "
    "child Epics, each then grouping its own Features). An Epic grouping "
    "other Epics is NOT capped at one level -- if one of those child Epics "
    "is ITSELF large enough to represent multiple distinct sub-initiatives "
    "(by the same scope test above, applied again one level down), split it "
    "into its own further child Epics before reaching Features. How many "
    "levels of Epic-under-Epic are warranted depends entirely on the "
    "section's actual scope, not a fixed depth -- most sections need zero "
    "or one level of Epic nesting, but do not artificially flatten a "
    "genuinely multi-tier domain just to stop at one level.\n"
    "- Nested Feature: when a sub-topic under a Feature is itself a "
    "coherent capability with several Requirements of its own, emit it as "
    "a Feature nested under that Feature, not flattened into a sibling "
    "Requirement list (e.g. 'Picture Modes' as a Feature nested under a "
    "'Display' Feature, itself grouping 'Movie Mode'/'Game Mode' "
    "Requirements, instead of six flat Requirements directly under "
    "'Display').\n"
    "- Child Requirement: when a Requirement's exceptions, conditions, "
    "alternative flows, or specific follow-up behavior are themselves "
    "separately testable, emit them as Requirements parented under that "
    "general Requirement, not as siblings under the same Feature (e.g. a "
    "general 'Automatic Switching to an Active Source' Requirement with "
    "child Requirements 'Multiple Active Sources' and 'User Dismisses the "
    "Suggestion' for its two specific sub-cases).\n"
    "Do not force any of these three when the section's content is "
    "genuinely flat -- a Feature with only atomic, unrelated Requirements "
    "and no real sub-capability or exception case should stay exactly that "
    "flat, not be padded with an invented nested level.\n\n"
    "Confirmed real gap: when the source content itself already provides an "
    "intermediate group label -- a numbered sub-heading, or a table row that "
    "is purely a group title with no 'shall' statement of its own -- and "
    "that group has TWO OR MORE child items under it, that group's own "
    "label is a strong, deliberate signal from the source document's own "
    "author about where a node boundary belongs. Use that label as a node "
    "(a nested Feature for a sub-capability grouping several distinct "
    "Requirements, or a parent Requirement for a general statement grouping "
    "its own exception/condition sub-cases) instead of skipping past it "
    "straight to a broader ancestor and flattening its children in as that "
    "ancestor's own direct children. A source group label with only ONE "
    "child, or no child items of its own (pure prose), does not need this -- "
    "only groups with two or more children are the real signal."
)

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
        self._transport: httpx.BaseTransport | None = None  # test-only injection seam

    @property
    def model(self) -> str | None:
        """Public read-only accessor for the per-job model override -- exists
        purely so llm_leveling.py's narration (`_fire`/`getattr(client,
        'model', None)`) can surface which model is doing the work on the
        running page, without this class needing to know narration exists."""
        return self._model

    def generate_requirements(self, block_text: str) -> list[dict]:
        system_prompt = (
            "You convert informal requirement text into formal 'shall' statements. "
            "Return ONLY a JSON array of objects, each with 'text' (a single formal "
            "shall-style requirement sentence) and 'tags' (a list of zero or more of: "
            "functional, non_functional, interface, performance, regulatory, safety, "
            "security, operation, maintenance, feature, behavior). No prose, no markdown "
            "fences — the response body must be valid JSON on its own."
        )
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
        with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
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
        catalog_lines = "\n".join(
            f"- {entry['reference_name']} (\"{entry['name']}\")"
            + (f": {entry['semantic_hint']}" if entry.get("semantic_hint") else "")
            for entry in link_type_catalog
        )
        nodes_json = json.dumps(nodes)
        system_prompt = (
            "You infer trace/coverage links between work items in a requirements tree — "
            "the most common case is a System Requirement covering/tracing a Customer "
            "Requirement, but use your judgment on the actual relationship implied by the "
            "text. You are given a JSON array of nodes, each with 'node_id', 'type', "
            "and 'text'. You may propose zero or more links. For each link, "
            "choose EXACTLY ONE reference_name from this list — never invent one, and "
            "omit the link entirely if none genuinely fits:\n\n"
            f"{catalog_lines}\n\n"
            "Return ONLY a JSON array of objects, each with 'source_node_id' (the node_id "
            "the link is on), 'target_ref' (the node_id of the OTHER node in this array, "
            "if the target is one of them), and 'reference_name' (one of the reference "
            "names listed above). If the covered/traced item is NOT one of the nodes "
            "supplied above but the text cites an external requirement identifier (e.g. a "
            "customer requirement ID like 'REQ-SYS-012'), use that cited identifier as "
            "target_ref instead. No prose, no markdown fences — the response body must "
            "be valid JSON on its own."
        )
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
        with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
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
        system_prompt = (
            "You judge the quality of candidate requirement items extracted from a "
            "specification document. Some candidates are already formal 'shall'-"
            "style requirement statements; others are NOT requirements at all -- "
            "bare labels, table cells, headings, rationale/justification text, or "
            "open questions/TBD items left in the source. Judge whether each "
            "candidate IS a real requirement FIRST (see completeness_as_requirement "
            "below), then judge its quality against EARS, INCOSE, and ISO/IEC/IEEE "
            "29148 criteria (unambiguous, testable, atomic/not compound, has clear "
            "acceptance criteria, no vague terms like 'user-friendly' or 'fast', "
            "active voice, states its rationale when non-obvious). You are given a "
            "JSON object mapping each candidate's node_id to its final text. Return "
            "ONLY a JSON object with the SAME node_id keys, each mapped to an "
            "object with 'score' (an integer 0-100, where 100 is a fully compliant "
            "requirement -- a non-requirement fragment should score low here too), "
            "'issues' (a list of zero or more of: ambiguous, not_testable, "
            "compound, missing_acceptance_criteria, vague_term, passive_voice, "
            "missing_rationale, not_a_requirement, fragment, placeholder, "
            "open_item_tbd, rationale_as_requirement, conflicting_value), and " +
            category_instruction +
            "Never invent a node_id not present in the input. "
            # Concrete, countable completeness instruction -- same
            # confirmed-live pattern as _whole_document_hint/
            # _branch_topic_hint ("a concrete, countable floor beats a
            # qualitative reminder"). Addresses a real, already-observed
            # failure mode (llm_leveling.py's "Quality scoring returned no
            # valid score for N node(s)" warning): nothing previously told
            # the model it must cover EVERY input key, only that it must
            # not invent new ones.
            f"The input contains exactly {len(descriptions_by_node_id)} node_id(s). "
            f"Return exactly {len(descriptions_by_node_id)} entries in your response "
            "-- one for EVERY node_id in the input, none omitted, none invented. "
            "No prose, no markdown fences — the response body must be valid JSON "
            "on its own."
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
        with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
        elapsed_seconds = time.monotonic() - started_at
        logger.info(
            "score_requirements_for_document: %d node(s), %d request char(s), %.1fs wall time",
            len(descriptions_by_node_id), request_chars, elapsed_seconds,
        )
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        return _parse_json_object(content)

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
        system_prompt = (
            "You are given the full text of one document ingested into a company's "
            "requirements-engineering Knowledge Base. Determine whether this "
            "document defines a QUALITY CHECKLIST for evaluating individual "
            "requirements -- a named list of criteria, questions, or attributes "
            "used to judge whether a requirement is well-written (e.g. a table of "
            "'Question'/'Pass condition' rows, or a list like 'Necessary, "
            "Unambiguous, Verifiable, ...'). If it does, return a JSON array of "
            "the checklist's own category/question names, exactly as they appear "
            "in the document (short, 1-4 words each), in the SAME order the "
            "document presents them. If this document does NOT define such a "
            "checklist (e.g. it's general reference material, a template, or "
            "unrelated content), return an empty array []. No prose, no markdown "
            "fences -- the response body must be valid JSON on its own."
        )
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
        with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
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
        system_prompt = (
            "You judge the quality of Epic and Feature work items in a CMMI-style "
            "requirements hierarchy (Epic groups Features, Feature groups "
            "Requirements -- see the CMMI guidance on what makes each level "
            "well-scoped). You are given a JSON object mapping each node's "
            "node_id to an object with 'type' ('Epic' or 'Feature') and 'text' "
            "(its description). Return ONLY a JSON object with the SAME "
            "node_id keys, each mapped to an object with 'score' (an integer "
            "0-100, where 100 is fully compliant) and 'categoryScores', judged "
            "against the criteria for THAT node's own type:\n"
            "For an EPIC, judge:\n"
            "  - scopeCoherence: could multiple independently valuable "
            "Features genuinely be delivered under this outcome -- not one "
            "narrow task, and not several unrelated outcomes bundled "
            "together?\n"
            "  - outcomeClarity: does it state a clear business/system "
            "outcome and why it matters, staying at that level rather than "
            "describing implementation detail?\n"
            "For a FEATURE, judge:\n"
            "  - capabilityClarity: does it describe ONE coherent, "
            "demonstrable capability -- not several unrelated capabilities "
            "bundled together, and not a single atomic requirement dressed "
            "up as a Feature?\n"
            "  - decomposability: can it genuinely be decomposed into "
            "several distinct, testable Requirements?\n"
            "Each category is an independent integer 0-100 judgment (100 = "
            "fully compliant on that dimension alone). Never invent a "
            "node_id not present in the input. "
            f"The input contains exactly {len(nodes_by_id)} node_id(s). Return "
            f"exactly {len(nodes_by_id)} entries in your response -- one for "
            "EVERY node_id in the input, none omitted, none invented. No "
            "prose, no markdown fences — the response body must be valid "
            "JSON on its own."
        )
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
        with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
        elapsed_seconds = time.monotonic() - started_at
        logger.info(
            "score_epics_and_features_for_document: %d node(s), %d request char(s), "
            "%.1fs wall time",
            len(nodes_by_id), request_chars, elapsed_seconds,
        )
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        return _parse_json_object(content)

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
        system_prompt = (
            "You are given a JSON object mapping row ids to short text extracted "
            "verbatim from a specification document (a heading, a table-cell "
            "value, or a short requirement statement -- some rows may be sentence "
            "fragments, not full requirements). For EACH row, return a SHORT, "
            "scannable title (a few words, not the full text -- omit only if the "
            "text is already short and clear, in which case return it unchanged) "
            "and zero or more tags from the closed set: "
            f"{', '.join(t.value for t in RequirementTag)}. Return ONLY a JSON "
            "object with the SAME row id keys, each mapped to an object with "
            "'title' (string) and 'tags' (array of zero or more of the tags "
            "above). Never invent a row id not present in the input. "
            f"The input contains exactly {len(texts_by_row_id)} row(s). Return "
            f"exactly {len(texts_by_row_id)} entries in your response -- one for "
            "EVERY row id in the input, none omitted, none invented. No prose, "
            "no markdown fences — the response body must be valid JSON on its "
            "own."
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
        with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
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
        system_prompt = (
            "You are given a JSON object mapping node ids to an Epic or "
            "Feature work item (Azure DevOps definitions): an Epic is a "
            "large, portfolio-level strategic goal that breaks down into "
            "multiple Features -- it answers 'what is the big strategic "
            "direction', not individual task execution. A Feature is a "
            "significant piece of functionality delivering direct value to "
            "the user, broken down further into Requirements/stories. Each "
            "entry gives the node's current title (often just the source "
            "document's own section heading, not a real strategic/capability "
            "statement) plus EVERY requirement statement nested underneath "
            "it, however deep (requirement_titles/requirement_descriptions) "
            "-- treat these as this node's real scope, not just its "
            "immediate children. For EACH node, return a SHORT title "
            "reframed to match its real role (Epic = strategic goal, "
            "Feature = capability delivering user value) -- not a copy of "
            "the input title unless it already reads that way -- and a "
            "description: 1-2 sentences summarizing what those requirements "
            "collectively deliver. The description MUST be worded "
            "differently from the title, never identical or a "
            "trivial restatement. Return ONLY a JSON object with the SAME "
            "node id keys, each mapped to an object with 'title' (string) "
            "and 'description' (string). Never invent a node id not present "
            "in the input. "
            f"The input contains exactly {len(nodes_by_id)} node(s). Return "
            f"exactly {len(nodes_by_id)} entries in your response -- one for "
            "EVERY node id in the input, none omitted, none invented. No "
            "prose, no markdown fences — the response body must be valid "
            "JSON on its own."
        )
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
        with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
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
        system_prompt = (
            "You are given a JSON object mapping row ids to source material "
            "extracted from a specification document. Each row has 'text' (the "
            "verbatim source text -- often a short table-cell value, a bare "
            "label, or a sentence fragment, NOT yet a complete requirement "
            "statement) and 'context' (that row's parent section titles, most "
            "general first, e.g. 'Power Supply > Electrical Characteristics' -- "
            "use this ONLY to understand what the row is about, never invent "
            "facts beyond what 'text' actually states). For EACH row, "
            "synthesize a complete, well-formed 'shall'-style requirement "
            "statement that expresses EXACTLY the same fact as 'text' (using "
            "'context' to supply the missing subject when 'text' alone doesn't "
            "name one -- e.g. text 'Size: 3U 1\"' under context 'Power Supply' "
            "becomes 'The power supply shall have a 3U, 1-inch form factor.') "
            "-- never add a value, threshold, or condition that isn't already "
            "present in 'text' itself. Return ONLY a JSON object with the SAME "
            "row id keys, each mapped to an object with 'title' (a short, "
            "scannable title), 'text' (the synthesized requirement statement), "
            "and 'tags' (an array of zero or more of the closed set: "
            f"{', '.join(t.value for t in RequirementTag)}). Never invent a row "
            f"id not present in the input. The input contains exactly "
            f"{len(items_by_id)} row(s). Return exactly {len(items_by_id)} "
            "entries in your response -- one for EVERY row id in the input, "
            "none omitted, none invented. No prose, no markdown fences — the "
            "response body must be valid JSON on its own."
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
        with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        return _parse_json_object(content)

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
        system_prompt = (
            "You are given two requirement statements: 'candidate' (newly "
            "extracted from a specification document) and 'existing' (already "
            "in Azure DevOps, flagged as a near-duplicate by embedding "
            "similarity alone). Similarity alone cannot tell whether they "
            "actually describe the SAME real-world requirement, or only the "
            "same general topic/subject area. Judge their relationship: "
            "'redundant' if they state the same fact (harmless restatement); "
            "'contradictory' if they state DIFFERENT values for what looks "
            "like the SAME specific parameter/capability (e.g. one says 'at "
            "least 85%' and another says 'at least 93%' for the same "
            "efficiency spec); 'distinct' if they are about the same general "
            "topic/component but cover a genuinely DIFFERENT specific "
            "requirement or scope (e.g. one covers a connector's physical "
            "port count/pinout and the other covers a communication "
            "protocol over that SAME connector -- same subject area, "
            "different requirement). Return ONLY a JSON object with "
            "'verdict' (one of 'redundant', 'contradictory', 'distinct'). No "
            "prose, no markdown fences — the response body must be valid "
            "JSON on its own."
        )
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
        with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
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
        system_prompt = (
            "You are given a JSON object mapping node ids to near-duplicate "
            "requirement statements from the same specification document -- "
            "they were flagged as near-duplicates by embedding similarity, but "
            "similarity alone cannot tell whether they actually agree. Judge "
            "their relationship: 'redundant' if they restate the same fact "
            "(harmless duplication, e.g. the same requirement appearing in a "
            "body section and again in an appendix); 'contradictory' if they "
            "state DIFFERENT values for what looks like the SAME parameter "
            "(e.g. one says 'at least 85%' and another says 'at least 93%' for "
            "the same efficiency spec, or 'input 28VAC' vs 'input 28VDC' for "
            "the same input); 'distinct' if they are genuinely different "
            "requirements that only happened to embed as similar. Return ONLY "
            "a JSON object with 'verdict' (one of the three values above) and "
            "'conflicting_values' (a list of the specific conflicting values "
            "quoted from the text, e.g. ['85%', '93%'] -- empty list unless "
            "verdict is 'contradictory'). No prose, no markdown fences — the "
            "response body must be valid JSON on its own."
        )
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
        with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
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
        system_prompt = (
            "You are given a JSON object mapping node ids to the SHORT TITLES "
            "of a specification document's disconnected top-level sections -- "
            "sections that ended up as separate roots because the document's "
            "own heading outline has no single top-level heading tying them "
            "together. Propose a topical grouping: cluster titles that belong "
            "to the same broader subject into named groups (e.g. several "
            "signal-name sections like 'PS_SYSRESET', 'PS_SYNC', 'PS_SM' might "
            "all belong under a group titled something like 'VPX Utility & "
            "Management Signals'). A section that doesn't clearly belong with "
            "any other should simply not appear in any group -- do not force "
            "every section into a group. Return ONLY a JSON object with a "
            "'groups' array, each entry an object with 'title' (a short, "
            "descriptive name for the group) and 'member_ids' (the node ids, "
            "from the input, that belong in this group -- at least 2 per "
            "group; never invent an id not present in the input). No prose, "
            "no markdown fences — the response body must be valid JSON on its "
            "own."
        )
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
        with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
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
        system_prompt = (
            "You are given the content of one section of a requirements document, "
            "and a JSON object mapping snippet indices (as strings) to knowledge-base "
            "snippets that were retrieved as POSSIBLY relevant reference material for "
            "this section -- retrieval is similarity-based and may include snippets "
            "that are not actually relevant. For each index, judge whether that "
            "snippet's content is genuinely relevant to and would help formalize this "
            "section's requirements. Return ONLY a JSON object with the SAME index "
            "keys, each mapped to 'relevant' or 'not_relevant'. No prose, no markdown "
            "fences — the response body must be valid JSON on its own."
        )
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
        with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
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
        with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
        response.raise_for_status()
        body = response.json()
        content = _strip_json_fence(body["content"])
        nodes = _nodes_from_parsed(_parse_json_object(content))
        truncated = body.get("finishReason") == "length"
        logger.warning(
            "analyze_section result: node_count=%d finishReason=%r truncated=%s topic_count=%r",
            len(nodes), body.get("finishReason"), truncated, topic_count,
        )
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
        see llm_leveling._build_survey_tree_for_branch) so this client stays
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
        system_prompt = _section_analysis_system_prompt(expected_root_count) + tool_hint
        if whole_document:
            system_prompt += _whole_document_hint(topic_count)
        elif topic_count is not None:
            system_prompt += _branch_topic_hint(topic_count)
        system_prompt += _table_group_hint(table_group_hints)
        messages: list[dict] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": section_text},
        ]
        citations: list[dict] = []
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
                # analyze_section already had all along.
                "responseSchema": section_analysis_schema(),
                "maxTokens": _MAX_OUTPUT_TOKENS,
                # See analyze_section's identical doc comment -- same
                # confirmed-live finding, same two SURVEY call sites.
                "think": False,
                **({"numCtx": self._num_ctx} if self._num_ctx else {}),
                **({"topK": self._top_k} if self._top_k else {}),
                **({"minP": self._min_p} if self._min_p else {}),
            }
            with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
                response = client.post(
                    f"{self._base_url}/llm/chat",
                    json=payload,
                    headers={"Authorization": f"Bearer {self._bearer_token}"},
                )
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
                nodes = _nodes_from_parsed(_parse_json_object(content))
                truncated = body.get("finishReason") == "length"
                logger.warning(
                    "analyze_section_agentic result: node_count=%d finishReason=%r truncated=%s query_kb_calls=%d topic_count=%r",
                    len(nodes), body.get("finishReason"), truncated, len(citations), topic_count,
                )
                return nodes, citations, truncated
            # Contradicts toolChoice:'none' on the last round (or the model
            # returned neither tool_calls nor content on an earlier round) --
            # extremely unlikely per the API contract, but fall back to a
            # single non-agentic analyze_section call over the same section
            # text rather than silently returning 0 nodes for this branch.
            logger.warning(
                "analyze_section_agentic: round %d produced neither tool_calls nor content -- falling back to analyze_section",
                round_index,
            )
            fallback_nodes, fallback_truncated = self.analyze_section(
                section_text, kb_context=None, whole_document=whole_document, topic_count=topic_count
            )
            return fallback_nodes, citations, fallback_truncated
        # Exceeded _MAX_TOOL_ROUNDS without a final answer -- degrade to no
        # nodes for this branch rather than looping forever; the branch's
        # existing coverage/completeness warnings surface the gap. Not a
        # length-cap truncation (no final answer was ever reached to check
        # finishReason on) -- reported as truncated=False, a distinct
        # failure mode from analyze_section's own truncation signal.
        logger.warning("analyze_section_agentic: exceeded _MAX_TOOL_ROUNDS=%d without a final answer -- 0 nodes", _MAX_TOOL_ROUNDS)
        return [], citations, False

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

