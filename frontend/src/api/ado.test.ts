import { describe, it, expect, vi } from 'vitest';
import { httpClient } from './httpClient';
import { getAreaPaths, getProjects } from './ado';

vi.mock('./httpClient');

describe('ado api', () => {
  it('getAreaPaths sends depth as a query param and PAT credentials as headers', async () => {
    const areaPathTree = { path: 'Project', children: [] };
    (httpClient.get as any).mockResolvedValue({ data: areaPathTree });

    const result = await getAreaPaths(2, { orgUrl: 'https://ado.example', pat: 'pat-1' });

    expect(httpClient.get).toHaveBeenCalledWith('/ado/area-paths', {
      params: { depth: 2 },
      headers: { 'X-Ado-Org-Url': 'https://ado.example', 'X-Ado-Pat': 'pat-1' },
    });
    expect(result).toEqual(areaPathTree);
  });

  it('getAreaPaths includes a project query param when provided', async () => {
    const areaPathTree = { path: 'OtherProject', children: [] };
    (httpClient.get as any).mockResolvedValue({ data: areaPathTree });

    await getAreaPaths(2, { orgUrl: 'https://ado.example', pat: 'pat-1' }, 'OtherProject');

    expect(httpClient.get).toHaveBeenCalledWith('/ado/area-paths', {
      params: { depth: 2, project: 'OtherProject' },
      headers: { 'X-Ado-Org-Url': 'https://ado.example', 'X-Ado-Pat': 'pat-1' },
    });
  });

  it('getProjects sends PAT credentials as headers and returns the project list', async () => {
    const projects = [{ id: '1', name: 'Project' }];
    (httpClient.get as any).mockResolvedValue({ data: projects });

    const result = await getProjects({ orgUrl: 'https://ado.example', pat: 'pat-1' });

    expect(httpClient.get).toHaveBeenCalledWith('/ado/projects', {
      headers: { 'X-Ado-Org-Url': 'https://ado.example', 'X-Ado-Pat': 'pat-1' },
    });
    expect(result).toEqual(projects);
  });
});
