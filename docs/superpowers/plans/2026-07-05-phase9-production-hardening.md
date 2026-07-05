# Phase 9 Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three real production blockers found by a Phase 8 cross-validation review against `docs/architecture.md`: real ADO writes are hard-disabled, work items are written with no parent/child hierarchy and no real field content, and uploads have no size/type limits. Also close two smaller, real gaps found in the same review: on-prem CA-trust TLS config is parsed but never consumed, and the app carries dead RBAC scaffolding that the architecture's own locked decision says should never be built out — ADO's own permission system is the real access-control gate, not app-level RBAC.

**Architecture:** This phase does not touch ingestion's leveling logic — a direct read of `ingestion/app/leveling/tree_builder.py` confirms `build_baseline_tree` already computes `parent_local_id` per node and the `/level` route already returns it in the JSON response (`ingestion/app/main.py`, `response_model=WorkItemTree`). The entire parent/child gap is on the TypeScript orchestrator side: `pipeline.worker.ts`'s local `LeveledNode` interface doesn't declare `parent_local_id`, so it's silently dropped in a `.map()`, and `DryRunTreeNode`/`DryRunDiffEntry` (`dry-run.service.ts`) have no field to carry it further. Similarly, `JobsService.confirm()` calls `mcpClient.createWorkItem('Requirement', {})` — a hardcoded type and an **empty fields object** — because `DryRunDiffEntry` never carried `type`/`title`/`description` either; `mcpClient.linkParentChild` is already fully implemented on both `McpClient` and `RealAdoBackend` but is never called from `confirm()`. This phase's Task 2 is therefore almost entirely TypeScript plumbing to stop dropping data ingestion already computes — not new business logic.

The real-ADO-backend gate (`mcp-ado-server/src/index.ts` throws on `ADO_BACKEND=real`) exists because `RealAdoBackend`'s constructor requires a per-instance `AdoCredential` (`{orgUrl, pat}`), but `index.ts` builds one backend for the whole process lifetime — a shape that only fits the credential-less `MockAdoBackend`. `server.ts`'s `/mcp` POST handler already constructs a fresh `McpServer`/transport per request (required by the SDK's stateless-transport mode) — this phase extends that same per-request construction to the backend itself, reading `AdoCredential` from request headers. On the orchestrator side, `AuthController.login()` currently **discards the PAT** immediately after validating it (only a session JWT is kept, for app identity — never the PAT itself, per the architecture's own "never persisted" rule). This phase does not change that: the PAT must be supplied again, per write-triggering request, from the frontend's in-memory session state — matching the "in-memory/session only" locked decision literally, not just at login time.

On RBAC: a direct code read (done before writing this plan) confirms `Role`/`RolesGuard`/`toDomainRole` are **already dead code with zero runtime effect** — `RolesGuard` is registered as a module-scoped `APP_GUARD` in `auth.module.ts`, but no route anywhere uses the `@Roles()` decorator, so `RolesGuard.canActivate` always sees an empty required-roles list and short-circuits to `true` for every request. Separately, `role` is written into the session JWT at login but **nothing anywhere calls `SessionService.verify()` and reads `.role` back out** — no guard, middleware, or Passport strategy exists that populates `request.user` at all. The architecture doc's own locked decision already states "every authenticated user gets a single role (Operator) — ADO's own permission system is the real access-control gate, not app-level RBAC," and keeping this scaffolding "for a future multi-user RBAC scenario if ever needed" is no longer wanted — Task 5 removes it outright rather than building it out further.

**Tech Stack:** No new dependencies. `https` (Node built-in) for CA-trust TLS. Everything else is existing NestJS/Express/Prisma/MCP-SDK machinery.

## Global Constraints

- Every fix in this phase targets a REAL, verified gap found by reading the actual code (via a Phase 8 cross-validation review), not a hypothetical hardening item — each task states exactly which file:line motivated it.
- Do NOT modify `ingestion/app/leveling/tree_builder.py` or any other Python leveling logic — `parent_local_id` is already correctly computed there; this phase only stops the orchestrator from dropping it.
- Do NOT persist a raw ADO PAT anywhere (Postgres, Redis, disk, logs) at any point in this phase — matches the architecture's locked "PAT ... never persisted or logged" decision, unchanged from Phase 0.
- `JobsService.confirm()`'s existing idempotency-recording behavior (per-entry `sourceHash`/`customerId`, Phase 7.5's own bug fix) must not regress — the golden E2E's "re-run produces 100% reuse" assertion must still pass after this phase.
- Explicitly OUT OF SCOPE for this phase (tracked as separate future work, not silently dropped): SSE job-progress streaming (frontend still polls), vision LLM method, SURVEY-mode pipeline wiring, embedding-based dedup pipeline wiring, `deploy/` folder + nginx reverse-proxy config, remaining `docs/` wiki files (`runbook.md`, `api.md`, `prompts.md`, `security.md`), frontend Preview/Results/Settings pages, `shared/` JSON-Schema-to-TS/pydantic codegen wiring, audit-trail UI (this phase wires the audit table, not a frontend view of it).
- Type hints/explicit types on every function signature; existing repo test conventions per package.

---

### Task 1: Per-request ADO credential wiring — unblock `ADO_BACKEND=real`

**Files:**
- Modify: `mcp-ado-server/src/server.ts`
- Modify: `mcp-ado-server/src/index.ts`
- Modify: `orchestrator/src/modules/pipeline/mcp.client.ts`
- Modify: `orchestrator/src/modules/pipeline/jobs.controller.ts`
- Modify: `orchestrator/src/modules/pipeline/jobs.service.ts`
- Test: `mcp-ado-server/test/server.test.ts` (append), `orchestrator/test/mcp.client.spec.ts` (append), `orchestrator/test/jobs.controller.e2e-spec.ts` (append)

**Interfaces:**
- Adds: `X-Ado-Org-Url` / `X-Ado-Pat` HTTP headers, read per-request by `mcp-ado-server`'s `/mcp` POST handler when `cfg.backend === 'real'`.
- Adds: `credential?: { orgUrl: string; pat: string }` optional parameter, threaded through `McpClient.createWorkItem`/`linkParentChild`/`discoverFields`, forwarded as the same two headers on the MCP HTTP call.
- Adds: `X-Ado-Org-Url` / `X-Ado-Pat` HTTP headers accepted by `POST /jobs/:id/confirm` (write-triggering only — `POST /jobs` and `GET /jobs/:id` do not need ADO credentials, since dry-run diffing only needs Postgres).

**Boundary:** Only touch the five files listed. Do not modify `RealAdoBackend`, `MockAdoBackend`, or any MCP tool file — their contracts are unchanged; only how a backend instance gets constructed per-request changes.

- [ ] **Step 1: Confirm the exact current blocking code**

Run: `grep -n "ADO_BACKEND=real requires" mcp-ado-server/src/index.ts`
Expected: the `throw new Error(...)` block this task replaces.

- [ ] **Step 2: Change `createMcpApp` to accept a backend FACTORY, not a single instance**

```typescript
// mcp-ado-server/src/server.ts
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AdoBackend } from './backends/types.js';
import type { AdoCredential } from './auth/patAuth.js';
import type { AdoMcpConfig } from './config/env.js';
import { registerPingTool } from './tools/pingTool.js';
import { registerDiscoverFieldsTool } from './tools/discoverFieldsTool.js';
import { registerCreateWorkItemTool } from './tools/createWorkItemTool.js';
import { registerLinkParentChildTool } from './tools/linkParentChildTool.js';
import { registerSetFieldsTool } from './tools/setFieldsTool.js';
import { registerQueryIdsTool } from './tools/queryIdsTool.js';
import { timingSafeEqualBearer } from './auth/timingSafeEqualBearer.js';

/**
 * `backendFactory` is called once per /mcp request, given the request's
 * per-user AdoCredential (undefined when backend===mock, which needs none).
 * Real backend: a fresh RealAdoBackend per request, scoped to that user's
 * own PAT — never a shared, process-lifetime credential. Mock backend: the
 * SAME shared MockAdoBackend instance every time (it's a stateful SQLite
 * store meant to simulate ADO's persistence across requests/tests, not a
 * per-user resource).
 */
export type BackendFactory = (credential: AdoCredential | undefined) => AdoBackend;

function readCredential(req: express.Request): AdoCredential | undefined {
  const orgUrl = req.header('x-ado-org-url');
  const pat = req.header('x-ado-pat');
  if (!orgUrl || !pat) return undefined;
  return { orgUrl, pat };
}

export function createMcpApp(backendFactory: BackendFactory, cfg: AdoMcpConfig): express.Express {
  const app = express();
  app.use(express.json());

  app.get('/health', async (_req, res) => {
    // Health check never needs a real credential — mock/no-op ping is fine
    // even when backend===real, since this only proves the process is up.
    res.json(await backendFactory(undefined).ping());
  });

  app.use('/mcp', (req, res, next) => {
    const header = req.header('authorization') ?? '';
    if (!timingSafeEqualBearer(header, `Bearer ${cfg.mcpBearer}`)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (cfg.backend === 'real' && !readCredential(req)) {
      res.status(401).json({ error: 'missing X-Ado-Org-Url / X-Ado-Pat headers for real backend' });
      return;
    }
    next();
  });

  app.post('/mcp', async (req, res) => {
    const backend = backendFactory(readCredential(req));
    const mcpServer = new McpServer({ name: 'req2ado-ado-mcp-server', version: '0.1.0' });
    registerPingTool(mcpServer, backend);
    registerDiscoverFieldsTool(mcpServer, backend);
    registerCreateWorkItemTool(mcpServer, backend);
    registerLinkParentChildTool(mcpServer, backend);
    registerSetFieldsTool(mcpServer, backend);
    registerQueryIdsTool(mcpServer, backend);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      void transport.close();
      void mcpServer.close();
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}
```

- [ ] **Step 3: Wire the two factory branches in `index.ts`, remove the throw**

```typescript
// mcp-ado-server/src/index.ts
import { createMcpApp } from './server.js';
import { loadConfig } from './config/env.js';
import { MockAdoBackend } from './backends/mockAdo.js';
import { RealAdoBackend } from './backends/realAdo.js';

const cfg = loadConfig();

const backendFactory =
  cfg.backend === 'real'
    ? (credential: import('./auth/patAuth.js').AdoCredential | undefined) => {
        // credential is guaranteed defined here — server.ts's /mcp middleware
        // already rejected the request with 401 if it were missing.
        return new RealAdoBackend(cfg, credential!);
      }
    : (() => {
        const mock = new MockAdoBackend(cfg.mockDbPath);
        return () => mock;
      })();

const app = createMcpApp(backendFactory, cfg);
app.listen(cfg.port, () => {
  // eslint-disable-next-line no-console -- startup banner, not app logging
  process.stdout.write(`req2ado mcp-ado-server listening on :${cfg.port} (backend=${cfg.backend})\n`);
});
```

- [ ] **Step 4: Run `mcp-ado-server`'s existing tests to confirm no regression, then add a real-backend-credential test**

Run: `cd mcp-ado-server && npx vitest run` — the existing `server.test.ts` tests construct the app with a single backend today; update any that call `createMcpApp(backend, cfg)` to `createMcpApp(() => backend, cfg)` (mock-mode shape) so they keep compiling and passing unchanged.

Append to `mcp-ado-server/test/server.test.ts`:
```typescript
it('rejects a /mcp request with no ADO credential headers when backend=real', async () => {
  const app = createMcpApp(() => { throw new Error('should not be called'); }, { ...testCfg, backend: 'real' });
  const res = await request(app).post('/mcp').set('Authorization', `Bearer ${testCfg.mcpBearer}`).send({});
  expect(res.status).toBe(401);
});
```

- [ ] **Step 5: Thread the credential through `McpClient`'s three methods**

```typescript
// orchestrator/src/modules/pipeline/mcp.client.ts
export interface AdoRequestCredential {
  orgUrl: string;
  pat: string;
}

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

  // ...parseToolTextResult unchanged...

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

  async discoverFields(workItemType: string, credential?: AdoRequestCredential): Promise<string[]> {
    return this.withClient(credential, async (client) => {
      const result = await client.callTool({ name: 'ado_discover_fields', arguments: { workItemType } });
      return this.parseToolTextResult(result as any);
    });
  }
}
```

Existing callers passing no `credential` arg keep working unchanged against `ADO_BACKEND=mock` (the default in every test and the golden E2E) — `credential` is optional and `withClient` only adds the two headers when present.

- [ ] **Step 6: Accept the credential on `POST /jobs/:id/confirm`, thread it into `confirm()`**

```typescript
// orchestrator/src/modules/pipeline/jobs.controller.ts — modify the confirm route:
import { Headers } from '@nestjs/common';
// ...
@Post(':id/confirm')
async confirm(
  @Param('id') id: string,
  @Headers('x-ado-org-url') orgUrl: string | undefined,
  @Headers('x-ado-pat') pat: string | undefined,
): Promise<{ status: string; createdCount: number }> {
  const credential = orgUrl && pat ? { orgUrl, pat } : undefined;
  return this.jobsService.confirm(id, credential);
}
```

```typescript
// orchestrator/src/modules/pipeline/jobs.service.ts — confirm() signature only, body changes land in Task 2:
async confirm(
  id: string,
  credential?: { orgUrl: string; pat: string },
): Promise<{ status: string; createdCount: number }> {
  // ... existing body, pass `credential` through to every this.mcpClient.* call ...
}
```

When `ADO_BACKEND=mock` (every test, the golden E2E), `credential` stays `undefined` end-to-end and behavior is byte-for-byte unchanged from before this task — confirmed by re-running the full existing suite in Step 7.

- [ ] **Step 7: Run both packages' full suites**

Run: `cd mcp-ado-server && npx vitest run && cd ../orchestrator && npx jest`
Expected: all pass, no regressions (baseline: 47/47 mcp-ado-server, 97/97 orchestrator going into this phase).

- [ ] **Step 8: Manually verify against a REAL on-prem ADO test project (gated, not part of automated CI)**

This step requires actual on-prem ADO access and cannot run in a sandboxed CI runner — matches this project's own established convention (see Phase 7's "Real ADO (gated)" verification step in `docs/architecture.md`'s Verification section). If ADO access is available: set `ADO_BACKEND=real`, `ADO_BASE_URL`/`ADO_PROJECT` to a real on-prem scratch project, start `mcp-ado-server`, and issue a manual `curl` to `/mcp` with `X-Ado-Org-Url`/`X-Ado-Pat` headers matching a real PAT, confirming a real work item is created. If ADO access is NOT available in this environment, report this step as "unverified in this environment — code reviewed and unit-tested against the mock backend's identical tool contract" rather than skip it silently.

- [ ] **Step 9: Commit**

```bash
git add mcp-ado-server/src/server.ts mcp-ado-server/src/index.ts mcp-ado-server/test/server.test.ts orchestrator/src/modules/pipeline/mcp.client.ts orchestrator/src/modules/pipeline/jobs.controller.ts orchestrator/src/modules/pipeline/jobs.service.ts orchestrator/test/mcp.client.spec.ts orchestrator/test/jobs.controller.e2e-spec.ts
git commit -m "feat(mcp-ado-server,orchestrator): per-request ADO credential wiring, unblocking ADO_BACKEND=real"
```

---

### Task 2: Parent/child linking + real field content on write-back

**Files:**
- Modify: `orchestrator/src/modules/pipeline/pipeline.worker.ts`
- Modify: `orchestrator/src/modules/writeback/dry-run.service.ts`
- Modify: `orchestrator/src/modules/pipeline/jobs.service.ts`
- Test: `orchestrator/test/pipeline.worker.spec.ts` (append), `orchestrator/test/dry-run.service.spec.ts` (append), new `orchestrator/test/jobs.service.spec.ts` (unit test for `confirm()`'s new linking logic, isolated from the controller/e2e layer)

**Interfaces:**
- `DryRunTreeNode`/`DryRunDiffEntry` (`dry-run.service.ts`) gain `parentLocalId: string | null`, `type: string`, `title: string`, `description: string` — additive, matching the pattern already used when `sourceHash`/`customerId` were added to `DryRunDiffEntry` in Phase 7.5.
- `JobsService.confirm()`'s internal write loop changes from "call `createWorkItem('Requirement', {})` for every `create` entry, ignore parent/child" to "call `createWorkItem(entry.type, {title, description, ...})` for every `create` entry in tree order, building a `localId -> adoWorkItemId` map (seeded with `existingAdoId` for `reuse` entries), then call `mcpClient.linkParentChild(childAdoId, parentAdoId)` for every entry with a non-null `parentLocalId`."

**Boundary:** Only touch the three files listed, plus their test files. Do not modify `ingestion/app/leveling/tree_builder.py` — `parent_local_id`/`type`/`title`/`description` are already correctly computed there; this task only stops the orchestrator from dropping them.

- [ ] **Step 1: Confirm ingestion's `/level` response already carries the needed fields**

Run: `grep -n "parent_local_id\|class WorkItemNode" ingestion/app/workitem/model.py`
Expected: `WorkItemNode` declares `parent_local_id: str | None`, `type`, `title`, `description` as real fields — confirming no Python changes are needed (verified during this plan's own research; re-confirm before starting in case of drift).

- [ ] **Step 2: Extend `LeveledNode` and the mapping in `pipeline.worker.ts`**

```typescript
// orchestrator/src/modules/pipeline/pipeline.worker.ts
interface LeveledNode {
  local_id: string;
  parent_local_id: string | null;
  type: string;
  title: string;
  description: string;
  fidelity_hash: string;
  customer_id: string | null;
}

// inside runPipelineJob, replace the existing diffInputs.map(...):
const diffInputs: DryRunTreeNode[] = tree.nodes.map((node) => ({
  localId: node.local_id,
  parentLocalId: node.parent_local_id,
  type: node.type,
  title: node.title,
  description: node.description,
  sourceHash: node.fidelity_hash,
  customerId: node.customer_id,
  areaPath: job.areaPath,
}));
```

- [ ] **Step 3: Extend `DryRunTreeNode`/`DryRunDiffEntry`, carry the new fields through `diff()`**

```typescript
// orchestrator/src/modules/writeback/dry-run.service.ts
export interface DryRunTreeNode {
  localId: string;
  parentLocalId: string | null;
  type: string;
  title: string;
  description: string;
  sourceHash: string;
  customerId: string | null;
  areaPath: string;
}

export interface DryRunDiffEntry {
  localId: string;
  parentLocalId: string | null;
  type: string;
  title: string;
  description: string;
  action: 'create' | 'reuse';
  existingAdoId: number | null;
  sourceHash: string;
  customerId: string | null;
}

// inside diff()'s loop, add the new fields to the pushed entry:
results.push({
  localId: node.localId,
  parentLocalId: node.parentLocalId,
  type: node.type,
  title: node.title,
  description: node.description,
  action: existingAdoId === null ? 'create' : 'reuse',
  existingAdoId,
  sourceHash: node.sourceHash,
  customerId: node.customerId,
});
```

Update `dry-run.service.spec.ts`'s existing `toEqual` assertions to include the new fields with test-appropriate values (matching Phase 7.5's own precedent for this exact kind of additive-field test update).

- [ ] **Step 4: Rewrite `confirm()`'s write loop — create in tree order, build id map, link parents**

```typescript
// orchestrator/src/modules/pipeline/jobs.service.ts
async confirm(
  id: string,
  credential?: { orgUrl: string; pat: string },
): Promise<{ status: string; createdCount: number }> {
  const job = await this.prisma.job.findUnique({ where: { id } });
  if (!job || job.status !== 'diff_ready') {
    throw new Error(`Job ${id} is not in a confirmable state`);
  }
  await this.prisma.job.update({ where: { id }, data: { status: 'writing' } });

  const diff = job.dryRunDiff as {
    localId: string;
    parentLocalId: string | null;
    type: string;
    title: string;
    description: string;
    action: string;
    existingAdoId: number | null;
    sourceHash: string;
    customerId: string | null;
  }[];

  // Tree order from ingestion (parents appear before children — see
  // tree_builder.py's stack-based construction) means a single left-to-right
  // pass is sufficient: every entry's parentLocalId, if non-null, already
  // has its ADO id in this map by the time we reach the child.
  const adoIdByLocalId = new Map<string, number>();
  let createdCount = 0;

  for (const entry of diff) {
    if (entry.action === 'reuse' && entry.existingAdoId !== null) {
      adoIdByLocalId.set(entry.localId, entry.existingAdoId);
      continue;
    }
    const created = await this.mcpClient.createWorkItem(
      entry.type,
      { 'System.Title': entry.title, 'System.Description': entry.description },
      credential,
    );
    adoIdByLocalId.set(entry.localId, created.id);
    await this.idempotencyService.record(entry.sourceHash, entry.customerId, job.areaPath, created.id);
    createdCount += 1;
  }

  for (const entry of diff) {
    if (entry.parentLocalId === null) continue;
    const childAdoId = adoIdByLocalId.get(entry.localId);
    const parentAdoId = adoIdByLocalId.get(entry.parentLocalId);
    if (childAdoId === undefined || parentAdoId === undefined) continue; // defensive — should not happen given tree order
    await this.mcpClient.linkParentChild(childAdoId, parentAdoId, credential);
  }

  await this.prisma.job.update({
    where: { id },
    data: { status: 'succeeded', confirmedAt: new Date(), completedAt: new Date() },
  });
  return { status: 'succeeded', createdCount };
}
```

Two passes (create-all, then link-all) rather than interleaving link calls inside the create loop — this is deliberate: a `reuse` entry's parent might itself be a `create` entry appearing later in a pathological tree shape (unlikely given ingestion's real construction order, but not guaranteed by this interface), so resolving all ids before issuing any link call is the more defensive ordering, at the cost of nothing since `linkParentChild` is idempotent-safe to call after all creates regardless.

- [ ] **Step 5: New unit tests for `confirm()`'s linking logic**

Create `orchestrator/test/jobs.service.spec.ts` (unit-level, mocking `prisma`/`mcpClient`/`idempotencyService` directly — NOT going through the HTTP controller layer, which `jobs.controller.e2e-spec.ts` already covers for the request/response shape):

```typescript
import { JobsService } from '../src/modules/pipeline/jobs.service';

describe('JobsService.confirm', () => {
  it('creates items in tree order and links each child to its already-created parent', async () => {
    const createWorkItem = jest.fn()
      .mockResolvedValueOnce({ id: 100 }) // parent
      .mockResolvedValueOnce({ id: 101 }); // child
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const record = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: 'diff_ready',
          areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null },
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const service = new JobsService(prisma as any, { createWorkItem, linkParentChild } as any, { record } as any, 'redis://unused');

    const result = await service.confirm('job-1');

    expect(result).toEqual({ status: 'succeeded', createdCount: 2 });
    expect(linkParentChild).toHaveBeenCalledWith(101, 100, undefined);
  });

  it('links a child to a REUSED parent (existingAdoId), not just newly-created parents', async () => {
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 101 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'reuse', existingAdoId: 42, sourceHash: 'h0', customerId: null },
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const service = new JobsService(prisma as any, { createWorkItem, linkParentChild } as any, { record: jest.fn() } as any, 'redis://unused');

    await service.confirm('job-1');

    expect(linkParentChild).toHaveBeenCalledWith(101, 42, undefined);
  });
});
```

- [ ] **Step 6: Update the golden E2E's assertions for the new fields (no logic change, just richer diff shape)**

`scripts/run-golden-e2e.sh` already asserts `action` values via `jq`; confirm its existing `jq '.dryRunDiff[].action'` selector still works unchanged against the richer entry shape (it will — `jq` field selection is unaffected by additional sibling fields).

- [ ] **Step 7: Run the full orchestrator suite, then the golden E2E**

Run: `cd orchestrator && npx jest` — expect no regressions plus new passing tests.
Run: `bash scripts/run-golden-e2e.sh` — expect `GOLDEN E2E PASSED`, now with the mock backend receiving real `System.Title`/`System.Description` field values and a real parent-child link call (verifiable by adding a temporary debug log in `MockAdoBackend.linkParentChild` during manual verification, or by asserting on it in a new script-level check if convenient — not required for pass/fail).

- [ ] **Step 8: Commit**

```bash
git add orchestrator/src/modules/pipeline/pipeline.worker.ts orchestrator/src/modules/writeback/dry-run.service.ts orchestrator/src/modules/pipeline/jobs.service.ts orchestrator/test/pipeline.worker.spec.ts orchestrator/test/dry-run.service.spec.ts orchestrator/test/jobs.service.spec.ts
git commit -m "fix(orchestrator): stop dropping parent_local_id/type/title/description from ingestion, wire linkParentChild into confirm()"
```

---

### Task 3: Upload size/type limits

**Files:**
- Modify: `orchestrator/src/modules/pipeline/jobs.controller.ts`
- Modify: `orchestrator/src/config/config.schema.ts`
- Test: `orchestrator/test/jobs.controller.e2e-spec.ts` (append)

**Interfaces:** Adds `MAX_UPLOAD_SIZE_MB` (default `25`) to the validated config schema. No new public interface otherwise — `FileInterceptor`'s options are internal to the controller.

**Boundary:** Only touch the two files listed.

- [ ] **Step 1: Confirm the exact current gap**

Run: `grep -n "FileInterceptor" orchestrator/src/modules/pipeline/jobs.controller.ts`
Expected: `@UseInterceptors(FileInterceptor('file'))` with no options object — confirmed unlimited size, no MIME filter.

- [ ] **Step 2: Add the config value**

```typescript
// orchestrator/src/config/config.schema.ts — add to the schema object:
  MAX_UPLOAD_SIZE_MB: z.coerce.number().default(25),
```

- [ ] **Step 3: Add limits + a MIME/extension allowlist matching ingestion's real supported formats**

```typescript
// orchestrator/src/modules/pipeline/jobs.controller.ts
import { BadRequestException, Controller, Get, NotFoundException, Param, Post, UploadedFile, UseInterceptors, Headers, PayloadTooLargeException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Body } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { createHash } from 'crypto';

// Matches ingestion/app/loaders/*.py's actually-implemented loaders — txt,
// md, docx, pdf (incl. scanned/OCR, same extension), xlsx. Not a security
// boundary against malicious file CONTENT (that's ingestion's own parsing
// robustness), only a cheap reject-obviously-wrong-format-early gate.
const ALLOWED_EXTENSIONS = new Set(['.txt', '.md', '.docx', '.pdf', '.xlsx']);

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobsService: JobsService,
    private readonly maxUploadSizeBytes: number,
  ) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 25 * 1024 * 1024 }, // overridden per-instance below via DI value; see jobs.module.ts factory note
    }),
  )
  async submit(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('areaPath') areaPath: string | undefined,
    @Body('customerId') customerId: string | undefined,
  ): Promise<{ jobId: string }> {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    if (file.size > this.maxUploadSizeBytes) {
      throw new PayloadTooLargeException(
        `file exceeds the ${Math.round(this.maxUploadSizeBytes / 1024 / 1024)}MB upload limit`,
      );
    }
    const ext = file.originalname.slice(file.originalname.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new BadRequestException(`unsupported file type: ${ext}`);
    }
    if (!areaPath) {
      throw new BadRequestException('areaPath is required');
    }
    const sourceHash = createHash('sha256').update(file.buffer).digest('hex');
    return this.jobsService.submit({
      userId: 'placeholder-user-id',
      areaPath,
      customerId: customerId ?? null,
      fileBuffer: file.buffer,
      filename: file.originalname,
      sourceHash,
    });
  }

  // ...getById/confirm unchanged...
}
```

Note on the `limits: { fileSize: ... }` decorator option: NestJS's `@UseInterceptors(FileInterceptor(...))` decorator arguments are evaluated at class-definition time, before DI has resolved `maxUploadSizeBytes` — so the decorator's own `limits.fileSize` must use a static, generous upper bound (Multer's own hard ceiling, here `25 * 1024 * 1024` as a literal matching the config default) as a first line of defense, while the REAL configurable limit is enforced by the explicit `file.size > this.maxUploadSizeBytes` check inside the method body (which does see the DI-resolved value). If a genuinely different literal value is needed here later, keep both numbers in sync manually — this is a known, minor duplication, not a bug, and matches how Multer's decorator-time options work in every NestJS app.

- [ ] **Step 4: Wire `maxUploadSizeBytes` via `jobs.module.ts`'s existing factory-provider pattern**

```typescript
// orchestrator/src/modules/pipeline/jobs.module.ts — add a provider:
{
  provide: 'MAX_UPLOAD_SIZE_BYTES',
  useFactory: (config: AppConfig) => config.MAX_UPLOAD_SIZE_MB * 1024 * 1024,
  inject: [/* however AppConfig is already injected elsewhere in this module */],
},
```

Match whatever DI token/pattern this module already uses for injecting the validated `AppConfig` (check `orchestrator/src/config/config.module.ts` for the existing provider token before guessing a name) — reuse it, don't invent a second config-access path.

- [ ] **Step 5: New tests**

```typescript
// Append to orchestrator/test/jobs.controller.e2e-spec.ts
it('POST /jobs rejects a file exceeding the configured size limit', async () => {
  const oversized = Buffer.alloc(30 * 1024 * 1024); // exceeds the 25MB default
  const res = await request(app.getHttpServer())
    .post('/jobs')
    .attach('file', oversized, 'big.txt')
    .field('areaPath', 'Project\\Area1');
  expect(res.status).toBe(413);
});

it('POST /jobs rejects an unsupported file extension', async () => {
  const res = await request(app.getHttpServer())
    .post('/jobs')
    .attach('file', Buffer.from('fake'), 'malware.exe')
    .field('areaPath', 'Project\\Area1');
  expect(res.status).toBe(400);
});
```

- [ ] **Step 6: Run the full orchestrator suite**

Run: `cd orchestrator && npx jest` — confirm no regressions, new tests pass.

- [ ] **Step 7: Commit**

```bash
git add orchestrator/src/modules/pipeline/jobs.controller.ts orchestrator/src/modules/pipeline/jobs.module.ts orchestrator/src/config/config.schema.ts orchestrator/test/jobs.controller.e2e-spec.ts
git commit -m "feat(orchestrator): add upload size limit and file-extension allowlist to POST /jobs"
```

---

### Task 4: Audit trail wiring

**Files:**
- Modify: `orchestrator/src/modules/pipeline/jobs.service.ts`
- Modify: `orchestrator/src/modules/pipeline/pipeline.worker.ts`
- Modify: `orchestrator/src/modules/pipeline/jobs.controller.ts`
- Test: `orchestrator/test/jobs.service.spec.ts` (append, from Task 2), `orchestrator/test/jobs.controller.e2e-spec.ts` (append)

**Interfaces:** Adds `GET /jobs/:id/audit` returning `AuditEntry[]` (id, message, createdAt) for a job — the `AuditEntry` Prisma model already exists (Phase 0) but is never read or written anywhere; this task is purely wiring existing schema to existing lifecycle events.

**Boundary:** Only touch the three files listed (plus their tests). Do not modify `prisma/schema.prisma` — `AuditEntry`'s existing shape (`jobId`, `message`, `createdAt`) is sufficient.

- [ ] **Step 1: Confirm the exact current gap**

Run: `grep -rn "AuditEntry\|auditEntr" orchestrator/src`
Expected: zero matches — confirming the table is defined but never touched by application code.

- [ ] **Step 2: Write audit entries at each real lifecycle transition**

```typescript
// orchestrator/src/modules/pipeline/jobs.service.ts — inside submit(), after job.create:
await this.prisma.auditEntry.create({
  data: { jobId: job.id, message: `Job submitted: ${input.filename}, areaPath=${input.areaPath}` },
});

// inside confirm(), after the final status update:
await this.prisma.auditEntry.create({
  data: { jobId: id, message: `Job confirmed: ${createdCount} work item(s) created` },
});
```

```typescript
// orchestrator/src/modules/pipeline/pipeline.worker.ts — inside runPipelineJob,
// right after the dryRunDiff status update succeeds:
await deps.prisma.auditEntry.create({
  data: { jobId: job.id, message: `Dry-run diff ready: ${diff.length} node(s), ${diff.filter((e) => e.action === 'create').length} to create` },
});
// and inside the catch block, right after setting status: 'failed':
await deps.prisma.auditEntry.create({
  data: { jobId: job.id, message: `Pipeline failed: ${error instanceof Error ? error.message : String(error)}` },
});
```

- [ ] **Step 3: Add the read endpoint**

```typescript
// orchestrator/src/modules/pipeline/jobs.service.ts
async getAuditTrail(id: string): Promise<{ id: string; message: string; createdAt: Date }[]> {
  return this.prisma.auditEntry.findMany({ where: { jobId: id }, orderBy: { createdAt: 'asc' } });
}
```

```typescript
// orchestrator/src/modules/pipeline/jobs.controller.ts
@Get(':id/audit')
async getAudit(@Param('id') id: string): Promise<{ id: string; message: string; createdAt: Date }[]> {
  return this.jobsService.getAuditTrail(id);
}
```

- [ ] **Step 4: Tests**

```typescript
// Append to orchestrator/test/jobs.controller.e2e-spec.ts
it('GET /jobs/:id/audit returns the audit trail', async () => {
  fakeJobsService.getAuditTrail.mockResolvedValue([{ id: 'a1', message: 'Job submitted: x.txt', createdAt: new Date() }]);
  const res = await request(app.getHttpServer()).get('/jobs/job-1/audit');
  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(1);
});
```

(Add `getAuditTrail: jest.fn()` to the existing `fakeJobsService` mock object at the top of this test file.)

- [ ] **Step 5: Run the full orchestrator suite**

Run: `cd orchestrator && npx jest` — confirm no regressions, new tests pass.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/modules/pipeline/jobs.service.ts orchestrator/src/modules/pipeline/pipeline.worker.ts orchestrator/src/modules/pipeline/jobs.controller.ts orchestrator/test/jobs.controller.e2e-spec.ts
git commit -m "feat(orchestrator): wire the existing (previously-dead) AuditEntry table into job lifecycle events, add GET /jobs/:id/audit"
```

---

### Task 5: Remove RBAC scaffolding (Role enum, RolesGuard, Prisma role column)

**Why this is a removal, not a hardening item.** A direct code read (done before writing this plan) confirms `Role`/`RolesGuard`/`@Roles()`/`toDomainRole` are dead code with zero runtime authorization effect today: `RolesGuard` is registered as a module-scoped `APP_GUARD` in `auth.module.ts`, but `@Roles()` is never applied to any route, so `RolesGuard.canActivate` always sees an empty required-roles list and returns `true` unconditionally for every request. Separately, `role` is written into the session JWT at login but nothing anywhere calls `SessionService.verify()` and reads `.role` back out — no guard/middleware/Passport strategy populates `request.user` at all. `docs/architecture.md`'s own locked decision already states ADO's own permission system is the real access-control gate, not app-level RBAC, and the "keep this scaffolding for a future multi-user RBAC scenario" stance from Phase 0 is explicitly retired by this task — PAT/ADO-account scope is enough.

**Files:**
- Delete: `orchestrator/src/modules/auth/roles.guard.ts`, `orchestrator/src/modules/auth/roles.decorator.ts`, `orchestrator/src/modules/auth/roles.enum.ts`
- Delete: `orchestrator/test/roles.guard.spec.ts`, `orchestrator/test/roles.mapper.spec.ts`
- Modify: `orchestrator/src/modules/auth/auth.module.ts` (remove `RolesGuard` import + `APP_GUARD` registration)
- Modify: `orchestrator/src/modules/auth/auth.controller.ts` (remove `toDomainRole`/`PrismaRole` role logic from the login upsert + JWT issue)
- Modify: `orchestrator/src/modules/auth/session.service.ts` (remove `role` from `SessionPayload`)
- Modify: `orchestrator/src/modules/auth/azure-ad.provider.ts` (remove `role` from `AzureAdUser` and its stub)
- Modify: `orchestrator/test/session.service.spec.ts`, `orchestrator/test/auth.controller.e2e-spec.ts` (drop role-related imports/assertions)
- Modify: `orchestrator/prisma/schema.prisma` (drop `User.role` field and the `Role` enum)
- Create: a new Prisma migration dropping the `role` column then the `Role` enum type (the enum is only ever created in the existing `20260701113652_init` migration — do not edit migration history, add a new forward migration)

**Interfaces:** Removes `role` from `SessionPayload` and from `AuthController.login`'s response JWT. `POST /auth/login` still returns `{ token }` — the JWT's payload shape shrinks from `{ userId, role }` to `{ userId }`, which is a breaking change to the JWT's internal shape but not to the `/auth/login` HTTP contract (still `{ token: string }`), and nothing downstream reads `.role` from a decoded token today (confirmed above), so no other code needs to change to tolerate the smaller payload.

**Boundary:** Only touch the files listed. Do not remove the `User` model itself (`Job.userId` still FKs to it) — only its `role` column and the `Role` enum. Do not touch `jobs.controller.ts`'s existing `userId: 'placeholder-user-id'` hardcoding — that's a separate, already-documented gap (no session-JWT guard applied to non-`/auth` routes yet) unrelated to this task.

- [ ] **Step 1: Confirm the exact current dead-code state before removing anything**

Run: `grep -n "RolesGuard\|@Roles(" orchestrator/src/modules/auth/*.ts orchestrator/src/modules/pipeline/*.ts orchestrator/src/modules/llm/*.ts orchestrator/src/modules/wiki/*.ts`
Expected: only `roles.guard.ts` and `roles.decorator.ts`'s own definitions — zero `@UseGuards(RolesGuard)` or `@Roles(...)` call sites anywhere else, confirming this is safe to delete outright with no call-site cleanup needed elsewhere.

- [ ] **Step 2: Delete the RBAC source and test files**

```bash
git rm orchestrator/src/modules/auth/roles.guard.ts orchestrator/src/modules/auth/roles.decorator.ts orchestrator/src/modules/auth/roles.enum.ts
git rm orchestrator/test/roles.guard.spec.ts orchestrator/test/roles.mapper.spec.ts
```

- [ ] **Step 3: Remove `RolesGuard` registration from `auth.module.ts`**

```typescript
// orchestrator/src/modules/auth/auth.module.ts — remove the RolesGuard import
// and its APP_GUARD provider entry; leave every other provider/controller
// registration in this module untouched.
```

- [ ] **Step 4: Simplify `auth.controller.ts`'s login flow**

```typescript
// orchestrator/src/modules/auth/auth.controller.ts
import { BadRequestException, Body, Controller, Post, UnauthorizedException } from '@nestjs/common';
import { AdoPatProvider } from './ado-pat.provider';
import { loginRequestSchema } from './login.dto';
import { PrismaService } from './prisma.service';
import { SessionService } from './session.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly adoPatProvider: AdoPatProvider,
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
  ) {}

  @Post('login')
  async login(@Body() rawBody: unknown): Promise<{ token: string }> {
    const parseResult = loginRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: adoOrgUrl must be a valid URL, pat must be non-empty');
    }
    const body = parseResult.data;

    let identity;
    try {
      identity = await this.adoPatProvider.validateAndIdentify(body.adoOrgUrl, body.pat);
    } catch {
      throw new UnauthorizedException('Invalid ADO organization URL or Personal Access Token');
    }

    const user = await this.prisma.user.upsert({
      where: { email: identity.identity },
      update: {},
      create: { email: identity.identity },
    });

    const token = this.sessionService.issue({ userId: user.id });
    return { token };
  }
}
```

- [ ] **Step 5: Drop `role` from `SessionPayload` and `AzureAdUser`**

```typescript
// orchestrator/src/modules/auth/session.service.ts
export interface SessionPayload {
  userId: string;
}
// issue()/verify() bodies are unchanged — they already operate generically
// on whatever shape SessionPayload declares.
```

```typescript
// orchestrator/src/modules/auth/azure-ad.provider.ts
export interface AzureAdUser {
  email: string;
}
// ... the stub exchangeCode() return value drops its `role: Role.Operator`
// field to match — return only `{ email: 'dev-user@example.com' }`.
```

- [ ] **Step 6: Update the two affected test files**

```typescript
// orchestrator/test/session.service.spec.ts — drop the `Role` import and
// any `role`/`decoded.role` assertions; assert only on `userId` round-tripping.
```

```typescript
// orchestrator/test/auth.controller.e2e-spec.ts — remove `role: 'OPERATOR'`
// from the upsert mock/assertion and the `decoded.role` assertion; keep
// every other assertion (200 status, `{ token }` shape, upsert called with
// the right email) unchanged.
```

- [ ] **Step 7: Drop the Prisma `Role` enum and `User.role` column**

```prisma
// orchestrator/prisma/schema.prisma — remove the `Role` enum block entirely,
// and remove the `role` field from `User`:
model User {
  id        String   @id @default(uuid())
  email     String   @unique
  createdAt DateTime @default(now())
  jobs      Job[]
}
```

Run: `cd orchestrator && npx prisma migrate dev --name drop_user_role` against a real local/temp Postgres instance (matching every prior phase's pattern of verifying Prisma migrations against a real database rather than trusting the generated SQL blind) — confirm the generated migration does `ALTER TABLE "User" DROP COLUMN "role";` then `DROP TYPE "Role";`, in that order (Postgres refuses to drop an enum type while a column still references it).

- [ ] **Step 8: Run the full orchestrator suite, confirm no regressions**

Run: `cd orchestrator && npx prisma generate && npx jest`
Expected: all pass at the same count as going into this task, minus the two deleted test files' test counts, with zero new failures elsewhere (confirming, per Step 1, that nothing outside the auth module ever depended on `Role`/`RolesGuard`).

- [ ] **Step 9: Commit**

```bash
git add orchestrator/src/modules/auth/auth.module.ts orchestrator/src/modules/auth/auth.controller.ts orchestrator/src/modules/auth/session.service.ts orchestrator/src/modules/auth/azure-ad.provider.ts orchestrator/test/session.service.spec.ts orchestrator/test/auth.controller.e2e-spec.ts orchestrator/prisma/schema.prisma orchestrator/prisma/migrations
git commit -m "refactor(orchestrator): remove RBAC scaffolding (Role enum, RolesGuard) — dead code with zero runtime effect; ADO's own permission system is the real access-control gate per architecture.md's own locked decision"
```

---

### Task 6: CA-trust TLS for on-prem ADO

**Files:**
- Modify: `mcp-ado-server/src/backends/realAdo.ts`
- Test: `mcp-ado-server/test/realAdo.test.ts` (append)

**Interfaces:** None new — `AdoMcpConfig.caCertPath` already exists (Phase 7); this task makes `RealAdoBackend` actually read and use it.

**Boundary:** Only touch the one file listed (plus its test). Do not modify `config/env.ts` — `caCertPath`/`ADO_CA_CERT` parsing is already correct.

- [ ] **Step 1: Confirm the exact current gap**

Run: `grep -n "caCertPath" mcp-ado-server/src/backends/realAdo.ts`
Expected: zero matches inside `realAdo.ts` itself — confirming the field is read into config but never consumed here.

- [ ] **Step 2: Construct an `https.Agent` with the CA bundle when configured**

```typescript
// mcp-ado-server/src/backends/realAdo.ts
import { readFileSync } from 'fs';
import https from 'https';
import axios, { type AxiosInstance } from 'axios';
// ... existing imports ...

function buildHttpClient(config: AdoMcpConfig): AxiosInstance {
  if (!config.caCertPath) {
    // On-prem ADO with a CA-issued (not self-signed) cert, or dev/mock use —
    // default TLS trust store is correct here, no custom agent needed.
    return axios.create();
  }
  // Self-signed on-prem TLS: trust ONLY this specific CA bundle, never
  // `rejectUnauthorized: false` (that disables trust entirely — an
  // explicit anti-pattern this project's own architecture doc rules out).
  const ca = readFileSync(config.caCertPath);
  return axios.create({ httpsAgent: new https.Agent({ ca }) });
}

export class RealAdoBackend implements AdoBackend {
  private httpClient: AxiosInstance;
  private resolvedApiVersion: string | null = null;

  constructor(
    private readonly config: AdoMcpConfig,
    private readonly credential: AdoCredential,
  ) {
    this.httpClient = buildHttpClient(config);
  }

  // ... rest of the class unchanged ...
}
```

- [ ] **Step 3: Tests**

```typescript
// Append to mcp-ado-server/test/realAdo.test.ts
import { readFileSync } from 'fs';
jest.mock('fs');

it('constructs an https.Agent with the CA bundle when caCertPath is configured', () => {
  (readFileSync as jest.Mock).mockReturnValue(Buffer.from('fake-ca-cert-content'));
  const backend = new RealAdoBackend({ ...testConfig, caCertPath: '/fake/ca.pem' }, testCredential);
  // Assert via the backend's own httpClient having a real httpsAgent — expose
  // enough for this test (e.g. a test-only getter, or inspect
  // (backend as any).httpClient.defaults.httpsAgent) matching whatever
  // introspection pattern this test file already uses for similar checks.
  expect(readFileSync).toHaveBeenCalledWith('/fake/ca.pem');
});

it('uses the default axios instance (no custom agent) when caCertPath is unset', () => {
  const backend = new RealAdoBackend({ ...testConfig, caCertPath: undefined }, testCredential);
  expect(readFileSync).not.toHaveBeenCalled();
});
```

- [ ] **Step 4: Run the full mcp-ado-server suite**

Run: `cd mcp-ado-server && npx vitest run` — confirm no regressions (baseline going into this task: 47/47 plus whatever Task 1 added), new tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp-ado-server/src/backends/realAdo.ts mcp-ado-server/test/realAdo.test.ts
git commit -m "fix(mcp-ado-server): actually consume ADO_CA_CERT for on-prem self-signed TLS trust, was parsed but unused"
```

---

## Self-Review Notes

- **Every fix targets a real, verified gap, not a generic checklist item:** all six tasks trace to specific file:line findings from a Phase 8 cross-validation review against `docs/architecture.md` (`mcp-ado-server/src/index.ts`'s own blocking `throw`, `JobsService.confirm()`'s hardcoded `('Requirement', {})` call with no `linkParentChild`, `jobs.controller.ts`'s option-less `FileInterceptor`, `RolesGuard`'s confirmed-dead-code no-op behavior, and `caCertPath` being parsed in `env.ts` but never read in `realAdo.ts`).
- **Task 5 is a removal, not a build-out, per explicit user direction:** the original draft of this plan proposed adding an admin-elevation path on top of the existing RBAC scaffolding; the user redirected to remove RBAC entirely instead — PAT/ADO-account scope is enough, matching `docs/architecture.md`'s own locked decision that ADO's own permission system is the real access-control gate. A full trace of every `Role`/`RolesGuard`/`toDomainRole` reference was done before writing the removal task, confirming zero runtime authorization effect anywhere today (no `@Roles()` call sites, no code that ever reads `.role` back off a decoded session JWT) — this is a safe, contained removal, not a behavior change to any real request path.
- **Task 2 required zero new Python logic, confirmed by direct code inspection before writing this plan:** `ingestion/app/leveling/tree_builder.py`'s `build_baseline_tree` already computes `parent_local_id` via a depth-stack per branch, and `ingestion/app/main.py`'s `/level` route returns the full `WorkItemNode` (including that field) with no filtering. The entire gap was TypeScript interfaces silently not naming a field that was already present in the JSON payload.
- **PAT-persistence rule held throughout:** Task 1 explicitly does NOT store a PAT anywhere server-side across requests — it requires the credential on each write-triggering call (`POST /jobs/:id/confirm`), matching the architecture's literal "in-memory/session only, never persisted" locked decision applied to every request, not just the login screen.
- **Real ADO verification honestly scoped:** Task 1's Step 8 explicitly instructs reporting "unverified in this environment" if real on-prem ADO access isn't available, rather than faking a pass — matching this project's own established, consistently-applied convention from every prior phase (Phase 1's OCR/Tesseract note, Phase 7.5/8's golden E2E honesty notes).
- **No scope creep into the explicitly-deferred items:** SSE, vision, SURVEY/dedup pipeline wiring, deploy/nginx, remaining docs, frontend Preview/Results/Settings pages, and shared/ codegen are all named explicitly in Global Constraints as OUT OF SCOPE for this phase — real, tracked gaps, not silently dropped, but each is either a larger feature-completion effort (SURVEY/dedup wiring) or lower production-blocking severity (docs, SSE) than the three critical items this phase closes.
- **No placeholders:** every step contains complete, runnable code where the target file's shape is already known from direct inspection; the few explicitly-flagged judgment calls (Step 4/Task 3's DI token name, Task 5's exact env-var-injection test pattern) are flagged as "grep the existing pattern first" rather than guessed, matching Phase 8's own precedent for handling implementer judgment calls honestly.
