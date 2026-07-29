# ingestion/app/logging_context.py
"""job_id log correlation, via a contextvar rather than threading a job_id
parameter through every function in llm_leveling.py/orchestrator_llm_client.py
that might log a warning. Confirmed zero job_id references in either
module's logger.warning/exception calls before this existed -- every soft-
failure warning (hierarchy repair, invalid type, truncation, low grounding,
scoring failure) was uncorrelated to the job that produced it.

job_id_scope() is entered once, at the top of the real work
(app.main._build_survey_tree_with_scoring, which already receives job_id as
a parameter) -- every logger call anywhere beneath it in the call stack
picks up the same job_id automatically via JobIdLogFilter, attached to the
root logger's handler in app.main alongside logging.basicConfig."""
from __future__ import annotations

import contextvars
import logging
from collections.abc import Iterator
from contextlib import contextmanager

_job_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "_job_id_var", default=None
)


class JobIdLogFilter(logging.Filter):
    """Injects the current job_id (from the contextvar above) onto any
    LogRecord that doesn't already carry one -- lets the log format string
    reference %(job_id)s unconditionally. Falls back to "-" when no job is
    in scope (e.g. a direct test/curl call to /level with no job_id, or any
    log line emitted outside job_id_scope())."""

    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "job_id"):
            record.job_id = _job_id_var.get() or "-"
        return True


def current_job_id() -> str | None:
    """Public accessor for the ambient job_id set by job_id_scope() below --
    used by app.debug_capture.DebugCapture to key a capture without needing
    job_id threaded as a parameter into every function that might capture."""
    return _job_id_var.get()


@contextmanager
def job_id_scope(job_id: str | None) -> Iterator[None]:
    """Scopes job_id for every log record emitted within this `with` block.
    job_id=None is a valid, common case (no job context) -- records
    emitted inside still resolve to "-" via JobIdLogFilter's fallback."""
    token = _job_id_var.set(job_id)
    try:
        yield
    finally:
        _job_id_var.reset(token)
