import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from jsonschema import Draft7Validator

from app.leveling.live_emitter import (
    MAX_QUEUED_FRAMES,
    LiveEmitter,
    clip_text,
    live_channel,
    live_latest_key,
    live_seq_key,
)

SCHEMA = json.loads(
    (
        Path(__file__).resolve().parents[2] / "shared" / "schemas" / "job-live.schema.json"
    ).read_text()
)
LIVE_FRAME = Draft7Validator(
    {
        "$schema": SCHEMA["$schema"],
        "definitions": SCHEMA["definitions"],
        "$ref": "#/definitions/LiveFrame",
    }
)


class FakeRedis:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.counters: dict[str, int] = {}
        self.published: list[tuple[str, dict]] = []
        self.hashes: dict[str, dict[str, str]] = {}
        self.expires: list[str] = []
        self.fail = False

    def incr(self, name: str) -> int:
        if self.fail:
            raise ConnectionError("redis is down")
        with self.lock:
            self.counters[name] = self.counters.get(name, 0) + 1
            return self.counters[name]

    def expire(self, name: str, time: int) -> None:
        self.expires.append(name)

    def hset(self, name: str, key: str, value: str) -> None:
        self.hashes.setdefault(name, {})[key] = value

    def publish(self, channel: str, message: str) -> None:
        with self.lock:
            self.published.append((channel, json.loads(message)))


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def frames(redis: FakeRedis) -> list[dict]:
    return [message for _, message in redis.published]


def make(**kwargs):  # noqa: ANN003, ANN202
    redis, clock = FakeRedis(), Clock()
    emitter = LiveEmitter(redis, "job-1", clock=clock, **kwargs)
    return emitter, redis, clock


# ---- text clipping --------------------------------------------------------

def test_clip_text_collapses_whitespace_and_strips_control_characters() -> None:
    messy = "  The BP\n\tshall \x00provide\x07 power.  "
    assert clip_text(messy, 100) == "The BP shall provide power."


def test_clip_text_returns_none_for_empty_or_blank_input() -> None:
    assert clip_text(None, 10) is None
    assert clip_text("", 10) is None
    assert clip_text(" \n\t ", 10) is None


def test_clip_text_cuts_at_a_word_boundary_with_an_ellipsis() -> None:
    clipped = clip_text("alpha beta gamma delta epsilon", 17)
    assert clipped == "alpha beta gamma…"
    assert len(clipped) <= 17


def test_clip_text_cuts_a_single_long_word_hard() -> None:
    clipped = clip_text("x" * 50, 10)
    assert clipped == "x" * 9 + "…"


def test_clip_text_keeps_unicode_intact() -> None:
    assert clip_text("שלום 日本語", 50) == "שלום 日本語"


# ---- frame content ---------------------------------------------------------

def test_every_frame_kind_conforms_to_the_live_frame_schema() -> None:
    emitter, redis, clock = make(hz=1000, excerpt_max_chars=240)
    emitter.working_on(
        ref="s0.1", title="Power", item_type="Epic",
        excerpt="The BP shall provide power.", cursor=0.4,
    )
    emitter.writing(ref="s0.2", title="Limit ripple", item_type="Requirement", partial=True)
    emitter.item(ref="s0.2", title="Limit ripple to 50 mV", item_type="Requirement")
    emitter.compare(kind="conflict", a_ref="r1", a_text="Ripple is 50 mV.", b_ref="r2",
                    b_text="Ripple is 30 mV.", similarity=0.93)
    emitter.ocr_page(page=3, pages=48, excerpt="Recognised text of page three.")
    emitter.reset(lane=1)
    emitter.flush()
    kinds = {f["kind"] for f in frames(redis)}
    assert kinds == {"working_on", "writing", "item", "compare", "ocr_page", "reset"}
    for frame in frames(redis):
        errors = [e.message for e in LIVE_FRAME.iter_errors(frame)]
        assert not errors, (frame, errors)


def test_text_fields_are_capped_before_sending() -> None:
    emitter, redis, _ = make(hz=1000, excerpt_max_chars=50)
    emitter.working_on(title="t" * 500, excerpt="word " * 400, cursor=7)
    emitter.compare(
        kind="duplicate", a_ref="a", a_text="x" * 900, b_ref="b", b_text="y", similarity=2,
    )
    emitter.flush()
    working, compare = frames(redis)
    assert len(working["title"]) <= 200
    assert len(working["excerpt"]) <= 50
    assert working["cursor"] == 1.0
    assert len(compare["compare"]["a"]["text"]) <= 400
    assert compare["compare"]["similarity"] == 1.0


def test_excerpt_limit_never_exceeds_the_schema_cap() -> None:
    emitter, redis, _ = make(hz=1000, excerpt_max_chars=999_999)
    emitter.working_on(excerpt="w " * 2000)
    emitter.flush()
    assert len(frames(redis)[0]["excerpt"]) <= 1000


def test_frames_go_to_the_live_channel_and_the_latest_per_lane_is_kept() -> None:
    emitter, redis, _ = make(hz=1000)
    emitter.working_on(lane=0, title="first")
    emitter.working_on(lane=1, title="other lane")
    emitter.working_on(lane=0, title="second")
    emitter.flush()
    assert {channel for channel, _ in redis.published} == {live_channel("job-1")}
    latest = redis.hashes[live_latest_key("job-1")]
    assert json.loads(latest["0"])["title"] == "second"
    assert json.loads(latest["1"])["title"] == "other lane"
    assert live_seq_key("job-1") in redis.expires


# ---- rate limiting and coalescing -----------------------------------------

def test_coalesced_frames_are_rate_limited_and_only_the_latest_survives() -> None:
    emitter, redis, clock = make(hz=4)
    for i in range(10):
        emitter.writing(title=f"title {i}")
    assert len(redis.published) == 4  # one second's burst, the rest are waiting
    clock.now += 0.25
    emitter.writing(title="title 10")
    assert len(redis.published) == 5
    assert frames(redis)[-1]["title"] == "title 10"


def test_the_waiting_frame_is_sent_on_flush() -> None:
    emitter, redis, _ = make(hz=1)
    emitter.writing(title="a")
    emitter.writing(title="b")  # waits: the bucket is empty
    assert [f["title"] for f in frames(redis)] == ["a"]
    emitter.flush()
    assert [f["title"] for f in frames(redis)] == ["a", "b"]


def test_items_are_never_dropped_and_keep_their_order_under_the_rate_limit() -> None:
    emitter, redis, _ = make(hz=4)
    for i in range(20):
        emitter.item(ref=f"r{i}", title=f"item {i}")
    assert len(redis.published) == 4
    emitter.flush()
    assert [f["ref"] for f in frames(redis)] == [f"r{i}" for i in range(20)]


def test_queue_overflow_drops_the_oldest_items() -> None:
    emitter, redis, _ = make(hz=1, max_queue=5)
    for i in range(12):
        emitter.item(ref=f"r{i}", title="x")
    emitter.flush()
    refs = [f["ref"] for f in frames(redis)]
    assert refs[0] == "r0"  # the one sent immediately
    assert refs[-1] == "r11"
    assert len(refs) == 1 + 5


def test_flush_sends_every_queued_item_however_fast_they_finished() -> None:
    from app.leveling.live_emitter import live_done_key

    emitter, redis, _ = make(hz=1)
    for i in range(200):
        emitter.item(ref=f"r{i}", title="x")
    assert len(redis.published) == 1  # the rate limit let one through
    emitter.flush()
    refs = [f["ref"] for f in frames(redis)]
    assert refs == [f"r{i}" for i in range(200)]
    # ...and the finished-items hash a reloaded page reads has all of them too.
    assert set(redis.hashes[live_done_key("job-1")]) == {f"r{i}" for i in range(200)}


def test_the_default_queue_holds_as_many_items_as_the_map_can_describe() -> None:
    assert MAX_QUEUED_FRAMES >= 5000


def test_reset_discards_an_unsent_frame_for_that_lane_and_announces_itself() -> None:
    emitter, redis, _ = make(hz=1)
    emitter.writing(lane=3, title="sent")
    emitter.writing(lane=3, title="stale, still waiting")
    emitter.reset(lane=3)
    emitter.flush()
    kinds = [(f["kind"], f.get("title")) for f in frames(redis)]
    assert ("writing", "stale, still waiting") not in kinds
    assert kinds[-1][0] == "reset"


# ---- ordering and concurrency ---------------------------------------------

def test_sequence_numbers_increase_across_frames() -> None:
    emitter, redis, _ = make(hz=1000)
    for i in range(5):
        emitter.item(ref=f"r{i}", title="x")
    assert [f["seq"] for f in frames(redis)] == [1, 2, 3, 4, 5]


def test_concurrent_lanes_never_share_or_lose_a_sequence_number() -> None:
    emitter, redis, _ = make(hz=100_000, max_queue=5000)

    def worker(lane: int) -> None:
        for i in range(50):
            emitter.item(lane=lane, ref=f"l{lane}-{i}", title="x")

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(worker, range(8)))
    emitter.flush()
    seqs = [f["seq"] for f in frames(redis)]
    assert len(seqs) == 400
    assert sorted(seqs) == list(range(1, 401))
    for lane in range(8):
        lane_refs = [f["ref"] for f in frames(redis) if f["lane"] == lane]
        assert lane_refs == [f"l{lane}-{i}" for i in range(50)]


# ---- failure handling ------------------------------------------------------

def test_a_redis_outage_never_raises_and_recovers_afterwards() -> None:
    emitter, redis, _ = make(hz=1000)
    redis.fail = True
    emitter.item(ref="lost", title="x")
    emitter.working_on(title="lost too")
    emitter.reset()
    emitter.flush()
    assert redis.published == []
    redis.fail = False
    emitter.item(ref="kept", title="x")
    assert [f["ref"] for f in frames(redis)] == ["kept"]


def test_a_malformed_call_never_raises() -> None:
    emitter, redis, _ = make(hz=1000)
    emitter.compare(
        kind="conflict", a_ref="a", a_text="x", b_ref="b", b_text="y",
        similarity="not a number",  # type: ignore[arg-type]
    )
    emitter.flush()


def test_finished_items_are_remembered_for_a_page_opened_mid_run() -> None:
    from app.leveling.live_emitter import live_done_key

    redis = FakeRedis()
    emitter = LiveEmitter(redis, "job-1", hz=100)
    emitter.item(lane=0, ref="det0_1_1", title="One")
    emitter.item(lane=1, ref="det0_1_2", title="Two")
    emitter.working_on(lane=0, ref="det0_1_3")
    emitter.compare(kind="conflict", a_ref="a", a_text="x", b_ref="b", b_text="y", similarity=0.5)
    emitter.flush()
    done = redis.hashes[live_done_key("job-1")]
    assert set(done) == {"det0_1_1", "det0_1_2"}
    assert live_done_key("job-1") in redis.expires
