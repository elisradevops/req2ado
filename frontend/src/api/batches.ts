import { httpClient } from './httpClient';

export interface SubmitBatchParams {
  files: File[];
  areaPath: string;
  adoProject?: string;
  mode: 'baseline' | 'survey';
  state?: string;
  iterationPath?: string;
  model?: string;
}

export interface SubmitBatchResult {
  batchId: string;
  filesAccepted: number;
  filesRejected: number;
}

export async function submitBatch(params: SubmitBatchParams): Promise<SubmitBatchResult> {
  const form = new FormData();
  for (const file of params.files) {
    form.append('files', file);
  }
  form.append('areaPath', params.areaPath);
  if (params.adoProject) form.append('adoProject', params.adoProject);
  form.append('mode', params.mode);
  if (params.state) form.append('state', params.state);
  if (params.iterationPath) form.append('iterationPath', params.iterationPath);
  if (params.model) form.append('model', params.model);
  const response = await httpClient.post('/batches', form);
  return response.data;
}

export interface BatchFile {
  id: string;
  ordinal: number;
  filename: string;
  sizeBytes: number;
  status: string;
  jobId: string | null;
  error: string | null;
  queuePosition: number | null;
}

export interface BatchSummary {
  filesTotal: number;
  filesQueued: number;
  filesRunning: number;
  filesAwaitingReview: number;
  filesSucceeded: number;
  filesFailed: number;
  filesRejected: number;
  filesPending: number;
  created: number;
  reused: number;
  dedupSkipped: number;
  flagged: number;
  itemsWritten: number;
  warningCount: number;
  warningKinds: Record<string, number>;
}

export interface BatchNote {
  kind: string;
  severity: 'info' | 'warning';
  message: string;
}

export interface BatchDetail {
  id: string;
  createdAt: string;
  areaPath: string;
  mode: string;
  state: string | null;
  iterationPath: string | null;
  model: string | null;
  files: BatchFile[];
  summary: BatchSummary;
  notes: BatchNote[];
}

export async function getBatch(batchId: string): Promise<BatchDetail> {
  const response = await httpClient.get<BatchDetail>(`/batches/${batchId}`);
  return response.data;
}

export interface BatchListEntry {
  id: string;
  createdAt: string;
  areaPath: string;
  mode: string;
  filesTotal: number;
  filesSucceeded: number;
  filesFailed: number;
  filesPending: number;
}

export async function listBatches(): Promise<BatchListEntry[]> {
  const response = await httpClient.get<BatchListEntry[]>('/batches');
  return response.data;
}

export async function cancelQueuedFiles(batchId: string): Promise<{ cancelled: number }> {
  const response = await httpClient.post(`/batches/${batchId}/cancel-queued`);
  return response.data;
}
