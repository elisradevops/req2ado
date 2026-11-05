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


def test_describe_figure_parses_a_title_when_the_model_provides_one() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"description": json.dumps({"significant": True, "description": "A block diagram.", "title": "Power Distribution Diagram"})},
        )

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.describe_figure(b"fake-png-bytes")
    assert result == FigureVisionResult(significant=True, description="A block diagram.", title="Power Distribution Diagram")


def test_describe_figure_title_defaults_to_none_when_the_model_omits_it() -> None:
    # Not in the schema's `required` list -- a model that omits it must not
    # fail the whole parse, unlike significant/description.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"description": json.dumps({"significant": True, "description": "A block diagram."})})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.describe_figure(b"fake-png-bytes")
    assert result == FigureVisionResult(significant=True, description="A block diagram.", title=None)


def test_describe_figure_title_normalizes_a_blank_string_to_none() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"description": json.dumps({"significant": True, "description": "A block diagram.", "title": "   "})})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.describe_figure(b"fake-png-bytes")
    assert result.title is None


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
    monkeypatch.setattr(settings, "vision_figure_budget_seconds", 0.0)  # kill switch: the legacy call timeout applies
    # Mirrors OrchestratorEmbedClient's own
    # test_embed_uses_a_real_timeout_not_httpxs_5_second_default: proves the
    # timeout actually reaches httpx.Client, not just that the module
    # constant has the right value in isolation.
    captured_kwargs: dict = {}
    real_client_cls = httpx.AsyncClient

    class _CapturingClient(real_client_cls):
        def __init__(self, *args, **kwargs):
            captured_kwargs.update(kwargs)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", _CapturingClient)

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


def test_describe_figure_sends_the_model_only_when_one_is_given() -> None:
    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"description": json.dumps({"significant": True, "description": "A diagram."})})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.describe_figure(b"fake-png-bytes")
    client.describe_figure(b"fake-png-bytes", model="claude-opus-4-8")

    assert "model" not in bodies[0]
    assert bodies[1]["model"] == "claude-opus-4-8"


# --- a failed figure is tried again before it is given up on -----------------------------------------------------

def _big_png() -> bytes:
    import io

    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGBA", (3200, 2400), (200, 30, 30, 128)).save(buffer, format="PNG")
    return buffer.getvalue()


def _ok_body() -> dict:
    return {"description": json.dumps({"significant": True, "description": "A block diagram.", "title": "Block diagram"})}


def _client_with(handler) -> OrchestratorVisionClient:
    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="tok")
    client._transport = httpx.MockTransport(handler)
    return client


def test_a_body_less_400_is_retried_once_with_the_image_downscaled_and_re_encoded() -> None:
    # Prod: 4 of 36 figures got an instant "400 (no body)" on GPT vision while the other 32 passed: the upstream refuses
    # some images (size or encoding), and the same bytes would be refused again.
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(body)
        return httpx.Response(400) if len(seen) == 1 else httpx.Response(200, json=_ok_body())

    result = _client_with(handler).describe_figure(_big_png(), "image/png")

    assert result is not None and result.description == "A block diagram."
    assert len(seen) == 2
    import base64
    import io

    from PIL import Image

    first, second = (base64.b64decode(b["images"][0]) for b in seen)
    assert seen[1]["mimeType"] == "image/jpeg"
    assert max(Image.open(io.BytesIO(second)).size) <= 1600 < max(Image.open(io.BytesIO(first)).size)


def test_a_server_error_or_timeout_is_retried_once_with_the_same_image() -> None:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        if len(seen) == 1:
            return httpx.Response(502, text="empty completion")
        return httpx.Response(200, json=_ok_body())

    client = _client_with(handler)
    client._retry_pause_seconds = 0
    assert client.describe_figure(b"\x89PNG-small", "image/png") is not None
    assert len(seen) == 2 and seen[0]["images"] == seen[1]["images"]


def test_a_figure_that_fails_twice_still_raises_so_the_caller_records_it() -> None:
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        return httpx.Response(400)

    client = _client_with(handler)
    client._retry_pause_seconds = 0
    with pytest.raises(httpx.HTTPStatusError):
        client.describe_figure(_big_png(), "image/png")
    assert attempts["n"] == 2  # never a loop


def test_an_authentication_failure_is_not_retried() -> None:
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        return httpx.Response(401)

    with pytest.raises(httpx.HTTPStatusError):
        _client_with(handler).describe_figure(_big_png(), "image/png")
    assert attempts["n"] == 1


def test_a_422_cut_off_answer_is_not_retried() -> None:
    # The orchestrator answers 422 when the model's reply was cut off at the largest output limit it allows (or the figure's
    # time ran out while raising it). The same image would be cut off again, so it is a final outcome for this figure.
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        return httpx.Response(422)

    with pytest.raises(httpx.HTTPStatusError):
        _client_with(handler).describe_figure(_big_png(), "image/png")
    assert attempts["n"] == 1


def test_an_image_that_cannot_be_decoded_is_retried_as_it_is_not_crashed_on() -> None:
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        return httpx.Response(400) if attempts["n"] == 1 else httpx.Response(200, json=_ok_body())

    assert _client_with(handler).describe_figure(b"not an image at all", None) is not None
    assert attempts["n"] == 2



# --- one figure has a time budget, and a timeout is not sent again ---------------------------------------------------

def _timeout_then_ok(seen: list):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if len(seen) == 1:
            raise httpx.ReadTimeout("slow", request=request)
        return httpx.Response(200, json=_ok_body())

    return handler


def test_a_timed_out_figure_is_not_sent_again_so_one_figure_costs_one_budget_not_two(monkeypatch) -> None:
    monkeypatch.setattr(settings, "vision_figure_budget_seconds", 240.0)
    seen: list = []
    client = _client_with(_timeout_then_ok(seen))
    client._retry_pause_seconds = 0
    with pytest.raises(httpx.TimeoutException):
        client.describe_figure(b"\x89PNG-small", "image/png")
    assert len(seen) == 1


def test_with_the_budget_switched_off_a_timeout_is_still_retried_once_as_before(monkeypatch) -> None:
    monkeypatch.setattr(settings, "vision_figure_budget_seconds", 0.0)
    seen: list = []
    client = _client_with(_timeout_then_ok(seen))
    client._retry_pause_seconds = 0
    assert client.describe_figure(b"\x89PNG-small", "image/png") is not None
    assert len(seen) == 2


def test_the_call_timeout_is_the_remaining_figure_budget_not_the_590_second_ceiling(monkeypatch) -> None:
    monkeypatch.setattr(settings, "vision_figure_budget_seconds", 240.0)
    captured: dict = {}
    real_client_cls = httpx.AsyncClient

    class _Capturing(real_client_cls):
        def __init__(self, *args, **kwargs):
            captured["timeout"] = kwargs.get("timeout")
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", _Capturing)
    _client_with(lambda request: httpx.Response(200, json=_ok_body())).describe_figure(b"x", "image/png")
    assert 0 < captured["timeout"] <= 240.0


def test_the_remaining_budget_is_sent_to_the_orchestrator_as_a_deadline_header(monkeypatch) -> None:
    monkeypatch.setattr(settings, "vision_figure_budget_seconds", 240.0)
    seen: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=_ok_body())

    _client_with(handler).describe_figure(b"x", "image/png")
    deadline_ms = int(seen[0].headers["x-req2ado-deadline-ms"])
    assert 0 < deadline_ms <= 240_000
    monkeypatch.setattr(settings, "vision_figure_budget_seconds", 0.0)
    seen.clear()
    _client_with(handler).describe_figure(b"x", "image/png")
    assert "x-req2ado-deadline-ms" not in seen[0].headers


def test_a_429_waits_for_retry_after_when_it_fits_in_the_budget_and_gives_up_when_it_does_not(monkeypatch) -> None:
    monkeypatch.setattr(settings, "vision_figure_budget_seconds", 240.0)
    slept: list[float] = []
    monkeypatch.setattr("app.job_cancel.sleep", slept.append)
    seen: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if len(seen) == 1:
            return httpx.Response(429, headers={"Retry-After": "7"})
        return httpx.Response(200, json=_ok_body())

    assert _client_with(handler).describe_figure(b"x", "image/png") is not None
    assert slept == [7.0] and len(seen) == 2

    seen.clear()
    slept.clear()

    def always_429(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(429, headers={"Retry-After": "500"})

    with pytest.raises(httpx.HTTPStatusError):
        _client_with(always_429).describe_figure(b"x", "image/png")
    assert len(seen) == 1 and slept == []


def test_a_server_error_is_not_retried_when_too_little_budget_is_left(monkeypatch) -> None:
    monkeypatch.setattr(settings, "vision_figure_budget_seconds", 5.0)
    seen: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(502, text="empty completion")

    client = _client_with(handler)
    client._retry_pause_seconds = 0
    with pytest.raises(httpx.HTTPStatusError):
        client.describe_figure(b"x", "image/png")
    assert len(seen) == 1


# --- a cancelled run stops its figure call, in flight or not yet sent ------------------------------------------------

def test_a_cancelled_run_never_sends_the_figure_call() -> None:
    from app import job_cancel

    seen: list = []
    client = _client_with(lambda request: seen.append(request) or httpx.Response(200, json=_ok_body()))
    with job_cancel.cancellation_scope() as token:
        token.cancel()
        with pytest.raises(job_cancel.JobCancelled):
            client.describe_figure(b"x", "image/png")
    assert seen == []


def test_cancelling_while_the_call_is_in_flight_stops_it_within_a_moment() -> None:
    """A real local server that answers only after 10 s: cancelling the run must end the call promptly and the server must
    see the connection close (so a backend that serves one request at a time is not kept busy for nobody)."""
    import threading
    import time
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    from app import job_cancel

    state = {"started": threading.Event(), "closed": threading.Event()}

    class Slow(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            state["started"].set()
            for _ in range(100):
                time.sleep(0.1)
                try:
                    self.wfile.write(b"")
                    self.connection.setblocking(False)
                    if self.connection.recv(1, 2) == b"":  # MSG_PEEK: the peer closed the connection
                        state["closed"].set()
                        return
                except BlockingIOError:
                    pass
                except OSError:
                    state["closed"].set()
                    return

        def log_message(self, *args) -> None:  # silence
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Slow)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        client = OrchestratorVisionClient(base_url=f"http://127.0.0.1:{server.server_address[1]}", bearer_token="t")
        outcome: dict = {}

        def run() -> None:
            with job_cancel.cancellation_scope() as token:
                outcome["token"] = token
                try:
                    client.describe_figure(b"x", "image/png")
                except BaseException as exc:  # noqa: BLE001
                    outcome["error"] = exc

        worker = threading.Thread(target=run, daemon=True)
        started = time.monotonic()
        worker.start()
        assert state["started"].wait(5)
        outcome["token"].cancel()
        worker.join(5)
        assert not worker.is_alive(), "the call kept running after the run was cancelled"
        assert time.monotonic() - started < 4
        assert isinstance(outcome["error"], job_cancel.JobCancelled)
        assert state["closed"].wait(3), "the server never saw the connection close"
    finally:
        server.shutdown()


# --- review follow-ups: the kill switch is the old behaviour exactly, a back-off can be cancelled -----------------------

def test_with_the_budget_off_a_429_waits_the_old_fixed_pause_whatever_retry_after_says(monkeypatch) -> None:
    monkeypatch.setattr(settings, "vision_figure_budget_seconds", 0.0)
    slept: list[float] = []
    monkeypatch.setattr("app.job_cancel.sleep", slept.append)
    seen: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if len(seen) == 1:
            return httpx.Response(429, headers={"Retry-After": "3600"})
        return httpx.Response(200, json=_ok_body())

    client = _client_with(handler)
    assert client.describe_figure(b"x", "image/png") is not None
    assert slept == [client._retry_pause_seconds]


def test_a_retry_after_longer_than_a_figure_is_worth_waiting_gives_up_even_with_a_large_budget(monkeypatch) -> None:
    monkeypatch.setattr(settings, "vision_figure_budget_seconds", 10_000.0)
    slept: list[float] = []
    monkeypatch.setattr("app.job_cancel.sleep", slept.append)
    seen: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(429, headers={"Retry-After": "900"})

    with pytest.raises(httpx.HTTPStatusError):
        _client_with(handler).describe_figure(b"x", "image/png")
    assert len(seen) == 1 and slept == []


def test_cancelling_during_a_back_off_wait_ends_the_wait_at_once() -> None:
    import threading
    import time

    from app import job_cancel

    state: dict = {}

    def run() -> None:
        with job_cancel.cancellation_scope() as token:
            state["token"] = token
            client = _client_with(lambda request: httpx.Response(429, headers={"Retry-After": "15"}))
            try:
                client.describe_figure(b"x", "image/png")
            except BaseException as exc:  # noqa: BLE001
                state["error"] = exc

    worker = threading.Thread(target=run, daemon=True)
    started = time.monotonic()
    worker.start()
    while "token" not in state:
        time.sleep(0.01)
    time.sleep(0.4)  # inside the 15 s wait
    state["token"].cancel()
    worker.join(3)
    assert not worker.is_alive(), "the back-off wait could not be cancelled"
    assert time.monotonic() - started < 3
    assert isinstance(state["error"], job_cancel.JobCancelled)


def test_a_retry_needs_at_least_as_much_budget_as_the_orchestrator_will_still_spend_on_an_attempt(monkeypatch) -> None:
    # The orchestrator starts no new attempt with less than 20 s left (MIN_ATTEMPT_MS), so a retry sent with a 10-20 s
    # deadline would be doomed.
    monkeypatch.setattr(settings, "vision_figure_budget_seconds", 18.0)
    seen: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(502, text="empty completion")

    client = _client_with(handler)
    client._retry_pause_seconds = 0
    with pytest.raises(httpx.HTTPStatusError):
        client.describe_figure(b"x", "image/png")
    assert len(seen) == 1


# --- an unusable reply says why, in the log (it used to be silent) ------------------------------------------------------

def test_an_unparseable_reply_is_logged_with_its_reason_and_size_but_never_its_text(caplog) -> None:
    import logging

    from app.vision.orchestrator_vision_client import _parse_figure_response

    with caplog.at_level(logging.WARNING, logger="app.vision.orchestrator_vision_client"):
        assert _parse_figure_response('{"significant": tr') is None
    line = " ".join(r.getMessage() for r in caplog.records)
    assert "unparseable" in line and "18 chars" in line
    assert "significant" not in line  # counts only, never the model's text


def test_a_significant_verdict_with_a_blank_description_is_logged_as_such(caplog) -> None:
    import logging

    from app.vision.orchestrator_vision_client import _parse_figure_response

    with caplog.at_level(logging.WARNING, logger="app.vision.orchestrator_vision_client"):
        assert _parse_figure_response('{"significant": true, "description": "   "}') is None
    assert "blank_description" in " ".join(r.getMessage() for r in caplog.records)


def test_a_good_reply_logs_nothing_at_warning(caplog) -> None:
    import logging

    from app.vision.orchestrator_vision_client import _parse_figure_response

    with caplog.at_level(logging.WARNING, logger="app.vision.orchestrator_vision_client"):
        assert _parse_figure_response('{"significant": true, "description": "A diagram."}') is not None
    assert caplog.records == []


def _client_replying(payload: dict) -> OrchestratorVisionClient:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"description": json.dumps(payload)})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)
    return client


def test_the_models_reason_for_not_significant_is_kept_short_and_plain() -> None:
    result = _client_replying({"significant": False, "description": "", "reason": "  A company logo, no technical content.  "}).describe_figure(b"x")
    assert result == FigureVisionResult(significant=False, description="", reason="A company logo, no technical content.")
    long_reason = _client_replying({"significant": False, "description": "", "reason": "word " * 100}).describe_figure(b"x")
    assert long_reason is not None and long_reason.reason is not None and len(long_reason.reason) <= 140


def test_a_missing_or_malformed_reason_is_none_not_an_error() -> None:
    for reason in (None, 5, "   ", ["a"]):
        result = _client_replying({"significant": False, "description": "", "reason": reason}).describe_figure(b"x")
        assert result is not None and result.reason is None
    assert _client_replying({"significant": False, "description": ""}).describe_figure(b"x").reason is None


def test_a_significant_figure_carries_no_reason() -> None:
    result = _client_replying({"significant": True, "description": "A block diagram.", "reason": "should be ignored"}).describe_figure(b"x")
    assert result is not None and result.reason is None


def test_the_request_asks_for_the_reason_in_the_schema_and_the_prompt() -> None:
    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"description": json.dumps({"significant": False, "description": ""})})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)
    client.describe_figure(b"x")
    schema = bodies[0]["responseSchema"]["schema"]
    assert "reason" in schema["properties"] and "reason" not in schema["required"]
    assert "why" in bodies[0]["prompt"].lower()


def test_the_prompt_and_schema_say_a_table_chart_or_screenshot_of_values_is_significant() -> None:
    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"description": json.dumps({"significant": True, "description": "A table."})})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)
    client.describe_figure(b"x")
    prompt = bodies[0]["prompt"].lower()
    assert "table" in prompt and "chart" in prompt and "screenshot" in prompt and "significant" in prompt
    definition = bodies[0]["responseSchema"]["schema"]["properties"]["significant"]["description"].lower()
    assert "table" in definition and "chart" in definition


def test_the_prompt_version_changes_with_the_prompt_so_old_verdicts_are_not_reused() -> None:
    from app.vision.orchestrator_vision_client import PROMPT_VERSION, _build_prompt

    assert PROMPT_VERSION and "table" in _build_prompt(None).lower()
