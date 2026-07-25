# ingestion/app/survey/orchestrator_llm_client.py
from __future__ import annotations

import json
import logging
import re
from typing import Callable

import httpx

from app.survey._response_schemas import (
    kb_relevance_schema,
    requirements_by_node_schema,
    scores_schema,
    section_analysis_schema,
)

logger = logging.getLogger(__name__)

_JSON_FENCE_PATTERN = re.compile(r"^```(?:json)?\s*\n?(.*?)\n?```$", re.DOTALL)

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


def _strip_json_fence(content: str) -> str:
    """Local models (Ollama included — the golden test's real target) often
    wrap JSON in markdown fences despite being explicitly told not to. Strip
    a single leading/trailing fence if present; otherwise return unchanged.
    Cheap insurance against a single fenced response failing an entire job."""
    match = _JSON_FENCE_PATTERN.match(content.strip())
    return match.group(1).strip() if match else content.strip()


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
    the rest of the response parse correctly. Any other malformation still
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
            raise ValueError(f"malformed JSON in LLM response content: {content!r}") from exc
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
    "IMPORTANT on parent_temp_id: null means 'this node has no parent at all "
    "-- it is a root of the tree', NOT a placeholder or default. At most ONE "
    "node in your entire response should have parent_temp_id null (the single "
    "section root -- usually the first Epic or Feature you emit). EVERY other "
    "node -- including the LAST ones you emit, however many nodes there are -- "
    "must set parent_temp_id to an already-emitted temp_id from earlier in "
    "this same array (its Epic, Feature, or another Requirement it belongs "
    "under). Do not let parent_temp_id drift to null for later nodes just "
    "because the response is long -- re-check this field for every single "
    "node before finishing."
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
        # redesign) -- forwarded only on analyze_section/analyze_section_agentic,
        # the two calls the §3 whole-document gate actually depends on being
        # backed by a real, large-enough context window. Sized by the caller
        # (app.main's /level route) from the SAME _resolve_caps(model) budget
        # build_survey_tree itself gates on. None (the default) omits the
        # field entirely, matching pre-num_ctx behavior exactly.
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

    def infer_hierarchy(
        self, outline: str, profile_hint: object | None, kb_context: str | None = None
    ) -> list[dict]:
        # profile_hint is currently unused by the real prompt — LlmLevelingClient's
        # Protocol declares it for future profile-aware prompting, not exercised yet.
        system_prompt = (
            "You infer a work-item hierarchy from an outline of requirement text. "
            "Each line of the outline is one candidate node, addressed by its "
            "0-based line index as a string. Return ONLY a JSON array of objects, "
            "each with 'node_id' (the line index as a string), 'type' (one of: "
            "Epic, Feature, Requirement), and 'parent_id' (the node_id of its "
            "parent, or null for a root node). Honor 'same depth, different type "
            "per branch' when the content implies it. Never invent a node_id not "
            "present in the outline. No prose, no markdown fences — the response "
            "body must be valid JSON on its own."
        )
        system_prompt = _with_kb_context(system_prompt, kb_context)
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": outline},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            # No response_format: this is the top-level array that actually
            # wedged Ollama's whole server live for 10+ minutes (up to 200
            # items on a real branch) -- see _response_schemas.py's module
            # docstring. Defended by the existing WorkItemType ValueError
            # fallback in llm_leveling.py instead.
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
        return _parse_json_object(content)

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
            "'title', and 'text'. You may propose zero or more links. For each link, "
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
        byte-identical to before either capability existed."""
        system_prompt = (
            "You judge the quality of formal 'shall'-style requirement statements "
            "against EARS, INCOSE, and ISO/IEC/IEEE 29148 criteria (unambiguous, "
            "testable, atomic/not compound, has clear acceptance criteria, no vague "
            "terms like 'user-friendly' or 'fast', active voice, states its "
            "rationale when non-obvious). You are given a JSON object mapping each "
            "requirement's node_id to its final text. Return ONLY a JSON object "
            "with the SAME node_id keys, each mapped to an object with 'score' "
            "(an integer 0-100, where 100 is a fully compliant requirement) and "
            "'issues' (a list of zero or more of: ambiguous, not_testable, "
            "compound, missing_acceptance_criteria, vague_term, passive_voice, "
            "missing_rationale). Never invent a node_id not present in the input. "
            "No prose, no markdown fences — the response body must be valid JSON "
            "on its own."
        )
        if criteria_context:
            system_prompt += (
                "\n\nThe following reference criteria were retrieved as most relevant "
                f"to these requirements -- cite them in your judgment:\n{criteria_context}"
            )
        system_prompt = _with_kb_context(system_prompt, kb_context)
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(descriptions_by_node_id)},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": scores_schema(),
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
        system_prompt = _with_kb_context(_SECTION_ANALYSIS_SYSTEM_PROMPT, kb_context)
        if whole_document:
            system_prompt += _whole_document_hint(topic_count)
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": section_text},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": section_analysis_schema(),
            "maxTokens": _MAX_OUTPUT_TOKENS,
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
        system_prompt = _SECTION_ANALYSIS_SYSTEM_PROMPT + tool_hint
        if whole_document:
            system_prompt += _whole_document_hint(topic_count)
        messages: list[dict] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": section_text},
        ]
        citations: list[dict] = []
        for _ in range(_MAX_TOOL_ROUNDS):
            payload = {
                "messages": messages,
                "temperature": 0,
                **({"model": self._model} if self._model else {}),
                "tools": tools,
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
            if tool_calls:
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
            nodes = _nodes_from_parsed(_parse_json_object(content))
            truncated = body.get("finishReason") == "length"
            logger.warning(
                "analyze_section_agentic result: node_count=%d finishReason=%r truncated=%s query_kb_calls=%d topic_count=%r",
                len(nodes), body.get("finishReason"), truncated, len(citations), topic_count,
            )
            return nodes, citations, truncated
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

    def generate_requirements_for_document(
        self, blocks_by_node_id: dict[str, str], kb_context: str | None = None
    ) -> dict[str, list[dict]]:
        """Batched sibling of generate_requirements: one LLM call for every
        node in the tree, not one call per node. A first draft of this
        wiring made ~2 LLM calls per node (title distillation + per-block
        requirement generation) — for a 50-block document, ~101 sequential
        blocking calls. This method and dropping title distillation entirely
        (see llm_leveling.py) cut that to ~2 total calls per document,
        mirroring how infer_hierarchy already sends the whole outline in one
        call rather than one call per line."""
        system_prompt = (
            "You convert several informal requirement blocks into formal 'shall' "
            "statements. You are given a JSON object mapping each block's node_id "
            "to its raw text. Return ONLY a JSON object with the SAME node_id keys, "
            "each mapped to a list of objects with 'text' (a single formal "
            "shall-style requirement sentence) and 'tags' (a list of zero or more "
            "of: functional, non_functional, interface, performance, regulatory, "
            "safety, security, operation, maintenance, feature, behavior). A block "
            "that yields no formal requirement (e.g. a heading) maps to an empty "
            "list. Never invent a node_id not present in the input. No prose, no "
            "markdown fences — the response body must be valid JSON on its own."
        )
        system_prompt = _with_kb_context(system_prompt, kb_context)
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(blocks_by_node_id)},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": requirements_by_node_schema(),
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
