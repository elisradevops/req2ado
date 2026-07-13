import { describe, it, expect, vi } from 'vitest';
import { httpClient } from './httpClient';
import { listKbSources, createKbSource, syncKbSource } from './kb';

vi.mock('./httpClient');

describe('kb api', () => {
  it('listKbSources GETs /kb/sources', async () => {
    const sources = [{ id: 'kb-1', areaPath: 'Project', siteUrl: 'https://s', library: 'Lib', folder: 'Folder', displayName: 'Docs', lastSyncedAt: null, createdAt: '2026-07-12T00:00:00Z' }];
    (httpClient.get as any).mockResolvedValue({ data: sources });

    const result = await listKbSources();

    expect(httpClient.get).toHaveBeenCalledWith('/kb/sources');
    expect(result).toEqual(sources);
  });

  it('createKbSource POSTs the input to /kb/sources', async () => {
    const created = { id: 'kb-1' };
    (httpClient.post as any).mockResolvedValue({ data: created });
    const input = { areaPath: 'Project', siteUrl: 'https://s', library: 'Lib', folder: 'Folder', displayName: 'Docs' };

    const result = await createKbSource(input);

    expect(httpClient.post).toHaveBeenCalledWith('/kb/sources', input);
    expect(result).toEqual(created);
  });

  it('syncKbSource POSTs the bearer token to /kb/sources/:id/sync', async () => {
    const syncResult = { filesProcessed: 1, filesSkipped: 0, filesFailed: [], chunksStored: 2 };
    (httpClient.post as any).mockResolvedValue({ data: syncResult });

    const result = await syncKbSource('kb-1', 'tok-1');

    expect(httpClient.post).toHaveBeenCalledWith('/kb/sources/kb-1/sync', { bearerToken: 'tok-1' });
    expect(result).toEqual(syncResult);
  });
});
