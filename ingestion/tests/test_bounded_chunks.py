import threading
import time

from app.leveling.bounded_chunks import ChunkOutcome, run_chunks_bounded


def test_serial_when_concurrency_is_one_and_never_constructs_an_executor() -> None:
    # concurrency<=1 must be the byte-identical old code path: one call at a
    # time, on the CALLING thread -- the same "zero new risk for every
    # deployment that hasn't opted in" guarantee llm_leveling.py's own
    # branch-concurrency guard gives (see its comment at line 2331).
    calling_thread = threading.current_thread().name
    threads: list[str] = []

    def worker(chunk: int) -> int:
        threads.append(threading.current_thread().name)
        return chunk * 2

    outcomes = list(run_chunks_bounded([1, 2, 3], worker, concurrency=1))

    assert [o.value for o in outcomes] == [2, 4, 6]
    assert threads == [calling_thread, calling_thread, calling_thread]


def test_runs_chunks_genuinely_concurrently() -> None:
    # Thread-name-set idiom, copied from this repo's existing
    # concurrency proof (test_llm_leveling.py's
    # test_mapping_runs_branches_concurrently_at_the_same_parallelism_as_its_neighbours):
    # a sleep long enough that a serial run could only ever use one thread,
    # asserted on the CARDINALITY of the distinct thread names -- not on
    # elapsed time, which is flaky on a loaded CI box.
    seen: set[str] = set()
    lock = threading.Lock()

    def worker(chunk: int) -> int:
        with lock:
            seen.add(threading.current_thread().name)
        time.sleep(0.05)
        return chunk

    list(run_chunks_bounded([1, 2, 3, 4], worker, concurrency=4))

    assert len(seen) > 1


def test_never_exceeds_the_requested_concurrency() -> None:
    in_flight = 0
    max_in_flight = 0
    lock = threading.Lock()

    def worker(chunk: int) -> int:
        nonlocal in_flight, max_in_flight
        with lock:
            in_flight += 1
            max_in_flight = max(max_in_flight, in_flight)
        time.sleep(0.05)
        with lock:
            in_flight -= 1
        return chunk

    list(run_chunks_bounded(list(range(8)), worker, concurrency=2))

    assert max_in_flight <= 2


def test_returns_outcomes_in_submission_order_even_when_chunk_zero_finishes_last() -> None:
    # The real risk: chunk 0 is submitted FIRST but artificially delayed so
    # chunk 2 genuinely completes first. Outcomes must still come back in
    # submission order -- the same guarantee llm_leveling.py's own
    # "results are gathered by INDEX, never by completion order" comment
    # (line 3804) makes for branch batches.
    def worker(chunk: int) -> int:
        if chunk == 0:
            time.sleep(0.2)
        return chunk

    outcomes = list(run_chunks_bounded([0, 1, 2], worker, concurrency=3))

    assert [o.chunk_index for o in outcomes] == [0, 1, 2]
    assert [o.value for o in outcomes] == [0, 1, 2]


def test_a_worker_exception_comes_back_as_data_and_never_propagates() -> None:
    # Fail-soft per chunk: every pass that uses this helper already catches
    # its own client call's exception, appends an IntegrityWarning, and
    # continues to the next chunk. The helper must not turn that into a
    # fail-fast raise.
    boom = RuntimeError("boom")

    def worker(chunk: int) -> int:
        if chunk == 1:
            raise boom
        return chunk

    outcomes = list(run_chunks_bounded([0, 1, 2], worker, concurrency=3))

    assert outcomes[0] == ChunkOutcome(chunk_index=0, value=0, error=None)
    assert outcomes[1].chunk_index == 1
    assert outcomes[1].value is None
    assert outcomes[1].error is boom
    assert outcomes[2] == ChunkOutcome(chunk_index=2, value=2, error=None)


def test_a_worker_exception_at_concurrency_one_also_comes_back_as_data() -> None:
    def worker(chunk: int) -> int:
        raise ValueError(f"no {chunk}")

    outcomes = list(run_chunks_bounded([7], worker, concurrency=1))

    assert isinstance(outcomes[0].error, ValueError)
    assert str(outcomes[0].error) == "no 7"


def test_empty_chunk_list_is_a_no_op() -> None:
    def worker(chunk: int) -> int:
        raise AssertionError("must never be called")

    assert list(run_chunks_bounded([], worker, concurrency=4)) == []


def test_is_lazy_so_a_caller_can_narrate_between_chunks() -> None:
    # Every caller fires its per-chunk progress event immediately before
    # pulling that chunk's outcome. An eager helper would run all the work
    # first, forcing every one of those events to fire back-to-back before
    # the first call -- the "progress bar jumps to ~94% then freezes"
    # regression. Nothing may run before the first pull, and pulling chunk
    # N must not have run chunk N+1 at concurrency 1.
    calls: list[int] = []

    outcomes = run_chunks_bounded([0, 1, 2], calls.append, concurrency=1)

    assert calls == []
    next(outcomes)
    assert calls == [0]
    next(outcomes)
    assert calls == [0, 1]


def test_a_worker_returning_none_is_not_confused_with_a_failure() -> None:
    outcomes = list(run_chunks_bounded([0], lambda chunk: None, concurrency=4))

    assert outcomes[0].value is None
    assert outcomes[0].error is None
