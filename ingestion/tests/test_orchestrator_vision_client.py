# ingestion/tests/test_orchestrator_vision_client.py
import base64
import json

import httpx
import pytest

from app.config import settings
from app.vision.orchestrator_vision_client import (
    _VISION_REQUEST_TIMEOUT_SECONDS,
    PROMPT_VERSION,
    FigureVisionResult,
    OrchestratorVisionClient,
    _build_prompt,
    _FIGURE_SIGNIFICANCE_SCHEMA,
)


def test_prompt_version_is_derived_from_the_actual_prompt_and_schema_text() -> None:
    # Real gap this guards against: main.py's figure-caption Redis cache
    # (1-week TTL) has no way to tell "the prompt changed" apart from "the
    # same image, same context" unless PROMPT_VERSION is derived from the
    # actual prompt/schema text -- confirmed live, this prompt's own wording
    # changed twice in one real debugging session, each requiring a manual
    # `redis-cli DEL figcap:*` to observe the fix, since the old key scheme
    # had nothing that would have changed. Asserts PROMPT_VERSION is
    # genuinely computed from the live prompt/schema, not a hardcoded
    # literal that happens to look like a hash -- if either changes without
    # this derivation also changing, this test fails.
    import hashlib

    expected = hashlib.sha256(
        (_build_prompt(None) + json.dumps(_FIGURE_SIGNIFICANCE_SCHEMA, sort_keys=True)).encode("utf-8")
    ).hexdigest()[:12]
    assert PROMPT_VERSION == expected

    # And the derivation itself is sensitive to the prompt text changing --
    # the actual property that makes cache invalidation work.
    changed = hashlib.sha256(
        (_build_prompt(None) + "extra" + json.dumps(_FIGURE_SIGNIFICANCE_SCHEMA, sort_keys=True)).encode("utf-8")
    ).hexdigest()[:12]
    assert PROMPT_VERSION != changed


def test_describe_figure_strips_a_degenerate_continuation_fragment_leaking_into_the_description() -> None:
    # Real live incident, confirmed via a completed job's actual captions
    # (not a synthetic guess): 2 of 42 real figure descriptions came back
    # with their own genuine content repeated near-verbatim, trailed by a
    # broken continuation fragment starting with a markdown code fence --
    # this is a near-verbatim reproduction of the actual observed pattern,
    # not an invented worst case. The real caption (before the fence) must
    # survive; only the degenerate tail is cut.
    real_caption = (
        "This drawing provides multiple orthogonal views detailing the electrical and mechanical "
        "interface of a CubeADCS unit. The top view shows a rectangular panel measuring 46.43 by "
        "40.72 units."
    )
    degenerate_tail = (
        ".} } " + real_caption + " } } This figure contains genuine informational content "
        "worth including because it specifies critical physical dimensions. } } ```json {\""
    )
    raw = json.dumps({"significant": True, "description": real_caption + degenerate_tail})

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"description": raw})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.describe_figure(b"fake-png-bytes")

    assert result is not None
    assert result.significant is True
    assert "```" not in result.description
    assert result.description.startswith(real_caption)


def test_describe_figure_treats_a_fence_only_description_as_the_same_ambiguous_none_outcome() -> None:
    # Edge case of the fix above: if the code fence appears at the START of
    # the description (nothing real before it survives stripping), this
    # must fall into the SAME "ambiguous, don't cache" None outcome a blank
    # significant=True description already gets -- not a confidently
    # returned empty string.
    raw = json.dumps({"significant": True, "description": "```json {\"broken"})

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"description": raw})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    assert client.describe_figure(b"fake-png-bytes") is None


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


@pytest.mark.parametrize(
    "blank_description",
    [None, "", "   "],
    ids=["null-description", "empty-description", "whitespace-only-description"],
)
def test_describe_figure_returns_none_for_a_significant_verdict_with_a_blank_description(blank_description) -> None:
    # Cache-poisoning guard (confirmed live incident: an AirPro document whose
    # 39 figures were all blank for a week). significant=True with a blank
    # description is well-formed enough to parse but useless as a caption --
    # if it were returned as a FigureVisionResult, main.py's _describe_figure
    # would write it to Redis with the 7-day TTL and replay the blank for a
    # week. Folded into the SAME None outcome as a totally unparseable
    # response so the existing "don't cache None" rule covers it, rather than
    # a second parallel guard in the caller. The `null` case is the one this
    # module itself used to manufacture (null -> "" coercion + significant
    # true).
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"description": json.dumps({"significant": True, "description": blank_description})})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    assert client.describe_figure(b"fake-bytes") is None


def test_describe_figure_timeout_comes_from_settings_not_a_hardcoded_constant() -> None:
    # Regression guard: this client used to hardcode
    # _VISION_REQUEST_TIMEOUT_SECONDS = 300.0. It must instead read
    # settings.vision_request_timeout_seconds (default 590s -- just under
    # the orchestrator's own 600s LLM_REQUEST_TIMEOUT_MS default, see
    # config.py's own doc comment) so it's configurable without a code
    # change, and so the two timeouts can be kept in sync.
    assert _VISION_REQUEST_TIMEOUT_SECONDS == settings.vision_request_timeout_seconds
    assert _VISION_REQUEST_TIMEOUT_SECONDS == 590.0
    assert _VISION_REQUEST_TIMEOUT_SECONDS != 300.0  # the old hardcoded value


def test_describe_figure_uses_the_settings_sourced_timeout_on_the_real_httpx_call(monkeypatch) -> None:
    # Mirrors OrchestratorEmbedClient's own
    # test_embed_uses_a_real_timeout_not_httpxs_5_second_default: proves the
    # timeout actually reaches httpx.Client, not just that the module
    # constant has the right value in isolation.
    captured_kwargs: dict = {}
    real_client_cls = httpx.Client

    class _CapturingClient(real_client_cls):
        def __init__(self, *args, **kwargs):
            captured_kwargs.update(kwargs)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "Client", _CapturingClient)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"description": json.dumps({"significant": True, "description": "ok"})})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.describe_figure(b"fake-bytes")

    assert captured_kwargs.get("timeout") == _VISION_REQUEST_TIMEOUT_SECONDS
    assert captured_kwargs.get("timeout") == settings.vision_request_timeout_seconds


def test_describe_figure_still_parses_an_insignificant_verdict_with_an_empty_description() -> None:
    # The blank-description guard above must NOT swallow this: the schema's
    # own `description` field says it may be empty when the figure is not
    # significant, so this is a confident, deliberate verdict -- a real result
    # the caller SHOULD cache, not an ambiguous blank.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"description": json.dumps({"significant": False, "description": ""})})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    assert client.describe_figure(b"fake-bytes") == FigureVisionResult(significant=False, description="")
