# ADO-PAT Login + Embeddings Design Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unusable Azure-AD-default app login with a working local-ADO-account login (PAT validated against the ADO Server itself), and correct the architecture docs' wrong assumption that Open WebUI exposes OpenAI-shaped embeddings.

**Architecture:** A new `AdoPatProvider` validates `{orgUrl, pat}` against ADO's own `GET _apis/connectionData` and extracts a stable identity (`authenticatedUser.descriptor`). A new `SessionService` issues a JWT (`{userId, role}`, never the PAT) via `@nestjs/jwt`. A new `POST /auth/login` endpoint wires these together with a Prisma upsert, unconditionally assigning `Role.OPERATOR` (no RBAC differentiation needed — ADO's own permissions are the real gate). The frontend's two-step login collapses into one PAT+OrgUrl form. `AzureAdProvider`/`RolesGuard`/`Role` enum stay untouched as unused future-proofing. Embeddings get a documented config/docs correction only — no code, since Phase 6 doesn't exist yet.

**Tech Stack:** Same as Phase 0 — NestJS, Prisma, Jest, Vitest/React Testing Library. New dependency: `@nestjs/jwt` (JWT issuance). No new dependency for the ADO HTTP call — use Node 22's built-in global `fetch`, not axios (avoid an unnecessary new dependency for a single GET call).

## Global Constraints

- Do NOT delete or modify `AzureAdProvider`, `RolesGuard`, `roles.decorator.ts`, or the `Role` enum's existing values — they stay as-is, additive only.
- Do NOT add app-level RBAC differentiation logic (no admin allowlist, no role bootstrap) — every authenticated user gets `Role.OPERATOR` unconditionally. ADO's own permission system is the real gate; this is a deliberate, confirmed scope decision, not an oversight.
- The identity key extracted from ADO's `connectionData` response must be `authenticatedUser.descriptor` (confirmed via research: stable, unique, non-PAT, survives display-name/email changes) — NOT `providerDisplayName` (can change) or `properties.Account.$value` (format varies AD vs MSA, not guaranteed present).
- The JWT session token must contain ONLY `{userId, role}` — never the PAT itself.
- The PAT continues to be sent as a per-request header for ADO-bound MCP calls (unchanged from Phase 0) — this round only adds an app-level session on top, it does not change how the PAT itself is used for ADO API access.
- Type hints/TypeScript types on every signature; NestJS DI patterns (constructor injection); no `console.log`.
- Embeddings correction (Task 6) is docs/config only — no orchestrator or ingestion code changes, since Phase 6 doesn't exist yet.

---

### Task 1: Config schema + new dependencies

**Files:**
- Modify: `orchestrator/src/config/config.schema.ts`
- Modify: `orchestrator/package.json` (add `@nestjs/jwt` dependency)

**Interfaces:**
- Modifies: `AppConfig`'s `AUTH_PROVIDER` field — enum changes from `['azure_ad', 'local']` to `['azure_ad', 'ado_pat']`, default changes from `'azure_ad'` to `'ado_pat'`.
- Produces: `AppConfig.AUTH_JWT_SECRET: string` (required, no default — a missing secret must fail at boot, not silently sign with an empty/weak secret) — Task 3 (`SessionService`) and Task 4 (`auth.module.ts`) both read this.

**Boundary:** Only touch `config.schema.ts` and `package.json`. Do not touch any other auth file yet.

- [ ] **Step 1: Update the config schema**

```typescript
// orchestrator/src/config/config.schema.ts (full file, replacing existing content)
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
  AUTH_PROVIDER: z.enum(['azure_ad', 'ado_pat']).default('ado_pat'),
  AUTH_JWT_SECRET: z.string().min(1),
  AZURE_AD_TENANT_ID: z.string().optional(),
  AZURE_AD_CLIENT_ID: z.string().optional(),
  AZURE_AD_CLIENT_SECRET: z.string().optional(),
});

export type AppConfig = z.infer<typeof configSchema>;
```

- [ ] **Step 2: Add `@nestjs/jwt` to package.json**

Edit `orchestrator/package.json`'s `dependencies` block to add, alphabetically:
```json
    "@nestjs/jwt": "^10.2.0",
```
(insert it after `"@nestjs/core"` and before `"@nestjs/platform-express"` to keep the existing alphabetical-ish ordering, or wherever fits — exact position doesn't matter, just valid JSON).

- [ ] **Step 3: Install and verify existing tests still pass**

Run: `cd orchestrator && npm install && npx jest`
Expected: existing tests FAIL at this point — `health.e2e-spec.ts` and any test constructing `AppModule`/`ConfigModule` will now fail Zod validation because `AUTH_JWT_SECRET` is required but not set in those tests' env setup. This is EXPECTED at this step (not yet fixed) — do not worry about it, the next step fixes it.

- [ ] **Step 4: Add `AUTH_JWT_SECRET` to the existing e2e test's env setup**

Edit `orchestrator/test/health.e2e-spec.ts`, in the `beforeAll` block, add this line alongside the existing `process.env.MCP_BEARER = 'test-bearer';` line:
```typescript
    process.env.AUTH_JWT_SECRET = 'test-jwt-secret';
```

- [ ] **Step 5: Run tests to verify they pass again**

Run: `cd orchestrator && npx jest`
Expected: PASS (all existing tests green again — 9 tests from Phase 0, per the ledger).

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/config/config.schema.ts orchestrator/package.json orchestrator/package-lock.json orchestrator/test/health.e2e-spec.ts
git commit -m "feat(orchestrator): switch AUTH_PROVIDER default to ado_pat, add AUTH_JWT_SECRET config"
```

---

### Task 2: AdoPatProvider — validate PAT against ADO Server, extract identity

**Files:**
- Create: `orchestrator/src/modules/auth/ado-pat.provider.ts`
- Test: `orchestrator/test/ado-pat.provider.spec.ts`

**Interfaces:**
- Produces: `AdoIdentity { identity: string; displayName: string }` and `AdoPatProvider` class with `validateAndIdentify(orgUrl: string, pat: string): Promise<AdoIdentity>` — Task 4 (`AuthController`) imports and calls this.

**Boundary:** Only touch `ado-pat.provider.ts` and its test. Do not touch `azure-ad.provider.ts`, `auth.module.ts`, or `roles.enum.ts` yet. Do not add axios or any other HTTP library — use the global `fetch` (available in Node 22 without import).

- [ ] **Step 1: Write the failing tests**

```typescript
// orchestrator/test/ado-pat.provider.spec.ts
import { AdoPatProvider } from '../src/modules/auth/ado-pat.provider';

describe('AdoPatProvider', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('extracts descriptor and displayName from a valid connectionData response', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        authenticatedUser: {
          descriptor: 'Microsoft.TeamFoundation.Identity;S-1-5-21-000',
          providerDisplayName: 'Jane Doe',
        },
      }),
    } as Response);

    const provider = new AdoPatProvider();
    const result = await provider.validateAndIdentify('https://tfs.internal/tfs/Collection', 'fake-pat');

    expect(result).toEqual({
      identity: 'Microsoft.TeamFoundation.Identity;S-1-5-21-000',
      displayName: 'Jane Doe',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://tfs.internal/tfs/Collection/_apis/connectionData?api-version=7.1',
      { headers: { Authorization: expect.stringMatching(/^Basic /) } },
    );
  });

  it('falls back to descriptor as displayName when providerDisplayName is absent', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        authenticatedUser: { descriptor: 'Microsoft.TeamFoundation.Identity;S-1-5-21-000' },
      }),
    } as Response);

    const provider = new AdoPatProvider();
    const result = await provider.validateAndIdentify('https://tfs.internal/tfs/Collection', 'fake-pat');

    expect(result.displayName).toBe('Microsoft.TeamFoundation.Identity;S-1-5-21-000');
  });

  it('throws when the ADO server rejects the request', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 401 } as Response);

    const provider = new AdoPatProvider();
    await expect(
      provider.validateAndIdentify('https://tfs.internal/tfs/Collection', 'bad-pat'),
    ).rejects.toThrow('ADO connectionData validation failed: 401');
  });

  it('throws when the response is missing authenticatedUser.descriptor', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response);

    const provider = new AdoPatProvider();
    await expect(
      provider.validateAndIdentify('https://tfs.internal/tfs/Collection', 'fake-pat'),
    ).rejects.toThrow('ADO connectionData response missing authenticatedUser.descriptor');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd orchestrator && npx jest test/ado-pat.provider.spec.ts`
Expected: FAIL — `Cannot find module '../src/modules/auth/ado-pat.provider'`

- [ ] **Step 3: Implement**

```typescript
// orchestrator/src/modules/auth/ado-pat.provider.ts
import { Injectable } from '@nestjs/common';

/**
 * `identity` is `authenticatedUser.descriptor` from ADO's connectionData
 * response — stable, unique, and NOT the PAT itself (confirmed via research:
 * survives display-name/email changes, unlike providerDisplayName or
 * properties.Account.$value). Use this as the DB key, never displayName.
 */
export interface AdoIdentity {
  identity: string;
  displayName: string;
}

function buildBasicAuthHeader(pat: string): string {
  return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
}

@Injectable()
export class AdoPatProvider {
  /**
   * Validates a PAT by calling ADO's own connectionData endpoint — the same
   * call the mock/real ADO backend already treats as a liveness/identity
   * check (see mcp-ado-server's ado_ping tool). No separate identity
   * provider is needed: on-prem ADO Server itself is the identity source.
   */
  async validateAndIdentify(orgUrl: string, pat: string): Promise<AdoIdentity> {
    const url = `${orgUrl.replace(/\/$/, '')}/_apis/connectionData?api-version=7.1`;
    const response = await fetch(url, {
      headers: { Authorization: buildBasicAuthHeader(pat) },
    });

    if (!response.ok) {
      throw new Error(`ADO connectionData validation failed: ${response.status}`);
    }

    const body = (await response.json()) as {
      authenticatedUser?: { descriptor?: string; providerDisplayName?: string };
    };
    const descriptor = body.authenticatedUser?.descriptor;
    if (!descriptor) {
      throw new Error('ADO connectionData response missing authenticatedUser.descriptor');
    }

    return {
      identity: descriptor,
      displayName: body.authenticatedUser?.providerDisplayName ?? descriptor,
    };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd orchestrator && npx jest test/ado-pat.provider.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/modules/auth/ado-pat.provider.ts orchestrator/test/ado-pat.provider.spec.ts
git commit -m "feat(orchestrator): add AdoPatProvider validating PAT against ADO connectionData"
```

---

### Task 3: SessionService — JWT issuance/verification

**Files:**
- Create: `orchestrator/src/modules/auth/session.service.ts`
- Test: `orchestrator/test/session.service.spec.ts`

**Interfaces:**
- Consumes: `Role` from `./roles.enum` (already exists, Phase 0).
- Produces: `SessionPayload { userId: string; role: Role }` and `SessionService` class with `issue(payload: SessionPayload): string` and `verify(token: string): SessionPayload` — Task 4 (`AuthController`) imports and calls both; a future auth guard (not built this round) will call `verify`.

**Boundary:** Only touch `session.service.ts` and its test. Do not touch `roles.guard.ts` (wiring a real auth-guard that populates `request.user` from this session is explicitly out of scope for this round — this task only builds the JWT issue/verify primitive).

- [ ] **Step 1: Write the failing tests**

```typescript
// orchestrator/test/session.service.spec.ts
import { JwtService } from '@nestjs/jwt';
import { SessionService } from '../src/modules/auth/session.service';
import { Role } from '../src/modules/auth/roles.enum';

describe('SessionService', () => {
  it('issues a token that verifies back to the same payload', () => {
    const service = new SessionService(new JwtService({ secret: 'test-secret' }));

    const token = service.issue({ userId: 'user-1', role: Role.Operator });
    const decoded = service.verify(token);

    expect(decoded.userId).toBe('user-1');
    expect(decoded.role).toBe(Role.Operator);
  });

  it('throws when verifying a token signed with a different secret', () => {
    const issuer = new SessionService(new JwtService({ secret: 'secret-a' }));
    const verifier = new SessionService(new JwtService({ secret: 'secret-b' }));

    const token = issuer.issue({ userId: 'user-1', role: Role.Viewer });

    expect(() => verifier.verify(token)).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd orchestrator && npx jest test/session.service.spec.ts`
Expected: FAIL — `Cannot find module '../src/modules/auth/session.service'`

- [ ] **Step 3: Implement**

```typescript
// orchestrator/src/modules/auth/session.service.ts
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role } from './roles.enum';

export interface SessionPayload {
  userId: string;
  role: Role;
}

/** Issues/verifies short-lived app session tokens. NEVER embeds the ADO PAT
 * — only { userId, role }. The PAT continues to be sent per-request as a
 * header for ADO-bound calls, unchanged from Phase 0. */
@Injectable()
export class SessionService {
  constructor(private readonly jwtService: JwtService) {}

  issue(payload: SessionPayload): string {
    return this.jwtService.sign(payload);
  }

  verify(token: string): SessionPayload {
    return this.jwtService.verify<SessionPayload>(token);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd orchestrator && npx jest test/session.service.spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/modules/auth/session.service.ts orchestrator/test/session.service.spec.ts
git commit -m "feat(orchestrator): add SessionService for JWT-based app session issuance"
```

---

### Task 4: AuthController + minimal PrismaService + auth.module wiring

**Files:**
- Create: `orchestrator/src/modules/auth/prisma.service.ts`
- Create: `orchestrator/src/modules/auth/auth.controller.ts`
- Modify: `orchestrator/src/modules/auth/auth.module.ts`
- Test: `orchestrator/test/auth.controller.e2e-spec.ts`

**Interfaces:**
- Consumes: `AdoPatProvider` (Task 2), `SessionService` (Task 3), `toDomainRole` from `./roles.enum` (Phase 0, already exists — reuse it, do not reimplement the Prisma-role→TS-role mapping).
- Produces: `PrismaService` (a thin `PrismaClient` wrapper implementing `OnModuleInit`/`OnModuleDestroy` for connect/disconnect lifecycle — the standard NestJS pattern since no shared Prisma module exists yet in this codebase); `POST /auth/login` route returning `{ token: string }`.

**Boundary:** `PrismaService` is scoped inside `modules/auth/` for now since it's the only consumer — do not build a separate top-level `PrismaModule` (out of scope; if more modules need Prisma later, that refactor belongs to whichever phase needs it). Do not modify `roles.guard.ts`, `roles.decorator.ts`, or `azure-ad.provider.ts`.

- [ ] **Step 1: Write the minimal PrismaService**

```typescript
// orchestrator/src/modules/auth/prisma.service.ts
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/** Thin PrismaClient wrapper with NestJS lifecycle hooks. Scoped to the auth
 * module for now since it's the only Prisma consumer in the app so far — if
 * a later phase needs Prisma elsewhere, extract this into a shared
 * PrismaModule at that point rather than duplicating this wrapper. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
```

- [ ] **Step 2: Write the failing e2e test**

```typescript
// orchestrator/test/auth.controller.e2e-spec.ts
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AdoPatProvider } from '../src/modules/auth/ado-pat.provider';
import { PrismaService } from '../src/modules/auth/prisma.service';

describe('AuthController (e2e)', () => {
  let app: INestApplication;
  const fakeAdoPatProvider = {
    validateAndIdentify: jest.fn(),
  };
  const fakePrismaService = {
    user: { upsert: jest.fn() },
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgresql://req2ado:req2ado@localhost:5432/req2ado';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.MCP_URL = 'http://localhost:4100';
    process.env.MCP_BEARER = 'test-bearer';
    process.env.AUTH_JWT_SECRET = 'test-jwt-secret';

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AdoPatProvider)
      .useValue(fakeAdoPatProvider)
      .overrideProvider(PrismaService)
      .useValue(fakePrismaService)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('POST /auth/login returns a token on a valid PAT', async () => {
    fakeAdoPatProvider.validateAndIdentify.mockResolvedValue({
      identity: 'Microsoft.TeamFoundation.Identity;S-1-5-21-000',
      displayName: 'Jane Doe',
    });
    fakePrismaService.user.upsert.mockResolvedValue({
      id: 'user-1',
      email: 'Microsoft.TeamFoundation.Identity;S-1-5-21-000',
      role: 'OPERATOR',
    });

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ adoOrgUrl: 'https://tfs.internal/tfs/Collection', pat: 'fake-pat' });

    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe('string');
    expect(fakePrismaService.user.upsert).toHaveBeenCalledWith({
      where: { email: 'Microsoft.TeamFoundation.Identity;S-1-5-21-000' },
      update: {},
      create: { email: 'Microsoft.TeamFoundation.Identity;S-1-5-21-000', role: 'OPERATOR' },
    });
  });

  it('POST /auth/login returns 401 on an invalid PAT', async () => {
    fakeAdoPatProvider.validateAndIdentify.mockRejectedValue(new Error('ADO connectionData validation failed: 401'));

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ adoOrgUrl: 'https://tfs.internal/tfs/Collection', pat: 'bad-pat' });

    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd orchestrator && npx jest test/auth.controller.e2e-spec.ts`
Expected: FAIL — `Cannot find module '../src/modules/auth/auth.controller'` (and/or `PrismaService` not found)

- [ ] **Step 4: Implement the controller**

```typescript
// orchestrator/src/modules/auth/auth.controller.ts
import { Body, Controller, Post, UnauthorizedException } from '@nestjs/common';
import { Role as PrismaRole } from '@prisma/client';
import { AdoPatProvider } from './ado-pat.provider';
import { PrismaService } from './prisma.service';
import { toDomainRole } from './roles.enum';
import { SessionService } from './session.service';

interface LoginRequestBody {
  adoOrgUrl: string;
  pat: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly adoPatProvider: AdoPatProvider,
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
  ) {}

  @Post('login')
  async login(@Body() body: LoginRequestBody): Promise<{ token: string }> {
    let identity;
    try {
      identity = await this.adoPatProvider.validateAndIdentify(body.adoOrgUrl, body.pat);
    } catch {
      throw new UnauthorizedException('Invalid ADO organization URL or Personal Access Token');
    }

    const user = await this.prisma.user.upsert({
      where: { email: identity.identity },
      update: {},
      create: { email: identity.identity, role: PrismaRole.OPERATOR },
    });

    const token = this.sessionService.issue({ userId: user.id, role: toDomainRole(user.role) });
    return { token };
  }
}
```

- [ ] **Step 5: Wire it all into auth.module.ts**

```typescript
// orchestrator/src/modules/auth/auth.module.ts (full file, replacing existing content)
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AdoPatProvider } from './ado-pat.provider';
import { AuthController } from './auth.controller';
import { AzureAdProvider } from './azure-ad.provider';
import { PrismaService } from './prisma.service';
import { RolesGuard } from './roles.guard';
import { SessionService } from './session.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('AUTH_JWT_SECRET'),
        signOptions: { expiresIn: '8h' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AzureAdProvider,
    AdoPatProvider,
    PrismaService,
    SessionService,
    Reflector,
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AzureAdProvider, AdoPatProvider],
})
export class AuthModule {}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd orchestrator && npx jest test/auth.controller.e2e-spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Run the full orchestrator suite**

Run: `cd orchestrator && npx jest`
Expected: all tests pass (Phase 0's 9 + Task 1's env-var fix + Task 2's 4 + Task 3's 2 + Task 4's 2 = should be around 17-18 total — verify the actual count, don't assume).

- [ ] **Step 8: Commit**

```bash
git add orchestrator/src/modules/auth/prisma.service.ts orchestrator/src/modules/auth/auth.controller.ts orchestrator/src/modules/auth/auth.module.ts orchestrator/test/auth.controller.e2e-spec.ts
git commit -m "feat(orchestrator): wire POST /auth/login (ADO PAT validation, Prisma upsert, JWT session)"
```

---

### Task 5: Frontend Login.tsx consolidation

**Files:**
- Modify: `frontend/src/pages/Login.tsx`
- Modify: `frontend/src/pages/Login.test.tsx`

**Interfaces:**
- Consumes: `httpClient` from `../api/httpClient.js` (already exists).
- Produces: the same `Login` component export, now calling `POST /auth/login` instead of `/connection/validate`, with no Azure AD button.

**Boundary:** Only touch these two files. Do not touch `httpClient.ts`, `App.tsx`, or any other frontend file.

- [ ] **Step 1: Update the failing tests first (TDD — adjust expectations to the new endpoint/behavior)**

```typescript
// frontend/src/pages/Login.test.tsx (full file, replacing existing content)
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Login } from './Login';
import { httpClient } from '../api/httpClient';

describe('Login page', () => {
  afterEach(() => vi.restoreAllMocks());

  it('disables the sign-in button until both fields are filled', () => {
    render(<Login />);
    expect(screen.getByText('Sign in')).toBeDisabled();
  });

  it('does not render an Azure AD sign-in option', () => {
    render(<Login />);
    expect(screen.queryByText(/Azure AD/i)).not.toBeInTheDocument();
  });

  it('shows a success alert and calls /auth/login when sign-in succeeds', async () => {
    vi.spyOn(httpClient, 'post').mockResolvedValueOnce({ data: { token: 'fake-jwt' } });

    render(<Login />);
    fireEvent.change(screen.getByLabelText('ADO Organization URL'), { target: { value: 'https://tfs.internal/tfs/Collection' } });
    fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'fake-pat' } });
    fireEvent.click(screen.getByText('Sign in'));

    await waitFor(() => expect(screen.getByText('Signed in successfully.')).toBeInTheDocument());
    expect(httpClient.post).toHaveBeenCalledWith('/auth/login', {
      adoOrgUrl: 'https://tfs.internal/tfs/Collection',
      pat: 'fake-pat',
    });
  });

  it('shows an error alert when sign-in fails', async () => {
    vi.spyOn(httpClient, 'post').mockRejectedValueOnce(new Error('Invalid ADO organization URL or Personal Access Token'));

    render(<Login />);
    fireEvent.change(screen.getByLabelText('ADO Organization URL'), { target: { value: 'https://tfs.internal/tfs/Collection' } });
    fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'fake-pat' } });
    fireEvent.click(screen.getByText('Sign in'));

    await waitFor(() => expect(screen.getByText('Invalid ADO organization URL or Personal Access Token')).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/pages/Login.test.tsx`
Expected: FAIL — button text is still "Validate connection", Azure AD button still present, wrong endpoint called.

- [ ] **Step 3: Implement the consolidated Login component**

```tsx
// frontend/src/pages/Login.tsx (full file, replacing existing content)
import { useState } from 'react';
import type { JSX } from 'react';
import { Box, Button, Stack, TextField, Typography, Alert } from '@mui/material';
import { httpClient } from '../api/httpClient.js';

/**
 * Single-step login: the ADO Server itself is the identity provider. The
 * entered PAT is validated against ADO's own connectionData endpoint
 * (orchestrator's POST /auth/login), which both proves the credential works
 * and identifies the user — no separate app-level identity system (e.g.
 * Azure AD) is needed for this deployment. The PAT lives only in this
 * component's state — never persisted to localStorage/sessionStorage/disk —
 * and continues to be sent as a header on ADO-bound requests, unchanged from
 * Phase 0. The returned session token is held in memory only, for app-level
 * RBAC identity (see docs/architecture.md "PAT entry" / auth corrections).
 *
 * Azure AD remains a supported backend option (AUTH_PROVIDER=azure_ad) for
 * deployments that can register an app, but is not surfaced in this UI,
 * which targets the local-ADO-account-only case. A provider-switchable UI
 * is a future enhancement, not built now.
 */
export function Login(): JSX.Element {
  const [adoOrgUrl, setAdoOrgUrl] = useState('');
  const [pat, setPat] = useState('');
  const [status, setStatus] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleLogin = async (): Promise<void> => {
    setStatus('checking');
    setErrorMessage(null);
    try {
      await httpClient.post('/auth/login', { adoOrgUrl, pat });
      setStatus('ok');
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Sign-in failed');
    }
  };

  return (
    <Box sx={{ maxWidth: 420, mx: 'auto', mt: 8 }}>
      <Typography variant="h5" gutterBottom>
        Sign in to req2ado
      </Typography>

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
        <Button variant="contained" onClick={handleLogin} disabled={!adoOrgUrl || !pat || status === 'checking'}>
          Sign in
        </Button>
        {status === 'ok' && <Alert severity="success">Signed in successfully.</Alert>}
        {status === 'error' && <Alert severity="error">{errorMessage}</Alert>}
      </Stack>
    </Box>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run src/pages/Login.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full frontend suite**

Run: `cd frontend && npx vitest run`
Expected: PASS (4 tests total — no other test files exist yet in frontend per Phase 0).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Login.tsx frontend/src/pages/Login.test.tsx
git commit -m "feat(frontend): consolidate login to single ADO-PAT step, remove Azure AD button"
```

---

### Task 6: Docs/config corrections — auth default + embeddings design

**Files:**
- Modify: `config.yaml`
- Modify: `.env.template`
- Modify: `docs/architecture.md`

**Interfaces:** None (docs/config only, no code).

**Boundary:** Only touch these three files. No orchestrator/ingestion/frontend code changes in this task — the embeddings correction is a design/docs note for the not-yet-built Phase 6, not an implementation.

- [ ] **Step 1: Update `config.yaml`'s `auth` section and add embeddings-transport fields**

In `config.yaml`, change:
```yaml
auth:
  provider: azure_ad # azure_ad | local
  roles: [admin, operator, viewer]
```
to:
```yaml
auth:
  provider: ado_pat # ado_pat | azure_ad — ado_pat validates the PAT against the ADO Server itself (no external IdP needed); azure_ad requires an App Registration, kept as a future option
  roles: [admin, operator, viewer] # RBAC machinery exists but is unused today — every ado_pat login gets 'operator'; ADO's own permissions are the real gate
```

Also in `config.yaml`'s `llm:` section, after the existing `embed_model: ${LLM_EMBED_MODEL}` line, add:
```yaml
  embed_transport: ollama # ollama | openai — Open WebUI does not expose an OpenAI-shaped /embeddings endpoint; it only proxies Ollama-shaped /ollama/api/embed. Default to 'ollama' until/unless a real OpenAI-shaped embeddings backend is configured separately.
  embed_base_url: ${EMBED_BASE_URL} # optional override; defaults to llm.base_url (Open WebUI) if unset
```

- [ ] **Step 2: Update `.env.template`**

Change:
```
AUTH_PROVIDER=azure_ad
```
to:
```
AUTH_PROVIDER=ado_pat
AUTH_JWT_SECRET=
```
(add `AUTH_JWT_SECRET` as a new blank env var in the "App auth (RBAC)" section, right after `AUTH_PROVIDER`)

Add a new line in the LLM section after `LLM_EMBED_MODEL=`:
```
EMBED_TRANSPORT=ollama
EMBED_BASE_URL=
```

- [ ] **Step 3: Correct `docs/architecture.md`**

Three edits:

(a) In the "Locked Decisions" table, change the "App auth" row from:
```
| App auth | **App-level login + roles** (in addition to per-user ADO PAT). Azure AD (DocGen runtime-config precedent) or local users; roles e.g. Admin / Operator / Viewer. NestJS guards enforce RBAC on routes. ADO PAT remains per-user, in-memory. |
```
to:
```
| App auth | **ADO PAT is the sole credential for both identity and permissions.** Login validates `{orgUrl, pat}` against the ADO Server's own `connectionData` endpoint — no external IdP (Azure AD requires an App Registration, unavailable in this deployment; kept in the codebase as an unused future option). Every authenticated user gets a single role (`Operator`) — ADO's own permission system is the real access-control gate, not app-level RBAC. NestJS `RolesGuard`/`Role` enum machinery exists (built, tested) for a future multi-user RBAC scenario if ever needed. |
```

(b) In the "Remaining Minor Questions" section, replace the "App login mechanism" question (which asked "Azure AD vs local username/password... Default: Azure AD") with a resolved statement:
```
1. **App login mechanism:** RESOLVED — ADO PAT validated against the ADO Server's own `connectionData` endpoint (see "Locked Decisions" above). Azure AD remains available as a backend config option (`AUTH_PROVIDER=azure_ad`) for deployments that can register an app, but is not the default and is not surfaced in the current login UI.
```

(c) In section 2c (Provider-Agnostic LLM Client Interface), find the `embed()` method's comment `// Models always from config (never hardcoded). base_url = Open WebUI.` and add directly below it:
```
// Embeddings use a SEPARATE transport from chat: Open WebUI does not expose
// an OpenAI-shaped /embeddings endpoint (confirmed via research) — only an
// Ollama-shaped /ollama/api/embed proxy exists. EMBED_TRANSPORT ('ollama' |
// 'openai', default 'ollama') and EMBED_BASE_URL select the real backend;
// this public embed() signature is unchanged, only the internal transport
// adapter differs. Not implemented yet — Phase 6 (dedup) is unbuilt.
```

Also find the "Ingestion" tech-stack bullet that says `chromadb (dedup); embeddings via Open WebUI.` and change it to `chromadb (dedup); embeddings via a configurable transport (Ollama-shaped by default, since Open WebUI doesn't expose OpenAI-shaped embeddings — see section 2c).`

And in the Phase table's Phase 6 row, change `Embeddings + ≥0.90 skip, Chroma, scoped by Area Path` cell's "LLM" column (currently `Embeddings via proxy`) to `Embeddings via configurable transport (Ollama-shaped default)`.

- [ ] **Step 4: Verify by reading the three corrected sections once more**

No automated test for this task. Read back the edited sections in `config.yaml`, `.env.template`, and `docs/architecture.md` to confirm no stale "Azure AD is default" or "embeddings via Open WebUI" (unqualified) claim remains.

- [ ] **Step 5: Commit**

```bash
git add config.yaml .env.template docs/architecture.md
git commit -m "docs(req2ado): correct auth default to ado_pat and embeddings transport assumption"
```

---

## Self-Review Notes

- **Spec coverage:** all three locked decisions from the approved plan are covered — ADO api-version (no change, nothing to do), app auth (Tasks 1-5, real working code), embeddings (Task 6, docs/config only as scoped). No RBAC-bootstrap logic was added anywhere, matching the confirmed "ADO's own permissions are the real gate" decision.
- **Type consistency:** `AdoIdentity` (Task 2) is consumed by `AuthController` (Task 4) via `identity.identity`/`identity.displayName` — field names match. `SessionPayload` (Task 3) is consumed identically by `AuthController` (`{ userId: user.id, role: toDomainRole(user.role) }`) — matches `SessionService.issue`'s parameter type. `PrismaService` (Task 4) extends `PrismaClient` so `this.prisma.user.upsert(...)` in `AuthController` uses the real Prisma-generated `user` delegate — no drift.
- **No placeholders:** every step contains complete, runnable code. The embeddings correction (Task 6) is explicitly scoped as docs-only per the approved plan — this is a stated scope boundary, not a placeholder/TODO left in code.
- **Known deferred item (explicitly out of scope, not a gap):** no NestJS guard/middleware is built in this round to actually verify the session JWT on subsequent requests and populate `request.user` for `RolesGuard` to read — `SessionService.verify()` exists as a tested primitive, but nothing calls it yet on incoming requests. This is a real next step for whichever future phase needs to protect routes beyond `/auth/login` itself, and should be flagged to the user in the final review rather than silently left for someone to discover.
