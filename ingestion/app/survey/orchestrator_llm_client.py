# ingestion/app/survey/orchestrator_llm_client.py
from __future__ import annotations

import json
import re

import httpx

_JSON_FENCE_PATTERN = re.compile(r"^```(?:json)?\s*\n?(.*?)\n?```$", re.DOTALL)

# httpx's default timeout (5s total) is far too short for a real local LLM —
# observed directly: a 12b-class Ollama model took several minutes to over
# ten minutes for a single cold-start inference depending on GPU/CPU
# contention on this box (subsequent warm calls are much faster, but the
# first call in a job's lifetime is not guaranteed warm, and Ollama evicts
# an idle model from memory after a few minutes by default).
_LLM_REQUEST_TIMEOUT_SECONDS = 1800.0


def _strip_json_fence(content: str) -> str:
    """Local models (Ollama included — the golden test's real target) often
    wrap JSON in markdown fences despite being explicitly told not to. Strip
    a single leading/trailing fence if present; otherwise return unchanged.
    Cheap insurance against a single fenced response failing an entire job."""
    match = _JSON_FENCE_PATTERN.match(content.strip())
    return match.group(1).strip() if match else content.strip()


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

    def __init__(self, base_url: str, bearer_token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._bearer_token = bearer_token
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
        }
        with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
        response.raise_for_status()
        content = response.json()["content"]
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError as exc:
            raise ValueError(f"malformed JSON in LLM response content: {content!r}") from exc
        return parsed

    def infer_hierarchy(self, outline: str, profile_hint: object | None, kb_context: str | None = None) -> list[dict]:
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
        }
        with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        try:
            return json.loads(content)
        except json.JSONDecodeError as exc:
            raise ValueError(f"malformed JSON in LLM response content: {content!r}") from exc

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
            "names listed above). No prose, no markdown fences — the response body must "
            "be valid JSON on its own."
        )
        system_prompt = _with_kb_context(system_prompt, kb_context)
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": nodes_json},
            ],
            "temperature": 0,
        }
        with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        try:
            return json.loads(content)
        except json.JSONDecodeError as exc:
            raise ValueError(f"malformed JSON in LLM response content: {content!r}") from exc

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
        }
        with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        try:
            return json.loads(content)
        except json.JSONDecodeError as exc:
            raise ValueError(f"malformed JSON in LLM response content: {content!r}") from exc

    def score_requirements_for_document(
        self, descriptions_by_node_id: dict[str, str], kb_context: str | None = None
    ) -> dict[str, dict]:
        """Batched whole-document quality scoring: one call scoring every
        node's FINAL formalized description, matching the same
        one-call-per-document rationale as generate_requirements_for_document.
        Runs as a separate call (not merged into generate_requirements_for_document)
        so formalization and scoring stay distinct concerns/prompts. The
        EARS/INCOSE/ISO-29148 criteria are always present in the system
        prompt — the model's general knowledge of these public standards is
        the baseline; kb_context, when supplied, is prepended as additive
        org-specific rules, not a replacement branch."""
        system_prompt = (
            "You score requirement quality against EARS, INCOSE, and ISO/IEC/IEEE "
            "29148 criteria: is it unambiguous, individually testable, atomic "
            "(a single requirement per statement), in active voice, and does it "
            "include acceptance criteria and a clear rationale. You are given a "
            "JSON object mapping each node_id to its final formalized requirement "
            "text. Return ONLY a JSON object with the SAME node_id keys, each "
            "mapped to an object with 'score' (an integer 0-100, where 100 is "
            "fully compliant) and 'issues' (a list of zero or more of: ambiguous, "
            "not_testable, compound, missing_acceptance_criteria, vague_term, "
            "passive_voice, missing_rationale). Never invent a node_id not present "
            "in the input. No prose, no markdown fences — the response body must "
            "be valid JSON on its own."
        )
        system_prompt = _with_kb_context(system_prompt, kb_context)
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(descriptions_by_node_id)},
            ],
            "temperature": 0,
        }
        with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        try:
            return json.loads(content)
        except json.JSONDecodeError as exc:
            raise ValueError(f"malformed JSON in LLM response content: {content!r}") from exc
