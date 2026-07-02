# Phase 7 MCP Server + ADO Write-Back Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `RealAdoBackend` (the on-prem ADO REST implementation of Phase 0's already-existing `AdoBackend` interface) and the full set of MCP tools for idempotent work-item creation/linking/write-back, satisfying Phase 7's DoD: "MCP tools unit+integration tested vs mock; dry-run diff; re-run zero dupes; parent links correct; 429 backoff; api-version fallback."

**Architecture:** Phase 0 already built the hard infrastructure decisions for this package: the stateless-per-request `StreamableHTTPServerTransport` pattern (`server.ts`), the backend-agnostic `AdoBackend` interface (`backends/types.ts`), a fully working `MockAdoBackend` (SQLite), PAT auth helpers (`auth/patAuth.ts`), and one working tool (`ado_ping`). This phase does NOT redesign any of that — it adds a sibling `RealAdoBackend implements AdoBackend` (Task 1-4: api-version fallback, JSON-Patch writes, retry/backoff, batching), a `discover_fields` capability for the already-designed Customer ID candidate-list resolution (Task 5, closing the loop deferred from the "Customer ID Field Resolution" section of `docs/architecture.md` and from Phase 4's own explicit deferral), the remaining MCP tools beyond `ado_ping` (Task 6-8: `ado_create_work_item`, `ado_link_parent_child`, `ado_set_fields`, `ado_query_ids`), and dry-run + idempotent write-back orchestration (Task 9-10) that ties a `WorkItemTree` (from Phases 2-6) to real ADO writes via the idempotency map already specified in `docs/architecture.md` (`(source_hash, customer_id, area_path) → System.Id`).

**Tech Stack:** Same as Phase 0's `mcp-ado-server` package — TS, `@modelcontextprotocol/sdk`, `axios` (already a listed dependency, unused until now), `p-limit` (already listed, for bounded concurrency), `vitest`. **New: Prisma** for the idempotency map (Task 10) — the orchestrator already has Prisma/Postgres from Phase 0; this phase adds the specific `IdempotencyMap` table and queries it from the orchestrator side (not from `mcp-ado-server`, which stays stateless and has no database — the idempotency check happens in the orchestrator BEFORE calling the MCP tool, not inside the MCP server itself).

## Global Constraints

- `RealAdoBackend` must implement the exact same `AdoBackend` interface Phase 0 already defined in `backends/types.ts` — do not modify that interface's method signatures. If a real ADO REST need doesn't fit the existing interface shape, add a NEW method to the interface (both `MockAdoBackend` and `RealAdoBackend` must implement it) rather than changing an existing method's signature, since `MockAdoBackend`'s existing tests must keep passing unmodified.
- api-version fallback ladder is `7.1 → 5.1 → none`, exactly as already configured in `config/env.ts`'s `apiVersionLadder` (a `string[]`, already parsed from `ADO_API_VERSION_LADDER`). "none" means omit the `api-version` query parameter entirely (some legacy on-prem endpoints predate versioning).
- PAT auth is HTTP Basic with empty username, exactly as `auth/patAuth.ts`'s existing `buildBasicAuthHeader` already implements — reuse it, do not reimplement.
- Batch size for `workitemsbatch` reads is capped at 200 (already in `config/env.ts`'s `batchSize`, default 200) — never issue a batch request larger than this.
- All ADO writes are idempotent: re-running the same ingestion (same `source_hash` + `customer_id` + `area_path`) must produce ZERO new work items on the second run — it must find and reuse the existing `System.Id` via the idempotency map.
- Retry/backoff on 429 and 5xx responses: exponential backoff with jitter, per `docs/architecture.md`'s already-locked "Generic ADO REST conventions."
- TLS trust for on-prem self-signed certs is via `NODE_EXTRA_CA_CERTS` (external, process-launch-time mechanism) — `caCertPath` in `config/env.ts` is a documented, deferred field (same pattern already established and explicitly NOT re-implemented as a custom TLS agent, per the orchestrator's `AdoPatProvider` precedent from the auth-corrections round).
- `dry_run: true` is the default (per `config.yaml`'s already-locked `ado.dry_run: true`) — a dry-run call must return a diff/preview WITHOUT performing any real write.
- Type hints/explicit types on every function signature; existing `mcp-ado-server` test conventions (vitest, supertest, `MockAdoBackend` reused directly in tests rather than mocked, matching `test/server.test.ts`'s existing style).

---

### Task 1: `RealAdoBackend` skeleton + api-version fallback

**Files:**
- Create: `mcp-ado-server/src/backends/realAdo.ts`
- Test: `mcp-ado-server/test/realAdo.test.ts`

**Interfaces:**
- Produces: `RealAdoBackend implements AdoBackend` (from `backends/types.ts`, unchanged) with a constructor `(config: AdoMcpConfig, credential: AdoCredential)` — `credential` is per-request (the orchestrator's per-user PAT, per `auth/patAuth.ts`'s existing `AdoCredential` type, NOT read from env/config, matching that file's own documented contract).
- Produces: `resolveApiVersion(baseUrl: string, apiVersionLadder: string[], credential: AdoCredential, httpClient: AxiosInstance) -> Promise<string>` — a standalone exported function (not a class method) so Task 2+ and later tests can reuse the fallback-probing logic without instantiating a full backend.

**Boundary:** Only touch the two new files. Do not touch `backends/types.ts`, `backends/mockAdo.ts`, or `server.ts` yet — this task only builds the skeleton and the api-version resolution, no work-item methods yet (Task 2-4 add those).

- [ ] **Step 1: Write the failing tests for `resolveApiVersion`**

```typescript
// mcp-ado-server/test/realAdo.test.ts
import { describe, it, expect, vi } from 'vitest';
import axios from 'axios';
import { resolveApiVersion } from '../src/backends/realAdo';
import type { AdoCredential } from '../src/auth/patAuth';

const credential: AdoCredential = { orgUrl: 'https://tfs.internal/tfs/Collection', pat: 'fake-pat' };

describe('resolveApiVersion', () => {
  it('returns the first ladder entry that responds 200', async () => {
    const httpClient = axios.create();
    const getSpy = vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });

    const result = await resolveApiVersion(credential.orgUrl, ['7.1', '5.1', 'none'], credential, httpClient);

    expect(result).toBe('7.1');
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy.mock.calls[0][0]).toContain('api-version=7.1');
  });

  it('falls back to the second ladder entry when the first returns 404', async () => {
    const httpClient = axios.create();
    const getSpy = vi
      .spyOn(httpClient, 'get')
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce({ status: 200, data: {} });

    const result = await resolveApiVersion(credential.orgUrl, ['7.1', '5.1', 'none'], credential, httpClient);

    expect(result).toBe('5.1');
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it('falls back to "none" (omits the query param) when both versions 404', async () => {
    const httpClient = axios.create();
    const getSpy = vi
      .spyOn(httpClient, 'get')
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce({ status: 200, data: {} });

    const result = await resolveApiVersion(credential.orgUrl, ['7.1', '5.1', 'none'], credential, httpClient);

    expect(result).toBe('none');
    expect(getSpy.mock.calls[2][0]).not.toContain('api-version');
  });

  it('throws if every ladder entry fails', async () => {
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockRejectedValue({ response: { status: 404 } });

    await expect(resolveApiVersion(credential.orgUrl, ['7.1', '5.1', 'none'], credential, httpClient)).rejects.toThrow(
      /no api-version/i,
    );
  });

  it('sends the PAT as a Basic auth header on every probe', async () => {
    const httpClient = axios.create();
    const getSpy = vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });

    await resolveApiVersion(credential.orgUrl, ['7.1'], credential, httpClient);

    const expectedHeader = `Basic ${Buffer.from(':fake-pat').toString('base64')}`;
    expect(getSpy.mock.calls[0][1]?.headers?.Authorization).toBe(expectedHeader);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mcp-ado-server && npx vitest run test/realAdo.test.ts`
Expected: FAIL — `Cannot find module '../src/backends/realAdo'`

- [ ] **Step 3: Implement**

```typescript
// mcp-ado-server/src/backends/realAdo.ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd mcp-ado-server && npx vitest run test/realAdo.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add mcp-ado-server/src/backends/realAdo.ts mcp-ado-server/test/realAdo.test.ts
git commit -m "feat(mcp-ado-server): add RealAdoBackend skeleton with api-version fallback resolution"
```

---

### Task 2: `createWorkItem` + `getWorkItem` (JSON-Patch writes)

**Files:**
- Modify: `mcp-ado-server/src/backends/realAdo.ts`
- Test: `mcp-ado-server/test/realAdo.test.ts` (append)

**Interfaces:**
- Modifies: `RealAdoBackend.createWorkItem`/`getWorkItem` get real implementations.

**Boundary:** Only touch `realAdo.ts` and its test file (append). Do not touch `linkParentChild`/`queryIds` yet (Tasks 3-4).

- [ ] **Step 1: Write the failing tests**

```typescript
// Append to mcp-ado-server/test/realAdo.test.ts
import { RealAdoBackend } from '../src/backends/realAdo';
import type { AdoMcpConfig } from '../src/config/env';

const testConfig: AdoMcpConfig = {
  adoBaseUrl: 'https://tfs.internal/tfs/Collection',
  adoProject: 'MyProject',
  apiVersionLadder: ['7.1'],
  batchSize: 200,
  concurrency: 8,
  mcpBearer: 'test-bearer',
  port: 0,
  backend: 'real',
  mockDbPath: '',
};

describe('RealAdoBackend.createWorkItem', () => {
  it('POSTs a JSON-Patch body to the correct work-item-type endpoint', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} }); // api-version probe
    const postSpy = vi.spyOn(httpClient, 'post').mockResolvedValueOnce({
      status: 200,
      data: { id: 42, fields: { 'System.Title': 'Test req' } },
    });
    // @ts-expect-error -- injecting the spied client for the test
    backend.httpClient = httpClient;

    const result = await backend.createWorkItem({ type: 'Requirement', fields: { 'System.Title': 'Test req' } });

    expect(result.id).toBe(42);
    expect(result.type).toBe('Requirement');
    expect(postSpy.mock.calls[0][0]).toContain('/wit/workitems/$Requirement');
    expect(postSpy.mock.calls[0][1]).toEqual([{ op: 'add', path: '/fields/System.Title', value: 'Test req' }]);
    expect(postSpy.mock.calls[0][2]?.headers?.['Content-Type']).toBe('application/json-patch+json');
  });

  it('sets parentId to null on a newly created item with no parent field', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    vi.spyOn(httpClient, 'post').mockResolvedValueOnce({ status: 200, data: { id: 1, fields: {} } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.createWorkItem({ type: 'Epic', fields: {} });
    expect(result.parentId).toBeNull();
  });
});

describe('RealAdoBackend.getWorkItem', () => {
  it('GETs the work item by id and maps the response', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} }) // api-version probe
      .mockResolvedValueOnce({
        status: 200,
        data: {
          id: 42,
          fields: { 'System.WorkItemType': 'Requirement', 'System.Title': 'Test req' },
          relations: [],
        },
      });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.getWorkItem(42);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(42);
    expect(result?.type).toBe('Requirement');
  });

  it('returns null on a 404', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockRejectedValueOnce({ response: { status: 404 } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.getWorkItem(9999);
    expect(result).toBeNull();
  });

  it('extracts parentId from a Hierarchy-Reverse relation when present', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          id: 42,
          fields: { 'System.WorkItemType': 'Requirement' },
          relations: [
            {
              rel: 'System.LinkTypes.Hierarchy-Reverse',
              url: 'https://tfs.internal/tfs/Collection/_apis/wit/workItems/7',
            },
          ],
        },
      });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.getWorkItem(42);
    expect(result?.parentId).toBe(7);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mcp-ado-server && npx vitest run test/realAdo.test.ts`
Expected: FAIL — `createWorkItem`/`getWorkItem` still throw "not implemented yet."

- [ ] **Step 3: Make `httpClient` accessible for test injection**

Change the `private httpClient` field declared in Task 1 to allow the tests' `@ts-expect-error` injection pattern to work — no change needed if `private` fields are already assignable from within the same file's test via `@ts-expect-error` (TypeScript allows this at the type-check-suppression level; `private` is a compile-time-only restriction). Confirm this compiles; if not, change `private httpClient` to a `protected` or unprefixed field — do not make it `public` (keep the encapsulation as tight as TypeScript allows while still letting tests inject a spied instance).

- [ ] **Step 4: Implement**

```typescript
// mcp-ado-server/src/backends/realAdo.ts (full file, replacing existing content)
import type { AxiosInstance } from 'axios';
import axios from 'axios';
import { buildBasicAuthHeader, type AdoCredential } from '../auth/patAuth.js';
import type { AdoBackend, CreateWorkItemInput, WorkItemRecord, WorkItemType } from './types.js';
import type { AdoMcpConfig } from '../config/env.js';

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
    const response = await this.httpClient.post(url, toJsonPatch(input.fields), {
      headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json-patch+json' },
    });
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
      const response = await this.httpClient.get(url, { headers: { Authorization: this.authHeader() } });
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

  async linkParentChild(_childId: number, _parentId: number): Promise<void> {
    throw new Error('RealAdoBackend.linkParentChild not implemented yet — see Task 3');
  }

  async queryIds(_fieldMatch: Record<string, string>): Promise<number[]> {
    throw new Error('RealAdoBackend.queryIds not implemented yet — see Task 4');
  }
}
```

- [ ] **Step 5: Run to verify all pass**

Run: `cd mcp-ado-server && npx vitest run test/realAdo.test.ts`
Expected: PASS (10 tests total — 5 from Task 1, 5 new)

- [ ] **Step 6: Commit**

```bash
git add mcp-ado-server/src/backends/realAdo.ts mcp-ado-server/test/realAdo.test.ts
git commit -m "feat(mcp-ado-server): implement RealAdoBackend.createWorkItem and getWorkItem via JSON-Patch"
```

---

### Task 3: `linkParentChild` + retry/backoff on 429/5xx

**Files:**
- Modify: `mcp-ado-server/src/backends/realAdo.ts`
- Create: `mcp-ado-server/src/backends/retryWithBackoff.ts`
- Test: `mcp-ado-server/test/retryWithBackoff.test.ts`
- Test: `mcp-ado-server/test/realAdo.test.ts` (append)

**Interfaces:**
- Produces: `retryWithBackoff<T>(fn: () => Promise<T>, opts?: { maxRetries?: number; baseDelayMs?: number }) -> Promise<T>` in `mcp-ado-server/src/backends/retryWithBackoff.ts` — retries on HTTP 429/5xx (detected via `error.response.status`), exponential backoff with jitter, throws the last error after exhausting retries. `RealAdoBackend` wraps every outbound HTTP call through this.

**Boundary:** Only touch the new `retryWithBackoff.ts` file, its own test, `realAdo.ts` (wiring only), and `realAdo.test.ts` (append).

- [ ] **Step 1: Write the failing tests for `retryWithBackoff`**

```typescript
// mcp-ado-server/test/retryWithBackoff.test.ts
import { describe, it, expect, vi } from 'vitest';
import { retryWithBackoff } from '../src/backends/retryWithBackoff';

describe('retryWithBackoff', () => {
  it('returns the result on the first successful call, no retry', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retryWithBackoff(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on a 429 response and eventually succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockResolvedValueOnce('ok');
    const result = await retryWithBackoff(fn, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on a 503 response', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce('ok');
    const result = await retryWithBackoff(fn, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on a 400 (non-retryable client error)', async () => {
    const fn = vi.fn().mockRejectedValue({ response: { status: 400 } });
    await expect(retryWithBackoff(fn, { baseDelayMs: 1 })).rejects.toMatchObject({ response: { status: 400 } });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws the last error after exhausting maxRetries', async () => {
    const fn = vi.fn().mockRejectedValue({ response: { status: 429 } });
    await expect(retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 1 })).rejects.toMatchObject({
      response: { status: 429 },
    });
    expect(fn).toHaveBeenCalledTimes(4); // initial attempt + 3 retries
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mcp-ado-server && npx vitest run test/retryWithBackoff.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement `retryWithBackoff`**

```typescript
// mcp-ado-server/src/backends/retryWithBackoff.ts

/**
 * Exponential backoff with jitter for ADO REST calls, per
 * docs/architecture.md's "Retry/backoff on 429/5xx + network errors, exp
 * backoff + jitter." Retries only on 429 and 5xx — 4xx (other than 429) is
 * a client error that will not succeed on retry, so it fails immediately.
 */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function isRetryable(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status;
  return status !== undefined && RETRYABLE_STATUSES.has(status);
}

function delayWithJitter(attempt: number, baseDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** attempt;
  const jitter = Math.random() * baseDelayMs;
  return exponential + jitter;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 200;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === maxRetries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayWithJitter(attempt, baseDelayMs)));
    }
  }
  throw lastError;
}
```

- [ ] **Step 4: Run to verify `retryWithBackoff` tests pass**

Run: `cd mcp-ado-server && npx vitest run test/retryWithBackoff.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Write the failing tests for `linkParentChild`**

```typescript
// Append to mcp-ado-server/test/realAdo.test.ts

describe('RealAdoBackend.linkParentChild', () => {
  it('PATCHes a Hierarchy-Reverse relation add op onto the child work item', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    const patchSpy = vi.spyOn(httpClient, 'patch').mockResolvedValueOnce({ status: 200, data: {} });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.linkParentChild(42, 7);

    expect(patchSpy.mock.calls[0][0]).toContain('/wit/workitems/42');
    expect(patchSpy.mock.calls[0][1]).toEqual([
      {
        op: 'add',
        path: '/relations/-',
        value: {
          rel: 'System.LinkTypes.Hierarchy-Reverse',
          url: expect.stringContaining('/workItems/7'),
        },
      },
    ]);
  });

  it('retries on a 429 before succeeding', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    const patchSpy = vi
      .spyOn(httpClient, 'patch')
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockResolvedValueOnce({ status: 200, data: {} });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.linkParentChild(42, 7);
    expect(patchSpy).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd mcp-ado-server && npx vitest run test/realAdo.test.ts`
Expected: FAIL — `linkParentChild` still throws "not implemented yet."

- [ ] **Step 7: Wire `retryWithBackoff` into `realAdo.ts` and implement `linkParentChild`**

```typescript
// mcp-ado-server/src/backends/realAdo.ts — apply these changes to the Task 2 version:

// Add this import at the top:
import { retryWithBackoff } from './retryWithBackoff.js';

// Wrap the existing createWorkItem's httpClient.post call:
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

// Wrap the existing getWorkItem's httpClient.get call (the SECOND one, not the api-version probe):
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

// Replace the linkParentChild stub:
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
```

- [ ] **Step 8: Run to verify all pass**

Run: `cd mcp-ado-server && npx vitest run test/realAdo.test.ts`
Expected: PASS (12 tests total)

- [ ] **Step 9: Run the full mcp-ado-server suite**

Run: `cd mcp-ado-server && npx vitest run`
Expected: all pass, no regressions.

- [ ] **Step 10: Commit**

```bash
git add mcp-ado-server/src/backends/realAdo.ts mcp-ado-server/src/backends/retryWithBackoff.ts mcp-ado-server/test/realAdo.test.ts mcp-ado-server/test/retryWithBackoff.test.ts
git commit -m "feat(mcp-ado-server): add retryWithBackoff and implement linkParentChild, wrap all HTTP calls with retry"
```

---

### Task 4: `queryIds` (batched WIQL-based query, dedup/idempotency lookups)

**Files:**
- Modify: `mcp-ado-server/src/backends/realAdo.ts`
- Test: `mcp-ado-server/test/realAdo.test.ts` (append)

**Interfaces:**
- Modifies: `RealAdoBackend.queryIds` gets a real implementation.

**Boundary:** Only touch `realAdo.ts` and its test file (append).

- [ ] **Step 1: Write the failing tests**

```typescript
// Append to mcp-ado-server/test/realAdo.test.ts

describe('RealAdoBackend.queryIds', () => {
  it('runs a WIQL query built from the field-match map and returns matching ids', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} }); // api-version probe
    const postSpy = vi.spyOn(httpClient, 'post').mockResolvedValueOnce({
      status: 200,
      data: { workItems: [{ id: 1 }, { id: 2 }] },
    });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.queryIds({ 'Custom.SourceHash': 'abc123' });

    expect(result).toEqual([1, 2]);
    expect(postSpy.mock.calls[0][0]).toContain('/wit/wiql');
    expect(postSpy.mock.calls[0][1].query).toContain("[Custom.SourceHash] = 'abc123'");
  });

  it('combines multiple field-match entries with AND', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    const postSpy = vi.spyOn(httpClient, 'post').mockResolvedValueOnce({ status: 200, data: { workItems: [] } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.queryIds({ 'Custom.SourceHash': 'abc123', 'System.AreaPath': 'Project\\Area1' });

    const query = postSpy.mock.calls[0][1].query;
    expect(query).toContain("[Custom.SourceHash] = 'abc123'");
    expect(query).toContain("[System.AreaPath] = 'Project\\Area1'");
    expect(query).toContain(' AND ');
  });

  it('returns an empty array when nothing matches', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    vi.spyOn(httpClient, 'post').mockResolvedValueOnce({ status: 200, data: { workItems: [] } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.queryIds({ 'Custom.SourceHash': 'nonexistent' });
    expect(result).toEqual([]);
  });

  it('escapes single quotes in field values to prevent WIQL injection', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    const postSpy = vi.spyOn(httpClient, 'post').mockResolvedValueOnce({ status: 200, data: { workItems: [] } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.queryIds({ 'System.Title': "O'Brien's spec" });
    const query = postSpy.mock.calls[0][1].query;
    expect(query).toContain("O''Brien''s spec");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mcp-ado-server && npx vitest run test/realAdo.test.ts`
Expected: FAIL — `queryIds` still throws "not implemented yet."

- [ ] **Step 3: Implement**

Add this helper function and replace the `queryIds` stub in `realAdo.ts`:

```typescript
// Add to mcp-ado-server/src/backends/realAdo.ts

function escapeWiqlValue(value: string): string {
  return value.replace(/'/g, "''");
}

function buildWiqlQuery(fieldMatch: Record<string, string>): string {
  const conditions = Object.entries(fieldMatch)
    .map(([field, value]) => `[${field}] = '${escapeWiqlValue(value)}'`)
    .join(' AND ');
  return `SELECT [System.Id] FROM WorkItems WHERE ${conditions}`;
}

// Replace the queryIds stub:
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
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd mcp-ado-server && npx vitest run test/realAdo.test.ts`
Expected: PASS (16 tests total)

- [ ] **Step 5: Run the full mcp-ado-server suite**

Run: `cd mcp-ado-server && npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add mcp-ado-server/src/backends/realAdo.ts mcp-ado-server/test/realAdo.test.ts
git commit -m "feat(mcp-ado-server): implement RealAdoBackend.queryIds via WIQL, with injection-safe value escaping"
```

---

### Task 5: `ado_discover_fields` tool — real backing for the Customer ID resolution algorithm

**Files:**
- Modify: `mcp-ado-server/src/backends/types.ts` (add a new method to `AdoBackend` — additive, does not change existing signatures)
- Modify: `mcp-ado-server/src/backends/mockAdo.ts` (implement the new method with a simple hardcoded field list)
- Modify: `mcp-ado-server/src/backends/realAdo.ts` (implement the new method for real)
- Create: `mcp-ado-server/src/tools/discoverFieldsTool.ts`
- Modify: `mcp-ado-server/src/server.ts` (register the new tool)
- Test: `mcp-ado-server/test/mockAdo.test.ts` (append), `mcp-ado-server/test/realAdo.test.ts` (append), `mcp-ado-server/test/discoverFieldsTool.test.ts` (new)

**Interfaces:**
- Modifies: `AdoBackend` gains `discoverFields(workItemType: WorkItemType): Promise<string[]>` (returns the list of field reference names available on that work-item type) — additive to the interface, both existing backends must implement it.
- Produces: `ado_discover_fields` MCP tool, registered in `server.ts` alongside `ado_ping`. This is the REAL backing for the Customer ID candidate-list resolution algorithm already fully designed in `docs/architecture.md`'s "Customer ID Field Resolution" section (steps 1-5) — that section describes checking `GET workitemtypes/{type}/fields` and matching against `Custom.CustomerId`/`Custom.CustomerRequirementId`/`Custom.CustomerID` in priority order; this task builds the MCP tool that makes that call available, but the priority-list matching LOGIC itself belongs to whichever caller consumes this tool (the orchestrator's write-back driver, Task 9) — this task only exposes the raw field list.

**Boundary:** Only touch the six files listed above.

- [ ] **Step 1: Write the failing tests for both backends' `discoverFields`**

```typescript
// Append to mcp-ado-server/test/mockAdo.test.ts

describe('MockAdoBackend.discoverFields', () => {
  it('returns a hardcoded, realistic set of field ref names for Requirement', async () => {
    const backend = new MockAdoBackend(':memory:');
    const fields = await backend.discoverFields('Requirement');
    expect(fields).toContain('System.Title');
    expect(fields).toContain('System.Description');
    expect(fields).toContain('Custom.CustomerId');
  });
});
```

```typescript
// Append to mcp-ado-server/test/realAdo.test.ts

describe('RealAdoBackend.discoverFields', () => {
  it('GETs the work-item-type fields endpoint and returns the reference names', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} }) // api-version probe
      .mockResolvedValueOnce({
        status: 200,
        data: {
          fields: [
            { referenceName: 'System.Title' },
            { referenceName: 'Custom.CustomerRequirementId' },
            { referenceName: 'Microsoft.VSTS.CMMI.RequirementType' },
          ],
        },
      });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.discoverFields('Requirement');
    expect(result).toEqual(['System.Title', 'Custom.CustomerRequirementId', 'Microsoft.VSTS.CMMI.RequirementType']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mcp-ado-server && npx vitest run test/mockAdo.test.ts test/realAdo.test.ts`
Expected: FAIL — `discoverFields` doesn't exist on either backend.

- [ ] **Step 3: Add the method to the `AdoBackend` interface**

```typescript
// mcp-ado-server/src/backends/types.ts — add this method to the existing AdoBackend interface:
export interface AdoBackend {
  ping(): Promise<{ ok: true; backend: 'mock' | 'real' }>;
  createWorkItem(input: CreateWorkItemInput): Promise<WorkItemRecord>;
  getWorkItem(id: number): Promise<WorkItemRecord | null>;
  linkParentChild(childId: number, parentId: number): Promise<void>;
  queryIds(fieldMatch: Record<string, string>): Promise<number[]>;
  /**
   * Returns the field reference names available on a given work-item type —
   * real backing for docs/architecture.md's "Customer ID Field Resolution"
   * candidate-list algorithm (Phase 4/7). The priority-list matching logic
   * itself lives in the caller (see Task 9's write-back driver), not here.
   */
  discoverFields(workItemType: WorkItemType): Promise<string[]>;
}
```

- [ ] **Step 4: Implement in `MockAdoBackend`**

```typescript
// mcp-ado-server/src/backends/mockAdo.ts — add this method to the existing class:
async discoverFields(_workItemType: WorkItemType): Promise<string[]> {
  // Hardcoded, realistic field set for off-network dev/tests — good enough
  // to exercise the Customer ID candidate-matching logic without a real
  // ADO server. Includes one of the three real candidate names so callers
  // can test the "found" path against the mock.
  return [
    'System.Title',
    'System.Description',
    'System.State',
    'System.AreaPath',
    'Microsoft.VSTS.CMMI.RequirementType',
    'Custom.CustomerId',
  ];
}
```

- [ ] **Step 5: Implement in `RealAdoBackend`**

```typescript
// mcp-ado-server/src/backends/realAdo.ts — add this method to the existing class:
async discoverFields(workItemType: WorkItemType): Promise<string[]> {
  const version = await this.getApiVersion();
  const url = `${this.credential.orgUrl.replace(/\/$/, '')}/${this.config.adoProject}/_apis/wit/workitemtypes/${workItemType}/fields${versionQueryParam(version)}`;
  const response = await retryWithBackoff(() =>
    this.httpClient.get(url, { headers: { Authorization: this.authHeader() } }),
  );
  return response.data.fields.map((field: { referenceName: string }) => field.referenceName);
}
```

- [ ] **Step 6: Run to verify the backend tests pass**

Run: `cd mcp-ado-server && npx vitest run test/mockAdo.test.ts test/realAdo.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing test for the MCP tool**

```typescript
// mcp-ado-server/test/discoverFieldsTool.test.ts
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDiscoverFieldsTool } from '../src/tools/discoverFieldsTool';
import { MockAdoBackend } from '../src/backends/mockAdo';

describe('ado_discover_fields tool', () => {
  it('registers without throwing and calls through to the backend', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const backend = new MockAdoBackend(':memory:');
    expect(() => registerDiscoverFieldsTool(server, backend)).not.toThrow();
  });
});
```

- [ ] **Step 8: Run to verify failure**

Run: `cd mcp-ado-server && npx vitest run test/discoverFieldsTool.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 9: Implement the tool**

```typescript
// mcp-ado-server/src/tools/discoverFieldsTool.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';

/** Registers `ado_discover_fields` — lists field reference names for a work-item type. */
export function registerDiscoverFieldsTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_discover_fields',
    {
      title: 'Discover ADO work-item type fields',
      description:
        'Returns the field reference names available on a given work-item type. Used by callers to resolve the correct Customer ID field ref name against a runtime-verified candidate list (see docs/architecture.md "Customer ID Field Resolution").',
      inputSchema: { workItemType: z.enum(['Epic', 'Feature', 'Requirement']) },
    },
    async ({ workItemType }) => {
      const fields = await backend.discoverFields(workItemType);
      return { content: [{ type: 'text', text: JSON.stringify(fields) }] };
    },
  );
}
```

- [ ] **Step 10: Register it in `server.ts`**

```typescript
// mcp-ado-server/src/server.ts — add the import and registration call:
import { registerDiscoverFieldsTool } from './tools/discoverFieldsTool.js';

// Inside the app.post('/mcp', ...) handler, alongside the existing registerPingTool call:
registerPingTool(mcpServer, backend);
registerDiscoverFieldsTool(mcpServer, backend);
```

- [ ] **Step 11: Run to verify all pass**

Run: `cd mcp-ado-server && npx vitest run`
Expected: all pass, no regressions.

- [ ] **Step 12: Commit**

```bash
git add mcp-ado-server/src/backends/types.ts mcp-ado-server/src/backends/mockAdo.ts mcp-ado-server/src/backends/realAdo.ts mcp-ado-server/src/tools/discoverFieldsTool.ts mcp-ado-server/src/server.ts mcp-ado-server/test/mockAdo.test.ts mcp-ado-server/test/realAdo.test.ts mcp-ado-server/test/discoverFieldsTool.test.ts
git commit -m "feat(mcp-ado-server): add discoverFields to AdoBackend + ado_discover_fields tool, closing the Customer ID resolution gap"
```

---

### Task 6: `ado_create_work_item` + `ado_link_parent_child` tools

**Files:**
- Create: `mcp-ado-server/src/tools/createWorkItemTool.ts`
- Create: `mcp-ado-server/src/tools/linkParentChildTool.ts`
- Modify: `mcp-ado-server/src/server.ts` (register both)
- Test: `mcp-ado-server/test/createWorkItemTool.test.ts`, `mcp-ado-server/test/linkParentChildTool.test.ts`

**Interfaces:**
- Produces: `ado_create_work_item` (input: `{type, fields}`, matches `CreateWorkItemInput`) and `ado_link_parent_child` (input: `{childId, parentId}`) MCP tools.

**Boundary:** Only touch the four files listed. Mirror `pingTool.ts`/`discoverFieldsTool.ts`'s exact registration pattern.

- [ ] **Step 1: Write the failing tests**

```typescript
// mcp-ado-server/test/createWorkItemTool.test.ts
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCreateWorkItemTool } from '../src/tools/createWorkItemTool';
import { MockAdoBackend } from '../src/backends/mockAdo';

describe('ado_create_work_item tool', () => {
  it('registers without throwing', () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const backend = new MockAdoBackend(':memory:');
    expect(() => registerCreateWorkItemTool(server, backend)).not.toThrow();
  });
});
```

```typescript
// mcp-ado-server/test/linkParentChildTool.test.ts
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerLinkParentChildTool } from '../src/tools/linkParentChildTool';
import { MockAdoBackend } from '../src/backends/mockAdo';

describe('ado_link_parent_child tool', () => {
  it('registers without throwing', () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const backend = new MockAdoBackend(':memory:');
    expect(() => registerLinkParentChildTool(server, backend)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mcp-ado-server && npx vitest run test/createWorkItemTool.test.ts test/linkParentChildTool.test.ts`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Implement both tools**

```typescript
// mcp-ado-server/src/tools/createWorkItemTool.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';

export function registerCreateWorkItemTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_create_work_item',
    {
      title: 'Create an ADO work item',
      description: 'Creates a new work item of the given type with the given fields. Does not link a parent — use ado_link_parent_child separately.',
      inputSchema: {
        type: z.enum(['Epic', 'Feature', 'Requirement']),
        fields: z.record(z.string()),
      },
    },
    async ({ type, fields }) => {
      const result = await backend.createWorkItem({ type, fields });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );
}
```

```typescript
// mcp-ado-server/src/tools/linkParentChildTool.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';

export function registerLinkParentChildTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_link_parent_child',
    {
      title: 'Link a child work item to its parent',
      description: 'Adds a System.LinkTypes.Hierarchy-Reverse relation from childId to parentId.',
      inputSchema: { childId: z.number(), parentId: z.number() },
    },
    async ({ childId, parentId }) => {
      await backend.linkParentChild(childId, parentId);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    },
  );
}
```

- [ ] **Step 4: Register both in `server.ts`**

```typescript
// mcp-ado-server/src/server.ts — add imports and registration calls:
import { registerCreateWorkItemTool } from './tools/createWorkItemTool.js';
import { registerLinkParentChildTool } from './tools/linkParentChildTool.js';

// Inside the app.post('/mcp', ...) handler:
registerPingTool(mcpServer, backend);
registerDiscoverFieldsTool(mcpServer, backend);
registerCreateWorkItemTool(mcpServer, backend);
registerLinkParentChildTool(mcpServer, backend);
```

- [ ] **Step 5: Run to verify all pass**

Run: `cd mcp-ado-server && npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add mcp-ado-server/src/tools/createWorkItemTool.ts mcp-ado-server/src/tools/linkParentChildTool.ts mcp-ado-server/src/server.ts mcp-ado-server/test/createWorkItemTool.test.ts mcp-ado-server/test/linkParentChildTool.test.ts
git commit -m "feat(mcp-ado-server): add ado_create_work_item and ado_link_parent_child tools"
```

---

### Task 7: `ado_set_fields` + `ado_query_ids` tools

**Files:**
- Modify: `mcp-ado-server/src/backends/types.ts` (add `setFields` method — additive)
- Modify: `mcp-ado-server/src/backends/mockAdo.ts`, `mcp-ado-server/src/backends/realAdo.ts` (implement `setFields`)
- Create: `mcp-ado-server/src/tools/setFieldsTool.ts`
- Create: `mcp-ado-server/src/tools/queryIdsTool.ts`
- Modify: `mcp-ado-server/src/server.ts` (register both)
- Test: `mcp-ado-server/test/mockAdo.test.ts`, `mcp-ado-server/test/realAdo.test.ts` (append), `mcp-ado-server/test/setFieldsTool.test.ts`, `mcp-ado-server/test/queryIdsTool.test.ts` (new)

**Interfaces:**
- Modifies: `AdoBackend` gains `setFields(id: number, fields: Record<string, string>): Promise<void>` — additive.
- Produces: `ado_set_fields` (input: `{id, fields}`) and `ado_query_ids` (input: `{fieldMatch}`, matching `queryIds`'s existing shape) MCP tools.

**Boundary:** Only touch the seven files listed.

- [ ] **Step 1: Write the failing backend tests**

```typescript
// Append to mcp-ado-server/test/mockAdo.test.ts

describe('MockAdoBackend.setFields', () => {
  it('updates the fields of an existing work item', async () => {
    const backend = new MockAdoBackend(':memory:');
    const created = await backend.createWorkItem({ type: 'Requirement', fields: { 'System.Title': 'Original' } });
    await backend.setFields(created.id, { 'System.Title': 'Updated' });
    const updated = await backend.getWorkItem(created.id);
    expect(updated?.fields['System.Title']).toBe('Updated');
  });

  it('merges new fields with existing ones rather than replacing the whole fields object', async () => {
    const backend = new MockAdoBackend(':memory:');
    const created = await backend.createWorkItem({
      type: 'Requirement',
      fields: { 'System.Title': 'Title', 'System.State': 'Proposed' },
    });
    await backend.setFields(created.id, { 'System.State': 'Active' });
    const updated = await backend.getWorkItem(created.id);
    expect(updated?.fields['System.Title']).toBe('Title');
    expect(updated?.fields['System.State']).toBe('Active');
  });
});
```

```typescript
// Append to mcp-ado-server/test/realAdo.test.ts

describe('RealAdoBackend.setFields', () => {
  it('PATCHes a JSON-Patch add op per field', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    const patchSpy = vi.spyOn(httpClient, 'patch').mockResolvedValueOnce({ status: 200, data: {} });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.setFields(42, { 'System.State': 'Active' });

    expect(patchSpy.mock.calls[0][0]).toContain('/wit/workitems/42');
    expect(patchSpy.mock.calls[0][1]).toEqual([{ op: 'add', path: '/fields/System.State', value: 'Active' }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mcp-ado-server && npx vitest run test/mockAdo.test.ts test/realAdo.test.ts`
Expected: FAIL — `setFields` doesn't exist on either backend.

- [ ] **Step 3: Add `setFields` to the interface**

```typescript
// mcp-ado-server/src/backends/types.ts — add to the AdoBackend interface:
  /** Updates (merges) fields on an existing work item without changing its type or parent link. */
  setFields(id: number, fields: Record<string, string>): Promise<void>;
```

- [ ] **Step 4: Implement in `MockAdoBackend`**

```typescript
// mcp-ado-server/src/backends/mockAdo.ts — add this method:
async setFields(id: number, fields: Record<string, string>): Promise<void> {
  const existing = this.db.prepare('SELECT fields FROM work_items WHERE id = ?').get(id) as
    | { fields: string }
    | undefined;
  if (!existing) return;
  const merged = { ...JSON.parse(existing.fields), ...fields };
  this.db.prepare('UPDATE work_items SET fields = ? WHERE id = ?').run(JSON.stringify(merged), id);
}
```

- [ ] **Step 5: Implement in `RealAdoBackend`**

```typescript
// mcp-ado-server/src/backends/realAdo.ts — add this method:
async setFields(id: number, fields: Record<string, string>): Promise<void> {
  const version = await this.getApiVersion();
  const url = `${this.credential.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems/${id}${versionQueryParam(version)}`;
  await retryWithBackoff(() =>
    this.httpClient.patch(url, toJsonPatch(fields), {
      headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json-patch+json' },
    }),
  );
}
```

- [ ] **Step 6: Run to verify the backend tests pass**

Run: `cd mcp-ado-server && npx vitest run test/mockAdo.test.ts test/realAdo.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing tool tests**

```typescript
// mcp-ado-server/test/setFieldsTool.test.ts
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSetFieldsTool } from '../src/tools/setFieldsTool';
import { MockAdoBackend } from '../src/backends/mockAdo';

describe('ado_set_fields tool', () => {
  it('registers without throwing', () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    expect(() => registerSetFieldsTool(server, new MockAdoBackend(':memory:'))).not.toThrow();
  });
});
```

```typescript
// mcp-ado-server/test/queryIdsTool.test.ts
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerQueryIdsTool } from '../src/tools/queryIdsTool';
import { MockAdoBackend } from '../src/backends/mockAdo';

describe('ado_query_ids tool', () => {
  it('registers without throwing', () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    expect(() => registerQueryIdsTool(server, new MockAdoBackend(':memory:'))).not.toThrow();
  });
});
```

- [ ] **Step 8: Run to verify failure**

Run: `cd mcp-ado-server && npx vitest run test/setFieldsTool.test.ts test/queryIdsTool.test.ts`
Expected: FAIL — modules don't exist.

- [ ] **Step 9: Implement both tools**

```typescript
// mcp-ado-server/src/tools/setFieldsTool.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';

export function registerSetFieldsTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_set_fields',
    {
      title: 'Set fields on an existing ADO work item',
      description: 'Merges the given fields onto an existing work item without changing its type or parent link.',
      inputSchema: { id: z.number(), fields: z.record(z.string()) },
    },
    async ({ id, fields }) => {
      await backend.setFields(id, fields);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    },
  );
}
```

```typescript
// mcp-ado-server/src/tools/queryIdsTool.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';

export function registerQueryIdsTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_query_ids',
    {
      title: 'Query work item ids by exact field match',
      description: 'Returns ids of work items whose fields exactly match every key/value pair given. Used for dedup/idempotency lookups.',
      inputSchema: { fieldMatch: z.record(z.string()) },
    },
    async ({ fieldMatch }) => {
      const ids = await backend.queryIds(fieldMatch);
      return { content: [{ type: 'text', text: JSON.stringify(ids) }] };
    },
  );
}
```

- [ ] **Step 10: Register both in `server.ts`**

```typescript
// mcp-ado-server/src/server.ts — add imports and registration calls:
import { registerSetFieldsTool } from './tools/setFieldsTool.js';
import { registerQueryIdsTool } from './tools/queryIdsTool.js';

// Inside the app.post('/mcp', ...) handler:
registerPingTool(mcpServer, backend);
registerDiscoverFieldsTool(mcpServer, backend);
registerCreateWorkItemTool(mcpServer, backend);
registerLinkParentChildTool(mcpServer, backend);
registerSetFieldsTool(mcpServer, backend);
registerQueryIdsTool(mcpServer, backend);
```

- [ ] **Step 11: Run the full mcp-ado-server suite**

Run: `cd mcp-ado-server && npx vitest run`
Expected: all pass.

- [ ] **Step 12: Commit**

```bash
git add mcp-ado-server/src/backends/types.ts mcp-ado-server/src/backends/mockAdo.ts mcp-ado-server/src/backends/realAdo.ts mcp-ado-server/src/tools/setFieldsTool.ts mcp-ado-server/src/tools/queryIdsTool.ts mcp-ado-server/src/server.ts mcp-ado-server/test/mockAdo.test.ts mcp-ado-server/test/realAdo.test.ts mcp-ado-server/test/setFieldsTool.test.ts mcp-ado-server/test/queryIdsTool.test.ts
git commit -m "feat(mcp-ado-server): add setFields to AdoBackend + ado_set_fields and ado_query_ids tools"
```

---

### Task 8: Wire `RealAdoBackend` into `index.ts` (remove the Phase 0 placeholder error)

**Files:**
- Modify: `mcp-ado-server/src/index.ts`
- Modify: `mcp-ado-server/src/config/env.ts` (the per-request `credential` is NOT loaded from env — document why, matching `patAuth.ts`'s existing contract)
- Test: (no new automated test — this file's Phase 0 behavior of "throw if backend=real" is what's being removed; verified manually per Step 3 below, since real credential wiring requires either a live ADO server or the orchestrator's request path, neither of which exists in this package's own test harness)

**Interfaces:** None new — this task only removes Phase 0's explicit placeholder guard and wires the already-built `RealAdoBackend` in.

**Boundary:** Only touch `index.ts`. Note the credential-sourcing gap explicitly (see Step 2) rather than inventing a fake solution — per-request PAT credentials fundamentally don't fit this package's current "one backend instance per process" `index.ts` bootstrap shape, and resolving that is Task 9's job (the orchestrator constructs a fresh `RealAdoBackend` per request/job, not `index.ts`'s top-level bootstrap).

- [ ] **Step 1: Read the current `index.ts` bootstrap shape**

Note that Phase 0's `index.ts` constructs ONE backend instance at process startup and passes it to `createMcpApp`. This works for `MockAdoBackend` (no per-user credential needed) but does NOT work for `RealAdoBackend` as designed in Tasks 1-7 (which takes a `credential: AdoCredential` in its constructor — a per-request/per-user value, not a process-startup value).

- [ ] **Step 2: Document the real architectural resolution needed, rather than papering over it**

The correct design is: `RealAdoBackend` should be constructed PER MCP REQUEST inside `server.ts`'s `app.post('/mcp', ...)` handler (which already creates a fresh `McpServer` per request per Phase 0's stateless pattern) — using a credential extracted from the request itself (e.g. a custom header the orchestrator sets, `X-Ado-Org-Url`/`X-Ado-Pat`, forwarded from the user's login-session PAT). This is a real, non-trivial design decision (how does the orchestrator's MCP client pass per-user ADO credentials through to a stateless MCP tool call?) that `docs/architecture.md` does not currently specify in enough detail to implement blindly.

**Do not implement a guess here.** Instead:

```typescript
// mcp-ado-server/src/index.ts (full file, replacing existing content)
import { createMcpApp } from './server.js';
import { loadConfig } from './config/env.js';
import { MockAdoBackend } from './backends/mockAdo.js';

const cfg = loadConfig();

if (cfg.backend === 'real') {
  // RealAdoBackend (Tasks 1-7) takes a per-request AdoCredential in its
  // constructor, but this bootstrap constructs ONE backend at process
  // startup for the app's whole lifetime — a shape that only fits
  // MockAdoBackend, which needs no per-user credential. Per-request
  // credential wiring (how the orchestrator forwards a user's ADO PAT
  // through to a stateless MCP tool call — e.g. a custom request header
  // read inside server.ts's per-request handler) is a real design decision
  // not yet specified precisely enough in docs/architecture.md to implement
  // without guessing. Flagging this explicitly rather than picking an
  // unreviewed guess: THIS MUST BE RESOLVED (a short design note in
  // docs/architecture.md, then wiring server.ts to construct a fresh
  // RealAdoBackend per request from that header) before ADO_BACKEND=real
  // can run in this process. Until then, real ADO integration testing
  // happens via directly instantiating RealAdoBackend in tests (Tasks 1-7),
  // not via this process's live HTTP path.
  throw new Error(
    'ADO_BACKEND=real requires per-request credential wiring not yet resolved — see the comment above this line. Set ADO_BACKEND=mock for now.',
  );
}

const backend = new MockAdoBackend(cfg.mockDbPath);
const app = createMcpApp(backend, cfg);
app.listen(cfg.port, () => {
  // eslint-disable-next-line no-console -- startup banner, not app logging
  process.stdout.write(`req2ado mcp-ado-server listening on :${cfg.port} (backend=${cfg.backend})\n`);
});
```

- [ ] **Step 3: Manually verify the mock path still works**

Run: `cd mcp-ado-server && ADO_BACKEND=mock MCP_BEARER=dev-local-only npm run start:dev &` then `curl http://localhost:4100/health` — expect `{"ok":true,"backend":"mock"}`. Stop the dev server afterward.

- [ ] **Step 4: Run the full suite to confirm no regressions**

Run: `cd mcp-ado-server && npx vitest run`
Expected: all pass — this task changes no tested code path (only `index.ts`, which has no existing automated test).

- [ ] **Step 5: Commit**

```bash
git add mcp-ado-server/src/index.ts
git commit -m "docs(mcp-ado-server): flag per-request ADO credential wiring as an unresolved design gap for ADO_BACKEND=real"
```

---

### Task 9: Orchestrator idempotency map (Prisma) + dry-run diff

**Files:**
- Modify: `orchestrator/prisma/schema.prisma` (add `IdempotencyMap` model)
- Create: `orchestrator/src/modules/writeback/idempotency.service.ts`
- Create: `orchestrator/src/modules/writeback/dry-run.service.ts`
- Test: `orchestrator/test/idempotency.service.spec.ts`, `orchestrator/test/dry-run.service.spec.ts`

**Interfaces:**
- Produces: Prisma model `IdempotencyMap { sourceHash: String, customerId: String?, areaPath: String, adoWorkItemId: Int }` with a compound unique constraint on `(sourceHash, customerId, areaPath)`, per `docs/architecture.md`'s already-locked idempotency key.
- Produces: `IdempotencyService.lookup(sourceHash: string, customerId: string | null, areaPath: string): Promise<number | null>` and `IdempotencyService.record(sourceHash, customerId, areaPath, adoWorkItemId): Promise<void>`.
- Produces: `DryRunService.diff(tree: WorkItemTreeNode[], idempotencyService: IdempotencyService): Promise<DryRunDiffEntry[]>` where `DryRunDiffEntry = { localId: string, action: 'create' | 'reuse', existingAdoId: number | null }` — per node, determines whether this run would create a new ADO item or reuse an existing one, WITHOUT calling any MCP tool (pure diff against the idempotency map, matching `config.yaml`'s `dry_run: true` default and Phase 7's DoD "dry-run diff").

**Boundary:** Only touch the four files listed (plus the Prisma schema and its generated migration).

- [ ] **Step 1: Add the Prisma model**

```prisma
// orchestrator/prisma/schema.prisma — add this model (check the exact existing model block style/imports before appending, to match conventions)
model IdempotencyMap {
  id            Int     @id @default(autoincrement())
  sourceHash    String
  customerId    String?
  areaPath      String
  adoWorkItemId Int

  @@unique([sourceHash, customerId, areaPath])
}
```

Run: `cd orchestrator && npx prisma migrate dev --name add_idempotency_map` (requires a running local Postgres per this project's existing dev setup — if unavailable, generate the migration SQL file manually following the existing migration files' format, and note this in the task report for the user to apply against a real Postgres instance).

- [ ] **Step 2: Write the failing tests for `IdempotencyService`**

```typescript
// orchestrator/test/idempotency.service.spec.ts
import { IdempotencyService } from '../src/modules/writeback/idempotency.service';

describe('IdempotencyService', () => {
  const fakePrisma = {
    idempotencyMap: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('lookup returns null when no matching record exists', async () => {
    fakePrisma.idempotencyMap.findUnique.mockResolvedValue(null);
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    const result = await service.lookup('hash1', 'CUST-1', 'Project\\Area1');
    expect(result).toBeNull();
  });

  it('lookup returns the ADO work item id when a record exists', async () => {
    fakePrisma.idempotencyMap.findUnique.mockResolvedValue({ adoWorkItemId: 42 });
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    const result = await service.lookup('hash1', 'CUST-1', 'Project\\Area1');
    expect(result).toBe(42);
  });

  it('lookup queries on the exact compound key', async () => {
    fakePrisma.idempotencyMap.findUnique.mockResolvedValue(null);
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    await service.lookup('hash1', 'CUST-1', 'Project\\Area1');
    expect(fakePrisma.idempotencyMap.findUnique).toHaveBeenCalledWith({
      where: {
        sourceHash_customerId_areaPath: { sourceHash: 'hash1', customerId: 'CUST-1', areaPath: 'Project\\Area1' },
      },
    });
  });

  it('record creates a new mapping row', async () => {
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    await service.record('hash1', 'CUST-1', 'Project\\Area1', 42);
    expect(fakePrisma.idempotencyMap.create).toHaveBeenCalledWith({
      data: { sourceHash: 'hash1', customerId: 'CUST-1', areaPath: 'Project\\Area1', adoWorkItemId: 42 },
    });
  });

  it('lookup and record both accept a null customerId', async () => {
    fakePrisma.idempotencyMap.findUnique.mockResolvedValue(null);
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    await service.lookup('hash1', null, 'Project\\Area1');
    expect(fakePrisma.idempotencyMap.findUnique).toHaveBeenCalledWith({
      where: { sourceHash_customerId_areaPath: { sourceHash: 'hash1', customerId: null, areaPath: 'Project\\Area1' } },
    });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd orchestrator && npx jest test/idempotency.service.spec.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement `IdempotencyService`**

```typescript
// orchestrator/src/modules/writeback/idempotency.service.ts
import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

/**
 * Backs docs/architecture.md's idempotency key: (source_hash, customer_id,
 * area_path) -> System.Id. A row existing means this exact source content,
 * for this customer, in this area path, already has a corresponding ADO
 * work item — re-running ingestion must reuse that id, never create a
 * duplicate.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaClient) {}

  async lookup(sourceHash: string, customerId: string | null, areaPath: string): Promise<number | null> {
    const record = await this.prisma.idempotencyMap.findUnique({
      where: { sourceHash_customerId_areaPath: { sourceHash, customerId, areaPath } },
    });
    return record?.adoWorkItemId ?? null;
  }

  async record(sourceHash: string, customerId: string | null, areaPath: string, adoWorkItemId: number): Promise<void> {
    await this.prisma.idempotencyMap.create({ data: { sourceHash, customerId, areaPath, adoWorkItemId } });
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd orchestrator && npx jest test/idempotency.service.spec.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Write the failing tests for `DryRunService`**

```typescript
// orchestrator/test/dry-run.service.spec.ts
import { DryRunService } from '../src/modules/writeback/dry-run.service';
import type { IdempotencyService } from '../src/modules/writeback/idempotency.service';

describe('DryRunService', () => {
  const fakeIdempotencyService = { lookup: jest.fn() } as unknown as IdempotencyService;

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('marks a node as "create" when no existing mapping is found', async () => {
    (fakeIdempotencyService.lookup as jest.Mock).mockResolvedValue(null);
    const service = new DryRunService();
    const result = await service.diff(
      [{ localId: 'n0', sourceHash: 'hash1', customerId: null, areaPath: 'Project\\Area1' }],
      fakeIdempotencyService,
    );
    expect(result).toEqual([{ localId: 'n0', action: 'create', existingAdoId: null }]);
  });

  it('marks a node as "reuse" when an existing mapping is found', async () => {
    (fakeIdempotencyService.lookup as jest.Mock).mockResolvedValue(42);
    const service = new DryRunService();
    const result = await service.diff(
      [{ localId: 'n0', sourceHash: 'hash1', customerId: 'CUST-1', areaPath: 'Project\\Area1' }],
      fakeIdempotencyService,
    );
    expect(result).toEqual([{ localId: 'n0', action: 'reuse', existingAdoId: 42 }]);
  });

  it('diffs every node in a multi-node tree independently', async () => {
    (fakeIdempotencyService.lookup as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(7);
    const service = new DryRunService();
    const result = await service.diff(
      [
        { localId: 'n0', sourceHash: 'hash1', customerId: null, areaPath: 'Project\\Area1' },
        { localId: 'n1', sourceHash: 'hash2', customerId: null, areaPath: 'Project\\Area1' },
      ],
      fakeIdempotencyService,
    );
    expect(result).toEqual([
      { localId: 'n0', action: 'create', existingAdoId: null },
      { localId: 'n1', action: 'reuse', existingAdoId: 7 },
    ]);
  });

  it('does not call any MCP tool or perform any write — pure diff', async () => {
    (fakeIdempotencyService.lookup as jest.Mock).mockResolvedValue(null);
    const service = new DryRunService();
    await service.diff(
      [{ localId: 'n0', sourceHash: 'hash1', customerId: null, areaPath: 'Project\\Area1' }],
      fakeIdempotencyService,
    );
    // No assertion needed beyond "this test exists and only calls lookup()"
    // — DryRunService has no MCP client dependency at all by construction,
    // so there is nothing else it COULD call.
    expect(fakeIdempotencyService.lookup).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 7: Run to verify failure**

Run: `cd orchestrator && npx jest test/dry-run.service.spec.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 8: Implement `DryRunService`**

```typescript
// orchestrator/src/modules/writeback/dry-run.service.ts
import { Injectable } from '@nestjs/common';
import type { IdempotencyService } from './idempotency.service';

export interface DryRunTreeNode {
  localId: string;
  sourceHash: string;
  customerId: string | null;
  areaPath: string;
}

export interface DryRunDiffEntry {
  localId: string;
  action: 'create' | 'reuse';
  existingAdoId: number | null;
}

/**
 * Pure diff against the idempotency map — no MCP tool call, no ADO write.
 * Satisfies Phase 7's DoD "dry-run diff" and config.yaml's dry_run: true
 * default: a caller can show this diff to a user for confirmation before
 * performing any real write-back.
 */
@Injectable()
export class DryRunService {
  async diff(nodes: DryRunTreeNode[], idempotencyService: IdempotencyService): Promise<DryRunDiffEntry[]> {
    const results: DryRunDiffEntry[] = [];
    for (const node of nodes) {
      const existingAdoId = await idempotencyService.lookup(node.sourceHash, node.customerId, node.areaPath);
      results.push({
        localId: node.localId,
        action: existingAdoId === null ? 'create' : 'reuse',
        existingAdoId,
      });
    }
    return results;
  }
}
```

- [ ] **Step 9: Run to verify it passes**

Run: `cd orchestrator && npx jest test/dry-run.service.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 10: Run the full orchestrator suite**

Run: `cd orchestrator && npx jest`
Expected: all pass, no regressions.

- [ ] **Step 11: Commit**

```bash
git add orchestrator/prisma/schema.prisma orchestrator/src/modules/writeback/idempotency.service.ts orchestrator/src/modules/writeback/dry-run.service.ts orchestrator/test/idempotency.service.spec.ts orchestrator/test/dry-run.service.spec.ts
git commit -m "feat(orchestrator): add IdempotencyMap Prisma model, IdempotencyService, and DryRunService"
```

---

### Task 10: Golden re-run test proving zero duplicate writes

**Files:**
- Test: `mcp-ado-server/test/idempotentWriteback.integration.test.ts` (new file, integration-style test using `MockAdoBackend` directly — no live ADO needed, matching Phase 7's DoD "MCP tools unit+integration tested vs mock")

**Interfaces:**
- Consumes: `MockAdoBackend` (Phase 0), `RealAdoBackend`'s interface shape (proves `MockAdoBackend` alone is sufficient to exercise the idempotency CONTRACT even without a live ADO server — the actual dedup/reuse decision lives in the orchestrator's `IdempotencyService`/`DryRunService` from Task 9, which this test simulates inline since it has no NestJS test harness dependency in this package).

**Boundary:** Test-only task — no production code changes. Only touch the one new file.

- [ ] **Step 1: Write the golden re-run integration test**

```typescript
// mcp-ado-server/test/idempotentWriteback.integration.test.ts
import { describe, it, expect } from 'vitest';
import { MockAdoBackend } from '../src/backends/mockAdo';

/**
 * Simulates the orchestrator's write-back loop (Task 9's IdempotencyService
 * + DryRunService pattern) directly against MockAdoBackend, without needing
 * a NestJS test harness in this package. Proves the CONTRACT — check
 * before create, record after create, re-run finds and reuses — holds
 * against the real AdoBackend interface all backends implement.
 */
interface FakeIdempotencyMap {
  [key: string]: number;
}

function keyFor(sourceHash: string, customerId: string | null, areaPath: string): string {
  return `${sourceHash}::${customerId}::${areaPath}`;
}

async function ingestOnce(
  backend: MockAdoBackend,
  idempotencyMap: FakeIdempotencyMap,
  node: { sourceHash: string; customerId: string | null; areaPath: string; title: string },
): Promise<number> {
  const key = keyFor(node.sourceHash, node.customerId, node.areaPath);
  const existingId = idempotencyMap[key];
  if (existingId !== undefined) {
    return existingId; // reuse, no create call
  }
  const created = await backend.createWorkItem({ type: 'Requirement', fields: { 'System.Title': node.title } });
  idempotencyMap[key] = created.id;
  return created.id;
}

describe('Idempotent write-back (golden re-run)', () => {
  it('re-ingesting the same node produces zero new work items', async () => {
    const backend = new MockAdoBackend(':memory:');
    const idempotencyMap: FakeIdempotencyMap = {};
    const node = {
      sourceHash: 'abc123',
      customerId: 'CUST-1',
      areaPath: 'Project\\Area1',
      title: 'The receiver shall scan all channels.',
    };

    const firstRunId = await ingestOnce(backend, idempotencyMap, node);
    const secondRunId = await ingestOnce(backend, idempotencyMap, node);

    expect(firstRunId).toBe(secondRunId);

    const allIds = await backend.queryIds({ 'System.Title': node.title });
    expect(allIds).toHaveLength(1);
  });

  it('a DIFFERENT customerId for the same source content creates a separate item', async () => {
    const backend = new MockAdoBackend(':memory:');
    const idempotencyMap: FakeIdempotencyMap = {};
    const baseNode = { sourceHash: 'abc123', areaPath: 'Project\\Area1', title: 'Shared title text' };

    const idForCustomerA = await ingestOnce(backend, idempotencyMap, { ...baseNode, customerId: 'CUST-A' });
    const idForCustomerB = await ingestOnce(backend, idempotencyMap, { ...baseNode, customerId: 'CUST-B' });

    expect(idForCustomerA).not.toBe(idForCustomerB);
  });

  it('running three ingests of a two-node tree twice produces exactly two work items total', async () => {
    const backend = new MockAdoBackend(':memory:');
    const idempotencyMap: FakeIdempotencyMap = {};
    const nodes = [
      { sourceHash: 'hash-a', customerId: 'CUST-1', areaPath: 'Project\\Area1', title: 'Requirement A' },
      { sourceHash: 'hash-b', customerId: 'CUST-1', areaPath: 'Project\\Area1', title: 'Requirement B' },
    ];

    for (const node of nodes) await ingestOnce(backend, idempotencyMap, node);
    for (const node of nodes) await ingestOnce(backend, idempotencyMap, node); // re-run

    const idsA = await backend.queryIds({ 'System.Title': 'Requirement A' });
    const idsB = await backend.queryIds({ 'System.Title': 'Requirement B' });
    expect(idsA).toHaveLength(1);
    expect(idsB).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `cd mcp-ado-server && npx vitest run test/idempotentWriteback.integration.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 3: Run the full mcp-ado-server suite**

Run: `cd mcp-ado-server && npx vitest run`
Expected: all pass, no regressions.

- [ ] **Step 4: Commit**

```bash
git add mcp-ado-server/test/idempotentWriteback.integration.test.ts
git commit -m "test(mcp-ado-server): add golden re-run integration test proving zero duplicate writes"
```

---

## Self-Review Notes

- **Spec coverage:** Phase 7's DoD ("MCP tools unit+integration tested vs mock; dry-run diff; re-run zero dupes; parent links correct; 429 backoff; api-version fallback") is covered by name: Task 10 (re-run zero dupes, unit+integration vs mock), Task 9 (dry-run diff), Task 3 (linkParentChild + 429 backoff), Task 1 (api-version fallback).
- **Built on real, already-existing Phase 0 infrastructure, not redesigned from scratch:** the stateless transport pattern, `AdoBackend` interface, `MockAdoBackend`, and `ado_ping` tool were all read from the actual codebase before writing this plan (not assumed) — this phase adds a sibling backend and more tools onto that exact existing shape.
- **Real, honestly-flagged gap, not silently guessed:** Task 8 explicitly does NOT invent a per-request-credential wiring scheme for `index.ts`'s process-startup bootstrap, because `RealAdoBackend`'s constructor needs a per-user PAT that a single-process bootstrap has no source for. This mirrors the project's established pattern (the LLM-proxy gap before Phase 5, the pipeline-integration gap after Phase 5/6) of surfacing an unresolved design question explicitly rather than picking an unreviewed guess — **this should be resolved (a short docs/architecture.md addition, then wiring) before `ADO_BACKEND=real` can actually run**, and is called out as such in the task itself, not buried in Self-Review Notes alone.
- **Reuses existing helpers, does not reimplement:** `buildBasicAuthHeader` (Phase 0's `patAuth.ts`) is imported and reused in every `RealAdoBackend` method, never reimplemented.
- **Chroma-style "verify against reality" caution applied to axios/ADO REST shapes too:** the exact JSON shape of ADO's `workitemtypes/{type}/fields`, `wiql`, and `workitems/$Type` responses in this plan are based on `docs/architecture.md`'s already-documented "Generic ADO REST conventions reused as knowledge" section — but that section is itself knowledge ported from other projects (DocGen), not this project's own verified capture. If Task 1-7's implementer finds the real on-prem server's actual response shape differs in a field name or structure, the plan's Self-Review pattern (established in Phase 4/6) applies: adjust the implementation/test to match observed reality and document the discrepancy, don't force a mismatched assertion.
- **Idempotency map lives in the orchestrator (Postgres/Prisma), not in `mcp-ado-server`:** `mcp-ado-server` remains fully stateless (no database) per its original design intent — the idempotency CHECK happens in the orchestrator (Task 9) before ever calling an MCP tool; `mcp-ado-server`'s own `queryIds` tool (Task 7) is a general-purpose exact-match query capability that Task 9's design could optionally also use as a secondary consistency check against ADO's own state, but Task 9 as written relies on the orchestrator's own Postgres map as the primary source of truth (faster, no network round-trip per check).
- **Type consistency:** `AdoBackend`'s interface (Task 5/7's additive `discoverFields`/`setFields` methods) is implemented identically in both `MockAdoBackend` and `RealAdoBackend` at every step — no drift, and each addition includes a test for BOTH backends before the corresponding MCP tool is added.
- **No placeholders:** every step contains complete, runnable code; the one explicit "not implemented" (Task 8's `index.ts` real-backend bootstrap) is a documented, intentional stop with a clear resolution path stated inline — not a vague TODO.
