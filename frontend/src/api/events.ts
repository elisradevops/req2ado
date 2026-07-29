export type JobStage =
  | 'parse'
  | 'infer_hierarchy_start'
  | 'infer_hierarchy_done'
  | 'generate_requirements_start'
  | 'generate_requirements_done'
  | 'diff_ready'
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
    | 'analyze_section'
    | 'infer_hierarchy'
    | 'generate_requirements'
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
    | 'infer_trace_links';
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
  // far in this document (not a fraction -- the total isn't known until
  // parsing finishes walking the whole document).
  figureIndex?: number | null;
  // parse_done only: final counts from the parsed document.
  blockCount?: number | null;
  tableCount?: number | null;
  figureCount?: number | null;
  // describe_figure only: the real vision-model caption for this figure,
  // set on a second event fired once the (potentially slow) vision call
  // returns -- null on the first "in flight" event for the same figure.
  // Already folded (truncated) into `message`; kept here in full in case a
  // caller wants the untruncated text.
  figureCaption?: string | null;
  // section_complete only: this branch's finished nodes, in generation
  // order -- null on every other phase.
  sectionNodes?: { type: string; title: string; text: string; qualityScore: number | null }[] | null;
  message: string;
}

export function subscribeToJobEvents(
  jobId: string,
  baseUrl: string,
  onStage: (stage: JobStage) => void,
  onNarration?: (narration: NarrationEvent) => void,
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
    const payload = JSON.parse((event as MessageEvent).data) as { stage: JobStage };
    onStage(payload.stage);
  });
  source.addEventListener('narration', (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as NarrationEvent;
    onNarration?.(payload);
  });
  return () => source.close();
}
