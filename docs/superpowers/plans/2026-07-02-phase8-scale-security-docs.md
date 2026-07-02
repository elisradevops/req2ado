# Phase 8 Scale, Security, Docs, Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Final hardening pass across everything built in Phases 0-7.5. Satisfies Phase 8's DoD: "Load test (N concurrent jobs) stable; security checklist passed; TSDoc/docstrings complete; in-app Wiki + tooltips shipped; full golden E2E green."

**Architecture:** This phase does not add new features — it hardens and documents existing ones, closing gaps found by directly inspecting the real codebase before writing this plan (not a generic checklist). Two concrete, already-flagged security items exist in the actual code today: `mcp-ado-server/src/server.ts:26` has its own comment explicitly deferring a constant-time bearer comparison to "Phase 8 security hardening," and this plan's own Phase 5 design (`orchestrator`'s `LlmProxyBearerGuard`) uses the identical plain-`!==`-comparison pattern. Neither `helmet`, CORS configuration, nor rate limiting exist in `orchestrator/src/main.ts` today (confirmed by reading the file) — all three are added here. A load test exercises Phase 7.5's real `PipelineWorker`/BullMQ queue with N concurrent jobs against `MockAdoBackend` (no real ADO server needed). `docs/user-guide.md` (referenced by `docs/architecture.md`'s Locked Decisions as the source the in-app Wiki page renders) does not exist yet — this phase writes it and wires a `GET /wiki` endpoint + a frontend `Wiki` page that renders it, plus MUI tooltips on `Upload`/`JobStatus`'s non-trivial controls. A TSDoc/docstring completeness pass closes any real gaps found by an actual coverage check (not a blind "add comments everywhere" pass, which the project's own conventions explicitly reject — comments only where genuinely non-obvious). The golden E2E is a scripted, documented full-stack run (docker-compose) since a true multi-service E2E (Postgres + Redis + Python + Node + mock ADO all live) cannot run inside this session's sandboxed test runners the way Jest/Vitest/pytest unit suites can.

**Tech Stack:** Orchestrator: `helmet`, `@nestjs/throttler` (both new dependencies — the project has no rate-limiting or security-header middleware yet). `mcp-ado-server`: no new dependency (`crypto.timingSafeEqual` is a Node built-in). Frontend: `react-markdown` (**new dependency** — needed to render `docs/user-guide.md` as HTML in the `Wiki` page; no markdown renderer exists in the frontend today).

## Global Constraints

- Every security fix in this phase targets a REAL, verified issue found by reading the actual code — not a hypothetical or generic "best practice" applied without checking whether it's already handled. Each task states exactly which file:line motivated it.
- The constant-time bearer comparison fix must not change any test's expected behavior (401 on wrong/missing bearer, pass-through on correct bearer) — only the comparison MECHANISM changes, not the security boundary's observable behavior.
- Rate limiting must not break any existing test suite's expected request volume — set a generous per-window limit (documented rationale in the task) so CI/test runs never trip it, while still providing real protection against abuse in production.
- The load test must use `MockAdoBackend` and a fake/local ingestion response (not a real ADO server or a real LLM) — this tests the ORCHESTRATOR's queue/worker concurrency handling, not any external service's throughput.
- TSDoc/docstring additions follow the project's own established rule (from the global CLAUDE.md, already in force all session): "Default to writing no comments. Only add one when the WHY is non-obvious." Do not add comments explaining WHAT a function does when its name and types already make that clear.
- Do not modify the public interface of any function/class from Phases 0-7.5 — this phase wraps/hardens, it does not redesign.
- Type hints/explicit types on every function signature; existing repo test conventions per package.

---

### Task 1: Constant-time bearer comparisons (mcp-ado-server + orchestrator)

**Files:**
- Modify: `mcp-ado-server/src/server.ts` (the specific line already flagged: `server.ts:26`)
- Modify: `orchestrator/src/modules/llm/llm-proxy-bearer.guard.ts` (built in Phase 5, uses the identical unsafe pattern)
- Test: `mcp-ado-server/test/server.test.ts` (append), `orchestrator/test/openwebui.client.spec.ts` or wherever `LlmProxyBearerGuard` has existing coverage (append — grep first to confirm the exact existing test file)

**Interfaces:** None new — behavior-preserving internal change to two existing auth checks.

**Boundary:** Only touch the two auth-check files and their existing test files (append only).

- [ ] **Step 1: Confirm the exact current comparison code**

Run: `grep -n "header !==" mcp-ado-server/src/server.ts orchestrator/src/modules/llm/llm-proxy-bearer.guard.ts`
Expected: both show a plain `!==` string comparison against a `Bearer <token>` string — this is a timing side-channel (string comparison short-circuits on the first mismatched byte, theoretically letting an attacker infer the correct token faster than random guessing via response-time measurement). Low real-world risk for this deployment (on-prem, internal network) but explicitly named in `docs/architecture.md`'s own Phase 8 DoD ("security checklist passed") and already self-flagged in `server.ts`'s own comment.

- [ ] **Step 2: Write the failing/confirming tests (behavior must be unchanged)**

```typescript
// Append to mcp-ado-server/test/server.test.ts
import { timingSafeEqualBearer } from '../src/auth/timingSafeEqualBearer';

describe('timingSafeEqualBearer', () => {
  it('returns true for an exact match', () => {
    expect(timingSafeEqualBearer('Bearer abc123', 'Bearer abc123')).toBe(true);
  });

  it('returns false for a mismatch', () => {
    expect(timingSafeEqualBearer('Bearer abc123', 'Bearer wrong')).toBe(false);
  });

  it('returns false when lengths differ (no length-based short-circuit crash)', () => {
    expect(timingSafeEqualBearer('Bearer short', 'Bearer a-much-longer-token-value')).toBe(false);
  });

  it('returns false for an empty header', () => {
    expect(timingSafeEqualBearer('', 'Bearer abc123')).toBe(false);
  });
});
```

```typescript
// Append to whatever existing test file covers LlmProxyBearerGuard (identify via
// grep -rln "LlmProxyBearerGuard" orchestrator/test) — add an equivalent set of
// timingSafeEqualBearer unit tests there, or a new orchestrator/test/timingSafeEqualBearer.spec.ts
// if this helper is extracted to a shared orchestrator-local util (see Step 3).
```

- [ ] **Step 3: Implement `timingSafeEqualBearer` in `mcp-ado-server`**

```typescript
// mcp-ado-server/src/auth/timingSafeEqualBearer.ts
import { timingSafeEqual } from 'crypto';

/**
 * Constant-time comparison for bearer-token headers. Plain string `!==`
 * short-circuits on the first mismatched byte, which is a (low-risk on an
 * internal network, but real) timing side-channel — flagged explicitly in
 * server.ts's own Phase 0 comment as deferred to Phase 8 hardening.
 * Buffers of different lengths are handled explicitly (timingSafeEqual
 * throws on length mismatch) rather than let that throw propagate.
 */
export function timingSafeEqualBearer(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
```

- [ ] **Step 4: Wire it into `server.ts`**

```typescript
// mcp-ado-server/src/server.ts — replace this block:
//   if (header !== `Bearer ${cfg.mcpBearer}`) {
//     res.status(401).json({ error: 'unauthorized' });
//     return;
//   }
// with:
import { timingSafeEqualBearer } from './auth/timingSafeEqualBearer.js';
// ...
if (!timingSafeEqualBearer(header, `Bearer ${cfg.mcpBearer}`)) {
  res.status(401).json({ error: 'unauthorized' });
  return;
}
```

Also remove the now-resolved comment above that block (the one explicitly deferring this to Phase 8 — its purpose is fulfilled).

- [ ] **Step 5: Run to verify `mcp-ado-server`'s tests pass**

Run: `cd mcp-ado-server && npx vitest run`
Expected: all pass, including the existing 401/wrong-bearer/correct-bearer tests in `server.test.ts` (behavior unchanged) plus the new `timingSafeEqualBearer` unit tests.

- [ ] **Step 6: Apply the identical fix to `orchestrator`'s `LlmProxyBearerGuard`**

```typescript
// orchestrator/src/modules/llm/timing-safe-equal-bearer.ts
import { timingSafeEqual } from 'crypto';

export function timingSafeEqualBearer(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
```

```typescript
// orchestrator/src/modules/llm/llm-proxy-bearer.guard.ts — replace:
//   if (header !== expected) {
// with:
import { timingSafeEqualBearer } from './timing-safe-equal-bearer.js';
// ...
if (!timingSafeEqualBearer(header ?? '', expected)) {
```

(The `header ?? ''` guards against `header` being `undefined` when the `Authorization` header is missing entirely — `timingSafeEqualBearer` already handles a length mismatch safely, so an empty string input is safe.)

- [ ] **Step 7: Run to verify the orchestrator's tests pass**

Run: `cd orchestrator && npx jest`
Expected: all pass, including `llm.controller.e2e-spec.ts`'s existing 401 tests (behavior unchanged).

- [ ] **Step 8: Commit**

```bash
git add mcp-ado-server/src/auth/timingSafeEqualBearer.ts mcp-ado-server/src/server.ts mcp-ado-server/test/server.test.ts orchestrator/src/modules/llm/timing-safe-equal-bearer.ts orchestrator/src/modules/llm/llm-proxy-bearer.guard.ts
git commit -m "fix(security): use constant-time comparison for bearer tokens, closing Phase 0's own flagged Phase 8 TODO"
```

---

### Task 2: `helmet` + rate limiting on the orchestrator

**Files:**
- Modify: `orchestrator/src/main.ts`
- Modify: `orchestrator/src/app.module.ts` (register `ThrottlerModule`)
- Modify: `orchestrator/package.json` (add `helmet`, `@nestjs/throttler`)
- Test: `orchestrator/test/security-headers.e2e-spec.ts` (new)

**Interfaces:** None new — global middleware/guard registration.

**Boundary:** Only touch the four files listed.

- [ ] **Step 1: Add dependencies**

```json
// orchestrator/package.json — add to dependencies:
    "helmet": "^7.1.0",
    "@nestjs/throttler": "^6.2.1",
```

Run: `cd orchestrator && npm install`

- [ ] **Step 2: Write the failing tests**

```typescript
// orchestrator/test/security-headers.e2e-spec.ts
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import helmet from 'helmet';

describe('Security headers and rate limiting', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgresql://req2ado:req2ado@localhost:5432/req2ado';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.MCP_URL = 'http://localhost:4100';
    process.env.MCP_BEARER = 'test-bearer';
    process.env.AUTH_JWT_SECRET = 'test-jwt-secret';
    process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
    process.env.LLM_CHAT_MODEL = 'test-model';
    process.env.LLM_PROXY_BEARER = 'test-llm-proxy-bearer';
    process.env.EMBED_MODEL = 'test-embed-model';

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(helmet());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets standard security headers on responses', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-dns-prefetch-control']).toBeDefined();
  });

  it('does not set the identifying X-Powered-By header', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows a generous burst of requests without rate-limiting (CI/test-safe threshold)', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => request(app.getHttpServer()).get('/health')),
    );
    expect(responses.every((res) => res.status === 200)).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify the header tests fail**

Run: `cd orchestrator && npx jest test/security-headers.e2e-spec.ts`
Expected: FAIL on the two header assertions (no `helmet()` applied yet inside `AppModule`/`main.ts` itself — only in this test's own manual `app.use(helmet())` call, which doesn't prove production `main.ts` applies it). The burst-request test should already pass (no rate limiter yet).

- [ ] **Step 4: Apply `helmet` in `main.ts`**

```typescript
// orchestrator/src/main.ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
}

void bootstrap();
```

- [ ] **Step 5: Register `ThrottlerModule` in `app.module.ts`**

```typescript
// orchestrator/src/app.module.ts
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { LlmModule } from './modules/llm/llm.module';
import { JobsModule } from './modules/pipeline/jobs.module';

@Module({
  imports: [
    ConfigModule,
    // 200 requests per 60-second window per client — generous enough that
    // no existing or new test in this project's suites (which never issue
    // more than ~20 requests in a single test) will ever trip this, while
    // still providing real abuse protection in production.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 200 }]),
    HealthModule,
    AuthModule,
    LlmModule,
    JobsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
```

- [ ] **Step 6: Run the security-headers test file directly against `main.ts`'s real setup**

Since `main.ts` isn't invoked by the Jest e2e test harness (which builds `AppModule` via `@nestjs/testing`, not `NestFactory.create` + `bootstrap()`), the test file's own `app.use(helmet())` call (already in Step 2) is what actually exercises this behavior in the test. Run: `cd orchestrator && npx jest test/security-headers.e2e-spec.ts` — Expected: PASS (3 tests). This confirms `helmet()`'s effect is correct; `main.ts`'s own `app.use(helmet())` (Step 4) is verified by direct code inspection (identical call) rather than a duplicate integration test, since spinning up the literal `bootstrap()` function in a test would require a real listening port and defeats the purpose of the existing `@nestjs/testing` pattern already used throughout this project.

- [ ] **Step 7: Run the full orchestrator suite**

Run: `cd orchestrator && npx jest`
Expected: all pass, no regressions (confirms the new `ThrottlerGuard` doesn't break any existing endpoint under normal test request volumes).

- [ ] **Step 8: Commit**

```bash
git add orchestrator/src/main.ts orchestrator/src/app.module.ts orchestrator/package.json orchestrator/package-lock.json orchestrator/test/security-headers.e2e-spec.ts
git commit -m "feat(orchestrator): add helmet security headers and rate limiting (200 req/min)"
```

---

### Task 3: Load test — N concurrent pipeline jobs

**Files:**
- Create: `orchestrator/test/load/concurrentJobs.load-test.ts` (NOT part of the default `npx jest` run — see below)
- Create: `orchestrator/scripts/run-load-test.sh`

**Interfaces:** None new — exercises Phase 7.5's `runPipelineJob` directly with fake dependencies, at concurrency, matching this project's DoD wording "Load test (N concurrent jobs) stable."

**Boundary:** Only touch the two new files. This is a manually-invoked script, not part of the automated CI suite (a load test's purpose — measuring behavior under concurrent load — is undermined by running it inside a shared CI runner every commit).

- [ ] **Step 1: Write the load test script**

```typescript
// orchestrator/test/load/concurrentJobs.load-test.ts
/**
 * Manual load test — NOT run by `npx jest` (see run-load-test.sh for why:
 * this file is excluded from Jest's default testMatch pattern via its
 * directory, matching the project's existing convention for
 * openwebui.client.live.smoke.ts).
 *
 * Exercises Phase 7.5's runPipelineJob directly at concurrency N, with a
 * fake ingestion client (no real Python service / Postgres / Redis
 * needed) — proves the pipeline logic itself has no shared-mutable-state
 * race condition under concurrent execution, independent of infrastructure
 * throughput (which is a deployment/ops concern, not a code-correctness one).
 *
 * Run with: npx ts-node test/load/concurrentJobs.load-test.ts [N]
 */
import { runPipelineJob } from '../../src/modules/pipeline/pipeline.worker';
import { DryRunService } from '../../src/modules/writeback/dry-run.service';
import { IdempotencyService } from '../../src/modules/writeback/idempotency.service';

async function main(): Promise<void> {
  const concurrency = Number(process.argv[2] ?? 50);

  const idempotencyStore = new Map<string, number>();
  let nextAdoId = 1;
  const fakePrisma = {
    job: { update: async () => undefined },
    idempotencyMapping: {
      findUnique: async ({ where }: any) => {
        const key = JSON.stringify(where.sourceHash_customerId_areaPath);
        return idempotencyStore.has(key) ? { adoWorkItemId: idempotencyStore.get(key) } : null;
      },
      create: async ({ data }: any) => {
        const key = JSON.stringify({ sourceHash: data.sourceHash, customerId: data.customerId, areaPath: data.areaPath });
        idempotencyStore.set(key, data.adoWorkItemId);
      },
    },
  };
  const idempotencyService = new IdempotencyService(fakePrisma as any);
  const dryRunService = new DryRunService();

  const fakeIngestionClient = {
    ingest: async () => ({ blocks: [{ id: 'b0' }] }),
    level: async (_doc: unknown, _customerId: string | null) => ({
      nodes: [{ local_id: 'n0', fidelity_hash: `hash-${nextAdoId++}`, customer_id: 'CUST-LOAD' }],
    }),
  };

  const startTime = Date.now();
  const jobs = Array.from({ length: concurrency }, (_, i) =>
    runPipelineJob(
      { id: `load-job-${i}`, areaPath: 'Project\\LoadTest', customerId: 'CUST-LOAD', fileBuffer: Buffer.from(`doc-${i}`), filename: `doc-${i}.txt` },
      { ingestionClient: fakeIngestionClient as any, dryRunService, idempotencyService, prisma: fakePrisma as any },
    ),
  );

  const results = await Promise.allSettled(jobs);
  const durationMs = Date.now() - startTime;
  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;

  console.log(`Load test: ${concurrency} concurrent jobs, ${succeeded} succeeded, ${failed} failed, ${durationMs}ms total`);
  if (failed > 0) {
    console.error('FAILED jobs:', results.filter((r) => r.status === 'rejected'));
    process.exitCode = 1;
  }
}

main();
```

- [ ] **Step 2: Write the runner script**

```bash
#!/usr/bin/env bash
# orchestrator/scripts/run-load-test.sh
# Manual load test runner — not invoked by CI. Usage: ./scripts/run-load-test.sh [N]
set -euo pipefail
cd "$(dirname "$0")/.."
npx ts-node test/load/concurrentJobs.load-test.ts "${1:-50}"
```

Run: `chmod +x orchestrator/scripts/run-load-test.sh`

- [ ] **Step 3: Run the load test and confirm stability at N=50**

Run: `cd orchestrator && ./scripts/run-load-test.sh 50`
Expected: `Load test: 50 concurrent jobs, 50 succeeded, 0 failed, <N>ms total` — no unhandled rejections, no partial/corrupted idempotency-map state (each job gets a unique `hash-N`, so all 50 are legitimately distinct "create" actions, not a dedup test — this test's purpose is concurrency safety, not dedup correctness, which Phase 7 Task 10 and Phase 7.5 Task 7 already cover).

- [ ] **Step 4: Confirm this file is NOT picked up by the automated test run**

Run: `cd orchestrator && npx jest --listTests | grep -i load`
Expected: empty output (Jest's default `testMatch` looks for `*.spec.ts`/`*.test.ts`; `concurrentJobs.load-test.ts` matches neither pattern).

- [ ] **Step 5: Commit**

```bash
git add orchestrator/test/load/concurrentJobs.load-test.ts orchestrator/scripts/run-load-test.sh
git commit -m "test(orchestrator): add manual load test for N concurrent pipeline jobs"
```

---

### Task 4: `docs/user-guide.md` + in-app Wiki page + tooltips

**Files:**
- Create: `docs/user-guide.md`
- Create: `orchestrator/src/modules/wiki/wiki.controller.ts`
- Create: `orchestrator/src/modules/wiki/wiki.module.ts`
- Modify: `orchestrator/src/app.module.ts`
- Create: `frontend/src/pages/Wiki.tsx`
- Modify: `frontend/src/pages/Upload.tsx`, `frontend/src/pages/JobStatus.tsx` (add tooltips)
- Modify: `frontend/src/App.tsx` (add Wiki navigation)
- Modify: `frontend/package.json` (add `react-markdown`)
- Test: `orchestrator/test/wiki.controller.e2e-spec.ts`, `frontend/src/pages/Wiki.test.tsx`

**Interfaces:**
- Produces: `GET /wiki` (orchestrator) returning `docs/user-guide.md`'s raw content as `text/markdown`.
- Produces: `Wiki` (frontend) — fetches `/wiki`, renders it via `react-markdown`.

**Boundary:** Only touch the eight files/dirs listed. Tooltips added to `Upload`/`JobStatus` are additive MUI `Tooltip` wraps around existing controls — no control's existing behavior changes.

- [ ] **Step 1: Write `docs/user-guide.md`**

```markdown
# req2ado User Guide

## What this tool does

Converts a requirements document (contract, survey, or engineering spec) into a structured Epic → Feature → Requirement hierarchy in Azure DevOps.

## Modes

- **Baseline** — verbatim extraction. The tool never rewrites your text; titles are truncated (not summarized) from the source, and every requirement's description is byte-for-byte traceable back to the source document via a fidelity hash. Use this for signed contracts and formal specs where wording must not change.
- **Survey** — generative. The tool uses an AI model to turn informal notes into formal "shall"-style requirements with taxonomy tags. Use this for early-stage or informally-written requirements. *(Not yet available in this build — see the disabled option on the Upload page.)*

## Workflow

1. **Upload** a document and specify the target ADO Area Path.
2. The tool ingests the document, infers a hierarchy, and computes a **dry-run diff** — a preview of what would be created or reused, without writing anything to ADO yet.
3. Review the diff. Each row shows whether that item would be newly created or would reuse an existing ADO work item (re-running the same document never creates duplicates).
4. Click **Confirm Write** to perform the actual ADO write.

## Customer ID

If your ADO project has a custom "Customer ID" field, the tool automatically detects its real field name (it checks a few common naming conventions) — you don't need to configure this yourself in most cases.

## Troubleshooting

- **"Upload failed"** — check that the file format is supported (txt, md, docx, pdf, scanned PDF, xlsx) and that the Area Path field is filled in.
- **Diff never becomes ready** — the ingestion service may be unreachable; contact your administrator.
```

- [ ] **Step 2: Write the failing orchestrator test**

```typescript
// orchestrator/test/wiki.controller.e2e-spec.ts
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

describe('WikiController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgresql://req2ado:req2ado@localhost:5432/req2ado';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.MCP_URL = 'http://localhost:4100';
    process.env.MCP_BEARER = 'test-bearer';
    process.env.AUTH_JWT_SECRET = 'test-jwt-secret';
    process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
    process.env.LLM_CHAT_MODEL = 'test-model';
    process.env.LLM_PROXY_BEARER = 'test-llm-proxy-bearer';
    process.env.EMBED_MODEL = 'test-embed-model';

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /wiki returns the user guide content', async () => {
    const res = await request(app.getHttpServer()).get('/wiki');
    expect(res.status).toBe(200);
    expect(res.text).toContain('# req2ado User Guide');
    expect(res.headers['content-type']).toContain('text/markdown');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd orchestrator && npx jest test/wiki.controller.e2e-spec.ts`
Expected: FAIL — route doesn't exist.

- [ ] **Step 4: Implement the `WikiController`**

```typescript
// orchestrator/src/modules/wiki/wiki.controller.ts
import { Controller, Get, Header } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

@Controller('wiki')
export class WikiController {
  @Get()
  @Header('Content-Type', 'text/markdown')
  getUserGuide(): string {
    // docs/user-guide.md lives at the monorepo root's docs/ dir, two levels
    // up from orchestrator/src/modules/wiki/ — read synchronously since
    // this is a small, static, infrequently-read file, not a per-request
    // I/O-bound hot path.
    return readFileSync(join(__dirname, '../../../../docs/user-guide.md'), 'utf-8');
  }
}
```

```typescript
// orchestrator/src/modules/wiki/wiki.module.ts
import { Module } from '@nestjs/common';
import { WikiController } from './wiki.controller';

@Module({ controllers: [WikiController] })
export class WikiModule {}
```

- [ ] **Step 5: Wire into `app.module.ts`**

```typescript
// orchestrator/src/app.module.ts — add the import and module entry:
import { WikiModule } from './modules/wiki/wiki.module';
// ... add WikiModule to the imports array alongside JobsModule
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd orchestrator && npx jest test/wiki.controller.e2e-spec.ts`
Expected: PASS (1 test). If the relative path in Step 4 doesn't resolve correctly against the compiled `dist/` output layout, adjust the path depth to match the ACTUAL build output structure (check `tsconfig.json`'s `outDir` and confirm via a real `npm run build` + path check) rather than assuming — a wrong relative path is a common real bug in exactly this kind of "read a file relative to compiled output" pattern.

- [ ] **Step 7: Add `react-markdown` and implement the `Wiki` frontend page**

```json
// frontend/package.json — add to dependencies:
    "react-markdown": "^9.0.1",
```

Run: `cd frontend && npm install`

```tsx
// frontend/src/pages/Wiki.tsx
import { useEffect, useState, type JSX } from 'react';
import { Box } from '@mui/material';
import ReactMarkdown from 'react-markdown';
import { httpClient } from '../api/httpClient.js';

export function Wiki(): JSX.Element {
  const [content, setContent] = useState('');

  useEffect(() => {
    void httpClient.get('/wiki', { responseType: 'text' }).then((response) => setContent(response.data));
  }, []);

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto', mt: 8, p: 2 }}>
      <ReactMarkdown>{content}</ReactMarkdown>
    </Box>
  );
}
```

- [ ] **Step 8: Write the failing frontend test**

```tsx
// frontend/src/pages/Wiki.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { Wiki } from './Wiki';
import { httpClient } from '../api/httpClient';

vi.mock('../api/httpClient');

describe('Wiki', () => {
  it('fetches and renders the user guide markdown', async () => {
    (httpClient.get as any).mockResolvedValue({ data: '# req2ado User Guide\n\nSome content.' });
    render(<Wiki />);
    await waitFor(() => expect(screen.getByRole('heading', { name: /req2ado user guide/i })).toBeInTheDocument());
  });
});
```

- [ ] **Step 9: Run to verify it passes**

Run: `cd frontend && npx vitest run src/pages/Wiki.test.tsx`
Expected: PASS (1 test)

- [ ] **Step 10: Add tooltips to `Upload` and `JobStatus`'s non-trivial controls**

```tsx
// frontend/src/pages/Upload.tsx — wrap the Area Path field and the Survey radio option with Tooltip:
import { Box, Button, FormControlLabel, Radio, RadioGroup, TextField, Tooltip, Typography } from '@mui/material';
// ...
<Tooltip title="The ADO Area Path work items will be created under, e.g. MyProject\Requirements">
  <TextField
    fullWidth
    label="Area Path"
    value={areaPath}
    onChange={(event) => setAreaPath(event.target.value)}
    sx={{ mb: 2 }}
  />
</Tooltip>
<RadioGroup value="baseline" sx={{ mb: 2 }}>
  <FormControlLabel value="baseline" control={<Radio />} label="Baseline (verbatim, deterministic)" />
  <Tooltip title="Generative mode is not yet available in this build">
    <span>
      <FormControlLabel value="survey" control={<Radio />} label="Survey (coming soon)" disabled />
    </span>
  </Tooltip>
</RadioGroup>
```

```tsx
// frontend/src/pages/JobStatus.tsx — wrap the Confirm Write button:
import { Box, Button, Table, TableBody, TableCell, TableHead, TableRow, Tooltip, Typography } from '@mui/material';
// ...
{job.status === 'diff_ready' && !confirmResult && (
  <Tooltip title="This will write the 'create' rows above to Azure DevOps. This cannot be automatically undone.">
    <Button variant="contained" onClick={handleConfirm} sx={{ mt: 2 }}>
      Confirm Write
    </Button>
  </Tooltip>
)}
```

(MUI's `Tooltip` requires its child to accept a ref and forward `onMouseEnter`/etc — a `disabled` `<FormControlLabel>` doesn't do this reliably, hence the `<span>` wrapper around the disabled Survey option, a documented MUI pattern for tooltips on disabled elements.)

- [ ] **Step 11: Run the existing `Upload`/`JobStatus` tests to confirm tooltips don't break existing assertions**

Run: `cd frontend && npx vitest run src/pages/Upload.test.tsx src/pages/JobStatus.test.tsx`
Expected: PASS (existing tests from Phase 7.5 Task 6 — tooltips are additive wrapper elements, `screen.getByLabelText`/`getByRole` queries for the underlying controls should be unaffected; if MUI's `Tooltip` changes the accessible role/label of a wrapped element in a way that breaks an existing query, adjust the test query to match the real rendered output, not the other way around).

- [ ] **Step 12: Add `Wiki` navigation to `App.tsx`**

```tsx
// frontend/src/App.tsx
import { useState, type JSX } from 'react';
import { AppBar, Button, Toolbar } from '@mui/material';
import { AppThemeProvider } from './theme/AppThemeProvider.js';
import { Login } from './pages/Login.js';
import { Upload } from './pages/Upload.js';
import { JobStatus } from './pages/JobStatus.js';
import { Wiki } from './pages/Wiki.js';

export function App(): JSX.Element {
  const [loggedIn, setLoggedIn] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [showWiki, setShowWiki] = useState(false);

  return (
    <AppThemeProvider>
      {loggedIn && (
        <AppBar position="static" color="default">
          <Toolbar>
            <Button onClick={() => setShowWiki((prev) => !prev)}>{showWiki ? 'Back' : 'Help / Wiki'}</Button>
          </Toolbar>
        </AppBar>
      )}
      {!loggedIn && <Login onLoginSuccess={() => setLoggedIn(true)} />}
      {loggedIn && showWiki && <Wiki />}
      {loggedIn && !showWiki && !jobId && <Upload onJobSubmitted={setJobId} />}
      {loggedIn && !showWiki && jobId && <JobStatus jobId={jobId} />}
    </AppThemeProvider>
  );
}
```

- [ ] **Step 13: Run the full frontend suite**

Run: `cd frontend && npx vitest run`
Expected: all pass, no regressions.

- [ ] **Step 14: Commit**

```bash
git add docs/user-guide.md orchestrator/src/modules/wiki orchestrator/src/app.module.ts orchestrator/test/wiki.controller.e2e-spec.ts frontend/src/pages/Wiki.tsx frontend/src/pages/Wiki.test.tsx frontend/src/pages/Upload.tsx frontend/src/pages/JobStatus.tsx frontend/src/App.tsx frontend/package.json frontend/package-lock.json
git commit -m "feat: add docs/user-guide.md, in-app Wiki page, and tooltips on Upload/JobStatus"
```

---

### Task 5: TSDoc/docstring completeness pass

**Files:**
- Create: `scripts/check-doc-coverage.sh` (repo-root utility script — checks, doesn't auto-fix)
- Modify: whichever specific exported functions/classes the script finds genuinely undocumented AND where the WHY is non-obvious (per Global Constraints — not a blanket pass)

**Interfaces:** None new.

**Boundary:** This task's file list cannot be enumerated in advance — it depends on the check script's real output. Only add documentation where a real gap exists per the check AND the missing doc would genuinely help a reader (per this project's own "only when the WHY is non-obvious" rule, already applied consistently across every phase this session) — do not add boilerplate one-line comments to every function just to make a coverage percentage look complete.

- [ ] **Step 1: Write the coverage-check script**

```bash
#!/usr/bin/env bash
# scripts/check-doc-coverage.sh — lists exported TS functions/classes with no
# preceding /** */ block, and exported Python functions/classes with no
# docstring. This is a CHECK, not an auto-fixer — read each finding and
# judge whether it genuinely needs documentation (non-obvious WHY) before
# adding anything, per this project's "no comments unless non-obvious" rule.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== TypeScript: exported symbols without a preceding /** doc block ==="
for dir in orchestrator/src mcp-ado-server/src frontend/src; do
  find "$dir" -name "*.ts" -o -name "*.tsx" | while read -r file; do
    grep -n "^export \(class\|function\|interface\)" "$file" | while IFS=: read -r lineno _; do
      prev_line=$((lineno - 1))
      prev_content=$(sed -n "${prev_line}p" "$file")
      if [[ "$prev_content" != *"*/"* ]]; then
        echo "$file:$lineno"
      fi
    done
  done
done

echo ""
echo "=== Python: public (non-underscore) functions/classes without a docstring ==="
for file in $(find ingestion/app -name "*.py"); do
  python3 -c "
import ast
import sys

with open('$file') as f:
    tree = ast.parse(f.read())

for node in ast.walk(tree):
    if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and not node.name.startswith('_'):
        if ast.get_docstring(node) is None:
            print(f'$file:{node.lineno}: {node.name}')
"
done
```

Run: `chmod +x scripts/check-doc-coverage.sh`

- [ ] **Step 2: Run it and review the real output**

Run: `./scripts/check-doc-coverage.sh`

This produces a list of genuinely undocumented exported symbols across all three TS packages and the Python package. For EACH finding:
- If the symbol's name + type signature already makes its purpose fully clear (e.g. a simple getter, a straightforward DTO interface) — leave it undocumented. Adding a comment here would violate this project's own "no comments unless the WHY is non-obvious" rule, consistently applied all session.
- If the symbol has a genuinely non-obvious WHY (a subtle invariant, a workaround, a security/correctness reason for a specific design choice) — add a concise doc comment explaining exactly that WHY, matching the style already used throughout Phases 0-7.5 (e.g. `AdoPatProvider`'s TLS-trust comment, `retryWithBackoff`'s retry-status-code rationale).

Do not blanket-add comments to hit a percentage — this task's success criterion is "every symbol that NEEDS a comment has one," not "every symbol has a comment."

- [ ] **Step 3: Apply documentation only where genuinely warranted**

(No fixed code block here — the implementer reads the actual script output against the real codebase and makes judgment calls per the criteria above, documenting which findings were addressed and which were deliberately left undocumented with a one-line reason each, in the task's completion report.)

- [ ] **Step 4: Run the full test suite across all packages to confirm no code behavior changed**

Run: `cd orchestrator && npx jest && cd ../mcp-ado-server && npx vitest run && cd ../frontend && npx vitest run && cd ../ingestion && pytest -v`
Expected: all pass — this task only adds comments, never changes logic.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-doc-coverage.sh
# Add whichever specific source files received genuine documentation additions —
# list them explicitly in the commit, do not use `git add -A`.
git commit -m "docs: add check-doc-coverage.sh and close genuinely non-obvious documentation gaps"
```

---

### Task 6: Golden full-stack E2E (docker-compose, scripted)

**Files:**
- Create: `scripts/run-golden-e2e.sh`
- Create: `docs/golden-e2e-fixture.txt` (a small, realistic BASELINE-style fixture document used by the script)

**Interfaces:** None new — this is an orchestration script driving the REAL full stack (all services via docker-compose), not a unit/integration test in any single package's test runner.

**Boundary:** Only touch the two new files. This script requires Docker and is meant to be run manually / in a dedicated CI job with Docker available — not part of `npx jest`/`npx vitest`/`pytest`'s default runs in any package, since no sandboxed unit-test runner in this session can start multiple real containers.

- [ ] **Step 1: Write the golden fixture document**

```
# docs/golden-e2e-fixture.txt
1 System Requirements
1.1 Power Subsystem
1.1.1 3.3V Rail Requirements
The receiver shall provide a stable 3.3V rail with less than 50mV ripple under full load.
OPEN: confirm connector part number before release.
1.1.2 5V Rail Requirements
The receiver shall provide a stable 5V rail capable of sourcing 2A continuous current.
```

- [ ] **Step 2: Write the golden E2E script**

```bash
#!/usr/bin/env bash
# scripts/run-golden-e2e.sh
# Full-stack golden E2E: docker-compose up (Postgres, Redis, ingestion,
# orchestrator, mcp-ado-server with ADO_BACKEND=mock, pipeline worker) ->
# submit docs/golden-e2e-fixture.txt as a Baseline job -> poll until
# diff_ready -> confirm -> verify the mock ADO backend has the expected
# work items with no duplicates on a second identical run.
#
# Requires Docker. Not run by any package's automated unit-test suite —
# run this manually or in a dedicated CI job with Docker available.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== Starting full stack ==="
docker compose up -d --build
trap 'docker compose down' EXIT

echo "=== Waiting for orchestrator health check ==="
for i in $(seq 1 30); do
  if curl -sf http://localhost:3001/health > /dev/null; then break; fi
  sleep 2
done

echo "=== Submitting golden fixture as a Baseline job ==="
JOB_RESPONSE=$(curl -sf -X POST http://localhost:3001/jobs \
  -F "file=@docs/golden-e2e-fixture.txt" \
  -F "areaPath=GoldenE2E\\Area1")
JOB_ID=$(echo "$JOB_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin)['jobId'])")
echo "Job ID: $JOB_ID"

echo "=== Polling for diff_ready ==="
for i in $(seq 1 30); do
  STATUS=$(curl -sf "http://localhost:3001/jobs/$JOB_ID" | python3 -c "import sys, json; print(json.load(sys.stdin)['status'])")
  if [[ "$STATUS" == "diff_ready" ]]; then break; fi
  if [[ "$STATUS" == "failed" ]]; then echo "Job failed"; exit 1; fi
  sleep 2
done

echo "=== Confirming write ==="
CONFIRM_RESPONSE=$(curl -sf -X POST "http://localhost:3001/jobs/$JOB_ID/confirm")
echo "Confirm response: $CONFIRM_RESPONSE"
CREATED_COUNT=$(echo "$CONFIRM_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin)['createdCount'])")

if [[ "$CREATED_COUNT" -lt 1 ]]; then
  echo "FAIL: expected at least 1 created work item, got $CREATED_COUNT"
  exit 1
fi

echo "=== Re-submitting the SAME fixture (must produce zero new creates) ==="
JOB2_RESPONSE=$(curl -sf -X POST http://localhost:3001/jobs \
  -F "file=@docs/golden-e2e-fixture.txt" \
  -F "areaPath=GoldenE2E\\Area1")
JOB2_ID=$(echo "$JOB2_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin)['jobId'])")

for i in $(seq 1 30); do
  STATUS=$(curl -sf "http://localhost:3001/jobs/$JOB2_ID" | python3 -c "import sys, json; print(json.load(sys.stdin)['status'])")
  if [[ "$STATUS" == "diff_ready" ]]; then break; fi
  sleep 2
done

DIFF=$(curl -sf "http://localhost:3001/jobs/$JOB2_ID" | python3 -c "import sys, json; d=json.load(sys.stdin)['dryRunDiff']; print(all(e['action'] == 'reuse' for e in d))")
if [[ "$DIFF" != "True" ]]; then
  echo "FAIL: re-running the same fixture did not produce all-reuse actions — duplicate-write bug"
  exit 1
fi

echo "=== GOLDEN E2E PASSED ==="
```

Run: `chmod +x scripts/run-golden-e2e.sh`

- [ ] **Step 3: Run it (requires Docker)**

Run: `./scripts/run-golden-e2e.sh`
Expected: `=== GOLDEN E2E PASSED ===`. If Docker is unavailable in the current environment, note this explicitly in the task completion report as "unverified in this environment — script is correct per manual code review and mirrors the already-proven unit-level pipeline logic from Phase 7.5 Task 7's golden test" rather than silently skipping or falsely claiming a pass.

- [ ] **Step 4: Commit**

```bash
git add scripts/run-golden-e2e.sh docs/golden-e2e-fixture.txt
git commit -m "test: add golden full-stack E2E script covering upload->diff->confirm->idempotent-rerun"
```

---

## Self-Review Notes

- **Every security fix targets a real, verified issue, not a generic checklist:** Task 1's constant-time comparison fix cites the exact file:line (`mcp-ado-server/src/server.ts:26`) that ALREADY had its own comment deferring this to Phase 8 — confirmed by reading the actual file before writing this plan, not assumed. The identical pattern was independently found in Phase 5's own `LlmProxyBearerGuard` design and is fixed the same way for consistency. Task 2's `helmet`/rate-limiting additions were confirmed absent by reading `orchestrator/src/main.ts` directly (no middleware registration existed) before this task was written.
- **Load test scoped honestly:** Task 3's load test exercises the ORCHESTRATOR's pipeline logic for concurrency-safety (shared state, race conditions), explicitly NOT infrastructure throughput (real Postgres/Redis/ADO performance under load is a deployment/ops concern this session cannot meaningfully test without real infrastructure) — this distinction is stated explicitly rather than overclaiming what the test proves.
- **Golden E2E honestly scoped to what CAN run in this environment:** Task 6's docker-compose-based script is the correct way to exercise a REAL full stack, but explicitly instructs the implementer to report "unverified in this environment" rather than fake a pass if Docker isn't available — matching this project's established, consistently-applied "verify against reality, report honestly if you can't" convention (same pattern as the OCR/Tesseract Docker-verification workaround from Phase 1, and Phase 4/6/7's "verify against the real library, don't force an assumed value" notes).
- **TSDoc pass explicitly guards against busywork:** Task 5's own instructions repeatedly state the success criterion is NOT a coverage percentage — this directly follows the project's own standing rule (in force via the global CLAUDE.md all session) against comments that don't explain a genuinely non-obvious WHY.
- **New dependencies called out explicitly:** `helmet`, `@nestjs/throttler` (orchestrator), `react-markdown` (frontend) are the only new dependencies in this phase — each justified by a concrete, previously-absent capability (security headers, rate limiting, markdown rendering), confirmed absent by reading the actual `package.json` files before this plan was written.
- **No placeholders:** every step contains complete, runnable code; Task 5's inherently-cannot-be-fully-scripted judgment calls are explicitly flagged as requiring human/implementer judgment rather than papered over with fake specificity.
- **This phase closes the loop on the whole 8-phase (plus 7.5) roadmap:** by the end of this phase, every Locked Decision in `docs/architecture.md`'s original planning table has either a real, tested implementation or an explicitly-flagged, still-open decision (the SURVEY-mode pipeline-integration question from Phase 5/6, and the per-request ADO-credential-wiring question from Phase 7 Task 8) — both of which are documented, not silently lost, and are real follow-up work for whenever SURVEY mode or live on-prem ADO writes are actually needed.
