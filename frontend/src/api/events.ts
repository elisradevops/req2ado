export type JobStage =
  | 'parse'
  | 'infer_hierarchy_start'
  | 'infer_hierarchy_done'
  | 'generate_requirements_start'
  | 'generate_requirements_done'
  | 'diff_ready'
  // Two real pipeline phases that previously published no stage/narration
  // signal at all -- see orchestrator's job-events.publisher.ts for the
  // full story (dedup-check burst, ~543 nodes on a real job; the Confirm/
  // writing phase, previously JobsService held no JobEventsPublisher at
  // all).
  | 'dedup_check'
  | 'writing'
  | 'failed'
  | 'cancelled';

export interface NarrationEvent {
  // 'analyze_section' replaced the 'infer_hierarchy'/'generate_requirements'
  // pair when the backend's SURVEY pipeline moved to one holistic call per
  // section (see req2ado docs) -- the old two are kept here only so a
  // stale/rolling-deploy backend emitting them doesn't fail this type.
  phase:
    // Fired during /ingest's parse stage, BEFORE any of the phases below --
    // describe_figure once per embedded figure (a real, sequential
    // vision-LLM call per figure, confirmed live to take minutes on a
    // figure-heavy document with zero prior visibility), parse_done once
    // parsing finishes with real block/table/figure counts.
    | 'describe_figure'
    | 'parse_done'
    // Fired once per Table found during parsing, right after parse_done --
    // answers "did my tables ingest correctly" before analysis/scoring.
    | 'table_detected'
    // Real gap this closes (user-reported, live): a multi-minute silent
    // window between parse_done and the first analyze_section event --
    // branch splitting/merging and KB retrieval run with zero narration --
    // previously left the UI showing nothing newer than "Finished parsing
    // the document", making the "Reading document" step look permanently
    // stuck even though the pipeline had already moved on to analysis.
    | 'preparing_analysis'
    // Real gap this closes (confirmed live, AirPro 682-block document):
    // _detect_deterministic_subtrees runs immediately after
    // preparing_analysis and, for a document with many ID-hierarchy table/
    // heading rows, makes a real, unbounded number of sequential per-subtree
    // LLM calls with ZERO narration of its own -- confirmed live as a
    // genuine 20+ minute silent window.
    | 'deterministic_subtree'
    // Real gap this closes: SURVEY's per-branch generation is split into
    // three stages (skeleton -> figure/table mapping -> content authoring)
    // -- stage 1 (deciding a branch's whole structure, no requirement text
    // written yet) previously fired the SAME 'analyze_section' event stage
    // 3 also fires, stale from before the split. Fired once per branch, at
    // the start of stage 1's own skeleton call.
    | 'build_skeleton'
    | 'analyze_section'
    | 'infer_hierarchy'
    | 'generate_requirements'
    // STAGE 2 (whole-document figure/table -> exact node id mapping,
    // between stage 1's skeleton and stage 3's content authoring) --
    // previously fired nothing at all, a genuine silent window. Unlike
    // 'regroup_roots' below (which stays deliberately silent, see
    // build_survey_tree's own call-site comment), this is a dedicated new
    // phase. Fired once per TIER 1 branch batch and once per TIER 2
    // escalation chunk.
    | 'map_scope'
    | 'score_requirements'
    // Fired once _apply_quality_scores actually finishes for a section --
    // the first real "scoring concluded" signal; previously nothing told
    // the user scoring had started AND finished, only started.
    | 'score_requirements_done'
    // Fired once, after scoring (if any), with this section's finished
    // nodes (sectionNodes below) -- the real "parsed and formatted
    // response" for a section, viewable live instead of only once the
    // whole job reaches diff_ready.
    | 'section_complete'
    // Whole-tree passes that run after every section is scored, before
    // trace-link inference -- previously silent (confirmed live: a
    // multi-minute gap with zero narration between the last
    // score_requirements_done and infer_trace_links events, exactly where
    // a large document's near-duplicate embedding/judging and root topical
    // regrouping LLM calls actually happen).
    | 'detect_conflicts'
    | 'regroup_roots'
    | 'infer_trace_links'
    // Fired for a docx source only, after parsing, while deriving real page
    // numbers by converting the docx to PDF and anchor-matching its blocks
    // against the PDF's own real per-page text (see ingestion's
    // docx_pagination.py) -- a real, potentially 30-120s silent window
    // otherwise. Two fires per docx: an in-flight start event, then a
    // completion event carrying pageAlignPageCount/pageAlignAnchoredRatio
    // below (both null on the first fire, same describe_figure convention).
    | 'page_alignment'
    // Published by the orchestrator (not ingestion) during the dedup-check
    // burst and the Confirm/writing phase -- reuses blocksDone/blocksTotal
    // for a plain N-of-M counter rather than new field names, matching
    // every other phase's convention here.
    | 'dedup_check'
    | 'writing'
    // Fired once, from /level's top-level exception handler, when an
    // unhandled exception (e.g. an LLM-call timeout) aborts the job --
    // replaces a flattened one-line AuditEntry with real structured context
    // (errorType/errorMessage/elapsedSeconds/lastPhase below).
    | 'job_failed'
    // Real gap this closes (docs/ui-progress-review.md item #3): every
    // chunked LLM pass already recorded a warning in Job.warnings when one
    // chunk's call failed, but that list was only ever surfaced once the
    // WHOLE job finished. Fired ALONGSIDE (never instead of) that same
    // warnings.append(...) -- see warningMessage below for the real text.
    | 'chunk_warning';
  // 'writing' only -- confirm() is several sequential sub-phases
  // (discover_types/create/link_parents/trace_links), not one flat burst;
  // null/undefined on every other phase.
  writeSubPhase?: 'discover_types' | 'create' | 'link_parents' | 'trace_links' | null;
  // Human-readable label for the section this event's branchIndex refers to
  // (typically its own first heading text) -- null/undefined when the
  // backend had nothing to label the section with (or for the whole-tree
  // infer_trace_links phase, which has no single section).
  sectionLabel?: string | null;
  branchIndex: number | null;
  branchCount: number;
  blocksDone: number;
  blocksTotal: number;
  kbGrounded: boolean;
  kbCitations: { sourceFile: string; similarity: number }[];
  // The LLM model doing the work for this step -- null/undefined when the
  // underlying client has none configured (falls back to the orchestrator's
  // default) or a stale/rolling-deploy backend predates this field.
  model?: string | null;
  // How many candidate requirements this section produced, known once
  // analyze_section returns -- only set on the score_requirements phase.
  draftCount?: number | null;
  // How many quality issues were flagged across this section's nodes --
  // only set on score_requirements_done.
  issuesFound?: number | null;
  // describe_figure only: 1-based running count of figures described so
  // far in this document.
  figureIndex?: number | null;
  // parse_done: final counts from the parsed document. figureCount is ALSO
  // set on describe_figure, and tableCount on table_detected, WHEN a
  // structural pre-count ran ahead of the real walk (ingestion's /ingest --
  // currently .docx only) -- letting `message` read "figure N of TOTAL"
  // instead of an open-ended "figure N so far". Null on those two phases
  // when no pre-count was done.
  blockCount?: number | null;
  tableCount?: number | null;
  figureCount?: number | null;
  // describe_figure only: the real vision-model caption for this figure,
  // set on a second event fired once the (potentially slow) vision call
  // returns -- null on the first "in flight" event for the same figure.
  // Already folded (truncated) into `message`; kept here in full in case a
  // caller wants the untruncated text.
  figureCaption?: string | null;
  // describe_figure only: mirrors ingestion's Figure.caption_status
  // ("insignificant" | "vision_failed" | null) for the SAME figure
  // figureCaption describes. figureCaption is NEVER empty even when the
  // model judged the figure decorative/failed (ingestion substitutes an
  // honest placeholder so the activity ticker's one-line status is never
  // blank) -- this field is what actually distinguishes "a real caption"
  // from "a placeholder for a figure with no real caption", the same
  // Boolean(caption) rule pipeline.worker.ts's persisted-job path already
  // applies when building Job.figureDescriptions. null on the real-caption
  // case (mirrors caption_status's own None default).
  figureCaptionStatus?: string | null;
  // section_complete only: this branch's finished nodes, in generation
  // order -- null on every other phase.
  sectionNodes?: { type: string; title: string; text: string; qualityScore: number | null; customerId: string | null }[] | null;
  // deterministic_subtree only: which subtree (0-based) out of how many
  // total, and a human label (the source Table's id, or "Heading
  // hierarchy") -- same "N of M plus a real name" pattern branchIndex/
  // branchCount/sectionLabel already use for analyze_section.
  subtreeIndex?: number | null;
  subtreeCount?: number | null;
  subtreeLabel?: string | null;
  // table_detected only.
  tableId?: string | null;
  tableRowCount?: number | null;
  tableQualifies?: boolean | null;
  // table_detected only: 1-based position of this table among the
  // document's tables (tableCount above carries the total) -- always known
  // (this fires from a post-parse loop over the full table list, no
  // pre-count needed).
  tableIndex?: number | null;
  // score_requirements/score_requirements_done/infer_trace_links only: real
  // item titles (or, for infer_trace_links's completion fire, "A -> B
  // (type)" endpoint labels) for a prefix of the items involved --
  // previously only a bare count with no way to tell which actual items
  // were involved.
  sampleTitles?: string[] | null;
  // score_requirements/score_requirements_done only: which chunk (0-based)
  // out of how many total -- real progress (the whole document's
  // requirement count is known before scoring starts, unlike figure/table
  // totals), unlike blocksDone/blocksTotal's fabricated-100% behavior on
  // every other whole-document tail phase.
  chunkIndex?: number | null;
  chunkCount?: number | null;
  // dedup_check only (published by the orchestrator): the node that just
  // finished its idempotency/dedup lookup.
  currentTitle?: string | null;
  // job_failed only: the real exception's class name, message, how long
  // the job had been running, and whatever phase was last known before it
  // failed.
  errorType?: string | null;
  errorMessage?: string | null;
  elapsedSeconds?: number | null;
  lastPhase?: string | null;
  // chunk_warning only: the same fully-formed message the backend also put
  // in this job's persisted warnings list -- already folded into `message`
  // (this phase has no separate template), kept here too so a caller can
  // dedupe a live warning against the final list without string-parsing
  // `message`.
  warningMessage?: string | null;
  // page_alignment only: set on the SECOND (completion) event only -- the
  // converted PDF's real total page count and what fraction of the docx's
  // own blocks were confidently anchored against it. Null on the first
  // "in flight" event, same convention describe_figure's figureCaption uses.
  pageAlignPageCount?: number | null;
  pageAlignAnchoredRatio?: number | null;
  message: string;
}

// Mirrors ingestion/app/leveling/narration_publisher.py's `Phase` Literal
// EXACTLY -- kept as its own list (not just "every value in NarrationEvent's
// phase union") so a dedicated test (events.phase-sync.test.ts) can read
// that Python file's actual source and assert this list still matches it
// byte-for-byte. This is the guardrail for the exact bug class that caused
// this session's own detect_conflicts/regroup_roots stepper regression
// (a phase added to ingestion's narration publisher, silently unmatched on
// the frontend) -- turns a silent runtime drift into a loud test failure.
export const INGESTION_NARRATION_PHASES = [
  'describe_figure',
  'parse_done',
  'table_detected',
  'preparing_analysis',
  'deterministic_subtree',
  'build_skeleton',
  'analyze_section',
  'score_requirements',
  'score_requirements_done',
  'section_complete',
  'detect_conflicts',
  'map_scope',
  'regroup_roots',
  'infer_trace_links',
  'page_alignment',
  'job_failed',
  'chunk_warning',
] as const;

// Never emitted by ingestion -- 'infer_hierarchy'/'generate_requirements'
// only ever come from a stale/rolling-deploy backend (kept for backward
// compat, see NarrationEvent's own comment); 'dedup_check'/'writing' are
// published by the orchestrator, not ingestion. Excluded from
// INGESTION_NARRATION_PHASES above by design, not an oversight -- the sync
// test only checks ingestion's own Phase Literal against the list above.
const NON_INGESTION_NARRATION_PHASES = ['infer_hierarchy', 'generate_requirements', 'dedup_check', 'writing'] as const;

const KNOWN_NARRATION_PHASES: readonly string[] = [
  ...INGESTION_NARRATION_PHASES,
  ...NON_INGESTION_NARRATION_PHASES,
];

const KNOWN_JOB_STAGES: readonly JobStage[] = [
  'parse',
  'infer_hierarchy_start',
  'infer_hierarchy_done',
  'generate_requirements_start',
  'generate_requirements_done',
  'diff_ready',
  'dedup_check',
  'writing',
  'failed',
  'cancelled',
];

// Previously a blind `JSON.parse(...) as NarrationEvent`/`as { stage:
// JobStage }` cast -- any shape mismatch (a field renamed/dropped on the
// backend) would silently propagate `undefined` into typed state with zero
// signal. These two guards fail loud (console.error + skip the event)
// instead, without adding a new schema-validation dependency for what is,
// today, a small and stable set of required fields.
// Exported so JobDetail.tsx can reuse it to recover real NarrationEvent
// objects out of JobEventRecord.detail -- JobEventPersistenceService
// (orchestrator) stores the exact same raw payload there as what arrives
// over SSE (`detail: payload as object`), so this same validator applies
// unchanged to either source.
export function isValidNarrationEvent(payload: unknown): payload is NarrationEvent {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.phase === 'string' &&
    KNOWN_NARRATION_PHASES.includes(p.phase) &&
    (p.branchIndex === null || typeof p.branchIndex === 'number') &&
    typeof p.branchCount === 'number' &&
    typeof p.blocksDone === 'number' &&
    typeof p.blocksTotal === 'number' &&
    typeof p.kbGrounded === 'boolean' &&
    Array.isArray(p.kbCitations) &&
    typeof p.message === 'string'
  );
}

function isValidStagePayload(payload: unknown): payload is { stage: JobStage } {
  if (typeof payload !== 'object' || payload === null) return false;
  const stage = (payload as Record<string, unknown>).stage;
  return typeof stage === 'string' && (KNOWN_JOB_STAGES as readonly string[]).includes(stage);
}

export function subscribeToJobEvents(
  jobId: string,
  baseUrl: string,
  onStage: (stage: JobStage) => void,
  onNarration?: (narration: NarrationEvent) => void,
  // Real gap this closes: EventSource has no onerror handling at all --
  // an expired session (401) or a dropped connection previously became a
  // silent infinite reconnect loop (EventSource's own built-in retry keeps
  // trying forever) with zero signal to the caller that anything was
  // wrong. Fired on every failed attempt -- callers should debounce/only
  // surface this once until a real event arrives again, not toast on
  // every retry.
  onError?: () => void,
): () => void {
  // withCredentials: true -- required for the session cookie to be sent at
  // all. EventSource defaults to NOT sending cookies (even same-origin in
  // some browsers, and never cross-origin, which this dev/docker topology
  // is: frontend on 4082, orchestrator on 3001). Without this, every SSE
  // connection 401s against AuthGuard (added when job ownership checks were
  // introduced) and the frontend never receives a single stage/narration
  // event -- the job silently looks stuck at whatever status it last had,
  // even though it's genuinely progressing server-side.
  const source = new EventSource(`${baseUrl}/jobs/${jobId}/events`, { withCredentials: true });
  source.addEventListener('stage', (event) => {
    const payload: unknown = JSON.parse((event as MessageEvent).data);
    if (!isValidStagePayload(payload)) {
      console.error('Received a malformed SSE stage event, skipping', payload);
      return;
    }
    onStage(payload.stage);
  });
  source.addEventListener('narration', (event) => {
    const payload: unknown = JSON.parse((event as MessageEvent).data);
    if (!isValidNarrationEvent(payload)) {
      console.error('Received a malformed SSE narration event, skipping', payload);
      return;
    }
    onNarration?.(payload);
  });
  source.addEventListener('error', () => {
    onError?.();
  });
  return () => source.close();
}
