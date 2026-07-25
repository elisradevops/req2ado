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
  // The submitting user's stable ADO identity (see authStore's userId) --
  // the Knowledge Base scope key, kept separate from areaPath (the ADO
  // write-back destination, unrelated concern). Optional: an unauthenticated
  // caller simply gets no KB grounding for this job.
  userId?: string | null;
  customerId?: string;
  mode: 'baseline' | 'survey';
  state?: string;
  iterationPath?: string;
  // True when this job ingests a follow-up document against requirements
  // already ingested under the same area path -- gates whether the
  // orchestrator runs the dedup-similarity check at all. Defaults to false
  // (a first-time ingestion has nothing to compare against).
  followUp?: boolean;
  // SURVEY-only LLM model override (BASELINE never calls an LLM). Unset
  // means "use whatever the orchestrator is configured with".
  model?: string;
}

export async function submitJob(params: SubmitJobParams): Promise<{ jobId: string }> {
  const form = new FormData();
  form.append('file', params.file);
  form.append('areaPath', params.areaPath);
  form.append('mode', params.mode);
  if (params.userId) form.append('userId', params.userId);
  if (params.customerId) form.append('customerId', params.customerId);
  if (params.state) form.append('state', params.state);
  if (params.iterationPath) form.append('iterationPath', params.iterationPath);
  form.append('followUp', params.followUp ? 'true' : 'false');
  if (params.model) form.append('model', params.model);
  const response = await httpClient.post('/jobs', form);
  return response.data;
}

export async function listModels(): Promise<string[]> {
  const response = await httpClient.get<{ models: string[] }>('/jobs/models');
  return response.data.models;
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

export async function rejectJob(id: string): Promise<{ status: string }> {
  const response = await httpClient.post(`/jobs/${id}/reject`);
  return response.data;
}

export interface JobSummaryReport {
  created: number;
  reused: number;
  dedupSkipped: number;
  flagged: number;
  warnings: string[];
}

export async function getSummary(id: string): Promise<JobSummaryReport> {
  const response = await httpClient.get<JobSummaryReport>(`/jobs/${id}/summary`);
  return response.data;
}

export interface DedupSkipEntry {
  id: string;
  localId: string;
  similarity: number;
  existingAdoId: number;
  createdAt: string;
}

export async function getDedupSkips(id: string): Promise<DedupSkipEntry[]> {
  const response = await httpClient.get<DedupSkipEntry[]>(`/jobs/${id}/dedup-skips`);
  return response.data;
}
