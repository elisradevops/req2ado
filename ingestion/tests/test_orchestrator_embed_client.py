import httpx

from app.dedup.orchestrator_embed_client import OrchestratorEmbedClient, _EMBED_REQUEST_TIMEOUT_SECONDS


def test_embed_calls_the_orchestrator_embed_endpoint_with_bearer_auth() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-bearer"
        assert request.url.path == "/llm/embed"
        return httpx.Response(200, json={"embeddings": [[0.1, 0.2, 0.3]]})

    client = OrchestratorEmbedClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.embed(["The unit shall survive a drop."])
    assert result == [[0.1, 0.2, 0.3]]


def test_embed_sends_all_texts_in_one_request() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"embeddings": [[0.1], [0.2]]})

    client = OrchestratorEmbedClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.embed(["text one", "text two"])
    assert captured["body"]["texts"] == ["text one", "text two"]


def test_embed_uses_a_real_timeout_not_httpxs_5_second_default(monkeypatch) -> None:
    # Regression guard for a confirmed real bug: this client previously
    # constructed httpx.Client() with NO explicit timeout at all, so
    # httpx's own 5-second default applied -- every sibling LLM client in
    # this codebase (OrchestratorLlmClient: 1800s, OrchestratorVisionClient:
    # 300s) uses a real timeout sized for a cold local model precisely
    # because Ollama evicts an idle model after a few minutes, so this
    # client's first call in a job's lifetime is not guaranteed warm either.
    captured_kwargs: dict = {}
    real_client_cls = httpx.Client

    class _CapturingClient(real_client_cls):
        def __init__(self, *args, **kwargs):
            captured_kwargs.update(kwargs)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "Client", _CapturingClient)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"embeddings": [[0.1]]})

    client = OrchestratorEmbedClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.embed(["text"])

    assert captured_kwargs.get("timeout") == _EMBED_REQUEST_TIMEOUT_SECONDS
    assert _EMBED_REQUEST_TIMEOUT_SECONDS > 5  # must be meaningfully larger than httpx's own default


def test_embed_raises_on_non_200_response() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"message": "unauthorized"})

    client = OrchestratorEmbedClient(base_url="http://orchestrator.internal", bearer_token="wrong-token")
    client._transport = httpx.MockTransport(handler)

    import pytest

    with pytest.raises(httpx.HTTPStatusError):
        client.embed(["text"])
