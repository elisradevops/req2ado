export type JobStage =
  | 'parse'
  | 'infer_hierarchy_start'
  | 'infer_hierarchy_done'
  | 'generate_requirements_start'
  | 'generate_requirements_done'
  | 'diff_ready'
  | 'failed';

export function subscribeToJobEvents(jobId: string, baseUrl: string, onStage: (stage: JobStage) => void): () => void {
  const source = new EventSource(`${baseUrl}/jobs/${jobId}/events`);
  source.addEventListener('stage', (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as { stage: JobStage };
    onStage(payload.stage);
  });
  return () => source.close();
}
