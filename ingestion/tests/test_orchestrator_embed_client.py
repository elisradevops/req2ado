import httpx

from app.dedup.orchestrator_embed_client import OrchestratorEmbedClient


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


def test_embed_raises_on_non_200_response() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"message": "unauthorized"})

    client = OrchestratorEmbedClient(base_url="http://orchestrator.internal", bearer_token="wrong-token")
    client._transport = httpx.MockTransport(handler)

    import pytest

    with pytest.raises(httpx.HTTPStatusError):
        client.embed(["text"])
