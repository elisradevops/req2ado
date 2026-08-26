from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Callable, Literal

import redis

logger = logging.getLogger(__name__)

# Mirrors JobEventsPublisher's (orchestrator) TTL for the last-known stage
# key -- same rationale: bounds unbounded Redis key growth, not modeling an
# actual expected job lifetime.
_CURRENT_NARRATION_TTL_SECONDS = 3600

# Real gap this closes (user-reported): a reconnecting client (page reload,
# dropped SSE connection) previously only ever replayed the SINGLE latest
# narration event (a `SET`-overwritten key) -- a full activity-log history
# accumulated client-side in JobDetail.tsx's own React state was silently
# lost on any reload, even though the job kept progressing server-side.
# Bounded to match JobDetail.tsx's own client-side cap (`.slice(-50)`) --
# replaying more than the frontend keeps anyway would be wasted bandwidth.
_NARRATION_LOG_MAX_ENTRIES = 50

Phase = Literal[
    "describe_figure",
    "parse_done",
    # Fired once per Table found during parsing, right after parse_done --
    # answers "did my tables ingest correctly" (row count + whether this
    # table's rows are ID-shaped enough to qualify for deterministic
    # hierarchy detection) before the user has to wait for analysis to find
    # out the hard way.
    "table_detected",
    # Real gap this closes: a docx's page-alignment pass (see
    # app/loaders/docx_pagination.py) converts the whole document to PDF via
    # headless LibreOffice then aligns every block/table/figure against it --
    # a real, sometimes slow (30-120s observed) synchronous step with zero
    # narration of its own before this phase existed, fired once at the
    # start (before conversion) and once on completion (carrying the real
    # page count + anchored ratio, distinguishing the two events the same
    # way describe_figure's figure_caption presence does).
    "page_alignment",
    # Real gap this closes (user-reported, live): a multi-minute SILENT
    # window between parse_done and the first analyze_section event, during
    # which build_survey_tree does real, sometimes-slow setup work
    # (deterministic-subtree detection, branch splitting/merging, KB
    # grounding retrieval) with zero narration -- the UI had nothing to show
    # but the LAST real event (parse_done), which made the "Reading
    # document" step indicator look permanently stuck even though the
    # pipeline had already moved on to analysis. Fired exactly once, at the
    # very top of build_survey_tree -- BEFORE deterministic-subtree
    # detection even runs, not just before KB retrieval (confirmed live on
    # a 682-block document: that detection pass alone is real synchronous
    # CPU work with no narration of its own).
    "preparing_analysis",
    # Real gap this closes (confirmed live, AirPro 682-block document):
    # _detect_deterministic_subtrees runs immediately after preparing_analysis
    # and, for a document with many ID-hierarchy table/heading rows, makes a
    # real, unbounded number of sequential per-subtree LLM calls (title/tag
    # synthesis, leaf-requirement synthesis) with ZERO narration of its own --
    # confirmed live as a genuine 20+ minute silent window, not the
    # intentional "no fixed step count" tail-phase design (ProgressBanner.tsx's
    # own isTailPhase) elsewhere in this app. One event per subtree (table or
    # heading-group), as each one's title/tag/synthesis calls run.
    "deterministic_subtree",
    # Real gap this closes: SURVEY's per-branch generation is split into
    # three stages (skeleton -> figure/table mapping -> content authoring,
    # see llm_leveling.build_survey_tree), but stage 1
    # (_build_survey_skeleton_for_branch -- deciding a branch's whole
    # Epic/Feature/Requirement STRUCTURE, with no requirement text written
    # yet) previously fired the SAME 'analyze_section' event stage 3
    # (content authoring) also fires -- stale from before the split, when
    # both were one call. A reviewer watching narration during stage 1 saw
    # "Analyzing and synthesizing requirements" for work that hadn't
    # synthesized a single requirement's text yet. Fired once per branch, at
    # the exact point stage 1's own analyze_section_skeleton /
    # analyze_section_skeleton_agentic call is made (see
    # _build_survey_skeleton_for_branch's own `_fire` closure).
    "build_skeleton",
    "analyze_section",
    "score_requirements",
    "score_requirements_done",
    "section_complete",
    "detect_conflicts",
    # Real gap this closes: STAGE 2 of SURVEY's per-branch generation
    # (binding every figure/table to an exact node id, see
    # _map_figures_tables_to_nodes) fired ZERO narration of its own -- a
    # genuine silent window between the last branch's build_skeleton event
    # and stage 3's first analyze_section event, with no signal the pipeline
    # had moved into a whole-document mapping pass in between. Unlike
    # 'regroup_roots' directly below (see
    # build_survey_tree's own call-site comment for why THAT specific pass
    # stays silent), this is a NEW, dedicated phase added alongside the
    # frontend phase-mapping it needs, precisely so it can narrate without
    # regroup_roots' stepper-regression problem. Fired once per TIER 1
    # branch batch and once per TIER 2 escalation chunk (see
    # _map_figures_tables_to_nodes).
    "map_scope",
    "regroup_roots",
    "infer_trace_links",
    # Real gap this closes (confirmed live): a job that fails deep inside
    # build_survey_tree (e.g. an httpx.ReadTimeout waiting on a scoring LLM
    # call) previously surfaced nothing more than a flattened one-line
    # AuditEntry ("Pipeline failed: Ingestion /level request failed: timed
    # out") -- no phase, no elapsed time, no real exception type. Fired once,
    # from /level's top-level exception handler, carrying whatever phase was
    # last known for this job (see _LAST_PHASE_BY_JOB below) plus the real
    # exception's type/message/elapsed time.
    "job_failed",
    # Real gap this closes (docs/ui-progress-review.md item #3): every
    # chunked LLM pass (title/tag enhancement, leaf synthesis, parent
    # summarization, scoring) already appends a message to a local
    # `warnings` list when one chunk's call fails -- but that list was only
    # ever surfaced once, in Job.warnings, after the WHOLE tree build
    # finishes. A chunk that silently degrades early in a multi-hour SURVEY
    # run gave zero live signal; the engineer only found out at the very
    # end, by which point re-running to fix it costs another multi-hour
    # cycle. Fired ALONGSIDE (never instead of) the existing
    # `warnings.append(message)` call at each site -- same message, both
    # places -- so the final warnings list is byte-identical to before.
    "chunk_warning",
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
    # THIS document. Before this field existed, a figure-heavy document
    # (confirmed live: one real document had 39 embedded figures, each a
    # sequential vision-LLM call during parse) gave zero visible signal for
    # however many minutes that took -- the parse stage was a total black
    # box.
    figure_index: int | None = None
    # parse_done: final counts from the parsed CanonicalDoc, letting the
    # user see exactly what was found in their document the moment parsing
    # finishes. table_count/figure_count are ALSO set on table_detected/
    # describe_figure respectively WHEN a structural pre-count ran ahead of
    # the real walk (see main.py's /ingest -- currently .docx only) --
    # letting "figure N so far" show a real denominator ("figure N of
    # TOTAL") instead of an open-ended counter. None on those two phases
    # when no pre-count was done (unsupported format, or vision/narration
    # inactive), same open-ended wording as before.
    block_count: int | None = None
    table_count: int | None = None
    figure_count: int | None = None
    # page_alignment only: set on the SECOND (completion) event only -- the
    # first (kickoff) event omits both, the same None-means-"in flight"
    # convention describe_figure's figure_caption uses. page_align_page_count
    # is the converted PDF's real total page count; page_align_anchored_ratio
    # is the fraction of anchorable block text that was actually matched
    # against it (see PageAlignment's own docstring) -- surfaced together so
    # a reviewer can tell "how many pages" from "how much do I trust them".
    page_align_page_count: int | None = None
    page_align_anchored_ratio: float | None = None
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
    # describe_figure only: mirrors Figure.caption_status ("insignificant" |
    # "vision_failed" | None) for the SAME figure figure_caption describes.
    # Real live bug this fixes: figure_caption is never blank even when the
    # vision model judged the figure decorative/failed -- main.py's own
    # narration substitutes an honest placeholder ("this figure has no
    # discernible technical content") so the ONE-LINE activity ticker is
    # never blank. But the frontend's separate FigureDescriptions PANEL (a
    # persistent, growing list, not a one-line ticker) used to read that
    # same non-empty placeholder as "a real caption to keep showing" --
    # confirmed live: a document's own logo and warning-triangle icon,
    # correctly judged insignificant by the vision model, still appeared as
    # full entries in that panel during a live run with the placeholder
    # text, even though the SAME figures are correctly excluded once the
    # job completes and JobDetail.tsx reads from the persisted
    # Job.figureDescriptions column instead (pipeline.worker.ts explicitly
    # drops any figure whose real `caption` is null). This field lets the
    # frontend apply that SAME "no real caption -> don't show it" rule
    # during a live run too, without changing figure_caption/the ticker's
    # own text at all.
    figure_caption_status: str | None = None
    # section_complete only: this branch's finished nodes (type/title/text/
    # quality_score, in generation order) -- the real "parsed and formatted
    # response" a reviewer can inspect live, per section, instead of only
    # ever seeing this content once the WHOLE job reaches diff_ready. Kept
    # as plain dicts (not WorkItemNode) so this module stays independent of
    # app.workitem.model -- the caller (llm_leveling.py) does the mapping.
    # None for every other phase.
    section_nodes: list[dict] | None = None
    # deterministic_subtree only: which subtree (0-based) out of how many
    # total this event describes, and a human label (the source Table's id,
    # or the claimed heading-group's own label) -- the same "N of M plus a
    # real name" pattern analyze_section's branch_index/branch_count/
    # section_label already uses, applied to the deterministic-detection
    # pass that previously had no narration at all.
    subtree_index: int | None = None
    subtree_count: int | None = None
    subtree_label: str | None = None
    # table_detected only: this table's own id (subtree_label carries the
    # human display; kept separate here since a table's id and a
    # deterministic-subtree's label serve different call sites and reusing
    # one field for both would make each phase's payload harder to read),
    # its row count, and whether it qualifies for deterministic hierarchy
    # detection (see qualifying_groups's own docstring for the heuristic) --
    # answers "did my tables ingest correctly" before the user has to wait
    # for analysis to find out the hard way.
    table_id: str | None = None
    table_row_count: int | None = None
    table_qualifies: bool | None = None
    # table_detected only: 1-based position of this table among the
    # document's tables (table_count above carries the total) -- same "N of
    # TOTAL" pattern figure_index/figure_count uses, trivially available
    # here since this fires from a post-parse `for table in doc.tables`
    # loop where the full list already exists (unlike figures, no pre-count
    # needed for this one).
    table_index: int | None = None
    # score_requirements/score_requirements_done only: real titles for (a
    # prefix of) the chunk being scored -- previously only a bare count
    # ("150 drafted requirement(s)") with no way to tell which actual items
    # were involved. Capped at a handful (see _MAX_SAMPLE_TITLES) to keep the
    # wire payload small on a large chunk; the count itself still reflects
    # the FULL chunk via draft_count/issues_found, unaffected by the cap.
    sample_titles: list[str] | None = None
    # score_requirements/score_requirements_done only: which chunk (0-based)
    # out of how many total -- the WHOLE document's requirement count is
    # known upfront (unlike figures/tables, whose totals aren't known until
    # parsing finishes walking the document), so this is real progress, not
    # a fabricated guess. Same "N of M" pattern deterministic_subtree's
    # subtree_index/subtree_count already use. None on every other phase.
    chunk_index: int | None = None
    chunk_count: int | None = None
    # job_failed only: the real exception's class name, message, and how
    # long the job had been running when it failed -- replaces the flattened
    # "Pipeline failed: <message>" AuditEntry line with actual structured
    # context. `last_phase` is whatever phase this SAME publish() path last
    # recorded for this job_id (see _LAST_PHASE_BY_JOB) -- best-effort, since
    # a failure during the very first phase has no prior phase to report.
    error_type: str | None = None
    error_message: str | None = None
    elapsed_seconds: float | None = None
    last_phase: str | None = None
    # chunk_warning only: the SAME fully-formed message string the caller
    # already built for warnings.append(...) at this exact call site --
    # this phase has no fixed template of its own (unlike every other
    # phase's _PHASE_MESSAGES entry) because the message is inherently
    # free-form per failure (which chunk, which pass, how many items
    # affected). _format_message returns this verbatim for chunk_warning.
    warning_message: str | None = None


# Caps sample_titles's payload size on a large scoring chunk -- draft_count/
# issues_found already carry the real total, this is purely "which ones,
# for a human to recognize" and doesn't need every single title.
_MAX_SAMPLE_TITLES = 5


def _sample_titles(titles: list[str]) -> list[str]:
    if len(titles) <= _MAX_SAMPLE_TITLES:
        return titles
    return [*titles[:_MAX_SAMPLE_TITLES], f"...and {len(titles) - _MAX_SAMPLE_TITLES} more"]


# Last-known phase per job_id, updated on every publish() call -- purely
# best-effort in-memory state (this ingestion process's own lifetime is the
# job's lifetime for any single /level call, so no cross-process/restart
# concern) letting /level's top-level exception handler report which phase
# was actually running when an unhandled exception occurred, without
# threading a "current phase" parameter through every call in the stack.
_LAST_PHASE_BY_JOB: dict[str, str] = {}


def last_known_phase(job_id: str) -> str | None:
    return _LAST_PHASE_BY_JOB.get(job_id)


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
    "table_detected": "Detected a table",
    "page_alignment": "Deriving real page numbers from a converted PDF",
    "preparing_analysis": "Preparing analysis -- splitting sections, retrieving context",
    "deterministic_subtree": "Extracting a deterministic hierarchy subtree",
    "build_skeleton": "Deciding this section's work-item structure",
    "analyze_section": "Analyzing and synthesizing requirements",
    "score_requirements": "Scoring requirement quality",
    "score_requirements_done": "Scoring complete",
    "section_complete": "Finished analyzing section",
    "detect_conflicts": "Checking near-duplicate requirements for conflicting values",
    "map_scope": "Mapping figures and tables to their work items",
    "regroup_roots": "Grouping disconnected sections by topic",
    "infer_trace_links": "Resolving trace/coverage links",
    "job_failed": "Job failed",
}


def _format_message(progress: LevelingProgress) -> str:
    # chunk_warning has no fixed _PHASE_MESSAGES template (unlike every
    # other phase) -- the caller already built a complete, specific message
    # for warnings.append(...) at its own call site; this returns that
    # SAME string verbatim rather than prefixing/templating it.
    if progress.phase == "chunk_warning":
        return progress.warning_message or "A chunk of work failed"
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
        index_prefix = (
            f"Figure {progress.figure_index}: " if progress.figure_index is not None else "Figure: "
        )
        if progress.figure_caption:
            return index_prefix + _truncate_caption(progress.figure_caption)
        # `figure_caption == ""` (a real vision-model reply, just an empty
        # one -- distinct from `None`, "in flight") previously produced a
        # bare "Figure N: " with nothing after the colon -- confirmed live,
        # a genuinely blank-looking activity-log line, exactly the kind of
        # "cannot be blank" gap this narration system exists to prevent.
        # Falls back to the same honest wording `None` already gets.
        if progress.figure_caption is not None:
            return index_prefix + "no useful caption returned"
        if progress.figure_index is not None:
            base += (
                f" (figure {progress.figure_index} of {progress.figure_count})"
                if progress.figure_count is not None
                else f" (figure {progress.figure_index} so far)"
            )
        return base
    if progress.phase == "table_detected":
        if progress.table_id:
            base += f" {progress.table_id}"
        if progress.table_index is not None and progress.table_count is not None:
            base += f" (table {progress.table_index} of {progress.table_count})"
        if progress.table_row_count is not None:
            base += f" -- {progress.table_row_count} row(s)"
        base += " (qualifies for deterministic hierarchy detection)" if progress.table_qualifies else " (not ID-shaped, will go through LLM analysis)"
        return base
    if progress.phase == "preparing_analysis":
        return base
    if progress.phase == "page_alignment":
        # Completion fire (page_align_page_count present) vs. the earlier
        # kickoff fire (still None) -- same distinguishing convention
        # describe_figure's figure_caption presence uses.
        if progress.page_align_page_count is not None:
            pct = round((progress.page_align_anchored_ratio or 0.0) * 100)
            base += f" -- {progress.page_align_page_count} page(s), {pct}% anchored"
        return base
    if progress.phase == "deterministic_subtree":
        if progress.subtree_index is not None and progress.subtree_count is not None:
            base += f" ({progress.subtree_index + 1} of {progress.subtree_count}"
            if progress.subtree_label:
                base += f" -- {progress.subtree_label}"
            base += ")"
        elif progress.subtree_label:
            base += f" -- {progress.subtree_label}"
        return base
    if progress.phase == "job_failed":
        base = f"Job failed: {progress.error_message or 'unknown error'}"
        if progress.error_type:
            base += f" ({progress.error_type})"
        if progress.last_phase:
            base += f" -- last known phase: {progress.last_phase}"
        if progress.elapsed_seconds is not None:
            base += f", after {round(progress.elapsed_seconds)}s"
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
        if progress.chunk_index is not None and progress.chunk_count is not None:
            base += f" (batch {progress.chunk_index + 1} of {progress.chunk_count})"
        if progress.issues_found is not None:
            base += f" -- {progress.issues_found} quality issue(s) flagged"
        if progress.sample_titles:
            base += f" ({', '.join(progress.sample_titles)})"
    elif progress.phase == "score_requirements" and progress.draft_count is not None:
        if progress.chunk_index is not None and progress.chunk_count is not None:
            base += f" (batch {progress.chunk_index + 1} of {progress.chunk_count})"
        base += f" -- scoring {progress.draft_count} drafted requirement(s)"
        if progress.sample_titles:
            base += f": {', '.join(progress.sample_titles)}"
    elif progress.phase == "section_complete":
        if progress.section_nodes is not None:
            base += f" -- {len(progress.section_nodes)} item(s) drafted"
    elif progress.phase == "infer_trace_links" and progress.sample_titles:
        # Completion fire (real endpoint titles) vs. the earlier kickoff fire
        # (no sample_titles yet, just the plain phase message) for this same
        # phase -- distinguished purely by whether sample_titles is present,
        # no separate phase name needed.
        base += f" -- {', '.join(progress.sample_titles)}"
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
        # Recorded regardless of whether the Redis publish below succeeds --
        # this is what /level's exception handler reads (see
        # last_known_phase) to report which phase was actually running when
        # an unhandled exception occurs; it must stay accurate even during a
        # Redis outage, which is exactly when a failure is most likely to
        # need this context.
        _LAST_PHASE_BY_JOB[self._job_id] = progress.phase
        payload = json.dumps(
            {
                "type": "narration",
                # Real gap this closes: JobEventPersistenceService's own
                # backfillMissedEvents() (orchestrator-side) has no way to
                # know when an event ACTUALLY happened versus when it got
                # persisted -- a backfill sweep run long after the fact was
                # inserting rows stamped with the insertion time, making a
                # long-dead job look recently active to the stale-job
                # watchdog. This is the one place a narration event's real
                # origin time can be captured, at the moment it's actually
                # emitted.
                "emittedAt": datetime.now(UTC).isoformat(),
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
                "pageAlignPageCount": progress.page_align_page_count,
                "pageAlignAnchoredRatio": progress.page_align_anchored_ratio,
                "figureCaption": progress.figure_caption,
                "figureCaptionStatus": progress.figure_caption_status,
                "sectionNodes": (
                    [
                        {
                            "type": n["type"],
                            "title": n["title"],
                            "text": n["text"],
                            "qualityScore": n.get("quality_score"),
                            # Per-row requirement splitting (2026-08-26): lets
                            # a reviewer see this node's own customer_id live,
                            # as soon as content authoring decides it, rather
                            # than only once the job reaches diff_ready.
                            "customerId": n.get("customer_id"),
                        }
                        for n in progress.section_nodes
                    ]
                    if progress.section_nodes is not None
                    else None
                ),
                "subtreeIndex": progress.subtree_index,
                "subtreeCount": progress.subtree_count,
                "subtreeLabel": progress.subtree_label,
                "tableId": progress.table_id,
                "tableRowCount": progress.table_row_count,
                "tableQualifies": progress.table_qualifies,
                "tableIndex": progress.table_index,
                "sampleTitles": progress.sample_titles,
                "chunkIndex": progress.chunk_index,
                "chunkCount": progress.chunk_count,
                "errorType": progress.error_type,
                "errorMessage": progress.error_message,
                "elapsedSeconds": progress.elapsed_seconds,
                "lastPhase": progress.last_phase,
                "warningMessage": progress.warning_message,
                "message": _format_message(progress),
            }
        )
        try:
            # A bounded LIST (not the old single-key SET-overwrite) so a
            # reconnecting client can replay the last N events, not just the
            # very latest one -- see JobEventsController.streamEvents
            # (orchestrator), which reads this same key via LRANGE.
            log_key = f"job-events:{self._job_id}:narration-log"
            self._redis.rpush(log_key, payload)
            self._redis.ltrim(log_key, -_NARRATION_LOG_MAX_ENTRIES, -1)
            self._redis.expire(log_key, _CURRENT_NARRATION_TTL_SECONDS)
            self._redis.publish(f"job-events:{self._job_id}", payload)
        except Exception as exc:  # noqa: BLE001 - narration must never fail a SURVEY job
            logger.warning("Failed to publish narration for job %s: %s", self._job_id, exc)
