import logging
import random
import re
import threading

import httpx
import pytest

from app.job_cancel import CancelToken, JobCancelled, cancellation_scope, current_token
from app.leveling import document_study as study_document_module
from app.leveling import study_runner as study_runner_module
from app.leveling.document_study import WindowFindings, study_document
from app.leveling.study_runner import (
    LeasedStudyClient,
    StudyDeadlineExceeded,
    StudyHandle,
    StudyOutcome,
)
from app.leveling.study_store import StudyStore
from app.request_identity import user_scope

SCOPE = user_scope("Microsoft.Identity;distinctive-user@example.com")
OTHER_SCOPE = user_scope("Microsoft.Identity;someone-else@example.com")
MODEL = "model-a"
USER = "user-raw-id"
WAIT = 10.0

_EMPTY = {
    "glossary": [], "placeholder_tokens": [], "verification_statements": [], "standards_cited": [], "table_roles": [],
}


def _doc(n: int) -> str:
    """`n` windows exactly; window i starts with its own marker "S00i" and holds the next one, so every window (and its first half) differs."""
    return "".join(f"S{i:03d} " + "word " * 3899 for i in range(n))


def _index_of(text: str) -> int:
    return int(re.search(r"S(\d{3})", text).group(1))


def _http_error(status: int) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "http://study.invalid/")
    return httpx.HTTPStatusError(str(status), request=request, response=httpx.Response(status, request=request))


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


class _CountingClock(_Clock):
    """Counts its readings: the coordinator reads the clock once per pass of its loop, so `cycles(n)` waits until it has made n more passes."""

    def __init__(self) -> None:
        super().__init__()
        self._lock = threading.Lock()
        self._calls = 0
        self._target = 0
        self._reached = threading.Event()

    def __call__(self) -> float:
        with self._lock:
            self._calls += 1
            if self._calls >= self._target:
                self._reached.set()
        return self.now

    def cycles(self, n: int) -> None:
        with self._lock:
            self._target = self._calls + n
            self._reached.clear()
        assert self._reached.wait(WAIT), "the coordinator made no progress"


class _Stub:
    """Answers a window from its marker alone (so any order of reads gives one result). `hold` windows block, on their whole-window call,
    until their gate is opened; `fail` raises for a window's whole-window call; `once_429` raises a 429 on a window's first call."""

    def __init__(self, n: int, hold=(), fail=None, once_429=()) -> None:
        self.lock = threading.Lock()
        self.calls: list[int] = []
        self.threads: set[int] = set()
        self.inflight = self.peak = 0
        self.tokens: list[tuple[int, CancelToken, bool]] = []
        self.started = [threading.Event() for _ in range(n)]
        self.finished = [threading.Event() for _ in range(n)]
        self.gates = [threading.Event() for _ in range(n)]
        for i in range(n):
            if i not in hold:
                self.gates[i].set()
        self.fail = fail or {}
        self.once_429 = set(once_429)
        self.attempts: dict[int, int] = {}

    def open_all(self) -> None:
        for gate in self.gates:
            gate.set()

    def study_document_window(self, window_text: str, user_id: str | None = None) -> dict:
        i = _index_of(window_text)
        whole = len(window_text) > 15_000
        with self.lock:
            self.calls.append(i)
            self.threads.add(threading.get_ident())
            self.inflight += 1
            self.peak = max(self.peak, self.inflight)
            self.attempts[i] = self.attempts.get(i, 0) + 1
            attempt = self.attempts[i]
        try:
            self.started[i].set()
            if whole and not self.gates[i].wait(WAIT):
                raise AssertionError("gate was never opened")
            token = current_token()
            if token is not None:
                with self.lock:
                    self.tokens.append((i, token, token.cancelled))
            if whole and i in self.fail:
                raise self.fail[i]
            if whole and i in self.once_429 and attempt == 1:
                raise _http_error(429)
            return {**_EMPTY, "standards_cited": [f"S{i:03d}"], "placeholder_tokens": ["word"]}
        finally:
            with self.lock:
                self.inflight -= 1
            self.finished[i].set()


class _Redis:
    """In-memory redis-py stand-in (SET honours NX) that records the thread of every call and signals the first write."""

    def __init__(self) -> None:
        self.data: dict[str, bytes] = {}
        self.threads: set[int] = set()
        self.stored = threading.Event()

    def get(self, key):
        self.threads.add(threading.get_ident())
        return self.data.get(key)

    def set(self, key, value, ex=None, nx=False):
        self.threads.add(threading.get_ident())
        if nx and key in self.data:
            return None
        self.data[key] = value.encode() if isinstance(value, str) else value
        self.stored.set()
        return True

    def delete(self, *keys):
        self.threads.add(threading.get_ident())
        return sum(self.data.pop(key, None) is not None for key in keys)


def _store(redis) -> StudyStore:
    return StudyStore(redis, 3600)


def _own_keys(redis, text: str, scope: str = SCOPE) -> list[str]:
    prefix = _store(redis).run(scope, MODEL, text)._prefix
    return [key for key in redis.data if key.startswith(prefix)]


class _Lease:
    def __init__(self, limiter) -> None:
        self.limiter = limiter

    def release(self) -> None:
        with self.limiter.lock:
            self.limiter.released += 1
            self.limiter.held -= 1


class _Limiter:
    def __init__(self, none_first: int = 0, always_none: bool = False, on_acquire=None) -> None:
        self.lock = threading.Lock()
        self.none_left = none_first
        self.always_none = always_none
        self.on_acquire = on_acquire
        self.acquires: list[tuple[str | None, str, float]] = []
        self.held = self.released = 0
        self.tried = threading.Event()

    def acquire(self, model, scope, max_wait_seconds, **kwargs):
        with self.lock:
            self.acquires.append((model, scope, max_wait_seconds))
            self.tried.set()
            none = self.always_none or self.none_left > 0
            if none and not self.always_none:
                self.none_left -= 1
            if not none:
                self.held += 1
        if self.on_acquire is not None:
            self.on_acquire()
        if none:
            threading.Event().wait(0.001)  # a real limiter blocks for its max wait; yield instead of spinning
            return None
        return _Lease(self)


def _handle(text: str, client, **over) -> StudyHandle:
    params = dict(
        render_text=lambda: text, client=client, user_id=USER, scope=SCOPE, model=MODEL, store=None, limiter=None, concurrency=4,
        lookahead=8, deadline_seconds=1000.0, soft_budget_seconds=500.0, breaker_failures=5, max_windows=300, lease_max_wait_seconds=30.0,
        sleep=lambda seconds: None, rng=random.Random(0), clock=_Clock(), poll_seconds=0.01,
    )
    params.update(over)
    return StudyHandle(**params)


def _run(handle: StudyHandle, timeout: float = WAIT) -> StudyOutcome:
    handle.start()
    try:
        return handle.result(timeout=timeout)
    finally:
        handle.close()


def _wait(event: threading.Event) -> None:
    assert event.wait(WAIT), "timed out waiting for a test event"


def _sequential(text: str, stub: _Stub, **kwargs):
    return study_document(text, stub, USER, sleep=lambda seconds: None, rng=random.Random(0), **kwargs)


@pytest.fixture(autouse=True)
def _no_study_thread_survives():
    yield
    leaked = [t for t in threading.enumerate() if t.name.startswith(("study-coordinator", "study-worker"))]
    for thread in leaked:
        thread.join(5)
    assert not [t for t in leaked if t.is_alive()], "a study thread outlived its test"


def test_concurrent_result_equals_sequential_result() -> None:
    text = _doc(8)
    kwargs = dict(fail={3: _http_error(500)}, once_429={1, 5})
    expected = _sequential(text, _Stub(8, **kwargs))
    assert expected.read_stats.windows_split == 1 and expected.read_stats.windows_retried == 2
    for concurrency in (1, 4):
        outcome = _run(_handle(text, _Stub(8, **kwargs), concurrency=concurrency))
        assert outcome.study == expected
        assert outcome.stopped_by == "completed"


def test_result_is_independent_of_completion_order() -> None:
    text = _doc(4)
    stub = _Stub(4, hold={0, 1, 2, 3})
    handle = _handle(text, stub)
    handle.start()
    try:
        for i in range(4):
            _wait(stub.started[i])
        for i in (3, 2, 1, 0):  # finish in reverse; the next one is released only after this one has returned
            stub.gates[i].set()
            _wait(stub.finished[i])
        outcome = handle.result(timeout=WAIT)
    finally:
        stub.open_all()
        handle.close()
    assert outcome.study == _sequential(text, _Stub(4))


def test_never_more_than_n_windows_in_flight() -> None:
    stub = _Stub(8, hold=set(range(8)))
    clock = _CountingClock()
    handle = _handle(_doc(8), stub, concurrency=3, clock=clock)
    handle.start()
    try:
        for i in range(3):
            _wait(stub.started[i])
        clock.cycles(20)  # the coordinator has looked again many times, every gate still closed
        assert [e.is_set() for e in stub.started] == [True] * 3 + [False] * 5  # a fourth window never starts while three are in flight
        stub.open_all()
        outcome = handle.result(timeout=WAIT)
    finally:
        stub.open_all()
        handle.close()
    assert stub.peak == 3
    assert outcome.study.windows_studied == 8


def test_lookahead_caps_submitted_windows() -> None:
    stub = _Stub(6, hold={0})
    clock = _CountingClock()
    handle = _handle(_doc(6), stub, concurrency=4, lookahead=2, clock=clock)
    handle.start()
    try:
        _wait(stub.started[1])
        clock.cycles(20)
        assert not stub.started[2].is_set()  # window 0 is unconsumed and window 1 is done: two submitted, the cap
        stub.gates[0].set()
        outcome = handle.result(timeout=WAIT)
    finally:
        stub.open_all()
        handle.close()
    assert outcome.study.windows_studied == 6


def test_the_coordinator_is_a_daemon_thread() -> None:
    handle = _handle(_doc(1), _Stub(1))
    handle.start()
    try:
        assert handle._thread.daemon is True  # a process that is exiting never waits for a study
        handle.result(timeout=WAIT)
    finally:
        handle.close()


class _BlockingGetRedis(_Redis):
    """A slow Redis: every get blocks until `gate` is opened."""

    def __init__(self) -> None:
        super().__init__()
        self.entered = threading.Event()
        self.gate = threading.Event()
        self.gets = 0

    def get(self, key):
        self.gets += 1
        self.entered.set()
        assert self.gate.wait(WAIT), "the gate was never opened"
        return super().get(key)


def test_close_stops_the_cache_preload_after_the_blocked_get() -> None:
    redis = _BlockingGetRedis()
    handle = _handle(_doc(6), _Stub(6), store=_store(redis))
    handle.start()
    try:
        _wait(redis.entered)
        handle.stop(keep_results=False)
        redis.gate.set()  # the one get under way returns; no further window is preloaded
        handle._thread.join(WAIT)
        assert not handle._thread.is_alive()
        assert redis.gets == 1
        assert handle.result(timeout=WAIT).stopped_by == "stopped"
    finally:
        redis.gate.set()
        handle.close()


def test_a_parent_cancel_during_the_cache_preload_ends_the_run_as_cancelled() -> None:
    redis = _BlockingGetRedis()
    with cancellation_scope() as parent:
        handle = _handle(_doc(6), _Stub(6), store=_store(redis))
        handle.start()
        try:
            _wait(redis.entered)
            parent.cancel()
            redis.gate.set()
            with pytest.raises(JobCancelled):
                handle.result(timeout=WAIT)
            assert redis.gets == 1
        finally:
            redis.gate.set()
            handle.close()


def test_a_window_that_finished_is_consumed_even_when_the_deadline_has_passed(monkeypatch) -> None:
    window_done = threading.Event()
    real_submit = study_runner_module.submit_in_context

    class _PastDeadlineOnceDone(_Clock):
        """The coordinator's first two readings (the first pass of its loop) are 0. The third opens window 0's gate, waits for its future to be
        done and reads past the deadline, so the coordinator sees "finished" and "deadline" together, whatever the thread timing."""

        def __init__(self) -> None:
            super().__init__()
            self.coordinator_reads = 0

        def __call__(self) -> float:
            if threading.current_thread().name == "study-coordinator":
                self.coordinator_reads += 1
                if self.coordinator_reads > 2:
                    stub.gates[0].set()
                    assert window_done.wait(WAIT)
                    return 101.0
            return 0.0

    def submit(executor, fn, *args):
        future = real_submit(executor, fn, *args)
        if _index_of(args[0]) == 0:
            future.add_done_callback(lambda _f: window_done.set())
        return future

    monkeypatch.setattr(study_runner_module, "submit_in_context", submit)
    stub = _Stub(2, hold={0})
    handle = _handle(_doc(2), stub, concurrency=1, clock=_PastDeadlineOnceDone(), deadline_seconds=100.0)
    handle.start()
    try:
        outcome = handle.result(timeout=WAIT)
    finally:
        stub.open_all()
        handle.close()
    assert outcome.stopped_by == "deadline"
    assert outcome.study is not None and outcome.study.windows_studied == 1  # finished work is not thrown away


def test_store_hits_skip_the_model_and_the_workers() -> None:
    text = _doc(4)
    redis = _Redis()
    first = _run(_handle(text, _Stub(4), store=_store(redis)))
    assert len(redis.data) == 4

    stub = _Stub(4)
    outcome = _run(_handle(text, stub, store=_store(redis)))
    assert stub.calls == []
    assert outcome.study.read_stats.windows_cached == 4
    assert outcome.study.windows_studied == 4
    assert outcome.study.glossary == first.study.glossary and outcome.study.standards_cited == first.study.standards_cited

    del redis.data[_own_keys(redis, text)[2]]
    stub = _Stub(4)
    outcome = _run(_handle(text, stub, store=_store(redis)))
    assert sorted(set(stub.calls)) == [2]
    assert outcome.study.read_stats.windows_cached == 3


def test_cached_windows_reset_the_breaker() -> None:
    text = _doc(3)
    redis = _Redis()
    _store(redis).run(SCOPE, MODEL, text).put(1, WindowFindings(standards_cited=("S001",)))
    stub = _Stub(3, fail={0: RuntimeError("x"), 2: RuntimeError("x")})
    outcome = _run(_handle(text, stub, store=_store(redis), breaker_failures=2))
    assert outcome.study.read_stats.breaker_opened is False
    assert outcome.study.read_stats.windows_failed == 2
    assert outcome.study.windows_studied == 1


def test_only_the_coordinator_thread_touches_the_store() -> None:
    text = _doc(4)
    redis = _Redis()
    seen: list[int] = []
    stub = _Stub(4)

    def render() -> str:
        seen.append(threading.get_ident())
        return text

    _run(_handle(text, stub, store=_store(redis), render_text=render))
    assert redis.threads == {seen[0]}
    assert threading.get_ident() not in redis.threads
    assert stub.threads and seen[0] not in stub.threads


def test_render_runs_in_the_study_thread() -> None:
    names: list[str] = []

    def render() -> str:
        names.append(threading.current_thread().name)
        return _doc(1)

    _run(_handle("", _Stub(1), render_text=render))
    assert names == ["study-coordinator"]
    assert threading.current_thread().name != "study-coordinator"


def test_parent_cancel_stops_dispatch_and_cleans_up_own_keys_only() -> None:
    text = _doc(6)
    redis = _Redis()
    other_doc, other_user = _store(redis).run(SCOPE, MODEL, "another document"), _store(redis).run(OTHER_SCOPE, MODEL, text)
    other_doc.put(0, WindowFindings())
    other_user.put(0, WindowFindings())
    foreign = set(redis.data)
    redis.stored.clear()
    stub = _Stub(6, hold={1, 2, 3, 4, 5})
    with cancellation_scope() as parent:
        handle = _handle(text, stub, store=_store(redis), concurrency=2)
        handle.start()
        try:
            _wait(redis.stored)
            _wait(stub.started[1])
            assert _own_keys(redis, text)
            parent.cancel()
            with pytest.raises(JobCancelled):
                handle.result(timeout=WAIT)
            stub.open_all()
            _wait(stub.finished[1])
        finally:
            stub.open_all()
            handle.close()
    assert _own_keys(redis, text) == []
    assert set(redis.data) == foreign
    assert set(stub.calls) <= {0, 1, 2}
    assert [cancelled for i, token, cancelled in stub.tokens if i == 1] == [True]


def test_child_token_inherits_parent_cancel_and_never_cancels_the_parent() -> None:
    stub = _Stub(3, hold={1})
    with cancellation_scope() as parent:
        handle = _handle(_doc(3), stub, concurrency=2)
        handle.start()
        try:
            _wait(stub.started[1])
            handle.stop(keep_results=True)  # the study's own stop cancels its child, never the job's token
            handle.result(timeout=WAIT)
            stub.gates[1].set()
            _wait(stub.finished[1])
        finally:
            stub.open_all()
            handle.close()
    assert parent.cancelled is False
    held = [(token, cancelled) for i, token, cancelled in stub.tokens if i == 1]
    assert len(held) == 1 and held[0][0] is not parent and held[0][1] is True


def test_stop_keep_results_keeps_keys_and_returns_a_partial_outcome() -> None:
    text = _doc(4)
    redis = _Redis()
    stub = _Stub(4, hold={1, 2, 3})
    handle = _handle(text, stub, store=_store(redis), concurrency=2)
    handle.start()
    try:
        _wait(redis.stored)
        _wait(stub.started[1])
        handle.stop(keep_results=True)
        outcome = handle.result(timeout=WAIT)
    finally:
        stub.open_all()
        handle.close()
    assert outcome.stopped_by == "stopped"
    assert outcome.study is not None and outcome.study.windows_studied == 1 and outcome.study.windows_total == 4
    assert any("1 of 4" in warning for warning in outcome.warnings)
    assert len(_own_keys(redis, text)) == 1


def test_stop_cleanup_deletes_own_keys() -> None:
    text = _doc(4)
    redis = _Redis()
    _store(redis).run(OTHER_SCOPE, MODEL, text).put(0, WindowFindings())
    foreign = set(redis.data)
    redis.stored.clear()
    stub = _Stub(4, hold={1, 2, 3})
    handle = _handle(text, stub, store=_store(redis), concurrency=2)
    handle.start()
    try:
        _wait(redis.stored)
        _wait(stub.started[1])
        assert len(_own_keys(redis, text)) == 1
        handle.stop(keep_results=False)
        outcome = handle.result(timeout=WAIT)
    finally:
        stub.open_all()
        handle.close()
    assert outcome.stopped_by == "stopped"
    assert _own_keys(redis, text) == []
    assert set(redis.data) == foreign


def test_close_stops_a_running_study_and_cleans_up_and_is_safe_twice() -> None:
    text = _doc(3)
    redis = _Redis()
    stub = _Stub(3, hold={1, 2})
    handle = _handle(text, stub, store=_store(redis), concurrency=2)
    handle.start()
    _wait(redis.stored)
    _wait(stub.started[1])
    stub.open_all()
    handle.close()
    handle.close()
    assert _own_keys(redis, text) == []


def test_close_after_completion_keeps_the_cache() -> None:
    text = _doc(3)
    redis = _Redis()
    outcome = _run(_handle(text, _Stub(3), store=_store(redis)))
    assert outcome.stopped_by == "completed"
    assert len(_own_keys(redis, text)) == 3


class _BrokenStore:
    def run(self, scope, model, text):
        raise RuntimeError("redis exploded for key study:secret")


def test_result_raises_only_jobcancelled(caplog) -> None:
    caplog.set_level(logging.WARNING)
    outcome = _run(_handle(_doc(2), _Stub(2), store=_BrokenStore()))
    assert outcome.study is None and outcome.stopped_by == "error"
    assert outcome.warnings and all("secret" not in warning for warning in outcome.warnings)
    assert "secret" not in caplog.text

    def boom() -> str:
        raise ValueError("render failed")

    outcome = _run(_handle("", _Stub(1), render_text=boom))
    assert outcome.study is None and outcome.stopped_by == "error" and outcome.warnings


def test_worker_exception_becomes_a_failed_window_and_the_run_continues(caplog) -> None:
    caplog.set_level(logging.INFO)
    text = _doc(5)
    stub = _Stub(5, fail={2: RuntimeError("model said no")})
    outcome = _run(_handle(text, stub))
    assert outcome.stopped_by == "completed"
    assert outcome.study.read_stats.windows_failed == 1
    assert outcome.study.windows_studied == 4
    assert any("4 of 5" in warning for warning in outcome.warnings)
    assert USER not in caplog.text and SCOPE not in caplog.text


def test_unexpected_exception_in_a_worker_is_a_failed_window(caplog) -> None:
    caplog.set_level(logging.WARNING)

    def broken_sleep(seconds: float) -> None:
        raise RuntimeError("sleep exploded")

    stub = _Stub(3, once_429={1})  # the 429 back-off sleep raises something the read does not expect
    outcome = _run(_handle(_doc(3), stub, sleep=broken_sleep))
    assert outcome.study.read_stats.windows_failed == 1
    assert outcome.study.windows_studied == 2
    assert "sleep exploded" not in caplog.text


def test_worker_jobcancelled_ends_the_run_and_cleans_up() -> None:
    text = _doc(3)
    redis = _Redis()
    stub = _Stub(3, fail={1: JobCancelled("gone")})
    handle = _handle(text, stub, store=_store(redis), concurrency=1)
    handle.start()
    try:
        with pytest.raises(JobCancelled):
            handle.result(timeout=WAIT)
    finally:
        handle.close()
    assert _own_keys(redis, text) == []


def test_deadline_returns_a_partial_outcome_with_a_warning() -> None:
    clock = _Clock()
    redis = _Redis()
    text = _doc(4)
    stub = _Stub(4, hold={1, 2, 3})
    handle = _handle(text, stub, store=_store(redis), concurrency=2, clock=clock, deadline_seconds=100.0)
    handle.start()
    try:
        _wait(redis.stored)
        _wait(stub.started[1])
        clock.now = 101.0
        outcome = handle.result(timeout=WAIT)
    finally:
        stub.open_all()
        handle.close()
    assert outcome.stopped_by == "deadline"
    assert outcome.study.windows_studied == 1 and outcome.study.read_stats.budget_stopped is True
    assert any("time budget" in warning for warning in outcome.warnings)
    assert len(_own_keys(redis, text)) == 1  # a partial study keeps what it stored


def test_soft_budget_logs_one_warning_and_carries_on() -> None:
    clock = _Clock()
    logged = threading.Event()
    records: list[str] = []

    class _Flag(logging.Handler):
        def emit(self, record) -> None:
            if record.levelno == logging.WARNING:
                records.append(record.getMessage())
                logged.set()

    runner_logger = logging.getLogger("app.leveling.study_runner")
    flag = _Flag()
    runner_logger.addHandler(flag)
    stub = _Stub(3, hold={1})
    handle = _handle(_doc(3), stub, clock=clock, soft_budget_seconds=50.0, deadline_seconds=1000.0, concurrency=2)
    handle.start()
    try:
        _wait(stub.started[1])
        clock.now = 60.0
        _wait(logged)
        stub.open_all()
        outcome = handle.result(timeout=WAIT)
    finally:
        stub.open_all()
        handle.close()
        runner_logger.removeHandler(flag)
    assert len(records) == 1 and "past 50" in records[0]
    assert outcome.study.windows_studied == 3 and outcome.stopped_by == "completed"


def test_result_timeout_returns_the_partial_outcome() -> None:
    text = _doc(4)
    redis = _Redis()
    stub = _Stub(4, hold={1, 2, 3})
    handle = _handle(text, stub, store=_store(redis), concurrency=2)
    handle.start()
    try:
        _wait(redis.stored)
        _wait(stub.started[1])
        outcome = handle.result(timeout=0.05)
    finally:
        stub.open_all()
        handle.close()
    assert outcome.stopped_by == "stopped"
    assert outcome.study.windows_studied == 1
    assert len(_own_keys(redis, text)) == 1  # a timed-out result is "not needed any more": it keeps the cache, even through close()


def test_result_timeout_gives_up_waiting_for_a_stuck_coordinator(monkeypatch) -> None:
    monkeypatch.setattr(study_runner_module, "_RESULT_GRACE_SECONDS", 0.05)
    release = threading.Event()

    def stuck() -> str:
        release.wait(WAIT)
        return ""

    handle = _handle("", _Stub(1), render_text=stuck)
    handle.start()
    try:
        outcome = handle.result(timeout=0.05)
        assert outcome.study is None and outcome.stopped_by == "stopped" and outcome.warnings
    finally:
        release.set()
        handle.close()


def test_lease_is_taken_per_attempt_and_released_on_error() -> None:
    clock, limiter = _Clock(), _Limiter()

    class _Inner:
        calls = 0

        def study_document_window(self, window_text, user_id=None):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("model error")
            return _EMPTY

    inner = _Inner()
    client = LeasedStudyClient(inner, limiter, MODEL, SCOPE, clock, 100.0, 30.0)
    with pytest.raises(RuntimeError):
        client.study_document_window("text", USER)
    assert (limiter.held, limiter.released) == (0, 1)
    assert client.study_document_window("text", USER) == _EMPTY
    assert len(limiter.acquires) == 2 and (limiter.held, limiter.released) == (0, 2)
    assert limiter.acquires[0] == (MODEL, SCOPE, 30.0)
    clock.now = 90.0  # the wait for a lease never outlives the study's deadline
    client.study_document_window("text", USER)
    assert limiter.acquires[2][2] == 10.0


def test_a_window_read_takes_one_lease_per_model_attempt() -> None:
    limiter = _Limiter()
    stub = _Stub(3, once_429={0})
    outcome = _run(_handle(_doc(3), stub, limiter=limiter))
    assert stub.calls.count(0) == 2  # the 429 and its retry
    assert len(limiter.acquires) == len(stub.calls)
    assert limiter.released == len(limiter.acquires) and limiter.held == 0
    assert outcome.study.read_stats.windows_retried == 1


def test_lease_wait_is_not_a_failure_and_does_not_trip_the_breaker() -> None:
    limiter = _Limiter(none_first=7)
    stub = _Stub(3)
    outcome = _run(_handle(_doc(3), stub, limiter=limiter, breaker_failures=1, concurrency=1))
    assert outcome.stopped_by == "completed"
    assert outcome.study.windows_studied == 3
    assert outcome.study.read_stats.windows_failed == 0 and outcome.study.read_stats.breaker_opened is False
    assert len(limiter.acquires) == 7 + len(stub.calls)


def test_lease_wait_past_the_deadline_raises_and_holds_nothing() -> None:
    clock = _Clock()
    limiter = _Limiter(always_none=True, on_acquire=lambda: setattr(clock, "now", 101.0))
    inner = _Stub(1)
    client = LeasedStudyClient(inner, limiter, MODEL, SCOPE, clock, 100.0, 30.0)
    with pytest.raises(StudyDeadlineExceeded):
        client.study_document_window("S000 text", USER)
    assert client.deadline_exceeded is True and inner.calls == [] and limiter.held == 0
    with pytest.raises(StudyDeadlineExceeded):  # also with no limiter at all: no attempt starts after the deadline
        LeasedStudyClient(inner, None, MODEL, SCOPE, clock, 100.0, 30.0).study_document_window("S000 text", USER)


def test_lease_wait_honours_cancellation() -> None:
    limiter = _Limiter(always_none=True)
    client = LeasedStudyClient(_Stub(1), limiter, MODEL, SCOPE, _Clock(), 100.0, 30.0)
    with cancellation_scope() as token:
        token.cancel()
        with pytest.raises(JobCancelled):
            client.study_document_window("S000 text", USER)
    assert limiter.acquires == [] and limiter.held == 0


def test_a_study_blocked_on_leases_stops_at_the_deadline() -> None:
    clock = _Clock()
    limiter = _Limiter(always_none=True)
    handle = _handle(_doc(3), _Stub(3), limiter=limiter, clock=clock, deadline_seconds=100.0, breaker_failures=1)
    handle.start()
    try:
        _wait(limiter.tried)
        clock.now = 101.0
        outcome = handle.result(timeout=WAIT)
    finally:
        handle.close()
    assert outcome.stopped_by == "deadline" and outcome.study is None
    assert any("time budget" in warning for warning in outcome.warnings)
    assert limiter.held == 0


def test_breaker_is_evaluated_in_index_order(monkeypatch) -> None:
    text = _doc(8)
    fail = {2: RuntimeError("x"), 3: RuntimeError("x")}
    monkeypatch.setattr(study_document_module.settings, "survey_study_breaker_failures", 2)
    expected = _sequential(text, _Stub(8, fail=fail))
    assert expected.read_stats.breaker_opened is True and expected.windows_studied == 2
    stub = _Stub(8, hold={0, 1, 2, 3}, fail=fail)
    handle = _handle(text, stub, concurrency=4, breaker_failures=2)
    handle.start()
    try:
        for i in range(4):
            _wait(stub.started[i])
        for i in (3, 2, 1, 0):  # window 3 fails before window 2 does
            stub.gates[i].set()
            _wait(stub.finished[i])
        outcome = handle.result(timeout=WAIT)
    finally:
        stub.open_all()
        handle.close()
    assert outcome.study == expected
    assert outcome.stopped_by == "breaker"
    assert any("in a row" in warning for warning in outcome.warnings)


def test_429_pressure_reduces_workers_to_a_floor_of_one() -> None:
    handle = _handle(_doc(6), _Stub(6, once_429={0}), concurrency=4)
    _run(handle)
    assert handle.current_workers == 3
    handle = _handle(_doc(6), _Stub(6, once_429={0, 1, 2, 4}), concurrency=3)
    _run(handle)
    assert handle.current_workers == 1
    handle = _handle(_doc(4), _Stub(4), concurrency=3)
    _run(handle)
    assert handle.current_workers == 3  # no pressure: never raised, never lowered


def _status_504() -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "http://upstream.invalid/chat")
    return httpx.HTTPStatusError("504", request=request, response=httpx.Response(504, request=request))


def test_a_504_or_timeout_lowers_the_workers_like_a_429_and_the_window_is_unread() -> None:
    handle = _handle(_doc(6), _Stub(6, fail={0: _status_504()}), concurrency=4)
    outcome = _run(handle)
    assert handle.current_workers == 3
    assert outcome.study.read_stats.windows_failed == 1 and outcome.study.read_stats.windows_split == 0
    handle = _handle(_doc(6), _Stub(6, fail={0: httpx.ReadTimeout("slow"), 1: httpx.ReadTimeout("slow"), 2: httpx.ReadTimeout("slow")}), concurrency=3)
    _run(handle)
    assert handle.current_workers == 1


def _final_workers(n: int, once_429, concurrency: int = 4, **over) -> int:
    handle = _handle(_doc(n), _Stub(n, once_429=once_429), concurrency=concurrency, **over)
    _run(handle)
    return handle.current_workers


def test_clean_windows_raise_the_workers_by_one_after_the_recovery_streak() -> None:
    streak = study_runner_module._RECOVERY_CLEAN_WINDOWS
    assert streak == 8
    assert _final_workers(1 + streak - 1, {0}) == 3  # one clean window short: still lowered
    assert _final_workers(1 + streak, {0}) == 4  # the 8th clean window raises it by one


def test_a_429_resets_the_clean_streak_and_still_lowers_the_workers() -> None:
    # 429 at 0 (3), five clean, 429 at 6 (2), two clean: the streak restarted at 6, so there is no recovery.
    assert _final_workers(9, {0, 6}) == 2
    # a 429 at the very window that would have been the 8th clean one: lowered again, not raised
    assert _final_workers(9, {0, 8}) == 2
    assert _final_workers(18, {0, 6}) == 3  # 11 clean windows after the second 429: one recovery step (2 -> 3)


def test_recovery_steps_up_one_at_a_time_and_never_exceeds_the_configured_concurrency() -> None:
    assert _final_workers(19, {0, 1, 2}) == 3  # 1 after three 429s, then 16 clean windows: two steps
    assert _final_workers(30, {0}) == 4  # 3, raised to 4, then more clean windows: never above the configured 4
    assert _final_workers(30, set(), concurrency=3) == 3
    assert _final_workers(12, {0, 1, 2, 3, 4}, concurrency=3) == 1  # five 429s, then only six clean windows: no recovery


def test_cached_windows_do_not_count_towards_the_recovery_streak() -> None:
    text = _doc(10)
    redis = _Redis()
    run = _store(redis).run(SCOPE, MODEL, text)
    for index in range(1, 5):
        run.put(index, WindowFindings(standards_cited=(f"S{index:03d}",)))
    handle = _handle(text, _Stub(10, once_429={0}), store=_store(redis), concurrency=4)
    _run(handle)
    assert handle.current_workers == 3  # 4 cached + 5 read windows would have made 9 if the cached ones counted


def test_the_recovered_workers_are_in_the_statistics(caplog) -> None:
    caplog.set_level(logging.INFO)
    _run(_handle(_doc(9), _Stub(9, once_429={0}), concurrency=4))
    assert _stats_lines(caplog) == [_stats(reason="completed", total=9, studied=9, retried=1, workers=4)]


def test_no_study_thread_survives_close() -> None:
    before = set(threading.enumerate())
    stub = _Stub(4, hold={1, 2, 3})
    handle = _handle(_doc(4), stub, concurrency=2)
    handle.start()
    _wait(stub.started[1])
    stub.open_all()
    handle.close()
    for thread in set(threading.enumerate()) - before:
        thread.join(5)
        assert not thread.is_alive()
    _run(_handle(_doc(4), _Stub(4)))
    assert not [t for t in set(threading.enumerate()) - before if t.is_alive()]


def test_no_store_and_no_limiter_still_works() -> None:
    outcome = _run(_handle(_doc(3), _Stub(3), store=None, limiter=None))
    assert outcome.stopped_by == "completed" and outcome.warnings == ()
    assert outcome.study.windows_studied == outcome.study.windows_total == 3
    assert outcome.study.read_stats.windows_cached == 0


def test_blank_text_is_not_studied() -> None:
    stub = _Stub(1)
    outcome = _run(_handle("  \n ", stub))
    assert outcome == StudyOutcome(None, (), "completed")
    assert stub.calls == []


def test_max_windows_caps_the_reading_but_not_the_total() -> None:
    stub = _Stub(5)
    outcome = _run(_handle(_doc(5), stub, max_windows=2))
    assert set(stub.calls) <= {0, 1}
    assert outcome.study.windows_total == 5 and outcome.study.windows_studied == 2
    assert any("2 of 5" in warning for warning in outcome.warnings)


def test_reading_nothing_says_so() -> None:
    stub = _Stub(2, fail={0: RuntimeError("x"), 1: RuntimeError("x")})
    outcome = _run(_handle(_doc(2), stub))
    assert outcome.study is None and outcome.stopped_by == "completed"
    assert any("none" in warning for warning in outcome.warnings)


def test_a_handle_starts_once_and_result_needs_a_start() -> None:
    handle = _handle(_doc(1), _Stub(1))
    with pytest.raises(RuntimeError):
        handle.result(timeout=0.01)
    handle.close()  # never started: nothing to stop
    handle.start()
    try:
        with pytest.raises(RuntimeError):
            handle.start()
        handle.result(timeout=WAIT)
    finally:
        handle.close()


def test_from_settings_fills_the_budgets_from_settings(monkeypatch) -> None:
    settings = study_runner_module.settings
    for name, value in dict(
        survey_study_concurrency=3, survey_study_lookahead=5, survey_study_max_windows=7, survey_study_breaker_failures=2,
        survey_study_soft_budget_seconds=11, survey_study_hard_budget_seconds=22, survey_study_lease_max_wait_seconds=33,
    ).items():
        monkeypatch.setattr(settings, name, value)
    handle = StudyHandle.from_settings(
        render_text=lambda: _doc(1), client=_Stub(1), user_id=USER, scope=SCOPE, model=MODEL, store=None, limiter=None, poll_seconds=0.01,
    )
    assert (handle._concurrency, handle._lookahead, handle._max_windows, handle._breaker_failures) == (3, 5, 7, 2)
    assert (handle._soft_budget_seconds, handle._deadline_seconds, handle._lease_max_wait_seconds) == (11, 22, 33)
    assert _run(handle).study.windows_studied == 1


def test_settings_defaults() -> None:
    from pydantic import ValidationError

    from app.config import Settings

    s = Settings()
    assert (s.survey_study_concurrency, s.survey_study_lookahead) == (4, 8)
    for bad in ({"survey_study_concurrency": 0}, {"survey_study_concurrency": 9}, {"survey_study_lookahead": 0}):
        with pytest.raises(ValidationError):
            Settings(**bad)
    assert study_runner_module.__doc__


def _stats_lines(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.getMessage().startswith("Document study finished:")]


def _stats(*, reason, total=0, studied=0, cached=0, retried=0, split=0, failed=0, breaker=False, budget=False, seconds=0.0, workers=4) -> str:
    return (
        f"Document study finished: stopped_by={reason} windows_total={total} studied={studied} cached={cached} retried={retried} split={split} "
        f"failed={failed} breaker_opened={breaker} budget_stopped={budget} seconds={seconds:.1f} workers_final={workers}"
    )


def test_a_completed_run_logs_its_statistics_once(caplog) -> None:
    caplog.set_level(logging.INFO)
    outcome = _run(_handle(_doc(4), _Stub(4)))
    assert outcome.stopped_by == "completed"
    assert _stats_lines(caplog) == [_stats(reason="completed", total=4, studied=4)]


def test_a_retried_window_and_the_lowered_workers_are_in_the_statistics(caplog) -> None:
    caplog.set_level(logging.INFO)
    _run(_handle(_doc(6), _Stub(6, once_429={0}), concurrency=4))
    assert _stats_lines(caplog) == [_stats(reason="completed", total=6, studied=6, retried=1, workers=3)]


def test_a_breaker_stop_logs_its_statistics(caplog) -> None:
    caplog.set_level(logging.INFO)
    stub = _Stub(8, fail={2: RuntimeError("x"), 3: RuntimeError("x")})
    outcome = _run(_handle(_doc(8), stub, concurrency=1, breaker_failures=2))
    stats = outcome.study.read_stats
    assert outcome.stopped_by == "breaker"
    assert _stats_lines(caplog) == [_stats(
        reason="breaker", total=8, studied=outcome.study.windows_studied, retried=stats.windows_retried, split=stats.windows_split,
        failed=stats.windows_failed, breaker=True, workers=1,
    )]
    assert stats.windows_failed == 2 and outcome.study.windows_studied == 2


def test_a_deadline_stop_logs_its_statistics_and_the_engines_own_clock(caplog) -> None:
    caplog.set_level(logging.INFO)
    clock = _Clock()
    redis = _Redis()
    stub = _Stub(4, hold={1, 2, 3})
    handle = _handle(_doc(4), stub, store=_store(redis), concurrency=2, clock=clock, deadline_seconds=100.0)
    handle.start()
    try:
        _wait(redis.stored)
        _wait(stub.started[1])
        clock.now = 101.0
        outcome = handle.result(timeout=WAIT)
    finally:
        stub.open_all()
        handle.close()
    assert outcome.stopped_by == "deadline"
    assert _stats_lines(caplog) == [_stats(reason="deadline", total=4, studied=1, budget=True, seconds=101.0, workers=2)]


def test_a_cached_resume_logs_its_cached_windows(caplog) -> None:
    caplog.set_level(logging.INFO)
    text = _doc(4)
    redis = _Redis()
    _run(_handle(text, _Stub(4), store=_store(redis)))
    caplog.clear()
    _run(_handle(text, _Stub(4), store=_store(redis)))
    assert _stats_lines(caplog) == [_stats(reason="completed", total=4, studied=4, cached=4)]


def test_a_cancelled_run_logs_the_same_line_with_zeros(caplog) -> None:
    caplog.set_level(logging.INFO)
    handle = _handle(_doc(3), _Stub(3, fail={1: JobCancelled("gone")}), concurrency=1)
    handle.start()
    try:
        with pytest.raises(JobCancelled):
            handle.result(timeout=WAIT)
    finally:
        handle.close()
    assert _stats_lines(caplog) == [_stats(reason="cancelled", workers=1)]


def test_a_run_without_a_study_logs_the_same_line_with_zeros(caplog) -> None:
    caplog.set_level(logging.INFO)

    def boom() -> str:
        raise ValueError("render failed")

    assert _run(_handle("", _Stub(1), render_text=boom)).stopped_by == "error"
    assert _run(_handle("  ", _Stub(1))).stopped_by == "completed"
    assert _stats_lines(caplog) == [_stats(reason="error"), _stats(reason="completed")]


def test_no_log_record_of_a_run_carries_the_user_the_scope_or_any_text(caplog) -> None:
    caplog.set_level(logging.DEBUG)
    secret_user = "Microsoft.Identity;secret-person-77@example.com"
    secret_scope = user_scope(secret_user)
    text = _doc(6).replace("word", "zqxsecretwindowtext", 3)
    stub = _Stub(6, fail={2: RuntimeError("model down"), 3: RuntimeError("model down")}, once_429={0})
    _run(_handle(text, stub, user_id=secret_user, scope=secret_scope, store=_store(_Redis()), breaker_failures=2))
    assert _stats_lines(caplog)
    for record in caplog.records:
        shown = f"{record.getMessage()} {record.args} {record.exc_text}"
        for private in (secret_user, secret_scope, "secret-person-77", "zqxsecretwindowtext", MODEL):
            assert private not in shown


class _DeleteRedis(_Redis):
    """Also records the thread of every delete, to show who cleaned up."""

    def __init__(self) -> None:
        super().__init__()
        self.delete_threads: set[int] = set()

    def delete(self, *keys):
        self.delete_threads.add(threading.get_ident())
        return super().delete(*keys)


def _finished_study(text: str, redis, n: int, **over) -> StudyHandle:
    """A handle whose study has completed and stored its windows."""
    handle = _handle(text, _Stub(n), store=_store(redis), **over)
    handle.start()
    assert handle.result(timeout=WAIT).stopped_by == "completed"
    assert len(_own_keys(redis, text)) == n
    return handle


def test_discard_deletes_only_this_runs_keys() -> None:
    text = _doc(3)
    redis = _Redis()
    _store(redis).run(SCOPE, MODEL, text).put(0, WindowFindings())  # an earlier run of the same user and document
    _store(redis).run(OTHER_SCOPE, MODEL, text).put(1, WindowFindings())  # another user's
    earlier = set(redis.data)
    handle = _finished_study(text, redis, 3)
    assert len(redis.data) > len(earlier)  # this run wrote windows 1 and 2
    handle.close(discard=True)
    assert set(redis.data) == earlier


def test_close_without_discard_keeps_a_completed_studys_keys() -> None:
    text = _doc(2)
    redis = _Redis()
    handle = _finished_study(text, redis, 2)
    handle.close()
    assert len(_own_keys(redis, text)) == 2


def test_discard_after_completion_cleans_up_in_the_calling_thread() -> None:
    text = _doc(2)
    redis = _DeleteRedis()
    handle = _finished_study(text, redis, 2)
    handle.close(discard=True)
    assert _own_keys(redis, text) == []
    assert redis.delete_threads == {threading.get_ident()}  # the coordinator had finished: no put can be in flight


def test_discard_overrides_an_earlier_keep_results_stop() -> None:
    text = _doc(3)
    redis = _Redis()
    stub = _Stub(3, hold={1, 2})
    handle = _handle(text, stub, store=_store(redis), concurrency=2)
    handle.start()
    try:
        _wait(redis.stored)
        _wait(stub.started[1])
        handle.stop(keep_results=True)  # "not needed any more" ...
        handle.close(discard=True)  # ... but the job then failed
    finally:
        stub.open_all()
        handle.close()
    assert _own_keys(redis, text) == []


def test_discard_while_the_coordinator_is_still_running_cleans_up_in_the_coordinator() -> None:
    text = _doc(3)
    redis = _DeleteRedis()
    stub = _Stub(3, hold={1, 2})
    handle = _handle(text, stub, store=_store(redis), concurrency=2)
    handle.start()
    try:
        _wait(redis.stored)
        _wait(stub.started[1])
        handle.close(discard=True)
    finally:
        stub.open_all()
        handle.close()
    assert _own_keys(redis, text) == []
    assert redis.delete_threads and threading.get_ident() not in redis.delete_threads
    assert threading.get_ident() not in redis.threads  # the calling thread never touched the store


def test_close_discard_twice_and_on_an_unstarted_handle_is_safe() -> None:
    handle = _handle(_doc(1), _Stub(1))
    handle.close(discard=True)  # never started: nothing to do
    text = _doc(2)
    redis = _DeleteRedis()
    handle = _finished_study(text, redis, 2)
    handle.close(discard=True)
    handle.close(discard=True)
    handle.close()
    assert _own_keys(redis, text) == []


def test_discard_with_a_coordinator_that_outlives_the_join_leaves_the_cleanup_to_it(caplog) -> None:
    text = _doc(2)
    redis = _DeleteRedis()
    gate = threading.Event()
    handle = _handle(text, _Stub(2), store=_store(redis), sleep=lambda seconds: gate.wait(WAIT))
    handle._thread = threading.Thread(target=gate.wait, args=(WAIT,), name="study-coordinator", daemon=True)
    handle._thread.start()  # a coordinator that does not end within the join
    try:
        with caplog.at_level("WARNING"):
            handle.close(join_timeout=0.01, discard=True)
        assert [r for r in caplog.records if "did not stop" in r.getMessage()]
        assert handle._discard is True and redis.threads == set()  # the calling thread did not touch the run
    finally:
        gate.set()
        handle._thread.join(WAIT)


# -- the live notices (T7): the study is visible to the user through the notice channel --


class _Notices:
    """Stands in for `study_runner.notice`: records every call with the thread that made it."""

    def __init__(self) -> None:
        self.calls: list[tuple[int, str, str, str | None, dict]] = []

    def __call__(self, kind, severity="info", *, once_key=None, with_last_item=False, **facts) -> None:
        self.calls.append((threading.get_ident(), kind, severity, once_key, facts))

    def keys(self) -> list[str | None]:
        return [call[3] for call in self.calls]

    def facts(self, once_key: str) -> dict:
        return next(call[4] for call in self.calls if call[3] == once_key)


@pytest.fixture
def notices(monkeypatch) -> _Notices:
    recorder = _Notices()
    monkeypatch.setattr(study_runner_module, "notice", recorder)
    return recorder


def test_a_small_completed_run_says_it_started_and_that_it_is_done(notices) -> None:
    _run(_handle(_doc(4), _Stub(4)))
    assert notices.keys() == ["start", "end"]
    assert {call[1] for call in notices.calls} == {"document_study"} and {call[2] for call in notices.calls} == {"info"}
    assert notices.facts("start") == {"state": "reading", "windows": 4, "cached": 0}
    assert notices.facts("end") == {"state": "done", "studied": 4, "windows": 4, "cached": 0, "split": 0, "failed": 0}


def test_a_long_document_reports_each_quarter_once_in_order(notices) -> None:
    _run(_handle(_doc(8), _Stub(8), concurrency=2))
    assert notices.keys() == ["start", "p25", "p50", "p75", "end"]
    assert [notices.facts(key) for key in ("p25", "p50", "p75")] == [
        {"state": "reading", "done": 2, "windows": 8}, {"state": "reading", "done": 4, "windows": 8},
        {"state": "reading", "done": 6, "windows": 8},
    ]


# The wizard shows the study's progress while it runs (a long document takes minutes): the runner reports each window as it is accounted for,
# in window order, whichever order the model calls finish in. Cached windows count too: they are accounted for without a call.
def test_progress_is_reported_from_zero_to_every_window_in_order() -> None:
    calls: list[tuple[int, int]] = []
    _run(_handle(_doc(3), _Stub(3), concurrency=3, on_progress=lambda done, total: calls.append((done, total))))
    assert calls == [(0, 3), (1, 3), (2, 3), (3, 3)]


def test_a_failing_progress_callback_never_breaks_the_study() -> None:
    def boom(done: int, total: int) -> None:
        raise RuntimeError("the stream is gone")

    outcome = _run(_handle(_doc(2), _Stub(2), on_progress=boom))
    assert outcome.study is not None and outcome.study.windows_studied == 2


def test_no_progress_is_reported_for_an_empty_document() -> None:
    calls: list[tuple[int, int]] = []
    _run(_handle("   ", _Stub(1), on_progress=lambda done, total: calls.append((done, total))))
    assert calls == []


def test_a_short_document_has_no_milestones(notices) -> None:
    _run(_handle(_doc(7), _Stub(7)))
    assert notices.keys() == ["start", "end"]


def test_a_breaker_stop_ends_with_a_partial_warning(notices) -> None:
    stub = _Stub(8, fail={2: RuntimeError("x"), 3: RuntimeError("x")})
    _run(_handle(_doc(8), stub, concurrency=1, breaker_failures=2))
    *_, last = notices.calls
    assert last[2:4] == ("warning", "end")
    assert last[4] == {"state": "partial", "studied": 2, "windows": 8, "cached": 0, "split": 0, "failed": 2}
    assert notices.keys().count("end") == 1


def test_a_deadline_stop_ends_with_a_partial_warning(notices) -> None:
    clock = _Clock()
    redis = _Redis()
    stub = _Stub(4, hold={1, 2, 3})
    handle = _handle(_doc(4), stub, store=_store(redis), concurrency=2, clock=clock, deadline_seconds=100.0)
    handle.start()
    try:
        _wait(redis.stored)
        _wait(stub.started[1])
        clock.now = 101.0
        handle.result(timeout=WAIT)
    finally:
        stub.open_all()
        handle.close()
    *_, last = notices.calls
    assert last[2:4] == ("warning", "end")
    assert last[4] == {"state": "partial", "studied": 1, "windows": 4, "cached": 0, "split": 0, "failed": 0}


def test_a_fully_cached_resume_says_only_that_it_is_done(notices) -> None:
    text = _doc(8)
    redis = _Redis()
    _run(_handle(text, _Stub(8), store=_store(redis)))
    notices.calls.clear()
    stub = _Stub(8)
    _run(_handle(text, stub, store=_store(redis)))
    assert stub.calls == []
    assert notices.keys() == ["end"]
    assert notices.facts("end") == {"state": "done", "studied": 8, "windows": 8, "cached": 8, "split": 0, "failed": 0}


def test_a_partly_cached_resume_names_the_cached_windows_at_the_start(notices) -> None:
    text = _doc(4)
    redis = _Redis()
    _run(_handle(text, _Stub(4), store=_store(redis)))
    del redis.data[_own_keys(redis, text)[2]]
    notices.calls.clear()
    _run(_handle(text, _Stub(4), store=_store(redis)))
    assert notices.keys() == ["start", "end"]
    assert notices.facts("start") == {"state": "reading", "windows": 4, "cached": 3}


def test_a_cancelled_run_emits_no_finish_notice(notices) -> None:
    handle = _handle(_doc(3), _Stub(3, fail={1: JobCancelled("gone")}), concurrency=1)
    handle.start()
    try:
        with pytest.raises(JobCancelled):
            handle.result(timeout=WAIT)
    finally:
        handle.close()
    assert notices.keys() == ["start"]  # the job is ending: no finish row


def test_a_run_that_announced_nothing_and_has_no_study_emits_no_finish_notice(notices) -> None:
    assert _run(_handle(_doc(2), _Stub(2), store=_BrokenStore())).stopped_by == "error"  # fails before the start notice
    assert _run(_handle("  \n ", _Stub(1))).stopped_by == "completed"  # blank: nothing to read
    assert notices.calls == []


def test_an_error_after_the_start_notice_ends_with_a_partial_warning_of_zeros(notices, monkeypatch) -> None:
    def broken(results):
        raise RuntimeError("merge failed")

    monkeypatch.setattr(study_runner_module, "merge_findings", broken)
    outcome = _run(_handle(_doc(4), _Stub(4)))
    assert outcome.stopped_by == "error" and outcome.study is None
    assert notices.keys() == ["start", "end"]
    *_, last = notices.calls
    assert last[2:4] == ("warning", "end")
    assert last[4] == {"state": "partial", "studied": 0, "windows": 4, "cached": 0, "split": 0, "failed": 0}


def test_a_run_that_read_nothing_after_announcing_ends_with_a_partial_warning(notices) -> None:
    stub = _Stub(3, fail={i: RuntimeError("x") for i in range(3)})
    outcome = _run(_handle(_doc(3), stub, concurrency=1, breaker_failures=2))
    assert outcome.study is None
    *_, last = notices.calls
    assert last[2:4] == ("warning", "end")
    assert last[4] == {"state": "partial", "studied": 0, "windows": 3, "cached": 0, "split": 0, "failed": 0}
    assert notices.keys().count("end") == 1


def test_a_stop_because_nothing_needed_proposals_ends_with_an_info_stopped_notice(notices) -> None:
    text = _doc(4)
    redis = _Redis()
    stub = _Stub(4, hold={1, 2, 3})
    handle = _handle(text, stub, store=_store(redis), concurrency=2)
    handle.start()
    try:
        _wait(redis.stored)
        _wait(stub.started[1])
        handle.stop(keep_results=True)
        outcome = handle.result(timeout=WAIT)
    finally:
        stub.open_all()
        handle.close()
    assert outcome.stopped_by == "stopped"
    *_, last = notices.calls
    assert last[2:4] == ("info", "end")
    assert last[4] == {"state": "stopped", "studied": 1, "windows": 4, "cached": 0}
    assert notices.keys().count("end") == 1


def test_notice_facts_are_integers_and_short_enums_from_the_coordinator_thread_only(notices) -> None:
    text = _doc(8)
    stub = _Stub(8, fail={5: RuntimeError("x")})
    caller = threading.get_ident()
    handle = _handle(text, stub, concurrency=3, user_id=USER)
    handle.start()
    coordinator = handle._thread.ident
    try:
        handle.result(timeout=WAIT)
    finally:
        handle.close()
    assert notices.calls
    assert {call[0] for call in notices.calls} == {coordinator} and coordinator != caller
    for _, _, _, once_key, facts in notices.calls:
        assert len(facts) <= 6
        for key, value in facts.items():
            assert isinstance(value, (int, bool)) or (key == "state" and value in {"reading", "done", "partial", "stopped"})
        blob = repr((once_key, facts))
        assert not any(secret in blob for secret in (USER, SCOPE, MODEL, "S00", "word"))


def test_the_notices_come_from_a_run_with_no_job_in_scope_without_error() -> None:
    outcome = _run(_handle(_doc(2), _Stub(2)))  # the real `notice`: no job is in scope, so it is a no-op
    assert outcome.stopped_by == "completed"


def _headed_doc(n: int) -> str:
    """`n` windows exactly, each opening with its own heading line and marker, so a report can name the sections that were not read."""
    return "".join((f"# {i + 1}.0 Part {i}\nS{i:03d} " + "word " * 4000)[:19500] for i in range(n))


def test_an_unread_window_is_reported_by_part_and_section_never_as_a_finished_study() -> None:
    handle = _handle(_headed_doc(4), _Stub(4, fail={1: _status_504(), 2: _status_504()}), concurrency=1)
    outcome = _run(handle)
    message = next(w for w in outcome.warnings if "2 of 4" in w)
    assert "Not read: parts 2-3" in message
    assert "2.0 Part 1" in message and "3.0 Part 2" in message
    assert "1.0 Part 0" not in message and "4.0 Part 3" not in message


def test_separate_unread_runs_are_listed_separately() -> None:
    handle = _handle(_headed_doc(5), _Stub(5, fail={1: _status_504(), 3: _status_504()}), concurrency=1)
    message = next(w for w in _run(handle).warnings if "3 of 5" in w)
    assert "part 2" in message and "part 4" in message and "parts" not in message.split("Not read:")[1].split(";")[0]


def test_windows_never_reached_because_the_study_stopped_count_as_unread(monkeypatch) -> None:
    monkeypatch.setattr(study_document_module.settings, "survey_study_breaker_failures", 2)
    handle = _handle(_headed_doc(5), _Stub(5, fail={0: _status_504(), 1: _status_504()}), concurrency=1, breaker_failures=2)
    outcome = _run(handle)
    assert outcome.study is None or any("Not read: parts 1-5" in w or "none of the document" in w for w in outcome.warnings)


def test_the_unread_report_names_sections_by_a_short_label_even_when_headings_are_whole_sentences() -> None:
    long_heading = "The Backplane Mezzanine (BP_MEZ) board shall support twelve independent channels at once"
    text = "".join((f"# {long_heading} {i}\nS{i:03d} " + "word " * 4000)[:19500] for i in range(3))
    outcome = _run(_handle(text, _Stub(3, fail={1: _status_504()}), concurrency=1))
    message = next(w for w in outcome.warnings if "2 of 3" in w)
    assert "The Backplane Mezzanine" in message
    assert "independent channels" not in message  # cut to a short label, with an ellipsis
    assert "…" in message
