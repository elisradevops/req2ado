import { Injectable } from '@nestjs/common';

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
 * Thrown when a single REST round trip to mcp-ado-server exceeds
 * requestTimeoutMs. Extends Error so every existing untyped catch (both
 * `.catch(() => [])` fallbacks and outer job try/catch blocks) keeps
 * working unchanged -- this only turns a HANG into a FAST REJECTION.
 */
export class McpRequestTimeoutError extends Error {
  constructor(
    public readonly url: string,
    public readonly timeoutMs: number,
  ) {
    super(`ADO REST request to ${url} timed out after ${timeoutMs}ms`);
    this.name = 'McpRequestTimeoutError';
  }
}

/**
 * REST client for mcp-ado-server's `/api/ado/*` operations (S9's MCP → REST
 * cutover — see mcp-ado-server's src/operations/registry.ts for the
 * operation catalog this calls into, and src/rest/router.ts for the server
 * side). Retains the `McpClient` name and every public method's signature
 * unchanged from the MCP-protocol version this replaces — this file's 12+
 * call sites across the orchestrator (job pipeline, writeback, work-item
 * type catalog) needed zero changes as a result; only this file's internals
 * moved from the MCP SDK's StreamableHTTP client transport to a plain
 * per-operation POST.
 */
@Injectable()
export class McpClient {
  constructor(
    // Base URL of mcp-ado-server's REST router, e.g. http://mcp-ado-server:4100/api/ado
    // (construction sites append /api/ado themselves, same as they
    // previously appended /mcp — see jobs.module.ts / pipeline.processor.ts).
    private readonly restBaseUrl: string,
    private readonly bearerToken: string,
    // Wall-clock cap on a single REST round trip. Same rationale/default as
    // the MCP-protocol version this replaces: mcp-ado-server crashing
    // mid-request must never hang a pipeline job indefinitely.
    private readonly requestTimeoutMs = 60000,
  ) {}

  private async call<T>(operation: string, args: Record<string, unknown>, credential?: AdoRequestCredential): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.bearerToken}`,
      'Content-Type': 'application/json',
    };
    if (credential) {
      headers['X-Ado-Org-Url'] = credential.orgUrl;
      headers['X-Ado-Pat'] = credential.pat;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.restBaseUrl}/${operation}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(args),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new McpRequestTimeoutError(this.restBaseUrl, this.requestTimeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
      throw new Error(body?.error ?? `ADO REST request to ${operation} failed with status ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async createWorkItem(
    type: string,
    fields: Record<string, string>,
    credential?: AdoRequestCredential,
  ): Promise<{ id: number }> {
    return this.call('ado_create_work_item', { type, fields }, credential);
  }

  async linkParentChild(childId: number, parentId: number, credential?: AdoRequestCredential): Promise<void> {
    await this.call('ado_link_parent_child', { childId, parentId }, credential);
  }

  async linkWorkItems(
    fromId: number,
    toId: number,
    referenceName: string,
    credential?: AdoRequestCredential,
  ): Promise<void> {
    await this.call('ado_link_work_items', { fromId, toId, referenceName }, credential);
  }

  async discoverLinkTypes(credential?: AdoRequestCredential): Promise<AdoLinkType[]> {
    return this.call('ado_discover_link_types', {}, credential);
  }

  async readAreaPaths(depth: number, project?: string, credential?: AdoRequestCredential): Promise<unknown> {
    return this.call('ado_read_area_paths', { depth, project }, credential);
  }

  async readIterationPaths(depth: number, project?: string, credential?: AdoRequestCredential): Promise<unknown> {
    return this.call('ado_read_iteration_paths', { depth, project }, credential);
  }

  async readStates(workItemType: string, project?: string, credential?: AdoRequestCredential): Promise<string[]> {
    return this.call('ado_read_states', { workItemType, project }, credential);
  }

  async discoverWorkItemTypes(project?: string, credential?: AdoRequestCredential): Promise<WorkItemTypeDefinition[]> {
    return this.call('ado_discover_work_item_types', { project }, credential);
  }

  async discoverWorkItemTypeCategories(project?: string, credential?: AdoRequestCredential): Promise<WorkItemTypeCategoryMap> {
    return this.call('ado_discover_work_item_type_categories', { project }, credential);
  }

  async getWorkItemIcon(iconId: string, color: string, credential?: AdoRequestCredential): Promise<WorkItemIcon> {
    return this.call('ado_get_work_item_icon', { iconId, color }, credential);
  }

  async discoverProjects(credential?: AdoRequestCredential): Promise<AdoProject[]> {
    return this.call('ado_discover_projects', {}, credential);
  }

  async discoverFields(workItemType: string, credential?: AdoRequestCredential): Promise<string[]> {
    return this.call('ado_discover_fields', { workItemType }, credential);
  }

  async getWorkItemsBatch(
    ids: number[],
    credential?: AdoRequestCredential,
  ): Promise<{ id: number; type: string; fields: Record<string, string>; parentId: number | null }[]> {
    return this.call('ado_get_work_items_batch', { ids }, credential);
  }

  async queryIds(fieldMatch: Record<string, string>, credential?: AdoRequestCredential): Promise<number[]> {
    return this.call('ado_query_ids', { fieldMatch }, credential);
  }

  async uploadAttachment(
    workItemId: number,
    fileName: string,
    dataBase64: string,
    mimeType: string,
    credential?: AdoRequestCredential,
  ): Promise<void> {
    await this.call('ado_upload_attachment', { workItemId, fileName, dataBase64, mimeType }, credential);
  }
}
