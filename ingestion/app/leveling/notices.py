from __future__ import annotations

import json
import logging
import threading
import uuid
from datetime import UTC, datetime
from typing import Any, Protocol

logger = logging.getLogger(__name__)

# Job transparency (docs/job-transparency-implementation-plan.md, B12): typed notices
# for conditions the user should know about because they change what the run
# produced or how long it took. A notice is a fixed kind plus a few numbers and
# short enums: never free text and never any of the user's document text. The
# frontend owns the wording (utils/liveCopy.ts), so no server text can leak content.
#
# Published on the job's main channel (so the existing persistence service stores
# each in JobEvent, no migration) and kept in a short replay list for a stream that
# reconnects. Best-effort: a failure is logged once and never reaches the job.

NOTICE_KINDS = ("output_limit_reached", "server_retry", "context_assumed", "stream_fallback")
NOTICE_SEVERITIES = ("info", "warning")
NOTICE_TTL_SECONDS = 24 * 3600
NOTICE_LOG_MAX = 50

# Kinds that can repeat many times in a run publish at these cumulative counts only,
# so a flaky backend produces a handful of rows, not hundreds.
_REPEAT_COUNTS = frozenset({1, 2, 3, 5, 10, 25, 50, 100, 250, 500, 1000})


def notices_log_key(job_id: str) -> str:
    return f"job-events:{job_id}:notices"


class _RedisLike(Protocol):
    def rpush(self, name: str, *values: str) -> Any: ...
    def ltrim(self, name: str, start: int, end: int) -> Any: ...
    def expire(self, name: str, time: int) -> Any: ...
    def publish(self, channel: str, message: str) -> Any: ...


def _clean_facts(facts: dict[str, Any]) -> dict[str, str | int | float | bool]:
    """Only numbers, booleans and short strings survive; anything else is dropped."""
    clean: dict[str, str | int | float | bool] = {}
    for key, value in facts.items():
        if isinstance(value, bool | int | float):
            clean[key] = value
        elif isinstance(value, str):
            clean[key] = value[:40]
    return clean


class NoticePublisher:
    """One per job. Thread-safe: calls arrive from worker threads."""

    def __init__(self, redis_client: _RedisLike, job_id: str) -> None:
        self._redis = redis_client
        self._job_id = job_id
        self._lock = threading.Lock()
        self._counts: dict[str, int] = {}
        self._once: set[str] = set()
        self._warned = False

    def publish(
        self, kind: str, severity: str = "info", *, once_key: str | None = None, **facts: Any,
    ) -> bool:
        """Returns True when a notice was sent. `once_key` limits a kind to one notice
        per key for the job (for example one per model)."""
        if kind not in NOTICE_KINDS or severity not in NOTICE_SEVERITIES:
            return False
        with self._lock:
            if once_key is not None:
                key = f"{kind}:{once_key}"
                if key in self._once:
                    return False
                self._once.add(key)
            count = self._counts.get(kind, 0) + 1
            self._counts[kind] = count
            if once_key is None and count not in _REPEAT_COUNTS:
                return False
        payload = {
            "type": "notice",
            "id": uuid.uuid4().hex,
            "kind": kind,
            "severity": severity,
            "count": count,
            "facts": _clean_facts(facts),
            "emittedAt": datetime.now(UTC).isoformat(),
        }
        try:
            body = json.dumps(payload)
            log_key = notices_log_key(self._job_id)
            self._redis.rpush(log_key, body)
            self._redis.ltrim(log_key, -NOTICE_LOG_MAX, -1)
            self._redis.expire(log_key, NOTICE_TTL_SECONDS)
            self._redis.publish(f"job-events:{self._job_id}", body)
            return True
        except Exception:  # noqa: BLE001 - observation must never break the job
            if not self._warned:
                self._warned = True
                logger.warning(
                    "Notice dropped for job %s (further drops not logged)",
                    self._job_id, exc_info=True,
                )
            return False
