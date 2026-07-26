from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Callable, Literal

import redis

logger = logging.getLogger(__name__)

# Mirrors JobEventsPublisher's (orchestrator) TTL for the last-known stage
# key -- same rationale: bounds unbounded Redis key growth, not modeling an
# actual expected job lifetime.
_CURRENT_NARRATION_TTL_SECONDS = 3600

Phase = Literal["analyze_section", "score_requirements", "infer_trace_links"]


@dataclass(frozen=True)
class LevelingProgress:
    """Structured facts about one real step boundary in build_survey_tree --
    message formatting/wording lives in NarrationPublisher, not here, so
    this module stays UI-agnostic and independently testable."""

    phase: Phase
    branch_index: int | None  # 0-based; None for the whole-tree infer_trace_links phase
    branch_count: int
    blocks_done: int
    blocks_total: int
    kb_grounded: bool
    kb_citations: list[dict]  # [{source_file, similarity}] -- empty when kb_grounded is False
    # Human-readable label for the section currently being analyzed --
    # typically its own first heading text, or a short excerpt when the
    # section has no heading (see llm_leveling._derive_section_label).
    # None for the whole-tree infer_trace_links phase (no single section).
    # Without this the UI could only ever show an anonymous "Section N of
    # M", giving no way to tell WHICH real content a job was processing at
    # the time it failed.
    section_label: str | None = None


ProgressCallback = Callable[[LevelingProgress], None]

_PHASE_MESSAGES: dict[Phase, str] = {
    "analyze_section": "Analyzing and synthesizing requirements",
    "score_requirements": "Scoring requirement quality",
    "infer_trace_links": "Resolving trace/coverage links",
}


def _format_message(progress: LevelingProgress) -> str:
    base = _PHASE_MESSAGES[progress.phase]
    if progress.branch_index is not None:
        base += f" (section {progress.branch_index + 1} of {progress.branch_count}"
        if progress.section_label:
            base += f" -- {progress.section_label}"
        base += ")"
    base += f" -- {progress.blocks_done} of {progress.blocks_total} blocks"
    if progress.kb_grounded:
        strong = sum(1 for c in progress.kb_citations if c.get("similarity", 0) >= 0.55)
        weak = len(progress.kb_citations) - strong
        base += f", grounded with {len(progress.kb_citations)} KB file(s)"
        if strong or weak:
            base += f" (strong: {strong}, weak: {weak})"
    return base


class NarrationPublisher:
    """Publishes per-step SURVEY progress narration to the SAME
    `job-events:{job_id}` Redis channel orchestrator's JobEventsController
    already relays via SSE for coarse stage events (see
    job-events.publisher.ts). Convention: ingestion ONLY ever publishes
    `type:'narration'` events here -- orchestrator owns all `stage`
    transitions -- so the two writers' events never collide in meaning,
    even though they share one channel.

    Uses a SYNCHRONOUS redis.Redis client, not redis.asyncio (the pattern
    app/chat/redis_publisher.py uses) -- build_survey_tree runs inside
    FastAPI's run_in_threadpool (see app/main.py's /level route), i.e. on a
    worker THREAD, not the event loop, where an async client can't be
    awaited without loop gymnastics a plain sync call sidesteps entirely.

    Publishing is best-effort: a Redis failure here must never fail the
    SURVEY job itself, so every publish() call is wrapped and only logged
    on error."""

    def __init__(self, redis_client: redis.Redis, job_id: str) -> None:
        self._redis = redis_client
        self._job_id = job_id

    def publish(self, progress: LevelingProgress) -> None:
        payload = json.dumps(
            {
                "type": "narration",
                "phase": progress.phase,
                "branchIndex": progress.branch_index,
                "branchCount": progress.branch_count,
                "sectionLabel": progress.section_label,
                "blocksDone": progress.blocks_done,
                "blocksTotal": progress.blocks_total,
                "kbGrounded": progress.kb_grounded,
                "kbCitations": [
                    {"sourceFile": c["source_file"], "similarity": c["similarity"]} for c in progress.kb_citations
                ],
                "message": _format_message(progress),
            }
        )
        try:
            self._redis.set(f"job-events:{self._job_id}:narration", payload, ex=_CURRENT_NARRATION_TTL_SECONDS)
            self._redis.publish(f"job-events:{self._job_id}", payload)
        except Exception as exc:  # noqa: BLE001 - narration must never fail a SURVEY job
            logger.warning("Failed to publish narration for job %s: %s", self._job_id, exc)
