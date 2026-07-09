import { httpClient } from './httpClient';
import type { AdoRequestCredential } from './jobs';

export interface AreaPathNode {
  path: string;
  children: AreaPathNode[];
}

export async function getAreaPaths(depth: number, credential: AdoRequestCredential): Promise<AreaPathNode> {
  const response = await httpClient.get<AreaPathNode>('/ado/area-paths', {
    params: { depth },
    headers: { 'X-Ado-Org-Url': credential.orgUrl, 'X-Ado-Pat': credential.pat },
  });
  return response.data;
}
