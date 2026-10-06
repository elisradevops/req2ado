import json
import threading

import httpx
import pytest

from app.leveling.bounded_chunks import run_chunks_bounded
from app.leveling.live_context import live_emitter_scope
from app.leveling.live_stream import DraftingDisplay
from app.logging_context import current_job_id, job_id_scope
from app.survey import orchestrator_llm_client as client_module
from app.survey.orchestrator_llm_client import OrchestratorLlmClient

JOB = "job-stream"
ROWS = {"r1": "Size: 3U 1 inch", "r2": "Over-current protection", "r3": "Operating temperature"}
RESULT = {
    "r1": {"title": "Chassis size", "tags": ["physical"]},
    "r2": {"title": "Over-current protection", "tags": ["safety"]},
    "r3": {"title": "Operating temperature range", "tags": ["environmental"]},
}


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

    def frames(self) -> list[dict]:
        return [json.loads(m) for c, m in self.published if c.endswith(":live")]


def _ndjson(text: str, *, pieces: int = 5, done: dict | None = None) -> bytes:
    step = max(1, len(text) // pieces)
    lines = [json.dumps({"delta": text[i : i + step]}) for i in range(0, len(text), step)]
    if done is not None:
        lines.append(json.dumps(done))
    return ("\n".join(lines) + "\n").encode()


class Server:
    """Routes the two endpoints; records what was asked."""

    def __init__(self, content: str, *, stream: bytes | Exception | int | None = None) -> None:
        self.content = content
        finished = {"done": True, "finishReason": "stop"}
        self.stream = stream if stream is not None else _ndjson(content, done=finished)
        self.requests: list[tuple[str, dict]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.requests.append((request.url.path, body))
        if request.url.path == "/llm/chat":
            return httpx.Response(200, json={"content": self.content})
        assert request.url.path == "/llm/chat/stream"
        if isinstance(self.stream, int):
            return httpx.Response(self.stream, json={"message": "no"})
        if isinstance(self.stream, Exception):
            exc = self.stream

            def broken():  # noqa: ANN202
                yield json.dumps({"delta": '{"r1": {"title": "Chas'}).encode() + b"\n"
                raise exc

            return httpx.Response(200, content=broken())
        return httpx.Response(200, content=self.stream)

    def paths(self) -> list[str]:
        return [p for p, _ in self.requests]


@pytest.fixture
def live(monkeypatch):  # noqa: ANN001, ANN201
    monkeypatch.setattr(client_module.settings, "live_progress", True)
    monkeypatch.setattr(client_module.settings, "llm_stream_drafting", True)
    # live_context reads the same settings object
    redis = FakeRedis()
    return redis


def _client(server: Server) -> OrchestratorLlmClient:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="t")
    client._transport = httpx.MockTransport(server)
    return client


def _run(client: OrchestratorLlmClient, redis: FakeRedis | None, *, scope: bool = True):  # noqa: ANN202
    if not scope:
        return client.title_and_tags_for_rows(dict(ROWS), user_id="u1")
    with job_id_scope(JOB), live_emitter_scope(JOB, redis):
        return client.title_and_tags_for_rows(dict(ROWS), user_id="u1")


def test_streamed_call_returns_exactly_what_the_plain_call_returns(live) -> None:  # noqa: ANN001
    content = json.dumps(RESULT)
    streamed_server = Server(content)
    streamed = _run(_client(streamed_server), live)
    assert streamed_server.paths() == ["/llm/chat/stream"]

    plain_server = Server(content)
    client_module.settings.llm_stream_drafting = False
    plain = _run(_client(plain_server), live)
    assert plain_server.paths() == ["/llm/chat"]
    assert streamed == plain == RESULT


def test_streamed_text_goes_through_the_same_tolerant_parse(live) -> None:  # noqa: ANN001
    # A fenced answer with the known one-missing-brace defect: the plain path
    # repairs it, so the streamed path must give the same value.
    content = "```json\n" + json.dumps(RESULT)[:-1] + "\n```"
    streamed = _run(_client(Server(content)), live)
    client_module.settings.llm_stream_drafting = False
    plain = _run(_client(Server(content)), live)
    assert streamed == plain
    assert set(streamed) == set(RESULT)


def test_a_length_cut_off_is_parsed_like_the_plain_call_does(live) -> None:  # noqa: ANN001
    content = json.dumps(RESULT)[:-30]
    cut = Server(content, stream=_ndjson(content, done={"done": True, "finishReason": "length"}))
    try:
        streamed = _run(_client(cut), live)
    except ValueError as exc:
        streamed = ("error", str(exc))
    client_module.settings.llm_stream_drafting = False
    try:
        plain = _run(_client(Server(content)), live)
    except ValueError as exc:
        plain = ("error", str(exc))
    assert streamed == plain


def test_the_streamed_request_is_the_plain_request_plus_the_done_flag(live) -> None:  # noqa: ANN001
    content = json.dumps(RESULT)
    streamed_server = Server(content)
    _run(_client(streamed_server), live)
    client_module.settings.llm_stream_drafting = False
    plain_server = Server(content)
    _run(_client(plain_server), live)

    streamed_body = streamed_server.requests[0][1]
    plain_body = plain_server.requests[0][1]
    assert streamed_body.pop("includeDone") is True
    assert streamed_body == plain_body


def test_live_frames_show_the_rows_being_worked_on_and_each_finished_item(live) -> None:  # noqa: ANN001
    _run(_client(Server(json.dumps(RESULT))), live)
    frames = live.frames()
    kinds = [f["kind"] for f in frames]
    assert [f["ref"] for f in frames if f["kind"] == "item"] == ["r1", "r2", "r3"]
    assert [f["title"] for f in frames if f["kind"] == "item"] == [
        "Chassis size", "Over-current protection", "Operating temperature range",
    ]
    working = [f for f in frames if f["kind"] == "working_on"]
    assert working and working[0]["ref"] == "r1" and working[0]["excerpt"] == ROWS["r1"]
    assert kinds[-1] == "reset"
    assert {f["lane"] for f in frames} == {0}


def test_flags_off_or_no_emitter_means_the_plain_call_and_no_frames(live, monkeypatch) -> None:  # noqa: ANN001
    content = json.dumps(RESULT)
    # Live progress on, streaming off.
    monkeypatch.setattr(client_module.settings, "llm_stream_drafting", False)
    server = Server(content)
    assert _run(_client(server), live) == RESULT
    assert server.paths() == ["/llm/chat"] and live.frames() == []
    # Streaming on, live progress off (no emitter exists).
    monkeypatch.setattr(client_module.settings, "llm_stream_drafting", True)
    monkeypatch.setattr(client_module.settings, "live_progress", False)
    server = Server(content)
    assert _run(_client(server), live) == RESULT
    assert server.paths() == ["/llm/chat"]
    # Both on but no job in scope.
    monkeypatch.setattr(client_module.settings, "live_progress", True)
    server = Server(content)
    assert _run(_client(server), live, scope=False) == RESULT
    assert server.paths() == ["/llm/chat"]


def test_a_refusal_before_any_output_falls_back_to_the_plain_call(live) -> None:  # noqa: ANN001
    server = Server(json.dumps(RESULT), stream=502)
    assert _run(_client(server), live) == RESULT
    assert server.paths() == ["/llm/chat/stream", "/llm/chat"]
    # The first row was shown while connecting, then the lane was cleared; nothing was written.
    assert [f["kind"] for f in live.frames()] == ["working_on", "reset"]


def test_a_stream_that_breaks_part_way_clears_the_lane_and_retries_plainly(live) -> None:  # noqa: ANN001
    server = Server(json.dumps(RESULT), stream=httpx.ReadError("connection reset"))
    assert _run(_client(server), live) == RESULT
    assert server.paths() == ["/llm/chat/stream", "/llm/chat"]
    kinds = [f["kind"] for f in live.frames()]
    assert kinds.count("reset") >= 2  # one for the broken stream, one when the call ends
    assert "item" not in kinds


def test_a_stream_without_the_terminal_line_is_not_trusted(live) -> None:  # noqa: ANN001
    content = json.dumps(RESULT)
    server = Server(content, stream=_ndjson(content))  # no done line
    assert _run(_client(server), live) == RESULT
    assert server.paths() == ["/llm/chat/stream", "/llm/chat"]


def test_a_malformed_stream_line_falls_back_instead_of_failing_the_job(live) -> None:  # noqa: ANN001
    server = Server(json.dumps(RESULT), stream=b'{"delta": "{"}\nnot json at all\n')
    assert _run(_client(server), live) == RESULT
    assert server.paths() == ["/llm/chat/stream", "/llm/chat"]


def test_the_other_drafting_calls_stream_too(live) -> None:  # noqa: ANN001
    parents = {
        "p1": {"title": "Power", "requirement_titles": ["a"], "requirement_descriptions": ["b"]},
    }
    parent_result = {"p1": {"title": "Power supply", "description": "Powers the unit."}}
    server = Server(json.dumps(parent_result))
    with job_id_scope(JOB), live_emitter_scope(JOB, live):
        assert _client(server).summarize_parent_nodes(parents, user_id="u1") == parent_result
    assert server.paths() == ["/llm/chat/stream"]
    item = next(f for f in live.frames() if f["kind"] == "item")
    assert item["ref"] == "p1" and item["title"] == "Power supply"
    assert item["excerpt"] == "Powers the unit."

    items = {"s1": {"text": "Size: 3U", "context": "Hardware"}}
    synth_result = {"s1": {"title": "Size", "text": "The unit shall be 3U high.", "tags": []}}
    server = Server(json.dumps(synth_result))
    with job_id_scope(JOB), live_emitter_scope(JOB, live):
        assert _client(server).synthesize_leaf_requirements(items, user_id="u1") == synth_result
    assert server.paths() == ["/llm/chat/stream"]


def test_non_drafting_calls_are_never_streamed(live) -> None:  # noqa: ANN001
    server = Server(json.dumps({"verdict": "redundant"}))
    with job_id_scope(JOB), live_emitter_scope(JOB, live):
        _client(server).judge_duplicate_cluster({"a": "x", "b": "y"}, user_id="u1")
    assert server.paths() == ["/llm/chat"]


def test_concurrent_calls_get_their_own_lanes_and_give_them_back(live) -> None:  # noqa: ANN001
    with live_emitter_scope(JOB, live) as emitter:
        a, b = DraftingDisplay(emitter, ROWS), DraftingDisplay(emitter, ROWS)
        assert {a.lane, b.lane} == {0, 1}
        a.end()
        a.end()  # ending twice must not double-release
        c = DraftingDisplay(emitter, ROWS)
        assert c.lane == 0
        b.end()
        c.end()
        assert DraftingDisplay(emitter, ROWS).lane == 0


def test_worker_threads_see_the_job_only_when_live_progress_is_on(monkeypatch) -> None:  # noqa: ANN001
    def seen_job(_chunk):  # noqa: ANN001, ANN202
        return current_job_id()

    for flag, expected in ((True, JOB), (False, None)):
        monkeypatch.setattr(client_module.settings, "live_progress", flag)
        with job_id_scope(JOB):
            outcomes = list(run_chunks_bounded([1, 2, 3], seen_job, 2))
        assert [o.value for o in outcomes] == [expected] * 3


def test_streamed_items_move_the_pass_count_during_the_call(
    live, monkeypatch,  # noqa: ANN001
) -> None:
    # The counter's rate limit is out of the way: every observed item publishes.
    from app.leveling import live_context as lc
    from app.leveling.stage_units import StageCounter

    units: list[dict] = []
    original_publish = live.publish

    def capture(channel, message):  # noqa: ANN001, ANN202
        if channel.endswith(":units"):
            units.append(json.loads(message))
        original_publish(channel, message)

    monkeypatch.setattr(live, "publish", capture)
    with job_id_scope(JOB), live_emitter_scope(JOB, live):
        counter = lc.current_stage_counter()
        assert isinstance(counter, StageCounter)
        counter._min_interval = 0.0
        counter.plan({"improve": 3})
        client = _client(Server(json.dumps(RESULT)))
        assert client.title_and_tags_for_rows(dict(ROWS), user_id="u1") == RESULT
    improve = [u["done"] for u in units if u["stage"] == "improve"]
    assert improve[0] == 0
    assert 1 in improve and 2 in improve and improve[-1] == 3  # moved item by item
    assert improve == sorted(improve)
