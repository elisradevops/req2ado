"""Every model call of a job streams when live progress is on, so the screen can show how far a long call has got; the streamed call keeps
every safeguard of the plain one (the job's ledger headers, the call gate, the cancel, the budget stop), and a study call stays plain."""

import json
import threading
import time

import httpx
import pytest

from app.job_cancel import CancelToken, JobCancelled, LlmBudgetExceeded, cancellation_scope
from app.leveling.live_context import live_emitter_scope
from app.logging_context import job_id_scope
from app.prompts.assembly import DataBlock, build_call
from app.survey import orchestrator_llm_client as client_module
from app.survey.orchestrator_llm_client import OrchestratorLlmClient

JOB = "job-progress"
ANSWER = {"names": [{"group_id": "g0", "title": "Power"}]}


class FakeRedis:
    def __init__(self) -> None:
        self.published: list[tuple[str, str]] = []
        self._seq = 0
        self._lock = threading.Lock()

    def incr(self, name):  # noqa: ANN001, ANN201
        with self._lock:
            self._seq += 1
            return self._seq

    def expire(self, name, time):  # noqa: ANN001, ANN201
        return True

    def hset(self, name, key, value):  # noqa: ANN001, ANN201
        return 1

    def publish(self, channel, message):  # noqa: ANN001, ANN201
        with self._lock:
            self.published.append((channel, message))

    def progress(self) -> list[dict]:
        frames = [json.loads(m) for c, m in self.published if c.endswith(":live")]
        return [f for f in frames if f.get("kind") == "model_progress"]


def _ndjson(text: str, pieces: int = 4) -> bytes:
    step = max(1, len(text) // pieces)
    lines = [json.dumps({"delta": text[i : i + step]}) for i in range(0, len(text), step)]
    lines.append(json.dumps({"done": True, "finishReason": "stop"}))
    return ("\n".join(lines) + "\n").encode()


class Server:
    def __init__(self, *, stream_status: int = 200, stream_body: bytes | None = None, plain_delay: float = 0.0, on_stream=None) -> None:  # noqa: ANN001
        self.stream_status = stream_status
        self.stream_body = stream_body if stream_body is not None else _ndjson(json.dumps(ANSWER))
        self.plain_delay = plain_delay
        self.on_stream = on_stream
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path == "/llm/chat":
            time.sleep(self.plain_delay)
            return httpx.Response(200, json={"content": json.dumps(ANSWER)})
        if self.stream_status != 200:
            return httpx.Response(self.stream_status, text=f"refused {client_module._BUDGET_CODE}" if self.stream_status == 402 else "refused")
        if self.on_stream is not None:
            self.on_stream()
        return httpx.Response(200, content=self.stream_body)

    def paths(self) -> list[str]:
        return [r.url.path for r in self.requests]


@pytest.fixture
def live(monkeypatch):  # noqa: ANN001, ANN201
    monkeypatch.setattr(client_module.settings, "live_progress", True)
    monkeypatch.setattr(client_module.settings, "llm_stream_progress", True)
    monkeypatch.setattr(client_module, "_PROGRESS_EVERY_SECONDS", 0.0)
    return FakeRedis()


def _client(server: Server) -> OrchestratorLlmClient:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="t")
    client._transport = httpx.MockTransport(server)
    return client


def _call(client: OrchestratorLlmClient, redis: FakeRedis, *, budget_kind: str | None = None):  # noqa: ANN202
    call = build_call("name_root_groups", blocks=[DataBlock("source", json.dumps({"g0": ["a", "b"]}))])
    params = client._params(schema=None, budget_kind=budget_kind) if budget_kind else client._params(schema=None)
    with job_id_scope(JOB), live_emitter_scope(JOB, redis):
        return client._chat_json(call, params, user_id="u1")


def test_a_job_call_streams_and_reports_how_far_it_has_got(live) -> None:  # noqa: ANN001
    server = Server()
    assert _call(_client(server), live) == ANSWER
    assert server.paths() == ["/llm/chat/stream"]
    beats = live.progress()
    assert beats and beats[-1]["tokens"] > 0 and beats[-1]["prompt"].startswith("name_root_groups")


def test_the_streamed_call_names_its_job_and_stage_for_the_ledger(live) -> None:  # noqa: ANN001
    server = Server()
    _call(_client(server), live)
    headers = server.requests[0].headers
    assert headers["X-Req2Ado-Job-Id"] == JOB and headers["X-Req2Ado-Stage"]


def test_with_progress_streaming_off_the_call_is_plain(live, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(client_module.settings, "llm_stream_progress", False)
    server = Server()
    assert _call(_client(server), live) == ANSWER
    assert server.paths() == ["/llm/chat"]


def test_a_study_call_stays_plain(live) -> None:  # noqa: ANN001
    # A cut-off study answer is split by the plain path (StudyLengthCutoff); the stream does not do that.
    server = Server()
    _call(_client(server), live, budget_kind="study")
    assert server.paths() == ["/llm/chat"]


def test_a_plain_call_still_reports_that_it_is_working(live) -> None:  # noqa: ANN001
    server = Server(plain_delay=0.3)
    _call(_client(server), live, budget_kind="study")
    beats = live.progress()
    assert beats and beats[-1]["tokens"] is None and beats[-1]["elapsedS"] >= 0


def test_a_spent_budget_on_the_stream_stops_the_run_without_a_second_request(live) -> None:  # noqa: ANN001
    server = Server(stream_status=402)
    token = CancelToken()
    with cancellation_scope(token), pytest.raises(LlmBudgetExceeded):
        _call(_client(server), live)
    assert token.cancelled and server.paths() == ["/llm/chat/stream"]


def test_a_refusal_that_a_retry_cannot_change_is_raised_without_a_second_request(live) -> None:  # noqa: ANN001
    server = Server(stream_status=422)
    with pytest.raises(httpx.HTTPStatusError) as raised:
        _call(_client(server), live)
    assert raised.value.response.status_code == 422 and server.paths() == ["/llm/chat/stream"]


def test_a_cancel_during_the_stream_stops_the_call_and_sends_nothing_else(live) -> None:  # noqa: ANN001
    token = CancelToken()
    server = Server(on_stream=token.cancel)
    with cancellation_scope(token), pytest.raises(JobCancelled):
        _call(_client(server), live)
    assert server.paths() == ["/llm/chat/stream"]


def test_the_streamed_call_takes_the_call_gate(live, monkeypatch) -> None:  # noqa: ANN001
    entered: list[bool] = []
    real = client_module.gated

    def spy():  # noqa: ANN202
        entered.append(True)
        return real()

    monkeypatch.setattr(client_module, "gated", spy)
    _call(_client(Server()), live)
    assert entered
