import type { AxiosInstance } from 'axios';
import axios from 'axios';
import { buildBasicAuthHeader, type AdoCredential } from '../auth/patAuth.js';
import type { AdoBackend, CreateWorkItemInput, WorkItemRecord } from './types.js';
import type { AdoMcpConfig } from '../config/env.js';

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

/**
 * On-prem ADO REST implementation of AdoBackend (Phase 0's interface,
 * unchanged). Work-item methods are implemented in Tasks 2-4; this task
 * only establishes the skeleton and api-version resolution.
 */
export class RealAdoBackend implements AdoBackend {
  private httpClient: AxiosInstance = axios.create();
  private resolvedApiVersion: string | null = null;

  constructor(
    private readonly config: AdoMcpConfig,
    private readonly credential: AdoCredential,
  ) {}

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

  async createWorkItem(_input: CreateWorkItemInput): Promise<WorkItemRecord> {
    throw new Error('RealAdoBackend.createWorkItem not implemented yet — see Task 2');
  }

  async getWorkItem(_id: number): Promise<WorkItemRecord | null> {
    throw new Error('RealAdoBackend.getWorkItem not implemented yet — see Task 2');
  }

  async linkParentChild(_childId: number, _parentId: number): Promise<void> {
    throw new Error('RealAdoBackend.linkParentChild not implemented yet — see Task 3');
  }

  async queryIds(_fieldMatch: Record<string, string>): Promise<number[]> {
    throw new Error('RealAdoBackend.queryIds not implemented yet — see Task 4');
  }
}
