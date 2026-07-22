# ingestion/app/survey/orchestrator_llm_client.py
from __future__ import annotations

import json
import re
from typing import Callable

import httpx

from app.survey._response_schemas import (
    kb_relevance_schema,
    requirements_by_node_schema,
    scores_schema,
    section_analysis_schema,
)

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
    truncation fix."""
    try:
        obj, _end = json.JSONDecoder().raw_decode(content)
    except json.JSONDecodeError as exc:
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

_SECTION_ANALYSIS_SYSTEM_PROMPT = (
    "You are analyzing one section of a customer requirements document. First "
    "understand the section as a whole -- its headings, prose, bullet/spec lists, "
    "tables, and figure descriptions together form coherent requirements, NOT one "
    "requirement per line. Synthesize them. Return a work-item tree for THIS "
    "section as a JSON object {\"nodes\": [...]}. Each node has: 'temp_id' (a "
    "unique short id you assign, e.g. 'n1'), 'type' (one of: Epic, Feature, "
    "Requirement), 'parent_temp_id' (the temp_id of its parent in this same "
    "array, or null for a section root), 'text' (a single formal shall-style "
    "requirement statement that folds in every related value/bullet/cell -- do "
    "NOT emit one node per bullet), and 'tags' (zero or more of: functional, "
    "non_functional, interface, performance, regulatory, safety, security, "
    "operation, maintenance, feature, behavior). Emit as many or as few nodes as "
    "the section genuinely contains. No prose, no markdown fences -- the body "
    "must be valid JSON on its own."
)

_SECTION_ANALYSIS_TOOL_HINT = (
    "\n\nYou may call the query_kb tool zero or more times first if additional "
    "reference material would help you formalize this section's requirements. "
    "Once you have what you need (or need nothing further), respond with the "
    "final JSON object described above -- not a tool call."
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

    def __init__(self, base_url: str, bearer_token: str, model: str | None = None) -> None:
        self._base_url = base_url.rstrip("/")
        self._bearer_token = bearer_token
        # Per-job model override (see /level's `model` query param) -- when
        # unset, the orchestrator's own /llm/chat proxy falls back to its
        # configured LLM_CHAT_MODEL default, matching pre-model-selection
        # behavior exactly.
        self._model = model
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

    def analyze_section(self, section_text: str, kb_context: str | None = None) -> list[dict]:
        """Single holistic SURVEY call replacing the old infer_hierarchy +
        generate_requirements_for_document pair for the whole-tree-in-one-call
        redesign. Given ONE coherent, structure-preserving markdown rendering
        of a whole section (see llm_leveling.render_section), returns the
        COMPLETE node set the model decides the section contains -- however
        many, not one per input block. This is the FALLBACK path for models
        without tool-calling support (see §5c's capability gate) -- KB context,
        when available, is a pre-computed once-per-document string threaded in
        via kb_context rather than actively retrieved. Tool-capable models use
        analyze_section_agentic instead."""
        system_prompt = _with_kb_context(_SECTION_ANALYSIS_SYSTEM_PROMPT, kb_context)
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": section_text},
            ],
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            "responseSchema": section_analysis_schema(),
        }
        with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        return _nodes_from_parsed(_parse_json_object(content))

    def analyze_section_agentic(
        self,
        section_text: str,
        retrieve_fn: Callable[[str], tuple[str | None, list[dict]]],
    ) -> tuple[list[dict], list[dict]]:
        """Tool-calling variant of analyze_section for models that support it
        (see §5c's capability gate) -- the model actively pulls KB context via
        a query_kb tool call DURING analysis instead of us pre-computing
        relevance once per document. `retrieve_fn` is injected by the caller
        (closing over area_path/embed_client/vector_store -> retrieve_context,
        see llm_leveling._build_survey_tree_for_branch) so this client stays
        free of KB dependencies -- it only executes tool calls the model asks
        for. Bounded to _MAX_TOOL_ROUNDS turns so a model that keeps calling
        the tool can't loop forever. Returns (nodes, citations) -- citations
        are every (source_file, similarity) hit actually retrieved across all
        query_kb calls, marked relevant by the model's own choice to use them
        (see llm_leveling's KbCitation construction)."""
        messages: list[dict] = [
            {"role": "system", "content": _SECTION_ANALYSIS_SYSTEM_PROMPT + _SECTION_ANALYSIS_TOOL_HINT},
            {"role": "user", "content": section_text},
        ]
        citations: list[dict] = []
        for _ in range(_MAX_TOOL_ROUNDS):
            payload = {
                "messages": messages,
                "temperature": 0,
                **({"model": self._model} if self._model else {}),
                "tools": [QUERY_KB_TOOL],
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
                    query = args.get("query", "") if isinstance(args, dict) else ""
                    tool_result = "(no query provided)"
                    if query:
                        kb_context, hits = retrieve_fn(query)
                        citations.extend(hits)
                        tool_result = kb_context or "(no relevant context found)"
                    messages.append({"role": "tool", "tool_call_id": call["id"], "content": tool_result})
                continue
            content = _strip_json_fence(body.get("content", ""))
            return _nodes_from_parsed(_parse_json_object(content)), citations
        # Exceeded _MAX_TOOL_ROUNDS without a final answer -- degrade to no
        # nodes for this branch rather than looping forever; the branch's
        # existing coverage/completeness warnings surface the gap.
        return [], citations

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
