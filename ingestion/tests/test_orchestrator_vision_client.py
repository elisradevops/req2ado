# ingestion/tests/test_orchestrator_vision_client.py
import base64
import json

import httpx
import pytest

from app.vision.orchestrator_vision_client import FigureVisionResult, OrchestratorVisionClient


def test_describe_figure_calls_the_orchestrator_vision_endpoint_with_bearer_auth() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-bearer"
        assert request.url.path == "/llm/vision"
        return httpx.Response(200, json={"description": json.dumps({"significant": True, "description": "A block diagram showing power distribution."})})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.describe_figure(b"fake-png-bytes")
    assert result == FigureVisionResult(significant=True, description="A block diagram showing power distribution.")


def test_describe_figure_sends_the_image_base64_encoded() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"description": json.dumps({"significant": True, "description": "ok"})})

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


def test_describe_figure_forwards_mime_type_when_supplied() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"description": json.dumps({"significant": True, "description": "ok"})})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.describe_figure(b"fake-jpeg-bytes", mime_type="image/jpeg")

    assert captured["body"]["mimeType"] == "image/jpeg"


def test_describe_figure_omits_mime_type_when_not_supplied() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"description": json.dumps({"significant": True, "description": "ok"})})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.describe_figure(b"fake-png-bytes")

    assert "mimeType" not in captured["body"]


def test_describe_figure_parses_significant_false() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"description": json.dumps({"significant": False, "description": "A decorative rectangular block."})})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.describe_figure(b"fake-bytes")
    assert result.significant is False


def test_describe_figure_sends_responseSchema_and_document_context_in_the_prompt() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"description": json.dumps({"significant": True, "description": "ok"})})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.describe_figure(b"fake-bytes", document_context="This is an avionics interface control document.")

    assert "responseSchema" in captured["body"]
    assert captured["body"]["responseSchema"]["name"]
    assert "avionics interface control document" in captured["body"]["prompt"]


def test_describe_figure_returns_none_on_a_totally_unparseable_response() -> None:
    # A bad-figure-description parse failure must never raise -- but it is
    # ALSO distinct from a genuinely parsed significant=False verdict: None
    # signals "unknown, don't cache this" to the caller (main.py's
    # _describe_figure), preserving the exact "don't memorize a glitch for
    # a week" protection the old blank-caption guard provided, while a real
    # parsed significant=False IS cached (a confident, deliberate verdict,
    # not an ambiguous blank).
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"description": "not valid json at all"})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.describe_figure(b"fake-bytes")
    assert result is None


def test_describe_figure_recovers_a_slightly_malformed_json_reply_via_repair() -> None:
    # A model appending stray trailing content after otherwise-valid JSON
    # (the same real failure shape orchestrator_llm_client.py's own
    # _parse_json_object already tolerates) must still parse correctly.
    # Note: json.loads tolerates trailing whitespace, so we use non-whitespace
    # garbage to actually trigger the json_repair fallback path.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"description": '{"significant": true, "description": "A block diagram."} garbage'})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.describe_figure(b"fake-bytes")
    assert result == FigureVisionResult(significant=True, description="A block diagram.")
