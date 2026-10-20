"""Stopping the work of a job nobody is waiting for any more.

`/level` runs for many minutes. When its caller goes away (the orchestrator's request timed out, the worker restarted, the job
was cancelled) the route used to keep going to the end: every remaining scoring, regrouping and trace-link call still hit the
model, and those calls starved the next jobs of the same model. The route now watches for the disconnect and marks the job
cancelled; the next model call of that job raises `JobCancelled`, so the rest of the job costs nothing.

`JobCancelled` is an ordinary exception on purpose: stages already treat a failed call as fail-open and move on, so the
remaining calls of a cancelled job each raise at once and the job winds down in moments."""
from __future__ import annotations

import asyncio
import threading
from contextlib import asynccontextmanager
from typing import Protocol

from app.logging_context import current_job_id

_cancelled: set[str] = set()
_lock = threading.Lock()


class JobCancelled(Exception):
    """Raised at a model call of a job whose caller has gone away."""


def cancel(job_id: str) -> None:
    with _lock:
        _cancelled.add(job_id)


def clear(job_id: str) -> None:
    with _lock:
        _cancelled.discard(job_id)


def is_cancelled(job_id: str | None) -> bool:
    with _lock:
        return job_id is not None and job_id in _cancelled


def raise_if_cancelled() -> None:
    """Called before every model call; the job is the ambient one (logging_context), so no parameter is threaded through."""
    job_id = current_job_id()
    if is_cancelled(job_id):
        raise JobCancelled(f"job {job_id} was cancelled: its caller is gone")


class _Disconnectable(Protocol):
    async def is_disconnected(self) -> bool: ...


@asynccontextmanager
async def watch_for_disconnect(request: _Disconnectable, job_id: str | None, poll_seconds: float = 2.0):
    """Within the block, marks `job_id` cancelled as soon as the request's client disconnects. Nothing is watched without a job id."""
    if not job_id:
        yield
        return

    # Stopped with a flag, not task.cancel(): Starlette's is_disconnected() runs inside an anyio cancel scope that can swallow
    # a plain asyncio cancellation, which left the watcher looping and the request hanging.
    stop = asyncio.Event()

    async def watch() -> None:
        while not stop.is_set():
            if await request.is_disconnected():
                cancel(job_id)
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
