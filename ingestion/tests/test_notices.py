from __future__ import annotations

import json

from app.leveling import live_context
from app.leveling.live_context import live_emitter_scope, notice
from app.logging_context import job_id_scope
from app.leveling.notices import NoticePublisher, notices_log_key


class FakeRedis:
    def __init__(self) -> None:
        self.lists: dict[str, list[str]] = {}
        self.published: list[tuple[str, str]] = []
        self.hashes: dict[str, dict[str, str]] = {}
        self.counter = 0

    def rpush(self, name, *values):
        self.lists.setdefault(name, []).extend(values)

    def ltrim(self, name, start, end):
        self.lists[name] = self.lists[name][start:] if start < 0 else self.lists[name][start : end + 1]

    def expire(self, name, time):
        return True

    def publish(self, channel, message):
        self.published.append((channel, message))

    def hset(self, name, key, value):
        self.hashes.setdefault(name, {})[key] = value

    def incr(self, name):
        self.counter += 1
        return self.counter


def test_publishes_on_main_channel_and_replay_list() -> None:
    redis = FakeRedis()
    publisher = NoticePublisher(redis, "j1")
    assert publisher.publish("output_limit_reached", "warning", step="analyze", lastRef="det0_1")
    channel, body = redis.published[0]
    assert channel == "job-events:j1"
    payload = json.loads(body)
    assert payload["type"] == "notice" and payload["kind"] == "output_limit_reached"
    assert payload["severity"] == "warning" and payload["facts"] == {"step": "analyze", "lastRef": "det0_1"}
    assert redis.lists[notices_log_key("j1")] == [body]


def test_repeats_are_rate_limited_by_count() -> None:
    redis = FakeRedis()
    publisher = NoticePublisher(redis, "j1")
    sent = [publisher.publish("server_retry", status=503) for _ in range(12)]
    assert [i + 1 for i, ok in enumerate(sent) if ok] == [1, 2, 3, 5, 10]
    assert json.loads(redis.published[-1][1])["count"] == 10


def test_once_key_publishes_once_per_key() -> None:
    publisher = NoticePublisher(FakeRedis(), "j1")
    assert publisher.publish("context_assumed", once_key="m1", tokens=28000)
    assert not publisher.publish("context_assumed", once_key="m1", tokens=28000)
    assert publisher.publish("context_assumed", once_key="m2", tokens=28000)


def test_unknown_kind_and_severity_are_ignored() -> None:
    redis = FakeRedis()
    publisher = NoticePublisher(redis, "j1")
    assert not publisher.publish("made_up")
    assert not publisher.publish("server_retry", "fatal")
    assert redis.published == []


def test_facts_carry_no_free_text() -> None:
    redis = FakeRedis()
    NoticePublisher(redis, "j1").publish("stream_fallback", reason="x" * 100, doc={"a": 1}, items=[1])
    facts = json.loads(redis.published[0][1])["facts"]
    assert facts == {"reason": "x" * 40}


def test_redis_failure_never_raises() -> None:
    class Broken(FakeRedis):
        def rpush(self, *a, **k):
            raise ConnectionError("down")

    assert NoticePublisher(Broken(), "j1").publish("server_retry") is False


def test_helper_is_noop_without_a_job_scope() -> None:
    notice("server_retry")  # no job in scope: nothing to assert but no error


def test_helper_in_scope_adds_last_item_ref(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(live_context.settings, "live_progress", True)
    redis = FakeRedis()
    with job_id_scope("j9"), live_emitter_scope("j9", redis) as emitter:
        emitter.item(ref="det0_3", title="t")
        notice("output_limit_reached", "warning", with_last_item=True, step="write")
    notices = [json.loads(b) for c, b in redis.published if c == "job-events:j9"]
    assert notices and notices[0]["facts"] == {"step": "write", "lastRef": "det0_3"}
    assert live_context._NOTICES == {}


def test_helper_is_silent_with_live_progress_off(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(live_context.settings, "live_progress", False)
    redis = FakeRedis()
    with job_id_scope("j9"), live_emitter_scope("j9", redis):
        notice("server_retry")
    assert redis.published == []


def _client(handler):  # noqa: ANN001, ANN202
    import httpx

    from app.survey.orchestrator_llm_client import OrchestratorLlmClient

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="t")
    client._transport = httpx.MockTransport(handler)
    return client


def test_client_reports_retry_and_output_limit(monkeypatch) -> None:  # noqa: ANN001
    import httpx

    from app.survey import orchestrator_llm_client as module

    monkeypatch.setattr(live_context.settings, "live_progress", True)
    monkeypatch.setattr(module.time, "sleep", lambda _s: None)
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(503, json={"error": "busy"})
        return httpx.Response(200, json={"content": json.dumps({"nodes": []}), "finishReason": "length"})

    redis = FakeRedis()
    with job_id_scope("j5"), live_emitter_scope("j5", redis):
        _client(handler).analyze_section("Some section text.")
    kinds = [(json.loads(b)["kind"], json.loads(b)["facts"]) for c, b in redis.published if c == "job-events:j5"]
    assert ("server_retry", {"status": 503}) in kinds
    assert ("output_limit_reached", {"step": "analyze"}) in kinds


def test_client_is_silent_without_live_progress(monkeypatch) -> None:  # noqa: ANN001
    import httpx

    monkeypatch.setattr(live_context.settings, "live_progress", False)
    redis = FakeRedis()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"content": json.dumps({"nodes": []}), "finishReason": "length"})

    with job_id_scope("j5"), live_emitter_scope("j5", redis):
        _client(handler).analyze_section("Some section text.")
    assert redis.published == []
