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
    analysis/scoring calls (analyze_section, score_requirements_for_document,
    score_epics_and_features_for_document) so re-running the SAME
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
            logger.warning("LlmResponseCache.get: stored value was not valid JSON, treating as a cache miss")
            return None

    def set(self, key: str, value: object) -> None:
        try:
            self._redis.set(key, json.dumps(value), ex=self._ttl_seconds)
        except Exception:
            logger.warning("LlmResponseCache.set failed, result will not be cached", exc_info=True)


def cache_key(operation: str, model: str | None, num_ctx: int | None, top_k: int | None, min_p: float | None, *parts: object) -> str:
    """Stable cache key covering every input that can change an LLM call's
    output -- not just the prompt/section text. Two identical texts scored
    under a different model/num_ctx/top_k/min_p must never collide, so all
    four are folded into the key alongside the call's own arguments."""
    payload = json.dumps(
        {"operation": operation, "model": model, "num_ctx": num_ctx, "top_k": top_k, "min_p": min_p, "parts": parts},
        sort_keys=True,
        default=str,
    )
    return f"llm_cache:{hashlib.sha256(payload.encode()).hexdigest()}"
