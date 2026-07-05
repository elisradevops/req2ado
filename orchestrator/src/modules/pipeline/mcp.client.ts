import { Injectable } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Real MCP protocol client for mcp-ado-server — the first place in this
 * project that uses the SDK's CLIENT-side APIs (every prior phase only
 * built the SERVER side, inside mcp-ado-server itself). Connects and
 * closes per call, matching mcp-ado-server's own stateless-per-request
 * server design (see mcp-ado-server/src/server.ts's comment on why a
 * StreamableHTTPServerTransport in stateless mode is single-use).
 */
@Injectable()
export class McpClient {
  constructor(
    private readonly mcpUrl: string,
    private readonly bearerToken: string,
  ) {}

  private async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: 'req2ado-orchestrator', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${this.bearerToken}` } },
    });
    await client.connect(transport);
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  }

  private parseToolTextResult<T>(result: { content: { type: string; text?: string }[] }): T {
    const textContent = result.content.find((item) => item.type === 'text');
    return JSON.parse(textContent?.text ?? 'null') as T;
  }

  async createWorkItem(type: string, fields: Record<string, string>): Promise<{ id: number }> {
    return this.withClient(async (client) => {
      const result = await client.callTool({ name: 'ado_create_work_item', arguments: { type, fields } });
      return this.parseToolTextResult(result as any);
    });
  }

  async linkParentChild(childId: number, parentId: number): Promise<void> {
    await this.withClient(async (client) => {
      await client.callTool({ name: 'ado_link_parent_child', arguments: { childId, parentId } });
    });
  }

  async discoverFields(workItemType: string): Promise<string[]> {
    return this.withClient(async (client) => {
      const result = await client.callTool({ name: 'ado_discover_fields', arguments: { workItemType } });
      return this.parseToolTextResult(result as any);
    });
  }
}
