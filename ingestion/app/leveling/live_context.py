from __future__ import annotations

import logging
import threading
from collections.abc import Iterator
from contextlib import contextmanager

from app.config import settings
from app.leveling.live_emitter import LiveEmitter, _RedisLike
from app.leveling.notices import NoticePublisher
from app.leveling.stage_units import StageCounter, StageUnits, publish_units
from app.logging_context import current_job_id

logger = logging.getLogger(__name__)

# Job transparency (docs/job-transparency-implementation-plan.md, B9): lets code
# deep inside the survey build (conflict detection now, the streamed drafting
# calls in B7) reach the job's LiveEmitter without threading a parameter
# through every function. Keyed by job id, not by contextvar alone, because
# the build fans out to worker threads that do not inherit the caller's
# context; a thread that knows the job id (or copies the context) can still
# find the emitter. Off unless LIVE_PROGRESS is set, in which case
# `current_live_emitter()` is always None and every caller does nothing.

_EMITTERS: dict[str, LiveEmitter] = {}
_COUNTERS: dict[str, StageCounter] = {}
_NOTICES: dict[str, NoticePublisher] = {}
_LOCK = threading.Lock()


def live_emitter_for(job_id: str | None) -> LiveEmitter | None:
    if not job_id:
        return None
    with _LOCK:
        return _EMITTERS.get(job_id)


def stage_counter_for(job_id: str | None) -> StageCounter | None:
    if not job_id:
        return None
    with _LOCK:
        return _COUNTERS.get(job_id)


def notice(
    kind: str, severity: str = "info", *, once_key: str | None = None, with_last_item: bool = False,
    **facts: object,
) -> None:
    """Tells the user about a condition that changed the run (job transparency, B12).
    A no-op unless live progress is on and a job is in scope; never raises."""
    try:
        job_id = current_job_id()
        if not job_id:
            return
        with _LOCK:
            publisher = _NOTICES.get(job_id)
            emitter = _EMITTERS.get(job_id)
        if with_last_item and emitter is not None and emitter.last_item_ref:
            facts["lastRef"] = emitter.last_item_ref
        if publisher is not None:
            publisher.publish(kind, severity, once_key=once_key, **facts)
    except Exception:  # noqa: BLE001 - observation must never break the job
        logger.debug("notice failed", exc_info=True)


def current_stage_counter() -> StageCounter | None:
    """The exact-count tracker of the job in scope; None unless live progress is on."""
    return stage_counter_for(current_job_id())


def current_live_emitter() -> LiveEmitter | None:
    """The emitter of the job in scope (see logging_context.job_id_scope)."""
    return live_emitter_for(current_job_id())


@contextmanager
def live_emitter_scope(
    job_id: str | None, redis_client: _RedisLike,
) -> Iterator[LiveEmitter | None]:
    """Creates and registers the job's emitter for the duration of the block
    when live progress is on and a job id exists; flushes it and removes it on
    exit, even on error. Never raises on its own account."""
    emitter: LiveEmitter | None = None
    if settings.live_progress and job_id:
        try:
            emitter = LiveEmitter(
                redis_client, job_id, hz=settings.live_publish_hz,
                excerpt_max_chars=settings.live_excerpt_max_chars,
            )
            with _LOCK:
                _EMITTERS[job_id] = emitter
                _COUNTERS[job_id] = StageCounter(redis_client, job_id)
                _NOTICES[job_id] = NoticePublisher(redis_client, job_id)
        except Exception:  # noqa: BLE001 - observation must never break the job
            logger.warning("Could not start the live emitter for job %s", job_id, exc_info=True)
            emitter = None
    try:
        yield emitter
    finally:
        if emitter is not None and job_id:
            with _LOCK:
                _EMITTERS.pop(job_id, None)
                _COUNTERS.pop(job_id, None)
                _NOTICES.pop(job_id, None)
            emitter.flush()


def ocr_progress_callback(job_id: str | None, redis_client: _RedisLike):  # noqa: ANN201
    """Callback for `load_pdf_with_ocr_fallback(on_ocr_page=...)` (B10): reports
    scanned-page progress as exact units (stage `parse`, unit `pages`) and as a
    live `ocr_page` frame with a short excerpt of the recognised text. None
    unless live progress is on and a job id exists. Runs on the parsing thread,
    so it finds the emitter by job id."""
    if not (settings.live_progress and job_id):
        return None

    def on_page(done: int, total: int, page_number: int, page_count: int, text: str) -> None:
        publish_units(redis_client, job_id, StageUnits("parse", "pages", done, total))
        emitter = live_emitter_for(job_id)
        if emitter is not None:
            emitter.ocr_page(page=page_number, pages=page_count, excerpt=text)

    return on_page
