from __future__ import annotations

import httpx

# Confirmed real bug: this was the only LLM-adjacent client in the
# codebase with NO explicit timeout, meaning httpx's own 5-second default
# applied -- every other client here uses a real timeout sized for a cold
# local model (OrchestratorLlmClient: 1800s, OrchestratorVisionClient:
# 300s) precisely because Ollama evicts an idle model from memory after a
# few minutes, so the FIRST call in a job's lifetime is not guaranteed
# warm. A cold-start embed call (used by KB retrieval, dedup checks, and
# criteria retrieval -- none of which can tolerate a silent 5s timeout)
# would fail spuriously under exactly the same conditions this module's
# sibling clients already guard against. 120s: embedding is normally much
# faster than full generation even cold, but still needs real headroom.
_EMBED_REQUEST_TIMEOUT_SECONDS = 120.0


class OrchestratorEmbedClient:
    """Calls the orchestrator's POST /llm/embed proxy (Phase 6 Part A) —
    NEVER calls Open WebUI/Ollama directly, same 'backend proxy, redact-
    first' boundary as Phase 5's OrchestratorLlmClient. Mirrors that class's
    structure and test-injection seam exactly."""

    def __init__(self, base_url: str, bearer_token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._bearer_token = bearer_token
        self._transport: httpx.BaseTransport | None = None  # test-only injection seam

    def embed(self, texts: list[str], user_id: str | None = None) -> list[list[float]]:
        """`user_id` -- the orchestrator now requires an X-Req2Ado-User-Id
        header identifying which user's vaulted Open WebUI credential to
        use for /llm/embed (no shared/global fallback credential exists any
        more); a request with a valid bearer token but a missing/unknown
        header is rejected with 401. Must be a per-call parameter, never
        stored on `self`, for the same reason documented on
        OrchestratorLlmClient._post_chat: this class is constructed as a
        module-level singleton (main.py's `_embed_client`) shared across
        every concurrent request the process handles. Omitted from the
        header entirely when falsy, never sent as an empty string."""
        headers = {"Authorization": f"Bearer {self._bearer_token}"}
        if user_id:
            headers["X-Req2Ado-User-Id"] = user_id
        with httpx.Client(transport=self._transport, timeout=_EMBED_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/embed",
                json={"texts": texts},
                headers=headers,
            )
        response.raise_for_status()
        return response.json()["embeddings"]
