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
