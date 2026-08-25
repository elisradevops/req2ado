import { McpClient, McpRequestTimeoutError } from '../src/modules/pipeline/mcp.client';

// S9 (MCP -> REST cutover): McpClient's internals moved from the MCP SDK's
// StreamableHTTP transport to a plain fetch-based POST against
// mcp-ado-server's /api/ado/:operation REST router (src/rest/router.ts on
// that side, built off the same operations registry the old MCP tools used)
// -- these tests mock global.fetch directly instead of the SDK's Client
// class, matching this repo's existing fetch-mocking style (see
// ingestion-http.client.spec.ts). Public method signatures and every
// call-site contract (operation name -> args shape, credential headers,
// error propagation, timeout behavior) are unchanged from the MCP version.
describe('McpClient', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  function mockJsonResponse(body: unknown, status = 200): void {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
  }

  it('createWorkItem POSTs to the ado_create_work_item operation with the right arguments', async () => {
    mockJsonResponse({ id: 42 });

    const client = new McpClient('http://mcp.internal/api/ado', 'test-bearer');
    const result = await client.createWorkItem('Requirement', { 'System.Title': 'Test' });

    expect(result).toEqual({ id: 42 });
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://mcp.internal/api/ado/ado_create_work_item');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ type: 'Requirement', fields: { 'System.Title': 'Test' } });
  });

  it('linkParentChild POSTs to the ado_link_parent_child operation', async () => {
    mockJsonResponse({ ok: true });

    const client = new McpClient('http://mcp.internal/api/ado', 'test-bearer');
    await client.linkParentChild(42, 7);

    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://mcp.internal/api/ado/ado_link_parent_child');
    expect(JSON.parse(options.body)).toEqual({ childId: 42, parentId: 7 });
  });

  it('discoverFields POSTs to ado_discover_fields and parses the field list', async () => {
    mockJsonResponse(['System.Title', 'Custom.CustomerId']);

    const client = new McpClient('http://mcp.internal/api/ado', 'test-bearer');
    const result = await client.discoverFields('Requirement');

    expect(result).toEqual(['System.Title', 'Custom.CustomerId']);
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://mcp.internal/api/ado/ado_discover_fields');
    expect(JSON.parse(options.body)).toEqual({ workItemType: 'Requirement' });
  });

  it('discoverFieldsDetailed POSTs to ado_discover_fields_detailed and parses the descriptor list', async () => {
    mockJsonResponse([
      { referenceName: 'System.Title', allowedValues: [], alwaysRequired: false },
      { referenceName: 'Microsoft.VSTS.CMMI.RequirementType', allowedValues: ['Functional', 'Safety'], alwaysRequired: true },
    ]);

    const client = new McpClient('http://mcp.internal/api/ado', 'test-bearer');
    const result = await client.discoverFieldsDetailed('Requirement');

    expect(result).toEqual([
      { referenceName: 'System.Title', allowedValues: [], alwaysRequired: false },
      { referenceName: 'Microsoft.VSTS.CMMI.RequirementType', allowedValues: ['Functional', 'Safety'], alwaysRequired: true },
    ]);
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://mcp.internal/api/ado/ado_discover_fields_detailed');
    expect(JSON.parse(options.body)).toEqual({ workItemType: 'Requirement' });
  });

  it('queryIds POSTs to ado_query_ids with the given field match, omitting project when not given', async () => {
    mockJsonResponse([100, 101]);

    const client = new McpClient('http://mcp.internal/api/ado', 'test-bearer');
    const result = await client.queryIds({ 'System.AreaPath': 'Project\\Area1' });

    expect(result).toEqual([100, 101]);
    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ fieldMatch: { 'System.AreaPath': 'Project\\Area1' } });
  });

  it('queryIds forwards project when given (per-job ADO project override)', async () => {
    mockJsonResponse([100, 101]);

    const client = new McpClient('http://mcp.internal/api/ado', 'test-bearer');
    await client.queryIds({ 'System.AreaPath': 'Project\\Area1' }, 'Project');

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ fieldMatch: { 'System.AreaPath': 'Project\\Area1' }, project: 'Project' });
  });

  it('readAreaPaths POSTs to ado_read_area_paths and parses the result', async () => {
    mockJsonResponse({ path: 'Project', children: [] });

    const client = new McpClient('http://mcp.internal/api/ado', 'test-bearer');
    const result = await client.readAreaPaths(3);

    expect(result).toEqual({ path: 'Project', children: [] });
    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ depth: 3 });
  });

  it('forwards project in the request body when provided (per-project area-path override)', async () => {
    mockJsonResponse({ path: 'OtherProject', children: [] });

    const client = new McpClient('http://mcp.internal/api/ado', 'test-bearer');
    await client.readAreaPaths(3, 'OtherProject');

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ depth: 3, project: 'OtherProject' });
  });

  it('discoverProjects POSTs to ado_discover_projects and parses the result', async () => {
    mockJsonResponse([{ id: '1', name: 'Project' }]);

    const client = new McpClient('http://mcp.internal/api/ado', 'test-bearer');
    const result = await client.discoverProjects();

    expect(result).toEqual([{ id: '1', name: 'Project' }]);
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://mcp.internal/api/ado/ado_discover_projects');
    expect(JSON.parse(options.body)).toEqual({});
  });

  it('linkWorkItems POSTs to ado_link_work_items with fromId/toId/referenceName', async () => {
    mockJsonResponse({ ok: true });

    const client = new McpClient('http://mcp.internal/api/ado', 'test-bearer');
    await client.linkWorkItems(101, 100, 'Elisra.CoveredBy-Forward');

    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://mcp.internal/api/ado/ado_link_work_items');
    expect(JSON.parse(options.body)).toEqual({ fromId: 101, toId: 100, referenceName: 'Elisra.CoveredBy-Forward' });
  });

  it('discoverLinkTypes POSTs to ado_discover_link_types and parses the JSON array result', async () => {
    const linkTypes = [{ referenceName: 'System.LinkTypes.Related', name: 'Related' }];
    mockJsonResponse(linkTypes);

    const client = new McpClient('http://mcp.internal/api/ado', 'test-bearer');
    const result = await client.discoverLinkTypes();

    expect(result).toEqual(linkTypes);
  });

  it('createWorkItem throws the real error message when the response is not ok', async () => {
    // Regression (carried over from the MCP version): the ADO-detail error
    // message (mcp-ado-server's adoErrorMessage, e.g. a real TF400xxx code)
    // must survive to the caller, not collapse into a bare status code.
    mockJsonResponse({ error: 'No api-version in the ladder [7.1, 7.0, 5.1, none] succeeded against x' }, 502);

    const client = new McpClient('http://mcp.internal/api/ado', 'test-bearer');
    await expect(client.createWorkItem('Requirement', {})).rejects.toThrow(
      'No api-version in the ladder [7.1, 7.0, 5.1, none] succeeded against x',
    );
  });

  it('linkParentChild throws the real error message when the response is not ok', async () => {
    // Regression: linkParentChild/linkWorkItems previously discarded the
    // callTool result entirely instead of checking isError -- a failed ADO
    // relation write resolved as silent success, and jobs.service.ts then
    // durably marked the link as done when it never happened. The REST
    // cutover's equivalent failure mode is trusting response.ok === true
    // without it actually being true.
    mockJsonResponse({ error: 'TF401232: parent work item does not exist' }, 502);

    const client = new McpClient('http://mcp.internal/api/ado', 'test-bearer');
    await expect(client.linkParentChild(42, 7)).rejects.toThrow('TF401232: parent work item does not exist');
  });

  it('linkWorkItems throws the real error message when the response is not ok', async () => {
    mockJsonResponse({ error: 'TF401232: target work item does not exist' }, 502);

    const client = new McpClient('http://mcp.internal/api/ado', 'test-bearer');
    await expect(client.linkWorkItems(101, 100, 'Elisra.CoveredBy-Forward')).rejects.toThrow(
      'TF401232: target work item does not exist',
    );
  });

  it('falls back to a status-code message when a non-ok response has no parseable JSON body', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    });

    const client = new McpClient('http://mcp.internal/api/ado', 'test-bearer');
    await expect(client.discoverProjects()).rejects.toThrow(
      'ADO REST request to ado_discover_projects failed with status 500',
    );
  });

  it('omits the ADO credential headers when no credential is passed (mock-backend default)', async () => {
    mockJsonResponse({ id: 1 });

    const client = new McpClient('http://mcp.internal/api/ado', 'test-bearer');
    await client.createWorkItem('Requirement', {});

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(options.headers).toEqual({ Authorization: 'Bearer test-bearer', 'Content-Type': 'application/json' });
  });

  it('forwards X-Ado-Org-Url / X-Ado-Pat headers when a credential is passed', async () => {
    mockJsonResponse({ id: 1 });

    const client = new McpClient('http://mcp.internal/api/ado', 'test-bearer');
    await client.createWorkItem('Requirement', {}, { orgUrl: 'https://ado.example.com/tfs', pat: 'secret-pat' });

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(options.headers).toEqual({
      Authorization: 'Bearer test-bearer',
      'Content-Type': 'application/json',
      'X-Ado-Org-Url': 'https://ado.example.com/tfs',
      'X-Ado-Pat': 'secret-pat',
    });
  });

  it('rejects with McpRequestTimeoutError when the request never settles', async () => {
    (global.fetch as jest.Mock).mockImplementation(
      (_url: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    const client = new McpClient('http://mcp.internal/api/ado', 'test-bearer', 20);

    await expect(client.discoverLinkTypes()).rejects.toBeInstanceOf(McpRequestTimeoutError);
    await expect(client.discoverLinkTypes()).rejects.toThrow(/mcp\.internal\/api\/ado.*20ms/);
  });

  it('resolves normally when the call settles before the timeout', async () => {
    mockJsonResponse([]);

    const client = new McpClient('http://mcp.internal/api/ado', 'test-bearer', 20);

    await expect(client.discoverLinkTypes()).resolves.toEqual([]);
  });
});
