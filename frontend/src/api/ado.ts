import { httpClient } from './httpClient';

export interface AreaPathNode {
  path: string;
  children: AreaPathNode[];
}

export interface AdoProject {
  id: string;
  name: string;
}

// No credential is passed here -- the orchestrator resolves the caller's
// ADO PAT server-side from the credential vault, keyed by the session
// cookie's userId (see CredentialVaultService/AdoCredentialResolver).
// httpClient already sends the session cookie (withCredentials: true).

export interface AdoStatus {
  status: 'not_configured' | 'valid' | 'unreachable';
}

export async function getAdoStatus(): Promise<AdoStatus> {
  const response = await httpClient.get<AdoStatus>('/ado/status');
  return response.data;
}

export async function getAreaPaths(depth: number, project?: string): Promise<AreaPathNode> {
  const response = await httpClient.get<AreaPathNode>('/ado/area-paths', {
    params: { depth, ...(project ? { project } : {}) },
  });
  return response.data;
}

export async function getProjects(): Promise<AdoProject[]> {
  const response = await httpClient.get<AdoProject[]>('/ado/projects');
  return response.data;
}

export async function getIterationPaths(depth: number, project?: string): Promise<AreaPathNode> {
  const response = await httpClient.get<AreaPathNode>('/ado/iteration-paths', {
    params: { depth, ...(project ? { project } : {}) },
  });
  return response.data;
}

export async function getStates(workItemType: string, project?: string): Promise<string[]> {
  const response = await httpClient.get<string[]>('/ado/states', {
    params: { workItemType, ...(project ? { project } : {}) },
  });
  return response.data;
}

export interface WorkItemTypeCatalogEntry {
  color: string;
  // A ready-to-use `data:image/svg+xml;base64,...` URL, resolved entirely
  // server-side (real ADO type discovery + icon bytes, see orchestrator's
  // WorkItemTypeCatalogService) and embedded directly in GET /jobs/:id's
  // own response (JobDetail.tsx) -- there is no separate frontend request
  // for this at all.
  iconDataUrl: string;
}
