import json
import threading

from app.leveling.stage_units import StageCounter, units_latest_key


class FakeRedis:
    def __init__(self) -> None:
        self.messages: list[dict] = []
        self.hashes: dict[str, dict[str, str]] = {}
        self._lock = threading.Lock()

    def publish(self, channel, message):  # noqa: ANN001, ANN201
        with self._lock:
            self.messages.append(json.loads(message))

    def hset(self, name, key, value):  # noqa: ANN001, ANN201
        self.hashes.setdefault(name, {})[key] = value

    def expire(self, name, time):  # noqa: ANN001, ANN201
        return True

    def last(self, stage: str) -> dict:
        return [m for m in self.messages if m["stage"] == stage][-1]


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def _counter(clock: Clock | None = None) -> tuple[StageCounter, FakeRedis, Clock]:
    redis, clock = FakeRedis(), clock or Clock()
    return StageCounter(redis, "job-1", clock=clock, min_interval=0.25), redis, clock


def test_plan_publishes_every_total_and_a_zero_total_is_complete_so_it_reads_as_skipped() -> None:
    counter, redis, _ = _counter()
    counter.plan({"draft": 0, "improve": 36, "summarize": 12})
    assert (redis.last("draft")["total"], redis.last("draft")["complete"]) == (0, True)
    assert (redis.last("improve")["done"], redis.last("improve")["total"]) == (0, 36)
    assert redis.last("improve")["complete"] is False
    assert redis.last("summarize")["unit"] == "items"


def test_advance_adds_finished_items_across_chunks_and_subtrees() -> None:
    counter, redis, _ = _counter()
    counter.plan({"improve": 300})
    counter.advance("improve", 150)
    counter.advance("improve", 100)
    assert redis.last("improve")["done"] == 250


def test_in_flight_items_move_the_count_until_the_finished_chunk_replaces_them() -> None:
    counter, redis, clock = _counter()
    counter.plan({"improve": 36})
    clock.now = 1.0
    counter.in_flight("improve", 0, 12)
    assert redis.last("improve")["done"] == 12
    clock.now = 2.0
    counter.in_flight("improve", 0, 30)
    assert redis.last("improve")["done"] == 30
    counter.clear_in_flight("improve", 0)
    counter.advance("improve", 36)
    assert redis.last("improve")["done"] == 36


def test_concurrent_calls_add_up_and_the_count_never_goes_backwards() -> None:
    counter, redis, clock = _counter()
    counter.plan({"improve": 100})
    clock.now = 1.0
    counter.in_flight("improve", "a", 20)
    clock.now = 2.0
    counter.in_flight("improve", "b", 15)
    assert redis.last("improve")["done"] == 35
    # A call ends before its chunk is merged: the running count drops but the
    # reported count must not.
    counter.clear_in_flight("improve", "a")
    clock.now = 3.0
    counter.in_flight("improve", "b", 16)
    assert redis.last("improve")["done"] == 35
    counter.advance("improve", 50)
    assert redis.last("improve")["done"] == 66
    dones = [m["done"] for m in redis.messages if m["stage"] == "improve"]
    assert dones == sorted(dones)


def test_in_flight_updates_are_rate_limited_but_finished_work_is_not() -> None:
    counter, redis, clock = _counter()
    counter.plan({"draft": 50})
    before = len(redis.messages)
    clock.now = 1.0
    for n in range(1, 11):
        counter.in_flight("draft", 0, n)  # ten updates inside one interval
    assert len(redis.messages) - before == 1
    counter.advance("draft", 10)
    assert len(redis.messages) - before == 2


def test_done_is_capped_at_the_total_and_complete_means_fully_done() -> None:
    counter, redis, _ = _counter()
    counter.plan({"summarize": 12})
    counter.advance("summarize", 99)
    assert redis.last("summarize")["done"] == 12
    counter2, redis2, _ = _counter()
    counter2.plan({"improve": 36})
    counter2.advance("improve", 30)  # the plan was an estimate; the pass is over
    counter2.complete("improve")
    last = redis2.last("improve")
    assert (last["done"], last["total"], last["complete"]) == (36, 36, True)


def test_set_total_corrects_an_estimate_with_the_exact_count() -> None:
    counter, redis, _ = _counter()
    counter.plan({"summarize": 10})
    counter.set_total("summarize", 12)
    assert redis.last("summarize")["total"] == 12
    counter.set_total("summarize", 0)
    assert redis.last("summarize")["complete"] is True


def test_a_stage_that_was_never_planned_publishes_nothing() -> None:
    counter, redis, _ = _counter()
    counter.advance("improve", 5)
    counter.in_flight("improve", 0, 3)
    assert redis.messages == []


def test_latest_snapshot_keeps_one_field_per_stage_and_a_redis_failure_is_swallowed() -> None:
    counter, redis, _ = _counter()
    counter.plan({"improve": 4, "draft": 2})
    assert set(redis.hashes[units_latest_key("job-1")]) == {"improve", "draft"}

    class Broken(FakeRedis):
        def publish(self, channel, message):  # noqa: ANN001, ANN201
            raise ConnectionError("redis down")

    StageCounter(Broken(), "job-2").plan({"improve": 4})  # must not raise
