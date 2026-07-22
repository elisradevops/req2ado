import { httpClient } from './httpClient';
import type { AdoRequestCredential } from './jobs';

export interface AreaPathNode {
  path: string;
  children: AreaPathNode[];
}

export interface AdoProject {
  id: string;
  name: string;
}

export async function getAreaPaths(
  depth: number,
  credential: AdoRequestCredential,
  project?: string,
): Promise<AreaPathNode> {
  const response = await httpClient.get<AreaPathNode>('/ado/area-paths', {
    params: { depth, ...(project ? { project } : {}) },
    headers: { 'X-Ado-Org-Url': credential.orgUrl, 'X-Ado-Pat': credential.pat },
  });
  return response.data;
}

export async function getProjects(credential: AdoRequestCredential): Promise<AdoProject[]> {
  const response = await httpClient.get<AdoProject[]>('/ado/projects', {
    headers: { 'X-Ado-Org-Url': credential.orgUrl, 'X-Ado-Pat': credential.pat },
  });
  return response.data;
}
