import base64
import json

import httpx
import pytest

from app.vision.orchestrator_vision_client import OrchestratorVisionClient


def test_describe_figure_calls_the_orchestrator_vision_endpoint_with_bearer_auth() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-bearer"
        assert request.url.path == "/llm/vision"
        return httpx.Response(200, json={"description": "A block diagram showing power distribution."})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.describe_figure(b"fake-png-bytes")
    assert result == "A block diagram showing power distribution."


def test_describe_figure_sends_the_image_base64_encoded() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"description": "ok"})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.describe_figure(b"fake-png-bytes")

    assert captured["body"]["images"] == [base64.b64encode(b"fake-png-bytes").decode("ascii")]
    assert "prompt" in captured["body"]


def test_describe_figure_raises_on_non_200_response() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, json={"message": "bad gateway"})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    with pytest.raises(httpx.HTTPStatusError):
        client.describe_figure(b"img")
