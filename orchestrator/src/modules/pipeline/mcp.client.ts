import { Injectable } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Per-request ADO credential forwarded to mcp-ado-server as the
 * X-Ado-Org-Url / X-Ado-Pat headers. Optional on every McpClient method —
 * omitted entirely when the backend is mock (no credential needed).
 */
export interface AdoRequestCredential {
  orgUrl: string;
  pat: string;
}

export interface AdoLinkType {
  referenceName: string;
  name: string;
  semanticHint?: string;
}

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

  private async withClient<T>(
    credential: AdoRequestCredential | undefined,
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    const client = new Client({ name: 'req2ado-orchestrator', version: '0.1.0' });
    const headers: Record<string, string> = { Authorization: `Bearer ${this.bearerToken}` };
    if (credential) {
      headers['X-Ado-Org-Url'] = credential.orgUrl;
      headers['X-Ado-Pat'] = credential.pat;
    }
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl), { requestInit: { headers } });
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

  async createWorkItem(
    type: string,
    fields: Record<string, string>,
    credential?: AdoRequestCredential,
  ): Promise<{ id: number }> {
    return this.withClient(credential, async (client) => {
      const result = await client.callTool({ name: 'ado_create_work_item', arguments: { type, fields } });
      return this.parseToolTextResult(result as any);
    });
  }

  async linkParentChild(childId: number, parentId: number, credential?: AdoRequestCredential): Promise<void> {
    await this.withClient(credential, async (client) => {
      await client.callTool({ name: 'ado_link_parent_child', arguments: { childId, parentId } });
    });
  }

  async linkWorkItems(
    fromId: number,
    toId: number,
    referenceName: string,
    credential?: AdoRequestCredential,
  ): Promise<void> {
    await this.withClient(credential, async (client) => {
      await client.callTool({ name: 'ado_link_work_items', arguments: { fromId, toId, referenceName } });
    });
  }

  async discoverLinkTypes(credential?: AdoRequestCredential): Promise<AdoLinkType[]> {
    return this.withClient(credential, async (client) => {
      const result = await client.callTool({ name: 'ado_discover_link_types', arguments: {} });
      return this.parseToolTextResult(result as any);
    });
  }

  async discoverFields(workItemType: string, credential?: AdoRequestCredential): Promise<string[]> {
    return this.withClient(credential, async (client) => {
      const result = await client.callTool({ name: 'ado_discover_fields', arguments: { workItemType } });
      return this.parseToolTextResult(result as any);
    });
  }

  async readAreaPaths(depth: number, credential?: AdoRequestCredential): Promise<unknown> {
    return this.withClient(credential, async (client) => {
      const result = await client.callTool({ name: 'ado_read_area_paths', arguments: { depth } });
      return this.parseToolTextResult(result as any);
    });
  }
}
