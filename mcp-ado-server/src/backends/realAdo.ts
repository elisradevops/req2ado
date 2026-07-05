import type { AxiosInstance } from 'axios';
import axios from 'axios';
import { buildBasicAuthHeader, type AdoCredential } from '../auth/patAuth.js';
import type { AdoBackend, CreateWorkItemInput, WorkItemRecord, WorkItemType } from './types.js';
import type { AdoMcpConfig } from '../config/env.js';
import { retryWithBackoff } from './retryWithBackoff.js';

/**
 * Probes the api-version fallback ladder (docs/architecture.md: "7.1 -> 5.1
 * -> none") by calling connectionData with each candidate in order, using
 * the first one that responds 200. "none" omits the api-version query
 * param entirely — some legacy on-prem endpoints predate versioning.
 * Exported standalone (not a RealAdoBackend method) so it can be reused
 * and tested independently of a full backend instance.
 */
export async function resolveApiVersion(
  orgUrl: string,
  apiVersionLadder: string[],
  credential: AdoCredential,
  httpClient: AxiosInstance,
): Promise<string> {
  const authHeader = buildBasicAuthHeader(credential.pat);
  for (const version of apiVersionLadder) {
    const url =
      version === 'none'
        ? `${orgUrl.replace(/\/$/, '')}/_apis/connectionData`
        : `${orgUrl.replace(/\/$/, '')}/_apis/connectionData?api-version=${version}`;
    try {
      const response = await httpClient.get(url, { headers: { Authorization: authHeader } });
      if (response.status === 200) {
        return version;
      }
    } catch {
      continue;
    }
  }
  throw new Error(`No api-version in the ladder [${apiVersionLadder.join(', ')}] succeeded against ${orgUrl}`);
}

function versionQueryParam(version: string): string {
  return version === 'none' ? '' : `?api-version=${version}`;
}

function toJsonPatch(fields: Record<string, string>): { op: string; path: string; value: string }[] {
  return Object.entries(fields).map(([key, value]) => ({ op: 'add', path: `/fields/${key}`, value }));
}

function parentIdFromRelations(relations: { rel: string; url: string }[] | undefined): number | null {
  const parentRelation = relations?.find((relation) => relation.rel === 'System.LinkTypes.Hierarchy-Reverse');
  if (!parentRelation) return null;
  const match = parentRelation.url.match(/\/workItems\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function escapeWiqlValue(value: string): string {
  return value.replace(/'/g, "''");
}

function buildWiqlQuery(fieldMatch: Record<string, string>): string {
  const conditions = Object.entries(fieldMatch)
    .map(([field, value]) => `[${field}] = '${escapeWiqlValue(value)}'`)
    .join(' AND ');
  return `SELECT [System.Id] FROM WorkItems WHERE ${conditions}`;
}

/**
 * On-prem ADO REST implementation of AdoBackend (Phase 0's interface,
 * unchanged). createWorkItem/getWorkItem are implemented here via the
 * JSON-Patch work-item API; linkParentChild/queryIds remain stubs for
 * Tasks 3-4.
 */
export class RealAdoBackend implements AdoBackend {
  private httpClient: AxiosInstance = axios.create();
  private resolvedApiVersion: string | null = null;

  constructor(
    private readonly config: AdoMcpConfig,
    private readonly credential: AdoCredential,
  ) {}

  private authHeader(): string {
    return buildBasicAuthHeader(this.credential.pat);
  }

  private async getApiVersion(): Promise<string> {
    if (this.resolvedApiVersion === null) {
      this.resolvedApiVersion = await resolveApiVersion(
        this.credential.orgUrl,
        this.config.apiVersionLadder,
        this.credential,
        this.httpClient,
      );
    }
    return this.resolvedApiVersion;
  }

  async ping(): Promise<{ ok: true; backend: 'real' }> {
    await this.getApiVersion();
    return { ok: true, backend: 'real' };
  }

  async createWorkItem(input: CreateWorkItemInput): Promise<WorkItemRecord> {
    const version = await this.getApiVersion();
    const url = `${this.credential.orgUrl.replace(/\/$/, '')}/${this.config.adoProject}/_apis/wit/workitems/$${input.type}${versionQueryParam(version)}`;
    const response = await retryWithBackoff(() =>
      this.httpClient.post(url, toJsonPatch(input.fields), {
        headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json-patch+json' },
      }),
    );
    return {
      id: response.data.id,
      type: input.type,
      fields: input.fields,
      parentId: null,
    };
  }

  async getWorkItem(id: number): Promise<WorkItemRecord | null> {
    const version = await this.getApiVersion();
    const url = `${this.credential.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems/${id}?$expand=relations${version === 'none' ? '' : `&api-version=${version}`}`;
    try {
      const response = await retryWithBackoff(() =>
        this.httpClient.get(url, { headers: { Authorization: this.authHeader() } }),
      );
      const data = response.data;
      return {
        id: data.id,
        type: data.fields['System.WorkItemType'] as WorkItemType,
        fields: data.fields,
        parentId: parentIdFromRelations(data.relations),
      };
    } catch (error: any) {
      if (error?.response?.status === 404) return null;
      throw error;
    }
  }

  async linkParentChild(childId: number, parentId: number): Promise<void> {
    const version = await this.getApiVersion();
    const url = `${this.credential.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems/${childId}${versionQueryParam(version)}`;
    const parentUrl = `${this.credential.orgUrl.replace(/\/$/, '')}/_apis/wit/workItems/${parentId}`;
    await retryWithBackoff(() =>
      this.httpClient.patch(
        url,
        [
          {
            op: 'add',
            path: '/relations/-',
            value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: parentUrl },
          },
        ],
        { headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json-patch+json' } },
      ),
    );
  }

  async queryIds(fieldMatch: Record<string, string>): Promise<number[]> {
    const version = await this.getApiVersion();
    const url = `${this.credential.orgUrl.replace(/\/$/, '')}/${this.config.adoProject}/_apis/wit/wiql${versionQueryParam(version)}`;
    const response = await retryWithBackoff(() =>
      this.httpClient.post(
        url,
        { query: buildWiqlQuery(fieldMatch) },
        { headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json' } },
      ),
    );
    return response.data.workItems.map((item: { id: number }) => item.id);
  }

  async discoverFields(workItemType: WorkItemType): Promise<string[]> {
    const version = await this.getApiVersion();
    const url = `${this.credential.orgUrl.replace(/\/$/, '')}/${this.config.adoProject}/_apis/wit/workitemtypes/${workItemType}/fields${versionQueryParam(version)}`;
    const response = await retryWithBackoff(() =>
      this.httpClient.get(url, { headers: { Authorization: this.authHeader() } }),
    );
    return response.data.fields.map((field: { referenceName: string }) => field.referenceName);
  }
}
