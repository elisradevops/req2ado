"""A per-run gate every model attempt passes through while it is set (see OrchestratorLlmClient._post_chat).

The acceptance-criteria step sets one in each of its worker threads (a context variable, so one worker's gate is never another's): the gate
takes a lease on the shared limiter for the length of ONE attempt, so a retry's back-off sleep holds no slot. Nothing is set anywhere else,
and then `gated()` does nothing."""
from __future__ import annotations

import contextlib
import contextvars
import time
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager
from typing import TYPE_CHECKING

from app.job_cancel import raise_if_cancelled

if TYPE_CHECKING:
    from app.leveling.llm_lease_limiter import LeaseLimiter

_gate: contextvars.ContextVar[Callable[[], AbstractContextManager[None]] | None] = contextvars.ContextVar("llm_call_gate", default=None)


@contextlib.contextmanager
def use_gate(gate: Callable[[], AbstractContextManager[None]]):
    """Sets `gate` for the current context (a worker thread's own copy) until the block ends."""
    token = _gate.set(gate)
    try:
        yield
    finally:
        _gate.reset(token)


def gated() -> AbstractContextManager[None]:
    """The context manager one model attempt runs inside: the current gate's, or a no-op when none is set."""
    gate = _gate.get()
    return gate() if gate is not None else contextlib.nullcontext()


class StepBudgetExceeded(Exception):
    """The step's time budget was spent before a model attempt could start."""


class LeaseGate:
    """What every model attempt of the step passes through (see app.leveling.llm_call_gate): refuses once the step's budget is spent and,
    with a limiter, holds one lease of the shared limiter for the length of the attempt. Waiting for a lease is back-pressure, not a failure:
    it goes on until a lease is had, the run is cancelled (JobCancelled) or the budget is spent (StepBudgetExceeded). Shared by the
    workers; it holds no state of its own beyond what it was given."""

    def __init__(
        self, limiter: LeaseLimiter | None, model: str | None, scope: str, deadline: float, max_wait: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._limiter, self._model, self._scope, self._deadline, self._max_wait, self._clock = limiter, model, scope, deadline, max_wait, clock

    @property
    def deadline(self) -> float:
        return self._deadline

    def _time_left(self) -> float:
        left = self._deadline - self._clock()
        if left <= 0:
            raise StepBudgetExceeded("the step's time budget is spent")
        return left

    @contextlib.contextmanager
    def __call__(self) -> Iterator[None]:
        raise_if_cancelled()
        left = self._time_left()
        lease = None
        if self._limiter is not None:
            while lease is None:
                lease = self._limiter.acquire(self._model, self._scope, max_wait_seconds=min(self._max_wait, left))
                if lease is None:
                    raise_if_cancelled()
                    left = self._time_left()
        try:
            raise_if_cancelled()  # cancelled while waiting for the slot: no call is made, and the slot goes back below
            yield
        finally:
            if lease is not None:
                lease.release()
