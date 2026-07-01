# Phase 0 Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a working, testable skeleton of all four core Phase 0 services (mcp-ado-server, orchestrator, frontend, infra) so `docker-compose up` runs them, tests are green, app login + RBAC guard work, and the mock ADO backend can create/link work items — matching the DoD in `docs/architecture.md` Phase 0 row.

**Architecture:** Two independent TS packages (`mcp-ado-server`, `orchestrator`) plus one frontend package (`frontend`), each buildable and testable standalone, wired together at the end via `docker-compose.yml` (already scaffolded at repo root). `ingestion` (Python) and `chroma` are out of scope for this plan — later phases.

**Tech Stack:** TypeScript/Node 22 (NestJS for orchestrator, `@modelcontextprotocol/sdk` + Express for mcp-ado-server, `better-sqlite3` for the mock backend), React 19 + Vite + MUI for frontend, Prisma + Postgres, vitest (mcp-ado-server) / jest (orchestrator) / vitest (frontend).

## Global Constraints

- On-prem ADO only: api-version ladder `7.1 → 5.1 → none` (already encoded in `mcp-ado-server/src/config/env.ts`).
- PAT is **never** persisted to disk or logged — header-passed, in-memory only. Any log statement touching a PAT-shaped string must go through `redactPat()` (`mcp-ado-server/src/auth/patAuth.ts`, already written).
- MCP transport = **Streamable HTTP** with bearer auth (no stdio).
- Orchestrator uses **NestJS** DI patterns: thin controllers, logic in services, Zod validation at the boundary, no `console.log` (use a logger).
- Database = **Postgres via Prisma**.
- App auth = **Azure AD** login + **RBAC** roles `admin | operator | viewer` (Azure AD tenant creds may not exist yet in dev — stub the token-exchange call behind an interface so the guard/role logic is real and testable without a live tenant).
- Do not touch `ingestion/`, `shared/schemas/*.json`, or `docs/architecture.md` in this plan — those are out of scope.
- Do not modify `mcp-ado-server/src/config/env.ts` or `mcp-ado-server/src/auth/patAuth.ts` — already correct, only import from them.

---

### Task 1: Mock ADO backend (SQLite) behind a shared tool contract

**Files:**
- Create: `mcp-ado-server/src/backends/types.ts`
- Create: `mcp-ado-server/src/backends/mockAdo.ts`
- Test: `mcp-ado-server/test/mockAdo.test.ts`

**Interfaces:**
- Produces: `AdoBackend` interface (`createWorkItem`, `getWorkItem`, `linkParentChild`, `queryIds`, `ping`) — Task 2 (server bootstrap) and later real-backend tasks implement/consume this.
- Produces: `WorkItemRecord { id: number; type: 'Epic'|'Feature'|'Requirement'; fields: Record<string,string>; parentId: number|null }`.

- [ ] **Step 1: Write the failing test**

```ts
// mcp-ado-server/test/mockAdo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { MockAdoBackend } from '../src/backends/mockAdo';

describe('MockAdoBackend', () => {
  let backend: MockAdoBackend;

  beforeEach(() => {
    backend = new MockAdoBackend(':memory:');
  });

  it('creates a work item and assigns an incrementing id', async () => {
    const item = await backend.createWorkItem({
      type: 'Epic',
      fields: { 'System.Title': 'Receiver', 'System.State': 'Proposed' },
    });
    expect(item.id).toBe(1);
    expect(item.type).toBe('Epic');
    expect(item.parentId).toBeNull();
  });

  it('links a child to a parent via Hierarchy-Reverse', async () => {
    const parent = await backend.createWorkItem({ type: 'Epic', fields: { 'System.Title': 'Receiver' } });
    const child = await backend.createWorkItem({ type: 'Feature', fields: { 'System.Title': 'Broadcast & Inputs' } });
    await backend.linkParentChild(child.id, parent.id);
    const fetched = await backend.getWorkItem(child.id);
    expect(fetched?.parentId).toBe(parent.id);
  });

  it('queryIds finds items by exact field match, scoped by area path field if present', async () => {
    await backend.createWorkItem({ type: 'Requirement', fields: { 'System.Title': 'Channel scan', 'System.AreaPath': 'ProjectX\\TV' } });
    const ids = await backend.queryIds({ 'System.AreaPath': 'ProjectX\\TV' });
    expect(ids).toHaveLength(1);
  });

  it('ping returns ok:true', async () => {
    expect(await backend.ping()).toEqual({ ok: true, backend: 'mock' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-ado-server && npx vitest run test/mockAdo.test.ts`
Expected: FAIL — `Cannot find module '../src/backends/mockAdo'`

- [ ] **Step 3: Write the shared backend contract**

```ts
// mcp-ado-server/src/backends/types.ts
/**
 * Backend-agnostic contract for ADO work-item operations. `MockAdoBackend`
 * (this phase) and a future `RealAdoBackend` (Phase 7) both implement this,
 * so MCP tools never need to know which one is wired in.
 */
export type WorkItemType = 'Epic' | 'Feature' | 'Requirement';

export interface WorkItemRecord {
  id: number;
  type: WorkItemType;
  fields: Record<string, string>;
  parentId: number | null;
}

export interface CreateWorkItemInput {
  type: WorkItemType;
  fields: Record<string, string>;
}

export interface AdoBackend {
  ping(): Promise<{ ok: true; backend: 'mock' | 'real' }>;
  createWorkItem(input: CreateWorkItemInput): Promise<WorkItemRecord>;
  getWorkItem(id: number): Promise<WorkItemRecord | null>;
  linkParentChild(childId: number, parentId: number): Promise<void>;
  /** Exact-match field query, used for dedup/idempotency lookups (later phases) and tests here. */
  queryIds(fieldMatch: Record<string, string>): Promise<number[]>;
}
```

- [ ] **Step 4: Implement the mock backend**

```ts
// mcp-ado-server/src/backends/mockAdo.ts
import Database from 'better-sqlite3';
import type { AdoBackend, CreateWorkItemInput, WorkItemRecord, WorkItemType } from './types.js';

/**
 * SQLite-backed ADO stand-in for off-network development and tests.
 * Schema is intentionally flat: one row per work item, fields as a JSON blob,
 * parent_id nullable for the hierarchy link. Good enough to exercise the same
 * MCP tool contract the real ADO REST backend will fulfill in Phase 7.
 */
export class MockAdoBackend implements AdoBackend {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        fields TEXT NOT NULL,
        parent_id INTEGER
      );
    `);
  }

  async ping(): Promise<{ ok: true; backend: 'mock' }> {
    return { ok: true, backend: 'mock' };
  }

  async createWorkItem(input: CreateWorkItemInput): Promise<WorkItemRecord> {
    const stmt = this.db.prepare(
      'INSERT INTO work_items (type, fields, parent_id) VALUES (?, ?, NULL)',
    );
    const result = stmt.run(input.type, JSON.stringify(input.fields));
    return { id: Number(result.lastInsertRowid), type: input.type, fields: input.fields, parentId: null };
  }

  async getWorkItem(id: number): Promise<WorkItemRecord | null> {
    const row = this.db
      .prepare('SELECT id, type, fields, parent_id as parentId FROM work_items WHERE id = ?')
      .get(id) as { id: number; type: WorkItemType; fields: string; parentId: number | null } | undefined;
    if (!row) return null;
    return { id: row.id, type: row.type, fields: JSON.parse(row.fields), parentId: row.parentId };
  }

  async linkParentChild(childId: number, parentId: number): Promise<void> {
    this.db.prepare('UPDATE work_items SET parent_id = ? WHERE id = ?').run(parentId, childId);
  }

  async queryIds(fieldMatch: Record<string, string>): Promise<number[]> {
    const rows = this.db.prepare('SELECT id, fields FROM work_items').all() as { id: number; fields: string }[];
    return rows
      .filter((row) => {
        const fields = JSON.parse(row.fields) as Record<string, string>;
        return Object.entries(fieldMatch).every(([key, value]) => fields[key] === value);
      })
      .map((row) => row.id);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd mcp-ado-server && npx vitest run test/mockAdo.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add mcp-ado-server/src/backends/types.ts mcp-ado-server/src/backends/mockAdo.ts mcp-ado-server/test/mockAdo.test.ts
git commit -m "feat(mcp-ado-server): add mock ADO backend behind shared contract"
```

---

### Task 2: MCP server bootstrap (Streamable HTTP, bearer auth, ping tool)

**Files:**
- Create: `mcp-ado-server/src/server.ts`
- Create: `mcp-ado-server/src/index.ts`
- Create: `mcp-ado-server/src/tools/pingTool.ts`
- Test: `mcp-ado-server/test/server.test.ts`

**Interfaces:**
- Consumes: `loadConfig()` from `src/config/env.ts` (produces `AdoMcpConfig`, already written), `AdoBackend`/`MockAdoBackend` from Task 1.
- Produces: `createMcpApp(backend: AdoBackend, cfg: AdoMcpConfig): express.Express` — later tool tasks (Phase 7) register more tools on the same `McpServer` instance built inside this function.

**Boundary:** Do not implement `create_work_item` / `link_parent_child` / other write tools here — those come in Phase 7 once the real ADO client exists. This task only wires transport + auth + the `ado_ping` tool.

- [ ] **Step 1: Write the failing test**

```ts
// mcp-ado-server/test/server.test.ts
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createMcpApp } from '../src/server';
import { MockAdoBackend } from '../src/backends/mockAdo';
import type { AdoMcpConfig } from '../src/config/env';

const testConfig: AdoMcpConfig = {
  adoBaseUrl: '',
  adoProject: '',
  apiVersionLadder: ['7.1', '5.1', 'none'],
  batchSize: 200,
  concurrency: 8,
  mcpBearer: 'test-bearer-token',
  port: 0,
  backend: 'mock',
  mockDbPath: ':memory:',
};

describe('MCP server HTTP transport', () => {
  it('rejects requests without a bearer token', async () => {
    const app = createMcpApp(new MockAdoBackend(':memory:'), testConfig);
    const res = await request(app).post('/mcp').send({});
    expect(res.status).toBe(401);
  });

  it('rejects requests with the wrong bearer token', async () => {
    const app = createMcpApp(new MockAdoBackend(':memory:'), testConfig);
    const res = await request(app).post('/mcp').set('Authorization', 'Bearer wrong').send({});
    expect(res.status).toBe(401);
  });

  it('exposes a plain health endpoint with no auth required', async () => {
    const app = createMcpApp(new MockAdoBackend(':memory:'), testConfig);
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, backend: 'mock' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-ado-server && npm install --save-dev supertest @types/supertest && npx vitest run test/server.test.ts`
Expected: FAIL — `Cannot find module '../src/server'`

- [ ] **Step 3: Write the ping tool**

```ts
// mcp-ado-server/src/tools/pingTool.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdoBackend } from '../backends/types.js';

/** Registers `ado_ping` — a trivial liveness/backend-identity check for MCP clients. */
export function registerPingTool(server: McpServer, backend: AdoBackend): void {
  server.registerTool(
    'ado_ping',
    {
      title: 'Ping the ADO backend',
      description: 'Returns which backend (mock|real) is wired in and confirms it is reachable.',
      inputSchema: {},
    },
    async () => {
      const result = await backend.ping();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );
}
```

- [ ] **Step 4: Write the server bootstrap with bearer auth**

```ts
// mcp-ado-server/src/server.ts
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AdoBackend } from './backends/types.js';
import type { AdoMcpConfig } from './config/env.js';
import { registerPingTool } from './tools/pingTool.js';

/**
 * Builds the Express app hosting the MCP Streamable HTTP transport.
 * `/health` is unauthenticated (container/orchestrator health checks).
 * `/mcp` requires `Authorization: Bearer <cfg.mcpBearer>` on every request.
 */
export function createMcpApp(backend: AdoBackend, cfg: AdoMcpConfig): express.Express {
  const app = express();
  app.use(express.json());

  app.get('/health', async (_req, res) => {
    res.json(await backend.ping());
  });

  app.use('/mcp', (req, res, next) => {
    const header = req.header('authorization') ?? '';
    if (header !== `Bearer ${cfg.mcpBearer}`) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  const mcpServer = new McpServer({ name: 'req2ado-ado-mcp-server', version: '0.1.0' });
  registerPingTool(mcpServer, backend);

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  app.post('/mcp', async (req, res) => {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}
```

- [ ] **Step 5: Write the entry point**

```ts
// mcp-ado-server/src/index.ts
import { createMcpApp } from './server.js';
import { loadConfig } from './config/env.js';
import { MockAdoBackend } from './backends/mockAdo.js';

const cfg = loadConfig();
const backend = cfg.backend === 'mock' ? new MockAdoBackend(cfg.mockDbPath) : undefined;
if (!backend) {
  throw new Error('Real ADO backend is not implemented until Phase 7 — set ADO_BACKEND=mock for now.');
}

const app = createMcpApp(backend, cfg);
app.listen(cfg.port, () => {
  // eslint-disable-next-line no-console -- startup banner, not app logging
  process.stdout.write(`req2ado mcp-ado-server listening on :${cfg.port} (backend=${cfg.backend})\n`);
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd mcp-ado-server && npx vitest run test/server.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Commit**

```bash
git add mcp-ado-server/src/server.ts mcp-ado-server/src/index.ts mcp-ado-server/src/tools/pingTool.ts mcp-ado-server/test/server.test.ts mcp-ado-server/package.json mcp-ado-server/package-lock.json
git commit -m "feat(mcp-ado-server): bootstrap Streamable HTTP transport with bearer auth and ado_ping tool"
```

---

### Task 3: mcp-ado-server test harness (vitest config)

**Files:**
- Create: `mcp-ado-server/vitest.config.ts`

**Boundary:** Only this file. Do not touch `orchestrator/` or `frontend/` here.

- [ ] **Step 1: Write the config**

```ts
// mcp-ado-server/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: { reporter: ['text', 'lcov'] },
  },
});
```

- [ ] **Step 2: Run the full suite to confirm the harness works end to end**

Run: `cd mcp-ado-server && npx vitest run`
Expected: PASS — 7 tests total (4 from Task 1, 3 from Task 2)

- [ ] **Step 3: Commit**

```bash
git add mcp-ado-server/vitest.config.ts
git commit -m "chore(mcp-ado-server): add vitest config"
```

---

### Task 4: Orchestrator NestJS bootstrap + config module + health endpoint

**Files:**
- Create: `orchestrator/src/main.ts`
- Create: `orchestrator/src/app.module.ts`
- Create: `orchestrator/src/config/config.schema.ts`
- Create: `orchestrator/src/config/config.module.ts`
- Create: `orchestrator/src/modules/health/health.controller.ts`
- Create: `orchestrator/src/modules/health/health.module.ts`
- Test: `orchestrator/test/health.e2e-spec.ts`
- Create: `orchestrator/jest.config.js`

**Interfaces:**
- Produces: `AppConfig` type (zod-validated) exported from `config.schema.ts` — Task 5 (Prisma/auth) and Task 6 (frontend wiring) both read config the same way via `ConfigService<AppConfig>`.
- Produces: `GET /health` → `{ ok: true }`.

**Boundary:** No Prisma, no auth logic here — stub `AppModule` imports only `ConfigModule` and `HealthModule`. Task 5 adds `AuthModule`/`PrismaModule` as siblings.

- [ ] **Step 1: Write the config schema**

```ts
// orchestrator/src/config/config.schema.ts
import { z } from 'zod';

/**
 * Validated shape of process.env for the orchestrator. Fields mirror
 * `config.yaml` / `.env.template` at the repo root — see docs/architecture.md
 * section 2b. Anything missing here throws at boot, not at first use.
 */
export const configSchema = z.object({
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  MCP_URL: z.string().min(1),
  MCP_BEARER: z.string().min(1),
  AUTH_PROVIDER: z.enum(['azure_ad', 'local']).default('azure_ad'),
  AZURE_AD_TENANT_ID: z.string().optional(),
  AZURE_AD_CLIENT_ID: z.string().optional(),
  AZURE_AD_CLIENT_SECRET: z.string().optional(),
});

export type AppConfig = z.infer<typeof configSchema>;
```

- [ ] **Step 2: Write the config module**

```ts
// orchestrator/src/config/config.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { configSchema } from './config.schema.js';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      validate: (env) => configSchema.parse(env),
    }),
  ],
})
export class ConfigModule {}
```

- [ ] **Step 3: Write the health module**

```ts
// orchestrator/src/modules/health/health.controller.ts
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check(): { ok: true } {
    return { ok: true };
  }
}
```

```ts
// orchestrator/src/modules/health/health.module.ts
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';

@Module({ controllers: [HealthController] })
export class HealthModule {}
```

- [ ] **Step 4: Write the app module and main entry**

```ts
// orchestrator/src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './modules/health/health.module.js';

@Module({
  imports: [ConfigModule, HealthModule],
})
export class AppModule {}
```

```ts
// orchestrator/src/main.ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
}

void bootstrap();
```

- [ ] **Step 5: Write the failing e2e test**

```ts
// orchestrator/test/health.e2e-spec.ts
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('HealthController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgresql://req2ado:req2ado@localhost:5432/req2ado';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.MCP_URL = 'http://localhost:4100';
    process.env.MCP_BEARER = 'test-bearer';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns ok:true', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
```

- [ ] **Step 6: Add jest config**

```js
// orchestrator/jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.e2e-spec.ts', '<rootDir>/src/**/*.spec.ts'],
};
```

- [ ] **Step 7: Install missing dev deps, run test to verify it fails then passes**

Run: `cd orchestrator && npm install --save-dev supertest @types/supertest ts-node && npx jest`
Expected first (before Step 4 files exist): FAIL — module not found. After Steps 1-6: PASS (1 test).

- [ ] **Step 8: Commit**

```bash
git add orchestrator/src/main.ts orchestrator/src/app.module.ts orchestrator/src/config orchestrator/src/modules/health orchestrator/test/health.e2e-spec.ts orchestrator/jest.config.js orchestrator/package.json orchestrator/package-lock.json
git commit -m "feat(orchestrator): bootstrap NestJS app with validated config and health endpoint"
```

---

### Task 5: Prisma schema + Azure AD login (stubbed) + RBAC guard

**Files:**
- Create: `orchestrator/prisma/schema.prisma`
- Create: `orchestrator/src/modules/auth/roles.enum.ts`
- Create: `orchestrator/src/modules/auth/azure-ad.provider.ts`
- Create: `orchestrator/src/modules/auth/roles.guard.ts`
- Create: `orchestrator/src/modules/auth/roles.decorator.ts`
- Create: `orchestrator/src/modules/auth/auth.module.ts`
- Test: `orchestrator/test/roles.guard.spec.ts`

**Interfaces:**
- Consumes: `AppConfig` (Task 4).
- Produces: `Role` enum (`Admin | Operator | Viewer`), `@Roles(...roles: Role[])` decorator, `RolesGuard` — later tasks/phases put `@Roles(Role.Operator)` + `@UseGuards(RolesGuard)` on job-submission routes.
- Produces: `AzureAdProvider.exchangeCode(code: string): Promise<{ email: string; role: Role }>` — swap the stub body for a real MSAL call once tenant creds exist; the interface does not change.

**Boundary:** Do not build the `/auth/login` HTTP controller yet (needs frontend redirect-URI coordination — defer to a later task once frontend Task 6 exists). This task delivers the guard + role logic + Prisma models only, fully unit-testable without a live Azure tenant.

- [ ] **Step 1: Write the Prisma schema**

```prisma
// orchestrator/prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  ADMIN
  OPERATOR
  VIEWER
}

model User {
  id        String   @id @default(uuid())
  email     String   @unique
  role      Role     @default(VIEWER)
  createdAt DateTime @default(now())
  jobs      Job[]
}

model Job {
  id          String    @id @default(uuid())
  userId      String
  user        User      @relation(fields: [userId], references: [id])
  mode        String // "baseline" | "survey"
  status      String // "pending" | "running" | "succeeded" | "failed"
  sourceHash  String
  createdAt   DateTime  @default(now())
  completedAt DateTime?
  auditEntries AuditEntry[]
}

model AuditEntry {
  id        String   @id @default(uuid())
  jobId     String
  job       Job      @relation(fields: [jobId], references: [id])
  message   String
  createdAt DateTime @default(now())
}

// Idempotency map: prevents duplicate ADO writes on job re-run.
// See docs/architecture.md 1c: (source_hash, customer_id, area_path) -> System.Id
model IdempotencyMapping {
  id           String @id @default(uuid())
  sourceHash   String
  customerId   String
  areaPath     String
  adoWorkItemId Int

  @@unique([sourceHash, customerId, areaPath])
}
```

- [ ] **Step 2: Write the Role enum and decorator**

```ts
// orchestrator/src/modules/auth/roles.enum.ts
export enum Role {
  Admin = 'admin',
  Operator = 'operator',
  Viewer = 'viewer',
}
```

```ts
// orchestrator/src/modules/auth/roles.decorator.ts
import { SetMetadata } from '@nestjs/common';
import type { Role } from './roles.enum.js';

export const ROLES_KEY = 'roles';
/** Attach to a controller method: `@Roles(Role.Operator)` — enforced by `RolesGuard`. */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);
```

- [ ] **Step 3: Write the RBAC guard**

```ts
// orchestrator/src/modules/auth/roles.guard.ts
import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator.js';
import type { Role } from './roles.enum.js';

interface RequestWithUser {
  user?: { role: Role };
}

/**
 * Reads the `@Roles(...)` metadata off the handler and denies unless
 * `request.user.role` (set upstream by the auth middleware once it exists)
 * is one of the allowed roles. No roles declared => allow (public route).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const userRole = request.user?.role;
    if (!userRole || !requiredRoles.includes(userRole)) {
      throw new ForbiddenException(`Requires one of roles: ${requiredRoles.join(', ')}`);
    }
    return true;
  }
}
```

- [ ] **Step 4: Write the Azure AD provider stub**

```ts
// orchestrator/src/modules/auth/azure-ad.provider.ts
import { Injectable } from '@nestjs/common';
import { Role } from './roles.enum.js';

export interface AzureAdUser {
  email: string;
  role: Role;
}

/**
 * Wraps the Azure AD auth-code exchange behind a stable interface so the
 * rest of the app never talks to MSAL directly. Until real tenant
 * credentials are configured (`AZURE_AD_*` env vars), `exchangeCode`
 * returns a deterministic stub user — swap the method body for a real
 * `@azure/msal-node` call without touching any caller.
 */
@Injectable()
export class AzureAdProvider {
  async exchangeCode(code: string): Promise<AzureAdUser> {
    if (!code) {
      throw new Error('Missing authorization code');
    }
    // TODO(Phase 0 follow-up, real tenant): replace with ConfidentialClientApplication.acquireTokenByCode
    return { email: 'dev-user@example.com', role: Role.Operator };
  }
}
```

- [ ] **Step 5: Write the auth module**

```ts
// orchestrator/src/modules/auth/auth.module.ts
import { Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { AzureAdProvider } from './azure-ad.provider.js';
import { RolesGuard } from './roles.guard.js';

@Module({
  providers: [
    AzureAdProvider,
    Reflector,
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AzureAdProvider],
})
export class AuthModule {}
```

- [ ] **Step 6: Write the failing guard test**

```ts
// orchestrator/test/roles.guard.spec.ts
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { RolesGuard } from '../src/modules/auth/roles.guard';
import { Role } from '../src/modules/auth/roles.enum';
import { ROLES_KEY } from '../src/modules/auth/roles.decorator';

function makeContext(role: Role | undefined, requiredRoles: Role[] | undefined): ExecutionContext {
  const reflectorSpy = jest.spyOn(Reflector.prototype, 'getAllAndOverride').mockReturnValue(requiredRoles);
  const context = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user: role ? { role } : undefined }) }),
  } as unknown as ExecutionContext;
  return Object.assign(context, { __reflectorSpy: reflectorSpy });
}

describe('RolesGuard', () => {
  afterEach(() => jest.restoreAllMocks());

  it('allows access when no roles are required', () => {
    const guard = new RolesGuard(new Reflector());
    const context = makeContext(undefined, undefined);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows access when user role matches a required role', () => {
    const guard = new RolesGuard(new Reflector());
    const context = makeContext(Role.Operator, [Role.Operator, Role.Admin]);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('denies access when user role does not match', () => {
    const guard = new RolesGuard(new Reflector());
    const context = makeContext(Role.Viewer, [Role.Operator, Role.Admin]);
    expect(() => guard.canActivate(context)).toThrow('Requires one of roles: operator, admin');
  });

  it('denies access when no user is present', () => {
    const guard = new RolesGuard(new Reflector());
    const context = makeContext(undefined, [Role.Admin]);
    expect(() => guard.canActivate(context)).toThrow('Requires one of roles: admin');
  });
});
```

- [ ] **Step 7: Run test to verify it fails, then passes**

Run: `cd orchestrator && npx jest test/roles.guard.spec.ts`
Expected before Steps 2-5: FAIL — modules not found. After: PASS (4 tests).

- [ ] **Step 8: Wire AuthModule into AppModule**

```ts
// orchestrator/src/app.module.ts  (replace existing content)
import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { AuthModule } from './modules/auth/auth.module.js';

@Module({
  imports: [ConfigModule, HealthModule, AuthModule],
})
export class AppModule {}
```

- [ ] **Step 9: Run the full orchestrator suite**

Run: `cd orchestrator && npx jest`
Expected: PASS (5 tests: 1 health e2e + 4 guard unit)

- [ ] **Step 10: Commit**

```bash
git add orchestrator/prisma/schema.prisma orchestrator/src/modules/auth orchestrator/src/app.module.ts orchestrator/test/roles.guard.spec.ts orchestrator/package.json orchestrator/package-lock.json
git commit -m "feat(orchestrator): add Prisma schema, RBAC guard, and stubbed Azure AD provider"
```

---

### Task 6: Frontend app shell (DocGen visual language) + Login page

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/tsconfig.json`
- Create: `frontend/index.html`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/theme/tokens.ts`
- Create: `frontend/src/theme/AppThemeProvider.tsx`
- Create: `frontend/src/pages/Login.tsx`
- Create: `frontend/src/api/httpClient.ts`
- Test: `frontend/src/pages/Login.test.tsx`
- Create: `frontend/vitest.config.ts`
- Create: `frontend/src/test/setup.ts`

**Interfaces:**
- Produces: `themeTokens` object and `AppThemeProvider` — every later page/component imports theme from here, never inline hex colors (per CLAUDE.md UI conventions: "no ad hoc inline styles").
- Produces: `<Login>` page that POSTs `{ adoOrgUrl, pat }` to `POST /connection/validate` via `httpClient` and shows success/error — PAT is held in component state only, never `localStorage`.

**Boundary:** Do not wire real Azure AD redirect flow yet (needs a live tenant + orchestrator `/auth/login` route from a later task) — render a "Sign in" button that is presently a no-op placeholder with a code comment explaining why, and focus this task's testable surface on the PAT-entry form + theme.

- [ ] **Step 1: Scaffold package.json and configs**

```json
// frontend/package.json
{
  "name": "@req2ado/frontend",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "lint": "eslint \"src/**/*.{ts,tsx}\"",
    "test": "vitest run"
  },
  "dependencies": {
    "@emotion/react": "^11.13.3",
    "@emotion/styled": "^11.13.0",
    "@mui/material": "^6.1.1",
    "axios": "^1.7.7",
    "mobx": "^6.13.3",
    "mobx-react-lite": "^4.0.7",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.5.0",
    "@testing-library/react": "^16.0.1",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.1",
    "jsdom": "^25.0.0",
    "typescript": "^5.6.2",
    "vite": "^5.4.6",
    "vitest": "^2.1.1"
  }
}
```

```ts
// frontend/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
```

```json
// frontend/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

```html
<!-- frontend/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>req2ado</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Write the design tokens (DocGen visual language)**

```ts
// frontend/src/theme/tokens.ts
/**
 * Design tokens shared across the app — mirrors the token-based approach
 * used by docgen-frontend's src/theme/tokens.js and
 * ado-hierarchy-viewer/frontend's MUI theme. Never inline hex colors in
 * components; import from here.
 */
export const themeTokens = {
  color: {
    primary: '#2451B7',
    primaryDark: '#173a8a',
    surface: '#FFFFFF',
    surfaceAlt: '#F4F6FB',
    border: '#D8DEE9',
    textPrimary: '#1B2430',
    textSecondary: '#5B6472',
    danger: '#C4314B',
    success: '#2E7D32',
  },
  radius: { sm: 4, md: 8, lg: 16 },
  spacing: (multiplier: number): number => multiplier * 8,
} as const;
```

```tsx
// frontend/src/theme/AppThemeProvider.tsx
import { createTheme, ThemeProvider, CssBaseline } from '@mui/material';
import type { ReactNode } from 'react';
import { themeTokens } from './tokens.js';

const theme = createTheme({
  palette: {
    primary: { main: themeTokens.color.primary, dark: themeTokens.color.primaryDark },
    background: { default: themeTokens.color.surfaceAlt, paper: themeTokens.color.surface },
    text: { primary: themeTokens.color.textPrimary, secondary: themeTokens.color.textSecondary },
    error: { main: themeTokens.color.danger },
    success: { main: themeTokens.color.success },
  },
  shape: { borderRadius: themeTokens.radius.md },
});

export function AppThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}
```

- [ ] **Step 3: Write the http client**

```ts
// frontend/src/api/httpClient.ts
import axios from 'axios';

/** Base axios instance for the orchestrator API. PAT/org-url are attached per-request by callers — never stored here. */
export const httpClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001',
});
```

- [ ] **Step 4: Write the Login page**

```tsx
// frontend/src/pages/Login.tsx
import { useState } from 'react';
import { Box, Button, Stack, TextField, Typography, Alert } from '@mui/material';
import { httpClient } from '../api/httpClient.js';

/**
 * Two-step entry: (1) app-level sign-in via Azure AD [placeholder until a
 * live tenant + orchestrator /auth/login route exist], (2) per-user ADO PAT
 * entry. The PAT lives only in this component's state — never persisted to
 * localStorage/sessionStorage/disk, and sent as a header on each request
 * rather than stored server-side (see docs/architecture.md "PAT entry").
 */
export function Login(): JSX.Element {
  const [adoOrgUrl, setAdoOrgUrl] = useState('');
  const [pat, setPat] = useState('');
  const [status, setStatus] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleValidate = async (): Promise<void> => {
    setStatus('checking');
    setErrorMessage(null);
    try {
      await httpClient.post(
        '/connection/validate',
        {},
        { headers: { 'X-Ado-Org-Url': adoOrgUrl, 'X-Ado-Pat': pat } },
      );
      setStatus('ok');
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Connection failed');
    }
  };

  return (
    <Box sx={{ maxWidth: 420, mx: 'auto', mt: 8 }}>
      <Typography variant="h5" gutterBottom>
        Sign in to req2ado
      </Typography>

      {/* Azure AD sign-in is wired once a tenant + orchestrator /auth/login route exist (tracked separately). */}
      <Button variant="outlined" fullWidth disabled sx={{ mb: 3 }}>
        Sign in with Azure AD (coming soon)
      </Button>

      <Stack spacing={2}>
        <TextField
          label="ADO Organization URL"
          value={adoOrgUrl}
          onChange={(e) => setAdoOrgUrl(e.target.value)}
          fullWidth
        />
        <TextField
          label="Personal Access Token"
          type="password"
          value={pat}
          onChange={(e) => setPat(e.target.value)}
          fullWidth
        />
        <Button variant="contained" onClick={handleValidate} disabled={!adoOrgUrl || !pat || status === 'checking'}>
          Validate connection
        </Button>
        {status === 'ok' && <Alert severity="success">Connection validated.</Alert>}
        {status === 'error' && <Alert severity="error">{errorMessage}</Alert>}
      </Stack>
    </Box>
  );
}
```

- [ ] **Step 5: Write App and main entry**

```tsx
// frontend/src/App.tsx
import { AppThemeProvider } from './theme/AppThemeProvider.js';
import { Login } from './pages/Login.js';

export function App(): JSX.Element {
  return (
    <AppThemeProvider>
      <Login />
    </AppThemeProvider>
  );
}
```

```tsx
// frontend/src/main.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 6: Write the failing Login test**

```tsx
// frontend/src/pages/Login.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Login } from './Login';
import { httpClient } from '../api/httpClient';

describe('Login page', () => {
  afterEach(() => vi.restoreAllMocks());

  it('disables the validate button until both fields are filled', () => {
    render(<Login />);
    expect(screen.getByText('Validate connection')).toBeDisabled();
  });

  it('shows a success alert when validation succeeds', async () => {
    vi.spyOn(httpClient, 'post').mockResolvedValueOnce({ data: { ok: true } });

    render(<Login />);
    fireEvent.change(screen.getByLabelText('ADO Organization URL'), { target: { value: 'https://tfs.internal/tfs/Collection' } });
    fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'fake-pat' } });
    fireEvent.click(screen.getByText('Validate connection'));

    await waitFor(() => expect(screen.getByText('Connection validated.')).toBeInTheDocument());
    expect(httpClient.post).toHaveBeenCalledWith(
      '/connection/validate',
      {},
      { headers: { 'X-Ado-Org-Url': 'https://tfs.internal/tfs/Collection', 'X-Ado-Pat': 'fake-pat' } },
    );
  });

  it('shows an error alert when validation fails', async () => {
    vi.spyOn(httpClient, 'post').mockRejectedValueOnce(new Error('bad credentials'));

    render(<Login />);
    fireEvent.change(screen.getByLabelText('ADO Organization URL'), { target: { value: 'https://tfs.internal/tfs/Collection' } });
    fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'fake-pat' } });
    fireEvent.click(screen.getByText('Validate connection'));

    await waitFor(() => expect(screen.getByText('bad credentials')).toBeInTheDocument());
  });
});
```

- [ ] **Step 7: Add vitest config and DOM test setup**

```ts
// frontend/vitest.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
  },
});
```

```ts
// frontend/src/test/setup.ts
import '@testing-library/jest-dom';
```

- [ ] **Step 8: Install deps, run test to verify it fails then passes**

Run: `cd frontend && npm install && npx vitest run src/pages/Login.test.tsx`
Expected before Steps 4-5 exist: FAIL — module not found. After: PASS (3 tests).

- [ ] **Step 9: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): scaffold Vite/React/MUI app shell with theme tokens and PAT-entry login page"
```

---

### Task 7: docker-compose validation for core services

**Files:**
- Create: `mcp-ado-server/Dockerfile`
- Create: `orchestrator/Dockerfile`
- Modify: `docker-compose.yml` (already exists at repo root — comment out `chroma` and `ingestion` services, since Phase 0 does not build them yet; leave `frontend` in, pointing at a Dockerfile added in a later frontend-hardening task if it doesn't build headless yet)

**Boundary:** Only touch `docker-compose.yml`, `mcp-ado-server/Dockerfile`, `orchestrator/Dockerfile`. Do not add a `frontend/Dockerfile` in this task — if `docker-compose up` for `frontend`/`ingestion` fails, comment those two services out with a `# Phase 1+` note rather than debugging their builds here.

- [ ] **Step 1: Write the mcp-ado-server Dockerfile**

```dockerfile
# mcp-ado-server/Dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
EXPOSE 4100
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Write the orchestrator Dockerfile**

```dockerfile
# orchestrator/Dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json nest-cli.json* ./
COPY src ./src
COPY prisma ./prisma
RUN npx prisma generate
RUN npm run build
EXPOSE 3001
CMD ["node", "dist/main.js"]
```

- [ ] **Step 3: Comment out not-yet-buildable services in docker-compose.yml**

Edit `docker-compose.yml`: prefix the `chroma`, `ingestion`, and `frontend` service blocks with `# Phase 1+ — not built in Phase 0` and comment out their lines (keep `postgres`, `redis`, `mcp-ado-server`, `orchestrator` active). Also remove `orchestrator`'s `depends_on: ingestion` line since that service is now commented out.

- [ ] **Step 4: Build and run the four core services**

Run: `docker-compose up -d --build postgres redis mcp-ado-server orchestrator`
Expected: all four containers report `Up` (or healthy) via `docker-compose ps`.

Run: `curl -s http://localhost:4100/health` — Expected: `{"ok":true,"backend":"mock"}`
Run: `curl -s http://localhost:3001/health` — Expected: `{"ok":true}`

- [ ] **Step 5: Tear down and commit**

```bash
docker-compose down
git add mcp-ado-server/Dockerfile orchestrator/Dockerfile docker-compose.yml
git commit -m "chore(deploy): add Dockerfiles and enable core services in docker-compose for Phase 0"
```

---

## Self-Review Notes

- **Spec coverage:** mock ADO backend (Task 1), MCP bootstrap (Task 2-3), NestJS bootstrap (Task 4), Prisma + RBAC + Azure AD stub (Task 5), GUI shell + PAT login (Task 6), docker-compose (Task 7) — all five DoD bullets from `docs/architecture.md` Phase 0 row are covered except the live Azure AD redirect and the real `/connection/validate` orchestrator endpoint, both explicitly deferred as follow-up tasks once a tenant exists / once Task 5's `AzureAdProvider` gets a real `/auth/login` controller wired to it — call these out to the user before declaring Phase 0 fully done.
- **Type consistency:** `AdoBackend` (Task 1) is consumed as-is in Task 2's `createMcpApp(backend: AdoBackend, ...)`. `AppConfig` (Task 4) is the only config type referenced in Task 5. `Role` enum values (`admin|operator|viewer`) match `docs/architecture.md`'s locked decision and Prisma's `Role` enum (`ADMIN|OPERATOR|VIEWER` — Prisma convention is upper-case; the guard test asserts lower-case `Role` TS enum values, which is intentional since the TS enum is the app-facing contract, not the DB enum).
- **Known follow-up (not in this plan):** a real `orchestrator` `POST /connection/validate` controller that calls the MCP server's `ado_ping` tool — Task 6's Login test mocks this endpoint; wiring the real controller is a small, separate task once Task 2's MCP client story exists in the orchestrator (Phase 7 territory, but a thin stub returning `{ok:true}` could be added as an 8th task if the user wants `docker-compose up` + a live login to fully round-trip before moving to Phase 1).
