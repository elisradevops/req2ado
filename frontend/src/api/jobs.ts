import axios from 'axios';
import { httpClient } from './httpClient';
import { loadRuntimeConfig } from './config';
import { useAuthStore } from '../store/authStore';
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

/** One row of a job's token ledger: what the LLM proxy reported for the calls of one pipeline stage on one model. */
export interface TokenUsageRow {
  stage: string;
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

export async function getTokenUsage(id: string): Promise<TokenUsageRow[]> {
  const response = await httpClient.get<TokenUsageRow[]>(`/jobs/${id}/token-usage`);
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
  // Finished runs of about this document's size (half to double its blocks) behind the fit; 0 means the number is extrapolated. Absent on an older server.
  nearSizeSampleCount?: number;
  modelSampleCount: number;
  modelAdjustment: number;
  windowDays: number;
  /** A SURVEY forecast of what the run will spend, when the request gave the document's size. Absent for BASELINE and an older server. */
  tokens?: TokenForecast;
}

export interface TokenRange {
  low: number;
  likely: number;
  high: number;
}

/** A rough forecast of a SURVEY run's model usage (orchestrator token-estimate.ts). `costUsd` exists only when a price is configured for the model. */
export interface TokenForecast {
  documentTokens: number;
  inputTokens: TokenRange;
  outputTokens: TokenRange;
  costUsd?: { low: number; high: number };
  /** True when the forecast is above the deployment's threshold, so Start asks first. */
  requiresConfirmation: boolean;
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
  /** The step-3 overview, made from the parsed text and structure alone. Absent from a server that predates it. */
  overview?: DocumentOverview & { profile?: { summaryInput?: string } };
  /** The result-cache hash of the file's bytes (not its name), for getCachedResult. Absent from a server that predates it. */
  fileHash?: string;
  /** The document's size in tokens, passed back to getEstimate for the cost forecast. Absent from a server that predates it. */
  documentTokens?: number;
  /** What the build leaves out as front matter (cover, notices, revision history, contents, ...), each part with its own heading and page; null when
   *  nothing is. Absent from a server that predates it. */
  leftOut?: LeftOut | null;
}

/** Front matter the build leaves out of the items: the document's own heading (or first words) for each part, with its page. */
export interface LeftOut {
  parts: { text: string; page: number | null }[];
  pages: number[];
  blockIds: string[];
  tableIds: string[];
  titleBlockId: string | null;
}

/** The wizard's overview of a document: `lines` is what step 3 shows, each read off the document's text and structure. */
export interface DocumentOverview {
  synopsis: string;
  caveat: string | null;
  lines?: string[];
  /** The optional AI summary the wizard showed, kept so the job page can show it too. Absent when it was not ready at start. */
  aiSummary?: string;
  /** How the file is built, for the SURVEY job's AI stage; carried to the job, never shown. */
  structureHint?: string;
}

/**
 * The optional AI summary of the document: written by the server from the small prepared input the preview returned, and checked against it.
 * Null when there is none, and also when the call fails or is cancelled: the summary is a bonus, never a reason to show an error.
 */
// fresh: "Write it again" -- the server asks the model even when it already holds a summary for this input.
export async function previewSummary(params: { summaryInput: string; model?: string; fresh?: boolean }, signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await httpClient.post<{ summary: string | null }>('/jobs/preview/summary', params, { signal });
    return response.data?.summary ?? null;
  } catch {
    return null;
  }
}

/** Whether a SURVEY job of this file (by preview's fileHash) would be served from the result cache. False on any failure: a courtesy note. */
export async function getCachedResult(
  params: { fileHash: string; mode: 'baseline' | 'survey'; model?: string },
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const response = await httpClient.get<{ cachedResult?: boolean }>('/jobs/cached-result', { params, signal });
    return response.data?.cachedResult === true;
  } catch {
    return false;
  }
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

/** How a file states its structure, as the pre-study learned it (or the user edited it): what the wizard shows, and what the job is built from. */
export interface RulebookView {
  /** The stored rulebook's id, passed to submitJob. Null when the study learned nothing (nothing is stored for it). */
  id: string | null;
  /** "model" (learned by the model, checked against every row), "user" (an edit that fits the file) or "none" (nothing could be verified). */
  source: 'model' | 'user' | 'none';
  hash: string;
  /** How each table (and the document's headings) will be read, in words. */
  rules: string[];
  warnings: { kind?: string; raw?: string; detail?: Record<string, unknown> }[];
  /** The rulebook's JSON form: what an edit is made on and sent back as. */
  rulebook: Record<string, unknown>;
  /** True when a rulebook stored earlier for this file was returned and no model was asked. */
  reused: boolean;
  /** Why the study was skipped (no model connection for this user), or null. Not a failure: the file is read by its recognised headings and its shape. */
  skipped: string | null;
  /** What the rules make of the file, to check them against it; null for a skipped or empty study and for a rulebook stored before it was kept. */
  details?: RulebookDetails | null;
}

/** One item the rules build, as an example: `row` is the sheet's row number (heading row = 1), null for a document's heading. */
export interface RulebookSample {
  row: number | null;
  title: string;
  /** The parent's title; null for a root. */
  parent: string | null;
}

type LadderCounts = Record<'Epic' | 'Feature' | 'Requirement', number>;

/** What the rules make of the file (ingestion's `_prestudy_response`): capped, display only. */
export interface RulebookDetails {
  /** True when a part of it is an estimate (a document's headings). */
  approximate: boolean;
  tables: {
    name: string;
    totalRows: number;
    typeCounts: LadderCounts;
    /** At most 3 per type. */
    samples: Partial<Record<string, RulebookSample[]>>;
    skipped: {
      count: number;
      /** Reason code -> rows: "type:<the file's value>", "under_skipped", "in_cycle", "no_title" or "no_type". */
      byReason: Record<string, number>;
      /** The first 20; `more` counts the rest. */
      rows: { row: number; reason: string; text: string }[];
      more: number;
    };
  }[];
  /** A document's headings the rules state a type for: an estimate, never exact. */
  document?: { typeCounts: LadderCounts; samples: Partial<Record<string, RulebookSample[]>>; approximate: true } | null;
  /** What the new-job page shows about a studied document (ingestion's app.study.reading); absent for a spreadsheet or an older rulebook. */
  reading?: FileReading | null;
}

/** One Epic or Feature the job will build, with every proposal undecided (the file's original). */
export interface ReadingOutlineItem {
  id: string;
  parent: string | null;
  type: 'Epic' | 'Feature';
  title: string;
  /** The heading it was built from, which a decision names; null for the document's own Epic. */
  headingId: string | null;
  requirements: number;
}

export type ProposalDecision = 'accept' | 'keep';

/** A structure change the study proposes for one heading: never applied until the user accepts it. */
export interface ReadingDecision {
  headingId: string;
  action: 'rename' | 'drop_wrapper';
  title: string;
  newTitle: string | null;
  reason: string;
  decision: ProposalDecision | null;
}

/** The verdict, the decisions, the fixes and the outline of a studied document. */
export interface FileReading {
  kind: 'requirements_export' | 'requirements_spec' | 'prose_spec' | 'other' | null;
  coverTitle: string | null;
  requirements: number;
  withIds: number;
  epics: number;
  features: number;
  outline: ReadingOutlineItem[];
  outlineMore: number;
  decisions: ReadingDecision[];
  fixes: { headingId: string; from: string; to: string }[];
  examples: { customerId: string; title: string; under: string | null }[];
  leftOut: { text: string; page?: number | null; pageEnd?: number | null }[];
  context: string[];
}

// Reads how the file states its structure (the model is asked, with the file attached; a rulebook stored for this user and file is returned without
// asking again, unless `relearn`). Takes minutes the first time: the caller shows progress and can abort.
export async function previewRules(file: File, model?: string, relearn = false, signal?: AbortSignal): Promise<RulebookView> {
  const form = new FormData();
  form.append('file', file);
  if (model) form.append('model', model);
  if (relearn) form.append('relearn', 'true');
  const response = await httpClient.post<RulebookView>('/jobs/preview/rules', form, signal ? { signal } : undefined);
  return response.data;
}

/** The Study of a document (ingestion's /study): what the job's later steps are given as context. Display only in the wizard. */
export interface DocumentStudy {
  orientation: { document_type: string; purpose: string; system: string; conventions: string };
  glossary: { term: string; definition: string }[];
  placeholder_tokens: string[];
  verification_statements: string[];
  standards_cited: string[];
  table_roles: { table: string; role: string }[];
  vocabulary: { table: string; column: string; values: string[]; more: number }[];
  // stopped_by 'empty': the document had no text to read (no model was asked).
  stats: { windows_studied: number; windows_total: number; budget_stopped: boolean; orientation_failed: boolean; from_cache: boolean; stopped_by?: string };
  warnings: string[];
}

/** What the wizard's Study step ended with: the Study, or `skipped` when this job reads none (no model connection for a BASELINE job). */
export type StudyPreviewResult = { kind: 'study'; study: DocumentStudy } | { kind: 'skipped' };

/** Thrown when the reading stops with an error; `status` is the HTTP status the server gave (in a stream, carried on its error line). */
export class StudyPreviewError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// The wizard's "Reading and analyzing the document" step: the same reading the job will do, streamed (fetch, not axios: axios cannot hand a
// browser stream over as it arrives). `onProgress` gets the windows read so far as each heartbeat line arrives; aborting `signal` stops it.
export async function previewStudy(
  input: { file: File; mode: 'baseline' | 'survey'; model?: string; rulebookId?: string },
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<StudyPreviewResult> {
  const form = new FormData();
  form.append('file', input.file);
  form.append('mode', input.mode);
  if (input.model) form.append('model', input.model);
  if (input.rulebookId) form.append('rulebookId', input.rulebookId);
  const { apiBaseUrl } = await loadRuntimeConfig();
  const response = await fetch(`${apiBaseUrl}/jobs/preview/study`, { method: 'POST', body: form, credentials: 'include', signal });
  if (response.status === 401) {
    useAuthStore.getState().logout(); // the same expired-session handling httpClient's interceptor gives every other call
    window.location.assign('/login');
  }
  if (!response.ok || !response.body) {
    let message = `The document could not be read (status ${response.status}).`;
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body?.message === 'string') message = body.message;
    } catch {
      // not JSON: keep the plain sentence
    }
    throw new StudyPreviewError(message, response.status);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffered += value;
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const text = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
      if (!text) continue;
      const line = JSON.parse(text) as { type: string; windowsDone?: number; windowsTotal?: number; study?: DocumentStudy; status?: number; detail?: string };
      if (line.type === 'heartbeat' && typeof line.windowsTotal === 'number' && line.windowsTotal > 0) onProgress(line.windowsDone ?? 0, line.windowsTotal);
      else if (line.type === 'skipped') return { kind: 'skipped' };
      else if (line.type === 'result' && line.study) return { kind: 'study', study: line.study };
      else if (line.type === 'error') throw new StudyPreviewError(line.detail || 'The document could not be read.', line.status ?? 502);
    }
    if (done) throw new StudyPreviewError('The reading ended without an answer.', 502);
  }
}

/** A user's edit of the rulebook, checked against the file. Rejects with the server's reason in `response.data.message` when it does not fit. */
export async function editRules(file: File, rulebook: Record<string, unknown>, model?: string): Promise<RulebookView> {
  const form = new FormData();
  form.append('file', file);
  if (model) form.append('model', model);
  form.append('rulebook', JSON.stringify(rulebook));
  const response = await httpClient.post<RulebookView>('/jobs/preview/rules/edit', form);
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
  documentTokens?: number;
}): Promise<EtaEstimate> {
  const response = await httpClient.get<EtaEstimate>('/jobs/estimate', { params });
  return response.data;
}

export interface SubmitJobParams {
  file: File;
  areaPath: string;
  // The ADO project this job writes into -- optional at this layer (a
  // non-ADO-session mock context has no project to send), but the backend
  // validates it against areaPath's own project segment when both are
  // present.
  adoProject?: string;
  mode: 'baseline' | 'survey';
  state?: string;
  iterationPath?: string;
  // How wide the duplicate check looks: the area path and everything under it (the default; not sent) or the whole project.
  dedupScope?: 'area_path' | 'project';
  // SURVEY-only LLM model override (BASELINE never calls an LLM). Unset
  // means "use whatever the orchestrator is configured with".
  model?: string;
  // Generated by the wizard's SURVEY-only "Confirm understanding" step
  // (previewExposition above) -- undefined/null for BASELINE or a failed
  // generation.
  documentOverview?: DocumentOverview | null;
  // The stored rulebook the wizard showed (RulebookView.id): the job is built from exactly it. Unset: the file is not studied for this job.
  rulebookId?: string;
}

export async function submitJob(params: SubmitJobParams): Promise<{ jobId: string }> {
  const form = new FormData();
  form.append('file', params.file);
  form.append('areaPath', params.areaPath);
  if (params.adoProject) form.append('adoProject', params.adoProject);
  form.append('mode', params.mode);
  if (params.state) form.append('state', params.state);
  if (params.iterationPath) form.append('iterationPath', params.iterationPath);
  if (params.dedupScope === 'project') form.append('dedupScope', params.dedupScope);
  if (params.model) form.append('model', params.model);
  if (params.documentOverview) form.append('documentOverview', JSON.stringify(params.documentOverview));
  if (params.rulebookId) form.append('rulebookId', params.rulebookId);
  const response = await httpClient.post('/jobs', form);
  return response.data;
}

// What the app can state about one selectable model; every field is something it did or observed, not a quality rating.
export interface ModelDetail {
  id: string;
  name: string;
  describesFigures: boolean;
  runs: number;
  speedVsTypical: number | null;
  finishedShare: number | null;
}

export interface ModelListing {
  models: string[];
  recommended: string | null;
  details: ModelDetail[];
}

export async function listModels(): Promise<ModelListing> {
  const response = await httpClient.get<Partial<ModelListing> & { models: string[] }>('/jobs/models');
  // An older orchestrator sends only the ids: the extras are optional, the list is not.
  return { models: response.data.models, recommended: response.data.recommended ?? null, details: response.data.details ?? [] };
}

export async function getJob(id: string): Promise<JobDetail> {
  const response = await httpClient.get<JobDetail>(`/jobs/${id}`);
  return response.data;
}

// `startStateNotes`: one line per type whose workflow lacks the job's chosen state, so its items started in their own default state.
export async function confirmJob(
  id: string,
): Promise<{ status: string; createdCount: number; linkedInsteadCount?: number; startStateNotes?: string[] }> {
  const response = await httpClient.post(`/jobs/${id}/confirm`);
  return response.data;
}

// Rebuilds this job's duplicate index from its own records (no Azure DevOps call); a repair for a confirm whose index update failed.
export async function reindexDedup(id: string): Promise<{ indexed: number }> {
  const response = await httpClient.post<{ indexed: number }>(`/jobs/${id}/dedup/reindex`);
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
  patch: {
    title?: string;
    description?: string;
    customerId?: string | null;
    tags?: string[];
    seCoverageRef?: string | null;
    // Applying an assistant's suggestion: keep what it replaces (for Undo) and mark that suggestion accepted.
    snapshot?: boolean;
    suggestionId?: string;
  },
): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.patch(`/jobs/${jobId}/diff/${localId}`, patch);
  return response.data;
}

// Keeps the assistant's newest suggestion with the item, so it survives closing the chat and stepping to another item. See JobsService.setSuggestion.
export async function setSuggestion(
  jobId: string,
  localId: string,
  suggestion: { proposedTitle: string | null; proposedDescription: string | null },
): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.put(`/jobs/${jobId}/diff/${localId}/suggestion`, suggestion);
  return response.data;
}

// What the reviewer did with the suggestion. An accept is recorded by the edit that applies it. See JobsService.decideSuggestion.
export async function decideSuggestion(
  jobId: string,
  localId: string,
  decision: 'rejected' | 'discussed',
  suggestionId?: string,
): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.patch(`/jobs/${jobId}/diff/${localId}/suggestion`, { decision, suggestionId });
  return response.data;
}

// Undo of an applied suggestion: the text and the scores it replaced come back. Refused (409) once the item was edited since.
export async function revertDiffEntry(jobId: string, localId: string): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.post(`/jobs/${jobId}/diff/${localId}/revert`);
  return response.data;
}

// "To be discussed": park a proposed rewrite in the ADO Discussion at write time without touching the baseline text. See JobsService.addDiscussionEntry.
export async function addDiscussionEntry(
  jobId: string,
  localId: string,
  entry: { proposedTitle?: string; proposedDescription?: string },
): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.post(`/jobs/${jobId}/diff/${localId}/discussion`, entry);
  return response.data;
}

export async function removeDiscussionEntry(jobId: string, localId: string, entryId: string): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.delete(`/jobs/${jobId}/diff/${localId}/discussion/${entryId}`);
  return response.data;
}

// "Create as new item" on a skipped near-duplicate: it becomes a new item that remembers what it matched, optionally linked into the job's tree
// and optionally Related to the item it matched. The existing item is never changed. See JobsService.overrideDuplicate.
export async function overrideDuplicate(jobId: string, localId: string, options: { linkTree: boolean; relateToExisting: boolean }): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.post(`/jobs/${jobId}/diff/${localId}/duplicate-override`, options);
  return response.data;
}

export async function undoDuplicateOverride(jobId: string, localId: string): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.delete(`/jobs/${jobId}/diff/${localId}/duplicate-override`);
  return response.data;
}

export async function setDiffEntryExcluded(jobId: string, localId: string, excluded: boolean): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.patch(`/jobs/${jobId}/diff/${localId}/exclude`, { excluded });
  return response.data;
}

// The review gate for a generated acceptance-criteria proposal: it is written to ADO only while accepted. See JobsService.setProposalAccepted.
export async function setProposalAccepted(jobId: string, localId: string, accepted: boolean): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.patch(`/jobs/${jobId}/diff/${localId}/proposal`, { accepted });
  return response.data;
}

// Advisory "I've checked these" flag, set for many items in one request --
// see JobsService.setDiffEntriesReviewed. Never changes what Confirm writes.
export async function setDiffEntriesReviewed(jobId: string, localIds: string[], reviewed: boolean): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.patch(`/jobs/${jobId}/diff/reviewed`, { localIds, reviewed });
  return response.data;
}

// Marks integrity warnings handled. By kind (all records of it) or, with
// `raws`, only the records with that exact text -- see
// JobsService.setWarningsAcknowledged for why not by array index.
export async function setWarningsAcknowledged(
  jobId: string,
  input: { kind: string; raws?: string[]; acknowledged: boolean },
): Promise<{ warnings: unknown }> {
  const response = await httpClient.patch(`/jobs/${jobId}/warnings/acknowledged`, input);
  return response.data;
}

// Re-runs a failed optional enhancement pass for a batch of the items its
// warning lists (see JobsService.retryEnhancement). The caller sends one
// batch at a time and loops; `enhanced` ids changed, `failed` ids got
// nothing usable from the model, `skipped` ids were excluded, edited since,
// or otherwise left alone.
export interface RetryEnhancementResult {
  dryRunDiff: unknown;
  warnings: unknown;
  enhanced: string[];
  failed: string[];
  skipped: string[];
}

export async function retryEnhancement(
  jobId: string,
  input: { kind: string; pass: 'title_tag' | 'synthesis' | 'parent_summary'; localIds: string[] },
): Promise<RetryEnhancementResult> {
  const response = await httpClient.post(`/jobs/${jobId}/warnings/retry-enhancement`, input);
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

// How the file was read for a job (the new-job page's reading, from the rulebook the job was built from) and the code shape it learned; a
// null reading for a job built without one.
export async function getJobFileReading(jobId: string): Promise<{ reading: FileReading | null; codes: string[] }> {
  const response = await httpClient.get(`/jobs/${jobId}/file-reading`);
  return response.data;
}

// Changes an item's type within the ladder (owner decision, 2026-11-25). The server allows only a type the item's parent allows and that allows
// its children, only for an item this job creates and has not written; Undo is the same call with the entry's `retypedFrom`.
export async function changeDiffEntryType(jobId: string, localId: string, type: string): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.patch(`/jobs/${jobId}/diff/${localId}/type`, { type });
  return response.data;
}

export async function moveDiffEntry(jobId: string, localId: string, input: MoveDiffEntryInput): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.patch(`/jobs/${jobId}/diff/${localId}/move`, input);
  return response.data;
}

// Moves one figure of an entry to another entry before the write (same list kind), or detaches it when targetLocalId is null
// (the image stays stored but is no longer attached). Returns the updated diff; the server refuses written, excluded or
// identical targets and a figure that is not on the source. See JobsService for the rules.
export async function moveFigure(
  jobId: string,
  sourceLocalId: string,
  figureId: string,
  targetLocalId: string | null,
): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.patch(`/jobs/${jobId}/diff/${sourceLocalId}/figures/${figureId}`, { targetLocalId });
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

// What a write would do for this job right now, computed by the server with the rules the write itself uses (GET /jobs/:id/write-preview).
export interface WritePreview {
  createdTotal: number;
  createdLocalIds: string[];
  createdByType: Record<string, number>;
  excluded: { direct: number; viaAncestor: number };
  parentLinks: number;
  existingGettingChildren: number;
  existingWithoutNewParentLink: number;
  traceLinks: { planned: number; skipped: number };
  alreadyWritten: number;
  // Figure attachments still to upload; counts as work.
  figuresToAttach: number;
  // Figures that have no stored file and will not be attached; does not count as work.
  figuresUnavailable: number;
  // Set by the server: the write has anything left to do, and only figures are left.
  hasWork: boolean;
  figuresOnly: boolean;
}

export async function getWritePreview(id: string): Promise<WritePreview> {
  const response = await httpClient.get<WritePreview>(`/jobs/${id}/write-preview`);
  return response.data;
}

// WID 300578: post-write validation, diffing the real ADO state of every
// created/resumed work item against what the confirmed dryRunDiff expected
// -- catches ADO-side field-length truncation/picklist coercion silently
// altering what was written, not just "did the item get created at all."
// `field` can be the synthetic value 'existence' (JobsService.
// validateCreatedTree's own convention) when the ADO item itself is simply
// missing, rather than one of its real field ref names.
export interface ValidationMismatch {
  localId: string;
  adoWorkItemId: number;
  field: string;
  expected: string;
  actual: string;
}

export interface ValidationResult {
  valid: boolean;
  checkedCount: number;
  mismatches: ValidationMismatch[];
}

export async function validateCreatedTree(id: string): Promise<ValidationResult> {
  const response = await httpClient.get<ValidationResult>(`/jobs/${id}/validate`);
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
// The original wording behind one item, read again from the job's kept upload (the evidence strip). 'section' is a SURVEY
// item's whole source section (its words are written from it, not copied); 'table' is the table, or the row, it came from.
// 'unavailable' is a normal answer (no kept original, no span of its own, a parse that failed or timed out).
export type EntrySource =
  | { kind: 'text' | 'table' | 'section'; text: string; truncated: boolean }
  | { kind: 'unavailable'; reason?: 'no_original' | 'no_span' | 'parse_failed' };

export async function getEntrySource(jobId: string, localId: string, signal?: AbortSignal): Promise<EntrySource> {
  const response = await httpClient.get<EntrySource>(`/jobs/${jobId}/diff/${localId}/source`, { signal });
  const data = response.data as Partial<{ kind: unknown; text: unknown; truncated: unknown; reason: unknown }> | undefined;
  if ((data?.kind === 'text' || data?.kind === 'table' || data?.kind === 'section') && typeof data.text === 'string' && data.text) {
    return { kind: data.kind, text: data.text, truncated: data.truncated === true };
  }
  // Anything else is shown as "no wording", never as a quote.
  if (data?.reason === 'no_original' || data?.reason === 'no_span' || data?.reason === 'parse_failed') return { kind: 'unavailable', reason: data.reason };
  return { kind: 'unavailable' };
}

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


/** Why an item got the scores it did: one short reason per category asked about, and what the category is held to. */
export interface ScoreExplanation {
  explanations: { category: string; score: number | null; reason: string | null; passCondition: string | null }[];
  basis: 'knowledge_base' | 'built_in';
  rubric: { source: string; version: string | null };
}

// Read-only, one short model call, on demand. Without `categories` the weakest categories are explained.
export async function explainScore(jobId: string, localId: string, categories?: string[]): Promise<ScoreExplanation> {
  const response = await httpClient.post<ScoreExplanation>(`/jobs/${jobId}/diff/${localId}/score-explain`, categories?.length ? { categories } : {});
  return response.data;
}
