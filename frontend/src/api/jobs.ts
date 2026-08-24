import axios from 'axios';
import { httpClient } from './httpClient';
import type { JobSummary, JobDetail } from '../store/jobsStore';
import type { WarningRecord } from '../utils/warnings';

export interface AuditEntry {
  id: string;
  message: string;
  createdAt: string;
}

// Raw model-response captured behind a soft-failure warning (KB relevance
// verification, trace-link inference, Epic/Feature scoring) -- see
// ingestion's app.debug_capture. Empty array is the common case (no soft
// failures occurred during this job's run).
export interface DebugCaptureEntry {
  kind: string;
  identifier: string;
  content: string;
}

export async function getDebugCaptures(id: string): Promise<DebugCaptureEntry[]> {
  const response = await httpClient.get<DebugCaptureEntry[]>(`/jobs/${id}/debug`);
  return response.data;
}

export async function listJobs(): Promise<JobSummary[]> {
  const response = await httpClient.get<JobSummary[]>('/jobs');
  return response.data;
}

// DESIGN.md §11.2.3.d -- computed server-side (orchestrator's EtaService),
// from this deployment's own real completed-job durations. basis is
// deliberately a two-value union: the shrinkage weight w=n/(n+8) capped at
// 50 samples tops out at ~0.86, so a "fitted" state can never actually be
// returned by the backend.
export interface EtaEstimate {
  mode: 'baseline' | 'survey';
  estimateMinutes: number;
  lowerMinutes: number;
  upperMinutes: number;
  basis: 'bootstrap' | 'blended';
  sampleCount: number;
  modelSampleCount: number;
  modelAdjustment: number;
  windowDays: number;
}

// DESIGN.md §11.1 -- one row of the wizard step-1 document map, the "honest
// answer to what did it read." number is Block.number_label (e.g. "1.1.1"),
// null for a heading the parser couldn't assign a clause number to.
export interface DocumentMapSection {
  number: string | null;
  title: string;
  blockCount: number;
  figureCount: number;
}

export interface PreviewResult {
  blockCount: number;
  sectionCount: number;
  figureCount: number;
  depth: number;
  fileType: string;
  estimate: EtaEstimate;
  tableCount: number;
  openTbdCount: number;
  documentMap: DocumentMapSection[];
}

export async function previewJob(
  file: File,
  // Optional -- NewJobWizard.tsx defaults `mode` to 'baseline' before the
  // user has chosen anything, so the estimate this returns is for whatever
  // mode/model the caller currently has selected, not assumed server-side.
  mode?: 'baseline' | 'survey',
  model?: string,
): Promise<PreviewResult> {
  const form = new FormData();
  form.append('file', file);
  if (mode) form.append('mode', mode);
  if (model) form.append('model', model);
  const response = await httpClient.post('/jobs/preview', form);
  return response.data;
}

// Re-prices without re-uploading -- the reviewer changing mode/model on
// step 2 needs a fresh estimate, and re-uploading a (potentially 40MB)
// file just to change which number is shown would be absurd.
export async function getEstimate(params: {
  blockCount: number;
  figureCount: number;
  mode: 'baseline' | 'survey';
  model?: string;
}): Promise<EtaEstimate> {
  const response = await httpClient.get<EtaEstimate>('/jobs/estimate', { params });
  return response.data;
}

export interface SubmitJobParams {
  file: File;
  areaPath: string;
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

export async function confirmJob(id: string): Promise<{ status: string; createdCount: number }> {
  const response = await httpClient.post(`/jobs/${id}/confirm`);
  return response.data;
}

export async function getAudit(id: string): Promise<AuditEntry[]> {
  const response = await httpClient.get<AuditEntry[]>(`/jobs/${id}/audit`);
  return response.data;
}

// Durable counterpart to the live SSE narration stream (JobEventPersistenceService
// writes every stage/narration event to Postgres as it's published) --
// unlike the SSE stream's 50-entry replay buffer, this survives past the
// job's own completion/failure and past Redis's 1-hour narration-log TTL.
// `detail` is the exact narration/stage payload as received (phase-specific
// fields like sampleTitles/subtreeIndex/errorType, not just `message`).
export interface JobEventRecord {
  id: string;
  jobId: string;
  phase: string;
  message: string;
  detail: Record<string, unknown> | null;
  severity: 'info' | 'warning' | 'error';
  createdAt: string;
}

export async function getEventHistory(id: string): Promise<JobEventRecord[]> {
  const response = await httpClient.get<JobEventRecord[]>(`/jobs/${id}/event-history`);
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

// CR-7d rescore: re-judges ONE Requirement entry's CURRENT description
// (post-edit), forced against its own existing category rubric server-side
// -- see JobsService.rescoreDiffEntry's own docstring. Throws on failure;
// the caller is responsible for reverting its own "Re-checking" UI state
// back to Stale, never fabricating a fresh number locally.
export async function rescoreDiffEntry(jobId: string, localId: string): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.post(`/jobs/${jobId}/diff/${localId}/rescore`);
  return response.data;
}

export interface AddDiffEntryInput {
  // null creates a top-level item (Epic, or a Feature when no Epic exists
  // yet) -- BASELINE jobs never send null (their type is inherited from a
  // real parent's own childType, so there's no top-level type to infer
  // without one; see jobs.service.ts's addDiffEntry doc comment).
  parentLocalId: string | null;
  type: string;
  title: string;
  description: string;
}

export async function addDiffEntry(jobId: string, input: AddDiffEntryInput): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.post(`/jobs/${jobId}/diff`, input);
  return response.data;
}

export interface MoveDiffEntryInput {
  // null moves the entry to the top level.
  parentLocalId: string | null;
  // Omit both for "append last under the new parent" -- only needed to
  // land the entry at a specific position among siblings (a reorder, or a
  // reparent that also needs a specific slot).
  anchorLocalId?: string | null;
  placement?: 'before' | 'after';
}

export async function moveDiffEntry(jobId: string, localId: string, input: MoveDiffEntryInput): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.patch(`/jobs/${jobId}/diff/${localId}/move`, input);
  return response.data;
}

export async function rejectJob(id: string): Promise<{ status: string }> {
  const response = await httpClient.post(`/jobs/${id}/reject`);
  return response.data;
}

export async function cancelJob(id: string): Promise<{ status: string }> {
  const response = await httpClient.post(`/jobs/${id}/cancel`);
  return response.data;
}

export async function deleteJob(id: string): Promise<{ deleted: true }> {
  const response = await httpClient.delete(`/jobs/${id}`);
  return response.data;
}

// Re-runs a job's ORIGINAL upload without the user re-selecting the file --
// only available when the source bytes were retained (JobSourceFile,
// capped at MAX_UPLOAD_SIZE_MB server-side). Creates a brand-new job; the
// source job is untouched. Same sourceHash as the original, so confirm()
// reuses existing ADO items via IdempotencyMapping rather than duplicating
// them -- expected, not a bug, but worth the caller surfacing that copy.
export async function resubmitJob(id: string): Promise<{ jobId: string }> {
  const response = await httpClient.post(`/jobs/${id}/resubmit`);
  return response.data;
}

export interface JobSummaryReport {
  created: number;
  reused: number;
  dedupSkipped: number;
  flagged: number;
  warnings: (WarningRecord | string)[];
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

// Fetches a stored figure's compressed image bytes (JobFigureFile) as a
// Blob, through the same session-cookie-carrying httpClient every other
// request already uses -- pointing an <img src="..."> tag directly at the
// API origin would need its own crossOrigin="use-credentials" wiring and
// server-side CORS-with-credentials config, independent of (and easy to
// drift from) the axios session this app is otherwise built around. The
// caller turns the returned Blob into an object URL (URL.createObjectURL)
// to actually render it. Returns null (not a thrown error) for a 404 --
// the figure was never stored, or was already attached to ADO and deleted
// server-side (see attachFigureToAdo below) -- both are normal states the
// caller renders a quiet placeholder for, not application errors.
export async function getFigureFile(jobId: string, figureId: string): Promise<Blob | null> {
  try {
    const response = await httpClient.get(`/jobs/${jobId}/figures/${figureId}`, { responseType: 'blob' });
    return response.data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    throw err;
  }
}

// Manually (re-)triggers the same ADO attachment jobs.service.ts's confirm()
// already performs automatically for newly-created work items -- the only
// way to attach a figure to a 'reuse'/'dedup_skip' entry (which never goes
// through confirm()'s create/writeback path at all) or to retry a single
// figure that failed confirm()'s best-effort automatic pass. Deletes the
// server-side JobFigureFile row on success, same as the automatic path --
// a re-click after success 404s via getFigureFile above rather than
// re-uploading a duplicate attachment.
export async function attachFigureToAdo(jobId: string, localId: string, figureId: string): Promise<{ attached: true; adoId: number }> {
  const response = await httpClient.post(`/jobs/${jobId}/diff/${localId}/figures/${figureId}/attach`);
  return response.data;
}

// Manual retry for a trace link that failed to write during confirm() --
// mirrors attachFigureToAdo above (POST with no body, server-resolved
// credential/ids).
export async function retryTraceLinkWrite(jobId: string, failureId: string): Promise<{ written: true; sourceAdoId: number; targetAdoId: number }> {
  const response = await httpClient.post(`/jobs/${jobId}/trace-links/${failureId}/retry`);
  return response.data;
}
