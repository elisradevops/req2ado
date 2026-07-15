import { httpClient } from './httpClient';
import type { JobSummary, JobDetail } from '../store/jobsStore';

export interface AdoRequestCredential {
  orgUrl: string;
  pat: string;
}

export interface AuditEntry {
  id: string;
  message: string;
  createdAt: string;
}

function credentialHeaders(credential?: AdoRequestCredential): { headers: Record<string, string> } | undefined {
  if (!credential) return undefined;
  return { headers: { 'X-Ado-Org-Url': credential.orgUrl, 'X-Ado-Pat': credential.pat } };
}

export async function listJobs(): Promise<JobSummary[]> {
  const response = await httpClient.get<JobSummary[]>('/jobs');
  return response.data;
}

export async function previewJob(file: File): Promise<{ blockCount: number; sectionCount: number; fileType: string }> {
  const form = new FormData();
  form.append('file', file);
  const response = await httpClient.post('/jobs/preview', form);
  return response.data;
}

export interface SubmitJobParams {
  file: File;
  areaPath: string;
  customerId?: string;
  mode: 'baseline' | 'survey';
  state?: string;
  iterationPath?: string;
}

export async function submitJob(params: SubmitJobParams): Promise<{ jobId: string }> {
  const form = new FormData();
  form.append('file', params.file);
  form.append('areaPath', params.areaPath);
  form.append('mode', params.mode);
  if (params.customerId) form.append('customerId', params.customerId);
  if (params.state) form.append('state', params.state);
  if (params.iterationPath) form.append('iterationPath', params.iterationPath);
  const response = await httpClient.post('/jobs', form);
  return response.data;
}

export async function getJob(id: string): Promise<JobDetail> {
  const response = await httpClient.get<JobDetail>(`/jobs/${id}`);
  return response.data;
}

export async function confirmJob(id: string, credential?: AdoRequestCredential): Promise<{ status: string; createdCount: number }> {
  const response = await httpClient.post(`/jobs/${id}/confirm`, undefined, credentialHeaders(credential));
  return response.data;
}

export async function getAudit(id: string): Promise<AuditEntry[]> {
  const response = await httpClient.get<AuditEntry[]>(`/jobs/${id}/audit`);
  return response.data;
}

export async function editDiffEntry(
  jobId: string,
  localId: string,
  patch: { title?: string; description?: string },
): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.patch(`/jobs/${jobId}/diff/${localId}`, patch);
  return response.data;
}

export async function setDiffEntryExcluded(jobId: string, localId: string, excluded: boolean): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.patch(`/jobs/${jobId}/diff/${localId}/exclude`, { excluded });
  return response.data;
}

export interface AddDiffEntryInput {
  parentLocalId: string;
  type: string;
  title: string;
  description: string;
}

export async function addDiffEntry(jobId: string, input: AddDiffEntryInput): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.post(`/jobs/${jobId}/diff`, input);
  return response.data;
}
