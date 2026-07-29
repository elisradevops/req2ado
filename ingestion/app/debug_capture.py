# ingestion/app/debug_capture.py
"""Persists the raw content behind a soft-failure warning (KB relevance
verification, trace-link inference, Epic/Feature scoring -- anywhere a
`logger.warning`+`warnings.append` already fires for an enhancement that
degrades rather than aborting the job) so a reviewer can see what the model
actually said without re-running the job. Re-running is not a faithful
reproduction even at temperature=0: the agentic path's retrieval/tool calls
can vary run to run.

Fires ONLY when a soft failure actually occurs, never per successful call --
these are debug artifacts about failures, not a general request/response
log, and the analysis responses are the largest payloads in this module
(_MAX_OUTPUT_TOKENS=20000); storing every one would be wasteful and a
data-retention liability (they contain customer requirements text).

Redis-backed with a TTL (not a Postgres table): these are small, genuinely
debug-only artifacts that SHOULD expire, unlike a job's own durable audit
trail. Keyed by job_id (read from the ambient contextvar in
app.logging_context, not threaded as a parameter) -- capture silently no-ops
outside any job_id_scope() (e.g. a direct test/curl call with no job
context), since there is nothing meaningful to key it by."""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from app.logging_context import current_job_id

if TYPE_CHECKING:
    import redis  # noqa: F401 - referenced only in the type alias below

    _RedisClient = redis.Redis
else:
    _RedisClient = Any

logger = logging.getLogger(__name__)

_CAPTURE_TTL_SECONDS = 7 * 24 * 3600  # 7 days -- debug-only, expected to expire
_MAX_CAPTURED_CHARS = 20_000  # bounds worst-case Redis memory per capture
_KEY_PREFIX = "req2ado:debug"


def _key(job_id: str, kind: str, identifier: str) -> str:
    return f"{_KEY_PREFIX}:{job_id}:{kind}:{identifier}"


class DebugCapture:
    def __init__(self, redis_client: _RedisClient) -> None:
        self._redis = redis_client

    def capture(self, kind: str, identifier: str, raw_response: str) -> None:
        """Best-effort: a capture failure (Redis unavailable, etc.) must
        never fail the job whose soft-failure it was trying to record."""
        job_id = current_job_id()
        if job_id is None:
            return
        try:
            truncated = raw_response[:_MAX_CAPTURED_CHARS]
            self._redis.setex(_key(job_id, kind, identifier), _CAPTURE_TTL_SECONDS, truncated)
        except Exception:  # noqa: BLE001 - debug capture must never fail the job it's capturing for
            logger.warning(
                "DebugCapture failed to persist a capture for job %s (%s/%s)",
                job_id, kind, identifier,
            )

    def list_captures(self, job_id: str) -> list[dict[str, str]]:
        """Every capture recorded for this job, for the debug-read endpoint
        (GET /jobs/:id/debug via the orchestrator). Each capture's own key
        segments (kind, identifier) are returned alongside its content so
        the caller doesn't need to re-parse the Redis key."""
        pattern = _key(job_id, "*", "*")
        results: list[dict[str, str]] = []
        for raw_key in self._redis.scan_iter(match=pattern):
            key = raw_key.decode() if isinstance(raw_key, bytes) else raw_key
            parts = key.split(":", 4)
            if len(parts) != 5:
                continue
            _, _, _, kind, identifier = parts
            raw_value = self._redis.get(raw_key)
            if raw_value is None:
                continue
            value = raw_value.decode() if isinstance(raw_value, bytes) else raw_value
            results.append({"kind": kind, "identifier": identifier, "content": value})
        return results
