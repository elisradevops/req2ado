from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:  # avoids an import cycle: narration_publisher imports this module
    from app.leveling.narration_publisher import LevelingProgress

logger = logging.getLogger(__name__)

# Job transparency (docs/job-transparency-implementation-plan.md, B3): the
# EXACT units each stage of a SURVEY run has finished, derived from the
# progress events the pipeline already emits. The orchestrator's progress
# service turns these into one weighted percentage; this module only reports
# what was counted and never estimates.
#
# Published on its own channel (not the browser's job-events channel) so the
# SSE stream is untouched until the orchestrator routes the new events (B6).

UNITS_TTL_SECONDS = 24 * 3600

# Passes of the deterministic hierarchy builder: "draft" rewrites requirement
# text (the synthesis pass), "improve" refines titles and tags, "summarize"
# rewrites Epic and Feature titles and descriptions.


def units_channel(job_id: str) -> str:
    return f"job-events:{job_id}:units"


def units_latest_key(job_id: str) -> str:
    return f"job-events:{job_id}:units-latest"


@dataclass(frozen=True)
class StageUnits:
    stage: str  # parse | draft | improve | summarize | skeleton | map | write | score | link
    unit: str  # figures | items | sections | requirements | passes
    done: int
    total: int
    complete: bool = False
    # Deterministic path only: which subtree, and which chunk of the pass.
    subtree: int | None = None
    subtree_count: int | None = None
    chunk: int | None = None
    chunk_count: int | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "type": "units",
            "stage": self.stage,
            "unit": self.unit,
            "done": self.done,
            "total": self.total,
            "complete": self.complete,
            "subtree": self.subtree,
            "subtreeCount": self.subtree_count,
            "chunk": self.chunk,
            "chunkCount": self.chunk_count,
            "emittedAt": datetime.now(UTC).isoformat(),
        }


def _clamp(done: int, total: int) -> int:
    return max(0, min(done, total))


def units_from_progress(progress: LevelingProgress) -> StageUnits | None:
    """Maps one existing progress event to the units it proves, or None when
    the event carries no countable unit. Pure; never raises."""
    phase = progress.phase

    if phase == "describe_figure":
        total = progress.figure_count
        index = progress.figure_index
        if not total or index is None:
            return None
        # The first event of a figure fires when its vision call starts, the
        # second (caption set) when it returns -- only the second proves it done.
        done = index if progress.figure_caption is not None else index - 1
        return StageUnits("parse", "figures", _clamp(done, total), total)

    if phase == "parse_done":
        total = progress.figure_count or 0
        return StageUnits("parse", "figures", total, total, complete=True)

    if phase == "deterministic_subtree":
        # The draft / improve / summarize passes are counted by StageCounter
        # (below), which sums items across chunks and subtrees. The narration
        # events here only carry one subtree's start-of-chunk position, which
        # would fight with those totals, so they count nothing.
        return None

    if phase in ("build_skeleton", "analyze_section", "section_complete"):
        total = progress.branch_count
        index = progress.branch_index
        if total <= 0 or index is None:
            return None
        stage = "skeleton" if phase == "build_skeleton" else "write"
        done = index + 1 if phase == "section_complete" else index
        return StageUnits(stage, "sections", _clamp(done, total), total)

    if phase == "map_scope":
        return StageUnits("map", "passes", 0, 1)

    if phase in ("score_requirements", "score_requirements_done"):
        total = progress.blocks_total
        if total <= 0:
            return None
        done = total if phase == "score_requirements_done" else progress.blocks_done
        return StageUnits("score", "requirements", _clamp(done, total), total)

    # The three whole-document passes after scoring. Each event marks the START
    # of a pass, so passes finished = how many came before it.
    link_order = {"detect_conflicts": 0, "regroup_roots": 1, "infer_trace_links": 2}
    if phase in link_order:
        return StageUnits("link", "passes", link_order[phase], 3)

    return None


class _RedisLike(Protocol):
    def publish(self, channel: str, message: str) -> Any: ...
    def hset(self, name: str, key: str, value: str) -> Any: ...
    def expire(self, name: str, time: int) -> Any: ...


def publish_units(redis_client: _RedisLike, job_id: str, units: StageUnits) -> bool:
    """Best-effort publish of already-built units. Never raises."""
    try:
        payload = json.dumps(units.to_payload())
        # A scanned document counts its parse in pages, and the ordinary
        # "parse finished" event counts figures: keep them in separate fields so
        # the latest-units snapshot (used to resume after a restart) still knows
        # the run is a scan.
        field = "parse_pages" if units.stage == "parse" and units.unit == "pages" else units.stage
        redis_client.hset(units_latest_key(job_id), field, payload)
        redis_client.expire(units_latest_key(job_id), UNITS_TTL_SECONDS)
        redis_client.publish(units_channel(job_id), payload)
        return True
    except Exception:  # noqa: BLE001 - observation must never break the job
        logger.warning("Failed to publish stage units for job %s", job_id, exc_info=True)
        return False


class StageCounter:
    """Exact item counts for the passes that run over many chunks and, for a
    document with several deterministic subtrees, many times (draft, improve,
    summarize). One per job. Thread-safe: chunks may run concurrently.

    `plan()` publishes every pass's total up front so the percentage knows what
    is coming; a pass planned at zero items is reported complete, which tells
    the orchestrator it is skipped. `advance()` adds items whose call finished;
    `in_flight()` adds the items a streaming call has already produced, so the
    count moves while a long call is still running. Counts never go backwards,
    and in-flight updates are rate-limited (everything else publishes at once)."""

    _STAGES = ("draft", "improve", "summarize")

    def __init__(
        self, redis_client: _RedisLike, job_id: str, *,
        clock: Any = time.monotonic, min_interval: float = 0.25,
    ) -> None:
        self._redis = redis_client
        self._job_id = job_id
        self._clock = clock
        self._min_interval = min_interval
        self._lock = threading.Lock()
        self._total: dict[str, int] = {}
        self._finished: dict[str, int] = {}
        self._flying: dict[str, dict[Any, int]] = {}
        self._reported: dict[str, int] = {}
        self._complete: set[str] = set()
        self._last_publish: dict[str, float] = {}

    def plan(self, totals: dict[str, int]) -> None:
        for stage, total in totals.items():
            self.set_total(stage, total)

    def is_planned(self, stage: str) -> bool:
        with self._lock:
            return stage in self._total

    def set_total(self, stage: str, total: int) -> None:
        with self._lock:
            self._total[stage] = max(0, int(total))
            if self._total[stage] == 0:
                self._complete.add(stage)
            else:
                self._complete.discard(stage)
        self._publish(stage, force=True)

    def advance(self, stage: str, count: int) -> None:
        with self._lock:
            self._finished[stage] = self._finished.get(stage, 0) + max(0, int(count))
        self._publish(stage, force=True)

    def in_flight(self, stage: str, key: Any, count: int) -> None:
        with self._lock:
            self._flying.setdefault(stage, {})[key] = max(0, int(count))
        self._publish(stage, force=False)

    def clear_in_flight(self, stage: str, key: Any) -> None:
        with self._lock:
            self._flying.get(stage, {}).pop(key, None)

    def complete(self, stage: str) -> None:
        with self._lock:
            self._complete.add(stage)
        self._publish(stage, force=True)

    def _publish(self, stage: str, *, force: bool) -> None:
        try:
            with self._lock:
                now = self._clock()
                if not force and now - self._last_publish.get(stage, -1e9) < self._min_interval:
                    return
                total = self._total.get(stage)
                if total is None:
                    return
                flying = sum(self._flying.get(stage, {}).values())
                done = min(total, self._finished.get(stage, 0) + flying)
                done = max(done, self._reported.get(stage, 0))  # never backwards
                complete = stage in self._complete
                if complete:
                    done = total
                self._reported[stage] = done
                self._last_publish[stage] = now
            units = StageUnits(stage, "items", done, total, complete)
            publish_units(self._redis, self._job_id, units)
        except Exception:  # noqa: BLE001 - observation must never break the job
            logger.warning("Stage counter failed for job %s", self._job_id, exc_info=True)


def publish_stage_units(redis_client: _RedisLike, job_id: str, progress: LevelingProgress) -> bool:
    """Best-effort: publishes the units one event proves, if any. Returns True
    only when something was published. Never raises -- observation must not
    fail or slow a job."""
    try:
        units = units_from_progress(progress)
        if units is None:
            return False
        payload = json.dumps(units.to_payload())
        redis_client.hset(units_latest_key(job_id), units.stage, payload)
        redis_client.expire(units_latest_key(job_id), UNITS_TTL_SECONDS)
        redis_client.publish(units_channel(job_id), payload)
        return True
    except Exception:  # noqa: BLE001 - observation must never break the job
        logger.warning("Failed to publish stage units for job %s", job_id, exc_info=True)
        return False
