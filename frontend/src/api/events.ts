export type JobStage =
  | 'parse'
  | 'infer_hierarchy_start'
  | 'infer_hierarchy_done'
  | 'generate_requirements_start'
  | 'generate_requirements_done'
  | 'diff_ready'
  | 'failed';

export interface NarrationEvent {
  // 'analyze_section' replaced the 'infer_hierarchy'/'generate_requirements'
  // pair when the backend's SURVEY pipeline moved to one holistic call per
  // section (see req2ado docs) -- the old two are kept here only so a
  // stale/rolling-deploy backend emitting them doesn't fail this type.
  phase: 'analyze_section' | 'infer_hierarchy' | 'generate_requirements' | 'score_requirements' | 'infer_trace_links';
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
  message: string;
}

export function subscribeToJobEvents(
  jobId: string,
  baseUrl: string,
  onStage: (stage: JobStage) => void,
  onNarration?: (narration: NarrationEvent) => void,
): () => void {
  const source = new EventSource(`${baseUrl}/jobs/${jobId}/events`);
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
