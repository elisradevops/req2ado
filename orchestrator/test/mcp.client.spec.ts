import { McpClient } from '../src/modules/pipeline/mcp.client';

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
});
