import { describe, it, expect, vi } from 'vitest';
import { httpClient } from './httpClient';
import { getAreaPaths } from './ado';

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
});
