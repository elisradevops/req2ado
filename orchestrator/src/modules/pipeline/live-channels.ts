// Redis names for the live frames ingestion publishes while a job runs (see
// ingestion/app/leveling/live_emitter.py). Kept in step with that module.
export const liveChannel = (jobId: string): string => `job-events:${jobId}:live`;
export const liveDoneKey = (jobId: string): string => `job-events:${jobId}:live-done`;
export const liveLatestKey = (jobId: string): string => `job-events:${jobId}:live-latest`;
