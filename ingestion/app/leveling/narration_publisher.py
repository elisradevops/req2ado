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

Phase = Literal[
    "describe_figure",
    "parse_done",
    "analyze_section",
    "score_requirements",
    "score_requirements_done",
    "section_complete",
    "infer_trace_links",
]


@dataclass(frozen=True)
class LevelingProgress:
    """Structured facts about one real step boundary in build_survey_tree,
    OR (describe_figure/parse_done) in the /ingest parse pipeline that runs
    BEFORE build_survey_tree -- message formatting/wording lives in
    NarrationPublisher, not here, so this module stays UI-agnostic and
    independently testable. The parse-stage phases reuse this same
    dataclass rather than a separate one so both producers share one
    publish() path/wire format; branch_index/branch_count/blocks_done/
    blocks_total/kb_grounded/kb_citations are meaningless for them and
    always passed as None/0/0/False/[] (same convention infer_trace_links
    already uses for branch_index=None)."""

    phase: Phase
    branch_index: int | None  # 0-based; None for whole-tree/parse-stage phases
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
    # The LLM model doing the work for this step -- surfaced so the running
    # page can show which model is actually in use, not just a phase name.
    # None when the underlying client doesn't expose one (e.g. a test
    # double), matching pre-model-visibility behavior exactly.
    model: str | None = None
    # How many candidate requirements this section produced, known by the
    # time `score_requirements` fires (analyze_section already returned) --
    # lets the message read "Scoring 12 drafted requirements" instead of a
    # bare phase name. None for every other phase.
    draft_count: int | None = None
    # Set only on score_requirements_done: how many quality issues were
    # flagged across this section's nodes once _apply_quality_scores
    # actually finished -- the first real "what did scoring find" signal a
    # user sees, previously nothing ever told them scoring had concluded.
    issues_found: int | None = None
    # describe_figure only: 1-based count of figures described so far in
    # THIS document (not a total -- the loader doesn't know how many figures
    # remain until it finishes walking the whole document, so this is a
    # running count, not a fraction). Before this field existed, a
    # figure-heavy document (confirmed live: one real document had 39
    # embedded figures, each a sequential vision-LLM call during parse) gave
    # zero visible signal for however many minutes that took -- the parse
    # stage was a total black box.
    figure_index: int | None = None
    # parse_done only: final counts from the parsed CanonicalDoc, letting
    # the user see exactly what was found in their document (and cross-check
    # it against what they expected) the moment parsing finishes, not only
    # after the whole SURVEY run completes and the diff/warnings appear.
    block_count: int | None = None
    table_count: int | None = None
    figure_count: int | None = None
    # describe_figure only: the real vision-model caption for THIS figure,
    # set on a SECOND event fired once the (potentially slow) vision call
    # actually returns -- the first event (figure_caption=None) only signals
    # "in flight", this one answers "what did the model see". Without this,
    # a figure-heavy document showed the same generic "figure N so far" line
    # N times over with zero differentiating content (confirmed live: 7
    # identical rows in the activity log) -- exactly the gap that made
    # per-figure debugging (which figure failed to parse, what did the model
    # actually think it was) impossible.
    figure_caption: str | None = None
    # section_complete only: this branch's finished nodes (type/title/text/
    # quality_score, in generation order) -- the real "parsed and formatted
    # response" a reviewer can inspect live, per section, instead of only
    # ever seeing this content once the WHOLE job reaches diff_ready. Kept
    # as plain dicts (not WorkItemNode) so this module stays independent of
    # app.workitem.model -- the caller (llm_leveling.py) does the mapping.
    # None for every other phase.
    section_nodes: list[dict] | None = None


ProgressCallback = Callable[[LevelingProgress], None]

# Caps the caption text folded into the message string -- the raw caption
# (full length) still rides on the wire as its own `figureCaption` field for
# any caller that wants it in full; this only bounds what the ONE-LINE
# narration message itself shows.
_CAPTION_PREVIEW_LENGTH = 160


def _truncate_caption(caption: str) -> str:
    collapsed = " ".join(caption.split())
    if len(collapsed) <= _CAPTION_PREVIEW_LENGTH:
        return collapsed
    return f"{collapsed[:_CAPTION_PREVIEW_LENGTH]}…"

_PHASE_MESSAGES: dict[Phase, str] = {
    "describe_figure": "Describing an embedded figure via the vision model",
    "parse_done": "Finished parsing the document",
    "analyze_section": "Analyzing and synthesizing requirements",
    "score_requirements": "Scoring requirement quality",
    "score_requirements_done": "Scoring complete",
    "section_complete": "Finished analyzing section",
    "infer_trace_links": "Resolving trace/coverage links",
}


def _format_message(progress: LevelingProgress) -> str:
    base = _PHASE_MESSAGES[progress.phase]
    # Parse-stage phases run before build_survey_tree even starts (no
    # section/branch exists yet) -- handled as their own early-return rather
    # than folded into the section-phase logic below, which assumes a
    # section context that doesn't apply here.
    if progress.phase == "describe_figure":
        # Two distinct moments share this one phase: BEFORE the vision call
        # (figure_caption is None -- "something is happening, here's which
        # figure"), and AFTER it returns (the real answer to "what did the
        # model see"). Without the second event, N figures produced N
        # identical "figure N so far" lines with no way to tell them apart
        # or spot which one the model actually failed to describe usefully.
        if progress.figure_caption is not None:
            index_prefix = f"Figure {progress.figure_index}: " if progress.figure_index is not None else "Figure: "
            return index_prefix + _truncate_caption(progress.figure_caption)
        if progress.figure_index is not None:
            base += f" (figure {progress.figure_index} so far)"
        return base
    if progress.phase == "parse_done":
        parts = []
        if progress.block_count is not None:
            parts.append(f"{progress.block_count} block(s)")
        if progress.table_count is not None:
            parts.append(f"{progress.table_count} table(s)")
        if progress.figure_count is not None:
            parts.append(f"{progress.figure_count} figure(s)")
        if parts:
            base += " -- " + ", ".join(parts)
        return base
    if progress.branch_index is not None:
        base += f" (section {progress.branch_index + 1} of {progress.branch_count}"
        if progress.section_label:
            base += f" -- {progress.section_label}"
        base += ")"
    if progress.phase == "score_requirements_done":
        if progress.issues_found is not None:
            base += f" -- {progress.issues_found} quality issue(s) flagged"
    elif progress.phase == "score_requirements" and progress.draft_count is not None:
        base += f" -- scoring {progress.draft_count} drafted requirement(s)"
    elif progress.phase == "section_complete":
        if progress.section_nodes is not None:
            base += f" -- {len(progress.section_nodes)} item(s) drafted"
    else:
        base += f" -- {progress.blocks_done} of {progress.blocks_total} blocks"
    if progress.model:
        base += f" (model: {progress.model})"
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
                "model": progress.model,
                "draftCount": progress.draft_count,
                "issuesFound": progress.issues_found,
                "figureIndex": progress.figure_index,
                "blockCount": progress.block_count,
                "tableCount": progress.table_count,
                "figureCount": progress.figure_count,
                "figureCaption": progress.figure_caption,
                "sectionNodes": (
                    [
                        {
                            "type": n["type"],
                            "title": n["title"],
                            "text": n["text"],
                            "qualityScore": n.get("quality_score"),
                        }
                        for n in progress.section_nodes
                    ]
                    if progress.section_nodes is not None
                    else None
                ),
                "message": _format_message(progress),
            }
        )
        try:
            self._redis.set(f"job-events:{self._job_id}:narration", payload, ex=_CURRENT_NARRATION_TTL_SECONDS)
            self._redis.publish(f"job-events:{self._job_id}", payload)
        except Exception as exc:  # noqa: BLE001 - narration must never fail a SURVEY job
            logger.warning("Failed to publish narration for job %s: %s", self._job_id, exc)
