import logging
import random
import threading

import pytest

from app.job_cancel import CancelToken, JobCancelled, cancellation_scope
from app.leveling import llm_lease_limiter as limiter_module
from app.leveling.llm_lease_limiter import _PROBE_SCRIPT, _RELEASE_SCRIPT, LeaseLimiter
from app.request_identity import user_scope

SCOPE = user_scope("Microsoft.Identity;distinctive-user@example.com")
OTHER_SCOPE = user_scope("Microsoft.Identity;another-user@example.com")


class _FakeRedis:
    """In-memory stand-in for redis-py: SET honours NX (True, or None when the key exists) and records its PX; eval runs the release script."""

    def __init__(self) -> None:
        self.data: dict[str, str] = {}
        self.pxs: list[tuple[str, int | None]] = []
        self.lock = threading.Lock()
        self.probes = 0

    def get(self, key):
        with self.lock:
            return self.data.get(key)

    def set(self, key, value, px=None, nx=False):
        with self.lock:
            self.pxs.append((key, px))
            if nx and key in self.data:
                return None
            self.data[key] = value
            return True

    def eval(self, script, numkeys, key=None, token=None):
        if script == _PROBE_SCRIPT:
            assert numkeys == 0
            self.probes += 1
            return 1
        assert script == _RELEASE_SCRIPT and numkeys == 1
        with self.lock:
            if self.data.get(key) == token:
                del self.data[key]
                return 1
            return 0

    def expire_all(self) -> None:
        with self.lock:
            self.data.clear()

    def keys(self, prefix: str = "") -> list[str]:
        with self.lock:
            return [k for k in self.data if k.startswith(prefix)]


class _DownRedis:
    def __init__(self) -> None:
        self.calls = 0

    def _boom(self, *args, **kwargs):
        self.calls += 1
        raise ConnectionError("redis is down")

    get = set = _boom

    def eval(self, script, numkeys, key=None, token=None):
        if script == _PROBE_SCRIPT:
            return 1  # a down server is covered by set(); the Lua probe has its own test
        self._boom()


class _NoEvalRedis(_FakeRedis):
    def eval(self, script, numkeys, key=None, token=None):
        if script == _PROBE_SCRIPT:
            return 1  # the probe passes here; only the release fails
        raise RuntimeError("scripting is disabled")


class _Time:
    """Fake clock whose sleep advances it; `on_sleep(n)` runs after the n-th sleep."""

    def __init__(self, on_sleep=None) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []
        self.on_sleep = on_sleep

    def clock(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds
        if self.on_sleep:
            self.on_sleep(len(self.sleeps))


def _limiter(redis, g: int = 2, u: int = 2, lease: int = 600) -> LeaseLimiter:
    return LeaseLimiter(redis, g, u, lease)


def _acquire(limiter, time: _Time, model="m", scope=SCOPE, wait: float = 5.0):
    return limiter.acquire(model, scope, wait, sleep=time.sleep, clock=time.clock, rng=random.Random(1))


def test_global_cap_across_two_jobs() -> None:
    redis, time = _FakeRedis(), _Time()
    job_a, job_b = _limiter(redis, g=2, u=4), _limiter(redis, g=2, u=4)
    first = _acquire(job_a, time, scope=SCOPE)
    _acquire(job_b, time, scope=OTHER_SCOPE)
    assert _acquire(job_a, time, scope=SCOPE, wait=3) is None
    assert time.now >= 3
    first.release()
    assert _acquire(job_b, time, scope=OTHER_SCOPE) is not None


def test_dead_holder_slot_expires() -> None:
    redis, time = _FakeRedis(), _Time()
    limiter = _limiter(redis, g=2, u=2)
    _acquire(limiter, time)
    _acquire(limiter, time)
    redis.expire_all()
    assert _acquire(limiter, time) is not None


def test_release_never_frees_foreign_lease() -> None:
    redis, time = _FakeRedis(), _Time()
    limiter = _limiter(redis, g=1, u=1)
    a = _acquire(limiter, time)
    redis.expire_all()
    b = _acquire(limiter, time)
    held = dict(redis.data)
    a.release()
    assert redis.data == held and len(held) == 2
    b.release()
    assert redis.data == {}


def test_release_is_idempotent() -> None:
    redis, time = _FakeRedis(), _Time()
    limiter = _limiter(redis, g=1, u=1)
    lease = _acquire(limiter, time)
    lease.release()
    b = _acquire(limiter, time)
    lease.release()  # must not free b's keys even though they are the same keys
    assert len(redis.data) == 2
    b.release()


def test_context_manager_releases() -> None:
    redis, time = _FakeRedis(), _Time()
    with _acquire(_limiter(redis), time):
        assert len(redis.data) == 2
    assert redis.data == {}


def test_user_fairness_cap() -> None:
    redis, time = _FakeRedis(), _Time()
    limiter = _limiter(redis, g=4, u=2)
    assert _acquire(limiter, time, scope=SCOPE) is not None
    assert _acquire(limiter, time, scope=SCOPE) is not None
    assert _acquire(limiter, time, scope=SCOPE, wait=2) is None
    assert len(redis.keys("llmlease:g:")) == 2
    assert _acquire(limiter, time, scope=OTHER_SCOPE) is not None
    assert _acquire(limiter, time, scope=OTHER_SCOPE) is not None
    assert len(redis.keys("llmlease:g:")) == 4


def test_user_slot_is_returned_when_no_global_slot_is_free() -> None:
    redis, time = _FakeRedis(), _Time()
    limiter = _limiter(redis, g=1, u=2)
    _acquire(limiter, time, scope=OTHER_SCOPE)
    seen: list[int] = []
    time.on_sleep = lambda n: seen.append(len(redis.keys(f"llmlease:u:{SCOPE}:")))
    assert _acquire(limiter, time, scope=SCOPE, wait=3) is None
    assert seen and set(seen) == {0}
    assert redis.keys(f"llmlease:u:{SCOPE}:") == []


def test_every_lease_key_has_a_ttl() -> None:
    redis, time = _FakeRedis(), _Time()
    limiter = _limiter(redis, g=1, u=1, lease=123)
    _acquire(limiter, time)
    _acquire(limiter, time, wait=1)
    assert redis.pxs and all(px == 123_000 for _, px in redis.pxs)


def test_keys_never_contain_the_raw_user_or_model(caplog) -> None:
    redis, time = _FakeRedis(), _Time()
    limiter = _limiter(redis, g=1, u=1)
    with caplog.at_level(logging.DEBUG):
        lease = _acquire(limiter, time, model="distinctive-model-name", scope=SCOPE)
    keys = list(redis.data)
    assert all("distinctive" not in k for k in keys)
    assert any(f":{SCOPE}:" in k for k in keys if k.startswith("llmlease:u:"))
    g_key = next(k for k in keys if k.startswith("llmlease:g:"))
    assert len(g_key.split(":")[2]) == 12
    assert "distinctive" not in caplog.text
    lease.release()


def test_acquire_waits_then_succeeds_when_a_slot_frees() -> None:
    redis = _FakeRedis()
    limiter = _limiter(redis, g=1, u=1)
    holder = _acquire(limiter, _Time())
    time = _Time(on_sleep=lambda n: holder.release() if n == 3 else None)
    lease = _acquire(limiter, time, scope=OTHER_SCOPE, wait=60)
    assert lease is not None and len(time.sleeps) == 3
    assert all(0.25 <= s <= 1.0 for s in time.sleeps)


class _NoJitter(random.Random):
    def uniform(self, a, b):
        return 1.0


def _poll_intervals(limiter, time: _Time, holder, free_on_call: int, wait: float = 60.0):
    """Runs a contended acquire; returns (lease, seconds slept before each miss's next poll, the sleeps). `holder` is released at the given poll."""
    polls: list[float] = []
    original = limiter._try_once

    def try_once(*args):
        polls.append(sum(time.sleeps))
        if len(polls) == free_on_call:
            holder.release()
        return original(*args)

    limiter._try_once = try_once
    lease = limiter.acquire("m", OTHER_SCOPE, wait, sleep=time.sleep, clock=time.clock, rng=_NoJitter())
    return lease, [b - a for a, b in zip(polls, polls[1:])], polls


def test_the_poll_interval_backs_off_geometrically_up_to_the_cap_and_a_freed_slot_is_taken_at_the_next_poll() -> None:
    limiter = _limiter(_FakeRedis(), g=1, u=1)
    holder = _acquire(limiter, _Time())
    time = _Time()
    lease, intervals, polls = _poll_intervals(limiter, time, holder, free_on_call=7)
    assert lease is not None
    assert len(polls) == 7  # the slot was freed just before the 7th poll and that poll took it
    assert intervals == pytest.approx([0.5, 0.75, 1.125, 1.6875, 2.0, 2.0])
    assert max(time.sleeps) <= 1.0  # still slept in slices of at most one second


def test_a_long_poll_interval_is_slept_in_slices_with_a_cancel_check_before_each() -> None:
    limiter = _limiter(_FakeRedis(), g=1, u=1)
    holder = _acquire(limiter, _Time())
    token = CancelToken()
    # sleeps: 0.5 | 0.75 | 1.0 + 0.125 | 1.0 (first slice of the 4th interval, 1.6875): cancelled there, so its second slice never starts
    time = _Time(on_sleep=lambda n: token.cancel() if n == 5 else None)
    with cancellation_scope(token), pytest.raises(JobCancelled):
        limiter.acquire("m", OTHER_SCOPE, 60, sleep=time.sleep, clock=time.clock, rng=_NoJitter())
    assert len(time.sleeps) == 5
    holder.release()


def test_each_acquire_starts_its_back_off_again_from_the_base() -> None:
    limiter = _limiter(_FakeRedis(), g=1, u=1)
    holder = _acquire(limiter, _Time())
    lease, _, _ = _poll_intervals(limiter, _Time(), holder, free_on_call=5)
    holder = lease  # the slot is now held by the first waiter; the next waiter starts from the base again
    _, intervals, _ = _poll_intervals(limiter, _Time(), holder, free_on_call=3)
    assert intervals == pytest.approx([0.5, 0.75])


def test_acquire_gives_up_after_max_wait_and_returns_none() -> None:
    redis = _FakeRedis()
    limiter = _limiter(redis, g=1, u=1)
    _acquire(limiter, _Time())
    time = _Time()
    assert _acquire(limiter, time, scope=OTHER_SCOPE, wait=4) is None
    assert 4 <= time.now < 6


def test_cancel_during_wait_raises_and_holds_nothing() -> None:
    redis = _FakeRedis()
    limiter = _limiter(redis, g=1, u=1)
    _acquire(limiter, _Time(), scope=OTHER_SCOPE)
    before = dict(redis.data)
    token = CancelToken()
    time = _Time(on_sleep=lambda n: token.cancel() if n == 2 else None)
    with cancellation_scope(token), pytest.raises(JobCancelled):
        _acquire(limiter, time, scope=SCOPE, wait=60)
    assert redis.data == before


def test_redis_down_returns_a_local_lease_and_warns_once(caplog) -> None:
    redis, time = _DownRedis(), _Time()
    limiter = _limiter(redis)
    with caplog.at_level(logging.WARNING):
        first = _acquire(limiter, time)
        calls = redis.calls
        second = _acquire(limiter, time)
        first.release()
        second.release()
    assert first is not None and second is not None
    assert redis.calls == calls
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1 and "ConnectionError" in warnings[0].getMessage()
    assert time.sleeps == []


def test_no_redis_client_is_a_local_limiter() -> None:
    time = _Time()
    lease = _acquire(LeaseLimiter(None, 1, 1, 600), time)
    assert lease is not None
    with lease:
        pass
    lease.release()


def test_release_falls_back_to_ttl_when_eval_fails(caplog) -> None:
    redis, time = _NoEvalRedis(), _Time()
    limiter = _limiter(redis, g=1, u=1)
    lease = _acquire(limiter, time)
    with caplog.at_level(logging.WARNING):
        lease.release()
        lease.release()
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1 and "RuntimeError" in warnings[0].getMessage()
    assert len(redis.data) == 2  # left to expire on their own
    assert all(px == 600_000 for _, px in redis.pxs)


class _FlakyRedis(_FakeRedis):
    """Raises on every call while `broken` is set."""

    def __init__(self) -> None:
        super().__init__()
        self.broken = False
        self.attempts = 0

    def set(self, key, value, px=None, nx=False):
        self.attempts += 1
        if self.broken:
            raise ConnectionError("redis is down")
        return super().set(key, value, px=px, nx=nx)


def _acquire_at(limiter, time: _Time):
    return limiter.acquire("m", SCOPE, 5.0, sleep=time.sleep, clock=time.clock, rng=random.Random(1))


def test_limiter_recovers_after_the_cooldown() -> None:
    redis, time = _FlakyRedis(), _Time()
    limiter = LeaseLimiter(redis, 2, 2, 600, cooldown_seconds=30)
    redis.broken = True
    assert _acquire_at(limiter, time) is not None
    attempts = redis.attempts
    time.now = 29
    assert _acquire_at(limiter, time) is not None and redis.attempts == attempts  # still local, Redis untouched
    redis.broken = False
    time.now = 31
    lease = _acquire_at(limiter, time)
    assert len(redis.data) == 2  # a real lease again
    lease.release()
    assert redis.data == {}


def test_limiter_cooldown_restarts_on_a_new_failure() -> None:
    redis, time = _FlakyRedis(), _Time()
    limiter = LeaseLimiter(redis, 2, 2, 600, cooldown_seconds=30)
    redis.broken = True
    _acquire_at(limiter, time)
    time.now = 31
    _acquire_at(limiter, time)  # probes again, fails again
    attempts = redis.attempts
    time.now = 50  # 19 s after the second failure
    assert _acquire_at(limiter, time) is not None and redis.attempts == attempts
    redis.broken = False
    time.now = 62
    _acquire_at(limiter, time).release()
    assert redis.attempts > attempts


def test_recovery_logs_once_and_the_failure_warning_stays_single(caplog) -> None:
    redis, time = _FlakyRedis(), _Time()
    limiter = LeaseLimiter(redis, 2, 2, 600, cooldown_seconds=30)
    with caplog.at_level(logging.INFO):
        redis.broken = True
        _acquire_at(limiter, time)
        time.now = 31
        _acquire_at(limiter, time)  # second failure
        redis.broken = False
        time.now = 62
        _acquire_at(limiter, time).release()
        _acquire_at(limiter, time).release()
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    infos = [r for r in caplog.records if r.levelno == logging.INFO]
    assert len(warnings) == 1 and len(infos) == 1
    assert "ConnectionError" not in infos[0].getMessage()


def test_a_failed_release_also_starts_the_cooldown() -> None:
    redis, time = _NoEvalRedis(), _Time()
    limiter = LeaseLimiter(redis, 2, 2, 600, cooldown_seconds=30)
    _acquire_at(limiter, time).release()
    attempts = len(redis.pxs)
    assert _acquire_at(limiter, time) is not None and len(redis.pxs) == attempts


def test_a_lease_taken_before_a_blip_is_released_during_the_cooldown() -> None:
    redis, time = _FlakyRedis(), _Time()
    limiter = LeaseLimiter(redis, 2, 2, 600, cooldown_seconds=30)
    held = _acquire_at(limiter, time)
    assert len(redis.data) == 2
    redis.broken = True
    _acquire_at(limiter, time)  # another thread's failure starts the cooldown
    redis.broken = False  # Redis is healthy again, but the cooldown has not run out
    held.release()
    assert redis.data == {}  # the slots are given back at once, not left to the TTL


def test_a_release_that_raises_starts_the_cooldown_and_stops_releasing(caplog) -> None:
    class _EvalFails(_FakeRedis):
        def __init__(self) -> None:
            super().__init__()
            self.release_calls = 0

        def eval(self, script, numkeys, key=None, token=None):
            if script == _PROBE_SCRIPT:
                return 1
            self.release_calls += 1
            raise ConnectionError("redis is down")

    redis, time = _EvalFails(), _Time()
    limiter = LeaseLimiter(redis, 2, 2, 600, cooldown_seconds=30)
    lease = _acquire_at(limiter, time)
    with caplog.at_level(logging.WARNING):
        lease.release()
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert redis.release_calls == 1 and len(redis.data) == 2  # the second key was not tried: both expire by TTL
    assert len(warnings) == 1 and "ConnectionError" in warnings[0].getMessage()
    taken = len(redis.pxs)
    assert _acquire_at(limiter, time) is not None and len(redis.pxs) == taken  # the cooldown is running


def test_a_slow_probe_does_not_hold_the_limiter_lock() -> None:
    class _SlowProbe(_FakeRedis):
        def __init__(self) -> None:
            super().__init__()
            self.probing = threading.Event()
            self.gate = threading.Event()

        def eval(self, script, numkeys, key=None, token=None):
            if script == _PROBE_SCRIPT:
                self.probing.set()
                assert self.gate.wait(10)
            return super().eval(script, numkeys, key, token)

    redis, time = _SlowProbe(), _Time()
    limiter = _limiter(redis)
    prober = threading.Thread(target=lambda: _acquire(limiter, time).release())
    prober.start()
    try:
        assert redis.probing.wait(10)
        other_done = threading.Event()

        def other() -> None:
            limiter._fail("acquire", ValueError("x"))  # needs the lock
            other_done.set()

        threading.Thread(target=other, daemon=True).start()
        assert other_done.wait(2), "a method that needs the lock was blocked by the probe"
    finally:
        redis.gate.set()
        prober.join(10)


def test_first_acquire_probes_lua_and_goes_local_when_eval_is_unavailable(caplog) -> None:
    class _NoLua(_FakeRedis):
        def eval(self, script, numkeys, key=None, token=None):
            raise RuntimeError("unknown command 'eval'")

    redis, time = _NoLua(), _Time()
    limiter = _limiter(redis)
    with caplog.at_level(logging.INFO):
        lease = _acquire(limiter, time)
        _acquire(limiter, time)
    assert lease is not None and redis.pxs == []  # no slot was ever taken
    errors = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert len(errors) == 1 and "RuntimeError" in errors[0].getMessage() and "Lua" in errors[0].getMessage()


def test_successful_probe_runs_only_once() -> None:
    redis, time = _FakeRedis(), _Time()
    limiter = _limiter(redis)
    for _ in range(3):
        _acquire(limiter, time).release()
    assert redis.probes == 1


def test_study_redis_timeout_setting_default() -> None:
    from app.config import Settings

    assert Settings().survey_study_redis_timeout_seconds == 3.0


def test_main_builds_the_study_store_from_a_dedicated_client_with_timeouts() -> None:
    from app import main

    kwargs = main._study_redis.connection_pool.connection_kwargs
    assert kwargs["socket_timeout"] == kwargs["socket_connect_timeout"] == main.settings.survey_study_redis_timeout_seconds
    assert main._study_redis is not main._narration_redis
    assert main._study_store._redis is main._study_redis


def test_limiter_is_safe_across_threads() -> None:
    redis = _FakeRedis()
    limiter = _limiter(redis, g=3, u=8)
    holders = 0
    peak = 0
    guard = threading.Lock()
    errors: list[BaseException] = []

    def worker(seed: int) -> None:
        nonlocal holders, peak
        try:
            for _ in range(20):
                lease = limiter.acquire("m", SCOPE, 30, sleep=lambda s: None, clock=_Time().clock, rng=random.Random(seed))
                if lease is None:
                    continue
                with guard:
                    holders += 1
                    peak = max(peak, holders)
                with guard:
                    holders -= 1
                lease.release()
        except BaseException as error:  # noqa: BLE001
            errors.append(error)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert 1 <= peak <= 3
    assert redis.data == {}


def test_settings_defaults() -> None:
    from app.config import Settings

    s = Settings()
    assert (s.survey_study_global_slots, s.survey_study_user_slots) == (8, 4)
    assert (s.survey_study_lease_seconds, s.survey_study_lease_max_wait_seconds) == (600, 120)
    assert limiter_module.__doc__
