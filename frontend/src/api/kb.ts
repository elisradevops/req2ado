import { httpClient } from './httpClient';

export interface IngestResult {
  documentName: string;
  driveitemId: string;
  mimeType: string | null;
  sizeBytes: number;
  chunksStored: number;
  // Chunks the vector store holds for the file AFTER this call (what the
  // backend persists as chunkCount) -- unlike chunksStored, non-zero for a
  // skipped-unchanged re-ingest. Absent from an older backend.
  chunksInStore?: number | null;
  skippedUnchanged: boolean;
}

export interface IngestedDocument {
  id: string;
  userId: string;
  driveItemId: string;
  name: string;
  sizeBytes: number;
  mimeType: string | null;
  docType: string | null;
  retrievalMode: string | null;
  ingestedAt: string;
  // Chunks held at last ingest; null = unknown (legacy row).
  chunkCount?: number | null;
  // The SharePoint library the file came from; null/absent = added before it was recorded.
  driveId?: string | null;
}

export interface FolderIngestFile {
  file: string;
  status: string;
  chunksStored: number;
  driveitemId: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  reason: string | null;
  relativePath: string | null;
}

export interface FolderIngestResult {
  files: FolderIngestFile[];
}

export async function ingestUrl(url: string, userId: string, docType?: string): Promise<IngestResult> {
  const response = await httpClient.post<IngestResult>('/kb/ingest-url', { url, userId, docType });
  return response.data;
}

export async function ingestFolderUrl(
  url: string,
  userId: string,
  docType?: string,
  recursive?: boolean,
): Promise<FolderIngestResult> {
  const response = await httpClient.post<FolderIngestResult>('/kb/ingest-folder-url', { url, userId, docType, recursive });
  return response.data;
}

// No userId on either call: the session already says whose documents these are (the server reads it from there and ignores a query value),
// and an identity claim in a URL ends up in logs and history.
export async function listIngestedDocuments(): Promise<IngestedDocument[]> {
  const response = await httpClient.get<IngestedDocument[]>('/kb/documents', { params: {} });
  return response.data;
}

export async function deleteIngestedDocument(id: string): Promise<void> {
  await httpClient.delete(`/kb/documents/${id}`);
}

// Switches an already-ingested file between similarity-gated retrieval and full-context injection (no re-ingest).
// How a knowledge-base file reaches a job: 'retrieve' = only when a section is similar to it; 'always_include' = its full text in every job.
export type KbRetrievalMode = 'retrieve' | 'always_include';

export async function setRetrievalMode(id: string, retrievalMode: KbRetrievalMode): Promise<void> {
  await httpClient.put(`/kb/documents/${id}/retrieval-mode`, { retrievalMode });
}

export interface FolderTreeEntry {
  id: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number;
  isFolder: boolean;
  driveId: string | null;
  // The drive this item lives in, for files and folders alike (`driveId` above is only for descending into a folder). What a
  // batch ingest addresses a file by, together with its id. Absent from an older backend.
  parentDriveId?: string | null;
  alreadyIngested: boolean;
  // The matched IngestedDocument's id when alreadyIngested is true -- what
  // a row's remove action deletes by. Null for folders and not-yet-ingested
  // files.
  ingestedDocumentId: string | null;
  // Stored chunk count of the matched row: 0 = ingested but no vectors, null/
  // absent = unknown (not ingested, folder, or a legacy row).
  chunkCount?: number | null;
  // The matched row's retrieval mode; a re-ingest passes it back unchanged.
  retrievalMode?: string | null;
  // Files only -- lets a row's ingest action pull this exact file in via
  // POST /kb/ingest-item without a separate sharing link.
  downloadUrl: string | null;
}

// A POST body, not a query string: the sharing link opens the folder (DESIGN.md §11.7.1) and a query string ends up in proxy and access
// logs. The user id is not sent either: the server takes the user from the session. The parameter stays so callers need not change.
export async function browseSharedFolder(url: string, _userId: string): Promise<FolderTreeEntry[]> {
  const response = await httpClient.post<FolderTreeEntry[]>('/kb/browse-folder', { url });
  return response.data;
}

export async function browseSubfolder(driveId: string, itemId: string, _userId: string, path: string, signal?: AbortSignal): Promise<FolderTreeEntry[]> {
  const response = await httpClient.get<FolderTreeEntry[]>('/kb/browse-children', { params: { driveId, itemId, path }, signal });
  return response.data;
}

export async function ingestFolderItem(
  name: string,
  itemId: string,
  downloadUrl: string,
  relativePath: string,
  userId: string,
  // "retrieve" (default, omitted also means this) similarity-gates this
  // file exactly as before; "always_include" injects its full text into
  // every SURVEY prompt unconditionally, no similarity gate -- modeled on
  // Open WebUI's own Knowledge feature (Focused Retrieval vs Full Context).
  // Right for small, static reference material (a CMMI/requirements-
  // writing-standards doc) whose relevance is definitional, not topical.
  retrievalMode?: KbRetrievalMode,
  // The SharePoint library (Graph drive) the file is in. The server refuses a file from a different library than the one the
  // knowledge base already holds (409 kb_drive_mismatch), so it needs to know.
  driveId?: string,
): Promise<IngestResult & { ingestedDocumentId: string }> {
  const response = await httpClient.post<IngestResult & { ingestedDocumentId: string }>('/kb/ingest-item', {
    name,
    itemId,
    downloadUrl,
    relativePath,
    userId,
    retrievalMode,
    driveId,
  });
  return response.data;
}

// The user agreed to swap libraries: removes the knowledge-base files that came from any other library (or whose library was
// never recorded). `failed` lists the ones that could not be removed; they stay listed and the call can be repeated.
export async function switchKbSource(driveId: string): Promise<{ removed: number; failed: { id: string; name: string }[] }> {
  const response = await httpClient.post<{ removed: number; failed: { id: string; name: string }[] }>('/kb/source/switch', { driveId });
  return response.data;
}

export interface SharePointStatus {
  status: 'not_configured' | 'valid' | 'invalid' | 'unreachable';
  expiresInSeconds: number | null;
}

export async function getSharePointStatus(): Promise<SharePointStatus> {
  const response = await httpClient.get<SharePointStatus>('/kb/sharepoint/status');
  return response.data;
}

export async function reconnectSharePoint(token: string): Promise<SharePointStatus> {
  const response = await httpClient.post<SharePointStatus>('/kb/sharepoint/reconnect', { token });
  return response.data;
}


export interface RubricCategory {
  name: string;
  passCondition: string | null;
  // What the rubric derived for it (a pinned category's text is the user's): what an unpin hands the category back to. null for the user's own.
  basePassCondition?: string | null;
  guidance: string | null;
  pinned: boolean;
  origin: 'kb' | 'default' | 'custom';
  sources: string[];
  mergedFrom: string[];
}

/** The rubric the user's jobs are graded against: derived from their knowledge base, or the built-in one, with their pins and removals applied. */
export interface Rubric {
  version: string;
  source: 'kb' | 'default';
  builtAt: string | null;
  categories: RubricCategory[];
  removed: string[];
}

export interface RubricInput {
  pinned: { name: string; passCondition: string }[];
  removed: string[];
}

export async function getRubric(): Promise<Rubric> {
  const response = await httpClient.get<Rubric>('/kb/rubric');
  return response.data;
}

// Stores the user's pins (a category fixed, or one of their own) and removals; empty lists return to the derived rubric. Answers with the
// rubric that results.
export async function putRubric(input: RubricInput): Promise<Rubric> {
  const response = await httpClient.put<Rubric>('/kb/rubric', input);
  return response.data;
}

// ---- Batch ingest: many files added by one request, ingested one after another by the server ----

export type KbIngestBatchStatus = 'queued' | 'running' | 'paused' | 'completed' | 'completed_with_errors' | 'cancelled' | 'failed';
export type KbIngestItemState = 'queued' | 'running' | 'added' | 'unchanged' | 'failed' | 'skipped' | 'cancelled';

export interface KbIngestItem {
  id: string;
  ordinal: number;
  itemId: string;
  name: string;
  relativePath: string;
  sizeBytes: number;
  retrievalMode: KbRetrievalMode;
  state: KbIngestItemState;
  attempts: number;
  errorKind: 'transient' | 'permanent' | 'auth' | null;
  reason: string | null;
  chunksStored: number | null;
  chunksInStore: number | null;
  ingestedDocumentId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface KbIngestCounts {
  total: number;
  queued: number;
  running: number;
  added: number;
  unchanged: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

export interface KbIngestBatch {
  id: string;
  status: KbIngestBatchStatus;
  // Why a paused batch waits, e.g. "sharepoint_token" (replace the token, and it carries on by itself).
  pauseReason: string | null;
  cancelRequested: boolean;
  driveId: string;
  folderItemId: string | null;
  folderPath: string;
  docType: string | null;
  // Changes whenever anything in the batch does.
  version: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  counts: KbIngestCounts;
  // Present for one batch, absent in a list.
  items?: KbIngestItem[];
}

export interface CreateKbIngestBatchInput {
  driveId: string;
  folderItemId?: string | null;
  folderPath: string;
  docType?: string | null;
  items: { itemId: string; name: string; relativePath: string; sizeBytes: number; retrievalMode: KbRetrievalMode }[];
}

export async function createKbIngestBatch(input: CreateKbIngestBatchInput): Promise<KbIngestBatch> {
  const response = await httpClient.post<KbIngestBatch>('/kb/ingest-batches', input);
  return response.data;
}

export async function listKbIngestBatches(options: { active?: boolean; limit?: number } = {}): Promise<KbIngestBatch[]> {
  const params: Record<string, string | number> = {};
  if (options.active) params.active = 'true';
  if (options.limit !== undefined) params.limit = options.limit;
  const response = await httpClient.get<KbIngestBatch[]>('/kb/ingest-batches', { params });
  return response.data;
}

export async function getKbIngestBatch(id: string): Promise<KbIngestBatch> {
  const response = await httpClient.get<KbIngestBatch>(`/kb/ingest-batches/${id}`);
  return response.data;
}

export async function cancelKbIngestBatch(id: string): Promise<KbIngestBatch> {
  const response = await httpClient.post<KbIngestBatch>(`/kb/ingest-batches/${id}/cancel`);
  return response.data;
}

export async function retryFailedKbIngestBatch(id: string): Promise<KbIngestBatch> {
  const response = await httpClient.post<KbIngestBatch>(`/kb/ingest-batches/${id}/retry-failed`);
  return response.data;
}

export async function resumeKbIngestBatch(id: string): Promise<KbIngestBatch> {
  const response = await httpClient.post<KbIngestBatch>(`/kb/ingest-batches/${id}/resume`);
  return response.data;
}

// ---- The grading rubric the knowledge base builds, as the ingestion report shows it ----

export type KbProfileState = 'none' | 'queued' | 'building' | 'ready' | 'no_model';

export interface KbProfileDocument {
  file: string;
  status: 'contributed' | 'not_relevant' | 'extracted_nothing' | 'failed' | string;
  reason: string | null;
  categories: number;
  rules: number;
  typeDefinitions: number;
  glossary: number;
}

export interface KbProfile {
  state: KbProfileState;
  builtAt: string | null;
  version: string | null;
  builtWith: string | null;
  docsInKb: number;
  docsContributing: number;
  truncated: boolean;
  docs: KbProfileDocument[];
  conflicts: { kind: string; key: string; variantCount: number }[];
}

export async function getKbProfile(): Promise<KbProfile> {
  const response = await httpClient.get<KbProfile>('/kb/profile');
  return response.data;
}
