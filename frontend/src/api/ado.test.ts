import { describe, it, expect, vi } from 'vitest';
import { httpClient } from './httpClient';
import { getAreaPaths, getProjects } from './ado';

vi.mock('./httpClient');

// No credential is passed/asserted here anymore -- the orchestrator
// resolves the caller's ADO PAT server-side from the credential vault,
// keyed by the session cookie (httpClient sends it via withCredentials).

describe('ado api', () => {
  it('getAreaPaths sends depth as a query param', async () => {
    const areaPathTree = { path: 'Project', children: [] };
    (httpClient.get as any).mockResolvedValue({ data: areaPathTree });

    const result = await getAreaPaths(2);

    expect(httpClient.get).toHaveBeenCalledWith('/ado/area-paths', { params: { depth: 2 } });
    expect(result).toEqual(areaPathTree);
  });

  it('getAreaPaths includes a project query param when provided', async () => {
    const areaPathTree = { path: 'OtherProject', children: [] };
    (httpClient.get as any).mockResolvedValue({ data: areaPathTree });

    await getAreaPaths(2, 'OtherProject');

    expect(httpClient.get).toHaveBeenCalledWith('/ado/area-paths', { params: { depth: 2, project: 'OtherProject' } });
  });

  it('getProjects returns the project list', async () => {
    const projects = [{ id: '1', name: 'Project' }];
    (httpClient.get as any).mockResolvedValue({ data: projects });

    const result = await getProjects();

    expect(httpClient.get).toHaveBeenCalledWith('/ado/projects');
    expect(result).toEqual(projects);
  });
});
