import { McpClient, McpRequestTimeoutError } from '../src/modules/pipeline/mcp.client';

// These tests mock the @modelcontextprotocol/sdk Client class's connect/
// callTool/close methods directly, rather than standing up a real MCP
// server — verifying McpClient's OWN request-shaping logic (correct tool
// name, correct argument shape, correct connect/close lifecycle), not the
// SDK's own transport behavior (already covered by mcp-ado-server's own
// tests in Phase 0/7).
jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    callTool: jest.fn(),
  })),
}));

// Captures the requestInit headers passed to the transport, so we can assert
// that an optional credential is (or isn't) forwarded as the two ADO headers
// without needing a real HTTP transport.
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn().mockImplementation((_url, opts) => ({ __opts: opts })),
}));

describe('McpClient', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('createWorkItem calls the ado_create_work_item tool with the right arguments', async () => {
    const { Client } = jest.requireMock('@modelcontextprotocol/sdk/client/index.js');
    const mockCallTool = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"id":42}' }] });
    Client.mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      callTool: mockCallTool,
    }));

    const client = new McpClient('http://mcp.internal/mcp', 'test-bearer');
    const result = await client.createWorkItem('Requirement', { 'System.Title': 'Test' });

    expect(result).toEqual({ id: 42 });
    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'ado_create_work_item',
      arguments: { type: 'Requirement', fields: { 'System.Title': 'Test' } },
    });
  });

  it('connects and closes on every call (stateless per-call, matching the server design)', async () => {
    const { Client } = jest.requireMock('@modelcontextprotocol/sdk/client/index.js');
    const mockConnect = jest.fn().mockResolvedValue(undefined);
    const mockClose = jest.fn().mockResolvedValue(undefined);
    Client.mockImplementation(() => ({
      connect: mockConnect,
      close: mockClose,
      callTool: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"id":1}' }] }),
    }));

    const client = new McpClient('http://mcp.internal/mcp', 'test-bearer');
    await client.createWorkItem('Epic', {});
    await client.createWorkItem('Epic', {});

    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockClose).toHaveBeenCalledTimes(2);
  });

  it('linkParentChild calls the ado_link_parent_child tool', async () => {
    const { Client } = jest.requireMock('@modelcontextprotocol/sdk/client/index.js');
    const mockCallTool = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
    Client.mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      callTool: mockCallTool,
    }));

    const client = new McpClient('http://mcp.internal/mcp', 'test-bearer');
    await client.linkParentChild(42, 7);

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'ado_link_parent_child',
      arguments: { childId: 42, parentId: 7 },
    });
  });

  it('discoverFields calls the ado_discover_fields tool and parses the field list', async () => {
    const { Client } = jest.requireMock('@modelcontextprotocol/sdk/client/index.js');
    const mockCallTool = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: '["System.Title","Custom.CustomerId"]' }],
    });
    Client.mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      callTool: mockCallTool,
    }));

    const client = new McpClient('http://mcp.internal/mcp', 'test-bearer');
    const result = await client.discoverFields('Requirement');

    expect(result).toEqual(['System.Title', 'Custom.CustomerId']);
    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'ado_discover_fields',
      arguments: { workItemType: 'Requirement' },
    });
  });

  it('queryIds calls the ado_query_ids tool with the given field match', async () => {
    const { Client } = jest.requireMock('@modelcontextprotocol/sdk/client/index.js');
    const mockCallTool = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: '[100,101]' }] });
    Client.mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      callTool: mockCallTool,
    }));

    const client = new McpClient('http://mcp.internal/mcp', 'test-bearer');
    const result = await client.queryIds({ 'System.AreaPath': 'Project\\Area1' });

    expect(result).toEqual([100, 101]);
    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'ado_query_ids',
      arguments: { fieldMatch: { 'System.AreaPath': 'Project\\Area1' } },
    });
  });

  it('calls the ado_read_area_paths tool and parses the result', async () => {
    const { Client } = jest.requireMock('@modelcontextprotocol/sdk/client/index.js');
    const mockCallTool = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"path":"Project","children":[]}' }],
    });
    Client.mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      callTool: mockCallTool,
    }));

    const client = new McpClient('http://mcp.internal/mcp', 'test-bearer');
    const result = await client.readAreaPaths(3);

    expect(result).toEqual({ path: 'Project', children: [] });
    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'ado_read_area_paths',
      arguments: { depth: 3 },
    });
  });

  it('forwards project as a tool arg when provided (per-project area-path override)', async () => {
    const { Client } = jest.requireMock('@modelcontextprotocol/sdk/client/index.js');
    const mockCallTool = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"path":"OtherProject","children":[]}' }],
    });
    Client.mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      callTool: mockCallTool,
    }));

    const client = new McpClient('http://mcp.internal/mcp', 'test-bearer');
    await client.readAreaPaths(3, 'OtherProject');

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'ado_read_area_paths',
      arguments: { depth: 3, project: 'OtherProject' },
    });
  });

  it('discoverProjects calls the ado_discover_projects tool and parses the result', async () => {
    const { Client } = jest.requireMock('@modelcontextprotocol/sdk/client/index.js');
    const mockCallTool = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: '[{"id":"1","name":"Project"}]' }],
    });
    Client.mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      callTool: mockCallTool,
    }));

    const client = new McpClient('http://mcp.internal/mcp', 'test-bearer');
    const result = await client.discoverProjects();

    expect(result).toEqual([{ id: '1', name: 'Project' }]);
    expect(mockCallTool).toHaveBeenCalledWith({ name: 'ado_discover_projects', arguments: {} });
  });

  it('linkWorkItems calls the ado_link_work_items tool with fromId/toId/referenceName', async () => {
    const { Client } = jest.requireMock('@modelcontextprotocol/sdk/client/index.js');
    const mockCallTool = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
    Client.mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      callTool: mockCallTool,
    }));

    const client = new McpClient('http://mcp.internal/mcp', 'test-bearer');
    await client.linkWorkItems(101, 100, 'Elisra.CoveredBy-Forward');

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'ado_link_work_items',
      arguments: { fromId: 101, toId: 100, referenceName: 'Elisra.CoveredBy-Forward' },
    });
  });

  it('discoverLinkTypes calls the ado_discover_link_types tool and parses the JSON array result', async () => {
    const { Client } = jest.requireMock('@modelcontextprotocol/sdk/client/index.js');
    const linkTypes = [{ referenceName: 'System.LinkTypes.Related', name: 'Related' }];
    const mockCallTool = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(linkTypes) }],
    });
    Client.mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      callTool: mockCallTool,
    }));

    const client = new McpClient('http://mcp.internal/mcp', 'test-bearer');
    const result = await client.discoverLinkTypes();

    expect(result).toEqual(linkTypes);
    expect(mockCallTool).toHaveBeenCalledWith({ name: 'ado_discover_link_types', arguments: {} });
  });

  it('createWorkItem throws the real error message when the tool result has isError: true', async () => {
    // Regression: parseToolTextResult previously ignored `isError` and always
    // ran JSON.parse on the text content -- an error result's plain-text
    // message (not JSON) then threw an opaque SyntaxError, masking the real
    // backend failure (found live: "No api-version in the ladder [...]
    // succeeded" surfaced only as "Unexpected token 'N' ... is not valid JSON").
    const { Client } = jest.requireMock('@modelcontextprotocol/sdk/client/index.js');
    const mockCallTool = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'No api-version in the ladder [7.1, 7.0, 5.1, none] succeeded against x' }],
      isError: true,
    });
    Client.mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      callTool: mockCallTool,
    }));

    const client = new McpClient('http://mcp.internal/mcp', 'test-bearer');
    await expect(client.createWorkItem('Requirement', {})).rejects.toThrow(
      'No api-version in the ladder [7.1, 7.0, 5.1, none] succeeded against x',
    );
  });

  it('omits the ADO credential headers when no credential is passed (mock-backend default)', async () => {
    const { StreamableHTTPClientTransport } = jest.requireMock(
      '@modelcontextprotocol/sdk/client/streamableHttp.js',
    );
    const { Client } = jest.requireMock('@modelcontextprotocol/sdk/client/index.js');
    Client.mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      callTool: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"id":1}' }] }),
    }));

    const client = new McpClient('http://mcp.internal/mcp', 'test-bearer');
    await client.createWorkItem('Requirement', {});

    const headers = StreamableHTTPClientTransport.mock.calls[0][1].requestInit.headers;
    expect(headers).toEqual({ Authorization: 'Bearer test-bearer' });
  });

  it('forwards X-Ado-Org-Url / X-Ado-Pat headers when a credential is passed', async () => {
    const { StreamableHTTPClientTransport } = jest.requireMock(
      '@modelcontextprotocol/sdk/client/streamableHttp.js',
    );
    const { Client } = jest.requireMock('@modelcontextprotocol/sdk/client/index.js');
    Client.mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      callTool: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"id":1}' }] }),
    }));

    const client = new McpClient('http://mcp.internal/mcp', 'test-bearer');
    await client.createWorkItem('Requirement', {}, { orgUrl: 'https://ado.example.com/tfs', pat: 'secret-pat' });

    const headers = StreamableHTTPClientTransport.mock.calls[0][1].requestInit.headers;
    expect(headers).toEqual({
      Authorization: 'Bearer test-bearer',
      'X-Ado-Org-Url': 'https://ado.example.com/tfs',
      'X-Ado-Pat': 'secret-pat',
    });
  });

  it('rejects with McpRequestTimeoutError when the tool call never settles', async () => {
    const { Client } = jest.requireMock('@modelcontextprotocol/sdk/client/index.js');
    const mockClose = jest.fn().mockResolvedValue(undefined);
    Client.mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      close: mockClose,
      callTool: jest.fn().mockReturnValue(new Promise(() => {})),
    }));

    const client = new McpClient('http://mcp.internal/mcp', 'test-bearer', 20);

    await expect(client.discoverLinkTypes()).rejects.toBeInstanceOf(McpRequestTimeoutError);
    await expect(client.discoverLinkTypes()).rejects.toThrow(/mcp\.internal\/mcp.*20ms/);
    expect(mockClose).toHaveBeenCalled();
  });

  it('rejects with McpRequestTimeoutError when connect never settles', async () => {
    const { Client } = jest.requireMock('@modelcontextprotocol/sdk/client/index.js');
    const mockClose = jest.fn().mockResolvedValue(undefined);
    Client.mockImplementation(() => ({
      connect: jest.fn().mockReturnValue(new Promise(() => {})),
      close: mockClose,
      callTool: jest.fn(),
    }));

    const client = new McpClient('http://mcp.internal/mcp', 'test-bearer', 20);

    await expect(client.discoverLinkTypes()).rejects.toBeInstanceOf(McpRequestTimeoutError);
    expect(mockClose).toHaveBeenCalled();
  });

  it('resolves normally when the call settles before the timeout', async () => {
    const { Client } = jest.requireMock('@modelcontextprotocol/sdk/client/index.js');
    const mockClose = jest.fn().mockResolvedValue(undefined);
    Client.mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      close: mockClose,
      callTool: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: '[]' }] }),
    }));

    const client = new McpClient('http://mcp.internal/mcp', 'test-bearer', 20);

    await expect(client.discoverLinkTypes()).resolves.toEqual([]);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});
