from __future__ import annotations

import threading

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
        # One client, and so one connection pool, for the life of the process: a job makes one /llm/embed call per node (hundreds, several at
        # a time) and each used to open and close its own client. Built on first use, rebuilt if the transport seam was swapped, shared by
        # every thread (httpx.Client is thread-safe).
        self._http: httpx.Client | None = None
        self._http_transport: httpx.BaseTransport | None = None
        self._http_lock = threading.Lock()

    def _client(self) -> httpx.Client:
        with self._http_lock:
            if self._http is None or self._http.is_closed or self._http_transport is not self._transport:
                if self._http is not None and not self._http.is_closed:
                    self._http.close()
                self._http = httpx.Client(transport=self._transport, timeout=_EMBED_REQUEST_TIMEOUT_SECONDS)
                self._http_transport = self._transport
            return self._http

    def close(self) -> None:
        """Releases the pooled connections; the next call builds a new client."""
        with self._http_lock:
            if self._http is not None:
                self._http.close()
                self._http = None

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
        response = self._client().post(
            f"{self._base_url}/llm/embed",
            json={"texts": texts},
            headers=headers,
        )
        response.raise_for_status()
        return response.json()["embeddings"]
