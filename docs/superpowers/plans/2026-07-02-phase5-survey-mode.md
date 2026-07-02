# Phase 5 SURVEY Mode: LLM Proxy + Generative Requirements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the orchestrator's real LLM redaction-proxy (referenced by Phases 2/3/5/6 but never actually built by any prior phase — a gap surfaced and confirmed with the user before writing this plan) and use it to implement SURVEY-mode generative "shall"-requirement extraction with taxonomy tagging. Satisfies Phase 5's DoD: "Golden survey output; taxonomy tags applied; each req individually verifiable."

**Architecture:** Two parts, two services, in dependency order.

**Part A (`orchestrator/`, NestJS/TS):** a new `llm` module. `redactor.ts` is a direct TS port of the ingestion service's existing `app/redaction/redactor.py` patterns (part#/host/url/email/GUID) — the orchestrator needs its own redaction pass because it's the "server-side, redact-first" egress boundary named in `docs/architecture.md`'s Locked Decisions, separate from ingestion's document-level redaction pass (Phase 1). `OpenWebUiClient` implements the `LlmClient` interface already specified in `docs/architecture.md` §2c, using the `openai` npm package (already a listed, currently-unused dependency) against a config-driven `base_url` — this works unmodified against either Open WebUI or Ollama's own OpenAI-compatible endpoint (`http://localhost:11434/v1`), satisfying the "test AI features via Ollama" need from earlier in this project. A new `POST /llm/chat` endpoint exposes it to the ingestion service, gated by a static bearer token (`LLM_PROXY_BEARER`) — the same service-to-service auth shape already used for `MCP_BEARER`, since the caller here is the ingestion service, not a browser session (full user-JWT route protection remains a documented, separate gap from the auth-corrections round, out of scope for this phase).

**Part B (`ingestion/`, Python/FastAPI):** `SurveyRequirementClient` (a `Protocol`, mirroring the established `LlmLevelingClient`/`TitleDistillationClient` pattern from Phases 2-4) defines the generative-requirement-extraction seam. `OrchestratorLlmClient` is its first REAL implementation in this project — an `httpx`-based client calling Part A's `/llm/chat` endpoint — genuinely closing the "no real LLM call anywhere in this branch" gap from Phase 3. `build_survey_requirements` wires it into the SURVEY pipeline: each informal block → one or more formal "shall" requirements + taxonomy tags, at `temperature=0` per the architecture's runtime-prompt spec.

**Tech Stack:** Orchestrator: NestJS, `openai` npm package (SDK for Open WebUI's/Ollama's OpenAI-compatible endpoint), Jest. Ingestion: Python 3.11+/pydantic v2/FastAPI/pytest, **new runtime dependency: `httpx`** (already present as a `dev`-only dependency for FastAPI's TestClient; this phase promotes it to a real runtime dependency for the `OrchestratorLlmClient`'s outbound calls — the first genuine new dependency since Phase 0, called out explicitly since prior phases' Global Constraints said "no new dependencies").

## Global Constraints

- The orchestrator's LLM proxy is the ONLY place that calls Open WebUI/Ollama directly. The Python ingestion service NEVER calls Open WebUI/Ollama directly — it calls the orchestrator's `/llm/chat` endpoint. This is the "backend proxy, redact-first" security boundary from `docs/architecture.md`'s Locked Decisions; do not bypass it.
- Every call through `OpenWebUiClient.chat()` MUST pass through `redactor.ts`'s `redactMessages()` first, unless a config flag `LLM_TRUSTED_LOCAL=true` is explicitly set (mirrors the Python redactor's `trusted_local` parameter, same escape-hatch semantics, same default `false`).
- Model names come from config (`LLM_CHAT_MODEL`) — never hardcoded in a prompt-construction function.
- SURVEY-mode requirement generation runs at `temperature=0` (deterministic per the architecture's runtime-prompt spec) — this is a fixed value in this phase's code, not a caller-configurable parameter (matches the existing "Hierarchy inference... temp 0" convention already established in `llm_leveling.py`'s docstring, though that phase never actually wired a real call — this phase is the first to make temp=0 a real, tested HTTP request parameter).
- BASELINE mode remains completely untouched by this phase — no BASELINE code path gains any LLM dependency.
- `/llm/chat` requires a valid `Authorization: Bearer <LLM_PROXY_BEARER>` header — reject with 401 otherwise. This is service-to-service auth (ingestion service → orchestrator), not end-user auth; do not attempt to wire the existing (incomplete, documented-gap) user-session JWT guard into this route in this phase.
- Type hints (Python) / explicit types (TS) on every function signature; docstrings only where genuinely non-obvious; existing repo test conventions in each package.

---

## Part A: Orchestrator LLM Proxy

### Task 1: Config additions for LLM proxy

**Files:**
- Modify: `orchestrator/src/config/config.schema.ts`
- Modify: `orchestrator/.env.template` (repo root's `.env.template`, not orchestrator-local — confirm exact path via `find . -name ".env.template"` before editing)
- Test: `orchestrator/test/config.schema.spec.ts` (create if it doesn't exist; check first)

**Interfaces:**
- Produces: `AppConfig` gains `LLM_BASE_URL: string`, `LLM_API_KEY: string` (optional — Ollama's OpenAI-compatible endpoint needs no key), `LLM_CHAT_MODEL: string`, `LLM_TRUSTED_LOCAL: boolean` (default `false`), `LLM_PROXY_BEARER: string`.

**Boundary:** Only touch `config.schema.ts`, the root `.env.template`, and this task's own test.

- [ ] **Step 1: Check for an existing config schema test**

Run: `find orchestrator/test -iname "*config*"`
If a file exists, read it first and follow its exact pattern for the new test in Step 2. If none exists, create `orchestrator/test/config.schema.spec.ts` fresh.

- [ ] **Step 2: Write the failing test**

```typescript
// orchestrator/test/config.schema.spec.ts
import { configSchema } from '../src/config/config.schema';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://req2ado:req2ado@localhost:5432/req2ado',
  REDIS_URL: 'redis://localhost:6379',
  MCP_URL: 'http://localhost:4100',
  MCP_BEARER: 'test-bearer',
  AUTH_JWT_SECRET: 'test-jwt-secret',
  LLM_BASE_URL: 'http://localhost:11434/v1',
  LLM_CHAT_MODEL: 'llama3.1',
  LLM_PROXY_BEARER: 'test-llm-proxy-bearer',
};

describe('configSchema LLM fields', () => {
  it('parses valid LLM config with defaults for optional fields', () => {
    const result = configSchema.parse(BASE_ENV);
    expect(result.LLM_BASE_URL).toBe('http://localhost:11434/v1');
    expect(result.LLM_CHAT_MODEL).toBe('llama3.1');
    expect(result.LLM_TRUSTED_LOCAL).toBe(false);
    expect(result.LLM_PROXY_BEARER).toBe('test-llm-proxy-bearer');
  });

  it('rejects missing LLM_BASE_URL', () => {
    const { LLM_BASE_URL, ...rest } = BASE_ENV;
    expect(() => configSchema.parse(rest)).toThrow();
  });

  it('rejects missing LLM_PROXY_BEARER', () => {
    const { LLM_PROXY_BEARER, ...rest } = BASE_ENV;
    expect(() => configSchema.parse(rest)).toThrow();
  });

  it('coerces LLM_TRUSTED_LOCAL=true from a string env value', () => {
    const result = configSchema.parse({ ...BASE_ENV, LLM_TRUSTED_LOCAL: 'true' });
    expect(result.LLM_TRUSTED_LOCAL).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd orchestrator && npx jest test/config.schema.spec.ts`
Expected: FAIL — `LLM_BASE_URL`/`LLM_CHAT_MODEL`/`LLM_PROXY_BEARER` don't exist on the schema yet.

- [ ] **Step 4: Implement**

```typescript
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
  AUTH_PROVIDER: z.enum(['azure_ad', 'ado_pat']).default('ado_pat'),
  AUTH_JWT_SECRET: z.string().min(1),
  AZURE_AD_TENANT_ID: z.string().optional(),
  AZURE_AD_CLIENT_ID: z.string().optional(),
  AZURE_AD_CLIENT_SECRET: z.string().optional(),
  ADO_CA_CERT: z.string().optional(),
  LLM_BASE_URL: z.string().min(1),
  LLM_API_KEY: z.string().optional(),
  LLM_CHAT_MODEL: z.string().min(1),
  LLM_TRUSTED_LOCAL: z.coerce.boolean().default(false),
  LLM_PROXY_BEARER: z.string().min(1),
});

export type AppConfig = z.infer<typeof configSchema>;
```

- [ ] **Step 5: Update `.env.template`**

Find the `# LLM (Open WebUI)` block (already present per docs/architecture.md §2b) and update it in place:

```
# LLM (Open WebUI or Ollama's OpenAI-compatible endpoint, e.g. http://localhost:11434/v1)
LLM_BASE_URL=  LLM_API_KEY=  LLM_CHAT_MODEL=  LLM_EMBED_MODEL=  LLM_VISION_MODEL=
LLM_TRUSTED_LOCAL=false
LLM_PROXY_BEARER=
```

(`LLM_EMBED_MODEL`/`LLM_VISION_MODEL` were already present from Phase 0's template and stay as-is — unused until Phase 6/optional vision work; only `LLM_TRUSTED_LOCAL` and `LLM_PROXY_BEARER` are genuinely new here.)

- [ ] **Step 6: Run every existing orchestrator e2e test to confirm they still boot**

Run: `cd orchestrator && npx jest`
Expected: existing `health.e2e-spec.ts` and `auth.controller.e2e-spec.ts` will now FAIL at the `AppModule` import step, because `ConfigModule.forRoot()` validates against the schema and these tests' `beforeAll` blocks don't yet set `LLM_BASE_URL`/`LLM_CHAT_MODEL`/`LLM_PROXY_BEARER`. This is expected and is fixed in Step 7 — do not treat it as this task failing.

- [ ] **Step 7: Add the new required env vars to every existing e2e test's `beforeAll` env setup**

In `orchestrator/test/health.e2e-spec.ts` and `orchestrator/test/auth.controller.e2e-spec.ts`, add these three lines alongside the existing `process.env.AUTH_JWT_SECRET = 'test-jwt-secret';` line:

```typescript
process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
process.env.LLM_CHAT_MODEL = 'test-model';
process.env.LLM_PROXY_BEARER = 'test-llm-proxy-bearer';
```

- [ ] **Step 8: Run the full orchestrator suite to confirm everything passes again**

Run: `cd orchestrator && npx jest`
Expected: PASS — all pre-existing tests green again, plus this task's 4 new config tests.

- [ ] **Step 9: Commit**

```bash
git add orchestrator/src/config/config.schema.ts orchestrator/test/config.schema.spec.ts orchestrator/test/health.e2e-spec.ts orchestrator/test/auth.controller.e2e-spec.ts .env.template
git commit -m "feat(orchestrator): add LLM proxy config fields (base_url, chat_model, trusted_local, proxy_bearer)"
```

---

### Task 2: `redactor.ts` — TS port of the redaction patterns

**Files:**
- Create: `orchestrator/src/modules/llm/redactor.ts`
- Test: `orchestrator/test/redactor.spec.ts`

**Interfaces:**
- Produces: `redactText(text: string): string` and `redactMessages(messages: ChatMessage[]): ChatMessage[]` (where `ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }`) in `orchestrator/src/modules/llm/redactor.ts` — Task 3 (`OpenWebUiClient`) imports `redactMessages` by exact name.

**Boundary:** Only touch `orchestrator/src/modules/llm/redactor.ts` and this task's own test. No NestJS `@Injectable()` needed — these are plain pure functions, matching the Python redactor's own pure-function shape (`app/redaction/redactor.py`'s `_redact_text`/`redact_canonical_doc`).

- [ ] **Step 1: Write the failing tests**

```typescript
// orchestrator/test/redactor.spec.ts
import { redactMessages, redactText } from '../src/modules/llm/redactor';

describe('redactText', () => {
  it('redacts email addresses', () => {
    expect(redactText('contact jane@example.com for details')).toBe('contact <redacted> for details');
  });

  it('redacts URLs', () => {
    expect(redactText('see https://internal.corp.example/doc for spec')).toBe('see <redacted> for spec');
  });

  it('redacts GUIDs', () => {
    expect(redactText('id 123e4567-e89b-12d3-a456-426614174000 assigned')).toBe('id <redacted> assigned');
  });

  it('redacts internal hostnames', () => {
    expect(redactText('deployed to host01.internal.example')).toBe('deployed to <redacted>');
  });

  it('redacts part numbers', () => {
    expect(redactText('replace PN-4471-A immediately')).toBe('replace <redacted> immediately');
  });

  it('leaves ordinary text untouched', () => {
    expect(redactText('The receiver shall scan all channels.')).toBe('The receiver shall scan all channels.');
  });

  it('redacts multiple patterns in the same string', () => {
    const input = 'contact jane@example.com about PN-100-B';
    expect(redactText(input)).toBe('contact <redacted> about <redacted>');
  });
});

describe('redactMessages', () => {
  it('redacts content in every message', () => {
    const messages = [
      { role: 'system' as const, content: 'You are a requirements assistant.' },
      { role: 'user' as const, content: 'Contact jane@example.com for the spec.' },
    ];
    const result = redactMessages(messages);
    expect(result[0].content).toBe('You are a requirements assistant.');
    expect(result[1].content).toBe('Contact <redacted> for the spec.');
  });

  it('does not mutate the input array or its objects', () => {
    const messages = [{ role: 'user' as const, content: 'jane@example.com' }];
    const result = redactMessages(messages);
    expect(messages[0].content).toBe('jane@example.com');
    expect(result).not.toBe(messages);
  });

  it('preserves role values unchanged', () => {
    const messages = [{ role: 'assistant' as const, content: 'no pii here' }];
    expect(redactMessages(messages)[0].role).toBe('assistant');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd orchestrator && npx jest test/redactor.spec.ts`
Expected: FAIL — `Cannot find module '../src/modules/llm/redactor'`

- [ ] **Step 3: Implement**

```typescript
// orchestrator/src/modules/llm/redactor.ts

/**
 * Server-side redaction pass for the orchestrator's LLM proxy — the
 * "redact-first" egress boundary from docs/architecture.md's Locked
 * Decisions. This is a direct TS port of the same five patterns already
 * used by ingestion/app/redaction/redactor.py (Phase 1's document-level
 * redaction pass) — kept identical in both languages so the same PII/secret
 * classes are caught regardless of which service touches the text last.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const PATTERNS: RegExp[] = [
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, // email
  /https?:\/\/[^\s]+/g, // url
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, // guid
  /\b[a-zA-Z0-9-]+\.(?:internal|corp|local)\.[a-zA-Z]{2,}\b/g, // hostname
  /\b(?:PN|P\/N)-[A-Za-z0-9-]+\b/g, // part number
];

export function redactText(text: string): string {
  return PATTERNS.reduce((redacted, pattern) => redacted.replace(pattern, '<redacted>'), text);
}

export function redactMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({ ...message, content: redactText(message.content) }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd orchestrator && npx jest test/redactor.spec.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/modules/llm/redactor.ts orchestrator/test/redactor.spec.ts
git commit -m "feat(orchestrator): add TS redaction pass mirroring Python's Phase 1 patterns"
```

---

### Task 3: `LlmClient` interface + `OpenWebUiClient`

**Files:**
- Create: `orchestrator/src/modules/llm/llm-client.interface.ts`
- Create: `orchestrator/src/modules/llm/openwebui.client.ts`
- Test: `orchestrator/test/openwebui.client.spec.ts`

**Interfaces:**
- Consumes: `redactMessages` from `./redactor` (Task 2).
- Produces: `LlmClient` interface and `OpenWebUiClient` (an `@Injectable()` implementing it) in the files above — Task 4 (`/llm/chat` controller) imports `OpenWebUiClient` by exact name.

**Boundary:** Only touch the two new files and this task's own test. `chat()` is the only method implemented in this phase — `embed()`/`vision()` are declared on the interface (matching the full shape already specified in docs/architecture.md §2c) but throw `Error('not implemented — see Phase 6')` when called, since embeddings (Phase 6) and vision are out of this phase's scope.

- [ ] **Step 1: Write the failing tests**

```typescript
// orchestrator/test/openwebui.client.spec.ts
import { OpenWebUiClient } from '../src/modules/llm/openwebui.client';

describe('OpenWebUiClient', () => {
  const config = {
    LLM_BASE_URL: 'http://localhost:11434/v1',
    LLM_API_KEY: undefined,
    LLM_CHAT_MODEL: 'llama3.1',
    LLM_TRUSTED_LOCAL: false,
  };

  it('redacts messages before sending, by default', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'contact jane@example.com' }]);

    expect(fakeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'contact <redacted>' }],
        model: 'llama3.1',
      }),
    );
  });

  it('does NOT redact when LLM_TRUSTED_LOCAL is true', async () => {
    const trustedClient = new OpenWebUiClient({ ...config, LLM_TRUSTED_LOCAL: true });
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    trustedClient.openai.chat.completions.create = fakeCreate;

    await trustedClient.chat([{ role: 'user', content: 'contact jane@example.com' }]);

    expect(fakeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [{ role: 'user', content: 'contact jane@example.com' }] }),
    );
  });

  it('returns the response content string', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'The answer is 42.' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(result).toBe('The answer is 42.');
  });

  it('passes temperature through when provided', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'hi' }], { temperature: 0 });
    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0 }));
  });

  it('embed() throws not-implemented in this phase', async () => {
    const client = new OpenWebUiClient(config);
    await expect(client.embed(['text'])).rejects.toThrow(/not implemented/i);
  });

  it('vision() throws not-implemented in this phase', async () => {
    const client = new OpenWebUiClient(config);
    await expect(client.vision('prompt', [])).rejects.toThrow(/not implemented/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd orchestrator && npx jest test/openwebui.client.spec.ts`
Expected: FAIL — `Cannot find module '../src/modules/llm/openwebui.client'`

- [ ] **Step 3: Implement the interface**

```typescript
// orchestrator/src/modules/llm/llm-client.interface.ts
import type { ChatMessage } from './redactor';

/**
 * Provider-agnostic LLM client, per docs/architecture.md §2c. base_url is
 * always config-driven — never hardcoded — so the same interface works
 * against Open WebUI or Ollama's own OpenAI-compatible endpoint
 * (http://localhost:11434/v1) unmodified. Every chat() call is redacted
 * first unless LLM_TRUSTED_LOCAL is set. embed()/vision() are declared here
 * to match the full interface shape from the architecture doc, but are not
 * implemented until Phase 6 (embeddings) / vision work is scheduled.
 */
export interface LlmClient {
  chat(messages: ChatMessage[], opts?: { model?: string; temperature?: number }): Promise<string>;
  embed(texts: string[], opts?: { model?: string }): Promise<number[][]>;
  vision(prompt: string, images: Buffer[], opts?: { model?: string }): Promise<string>;
}
```

- [ ] **Step 4: Implement `OpenWebUiClient`**

```typescript
// orchestrator/src/modules/llm/openwebui.client.ts
import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import type { LlmClient } from './llm-client.interface';
import { redactMessages, type ChatMessage } from './redactor';

export interface OpenWebUiClientConfig {
  LLM_BASE_URL: string;
  LLM_API_KEY?: string;
  LLM_CHAT_MODEL: string;
  LLM_TRUSTED_LOCAL: boolean;
}

@Injectable()
export class OpenWebUiClient implements LlmClient {
  private readonly openai: OpenAI;

  constructor(private readonly config: OpenWebUiClientConfig) {
    this.openai = new OpenAI({
      baseURL: config.LLM_BASE_URL,
      apiKey: config.LLM_API_KEY ?? 'unused',
    });
  }

  async chat(messages: ChatMessage[], opts?: { model?: string; temperature?: number }): Promise<string> {
    const outboundMessages = this.config.LLM_TRUSTED_LOCAL ? messages : redactMessages(messages);
    const response = await this.openai.chat.completions.create({
      model: opts?.model ?? this.config.LLM_CHAT_MODEL,
      messages: outboundMessages,
      ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
    });
    return response.choices[0]?.message?.content ?? '';
  }

  async embed(_texts: string[], _opts?: { model?: string }): Promise<number[][]> {
    throw new Error('OpenWebUiClient.embed() not implemented — see Phase 6 (dedup/embeddings)');
  }

  async vision(_prompt: string, _images: Buffer[], _opts?: { model?: string }): Promise<string> {
    throw new Error('OpenWebUiClient.vision() not implemented — out of scope for the current phased plan');
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd orchestrator && npx jest test/openwebui.client.spec.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/modules/llm/llm-client.interface.ts orchestrator/src/modules/llm/openwebui.client.ts orchestrator/test/openwebui.client.spec.ts
git commit -m "feat(orchestrator): add LlmClient interface and OpenWebUiClient (chat only, redact-first)"
```

---

### Task 4: `POST /llm/chat` endpoint

**Files:**
- Create: `orchestrator/src/modules/llm/llm.controller.ts`
- Create: `orchestrator/src/modules/llm/llm-chat.dto.ts`
- Create: `orchestrator/src/modules/llm/llm-proxy-bearer.guard.ts`
- Create: `orchestrator/src/modules/llm/llm.module.ts`
- Modify: `orchestrator/src/app.module.ts`
- Test: `orchestrator/test/llm.controller.e2e-spec.ts`

**Interfaces:**
- Consumes: `OpenWebUiClient` (Task 3), `ChatMessage` (Task 2).
- Produces: `POST /llm/chat` accepting `{ messages: ChatMessage[], temperature?: number }`, returning `{ content: string }` on success, `401` on missing/invalid bearer, `400` on malformed body. Part B's `OrchestratorLlmClient` (Task 7) calls this exact route/shape.

**Boundary:** Only touch the five new files, `app.module.ts` (additive import), and this task's own test.

- [ ] **Step 1: Write the failing tests**

```typescript
// orchestrator/test/llm.controller.e2e-spec.ts
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { OpenWebUiClient } from '../src/modules/llm/openwebui.client';

describe('LlmController (e2e)', () => {
  let app: INestApplication;
  const fakeOpenWebUiClient = { chat: jest.fn(), embed: jest.fn(), vision: jest.fn() };

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgresql://req2ado:req2ado@localhost:5432/req2ado';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.MCP_URL = 'http://localhost:4100';
    process.env.MCP_BEARER = 'test-bearer';
    process.env.AUTH_JWT_SECRET = 'test-jwt-secret';
    process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
    process.env.LLM_CHAT_MODEL = 'test-model';
    process.env.LLM_PROXY_BEARER = 'test-llm-proxy-bearer';

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OpenWebUiClient)
      .useValue(fakeOpenWebUiClient)
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

  it('returns 401 with no Authorization header', async () => {
    const res = await request(app.getHttpServer())
      .post('/llm/chat')
      .send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(401);
  });

  it('returns 401 with the wrong bearer token', async () => {
    const res = await request(app.getHttpServer())
      .post('/llm/chat')
      .set('Authorization', 'Bearer wrong-token')
      .send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(401);
  });

  it('returns 400 on a malformed body (missing messages)', async () => {
    const res = await request(app.getHttpServer())
      .post('/llm/chat')
      .set('Authorization', 'Bearer test-llm-proxy-bearer')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns the chat content on a valid request with the correct bearer', async () => {
    fakeOpenWebUiClient.chat.mockResolvedValue('The unit shall survive a 1m drop.');
    const res = await request(app.getHttpServer())
      .post('/llm/chat')
      .set('Authorization', 'Bearer test-llm-proxy-bearer')
      .send({ messages: [{ role: 'user', content: 'summarize the drop spec' }] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ content: 'The unit shall survive a 1m drop.' });
  });

  it('passes temperature through to OpenWebUiClient.chat when provided', async () => {
    fakeOpenWebUiClient.chat.mockResolvedValue('ok');
    await request(app.getHttpServer())
      .post('/llm/chat')
      .set('Authorization', 'Bearer test-llm-proxy-bearer')
      .send({ messages: [{ role: 'user', content: 'hi' }], temperature: 0 });
    expect(fakeOpenWebUiClient.chat).toHaveBeenCalledWith(
      [{ role: 'user', content: 'hi' }],
      { temperature: 0 },
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd orchestrator && npx jest test/llm.controller.e2e-spec.ts`
Expected: FAIL — module/route doesn't exist yet.

- [ ] **Step 3: Implement the DTO**

```typescript
// orchestrator/src/modules/llm/llm-chat.dto.ts
import { z } from 'zod';

export const llmChatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string().min(1),
      }),
    )
    .min(1),
  temperature: z.number().min(0).max(2).optional(),
});

export type LlmChatRequestBody = z.infer<typeof llmChatRequestSchema>;
```

- [ ] **Step 4: Implement the bearer guard**

```typescript
// orchestrator/src/modules/llm/llm-proxy-bearer.guard.ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

/**
 * Service-to-service auth for /llm/chat: the caller is the Python ingestion
 * service, not a browser session, so this checks a static bearer token
 * (LLM_PROXY_BEARER) rather than the (separately incomplete, documented-gap)
 * user-session JWT guard. Mirrors the existing MCP_BEARER convention.
 */
@Injectable()
export class LlmProxyBearerGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    const expected = `Bearer ${this.config.get<string>('LLM_PROXY_BEARER')}`;
    if (header !== expected) {
      throw new UnauthorizedException('Invalid or missing LLM proxy bearer token');
    }
    return true;
  }
}
```

- [ ] **Step 5: Implement the controller**

```typescript
// orchestrator/src/modules/llm/llm.controller.ts
import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { llmChatRequestSchema } from './llm-chat.dto';
import { LlmProxyBearerGuard } from './llm-proxy-bearer.guard';
import { OpenWebUiClient } from './openwebui.client';

@Controller('llm')
@UseGuards(LlmProxyBearerGuard)
export class LlmController {
  constructor(private readonly llmClient: OpenWebUiClient) {}

  @Post('chat')
  async chat(@Body() rawBody: unknown): Promise<{ content: string }> {
    const parseResult = llmChatRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: messages must be a non-empty array');
    }
    const body = parseResult.data;
    const content = await this.llmClient.chat(
      body.messages,
      body.temperature !== undefined ? { temperature: body.temperature } : undefined,
    );
    return { content };
  }
}
```

- [ ] **Step 6: Implement the module**

```typescript
// orchestrator/src/modules/llm/llm.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LlmController } from './llm.controller';
import { LlmProxyBearerGuard } from './llm-proxy-bearer.guard';
import { OpenWebUiClient } from './openwebui.client';

@Module({
  imports: [ConfigModule],
  controllers: [LlmController],
  providers: [
    LlmProxyBearerGuard,
    {
      provide: OpenWebUiClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new OpenWebUiClient({
          LLM_BASE_URL: config.get<string>('LLM_BASE_URL')!,
          LLM_API_KEY: config.get<string>('LLM_API_KEY'),
          LLM_CHAT_MODEL: config.get<string>('LLM_CHAT_MODEL')!,
          LLM_TRUSTED_LOCAL: config.get<boolean>('LLM_TRUSTED_LOCAL')!,
        }),
    },
  ],
  exports: [OpenWebUiClient],
})
export class LlmModule {}
```

- [ ] **Step 7: Wire into `app.module.ts`**

```typescript
// orchestrator/src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { LlmModule } from './modules/llm/llm.module';

@Module({
  imports: [ConfigModule, HealthModule, AuthModule, LlmModule],
})
export class AppModule {}
```

- [ ] **Step 8: Run to verify it passes**

Run: `cd orchestrator && npx jest test/llm.controller.e2e-spec.ts`
Expected: PASS (5 tests)

- [ ] **Step 9: Run the full orchestrator suite**

Run: `cd orchestrator && npx jest`
Expected: all existing + new tests pass, no regressions.

- [ ] **Step 10: Commit**

```bash
git add orchestrator/src/modules/llm/llm.controller.ts orchestrator/src/modules/llm/llm-chat.dto.ts orchestrator/src/modules/llm/llm-proxy-bearer.guard.ts orchestrator/src/modules/llm/llm.module.ts orchestrator/src/app.module.ts orchestrator/test/llm.controller.e2e-spec.ts
git commit -m "feat(orchestrator): add POST /llm/chat proxy endpoint with bearer-gated access"
```

---

### Task 5: Optional live-Ollama smoke test

**Files:**
- Create: `orchestrator/test/openwebui.client.live.smoke.ts` (NOT run by default — see below)

**Interfaces:** None — this is a standalone manual verification script, not part of the automated suite.

**Boundary:** Only touch this one new file. This task does not modify Jest config to auto-discover this file (it deliberately uses a `.ts` extension without `.spec.` so `jest`'s default testMatch pattern skips it).

- [ ] **Step 1: Write the smoke script**

```typescript
// orchestrator/test/openwebui.client.live.smoke.ts
/**
 * Manual smoke test against a REAL local Ollama instance — not part of the
 * automated suite (deliberately not named *.spec.ts so Jest's default
 * testMatch skips it; CI never runs this).
 *
 * Prerequisites: `ollama serve` running locally with a chat-capable model
 * pulled (e.g. `ollama pull llama3.1`).
 *
 * Run manually with: npx ts-node test/openwebui.client.live.smoke.ts
 */
import { OpenWebUiClient } from '../src/modules/llm/openwebui.client';

async function main(): Promise<void> {
  const client = new OpenWebUiClient({
    LLM_BASE_URL: process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1',
    LLM_CHAT_MODEL: process.env.LLM_CHAT_MODEL ?? 'llama3.1',
    LLM_TRUSTED_LOCAL: true, // local dev smoke test — no redaction needed for a hello-world prompt
  });

  const result = await client.chat([{ role: 'user', content: 'Reply with exactly: OK' }], { temperature: 0 });
  console.log('Response from local Ollama:', result);
}

main().catch((err) => {
  console.error('Live Ollama smoke test failed:', err);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Verify it is NOT picked up by the automated test run**

Run: `cd orchestrator && npx jest --listTests | grep -i smoke`
Expected: empty output — confirms Jest's default `testMatch` (`*.spec.ts`) does not discover this file, so it never runs in CI or the automated suite.

- [ ] **Step 3: Commit**

```bash
git add orchestrator/test/openwebui.client.live.smoke.ts
git commit -m "docs(orchestrator): add optional manual smoke script for testing against local Ollama"
```

---

## Part B: SURVEY-Mode Generative Requirements (Python `ingestion/`)

### Task 6: `SurveyRequirementClient` Protocol + fake test double

**Files:**
- Create: `ingestion/app/survey/__init__.py`
- Create: `ingestion/app/survey/requirement_client.py`
- Test: `ingestion/tests/test_requirement_client.py`

**Interfaces:**
- Produces: `SurveyRequirementClient` (a `Protocol`) with `generate_requirements(self, block_text: str) -> list[dict]` (each dict: `{"text": str, "tags": list[str]}`), and `GeneratedRequirement` (a pydantic model wrapping one generated requirement: `text: str`, `tags: list[RequirementTag]`) in `ingestion/app/survey/requirement_client.py` — Task 7 (`OrchestratorLlmClient`) and Task 8 (`build_survey_requirements`) both import these by exact name.

**Boundary:** Only touch the two new files and this task's own test. Mirrors the established `LlmLevelingClient`/`TitleDistillationClient` Protocol pattern from Phases 2 and 3 exactly — no real HTTP call in this task, a hand-written fake client double only.

- [ ] **Step 1: Write the failing tests**

```python
# ingestion/tests/test_requirement_client.py
from app.survey.requirement_client import GeneratedRequirement, SurveyRequirementClient
from app.workitem.model import RequirementTag


class FakeSurveyRequirementClient:
    """Hand-written test double proving the SurveyRequirementClient
    interface/wiring works end-to-end. No real orchestrator LLM proxy call
    exists in THIS task — that's Task 7's OrchestratorLlmClient. Matches the
    established Phase 2-4 fake-client convention exactly."""

    def generate_requirements(self, block_text: str) -> list[dict]:
        return [
            {"text": "The unit shall survive a 1m drop onto concrete.", "tags": ["safety"]},
            {"text": "The unit shall resume normal operation within 5 seconds of impact.", "tags": ["performance", "operation"]},
        ]


def test_generated_requirement_model_validates_a_well_formed_dict() -> None:
    req = GeneratedRequirement(text="The unit shall survive a 1m drop.", tags=["safety"])
    assert req.text == "The unit shall survive a 1m drop."
    assert req.tags == [RequirementTag.SAFETY]


def test_generated_requirement_model_accepts_multiple_tags() -> None:
    req = GeneratedRequirement(text="The unit shall resume operation within 5 seconds.", tags=["performance", "operation"])
    assert req.tags == [RequirementTag.PERFORMANCE, RequirementTag.OPERATION]


def test_generated_requirement_model_defaults_to_no_tags() -> None:
    req = GeneratedRequirement(text="Some requirement.")
    assert req.tags == []


def test_survey_requirement_client_is_a_protocol_satisfied_by_the_fake() -> None:
    client: SurveyRequirementClient = FakeSurveyRequirementClient()
    result = client.generate_requirements("The unit must survive being dropped.")
    assert isinstance(result, list)
    assert result[0]["text"] == "The unit shall survive a 1m drop onto concrete."
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_requirement_client.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.survey'`

- [ ] **Step 3: Implement**

```python
# ingestion/app/survey/__init__.py
```

```python
# ingestion/app/survey/requirement_client.py
from __future__ import annotations

from typing import Protocol

from pydantic import BaseModel, Field

from app.workitem.model import RequirementTag


class GeneratedRequirement(BaseModel):
    """One LLM-generated formal 'shall' requirement, with taxonomy tags.
    Validates the tags against the same RequirementTag enum WorkItemNode
    uses, so a generated requirement can be attached to a node's tags field
    directly without a separate mapping step."""

    text: str
    tags: list[RequirementTag] = Field(default_factory=list)


class SurveyRequirementClient(Protocol):
    """Interface for SURVEY-mode generative requirement extraction. No real
    implementation exists in this task — see OrchestratorLlmClient (Task 7)
    for the first real implementation, which calls the orchestrator's
    /llm/chat proxy (Part A of this phase) rather than any LLM endpoint
    directly, per the 'backend proxy, redact-first' architecture boundary.
    Matches the runtime prompt contract documented in docs/architecture.md:
    'informal block -> formal shall requirement(s) + taxonomy tags... each
    individually verifiable.'"""

    def generate_requirements(self, block_text: str) -> list[dict]: ...
```

- [ ] **Step 4: Run to verify it passes**

Run: `pytest tests/test_requirement_client.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/survey/__init__.py ingestion/app/survey/requirement_client.py ingestion/tests/test_requirement_client.py
git commit -m "feat(ingestion): add SurveyRequirementClient interface with fake-client test"
```

---

### Task 7: `OrchestratorLlmClient` — first real LLM-backed implementation

**Files:**
- Create: `ingestion/app/survey/orchestrator_llm_client.py`
- Modify: `ingestion/pyproject.toml` (promote `httpx` from `dev` to main `dependencies`)
- Test: `ingestion/tests/test_orchestrator_llm_client.py`

**Interfaces:**
- Consumes: `SurveyRequirementClient` Protocol shape (Task 6) — `OrchestratorLlmClient` implements it.
- Produces: `OrchestratorLlmClient(base_url: str, bearer_token: str, model: str)` with `generate_requirements(self, block_text: str) -> list[dict]` in `ingestion/app/survey/orchestrator_llm_client.py` — Task 8 (`build_survey_requirements`) may inject either this or `FakeSurveyRequirementClient` interchangeably, since both satisfy the same Protocol.

**Boundary:** Only touch the new file, `pyproject.toml`'s dependency list, and this task's own test. Uses `httpx` (mocked via `respx` or `httpx.MockTransport` in tests — do not make a real network call in the automated test suite).

- [ ] **Step 1: Add `httpx` as a runtime dependency**

In `ingestion/pyproject.toml`, move `httpx` from the `[project.optional-dependencies].dev` list into the main `[project].dependencies` list:

```toml
[project]
name = "req2ado-ingestion"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.30.0",
    "pydantic>=2.9.0",
    "python-docx>=1.1.2",
    "pypdf>=5.0.0",
    "pdfplumber>=0.11.4",
    "pytesseract>=0.3.13",
    "pdf2image>=1.17.0",
    "openpyxl>=3.1.5",
    "markdown-it-py>=3.0.0",
    "python-multipart>=0.0.12",
    "httpx>=0.27.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.3.0",
    "ruff>=0.6.0",
    "mypy>=1.11.0",
    "reportlab>=4.2.0",
    "Pillow>=10.0.0",
    "jsonschema>=4.23.0",
]
```

(`httpx` was already present as a dev-only dependency for FastAPI's TestClient; it is now also a real runtime dependency for outbound calls — no version conflict, same package.)

Run: `pip install -e ".[dev]"` to pick up the change in the active venv.

- [ ] **Step 2: Write the failing tests**

```python
# ingestion/tests/test_orchestrator_llm_client.py
import httpx
import pytest

from app.survey.orchestrator_llm_client import OrchestratorLlmClient


def _mock_transport(response_json: dict, expected_status: int = 200) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-bearer"
        assert request.url.path == "/llm/chat"
        return httpx.Response(expected_status, json=response_json)

    return httpx.MockTransport(handler)


def test_generate_requirements_parses_valid_json_response() -> None:
    response_json = {
        "content": '[{"text": "The unit shall survive a 1m drop.", "tags": ["safety"]}]'
    }
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer", model="llama3.1"
    )
    client._transport = _mock_transport(response_json)  # test-only seam, see implementation

    result = client.generate_requirements("The unit must survive being dropped.")
    assert result == [{"text": "The unit shall survive a 1m drop.", "tags": ["safety"]}]


def test_generate_requirements_sends_temperature_zero() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        body = json.loads(request.content)
        captured["temperature"] = body["temperature"]
        return httpx.Response(200, json={"content": "[]"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer", model="llama3.1")
    client._transport = httpx.MockTransport(handler)

    client.generate_requirements("some block")
    assert captured["temperature"] == 0


def test_generate_requirements_raises_on_malformed_json_content() -> None:
    response_json = {"content": "not valid json"}
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer", model="llama3.1")
    client._transport = _mock_transport(response_json)

    with pytest.raises(ValueError, match="malformed"):
        client.generate_requirements("some block")


def test_generate_requirements_raises_on_non_200_response() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer", model="llama3.1")
    client._transport = _mock_transport({"content": "[]"}, expected_status=401)

    with pytest.raises(httpx.HTTPStatusError):
        client.generate_requirements("some block")
```

- [ ] **Step 3: Run to verify failure**

Run: `pytest tests/test_orchestrator_llm_client.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.survey.orchestrator_llm_client'`

- [ ] **Step 4: Implement**

```python
# ingestion/app/survey/orchestrator_llm_client.py
from __future__ import annotations

import json

import httpx


class OrchestratorLlmClient:
    """First REAL (non-fake) implementation of SurveyRequirementClient. Calls
    the orchestrator's POST /llm/chat proxy (Part A of this phase) — NEVER
    calls Open WebUI/Ollama directly, per the 'backend proxy, redact-first'
    architecture boundary in docs/architecture.md's Locked Decisions.

    The system prompt instructs the model to return a strict JSON array of
    {text, tags} objects; a malformed response raises ValueError rather than
    silently returning an empty/wrong result, since a caller acting on
    invalid generated requirements is worse than a loud failure."""

    def __init__(self, base_url: str, bearer_token: str, model: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._bearer_token = bearer_token
        self._model = model
        self._transport: httpx.BaseTransport | None = None  # test-only injection seam

    def generate_requirements(self, block_text: str) -> list[dict]:
        system_prompt = (
            "You convert informal requirement text into formal 'shall' statements. "
            "Return ONLY a JSON array of objects, each with 'text' (a single formal "
            "shall-style requirement sentence) and 'tags' (a list of zero or more of: "
            "functional, non_functional, interface, performance, regulatory, safety, "
            "security, operation, maintenance, feature, behavior). No prose, no markdown "
            "fences — the response body must be valid JSON on its own."
        )
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": block_text},
            ],
            "temperature": 0,
        }
        with httpx.Client(transport=self._transport) as client:
            response = client.post(
                f"{self._base_url}/llm/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
        response.raise_for_status()
        content = response.json()["content"]
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError as exc:
            raise ValueError(f"malformed JSON in LLM response content: {content!r}") from exc
        return parsed
```

- [ ] **Step 5: Run to verify it passes**

Run: `pytest tests/test_orchestrator_llm_client.py -v`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/survey/orchestrator_llm_client.py ingestion/pyproject.toml ingestion/tests/test_orchestrator_llm_client.py
git commit -m "feat(ingestion): add OrchestratorLlmClient, first real LLM-backed client calling the orchestrator proxy"
```

---

### Task 8: Wire into `build_survey_requirements`

**Files:**
- Create: `ingestion/app/survey/build_survey_requirements.py`
- Test: `ingestion/tests/test_build_survey_requirements.py`

**Interfaces:**
- Consumes: `SurveyRequirementClient`, `GeneratedRequirement` (Task 6).
- Produces: `build_survey_requirements(block_text: str, client: SurveyRequirementClient) -> list[GeneratedRequirement]` in `ingestion/app/survey/build_survey_requirements.py`.

**Boundary:** Only touch the new file and its own test. Does not modify `llm_leveling.py` or `tree_builder.py` — this is a standalone requirement-generation step, not yet wired into `build_survey_tree`'s node-creation loop (that integration is explicitly deferred — see Self-Review Notes below for why).

- [ ] **Step 1: Write the failing tests**

```python
# ingestion/tests/test_build_survey_requirements.py
from app.survey.build_survey_requirements import build_survey_requirements
from app.workitem.model import RequirementTag


class FakeSurveyRequirementClient:
    def generate_requirements(self, block_text: str) -> list[dict]:
        return [
            {"text": "The unit shall survive a 1m drop onto concrete.", "tags": ["safety"]},
            {"text": "The unit shall resume normal operation within 5 seconds of impact.", "tags": ["performance"]},
        ]


class EmptyResponseClient:
    def generate_requirements(self, block_text: str) -> list[dict]:
        return []


def test_build_survey_requirements_returns_validated_models() -> None:
    result = build_survey_requirements("The unit must survive being dropped.", FakeSurveyRequirementClient())
    assert len(result) == 2
    assert result[0].text == "The unit shall survive a 1m drop onto concrete."
    assert result[0].tags == [RequirementTag.SAFETY]
    assert result[1].tags == [RequirementTag.PERFORMANCE]


def test_build_survey_requirements_handles_an_empty_response() -> None:
    result = build_survey_requirements("Vague, unrequirement-like text.", EmptyResponseClient())
    assert result == []


def test_each_generated_requirement_is_individually_a_well_formed_shall_statement() -> None:
    # "individually verifiable" (Phase 5 DoD) is interpreted here as: each
    # requirement stands alone as a complete shall-statement sentence, not
    # referencing sibling requirements ("the above", "also", "additionally")
    # or trailing off incomplete. This is a lightweight heuristic check, not
    # a formal-methods verifiability proof.
    result = build_survey_requirements("The unit must survive being dropped.", FakeSurveyRequirementClient())
    for req in result:
        assert " shall " in req.text
        assert not req.text.lower().startswith(("also", "additionally", "the above"))
        assert req.text.strip().endswith(".")
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_build_survey_requirements.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Implement**

```python
# ingestion/app/survey/build_survey_requirements.py
from __future__ import annotations

from app.survey.requirement_client import GeneratedRequirement, SurveyRequirementClient


def build_survey_requirements(block_text: str, client: SurveyRequirementClient) -> list[GeneratedRequirement]:
    """Generates formal 'shall' requirements + taxonomy tags for one
    informal block, via the injected client (see requirement_client.py's
    docstring for why this is Protocol-based). Each raw dict from the client
    is validated through GeneratedRequirement, so a malformed tag value (not
    in RequirementTag) raises a pydantic ValidationError rather than
    silently passing through."""
    raw_requirements = client.generate_requirements(block_text)
    return [GeneratedRequirement(**raw) for raw in raw_requirements]
```

- [ ] **Step 4: Run to verify it passes**

Run: `pytest tests/test_build_survey_requirements.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full local ingestion suite**

Run: `pytest -v`
Expected: all Phase 1-5 tests pass (same pre-existing OCR failures, unrelated).

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/survey/build_survey_requirements.py ingestion/tests/test_build_survey_requirements.py
git commit -m "feat(ingestion): wire SurveyRequirementClient into build_survey_requirements"
```

---

### Task 9: Golden survey output test

**Files:**
- Test: `ingestion/tests/test_survey_golden.py` (new file, dedicated golden-fixture suite — matches Phase 4's convention of a separate golden-suite file for the phase's headline DoD claim)

**Interfaces:**
- Consumes: `build_survey_requirements` (Task 8), `FakeSurveyRequirementClient`-style test doubles (hand-written per this file, not imported — matches every prior phase's convention of file-local fakes for golden fixtures).

**Boundary:** Test-only task — no production code changes.

- [ ] **Step 1: Write the golden survey suite**

```python
# ingestion/tests/test_survey_golden.py
from app.survey.build_survey_requirements import build_survey_requirements
from app.workitem.model import RequirementTag


class GoldenIcdSurveyClient:
    """Fixture client simulating a realistic multi-tag, multi-requirement
    LLM response for an informal ICD-style input block — this is the
    'golden survey output' fixture Phase 5's DoD names explicitly."""

    def generate_requirements(self, block_text: str) -> list[dict]:
        assert "drop" in block_text.lower()
        return [
            {
                "text": "The unit shall survive a 1-meter drop onto a concrete surface without loss of function.",
                "tags": ["safety", "performance"],
            },
            {
                "text": "The unit shall resume normal operation within 5 seconds of a drop event.",
                "tags": ["performance", "operation"],
            },
            {
                "text": "The unit's enclosure shall show no visible cracking after a certified drop test.",
                "tags": ["safety"],
            },
        ]


def test_golden_survey_output_produces_three_formal_requirements() -> None:
    informal_text = "Needs to survive being dropped about a meter onto concrete and keep working."
    result = build_survey_requirements(informal_text, GoldenIcdSurveyClient())
    assert len(result) == 3
    assert all(req.text.strip().endswith(".") for req in result)


def test_golden_survey_output_applies_taxonomy_tags_correctly() -> None:
    informal_text = "Needs to survive being dropped about a meter onto concrete and keep working."
    result = build_survey_requirements(informal_text, GoldenIcdSurveyClient())
    assert result[0].tags == [RequirementTag.SAFETY, RequirementTag.PERFORMANCE]
    assert result[1].tags == [RequirementTag.PERFORMANCE, RequirementTag.OPERATION]
    assert result[2].tags == [RequirementTag.SAFETY]


def test_golden_survey_output_every_requirement_uses_shall_language() -> None:
    informal_text = "Needs to survive being dropped about a meter onto concrete and keep working."
    result = build_survey_requirements(informal_text, GoldenIcdSurveyClient())
    for req in result:
        assert " shall " in req.text


def test_golden_survey_output_no_requirement_references_a_sibling() -> None:
    # "Individually verifiable" — no requirement's text depends on reading
    # another requirement to make sense (no "the above", "also", "same as").
    informal_text = "Needs to survive being dropped about a meter onto concrete and keep working."
    result = build_survey_requirements(informal_text, GoldenIcdSurveyClient())
    forbidden_phrases = ["the above", "also,", "same as", "additionally,"]
    for req in result:
        lowered = req.text.lower()
        assert not any(phrase in lowered for phrase in forbidden_phrases)
```

- [ ] **Step 2: Run to verify all pass**

Run: `pytest tests/test_survey_golden.py -v`
Expected: PASS (4 tests)

- [ ] **Step 3: Run the full local suite**

Run: `pytest -v`
Expected: all Phase 1-5 tests pass, no regressions (same pre-existing OCR failures).

- [ ] **Step 4: Commit**

```bash
git add ingestion/tests/test_survey_golden.py
git commit -m "test(ingestion): add golden survey output suite covering taxonomy tags and per-requirement verifiability"
```

---

## Self-Review Notes

- **Spec coverage:** Phase 5's DoD ("Golden survey output; taxonomy tags applied; each req individually verifiable") is covered by Task 9's three named tests. The "Chat (temp 0) via proxy" LLM column is satisfied for real in this phase — Task 7's `OrchestratorLlmClient` is the first genuinely LLM-backed client in this whole project, closing the gap explicitly deferred through Phases 2-3.
- **Real gap found and fixed, confirmed with user before planning:** the orchestrator's LLM redaction-proxy was referenced by Phases 2/3/5/6 but never built by any phase — this was surfaced explicitly and the user chose to fold it into Phase 5 (Part A) rather than defer it again.
- **Deliberately NOT wired into `build_survey_tree`:** `build_survey_requirements` (Task 8) is a standalone function, not yet called from `llm_leveling.py`'s node-creation loop. Wiring it in would mean deciding how generated requirements map onto `WorkItemTree` nodes (one node per generated requirement? Attached as children of the informal block's existing node? A new node type?) — a real design question not resolved by anything in docs/architecture.md today. Surfacing this now rather than guessing: **this integration decision should be made explicitly before or during Phase 5's execution**, not embedded silently in this plan.
- **New dependency called out explicitly:** `httpx` moves from `dev`-only to a real runtime dependency (Task 7) — the first new runtime dependency since Phase 0. This is flagged because every prior phase's Global Constraints said "no new dependencies"; this phase's constraints do not repeat that line, and Task 7 states the change explicitly rather than sneaking it in.
- **Security boundary is the throughline:** every task in Part B routes through Part A's `/llm/chat`, never through Open WebUI/Ollama directly from Python — Global Constraints states this as a hard rule, Task 7's docstring restates it, and Task 9's golden fixtures never construct a direct Open WebUI/Ollama client.
- **Type consistency:** `LlmClient.chat(messages: ChatMessage[], opts?) -> Promise<string>` (Task 3, TS) is the exact shape `/llm/chat` (Task 4) exposes over HTTP as `{messages, temperature?} -> {content}`, which `OrchestratorLlmClient` (Task 7, Python) consumes with the exact same field names (`messages`, `temperature`, `content`) — no drift across the language boundary. `SurveyRequirementClient.generate_requirements(text) -> list[dict]` (Task 6) is satisfied identically by `FakeSurveyRequirementClient` (Tasks 6, 8, 9 — three independent fixtures, intentionally, matching the established one-fake-per-test-file convention from Phase 3-5) and `OrchestratorLlmClient` (Task 7) — same method name, same signature, same return shape.
- **No placeholders:** every step contains complete, runnable code in both languages.
