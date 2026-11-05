"""Stopping the work of a run nobody is waiting for any more.

`/level` runs for many minutes. When its caller goes away (the orchestrator's request timed out, the worker restarted, the job
was cancelled) the route used to keep going to the end: every remaining scoring, regrouping and trace-link call still hit the
model, and those calls starved the next jobs of the same model. The route now watches for the disconnect and marks its run
cancelled; the next model call of that run raises `JobCancelled`, so the rest of the run costs nothing.

The flag belongs to ONE request: a `CancelToken` kept in a contextvar for the duration of the route. It is deliberately not
keyed by job id. A re-run of the same job id (BullMQ reprocessing a stalled job) can start while the abandoned run is still
winding down on an in-flight call, and must not inherit its cancellation. The contextvar reaches the threadpool (starlette
copies the context) and the bounded chunk workers (they run under a copy of it), so no parameter is threaded through.

`JobCancelled` is an ordinary exception on purpose: stages already treat a failed call as fail-open and move on, so the
remaining calls of a cancelled run each raise at once and the run winds down in moments."""
from __future__ import annotations

import asyncio
import contextvars
import threading
import time
from collections.abc import Iterator
from contextlib import asynccontextmanager, contextmanager
from typing import Protocol


class JobCancelled(Exception):
    """Raised at a model call of a run whose caller has gone away."""


class CancelToken:
    def __init__(self) -> None:
        self.cancelled = False
        self._callbacks: list = []
        self._lock = threading.Lock()

    def cancel(self) -> None:
        with self._lock:
            if self.cancelled:
                return
            self.cancelled = True
            callbacks, self._callbacks = self._callbacks, []
        for callback in callbacks:
            try:
                callback()
            except Exception:  # noqa: BLE001 -- closing a call that already ended must not stop the others
                pass

    def on_cancel(self, callback):
        """Runs `callback` when the token is cancelled (at once if it already is), and returns a function that removes it.

        This is how a call that is already in flight (a blocking HTTP request in a worker thread) is stopped: the call
        registers `client.close` here for the duration of the request."""
        with self._lock:
            if not self.cancelled:
                self._callbacks.append(callback)
                return lambda: self._remove(callback)
        callback()
        return lambda: None

    def _remove(self, callback) -> None:
        with self._lock:
            if callback in self._callbacks:
                self._callbacks.remove(callback)


_token_var: contextvars.ContextVar[CancelToken | None] = contextvars.ContextVar("_cancel_token_var", default=None)


@contextmanager
def cancellation_scope(token: CancelToken | None = None) -> Iterator[CancelToken]:
    """One run's cancellation: model calls made inside (including in worker threads started from it) honour its token.

    A token made beforehand can be installed (a streamed run is cancelled from the stream's side, which has to hold the token)."""
    token = token if token is not None else CancelToken()
    reset = _token_var.set(token)
    try:
        yield token
    finally:
        _token_var.reset(reset)


def current_token() -> CancelToken | None:
    return _token_var.get()


def sleep(seconds: float, slice_seconds: float = 0.25) -> None:
    """time.sleep that a cancel ends at once: it raises JobCancelled before each slice once the run is cancelled."""
    deadline = time.monotonic() + seconds
    while True:
        raise_if_cancelled()
        left = deadline - time.monotonic()
        if left <= 0:
            return
        time.sleep(min(slice_seconds, left))


def raise_if_cancelled() -> None:
    """Called before every model call. Outside a scope (chat, rescoring, scripts) it never raises."""
    token = _token_var.get()
    if token is not None and token.cancelled:
        raise JobCancelled("the run was cancelled: its caller is gone")


class _Disconnectable(Protocol):
    async def is_disconnected(self) -> bool: ...


@asynccontextmanager
async def watch_for_disconnect(request: _Disconnectable, token: CancelToken, poll_seconds: float = 2.0):
    """Within the block, cancels `token` as soon as the request's client disconnects."""
    # Stopped with a flag, not task.cancel(): Starlette's is_disconnected() runs inside an anyio cancel scope that can swallow
    # a plain asyncio cancellation, which left the watcher looping and the request hanging.
    stop = asyncio.Event()

    async def watch() -> None:
        while not stop.is_set():
            if await request.is_disconnected():
                token.cancel()
                return
            try:
                await asyncio.wait_for(stop.wait(), timeout=poll_seconds)
            except asyncio.TimeoutError:
                pass

    task = asyncio.create_task(watch())
    try:
        yield
    finally:
        stop.set()
        try:
            await asyncio.wait_for(task, timeout=5)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            task.cancel()


def submit_in_context(executor, fn, /, *args, **kwargs):
    """`executor.submit` that runs `fn` under a copy of the caller's context, so a worker thread sees the run's cancel token
    (and its job id for log correlation). Every pool that can make model calls submits through this."""
    return executor.submit(contextvars.copy_context().run, lambda: fn(*args, **kwargs))
