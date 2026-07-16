# P4a — Trace/Coverage Link Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let req2ado write trace/coverage links (Covers, CoveredBy, Affects, AffectedBy, and any
other work-item link type a project's ADO process template exposes) between generated work items,
in addition to the existing parent-child hierarchy link — inferred by the SURVEY-mode LLM from an
ADO link-type catalog discovered live per job.

**Architecture:** MCP server (`mcp-ado-server`) gains a generic `linkWorkItems(fromId, toId,
referenceName)` primitive and an `ado_discover_link_types` tool (live REST fetch, seed-catalog
fallback). Orchestrator discovers the catalog once per job, forwards it to ingestion's `/level`
call, and resolves each inferred link's target — same-tree targets after creation (confirm time),
prior-job targets via `ado_query_ids` on the customer-ID field (dry-run time). Ingestion's SURVEY
pipeline gets one new batched LLM call, `infer_trace_links`, that chooses a link type from the
supplied catalog per candidate pair; anything not in the catalog is dropped, never blocking
confirm. BASELINE mode is untouched — no LLM, so no trace-link inference runs for it.

**Tech Stack:** TypeScript/Express/Zod/Vitest (`mcp-ado-server`), NestJS/Jest (`orchestrator`),
Python/FastAPI/Pydantic/pytest (`ingestion`), React/MUI/Vitest (`frontend`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-16-p4a-trace-link-types-design.md`.
- SURVEY mode only — BASELINE never calls an LLM and gets no trace-link inference (spec, Context
  section).
- Unresolved links (bad customer id, dropped/hallucinated `referenceName`) are shown as
  unresolved and dropped at write time — confirm always proceeds, never blocks (spec, Error
  handling section).
- No manual add/edit UI for trace links this slice — auto-inferred only, read-only display (spec,
  Diff/review UI section).
- Discovery (`ado_discover_link_types`) runs once per job, not once per link/item (spec, Link-type
  discovery section) — cache in the orchestrator the same way `customerIdFieldByType` is cached in
  `jobs.service.ts:243`.
- **Deviation from spec wording, smaller diff:** the spec describes `linkWorkItems` as
  "superseding" `linkParentChild`. This plan instead **adds** `linkWorkItems` as a new backend
  method/tool and leaves the existing `linkParentChild` method/tool/call-sites completely
  untouched. Net effect for the hierarchy link is identical (no behavior change); the diff is
  smaller and the working parent-child path is never at risk. Do not remove or rename
  `linkParentChild` anywhere in this plan.

---

## Task 1: MCP server — link-type discovery

**Files:**
- Create: `mcp-ado-server/src/domain/adoLinkTypes.ts`
- Modify: `mcp-ado-server/src/backends/types.ts`
- Modify: `mcp-ado-server/src/backends/mockAdo.ts`
- Modify: `mcp-ado-server/src/backends/realAdo.ts`
- Create: `mcp-ado-server/src/tools/discoverLinkTypesTool.ts`
- Modify: `mcp-ado-server/src/server.ts`
- Test: `mcp-ado-server/test/adoLinkTypes.test.ts`
- Test: `mcp-ado-server/test/realAdo.test.ts` (add a `discoverLinkTypes` describe block)
- Test: `mcp-ado-server/test/discoverLinkTypesTool.test.ts`

**Interfaces:**
- Produces: `AdoLinkType { referenceName: string; name: string; semanticHint?: string }`;
  `SEED_LINK_TYPES: AdoLinkType[]`; `AdoBackend.discoverLinkTypes(): Promise<AdoLinkType[]>`; MCP
  tool `ado_discover_link_types` (no input args) returning `AdoLinkType[]` as JSON text.

- [ ] **Step 1: Write the failing domain-module test**

```typescript
// mcp-ado-server/test/adoLinkTypes.test.ts
import { describe, it, expect } from 'vitest';
import { SEED_LINK_TYPES } from '../src/domain/adoLinkTypes';

describe('SEED_LINK_TYPES', () => {
  it('includes the built-in hierarchy, related, and affects pair with semantic hints', () => {
    const byRef = new Map(SEED_LINK_TYPES.map((t) => [t.referenceName, t]));
    expect(byRef.get('System.LinkTypes.Hierarchy-Reverse')?.name).toBe('Parent');
    expect(byRef.get('System.LinkTypes.Affects-Forward')?.name).toBe('Affects');
    expect(byRef.get('System.LinkTypes.Affects-Reverse')?.name).toBe('Affected By');
    expect(byRef.get('System.LinkTypes.Affects-Forward')?.semanticHint).toMatch(/affects the target/);
  });

  it('every entry has a non-empty referenceName and name', () => {
    for (const t of SEED_LINK_TYPES) {
      expect(t.referenceName.length).toBeGreaterThan(0);
      expect(t.name.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-ado-server && npx vitest run test/adoLinkTypes.test.ts`
Expected: FAIL — cannot find module `../src/domain/adoLinkTypes`

- [ ] **Step 3: Write the domain module**

```typescript
// mcp-ado-server/src/domain/adoLinkTypes.ts
/**
 * Seed catalog used when the live ADO workitemrelationtypes call fails.
 * Real catalogs are always preferred — this is only the fallback, and only
 * covers built-in/common types; project-custom types beyond these are
 * visible only via the live call.
 */
export interface AdoLinkType {
  referenceName: string;
  name: string;
  semanticHint?: string;
}

export const SEED_LINK_TYPES: AdoLinkType[] = [
  {
    referenceName: 'System.LinkTypes.Hierarchy-Forward',
    name: 'Child',
    semanticHint: 'parent→child link; source is the parent, target is the child',
  },
  {
    referenceName: 'System.LinkTypes.Hierarchy-Reverse',
    name: 'Parent',
    semanticHint: 'child→parent link; source is the child, target is the parent',
  },
  {
    referenceName: 'System.LinkTypes.Related',
    name: 'Related',
    semanticHint: 'generic association between two work items',
  },
  {
    referenceName: 'System.LinkTypes.Affects-Forward',
    name: 'Affects',
    semanticHint: 'source item affects the target item',
  },
  {
    referenceName: 'System.LinkTypes.Affects-Reverse',
    name: 'Affected By',
    semanticHint: 'source item is affected by the target item',
  },
  {
    referenceName: 'Microsoft.VSTS.Common.TestedBy-Forward',
    name: 'Tested By',
    semanticHint: 'source item is tested by the target (test case)',
  },
  {
    referenceName: 'Microsoft.VSTS.Common.TestedBy-Reverse',
    name: 'Tests',
    semanticHint: 'source (test case) tests the target item',
  },
];

/** Relation types that do not link to another work item — never useful as a trace link. */
export const NON_WORK_ITEM_RELATION_TYPES: ReadonlySet<string> = new Set([
  'ArtifactLink',
  'Hyperlink',
  'AttachedFile',
]);

export function isWorkItemRelationType(referenceName: string): boolean {
  return !NON_WORK_ITEM_RELATION_TYPES.has(referenceName);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-ado-server && npx vitest run test/adoLinkTypes.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Add `discoverLinkTypes` to `AdoBackend`, `MockAdoBackend`, and `RealAdoBackend`**

Add to `mcp-ado-server/src/backends/types.ts`, inside the `AdoBackend` interface (after
`readAreaPaths`):

```typescript
  /**
   * Discovers the work-item link types available on the target ADO project's
   * process template (Phase 4's trace/coverage link feature). Real backend:
   * live REST call with a seed-catalog fallback on failure. Mock backend:
   * always returns the seed catalog — good enough to exercise the tool
   * contract without a real ADO server.
   */
  discoverLinkTypes(): Promise<import('../domain/adoLinkTypes.js').AdoLinkType[]>;
```

Add the import at the top of `types.ts`:

```typescript
import type { AdoLinkType } from '../domain/adoLinkTypes.js';
```

and use `AdoLinkType[]` directly in the method signature instead of the inline `import()` form
(cleaner — replace the line above with `discoverLinkTypes(): Promise<AdoLinkType[]>;`).

In `mcp-ado-server/src/backends/mockAdo.ts`, add the import and method:

```typescript
import { SEED_LINK_TYPES, type AdoLinkType } from '../domain/adoLinkTypes.js';
```

```typescript
  async discoverLinkTypes(): Promise<AdoLinkType[]> {
    return SEED_LINK_TYPES;
  }
```

In `mcp-ado-server/src/backends/realAdo.ts`, add the import:

```typescript
import { SEED_LINK_TYPES, isWorkItemRelationType, type AdoLinkType } from '../domain/adoLinkTypes.js';
```

and the method, at the end of the `RealAdoBackend` class body (before the closing brace, after
`toAreaPathNode`):

```typescript
  async discoverLinkTypes(): Promise<AdoLinkType[]> {
    const version = await this.getApiVersion();
    const url = `${this.credential.orgUrl.replace(/\/$/, '')}/_apis/wit/workitemrelationtypes${versionQueryParam(version)}`;
    try {
      const response = await retryWithBackoff(() =>
        this.httpClient.get(url, { headers: { Authorization: this.authHeader() } }),
      );
      const raw = response.data.value as { referenceName: string; name: string }[];
      return raw
        .filter((t) => isWorkItemRelationType(t.referenceName))
        .map((t) => {
          const seedMatch = SEED_LINK_TYPES.find((s) => s.referenceName === t.referenceName);
          return { referenceName: t.referenceName, name: t.name, semanticHint: seedMatch?.semanticHint };
        });
    } catch {
      // Live discovery failed (network, auth, or an ADO version that doesn't
      // expose this endpoint) — fall back to the seed catalog rather than
      // failing the whole job over a discovery call that isn't the write
      // itself. Matches resolveCustomerIdField's discover-then-fallback shape.
      return SEED_LINK_TYPES;
    }
  }
```

- [ ] **Step 6: Write the RealAdoBackend.discoverLinkTypes test**

Add to `mcp-ado-server/test/realAdo.test.ts`, after the `RealAdoBackend.discoverFields` describe
block:

```typescript
describe('RealAdoBackend.discoverLinkTypes', () => {
  it('GETs the workitemrelationtypes endpoint and maps to AdoLinkType, filtering out non-work-item types', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} }) // api-version probe
      .mockResolvedValueOnce({
        status: 200,
        data: {
          value: [
            { referenceName: 'System.LinkTypes.Affects-Forward', name: 'Affects' },
            { referenceName: 'Elisra.CoveredBy-Forward', name: 'Covered by' },
            { referenceName: 'Hyperlink', name: 'Hyperlink' },
          ],
        },
      });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.discoverLinkTypes();

    expect(result).toEqual([
      { referenceName: 'System.LinkTypes.Affects-Forward', name: 'Affects', semanticHint: expect.stringContaining('affects the target') },
      { referenceName: 'Elisra.CoveredBy-Forward', name: 'Covered by', semanticHint: undefined },
    ]);
  });

  it('falls back to the seed catalog when the live call fails', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} }) // api-version probe
      .mockRejectedValueOnce(new Error('network down'));
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.discoverLinkTypes();

    expect(result.length).toBeGreaterThan(0);
    expect(result.some((t) => t.referenceName === 'System.LinkTypes.Hierarchy-Reverse')).toBe(true);
  });
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd mcp-ado-server && npx vitest run test/realAdo.test.ts`
Expected: PASS (all existing tests plus the 2 new ones)

- [ ] **Step 8: Write the MCP tool + its test**

```typescript
// mcp-ado-server/src/tools/discoverLinkTypesTool.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';

/** Registers `ado_discover_link_types` — lists work-item link types available on this project. */
export function registerDiscoverLinkTypesTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_discover_link_types',
    {
      title: 'Discover ADO work-item link types',
      description:
        'Returns the work-item link types (referenceName/name/semanticHint) available on the ' +
        "target project's process template. Used to resolve trace/coverage link types " +
        '(Covers/CoveredBy/Affects/AffectedBy/etc.) at runtime instead of hardcoding them.',
      inputSchema: {},
    },
    async () => {
      const linkTypes = await backend.discoverLinkTypes();
      return { content: [{ type: 'text', text: JSON.stringify(linkTypes) }] };
    },
  );
}
```

```typescript
// mcp-ado-server/test/discoverLinkTypesTool.test.ts
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDiscoverLinkTypesTool } from '../src/tools/discoverLinkTypesTool';
import { MockAdoBackend } from '../src/backends/mockAdo';

describe('ado_discover_link_types tool', () => {
  it('registers without throwing', () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    expect(() => registerDiscoverLinkTypesTool(server, new MockAdoBackend(':memory:'))).not.toThrow();
  });
});
```

- [ ] **Step 9: Register the tool in `server.ts`**

Add the import near the other tool imports in `mcp-ado-server/src/server.ts`:

```typescript
import { registerDiscoverLinkTypesTool } from './tools/discoverLinkTypesTool.js';
```

Add the call in the `/mcp` POST handler, after `registerQueryIdsTool(mcpServer, backend);`:

```typescript
    registerDiscoverLinkTypesTool(mcpServer, backend);
```

- [ ] **Step 10: Run the full mcp-ado-server suite**

Run: `cd mcp-ado-server && npx vitest run`
Expected: PASS, all tests

- [ ] **Step 11: Commit**

```bash
git add mcp-ado-server/src/domain/adoLinkTypes.ts mcp-ado-server/src/backends/types.ts \
  mcp-ado-server/src/backends/mockAdo.ts mcp-ado-server/src/backends/realAdo.ts \
  mcp-ado-server/src/tools/discoverLinkTypesTool.ts mcp-ado-server/src/server.ts \
  mcp-ado-server/test/adoLinkTypes.test.ts mcp-ado-server/test/realAdo.test.ts \
  mcp-ado-server/test/discoverLinkTypesTool.test.ts
git commit -m "feat(mcp-ado-server): add ado_discover_link_types (live + seed fallback)"
```

---

## Task 2: MCP server — generic `linkWorkItems` primitive

**Files:**
- Modify: `mcp-ado-server/src/backends/types.ts`
- Modify: `mcp-ado-server/src/backends/mockAdo.ts`
- Modify: `mcp-ado-server/src/backends/realAdo.ts`
- Create: `mcp-ado-server/src/tools/linkWorkItemsTool.ts`
- Modify: `mcp-ado-server/src/server.ts`
- Test: `mcp-ado-server/test/realAdo.test.ts` (add `linkWorkItems` describe block)
- Test: `mcp-ado-server/test/linkWorkItemsTool.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (independent addition).
- Produces: `AdoBackend.linkWorkItems(fromId: number, toId: number, referenceName: string):
  Promise<void>`; MCP tool `ado_link_work_items` with input `{ fromId: number, toId: number,
  referenceName: string }`.

- [ ] **Step 1: Write the failing RealAdoBackend.linkWorkItems test**

Add to `mcp-ado-server/test/realAdo.test.ts`, after the `RealAdoBackend.linkParentChild` describe
block:

```typescript
describe('RealAdoBackend.linkWorkItems', () => {
  it('PATCHes a relation add op with the given referenceName onto the fromId work item', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    const patchSpy = vi.spyOn(httpClient, 'patch').mockResolvedValueOnce({ status: 200, data: {} });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.linkWorkItems(42, 7, 'Elisra.CoveredBy-Forward');

    expect(patchSpy.mock.calls[0][0]).toContain('/wit/workitems/42');
    expect(patchSpy.mock.calls[0][1]).toEqual([
      {
        op: 'add',
        path: '/relations/-',
        value: {
          rel: 'Elisra.CoveredBy-Forward',
          url: expect.stringContaining('/workItems/7'),
        },
      },
    ]);
  });

  it('retries on a 503 before succeeding', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    const patchSpy = vi
      .spyOn(httpClient, 'patch')
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce({ status: 200, data: {} });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.linkWorkItems(42, 7, 'System.LinkTypes.Related');
    expect(patchSpy).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-ado-server && npx vitest run test/realAdo.test.ts`
Expected: FAIL — `backend.linkWorkItems is not a function`

- [ ] **Step 3: Add `linkWorkItems` to the interface and both backends**

Add to `mcp-ado-server/src/backends/types.ts`, inside `AdoBackend` (after the existing
`linkParentChild` line — do not modify `linkParentChild` itself):

```typescript
  /**
   * Adds a relation of the given referenceName from fromId to toId. Generic
   * primitive behind Phase 4's trace/coverage links (Covers/CoveredBy/
   * Affects/AffectedBy/etc.) — linkParentChild remains separate and
   * unchanged for the hierarchy link.
   */
  linkWorkItems(fromId: number, toId: number, referenceName: string): Promise<void>;
```

Add to `mcp-ado-server/src/backends/mockAdo.ts`, after `linkParentChild`:

```typescript
  async linkWorkItems(_fromId: number, _toId: number, _referenceName: string): Promise<void> {
    // No-op: the mock's flat schema has no generic relations table (only
    // parent_id). Good enough to exercise the tool contract in tests; the
    // real backend is what actually needs to write the relation.
  }
```

Add to `mcp-ado-server/src/backends/realAdo.ts`, after `linkParentChild`:

```typescript
  async linkWorkItems(fromId: number, toId: number, referenceName: string): Promise<void> {
    const version = await this.getApiVersion();
    const url = `${this.credential.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems/${fromId}${versionQueryParam(version)}`;
    const toUrl = `${this.credential.orgUrl.replace(/\/$/, '')}/_apis/wit/workItems/${toId}`;
    await retryWithBackoff(() =>
      this.httpClient.patch(
        url,
        [{ op: 'add', path: '/relations/-', value: { rel: referenceName, url: toUrl } }],
        { headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json-patch+json' } },
      ),
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-ado-server && npx vitest run test/realAdo.test.ts`
Expected: PASS, all tests

- [ ] **Step 5: Write the MCP tool + its test**

```typescript
// mcp-ado-server/src/tools/linkWorkItemsTool.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';

export function registerLinkWorkItemsTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_link_work_items',
    {
      title: 'Link two work items with an arbitrary relation type',
      description:
        'Adds a relation of the given referenceName (e.g. a Covers/CoveredBy/Affects/' +
        'AffectedBy reference name from ado_discover_link_types) from fromId to toId.',
      inputSchema: { fromId: z.number(), toId: z.number(), referenceName: z.string() },
    },
    async ({ fromId, toId, referenceName }) => {
      await backend.linkWorkItems(fromId, toId, referenceName);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    },
  );
}
```

```typescript
// mcp-ado-server/test/linkWorkItemsTool.test.ts
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerLinkWorkItemsTool } from '../src/tools/linkWorkItemsTool';
import { MockAdoBackend } from '../src/backends/mockAdo';

describe('ado_link_work_items tool', () => {
  it('registers without throwing', () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    expect(() => registerLinkWorkItemsTool(server, new MockAdoBackend(':memory:'))).not.toThrow();
  });
});
```

- [ ] **Step 6: Register the tool in `server.ts`**

Add the import:

```typescript
import { registerLinkWorkItemsTool } from './tools/linkWorkItemsTool.js';
```

Add the call, after `registerDiscoverLinkTypesTool(mcpServer, backend);` (from Task 1):

```typescript
    registerLinkWorkItemsTool(mcpServer, backend);
```

- [ ] **Step 7: Run the full mcp-ado-server suite**

Run: `cd mcp-ado-server && npx vitest run`
Expected: PASS, all tests

- [ ] **Step 8: Commit**

```bash
git add mcp-ado-server/src/backends/types.ts mcp-ado-server/src/backends/mockAdo.ts \
  mcp-ado-server/src/backends/realAdo.ts mcp-ado-server/src/tools/linkWorkItemsTool.ts \
  mcp-ado-server/src/server.ts mcp-ado-server/test/realAdo.test.ts \
  mcp-ado-server/test/linkWorkItemsTool.test.ts
git commit -m "feat(mcp-ado-server): add generic linkWorkItems primitive + ado_link_work_items tool"
```

---

## Task 3: Orchestrator — McpClient methods

**Files:**
- Modify: `orchestrator/src/modules/pipeline/mcp.client.ts`
- Test: create `orchestrator/test/mcp.client.spec.ts` (none exists today — this is the first test
  file for this class; if the suite conventionally mocks the SDK `Client`, follow the pattern in
  any existing test that constructs `McpClient`; if none, test at the unit level by spying on
  `Client.prototype.callTool` via `vi`/`jest.spyOn`).

**Interfaces:**
- Consumes: MCP tools `ado_discover_link_types` and `ado_link_work_items` (Tasks 1-2).
- Produces: `McpClient.discoverLinkTypes(credential?: AdoRequestCredential): Promise<AdoLinkType[]>`;
  `McpClient.linkWorkItems(fromId: number, toId: number, referenceName: string, credential?:
  AdoRequestCredential): Promise<void>`, where `AdoLinkType = { referenceName: string; name:
  string; semanticHint?: string }` (mirrored locally in the orchestrator, not imported
  cross-package — `mcp-ado-server` and `orchestrator` are separate TS projects with no shared
  package today; do not add one for this).

- [ ] **Step 1: Write the failing test**

```typescript
// orchestrator/test/mcp.client.spec.ts
import { McpClient } from '../src/modules/pipeline/mcp.client';

describe('McpClient.linkWorkItems / discoverLinkTypes', () => {
  it('linkWorkItems calls ado_link_work_items with fromId/toId/referenceName', async () => {
    const client = new McpClient('http://mcp.test/mcp', 'test-bearer');
    const callTool = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
    jest.spyOn(client as any, 'withClient').mockImplementation(async (_cred: unknown, fn: any) =>
      fn({ callTool }),
    );

    await client.linkWorkItems(101, 100, 'Elisra.CoveredBy-Forward');

    expect(callTool).toHaveBeenCalledWith({
      name: 'ado_link_work_items',
      arguments: { fromId: 101, toId: 100, referenceName: 'Elisra.CoveredBy-Forward' },
    });
  });

  it('discoverLinkTypes calls ado_discover_link_types and parses the JSON array result', async () => {
    const client = new McpClient('http://mcp.test/mcp', 'test-bearer');
    const linkTypes = [{ referenceName: 'System.LinkTypes.Related', name: 'Related' }];
    const callTool = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(linkTypes) }] });
    jest.spyOn(client as any, 'withClient').mockImplementation(async (_cred: unknown, fn: any) =>
      fn({ callTool }),
    );

    const result = await client.discoverLinkTypes();

    expect(callTool).toHaveBeenCalledWith({ name: 'ado_discover_link_types', arguments: {} });
    expect(result).toEqual(linkTypes);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd orchestrator && npx jest test/mcp.client.spec.ts`
Expected: FAIL — `client.linkWorkItems is not a function`

- [ ] **Step 3: Implement the two methods**

Add to `orchestrator/src/modules/pipeline/mcp.client.ts`, after the existing `interface
AdoRequestCredential` block:

```typescript
export interface AdoLinkType {
  referenceName: string;
  name: string;
  semanticHint?: string;
}
```

Add inside the `McpClient` class, after `linkParentChild` (do not modify `linkParentChild`):

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd orchestrator && npx jest test/mcp.client.spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full orchestrator suite**

Run: `cd orchestrator && npx jest`
Expected: PASS, all tests (no existing test touches `mcp.client.ts`, so no regressions expected)

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/modules/pipeline/mcp.client.ts orchestrator/test/mcp.client.spec.ts
git commit -m "feat(orchestrator): add McpClient.linkWorkItems and discoverLinkTypes"
```

---

## Task 4: Orchestrator — TraceLink type + dry-run cross-job resolution

**Files:**
- Modify: `orchestrator/src/modules/writeback/dry-run.service.ts`
- Test: `orchestrator/test/dry-run.service.spec.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-3 directly (this task adds the shape and pure resolution logic;
  MCP wiring for the actual live query happens in Task 5).
- Produces:

```typescript
export interface TraceLink {
  sourceLocalId: string;
  referenceName: string;
  displayName: string;
  targetKind: 'intraJob' | 'crossJob';
  targetLocalId?: string;
  targetCustomerId?: string;
  resolvedAdoId?: number;
  resolutionStatus: 'resolved' | 'unresolved' | 'pending';
}
```

  `DryRunTreeNode.traceLinks?: TraceLink[]` (input, pre-resolution), `DryRunDiffEntry.traceLinks?:
  TraceLink[]` (output, cross-job entries resolved). New exported function:

```typescript
export async function resolveCrossJobTraceLinks(
  links: TraceLink[],
  queryByCustomerId: (customerId: string) => Promise<number[]>,
): Promise<TraceLink[]>
```

  (later consumed by Task 5's orchestrator wiring, which supplies the real `queryByCustomerId`
  backed by `McpClient.queryIds` — not built in this task).

- [ ] **Step 1: Write the failing test**

Add to `orchestrator/test/dry-run.service.spec.ts` (create the file if it doesn't exist yet — check
first with `ls orchestrator/test/dry-run.service.spec.ts`; the file exists per the earlier
exploration, so add to it):

```typescript
import { resolveCrossJobTraceLinks, type TraceLink } from '../src/modules/writeback/dry-run.service';

describe('resolveCrossJobTraceLinks', () => {
  it('resolves an intraJob link without calling the query function', async () => {
    const links: TraceLink[] = [
      { sourceLocalId: 'n1', referenceName: 'System.LinkTypes.Related', displayName: 'Related', targetKind: 'intraJob', targetLocalId: 'n0', resolutionStatus: 'pending' },
    ];
    const queryByCustomerId = jest.fn();

    const result = await resolveCrossJobTraceLinks(links, queryByCustomerId);

    expect(result).toEqual(links);
    expect(queryByCustomerId).not.toHaveBeenCalled();
  });

  it('resolves a crossJob link to the single matching ADO id', async () => {
    const links: TraceLink[] = [
      { sourceLocalId: 'n1', referenceName: 'Elisra.CoveredBy-Forward', displayName: 'Covers', targetKind: 'crossJob', targetCustomerId: 'REQ-SYS-012', resolutionStatus: 'pending' },
    ];
    const queryByCustomerId = jest.fn().mockResolvedValue([555]);

    const result = await resolveCrossJobTraceLinks(links, queryByCustomerId);

    expect(queryByCustomerId).toHaveBeenCalledWith('REQ-SYS-012');
    expect(result[0].resolvedAdoId).toBe(555);
    expect(result[0].resolutionStatus).toBe('resolved');
  });

  it('marks unresolved when no match or more than one match is found', async () => {
    const links: TraceLink[] = [
      { sourceLocalId: 'n1', referenceName: 'Elisra.CoveredBy-Forward', displayName: 'Covers', targetKind: 'crossJob', targetCustomerId: 'REQ-NONE', resolutionStatus: 'pending' },
      { sourceLocalId: 'n2', referenceName: 'Elisra.CoveredBy-Forward', displayName: 'Covers', targetKind: 'crossJob', targetCustomerId: 'REQ-DUP', resolutionStatus: 'pending' },
    ];
    const queryByCustomerId = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([1, 2]);

    const result = await resolveCrossJobTraceLinks(links, queryByCustomerId);

    expect(result[0].resolutionStatus).toBe('unresolved');
    expect(result[0].resolvedAdoId).toBeUndefined();
    expect(result[1].resolutionStatus).toBe('unresolved');
  });

  it('marks unresolved (never throws) when the query function itself rejects', async () => {
    const links: TraceLink[] = [
      { sourceLocalId: 'n1', referenceName: 'Elisra.CoveredBy-Forward', displayName: 'Covers', targetKind: 'crossJob', targetCustomerId: 'REQ-ERR', resolutionStatus: 'pending' },
    ];
    const queryByCustomerId = jest.fn().mockRejectedValue(new Error('mcp down'));

    const result = await resolveCrossJobTraceLinks(links, queryByCustomerId);

    expect(result[0].resolutionStatus).toBe('unresolved');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd orchestrator && npx jest test/dry-run.service.spec.ts`
Expected: FAIL — `resolveCrossJobTraceLinks` / `TraceLink` not exported

- [ ] **Step 3: Add the type and function to `dry-run.service.ts`**

Add near the top of `orchestrator/src/modules/writeback/dry-run.service.ts`, after the existing
`DryRunTreeNode` interface:

```typescript
export interface TraceLink {
  sourceLocalId: string;
  referenceName: string;
  displayName: string;
  targetKind: 'intraJob' | 'crossJob';
  targetLocalId?: string;
  targetCustomerId?: string;
  resolvedAdoId?: number;
  resolutionStatus: 'resolved' | 'unresolved' | 'pending';
}

/**
 * Resolves crossJob trace links (targets outside the current job's tree) to
 * a real ADO id via an exact customer-ID field match, at dry-run build time
 * — so the diff view can show resolution status before the user ever
 * confirms. intraJob links are left untouched here; they resolve during
 * confirm() once their sibling gets a real ADO id (see jobs.service.ts).
 * Per the project's "never block" philosophy: no match, more than one
 * match, or the query itself failing all become 'unresolved', never a
 * thrown error — an unresolved link just doesn't get written later.
 */
export async function resolveCrossJobTraceLinks(
  links: TraceLink[],
  queryByCustomerId: (customerId: string) => Promise<number[]>,
): Promise<TraceLink[]> {
  const results: TraceLink[] = [];
  for (const link of links) {
    if (link.targetKind !== 'crossJob' || link.targetCustomerId === undefined) {
      results.push(link);
      continue;
    }
    try {
      const ids = await queryByCustomerId(link.targetCustomerId);
      if (ids.length === 1) {
        results.push({ ...link, resolvedAdoId: ids[0], resolutionStatus: 'resolved' });
      } else {
        results.push({ ...link, resolutionStatus: 'unresolved' });
      }
    } catch {
      results.push({ ...link, resolutionStatus: 'unresolved' });
    }
  }
  return results;
}
```

Add `traceLinks?: TraceLink[];` to both `DryRunTreeNode` (end of the interface) and
`DryRunDiffEntry` (end of the interface).

- [ ] **Step 4: Wire `traceLinks` through `DryRunService.diff()`**

In `DryRunService.diff()`, each of the three `results.push({...})` call sites (reuse, dedup_skip,
create) needs `traceLinks: node.traceLinks ?? []` added to the pushed object literal. Example for
the `create` branch (apply the same addition to the other two):

```typescript
      results.push({
        localId: node.localId, parentLocalId: node.parentLocalId, type: node.type,
        title: node.title, description: node.description, action: 'create',
        existingAdoId: null, similarity: null, sourceHash: node.sourceHash, customerId: node.customerId,
        tags: node.tags, qualityScore: node.qualityScore, qualityIssues: node.qualityIssues,
        childType: node.childType, traceLinks: node.traceLinks ?? [],
      });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd orchestrator && npx jest test/dry-run.service.spec.ts`
Expected: PASS, all tests (new + existing — existing `diff()` tests must still pass since
`traceLinks` defaults to `[]` when absent from input nodes)

- [ ] **Step 6: Run the full orchestrator suite**

Run: `cd orchestrator && npx jest`
Expected: PASS, all tests

- [ ] **Step 7: Commit**

```bash
git add orchestrator/src/modules/writeback/dry-run.service.ts orchestrator/test/dry-run.service.spec.ts
git commit -m "feat(orchestrator): add TraceLink type and crossJob resolution to dry-run diff"
```

---

## Task 5: Orchestrator — confirm-time link writes + per-job catalog caching

**Files:**
- Modify: `orchestrator/src/modules/pipeline/jobs.service.ts`
- Modify: `orchestrator/src/modules/pipeline/pipeline.worker.ts`
- Test: `orchestrator/test/jobs.service.spec.ts`

**Interfaces:**
- Consumes: `McpClient.linkWorkItems`, `McpClient.discoverLinkTypes` (Task 3); `TraceLink`,
  `resolveCrossJobTraceLinks` (Task 4); `McpClient.queryIds` (already exists, unchanged signature —
  confirmed at `mcp.client.ts` — wait, `queryIds` is not currently exposed on `McpClient`; add it
  now, mirroring `discoverFields`'s shape, since Task 4's `resolveCrossJobTraceLinks` needs a
  `queryByCustomerId` callback backed by the real `ado_query_ids` tool).
- Produces: `jobs.service.ts confirm()` writes trace links after the parent-child linking loop;
  `pipeline.worker.ts` discovers the link-type catalog once per job and threads it into
  `ingestionClient.level()`.

- [ ] **Step 1: Add `McpClient.queryIds` (missing piece needed by this task)**

Add to `orchestrator/test/mcp.client.spec.ts` (from Task 3):

```typescript
describe('McpClient.queryIds', () => {
  it('calls ado_query_ids with the field-match map and parses the JSON id array', async () => {
    const client = new McpClient('http://mcp.test/mcp', 'test-bearer');
    const callTool = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: '[1,2]' }] });
    jest.spyOn(client as any, 'withClient').mockImplementation(async (_cred: unknown, fn: any) =>
      fn({ callTool }),
    );

    const result = await client.queryIds({ 'Custom.CustomerId': 'REQ-SYS-012' });

    expect(callTool).toHaveBeenCalledWith({
      name: 'ado_query_ids',
      arguments: { fieldMatch: { 'Custom.CustomerId': 'REQ-SYS-012' } },
    });
    expect(result).toEqual([1, 2]);
  });
});
```

Run: `cd orchestrator && npx jest test/mcp.client.spec.ts` — Expected: FAIL (`queryIds` not a
function).

Add to `orchestrator/src/modules/pipeline/mcp.client.ts`, after `discoverLinkTypes`:

```typescript
  async queryIds(fieldMatch: Record<string, string>, credential?: AdoRequestCredential): Promise<number[]> {
    return this.withClient(credential, async (client) => {
      const result = await client.callTool({ name: 'ado_query_ids', arguments: { fieldMatch } });
      return this.parseToolTextResult(result as any);
    });
  }
```

Run: `cd orchestrator && npx jest test/mcp.client.spec.ts` — Expected: PASS.

- [ ] **Step 2: Write the failing confirm() test for intraJob trace-link writes**

Add to `orchestrator/test/jobs.service.spec.ts`, in a new `describe` block after
`JobsService.confirm — exclusion`:

```typescript
describe('JobsService.confirm — trace links', () => {
  it('writes a resolved intraJob trace link after both endpoints have real ADO ids', async () => {
    const createWorkItem = jest.fn()
      .mockResolvedValueOnce({ id: 100 }) // n0
      .mockResolvedValueOnce({ id: 101 }); // n1
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const linkWorkItems = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Sys Req', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, traceLinks: [] },
            {
              localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Cust Req', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null,
              traceLinks: [
                { sourceLocalId: 'n1', referenceName: 'Elisra.CoveredBy-Reverse', displayName: 'Covers', targetKind: 'intraJob', targetLocalId: 'n0', resolutionStatus: 'pending' },
              ],
            },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, linkWorkItems } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntry: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(linkWorkItems).toHaveBeenCalledWith(101, 100, 'Elisra.CoveredBy-Reverse', undefined);
  });

  it('skips writing an unresolved trace link without failing confirm', async () => {
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 100 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const linkWorkItems = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', areaPath: 'Project\\Area1',
          dryRunDiff: [
            {
              localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Req', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null,
              traceLinks: [
                { sourceLocalId: 'n0', referenceName: 'Elisra.CoveredBy-Forward', displayName: 'Covered by', targetKind: 'crossJob', targetCustomerId: 'REQ-MISSING', resolutionStatus: 'unresolved' },
              ],
            },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, linkWorkItems } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntry: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1');

    expect(result).toEqual({ status: 'succeeded', createdCount: 1 });
    expect(linkWorkItems).not.toHaveBeenCalled();
  });

  it('writes an already-resolved crossJob trace link using its resolvedAdoId', async () => {
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 100 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const linkWorkItems = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', areaPath: 'Project\\Area1',
          dryRunDiff: [
            {
              localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Req', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null,
              traceLinks: [
                { sourceLocalId: 'n0', referenceName: 'System.LinkTypes.Affects-Forward', displayName: 'Affects', targetKind: 'crossJob', targetCustomerId: 'REQ-SYS-012', resolvedAdoId: 555, resolutionStatus: 'resolved' },
              ],
            },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, linkWorkItems } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntry: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(linkWorkItems).toHaveBeenCalledWith(100, 555, 'System.LinkTypes.Affects-Forward', undefined);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd orchestrator && npx jest test/jobs.service.spec.ts`
Expected: FAIL — `linkWorkItems` never called (trace-link writing doesn't exist yet)

- [ ] **Step 4: Implement trace-link writing in `confirm()`**

In `orchestrator/src/modules/pipeline/jobs.service.ts`, widen the local `diff` type annotation
inside `confirm()` to include `traceLinks` (add to the type literal right after `tags?:
string[];`):

```typescript
      traceLinks?: {
        sourceLocalId: string;
        referenceName: string;
        targetKind: 'intraJob' | 'crossJob';
        targetLocalId?: string;
        targetCustomerId?: string;
        resolvedAdoId?: number;
        resolutionStatus: 'resolved' | 'unresolved' | 'pending';
      }[];
```

Add a third loop after the existing parent-child linking loop (after the closing brace of the `for
(const entry of diff) { if (entry.parentLocalId === null) continue; ... }` block, before
`await this.prisma.job.update(...)`):

```typescript
    // Trace-link writes fire last, once every entry in this confirm() call
    // has a real ADO id in adoIdByLocalId — same ordering guarantee the
    // parent-child loop above relies on. Unresolved links (bad customer id,
    // or a targetLocalId that isn't in this diff — e.g. its subtree was
    // excluded) are skipped, never thrown: per the project's "never block"
    // philosophy, a broken trace link must not fail the whole confirm.
    for (const entry of diff) {
      if (isExcluded(entry)) continue;
      for (const link of entry.traceLinks ?? []) {
        const sourceAdoId = adoIdByLocalId.get(link.sourceLocalId);
        if (sourceAdoId === undefined) continue;
        let targetAdoId: number | undefined;
        if (link.targetKind === 'intraJob' && link.targetLocalId) {
          targetAdoId = adoIdByLocalId.get(link.targetLocalId);
        } else if (link.targetKind === 'crossJob' && link.resolutionStatus === 'resolved') {
          targetAdoId = link.resolvedAdoId;
        }
        if (targetAdoId === undefined) continue;
        await this.mcpClient.linkWorkItems(sourceAdoId, targetAdoId, link.referenceName, credential);
      }
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd orchestrator && npx jest test/jobs.service.spec.ts`
Expected: PASS, all tests (new + existing)

- [ ] **Step 6: Wire per-job catalog discovery into `pipeline.worker.ts`**

Add to `orchestrator/src/modules/pipeline/pipeline.worker.ts`, in `PipelineWorkerDeps` (after
`jobEventsPublisher: JobEventsPublisher;`):

```typescript
  mcpClient: McpClient;
```

Add the import at the top:

```typescript
import type { McpClient } from './mcp.client';
```

In `runPipelineJob`, before the existing `const tree = (await deps.ingestionClient.level(...))`
call, discover the catalog once and pass it through:

```typescript
    // Discovered once per job (not per node/link) — mirrors
    // resolveCustomerIdField's per-confirm-call caching shape in
    // jobs.service.ts. Real ADO backends fall back to a seed catalog on
    // failure (mcp-ado-server's discoverLinkTypes); this call itself never
    // throws in practice, but if it somehow did, an empty catalog is the
    // correct degraded behavior — infer_trace_links just gets nothing to
    // choose from and every node's trace_links stays empty, never blocking
    // the rest of the job.
    let linkTypeCatalog: { referenceName: string; name: string; semanticHint?: string }[] = [];
    try {
      linkTypeCatalog = await deps.mcpClient.discoverLinkTypes();
    } catch {
      linkTypeCatalog = [];
    }
```

Change the `deps.ingestionClient.level(doc, job.customerId, job.mode, job.areaPath)` call to also
pass `linkTypeCatalog` (this requires extending `IngestionHttpClient.level`'s signature — done in
Task 8, which this task depends on being sequenced after; for now, add the parameter here so the
compile error surfaces and Task 8 resolves it):

```typescript
    const tree = (await deps.ingestionClient.level(doc, job.customerId, job.mode, job.areaPath, linkTypeCatalog)) as {
      nodes: LeveledNode[];
      kb_citations?: string[];
    };
```

Also update `LeveledNode` to carry `trace_links` through (needed regardless of Task 8's endpoint
change, since this file already destructures `tree.nodes`):

```typescript
interface LeveledTraceLink {
  source_local_id: string;
  reference_name: string;
  display_name: string;
  target_kind: 'intraJob' | 'crossJob';
  target_local_id?: string;
  target_customer_id?: string;
  resolution_status: 'resolved' | 'unresolved' | 'pending';
}
```

Add `trace_links?: LeveledTraceLink[];` to the top-level tree type used at the `level()` call site
(the inline type literal `{ nodes: LeveledNode[]; kb_citations?: string[] }` becomes `{ nodes:
LeveledNode[]; kb_citations?: string[]; trace_links?: LeveledTraceLink[] }`).

Map `tree.trace_links` into per-node `traceLinks` on `diffInputs` — trace links are tree-level in
ingestion's model (see Task 6) but need to live on the *source* node for `DryRunService.diff()`'s
existing per-node loop (Task 4). Change the `diffInputs` construction:

```typescript
    const traceLinksByLocalId = new Map<string, DryRunTreeNode['traceLinks']>();
    for (const link of tree.trace_links ?? []) {
      const existing = traceLinksByLocalId.get(link.source_local_id) ?? [];
      existing.push({
        sourceLocalId: link.source_local_id,
        referenceName: link.reference_name,
        displayName: link.display_name,
        targetKind: link.target_kind,
        targetLocalId: link.target_local_id,
        targetCustomerId: link.target_customer_id,
        resolutionStatus: link.resolution_status,
      });
      traceLinksByLocalId.set(link.source_local_id, existing);
    }

    const diffInputs: DryRunTreeNode[] = tree.nodes.map((node) => ({
      localId: node.local_id,
      parentLocalId: node.parent_local_id,
      type: node.type,
      title: node.title,
      description: node.description,
      sourceHash: node.fidelity_hash,
      customerId: node.customer_id,
      areaPath: job.areaPath,
      tags: node.tags ?? [],
      qualityScore: node.quality_score,
      qualityIssues: node.quality_issues,
      childType: node.child_type,
      traceLinks: traceLinksByLocalId.get(node.local_id) ?? [],
    }));
```

Import `DryRunTreeNode`'s `traceLinks` field type is already covered since `DryRunTreeNode` itself
gained `traceLinks?: TraceLink[]` in Task 4 — no separate import needed beyond the existing
`import type { DryRunService, DryRunTreeNode } from '../writeback/dry-run.service';`.

After building `diff` (the existing `deps.dryRunService.diff(...)` call), resolve crossJob links
before persisting, using `McpClient.queryIds` scoped to the discovered Customer ID field. This
requires resolving the field name first — reuse the same candidate-list approach as
`resolveCustomerIdField`, but `pipeline.worker.ts` has no access to `JobsService`'s private method.
Add a small local resolver here (duplication of the 3-candidate list is acceptable — it is a
3-line array literal, not worth extracting a shared module for two call sites per YAGNI):

```typescript
    const customerIdFieldCandidates = ['Custom.CustomerId', 'Custom.CustomerRequirementId', 'Custom.CustomerID'];
    // Cross-job trace-link targets are always Requirement-type items in
    // practice (System/Customer requirement pairs — the driving use case),
    // so a single discoverFields('Requirement') call is enough; if this
    // assumption stops holding, thread the actual target type through
    // instead of hardcoding it here.
    let resolvedCustomerIdField: string | null = null;
    if ((tree.trace_links ?? []).some((l) => l.target_kind === 'crossJob')) {
      const availableFields = await deps.mcpClient.discoverFields('Requirement').catch(() => [] as string[]);
      resolvedCustomerIdField =
        customerIdFieldCandidates.find((candidate) => availableFields.includes(candidate)) ?? null;
    }

    const diff = await deps.dryRunService.diff(
      diffInputs,
      deps.idempotencyService,
      (text, areaPath) => deps.ingestionClient.checkDuplicate(text, areaPath),
    );

    const resolvedDiff =
      resolvedCustomerIdField !== null
        ? await Promise.all(
            diff.map(async (entry) => ({
              ...entry,
              traceLinks: entry.traceLinks
                ? await resolveCrossJobTraceLinks(entry.traceLinks, async (customerId) =>
                    deps.mcpClient.queryIds({ [resolvedCustomerIdField as string]: customerId }),
                  )
                : entry.traceLinks,
            })),
          )
        : diff;
```

Replace the later `dryRunDiff: diff as any` in the `deps.prisma.job.update(...)` call with
`dryRunDiff: resolvedDiff as any`, and the `diff.length` / `diff.filter(...)` references in the
audit-entry message with `resolvedDiff.length` / `resolvedDiff.filter(...)`, and the function's
`return diff;` with `return resolvedDiff;`.

Add the import for `resolveCrossJobTraceLinks` at the top of `pipeline.worker.ts`:

```typescript
import { resolveCrossJobTraceLinks } from '../writeback/dry-run.service';
```

Wherever `PipelineWorkerDeps` is constructed (the worker's bootstrap file — locate it via `grep -n
"PipelineWorkerDeps" orchestrator/src -r` and pass the already-constructed `McpClient` instance
into the `mcpClient` field), add `mcpClient` to the object literal.

- [ ] **Step 7: Run the full orchestrator suite**

Run: `cd orchestrator && npx jest`
Expected: PASS, all tests. If `pipeline.worker.ts` has its own existing test file (check with `ls
orchestrator/test/pipeline.worker*`), its mocked `deps` object must gain a `mcpClient:
{ discoverLinkTypes: jest.fn().mockResolvedValue([]), discoverFields: jest.fn().mockResolvedValue([]),
queryIds: jest.fn().mockResolvedValue([]) }` stub or the test will fail on the new calls — update
that test file's fixture accordingly before re-running.

- [ ] **Step 8: Commit**

```bash
git add orchestrator/src/modules/pipeline/jobs.service.ts orchestrator/src/modules/pipeline/pipeline.worker.ts \
  orchestrator/src/modules/pipeline/mcp.client.ts orchestrator/test/jobs.service.spec.ts \
  orchestrator/test/mcp.client.spec.ts
git commit -m "feat(orchestrator): write trace links at confirm, discover+resolve catalog per job"
```

---

## Task 6: Ingestion — `TraceLink` Pydantic model

**Files:**
- Modify: `ingestion/app/workitem/model.py`
- Test: `ingestion/tests/test_workitem_model.py` (create if it doesn't exist — check with `ls
  ingestion/tests/test_workitem_model.py` first; if absent, create it fresh following this repo's
  existing pytest style, e.g. `ingestion/tests/test_llm_leveling.py`'s plain-function-per-test
  layout).

**Interfaces:**
- Produces:

```python
class TraceLinkTargetKind(str, Enum):
    INTRA_JOB = "intraJob"
    CROSS_JOB = "crossJob"


class TraceLinkResolutionStatus(str, Enum):
    RESOLVED = "resolved"
    UNRESOLVED = "unresolved"
    PENDING = "pending"


class TraceLink(BaseModel):
    source_local_id: str
    reference_name: str
    display_name: str
    target_kind: TraceLinkTargetKind
    target_local_id: str | None = None
    target_customer_id: str | None = None
    resolution_status: TraceLinkResolutionStatus


class WorkItemTree.trace_links: list[TraceLink]
```

- [ ] **Step 1: Write the failing test**

```python
# ingestion/tests/test_workitem_model.py
from app.workitem.model import TraceLink, TraceLinkResolutionStatus, TraceLinkTargetKind, WorkItemTree


def test_trace_link_requires_target_kind() -> None:
    link = TraceLink(
        source_local_id="0",
        reference_name="System.LinkTypes.Related",
        display_name="Related",
        target_kind=TraceLinkTargetKind.INTRA_JOB,
        target_local_id="1",
        resolution_status=TraceLinkResolutionStatus.PENDING,
    )
    assert link.target_kind == "intraJob"
    assert link.resolution_status == "pending"


def test_work_item_tree_defaults_trace_links_to_empty_list() -> None:
    tree = WorkItemTree()
    assert tree.trace_links == []


def test_work_item_tree_accepts_trace_links() -> None:
    link = TraceLink(
        source_local_id="0",
        reference_name="Elisra.CoveredBy-Forward",
        display_name="Covered by",
        target_kind=TraceLinkTargetKind.CROSS_JOB,
        target_customer_id="REQ-SYS-012",
        resolution_status=TraceLinkResolutionStatus.PENDING,
    )
    tree = WorkItemTree(trace_links=[link])
    assert tree.trace_links[0].target_customer_id == "REQ-SYS-012"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ingestion && python -m pytest tests/test_workitem_model.py -v`
Expected: FAIL — `ImportError: cannot import name 'TraceLink'`

- [ ] **Step 3: Add the models to `ingestion/app/workitem/model.py`**

Add after the `RequirementQualityIssue` class and before `WorkItemNode`:

```python
class TraceLinkTargetKind(str, Enum):
    INTRA_JOB = "intraJob"
    CROSS_JOB = "crossJob"


class TraceLinkResolutionStatus(str, Enum):
    RESOLVED = "resolved"
    UNRESOLVED = "unresolved"
    PENDING = "pending"


class TraceLink(BaseModel):
    """One trace/coverage link inferred by SURVEY's infer_trace_links call
    (see llm_leveling.py). Lives on WorkItemTree, not per-node — mirrors
    kb_citations — since most nodes carry zero links and a per-node field
    would churn every node's schema for a feature most won't use."""

    source_local_id: str
    reference_name: str
    display_name: str
    target_kind: TraceLinkTargetKind
    target_local_id: str | None = None
    target_customer_id: str | None = None
    resolution_status: TraceLinkResolutionStatus
```

Add `trace_links: list[TraceLink] = Field(default_factory=list)` as a new field on `WorkItemTree`,
after `kb_citations`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ingestion && python -m pytest tests/test_workitem_model.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full ingestion suite**

Run: `cd ingestion && python -m pytest`
Expected: PASS, all tests (adding a field with a default cannot break any existing
`WorkItemTree(...)` construction)

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/workitem/model.py ingestion/tests/test_workitem_model.py
git commit -m "feat(ingestion): add TraceLink model and WorkItemTree.trace_links field"
```

---

## Task 7: Ingestion — `infer_trace_links` LLM call

**Files:**
- Modify: `ingestion/app/survey/orchestrator_llm_client.py`
- Test: `ingestion/tests/test_orchestrator_llm_client.py`

**Interfaces:**
- Consumes: nothing new from earlier tasks (pure addition to the LLM client).
- Produces:

```python
def infer_trace_links(
    self,
    nodes: list[dict],  # [{"node_id": str, "type": str, "title": str, "text": str}, ...]
    link_type_catalog: list[dict],  # [{"reference_name": str, "name": str, "semantic_hint": str | None}, ...]
    kb_context: str | None = None,
) -> list[dict]:  # [{"source_node_id": str, "target_ref": str, "reference_name": str}, ...]
```

  (`OrchestratorLlmClient.infer_trace_links`, satisfying a new `TraceLinkInferenceClient` Protocol
  defined in Task 8's `llm_leveling.py` — this task only builds the real client method + its own
  unit test against a fake HTTP transport, following the exact pattern of the existing
  `infer_hierarchy` tests in this same file.)

- [ ] **Step 1: Write the failing test**

Check the existing test file's transport-injection pattern first:

```bash
grep -n "def test_infer_hierarchy\|_transport\|httpx.MockTransport" ingestion/tests/test_orchestrator_llm_client.py | head -20
```

Add a test mirroring whatever `infer_hierarchy`'s test looks like (same fake-transport style —
inspect the grep output above before writing this test, and match its exact mocking mechanism
rather than inventing a new one). The test body:

```python
def test_infer_trace_links_sends_nodes_and_catalog_returns_parsed_links() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        system_prompt = body["messages"][0]["content"]
        assert "Elisra.CoveredBy-Forward" in system_prompt
        return httpx.Response(
            200,
            json={
                "content": json.dumps(
                    [{"source_node_id": "1", "target_ref": "0", "reference_name": "Elisra.CoveredBy-Forward"}]
                )
            },
        )

    client = OrchestratorLlmClient("http://orchestrator.test", "test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.infer_trace_links(
        nodes=[
            {"node_id": "0", "type": "Requirement", "title": "Sys Req", "text": "The system shall X."},
            {"node_id": "1", "type": "Requirement", "title": "Cust Req", "text": "The customer requires X."},
        ],
        link_type_catalog=[
            {"reference_name": "Elisra.CoveredBy-Forward", "name": "Covered by", "semantic_hint": "system req covers customer req"},
        ],
    )

    assert result == [{"source_node_id": "1", "target_ref": "0", "reference_name": "Elisra.CoveredBy-Forward"}]


def test_infer_trace_links_raises_on_malformed_json() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"content": "not json"})

    client = OrchestratorLlmClient("http://orchestrator.test", "test-bearer")
    client._transport = httpx.MockTransport(handler)

    with pytest.raises(ValueError, match="malformed JSON"):
        client.infer_trace_links(nodes=[], link_type_catalog=[])


def test_infer_trace_links_with_no_catalog_still_sends_a_valid_request() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["messages"][1]["content"]  # user content present
        return httpx.Response(200, json={"content": "[]"})

    client = OrchestratorLlmClient("http://orchestrator.test", "test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.infer_trace_links(nodes=[{"node_id": "0", "type": "Requirement", "title": "T", "text": "X"}], link_type_catalog=[])
    assert result == []
```

(If `pytest`/`httpx` aren't already imported at the top of the test file, they are — this file
already exercises `infer_hierarchy` the same way, per the existing tests found via the grep in
Step 1 above; add `import pytest` only if it's missing.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ingestion && python -m pytest tests/test_orchestrator_llm_client.py -v -k infer_trace_links`
Expected: FAIL — `AttributeError: 'OrchestratorLlmClient' object has no attribute 'infer_trace_links'`

- [ ] **Step 3: Implement `infer_trace_links`**

Add to `ingestion/app/survey/orchestrator_llm_client.py`, as a new method on `OrchestratorLlmClient`
(after `infer_hierarchy`):

```python
    def infer_trace_links(
        self,
        nodes: list[dict],
        link_type_catalog: list[dict],
        kb_context: str | None = None,
    ) -> list[dict]:
        catalog_lines = "\n".join(
            f"- {entry['reference_name']} (\"{entry['name']}\")"
            + (f": {entry['semantic_hint']}" if entry.get("semantic_hint") else "")
            for entry in link_type_catalog
        )
        nodes_json = json.dumps(nodes)
        system_prompt = (
            "You infer trace/coverage links between work items in a requirements tree — "
            "the most common case is a System Requirement covering/tracing a Customer "
            "Requirement, but use your judgment on the actual relationship implied by the "
            "text. You are given a JSON array of nodes, each with 'node_id', 'type', "
            "'title', and 'text'. You may propose zero or more links. For each link, "
            "choose EXACTLY ONE reference_name from this list — never invent one, and "
            "omit the link entirely if none genuinely fits:\n\n"
            f"{catalog_lines}\n\n"
            "Return ONLY a JSON array of objects, each with 'source_node_id' (the node_id "
            "the link is on), 'target_ref' (the node_id of the OTHER node in this array, "
            "if the target is one of them), and 'reference_name' (one of the reference "
            "names listed above). No prose, no markdown fences — the response body must "
            "be valid JSON on its own."
        )
        system_prompt = _with_kb_context(system_prompt, kb_context)
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": nodes_json},
            ],
            "temperature": 0,
        }
        with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        try:
            return json.loads(content)
        except json.JSONDecodeError as exc:
            raise ValueError(f"malformed JSON in LLM response content: {content!r}") from exc
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ingestion && python -m pytest tests/test_orchestrator_llm_client.py -v -k infer_trace_links`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full ingestion suite**

Run: `cd ingestion && python -m pytest`
Expected: PASS, all tests

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/survey/orchestrator_llm_client.py ingestion/tests/test_orchestrator_llm_client.py
git commit -m "feat(ingestion): add OrchestratorLlmClient.infer_trace_links"
```

---

## Task 8: Ingestion — wire `infer_trace_links` into `build_survey_tree` + `/level`

**Files:**
- Modify: `ingestion/app/leveling/llm_leveling.py`
- Modify: `ingestion/app/main.py`
- Test: `ingestion/tests/test_llm_leveling.py`
- Test: `ingestion/tests/test_level_endpoint.py`

**Interfaces:**
- Consumes: `TraceLink`, `TraceLinkTargetKind`, `TraceLinkResolutionStatus` (Task 6);
  `OrchestratorLlmClient.infer_trace_links` (Task 7, satisfying a new `TraceLinkInferenceClient`
  Protocol this task defines); `linkTypeCatalog` arriving from the orchestrator (Task 5) via
  `/level`'s new optional request field.
- Produces: `build_survey_tree(..., link_type_client: TraceLinkInferenceClient | None = None,
  link_type_catalog: list[dict] | None = None)` populates `WorkItemTree.trace_links`; `POST /level`
  accepts an optional `link_type_catalog` field and threads it through when `mode == "survey"`.

- [ ] **Step 1: Write the failing `build_survey_tree` test**

Add to `ingestion/tests/test_llm_leveling.py`, after the existing `FakeBatchedScoringClient` class
and its tests (follow that class's exact style — constructor takes an optional override, records
calls in `self.calls`):

```python
class FakeTraceLinkInferenceClient:
    """Hand-written test double for infer_trace_links — proves build_survey_tree
    calls it exactly once per document (whole-tree, not per-node), and that
    the discovered catalog is passed through unchanged."""

    def __init__(self, results: list[dict] | None = None) -> None:
        self._results = results if results is not None else []
        self.calls: list[dict] = []

    def infer_trace_links(self, nodes: list[dict], link_type_catalog: list[dict], kb_context: str | None = None) -> list[dict]:
        self.calls.append({"nodes": nodes, "link_type_catalog": link_type_catalog, "kb_context": kb_context})
        return self._results


def test_build_survey_tree_without_link_type_client_leaves_trace_links_empty() -> None:
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient())
    assert tree.trace_links == []


def test_build_survey_tree_calls_infer_trace_links_exactly_once_with_the_catalog() -> None:
    fake_client = FakeTraceLinkInferenceClient()
    catalog = [{"reference_name": "System.LinkTypes.Related", "name": "Related", "semantic_hint": None}]
    build_survey_tree(
        _small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(),
        link_type_client=fake_client, link_type_catalog=catalog,
    )
    assert len(fake_client.calls) == 1
    assert fake_client.calls[0]["link_type_catalog"] == catalog


def test_build_survey_tree_resolves_intra_job_link_target() -> None:
    fake_client = FakeTraceLinkInferenceClient(
        results=[{"source_node_id": "1", "target_ref": "0", "reference_name": "System.LinkTypes.Related"}]
    )
    tree = build_survey_tree(
        _small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(),
        link_type_client=fake_client, link_type_catalog=[],
    )
    assert len(tree.trace_links) == 1
    link = tree.trace_links[0]
    assert link.source_local_id == "1"
    assert link.target_kind == "intraJob"
    assert link.target_local_id == "0"
    assert link.resolution_status == "pending"


def test_build_survey_tree_treats_a_non_node_id_target_ref_as_cross_job_customer_id() -> None:
    fake_client = FakeTraceLinkInferenceClient(
        results=[{"source_node_id": "1", "target_ref": "REQ-SYS-012", "reference_name": "Elisra.CoveredBy-Reverse"}]
    )
    tree = build_survey_tree(
        _small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(),
        link_type_client=fake_client, link_type_catalog=[],
    )
    link = tree.trace_links[0]
    assert link.target_kind == "crossJob"
    assert link.target_customer_id == "REQ-SYS-012"
    assert link.target_local_id is None


def test_build_survey_tree_drops_a_link_with_a_reference_name_not_in_the_catalog() -> None:
    fake_client = FakeTraceLinkInferenceClient(
        results=[
            {"source_node_id": "1", "target_ref": "0", "reference_name": "Hallucinated.NotReal"},
            {"source_node_id": "1", "target_ref": "0", "reference_name": "System.LinkTypes.Related"},
        ]
    )
    catalog = [{"reference_name": "System.LinkTypes.Related", "name": "Related", "semantic_hint": None}]
    tree = build_survey_tree(
        _small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(),
        link_type_client=fake_client, link_type_catalog=catalog,
    )
    assert len(tree.trace_links) == 1
    assert tree.trace_links[0].reference_name == "System.LinkTypes.Related"


def test_build_survey_tree_drops_a_link_whose_source_node_id_does_not_exist() -> None:
    fake_client = FakeTraceLinkInferenceClient(
        results=[{"source_node_id": "does-not-exist", "target_ref": "0", "reference_name": "System.LinkTypes.Related"}]
    )
    tree = build_survey_tree(
        _small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(),
        link_type_client=fake_client, link_type_catalog=[{"reference_name": "System.LinkTypes.Related", "name": "Related"}],
    )
    assert tree.trace_links == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ingestion && python -m pytest tests/test_llm_leveling.py -v -k trace_link`
Expected: FAIL — `build_survey_tree() got an unexpected keyword argument 'link_type_client'`

- [ ] **Step 3: Implement the wiring in `llm_leveling.py`**

Add the import at the top:

```python
from app.workitem.model import (
    RequirementQualityIssue,
    RequirementTag,
    TraceLink,
    TraceLinkResolutionStatus,
    TraceLinkTargetKind,
    WorkItemMode,
    WorkItemNode,
    WorkItemTree,
    WorkItemType,
)
```

Add a new Protocol after `BatchedScoringClient`:

```python
class TraceLinkInferenceClient(Protocol):
    """Interface for SURVEY-mode trace/coverage link inference — one call
    covering every node (whole-tree), mirroring BatchedRequirementClient's
    one-call-per-document rationale. Given the full node list and a
    discovered ADO link-type catalog, proposes zero or more links; anything
    the model returns with a reference_name outside the supplied catalog is
    dropped by build_survey_tree, never trusted blind."""

    def infer_trace_links(
        self, nodes: list[dict], link_type_catalog: list[dict], kb_context: str | None = None
    ) -> list[dict]: ...
```

Change `build_survey_tree`'s signature to add two new optional parameters (after
`scoring_client`):

```python
def build_survey_tree(
    doc: CanonicalDoc,
    llm_client: LlmLevelingClient,
    requirement_client: BatchedRequirementClient,
    area_path: str | None = None,
    embed_client: object | None = None,
    vector_store: KbVectorStore | None = None,
    scoring_client: BatchedScoringClient | None = None,
    link_type_client: TraceLinkInferenceClient | None = None,
    link_type_catalog: list[dict] | None = None,
) -> WorkItemTree:
```

Add a `trace_links` computation block right before the final `return WorkItemTree(...)` line,
replacing that line:

```python
    trace_links: list[TraceLink] = []
    if link_type_client is not None:
        catalog = link_type_catalog or []
        valid_reference_names = {entry["reference_name"] for entry in catalog}
        node_by_local_id = {node.local_id: node for node in nodes}
        llm_nodes = [
            {"node_id": node.local_id, "type": node.type.value, "title": node.title, "text": node.description}
            for node in nodes
        ]
        raw_links = link_type_client.infer_trace_links(llm_nodes, catalog, kb_context=kb_context)
        catalog_by_ref = {entry["reference_name"]: entry.get("name", entry["reference_name"]) for entry in catalog}
        for raw_link in raw_links:
            source_node_id = raw_link.get("source_node_id")
            reference_name = raw_link.get("reference_name")
            target_ref = raw_link.get("target_ref")
            if source_node_id not in node_by_local_id:
                continue
            if reference_name not in valid_reference_names:
                continue
            if target_ref in node_by_local_id:
                trace_links.append(
                    TraceLink(
                        source_local_id=source_node_id,
                        reference_name=reference_name,
                        display_name=catalog_by_ref[reference_name],
                        target_kind=TraceLinkTargetKind.INTRA_JOB,
                        target_local_id=target_ref,
                        resolution_status=TraceLinkResolutionStatus.PENDING,
                    )
                )
            elif target_ref:
                trace_links.append(
                    TraceLink(
                        source_local_id=source_node_id,
                        reference_name=reference_name,
                        display_name=catalog_by_ref[reference_name],
                        target_kind=TraceLinkTargetKind.CROSS_JOB,
                        target_customer_id=target_ref,
                        resolution_status=TraceLinkResolutionStatus.PENDING,
                    )
                )

    return WorkItemTree(nodes=nodes, kb_citations=kb_citations, trace_links=trace_links)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ingestion && python -m pytest tests/test_llm_leveling.py -v -k trace_link`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full llm_leveling suite to check for regressions**

Run: `cd ingestion && python -m pytest tests/test_llm_leveling.py -v`
Expected: PASS, all tests (existing tests never pass `link_type_client`, so `trace_links` stays
`[]` for them, unchanged from before this task)

- [ ] **Step 6: Wire `link_type_catalog` through the `/level` endpoint**

Check `ingestion/app/main.py`'s existing `level()` signature (already read: `doc: CanonicalDoc,
customer_id: str | None = None, mode: str = "baseline", area_path: str | None = None`). Add a new
optional query parameter carrying the catalog as a JSON string (matches the existing lightweight
query-param style for `customer_id`/`area_path` — avoids restructuring the body contract around
the `CanonicalDoc` Pydantic model):

```python
@app.post("/level", response_model=WorkItemTree)
async def level(
    doc: CanonicalDoc,
    customer_id: str | None = None,
    mode: str = "baseline",
    area_path: str | None = None,
    link_type_catalog: str | None = None,
) -> WorkItemTree:
    if mode == "survey":
        client = OrchestratorLlmClient(settings.orchestrator_url, settings.llm_proxy_bearer)
        catalog = json.loads(link_type_catalog) if link_type_catalog else []
        return await run_in_threadpool(
            build_survey_tree,
            doc,
            llm_client=client,
            requirement_client=client,
            area_path=area_path,
            embed_client=_embed_client,
            vector_store=_kb_vector_store,
            scoring_client=client,
            link_type_client=client,
            link_type_catalog=catalog,
        )
    return build_baseline_tree(doc, customer_id=customer_id)
```

Add `import json` at the top of `main.py` if not already present (check with `grep -n "^import
json" ingestion/app/main.py`).

- [ ] **Step 7: Write/extend the `/level` endpoint test**

Add to `ingestion/tests/test_level_endpoint.py`, following that file's existing style for the
survey-mode test (check the existing test for how the mock `OrchestratorLlmClient` / `infer_hierarchy`
call is patched in, and mirror it exactly for `infer_trace_links`):

```python
def test_level_endpoint_survey_mode_passes_link_type_catalog_through(monkeypatch) -> None:
    catalog = [{"reference_name": "System.LinkTypes.Related", "name": "Related"}]
    captured = {}

    def fake_infer_trace_links(self, nodes, link_type_catalog, kb_context=None):
        captured["link_type_catalog"] = link_type_catalog
        return []

    monkeypatch.setattr(
        "app.survey.orchestrator_llm_client.OrchestratorLlmClient.infer_trace_links",
        fake_infer_trace_links,
    )
    # NOTE: infer_hierarchy and generate_requirements_for_document must also
    # be monkeypatched here exactly as the existing survey-mode test in this
    # file already does — reuse that test's setup verbatim rather than
    # duplicating it; only the assertion below and the extra monkeypatch
    # above are new.

    response = client.post(  # `client` is this file's existing TestClient fixture
        f"/level?mode=survey&link_type_catalog={json.dumps(catalog)}",
        json={"document": {"path": "x.txt", "format": "TXT", "sha256": "h"}, "blocks": []},
    )

    assert response.status_code == 200
    assert captured["link_type_catalog"] == catalog
```

(Adapt the request body and any other monkeypatches to match this test file's actual existing
survey-mode test exactly — inspect it first with `grep -n "def test_level_endpoint_survey" -A 30
ingestion/tests/test_level_endpoint.py` before writing this, since the fixture/monkeypatch
mechanics must match what's already there rather than being invented fresh.)

- [ ] **Step 8: Run test to verify it passes**

Run: `cd ingestion && python -m pytest tests/test_level_endpoint.py -v`
Expected: PASS, all tests (new + existing)

- [ ] **Step 9: Run the full ingestion suite**

Run: `cd ingestion && python -m pytest`
Expected: PASS, all tests

- [ ] **Step 10: Commit**

```bash
git add ingestion/app/leveling/llm_leveling.py ingestion/app/main.py \
  ingestion/tests/test_llm_leveling.py ingestion/tests/test_level_endpoint.py
git commit -m "feat(ingestion): wire infer_trace_links into build_survey_tree and /level"
```

---

## Task 9: Frontend — diff view trace-link display

**Files:**
- Modify: `frontend/src/components/DiffTree.tsx`
- Modify: `frontend/src/components/NodeDetailPanel.tsx`
- Test: `frontend/src/components/DiffTree.test.tsx` (create if absent — check with `ls
  frontend/src/components/DiffTree.test.tsx`; if it doesn't exist, model the test on
  `NodeDetailPanel.test.tsx`'s existing render-and-assert style)
- Test: `frontend/src/components/NodeDetailPanel.test.tsx`

**Interfaces:**
- Consumes: `DryRunDiffEntry.traceLinks` (arrives from the orchestrator API response, shaped per
  Task 4's `TraceLink` — same field names, camelCase, since this is a same-language JSON payload
  with no snake_case boundary here).
- Produces: a small chip per trace link on each `DiffTree` row and in `NodeDetailPanel`'s detail
  view; no new exported functions.

- [ ] **Step 1: Extend the shared `DryRunDiffEntry` type**

Add to the `DryRunDiffEntry` interface in `frontend/src/components/DiffTree.tsx` (after
`isManual?: boolean;`):

```typescript
  traceLinks?: {
    sourceLocalId: string;
    referenceName: string;
    displayName: string;
    targetKind: 'intraJob' | 'crossJob';
    targetLocalId?: string;
    targetCustomerId?: string;
    resolvedAdoId?: number;
    resolutionStatus: 'resolved' | 'unresolved' | 'pending';
  }[];
```

`NodeDetailPanel.tsx` imports `DryRunDiffEntry` from `DiffTree.tsx` already (`import type {
DryRunDiffEntry } from './DiffTree';`), so no separate type edit is needed there.

- [ ] **Step 2: Write the failing `DiffTree` test**

Create `frontend/src/components/DiffTree.test.tsx` (or add to it if it already exists — check
first) with a test proving a trace-link chip renders:

```typescript
import { render, screen } from '@testing-library/react';
import { DiffTree, type DryRunDiffEntry } from './DiffTree';

const baseEntry: DryRunDiffEntry = {
  localId: 'n0',
  parentLocalId: null,
  type: 'Requirement',
  title: 'Sys Req',
  description: 'd',
  action: 'create',
  customerId: null,
};

describe('DiffTree trace link chips', () => {
  it('renders a resolved trace link chip with its display name and target', () => {
    const entries: DryRunDiffEntry[] = [
      {
        ...baseEntry,
        traceLinks: [
          { sourceLocalId: 'n0', referenceName: 'Elisra.CoveredBy-Forward', displayName: 'Covered by', targetKind: 'crossJob', targetCustomerId: 'REQ-SYS-012', resolvedAdoId: 555, resolutionStatus: 'resolved' },
        ],
      },
    ];

    render(<DiffTree entries={entries} selectedId={null} onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);

    expect(screen.getByText(/Covered by/i)).toBeInTheDocument();
  });

  it('renders an unresolved trace link chip distinctly', () => {
    const entries: DryRunDiffEntry[] = [
      {
        ...baseEntry,
        traceLinks: [
          { sourceLocalId: 'n0', referenceName: 'Elisra.CoveredBy-Forward', displayName: 'Covered by', targetKind: 'crossJob', targetCustomerId: 'REQ-MISSING', resolutionStatus: 'unresolved' },
        ],
      },
    ];

    render(<DiffTree entries={entries} selectedId={null} onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);

    const chip = screen.getByText(/Covered by/i);
    expect(chip.closest('[data-resolution-status]')).toHaveAttribute('data-resolution-status', 'unresolved');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/DiffTree.test.tsx`
Expected: FAIL — no trace-link chip rendered

- [ ] **Step 4: Add a `TraceLinkChips` component and render it in `DiffTree`**

Create `frontend/src/components/TraceLinkChips.tsx`, following the existing `TagChips`/`IssueChips`
pattern (inspect one of those two files first for the exact MUI `Chip` usage style, then match it):

```typescript
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';

interface TraceLinkView {
  displayName: string;
  targetKind: 'intraJob' | 'crossJob';
  targetLocalId?: string;
  targetCustomerId?: string;
  resolvedAdoId?: number;
  resolutionStatus: 'resolved' | 'unresolved' | 'pending';
}

function targetLabel(link: TraceLinkView): string {
  if (link.resolvedAdoId != null) return `WI-${link.resolvedAdoId}`;
  if (link.targetCustomerId) return link.targetCustomerId;
  if (link.targetLocalId) return link.targetLocalId;
  return '?';
}

export function TraceLinkChips({ links }: { links?: TraceLinkView[] }): React.ReactElement | null {
  if (!links || links.length === 0) return null;
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap">
      {links.map((link, i) => (
        <Chip
          key={`${link.displayName}-${i}`}
          size="small"
          data-resolution-status={link.resolutionStatus}
          color={link.resolutionStatus === 'unresolved' ? 'warning' : 'default'}
          label={`${link.displayName} → ${targetLabel(link)}`}
        />
      ))}
    </Stack>
  );
}
```

Import and render it in `DiffTree.tsx`'s row, inside the `ListItemText`'s `secondary` prop —
change:

```typescript
              secondary={<TagChips tags={row.entry.tags} />}
```

to:

```typescript
              secondary={
                <>
                  <TagChips tags={row.entry.tags} />
                  <TraceLinkChips links={row.entry.traceLinks} />
                </>
              }
```

Add the import at the top of `DiffTree.tsx`:

```typescript
import { TraceLinkChips } from './TraceLinkChips';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/DiffTree.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 6: Write the failing `NodeDetailPanel` test**

Add to `frontend/src/components/NodeDetailPanel.test.tsx` (inspect its existing structure first —
it likely already has a `describe`/`render` helper for a base entry; reuse that helper rather than
duplicating entry construction):

```typescript
it('shows the full trace link list for the selected node', () => {
  const entry: DryRunDiffEntry = {
    ...baseEntry, // reuse whatever helper this file already uses to build a minimal entry
    traceLinks: [
      { sourceLocalId: 'n0', referenceName: 'System.LinkTypes.Affects-Forward', displayName: 'Affects', targetKind: 'crossJob', targetCustomerId: 'REQ-SYS-099', resolutionStatus: 'unresolved' },
    ],
  };

  render(<NodeDetailPanel jobId="job-1" entry={entry} />);

  expect(screen.getByText(/Affects/i)).toBeInTheDocument();
  expect(screen.getByText(/REQ-SYS-099/i)).toBeInTheDocument();
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/NodeDetailPanel.test.tsx`
Expected: FAIL — trace link text not found

- [ ] **Step 8: Render the link list in `NodeDetailPanel`**

Add to `NodeDetailPanel.tsx`, after the existing `<IssueChips issues={entry.qualityIssues} />`
line's containing block, add a new block (the `entry.traceLinks` check is independent of
`jobMode`/`qualityScore` — trace links can exist regardless of scoring):

```typescript
      {entry.traceLinks && entry.traceLinks.length > 0 && (
        <Box mt={1}>
          <Typography variant="subtitle2">Trace links</Typography>
          <TraceLinkChips links={entry.traceLinks} />
        </Box>
      )}
```

Add the import at the top:

```typescript
import { TraceLinkChips } from './TraceLinkChips';
```

- [ ] **Step 9: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/NodeDetailPanel.test.tsx`
Expected: PASS, all tests

- [ ] **Step 10: Run the full frontend suite**

Run: `cd frontend && npx vitest run`
Expected: PASS, all tests

- [ ] **Step 11: Commit**

```bash
git add frontend/src/components/DiffTree.tsx frontend/src/components/NodeDetailPanel.tsx \
  frontend/src/components/TraceLinkChips.tsx frontend/src/components/DiffTree.test.tsx \
  frontend/src/components/NodeDetailPanel.test.tsx
git commit -m "feat(frontend): display trace/coverage link chips in diff view and node detail panel"
```

---

## Self-Review Notes

- **Spec coverage:** Link-type discovery (Task 1), generic link primitive (Task 2), orchestrator
  plumbing (Tasks 3-5), ingestion data model (Task 6), LLM inference (Task 7), tree-wiring +
  endpoint (Task 8), UI (Task 9) — every section of the spec maps to a task.
- **Deliberate scope note:** Task 5's cross-job Customer-ID-field resolution assumes the target
  work-item type is always `Requirement` (see the inline comment in that task) — matches the
  spec's stated driving use case (System Requirement ↔ Customer Requirement) without
  over-generalizing; flagged explicitly rather than silently baked in.
- **Placeholder scan:** clean — no TBD/placeholder code blocks remain in the plan.
- **Type consistency:** `TraceLink`'s field names (`sourceLocalId`, `referenceName`,
  `displayName`, `targetKind`, `targetLocalId`, `targetCustomerId`, `resolvedAdoId`,
  `resolutionStatus`) are identical across Task 4 (orchestrator TS), Task 6 (ingestion Python,
  snake_case per that language's convention: `source_local_id` etc.), and Task 9 (frontend TS,
  matching Task 4). Task 5's `LeveledTraceLink` interface and its mapping into `TraceLink` was
  cross-checked field-by-field against Task 6's Python model and Task 4's TS type.

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-16-p4a-trace-link-types.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
