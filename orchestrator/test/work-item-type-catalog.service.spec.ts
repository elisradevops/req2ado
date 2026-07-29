import { WorkItemTypeCatalogService } from '../src/modules/pipeline/work-item-type-catalog.service';

const TEST_CREDENTIAL = { orgUrl: 'https://ado.example', pat: 'pat-123' };

// The icon cache is declared `static` deliberately (process-wide, not
// per-instance/per-request) -- reset it between tests so a cache hit from
// an earlier test doesn't silently mask a bug in a later one asserting a
// fresh fetch happened.
function resetIconCache(): void {
  (WorkItemTypeCatalogService as unknown as { iconCache: Map<string, unknown> }).iconCache.clear();
}

describe('WorkItemTypeCatalogService.resolve', () => {
  it('resolves every discovered type to its color and a base64 icon data URL', async () => {
    resetIconCache();
    const mcpClient = {
      discoverWorkItemTypes: jest.fn().mockResolvedValue([
        { name: 'Epic', color: 'FF7B00', icon: { id: 'icon_crown', url: 'x' } },
        { name: 'Bug', color: 'CC293D', icon: { id: 'icon_insect', url: 'x' } },
      ]),
      getWorkItemIcon: jest
        .fn()
        .mockResolvedValueOnce({ contentType: 'image/svg+xml', dataBase64: 'AAA' })
        .mockResolvedValueOnce({ contentType: 'image/svg+xml', dataBase64: 'BBB' }),
    };
    const service = new WorkItemTypeCatalogService(mcpClient as any);

    const result = await service.resolve('Project', TEST_CREDENTIAL);

    expect(mcpClient.discoverWorkItemTypes).toHaveBeenCalledWith('Project', TEST_CREDENTIAL);
    expect(result).toEqual({
      Epic: { color: '#FF7B00', iconDataUrl: 'data:image/svg+xml;base64,AAA' },
      Bug: { color: '#CC293D', iconDataUrl: 'data:image/svg+xml;base64,BBB' },
    });
  });

  it('strips the api-version media-type parameter ADO echoes onto Content-Type before building the data URL', async () => {
    // Regression: ADO's own content negotiation for the icon endpoint
    // echoes the Accept header's api-version param back onto Content-Type
    // (confirmed live: "image/svg+xml; api-version=7.1", not a bare MIME
    // type -- see realAdo.ts's getWorkItemIcon doc comment). Stuffing that
    // verbatim into a data: URI's media-type slot isn't spec-compliant
    // (RFC 2397 requires a bare MIME type there) -- must be stripped to
    // just "image/svg+xml".
    resetIconCache();
    const mcpClient = {
      discoverWorkItemTypes: jest.fn().mockResolvedValue([
        { name: 'Epic', color: 'FF7B00', icon: { id: 'icon_crown', url: 'x' } },
      ]),
      getWorkItemIcon: jest.fn().mockResolvedValue({ contentType: 'image/svg+xml; api-version=7.1', dataBase64: 'AAA' }),
    };
    const service = new WorkItemTypeCatalogService(mcpClient as any);

    const result = await service.resolve('Project', TEST_CREDENTIAL);

    expect(result.Epic.iconDataUrl).toBe('data:image/svg+xml;base64,AAA');
  });

  it('drops a type whose icon fails to resolve, without failing the whole catalog', async () => {
    resetIconCache();
    const mcpClient = {
      discoverWorkItemTypes: jest.fn().mockResolvedValue([
        { name: 'Epic', color: 'FF7B00', icon: { id: 'icon_crown', url: 'x' } },
        { name: 'Broken', color: '000000', icon: { id: 'icon_missing', url: 'x' } },
      ]),
      getWorkItemIcon: jest
        .fn()
        .mockResolvedValueOnce({ contentType: 'image/svg+xml', dataBase64: 'AAA' })
        .mockRejectedValueOnce(new Error('404')),
    };
    const service = new WorkItemTypeCatalogService(mcpClient as any);

    const result = await service.resolve('Project', TEST_CREDENTIAL);

    expect(result).toEqual({ Epic: { color: '#FF7B00', iconDataUrl: 'data:image/svg+xml;base64,AAA' } });
    expect(result['Broken']).toBeUndefined();
  });

  it('caches a resolved icon across calls -- a second request for the same type never re-fetches the icon', async () => {
    resetIconCache();
    const mcpClient = {
      discoverWorkItemTypes: jest.fn().mockResolvedValue([{ name: 'Epic', color: 'FF7B00', icon: { id: 'icon_crown', url: 'x' } }]),
      getWorkItemIcon: jest.fn().mockResolvedValue({ contentType: 'image/svg+xml', dataBase64: 'AAA' }),
    };
    const service = new WorkItemTypeCatalogService(mcpClient as any);

    await service.resolve('Project', TEST_CREDENTIAL);
    await service.resolve('Project', TEST_CREDENTIAL);

    expect(mcpClient.getWorkItemIcon).toHaveBeenCalledTimes(1);
  });

  it('shares the icon cache across separate service instances -- process-wide, not per-instance', async () => {
    resetIconCache();
    const mcpClient = {
      discoverWorkItemTypes: jest.fn().mockResolvedValue([{ name: 'Epic', color: 'FF7B00', icon: { id: 'icon_crown', url: 'x' } }]),
      getWorkItemIcon: jest.fn().mockResolvedValue({ contentType: 'image/svg+xml', dataBase64: 'AAA' }),
    };

    await new WorkItemTypeCatalogService(mcpClient as any).resolve('Project', TEST_CREDENTIAL);
    await new WorkItemTypeCatalogService(mcpClient as any).resolve('Project', TEST_CREDENTIAL);

    expect(mcpClient.getWorkItemIcon).toHaveBeenCalledTimes(1);
  });
});
