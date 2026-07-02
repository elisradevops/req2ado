from __future__ import annotations

import httpx


class OrchestratorEmbedClient:
    """Calls the orchestrator's POST /llm/embed proxy (Phase 6 Part A) —
    NEVER calls Open WebUI/Ollama directly, same 'backend proxy, redact-
    first' boundary as Phase 5's OrchestratorLlmClient. Mirrors that class's
    structure and test-injection seam exactly."""

    def __init__(self, base_url: str, bearer_token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._bearer_token = bearer_token
        self._transport: httpx.BaseTransport | None = None  # test-only injection seam

    def embed(self, texts: list[str]) -> list[list[float]]:
        with httpx.Client(transport=self._transport) as client:
            response = client.post(
                f"{self._base_url}/llm/embed",
                json={"texts": texts},
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
        response.raise_for_status()
        return response.json()["embeddings"]
