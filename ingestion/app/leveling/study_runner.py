"""The document study (app.leveling.document_study) reading its windows several at a time, in the background of the job.

A `StudyHandle` runs the whole study in ONE coordinator thread, so the job's own thread is free to carry on. The document is rendered once,
on the job's own thread, as a snapshot before any stage runs (`render_text` just returns that string). The coordinator reads the windows the store has not got with up to `concurrency` worker threads, but takes their outcomes in
WINDOW ORDER, never in completion order: it stores, counts, trips the circuit breaker and merges exactly as the sequential
`study_document` does, so the study is the same whatever the order the model answered in. A 429 means the job's own scoring and authoring
calls share the proxy's rate limit, so the study then lowers its workers by one (never below one). Pressure that has passed is forgiven: after `_RECOVERY_CLEAN_WINDOWS`
consumed windows in a row without a 429 it raises them by one, never above the configured concurrency.

Stopping: the coordinator makes its own child `CancelToken` (app.job_cancel) and runs everything under it, so workers stop at their next
model call. It polls the job's token and the handle's stop flag about once a second and cancels the child when either fires; the child never
cancels the job's token. A stopped run discards the results of windows still in flight (they were never stored) and does not wait for a
model call that is under way: that call ends by itself and gives its lease back.
The coordinator is a daemon thread: a process that is exiting never waits for a study (its keys expire by their TTL).

Thread use, which is what keeps this free of locks:
- only the coordinator calls the StudyRun (`get`, `put`, `cleanup`): a run is single-thread by contract. The caller's thread never cleans up
  either, since a `put` still in flight could re-create a key after it. The one exception: `close(discard=True)` on a coordinator that has
  already ended (joined, so no `put` can be in flight) cleans up from the calling thread;
- workers only call the model, through `LeasedStudyClient` and `read_window`, and each returns an immutable `WindowRead`; they share no
  mutable state (the lease limiter is thread-safe, `merge_findings` is pure);
- the coordinator's own data (results, counts, futures) is touched by no other thread;
- the outcome is handed over through one `Event`. The caller turns its plain `warnings` into the job's IntegrityWarnings; the coordinator
  never touches the job's warning list;
- no log line carries the raw user id or a key.

The user sees the study through the live notice channel (kind `document_study`), sent from the coordinator thread only, a handful per job
(a start, at most three milestones, one finish), each with a `once_key`. Facts are integers and short enums: never document text, a user,
a scope, a key or a model.

Fail open, like the sequential study: a worker that fails unexpectedly is one failed window and the run carries on; only `JobCancelled`
ends the run, and `result` raises only that. Anything else the coordinator hits comes back as an outcome with no study."""
from __future__ import annotations

import contextvars
import logging
import random
import threading
import time
from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from typing import TYPE_CHECKING

from app.config import settings
from app.job_cancel import CancelToken, JobCancelled, cancellation_scope, current_token, raise_if_cancelled, submit_in_context
from app.kb.profile import windows_of
from app.leveling.document_study import (
    STUDY_WINDOW_CHARS, STUDY_WINDOW_OVERLAP, DocumentStudy, DocumentStudyClient, StudyReadStats, WindowFindings, WindowRead,
    _cancellable_sleep, merge_findings, read_window,
)
from app.leveling.live_context import notice

if TYPE_CHECKING:
    from app.leveling.llm_lease_limiter import LeaseLimiter
    from app.leveling.study_store import StudyRun, StudyStore

logger = logging.getLogger(__name__)

_POLL_SECONDS = 1.0  # how often the coordinator looks at the stop flag, the job's token and the deadline while waiting for a window
_RESULT_GRACE_SECONDS = 5.0  # how long `result` waits for the coordinator to wind down after a timeout
# What a run that ended early removes: the keys it wrote, unless something asked to keep them.
_DISCARDING = ("stopped", "cancelled", "error")
_MILESTONES = ((1, "p25"), (2, "p50"), (3, "p75"))  # quarters of the windows consumed; reported only for a document of this many windows
_MILESTONE_MIN_WINDOWS = 8
_RECOVERY_CLEAN_WINDOWS = 8  # consecutive consumed windows without a 429 that win back one worker


class StudyDeadlineExceeded(Exception):
    """Raised at a model attempt of a study whose time budget is spent."""


@dataclass(frozen=True)
class StudyOutcome:
    """`warnings` are plain messages for the caller to turn into the job's warnings; `stopped_by` is one of completed, breaker, deadline,
    stopped (asked to stop), cancelled (the job's run was cancelled) or error."""
    study: DocumentStudy | None
    warnings: tuple[str, ...]
    stopped_by: str


@dataclass(frozen=True)
class _Read:
    read: WindowRead
    deadline_exceeded: bool  # the read ended on the time budget, not on the model: it counts as neither a failure nor a read


class LeasedStudyClient:
    """A study client that holds a lease (app.leveling.llm_lease_limiter) for each model ATTEMPT, so a window's 429 back-off sleep holds no slot.
    Waiting for a lease is back-pressure, not a failure: it goes on until a lease is had, the run is cancelled (JobCancelled) or the study
    deadline passes (StudyDeadlineExceeded). One instance serves one window read, so `deadline_exceeded` is never shared between threads."""

    def __init__(
        self, inner: DocumentStudyClient, limiter: LeaseLimiter | None, model: str | None, scope: str,
        deadline_clock: Callable[[], float], deadline: float, max_wait: float,
    ) -> None:
        self._inner = inner
        self._limiter = limiter
        self._model = model
        self._scope = scope
        self._clock = deadline_clock
        self._deadline = deadline
        self._max_wait = max_wait
        self.deadline_exceeded = False

    def _time_left(self) -> float:
        left = self._deadline - self._clock()
        if left <= 0:
            self.deadline_exceeded = True
            raise StudyDeadlineExceeded("the study's time budget is spent")
        return left

    def study_document_window(self, window_text: str, user_id: str | None = None) -> dict:
        raise_if_cancelled()
        left = self._time_left()
        if self._limiter is None:
            return self._inner.study_document_window(window_text, user_id=user_id)
        while True:
            lease = self._limiter.acquire(self._model, self._scope, max_wait_seconds=min(self._max_wait, left))
            if lease is not None:
                break
            raise_if_cancelled()  # no lease within the wait: keep waiting, unless the run is cancelled or out of time
            left = self._time_left()
        try:
            return self._inner.study_document_window(window_text, user_id=user_id)
        finally:
            lease.release()


class _Dispatch:
    """The coordinator's sliding window of reads: windows are submitted in index order, at most `workers` unfinished at once and at most
    `lookahead` submitted but not yet consumed."""

    def __init__(self, submit: Callable[[int], Future], pending: list[int], lookahead: int) -> None:
        self._submit = submit
        self._pending = pending
        self._lookahead = lookahead
        self._next = 0
        self._futures: dict[int, Future] = {}

    def fill(self, workers: int) -> None:
        while self._next < len(self._pending):
            running = sum(1 for future in self._futures.values() if not future.done())
            if running >= workers or len(self._futures) >= self._lookahead:
                return
            index = self._pending[self._next]
            self._futures[index] = self._submit(index)
            self._next += 1

    def done(self, index: int) -> bool:
        future = self._futures.get(index)
        return future is not None and future.done()

    def take(self, index: int) -> Future:
        return self._futures.pop(index)

    def wait_for_progress(self, timeout: float) -> None:
        running = [future for future in self._futures.values() if not future.done()]
        if running:
            wait(running, timeout=timeout, return_when=FIRST_COMPLETED)

    def cancel_waiting(self) -> None:
        for future in self._futures.values():
            future.cancel()


class StudyHandle:
    def __init__(
        self, *, render_text: Callable[[], str], client: DocumentStudyClient, user_id: str | None, scope: str, model: str | None,
        store: StudyStore | None, limiter: LeaseLimiter | None, concurrency: int, lookahead: int, deadline_seconds: float,
        soft_budget_seconds: float, breaker_failures: int, max_windows: int, lease_max_wait_seconds: float,
        sleep: Callable[[float], None] = _cancellable_sleep, rng: random.Random | None = None,
        clock: Callable[[], float] = time.monotonic, poll_seconds: float = _POLL_SECONDS,
    ) -> None:
        self._render_text = render_text
        self._client = client
        self._user_id = user_id
        self._scope = scope
        self._model = model
        self._store = store
        self._limiter = limiter
        self._concurrency = concurrency
        self._lookahead = lookahead
        self._deadline_seconds = deadline_seconds
        self._soft_budget_seconds = soft_budget_seconds
        self._breaker_failures = breaker_failures
        self._max_windows = max_windows
        self._lease_max_wait_seconds = lease_max_wait_seconds
        self._sleep = sleep
        self._rng = rng or random.Random()  # shared by the workers: its methods are atomic under the GIL
        self._clock = clock
        self._poll_seconds = poll_seconds
        self._workers = concurrency
        self._thread: threading.Thread | None = None
        self._parent: CancelToken | None = None
        self._started_at = 0.0
        self._stop = threading.Event()
        self._keep_results = False  # set before the stop flag; True is final, since a study already handed out was built from those keys
        self._discard = False  # set by close(discard=True) before the stop flag: the job failed or was cancelled, so the keys go whatever was kept
        self._done = threading.Event()
        self._outcome = StudyOutcome(None, (), "error")
        self._run: StudyRun | None = None  # the coordinator's alone
        self._announced = False  # a start or milestone notice was sent: the finish notice must then replace that row (the coordinator's alone)
        self._windows_total = 0  # the coordinator's alone

    @classmethod
    def from_settings(
        cls, *, render_text: Callable[[], str], client: DocumentStudyClient, user_id: str | None, scope: str, model: str | None,
        store: StudyStore | None, limiter: LeaseLimiter | None, **overrides,
    ) -> StudyHandle:
        return cls(
            render_text=render_text, client=client, user_id=user_id, scope=scope, model=model, store=store, limiter=limiter,
            concurrency=settings.survey_study_concurrency, lookahead=settings.survey_study_lookahead,
            deadline_seconds=settings.survey_study_hard_budget_seconds, soft_budget_seconds=settings.survey_study_soft_budget_seconds,
            breaker_failures=settings.survey_study_breaker_failures, max_windows=settings.survey_study_max_windows,
            lease_max_wait_seconds=float(settings.survey_study_lease_max_wait_seconds), **overrides,
        )

    @property
    def current_workers(self) -> int:
        return self._workers

    def start(self) -> None:
        """Starts the coordinator under a copy of the caller's context (the job's emitters and log correlation) and its cancel token. The
        deadline counts from here."""
        if self._thread is not None:
            raise RuntimeError("the study has already been started")
        self._parent = current_token()
        self._started_at = self._clock()
        self._thread = threading.Thread(
            target=contextvars.copy_context().run, args=(self._coordinate,), name="study-coordinator", daemon=True,
        )
        self._thread.start()

    def stop(self, keep_results: bool) -> None:
        """Asks the study to stop. keep_results=True ("not needed any more"): what was stored stays as the cache. False ("cancelled or
        failed"): the coordinator deletes the keys it wrote, in its own thread."""
        if keep_results:
            self._keep_results = True
        self._stop.set()

    def result(self, timeout: float | None = None) -> StudyOutcome:
        """Blocks until the study is done. On timeout it stops the study (keeping what was stored) and returns what was read so far. Raises
        only JobCancelled, when the job's run was cancelled; any other failure is an outcome with no study."""
        if self._thread is None:
            raise RuntimeError("the study has not been started")
        if not self._done.wait(timeout):
            self.stop(keep_results=True)
            if not self._done.wait(_RESULT_GRACE_SECONDS):
                return StudyOutcome(None, ("The document study did not finish in time and was left unread.",), "stopped")
        if self._outcome.stopped_by == "cancelled":
            raise JobCancelled("the run was cancelled: its caller is gone")
        return self._outcome

    def close(self, join_timeout: float = 30.0, discard: bool = False) -> None:
        """For the owner's `finally`: stops a study that is still running (and has its keys removed), then waits for the coordinator.
        discard=True (the job was cancelled or failed): the keys this run wrote are removed even if the study had finished or was told to keep
        them; a finished study's keys are otherwise the re-run cache."""
        if self._thread is None:
            return
        if discard:
            self._discard = True  # before the stop flag, so a coordinator that ends because of it sees it
        if not self._done.is_set():
            self.stop(keep_results=False)
        self._thread.join(join_timeout)
        if self._thread.is_alive():
            logger.warning("Document study: the coordinator did not stop within %ss.", join_timeout)
        elif discard and self._run is not None:
            self._run.cleanup()  # the coordinator has ended, so no put is in flight; idempotent

    # -- everything below runs in the coordinator thread --

    def _coordinate(self) -> None:
        outcome = StudyOutcome(None, ("The document study stopped unexpectedly.",), "error")
        try:
            with cancellation_scope(CancelToken()) as child:
                outcome = self._study(child)
        except JobCancelled:
            outcome = StudyOutcome(None, (), "cancelled")
        except Exception as error:  # noqa: BLE001 -- the study is context only: the caller carries on without it
            logger.warning("Document study failed (%s); carrying on without it.", type(error).__name__)
            outcome = StudyOutcome(None, ("The document study stopped unexpectedly.",), "error")
        finally:
            try:
                if self._run is not None and ((outcome.stopped_by in _DISCARDING and not self._keep_results) or self._discard):
                    self._run.cleanup()
            finally:
                self._log_statistics(outcome)
                self._announce_finish(outcome)
                self._outcome = outcome
                self._done.set()

    def _log_statistics(self, outcome: StudyOutcome) -> None:
        """One line per run, only numbers, booleans and the stop reason: no user, scope, key, model or text. A run with no study has zeros."""
        study = outcome.study
        stats = study.read_stats if study else StudyReadStats()
        logger.info(
            "Document study finished: stopped_by=%s windows_total=%d studied=%d cached=%d retried=%d split=%d failed=%d breaker_opened=%s "
            "budget_stopped=%s seconds=%.1f workers_final=%d",
            outcome.stopped_by, study.windows_total if study else 0, study.windows_studied if study else 0, stats.windows_cached,
            stats.windows_retried, stats.windows_split, stats.windows_failed, stats.breaker_opened, stats.budget_stopped,
            self._clock() - self._started_at, self._workers,
        )

    def _announce_finish(self, outcome: StudyOutcome) -> None:
        """The one finish notice, so the one row of the run never stays on "reading". Sent for every outcome except a cancelled one (the job
        is ending) and a run that announced nothing and has no study."""
        study = outcome.study
        if outcome.stopped_by == "cancelled" or (study is None and not self._announced):
            return
        if outcome.stopped_by == "error" or (study is None and outcome.stopped_by != "stopped"):  # failed, or announced reading and read nothing
            notice("document_study", "warning", once_key="end", state="partial", studied=0, windows=study.windows_total if study else self._windows_total,
                   cached=0, split=0, failed=0)
            return
        stats = study.read_stats if study else StudyReadStats()
        studied, total = (study.windows_studied, study.windows_total) if study else (0, self._windows_total)
        if outcome.stopped_by == "stopped":  # asked to stop (nothing needed proposals): what was read stays as the cache
            notice("document_study", once_key="end", state="stopped", studied=studied, windows=total, cached=stats.windows_cached)
            return
        complete = studied >= total
        notice(
            "document_study", "info" if complete else "warning", once_key="end", state="done" if complete else "partial",
            studied=studied, windows=total, cached=stats.windows_cached, split=stats.windows_split, failed=stats.windows_failed,
        )

    def _stop_reason(self) -> str | None:
        if self._parent is not None and self._parent.cancelled:
            return "cancelled"
        if self._stop.is_set():
            return "stopped"
        if self._clock() - self._started_at >= self._deadline_seconds:
            return "deadline"
        return None

    def _read_one(self, window: str) -> _Read:
        """Runs in a worker thread."""
        deadline = self._started_at + self._deadline_seconds
        leased = LeasedStudyClient(
            self._client, self._limiter, self._model, self._scope, self._clock, deadline, self._lease_max_wait_seconds,
        )
        try:
            read = read_window(leased, window, self._user_id, self._sleep, self._rng)
        except JobCancelled:
            raise
        except Exception as error:  # noqa: BLE001 -- one window's unexpected failure is data: that window is failed, the run goes on
            logger.warning("Document study: a window could not be read (%s); skipping it.", type(error).__name__)
            read = WindowRead(None, failed=True)
        return _Read(read, leased.deadline_exceeded)

    def _study(self, child: CancelToken) -> StudyOutcome:
        text = self._render_text()
        if not text.strip():
            return StudyOutcome(None, (), "completed")
        all_windows = windows_of(text, STUDY_WINDOW_CHARS, STUDY_WINDOW_OVERLAP)
        self._windows_total = len(all_windows)
        windows = all_windows[:self._max_windows]
        run = self._run = self._store.run(self._scope, self._model, text) if self._store is not None else None
        cached: dict[int, WindowFindings] = {}
        if run is not None:
            for index in range(len(windows)):
                if self._stop_reason() is not None:  # a slow store must not keep the thread alive: the windows left are simply uncached
                    break
                stored = run.get(index)
                if stored is not None:
                    cached[index] = stored
        results: list[tuple[int, WindowFindings]] = []
        studied = retried = split = failed = consecutive = clean = 0
        reason: str | None = None
        soft_warned = False
        announced: set[str] = set()  # the milestones already sent
        if len(cached) < len(windows):  # a fully cached run says nothing until it is done
            self._announced = True
            notice("document_study", once_key="start", state="reading", windows=len(all_windows), cached=len(cached))
        executor = ThreadPoolExecutor(max_workers=self._concurrency, thread_name_prefix="study-worker")
        dispatch = _Dispatch(
            lambda index: submit_in_context(executor, self._read_one, windows[index]),
            [index for index in range(len(windows)) if index not in cached], self._lookahead,
        )
        try:
            for index in range(len(windows)):
                if index in cached:  # no model call, no budget, no wait; a cached window resets the breaker
                    results.append((index, cached[index]))
                    studied += 1
                    consecutive = 0
                    continue
                while reason is None:
                    reason = self._stop_reason()
                    if reason == "deadline" and dispatch.done(index):
                        reason = None  # finished work is not discarded because the deadline passed in the same pass
                        break
                    if reason is not None:
                        break
                    if not soft_warned and self._clock() - self._started_at >= self._soft_budget_seconds:
                        soft_warned = True
                        logger.warning("Document study: past %ss and still reading (window %d of %d).",
                                       self._soft_budget_seconds, index + 1, len(all_windows))
                    dispatch.fill(self._workers)
                    if dispatch.done(index):
                        break
                    dispatch.wait_for_progress(self._poll_seconds)
                if reason == "cancelled":
                    raise JobCancelled("the run was cancelled: its caller is gone")
                if reason is not None:  # stopped: only the store is consulted for the rest
                    child.cancel()
                    dispatch.cancel_waiting()
                    continue
                outcome = dispatch.take(index).result()  # JobCancelled from a worker ends the run
                if outcome.deadline_exceeded:
                    reason = "deadline"
                    child.cancel()
                    dispatch.cancel_waiting()
                    continue
                read = outcome.read
                retried += read.retries > 0
                split += read.split
                failed += read.failed
                if read.retries > 0:  # 429: the job's own calls share the proxy's rate limit, so ease off
                    self._workers = max(1, self._workers - 1)
                    clean = 0
                else:  # a streak of calm windows (cached ones are not counted) wins a worker back, one at a time
                    clean += 1
                    if clean >= _RECOVERY_CLEAN_WINDOWS:
                        clean = 0
                        self._workers = min(self._concurrency, self._workers + 1)
                findings = read.findings
                if findings is not None and run is not None and not read.failed:
                    findings = run.put(index, findings)  # the first writer's findings win, so concurrent jobs agree
                if findings is not None:
                    results.append((index, findings))
                if read.failed:
                    consecutive += 1
                    if consecutive >= self._breaker_failures:
                        logger.warning("Document study: %d windows in a row could not be read; stopping the study.", consecutive)
                        reason = "breaker"
                        child.cancel()
                        dispatch.cancel_waiting()
                else:
                    studied += 1
                    consecutive = 0
                if len(all_windows) >= _MILESTONE_MIN_WINDOWS:
                    for quarter, key in _MILESTONES:
                        if key not in announced and (index + 1) * 4 >= len(all_windows) * quarter:
                            announced.add(key)
                            self._announced = True
                            notice("document_study", once_key=key, state="reading", done=index + 1, windows=len(all_windows))
            if reason is None:
                executor.shutdown(wait=True)  # every window was consumed: nothing is running
        except BaseException:
            child.cancel()
            dispatch.cancel_waiting()
            raise
        finally:
            executor.shutdown(wait=False, cancel_futures=True)  # never waits for a model call that is under way: it ends by itself
        return self._outcome_of(results, all_windows, studied, (retried, split, failed, len(cached)), reason)

    def _outcome_of(
        self, results: list[tuple[int, WindowFindings]], all_windows: list[str], studied: int, counts: tuple[int, int, int, int],
        reason: str | None,
    ) -> StudyOutcome:
        retried, split, failed, cached = counts
        warnings: list[str] = []
        if not results:
            study = None
            warnings.append("The document study read none of the document, so proposals used the hierarchy alone.")
        else:
            study = merge_findings(results)
            study.windows_studied = studied  # a window with only one half read keeps its findings but does not count as studied
            study.windows_total = len(all_windows)
            study.read_stats = StudyReadStats(retried, split, failed, reason == "breaker", reason == "deadline", cached)
            if studied < len(all_windows):
                warnings.append(f"The document study read {studied} of {len(all_windows)} parts of the document.")
        if reason == "breaker":
            warnings.append(f"The document study stopped after {self._breaker_failures} parts in a row could not be read.")
        elif reason == "deadline":
            warnings.append("The document study stopped because its time budget was spent.")
        return StudyOutcome(study, tuple(warnings), reason or "completed")
