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
  areaPath: string;
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

export async function ingestUrl(url: string, areaPath: string, docType?: string): Promise<IngestResult> {
  const response = await httpClient.post<IngestResult>('/kb/ingest-url', { url, areaPath, docType });
  return response.data;
}

export async function ingestFolderUrl(
  url: string,
  areaPath: string,
  docType?: string,
  recursive?: boolean,
): Promise<FolderIngestResult> {
  const response = await httpClient.post<FolderIngestResult>('/kb/ingest-folder-url', { url, areaPath, docType, recursive });
  return response.data;
}

export async function listIngestedDocuments(areaPath?: string): Promise<IngestedDocument[]> {
  const response = await httpClient.get<IngestedDocument[]>('/kb/documents', { params: areaPath ? { areaPath } : {} });
  return response.data;
}
