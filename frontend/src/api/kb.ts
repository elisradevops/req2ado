import { httpClient } from './httpClient';

export interface KbSourceSummary {
  id: string;
  areaPath: string;
  siteUrl: string;
  library: string;
  folder: string;
  displayName: string;
  lastSyncedAt: string | null;
  createdAt: string;
}

export interface KbSourceInput {
  areaPath: string;
  siteUrl: string;
  library: string;
  folder: string;
  displayName: string;
}

export interface KbSyncResult {
  filesProcessed: number;
  filesSkipped: number;
  filesFailed: { file: string; reason: string }[];
  chunksStored: number;
}

export async function listKbSources(): Promise<KbSourceSummary[]> {
  const response = await httpClient.get<KbSourceSummary[]>('/kb/sources');
  return response.data;
}

export async function createKbSource(input: KbSourceInput): Promise<KbSourceSummary> {
  const response = await httpClient.post<KbSourceSummary>('/kb/sources', input);
  return response.data;
}

export async function syncKbSource(id: string, bearerToken: string): Promise<KbSyncResult> {
  const response = await httpClient.post<KbSyncResult>(`/kb/sources/${id}/sync`, { bearerToken });
  return response.data;
}
