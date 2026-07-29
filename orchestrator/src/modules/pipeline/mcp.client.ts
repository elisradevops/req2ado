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

export interface AdoProject {
  id: string;
  name: string;
}

export interface WorkItemTypeDefinition {
  name: string;
  color: string;
  icon: { id: string; url: string };
}

// req2ado's 3 internal category labels resolved to the REAL work-item type
// name the target project's actual process template uses for each -- see
// mcp-ado-server's WorkItemTypeCategoryMap doc comment for why this exists
// (Agile's Requirement-category type is "User Story", not "Requirement").
export interface WorkItemTypeCategoryMap {
  Epic: string;
  Feature: string;
  Requirement: string;
}

export interface WorkItemIcon {
  contentType: string;
  dataBase64: string;
}

/**
 * Thrown when a single MCP round trip (connect + tool call + close) exceeds
 * requestTimeoutMs. Extends Error so every existing untyped catch (both
 * `.catch(() => [])` fallbacks and outer job try/catch blocks) keeps
 * working unchanged -- this only turns a HANG into a FAST REJECTION.
 */
export class McpRequestTimeoutError extends Error {
  constructor(
    public readonly url: string,
    public readonly timeoutMs: number,
  ) {
    super(`MCP request to ${url} timed out after ${timeoutMs}ms`);
    this.name = 'McpRequestTimeoutError';
  }
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
    // Wall-clock cap on a single MCP round trip. Observed live: mcp-ado-server
    // crashed mid-request and a McpClient call hung indefinitely -- the
    // promise never settled, so the caller's surrounding try/catch never
    // fired, leaving a pipeline job stuck 'running' for 13+ minutes with no
    // recovery short of restarting the process. Default matches the MCP
    // SDK's own DEFAULT_REQUEST_TIMEOUT_MSEC.
    private readonly requestTimeoutMs = 60000,
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
    let timer: NodeJS.Timeout | undefined;
    // The transport sets its own `signal` (from an internal AbortController)
    // on every fetch AFTER spreading requestInit, so a signal passed via
    // requestInit above would be silently overridden -- close() (which
    // aborts that internal controller) is the only real cancellation path
    // for a hung connect()/fetch()/SSE stream.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void client.close().catch(() => {});
        reject(new McpRequestTimeoutError(this.mcpUrl, this.requestTimeoutMs));
      }, this.requestTimeoutMs);
    });
    const run = (async () => {
      await client.connect(transport);
      try {
        return await fn(client);
      } finally {
        await client.close().catch(() => {});
      }
    })();
    try {
      return await Promise.race([run, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private parseToolTextResult<T>(result: { content: { type: string; text?: string }[]; isError?: boolean }): T {
    const textContent = result.content.find((item) => item.type === 'text');
    if (result.isError) {
      throw new Error(textContent?.text ?? 'MCP tool call failed');
    }
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

  async readAreaPaths(depth: number, project?: string, credential?: AdoRequestCredential): Promise<unknown> {
    return this.withClient(credential, async (client) => {
      const result = await client.callTool({
        name: 'ado_read_area_paths',
        arguments: { depth, ...(project ? { project } : {}) },
      });
      return this.parseToolTextResult(result as any);
    });
  }

  async readIterationPaths(depth: number, project?: string, credential?: AdoRequestCredential): Promise<unknown> {
    return this.withClient(credential, async (client) => {
      const result = await client.callTool({
        name: 'ado_read_iteration_paths',
        arguments: { depth, ...(project ? { project } : {}) },
      });
      return this.parseToolTextResult(result as any);
    });
  }

  async readStates(workItemType: string, project?: string, credential?: AdoRequestCredential): Promise<string[]> {
    return this.withClient(credential, async (client) => {
      const result = await client.callTool({
        name: 'ado_read_states',
        arguments: { workItemType, ...(project ? { project } : {}) },
      });
      return this.parseToolTextResult(result as any);
    });
  }

  async discoverWorkItemTypes(project?: string, credential?: AdoRequestCredential): Promise<WorkItemTypeDefinition[]> {
    return this.withClient(credential, async (client) => {
      const result = await client.callTool({
        name: 'ado_discover_work_item_types',
        arguments: { ...(project ? { project } : {}) },
      });
      return this.parseToolTextResult(result as any);
    });
  }

  async discoverWorkItemTypeCategories(project?: string, credential?: AdoRequestCredential): Promise<WorkItemTypeCategoryMap> {
    return this.withClient(credential, async (client) => {
      const result = await client.callTool({
        name: 'ado_discover_work_item_type_categories',
        arguments: { ...(project ? { project } : {}) },
      });
      return this.parseToolTextResult(result as any);
    });
  }

  async getWorkItemIcon(iconId: string, color: string, credential?: AdoRequestCredential): Promise<WorkItemIcon> {
    return this.withClient(credential, async (client) => {
      const result = await client.callTool({ name: 'ado_get_work_item_icon', arguments: { iconId, color } });
      return this.parseToolTextResult(result as any);
    });
  }

  async discoverProjects(credential?: AdoRequestCredential): Promise<AdoProject[]> {
    return this.withClient(credential, async (client) => {
      const result = await client.callTool({ name: 'ado_discover_projects', arguments: {} });
      return this.parseToolTextResult(result as any);
    });
  }

  async discoverFields(workItemType: string, credential?: AdoRequestCredential): Promise<string[]> {
    return this.withClient(credential, async (client) => {
      const result = await client.callTool({ name: 'ado_discover_fields', arguments: { workItemType } });
      return this.parseToolTextResult(result as any);
    });
  }

  async getWorkItemsBatch(
    ids: number[],
    credential?: AdoRequestCredential,
  ): Promise<{ id: number; type: string; fields: Record<string, string>; parentId: number | null }[]> {
    return this.withClient(credential, async (client) => {
      const result = await client.callTool({ name: 'ado_get_work_items_batch', arguments: { ids } });
      return this.parseToolTextResult(result as any);
    });
  }

  async queryIds(fieldMatch: Record<string, string>, credential?: AdoRequestCredential): Promise<number[]> {
    return this.withClient(credential, async (client) => {
      const result = await client.callTool({ name: 'ado_query_ids', arguments: { fieldMatch } });
      return this.parseToolTextResult(result as any);
    });
  }
}
