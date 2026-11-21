# app/survey/llm_cache.py
from __future__ import annotations

import hashlib
import json
import logging

logger = logging.getLogger(__name__)

# Matches orchestrator/src/modules/pipeline/pipeline.worker.ts's
# AREA_PATH_BACKFILL_STALE_AFTER_MS precedent: long enough that a same-day
# re-run (resubmission after a failure, iterative testing, a golden-e2e-
# style identical re-run) is a guaranteed cache hit, short enough that a
# stale entry self-heals within a day with zero manual action.
_DEFAULT_TTL_SECONDS = 24 * 60 * 60


class LlmResponseCache:
    """Caches OrchestratorLlmClient's deterministic (temperature=0)
    analysis/scoring calls (analyze_section, score_requirements_for_document) so re-running the SAME
    section/document under the SAME model+params skips a real LLM round
    trip entirely. Fail-open, matching NarrationPublisher's own Redis-error
    philosophy (app.leveling.narration_publisher): a Redis error on get/set
    is logged and treated as a cache miss/no-op, never raised -- caching is
    a cost optimization, not a correctness dependency, and an LLM-analysis
    job must never fail because its cache layer had a bad day."""

    def __init__(self, redis_client, ttl_seconds: int = _DEFAULT_TTL_SECONDS) -> None:
        self._redis = redis_client
        self._ttl_seconds = ttl_seconds

    def get(self, key: str) -> object | None:
        try:
            raw = self._redis.get(key)
        except Exception:
            logger.warning("LlmResponseCache.get failed, treating as a cache miss", exc_info=True)
            return None
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except (TypeError, ValueError):
            logger.warning(
                "LlmResponseCache.get: stored value was not valid JSON, treating as a cache miss"
            )
            return None

    def set(self, key: str, value: object) -> None:
        try:
            self._redis.set(key, json.dumps(value), ex=self._ttl_seconds)
        except Exception:
            logger.warning("LlmResponseCache.set failed, result will not be cached", exc_info=True)


def payload_key(payload: dict, *scope: object) -> str:
    """The cache key of one request, computed from the exact body sent: the messages (so the prompt text), the schema and every model
    parameter. No caller lists what goes in, so nothing that changes the answer can be left out. `scope` partitions the cache by what
    is not in the body: the user (an answer is never shared across users) or a vote number (repeated asks stay separate opinions).
    An attached file's id changes with every upload of the same file, so only whether one is attached is part of the key."""
    body = {k: v for k, v in payload.items() if k != "fileId"}
    if "fileId" in payload:
        body["fileAttached"] = bool(payload["fileId"])
    text = json.dumps({"payload": body, "scope": scope}, sort_keys=True, default=str)
    return f"llm_cache:{hashlib.sha256(text.encode()).hexdigest()}"
