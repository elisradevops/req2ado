export type JobStage =
  | 'parse'
  | 'infer_hierarchy_start'
  | 'infer_hierarchy_done'
  | 'generate_requirements_start'
  | 'generate_requirements_done'
  | 'diff_ready'
  | 'failed';

export interface NarrationEvent {
  phase: 'infer_hierarchy' | 'generate_requirements' | 'score_requirements' | 'infer_trace_links';
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
