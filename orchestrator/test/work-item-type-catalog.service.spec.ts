import { WorkItemTypeCatalogService } from '../src/modules/pipeline/work-item-type-catalog.service';

const TEST_CREDENTIAL = { orgUrl: 'https://ado.example', pat: 'pat-123' };

// The icon cache is declared `static` deliberately (process-wide, not
// per-instance/per-request) -- reset it between tests so a cache hit from
// an earlier test doesn't silently mask a bug in a later one asserting a
// fresh fetch happened.
function resetIconCache(): void {
  (WorkItemTypeCatalogService as unknown as { iconCache: Map<string, unknown> }).iconCache.clear();
  (WorkItemTypeCatalogService as unknown as { lookupCache: Map<string, unknown> }).lookupCache?.clear();
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

// GET /jobs/:id for a Diff-ready job made about five sequential ADO round trips on every call (measured 4-8 s), which delayed the
// "Diff ready" screen. These lookups are project metadata: cached briefly per (project, credential), never shared across users.
describe('WorkItemTypeCatalogService lookup cache', () => {
  const LABELS = { Epic: 'Epic', Feature: 'Feature', Requirement: 'User Story' };
  const make = (overrides: Record<string, jest.Mock> = {}) => {
    resetIconCache();
    const mcpClient = {
      discoverWorkItemTypes: jest.fn().mockResolvedValue([]),
      discoverWorkItemTypeCategories: jest.fn().mockResolvedValue(LABELS),
      discoverFieldsDetailed: jest.fn().mockResolvedValue([{ referenceName: 'Microsoft.VSTS.CMMI.RequirementType', allowedValues: ['Functional'] }]),
      ...overrides,
    };
    return { mcpClient, service: new WorkItemTypeCatalogService(mcpClient as any) };
  };

  it('answers a repeat lookup from the cache instead of asking ADO again', async () => {
    const { mcpClient, service } = make();
    await service.resolveCategoryLabels('Project', TEST_CREDENTIAL);
    await service.resolveCategoryLabels('Project', TEST_CREDENTIAL);
    await service.resolve('Project', TEST_CREDENTIAL);
    await service.resolve('Project', TEST_CREDENTIAL);
    expect(mcpClient.discoverWorkItemTypeCategories).toHaveBeenCalledTimes(1);
    expect(mcpClient.discoverWorkItemTypes).toHaveBeenCalledTimes(1);
  });

  it('does not ask for the categories a second time when resolving the classification field', async () => {
    const { mcpClient, service } = make();
    await service.resolveCategoryLabels('Project', TEST_CREDENTIAL);
    const field = await service.resolveRequirementClassificationField('Project', TEST_CREDENTIAL);
    expect(field).toEqual({ referenceName: 'Microsoft.VSTS.CMMI.RequirementType', allowedValues: ['Functional'] });
    expect(mcpClient.discoverWorkItemTypeCategories).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight request between concurrent callers', async () => {
    const { mcpClient, service } = make();
    await Promise.all([service.resolveCategoryLabels('Project', TEST_CREDENTIAL), service.resolveRequirementClassificationField('Project', TEST_CREDENTIAL)]);
    expect(mcpClient.discoverWorkItemTypeCategories).toHaveBeenCalledTimes(1);
  });

  it('never serves one user the answer fetched with another credential or for another project', async () => {
    const { mcpClient, service } = make();
    await service.resolveCategoryLabels('Project', TEST_CREDENTIAL);
    await service.resolveCategoryLabels('Project', { ...TEST_CREDENTIAL, pat: 'someone-elses-pat' });
    await service.resolveCategoryLabels('Project', { orgUrl: 'https://other.example', pat: TEST_CREDENTIAL.pat });
    await service.resolveCategoryLabels('Other', TEST_CREDENTIAL);
    expect(mcpClient.discoverWorkItemTypeCategories).toHaveBeenCalledTimes(4);
  });

  it('does not cache a failed lookup: the next call asks ADO again', async () => {
    const failing = jest.fn().mockRejectedValueOnce(new Error('ADO down')).mockResolvedValue(LABELS);
    const { mcpClient, service } = make({ discoverWorkItemTypeCategories: failing });
    expect(await service.resolveCategoryLabels('Project', TEST_CREDENTIAL)).toEqual({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' });
    expect(await service.resolveCategoryLabels('Project', TEST_CREDENTIAL)).toEqual(LABELS);
    expect(mcpClient.discoverWorkItemTypeCategories).toHaveBeenCalledTimes(2);
  });

  it('asks ADO again once the cached answer is older than the cache lifetime', async () => {
    const { mcpClient, service } = make();
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    await service.resolveCategoryLabels('Project', TEST_CREDENTIAL);
    now.mockReturnValue(1_000_000 + 6 * 60 * 1000);
    await service.resolveCategoryLabels('Project', TEST_CREDENTIAL);
    now.mockRestore();
    expect(mcpClient.discoverWorkItemTypeCategories).toHaveBeenCalledTimes(2);
  });
});
