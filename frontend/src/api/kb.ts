import { httpClient } from './httpClient';

export interface IngestResult {
  documentName: string;
  driveitemId: string;
  mimeType: string | null;
  sizeBytes: number;
  chunksStored: number;
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

export async function listIngestedDocuments(userId?: string): Promise<IngestedDocument[]> {
  const response = await httpClient.get<IngestedDocument[]>('/kb/documents', { params: userId ? { userId } : {} });
  return response.data;
}

export async function deleteIngestedDocument(id: string, userId: string): Promise<void> {
  await httpClient.delete(`/kb/documents/${id}`, { params: { userId } });
}

export interface FolderTreeEntry {
  id: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number;
  isFolder: boolean;
  driveId: string | null;
  alreadyIngested: boolean;
  // The matched IngestedDocument's id when alreadyIngested is true -- what
  // a row's remove action deletes by. Null for folders and not-yet-ingested
  // files.
  ingestedDocumentId: string | null;
  // Files only -- lets a row's ingest action pull this exact file in via
  // POST /kb/ingest-item without a separate sharing link.
  downloadUrl: string | null;
}

export async function browseSharedFolder(url: string, userId: string): Promise<FolderTreeEntry[]> {
  const response = await httpClient.get<FolderTreeEntry[]>('/kb/browse-folder', { params: { url, userId } });
  return response.data;
}

export async function browseSubfolder(driveId: string, itemId: string, userId: string, path: string): Promise<FolderTreeEntry[]> {
  const response = await httpClient.get<FolderTreeEntry[]>('/kb/browse-children', { params: { driveId, itemId, userId, path } });
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
  retrievalMode?: 'retrieve' | 'always_include',
): Promise<IngestResult & { ingestedDocumentId: string }> {
  const response = await httpClient.post<IngestResult & { ingestedDocumentId: string }>('/kb/ingest-item', {
    name,
    itemId,
    downloadUrl,
    relativePath,
    userId,
    retrievalMode,
  });
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
