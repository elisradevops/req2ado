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

    def infer_hierarchy(self, outline: str, profile_hint: object | None) -> list[dict]:
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

    def generate_requirements_for_document(self, blocks_by_node_id: dict[str, str]) -> dict[str, list[dict]]:
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
