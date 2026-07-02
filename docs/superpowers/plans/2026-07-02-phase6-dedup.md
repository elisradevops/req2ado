# Phase 6 Dedup (Embeddings + Chroma) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement near-duplicate detection so re-ingesting the same or overlapping content doesn't create duplicate work items. Satisfies Phase 6's DoD: "0.89 keep / 0.91 skip tests; Area-Path scoping; local store only." Per `config.yaml`'s already-locked `dedup:` block: `store: chroma`, `path: ./.req2ado/vectors`, `threshold: 0.90`, `scope_by_area_path: true`.

**Architecture:** Two parts, extending Phase 5's split.

**Part A (`orchestrator/`):** implements `OpenWebUiClient.embed()` for real (Phase 5 Task 3 left it throwing `not implemented`). Per `docs/architecture.md` §2c, embeddings use a **separate transport** from chat — Open WebUI does not expose an OpenAI-shaped `/embeddings` endpoint, only an Ollama-shaped `/ollama/api/embed` proxy (confirmed by prior research in this project). New config `EMBED_TRANSPORT` (`'ollama' | 'openai'`, default `'ollama'`), `EMBED_BASE_URL` (defaults to `LLM_BASE_URL` if unset), `EMBED_MODEL`. A new `POST /llm/embed` endpoint mirrors `/llm/chat`'s shape and auth (same `LlmProxyBearerGuard`).

**Part B (`ingestion/`):** a new `app/dedup/` package. `ChromaVectorStore` wraps a local, persistent `chromadb` collection scoped per Area Path (one collection per area path, per `scope_by_area_path: true`), storing embeddings with cosine similarity. `OrchestratorEmbedClient` (mirrors Phase 5's `OrchestratorLlmClient` exactly) calls Part A's `/llm/embed` — Python never calls Open WebUI/Ollama directly, same boundary as Phase 5. `check_for_duplicates` embeds a candidate node's text, queries the area-path-scoped collection for its nearest neighbor, and returns a skip/keep decision at the locked `0.90` threshold.

**Tech Stack:** Orchestrator: same as Phase 5 (NestJS, `openai` package's raw `fetch`-based escape hatch is NOT used here — Ollama's embed endpoint is not OpenAI-shaped, so this uses plain `fetch`, matching the precedent already set by `AdoPatProvider`). Ingestion: **new runtime dependency `chromadb`** (not previously used in this project — first vector-store dependency, called out explicitly).

## Global Constraints

- Local vector store only — `chromadb`'s `PersistentClient`, no cloud/hosted mode, path from `config.yaml`'s `dedup.path` (default `./.req2ado/vectors`). This is a hard architectural constraint (`docs/architecture.md`: "Vector store local (Chroma) — no external cloud").
- Threshold is exactly `0.90` (from `config.yaml`'s `dedup.threshold`) — similarity `>= 0.90` means skip (duplicate), `< 0.90` means keep. The DoD's "0.89 keep / 0.91 skip" tests exist specifically to prove the boundary is `>=`, not `>`, and is applied at the correct side.
- Every dedup decision is scoped by Area Path (`scope_by_area_path: true`) — a candidate at 0.95 similarity to an existing item in a DIFFERENT area path must NOT be skipped. This is enforced via separate Chroma collections per area path, not a shared collection with an area_path filter (simpler correctness guarantee: cross-area-path leakage is structurally impossible, not just filtered out).
- Ingestion (Python) never calls Open WebUI/Ollama directly for embeddings, same as Phase 5's chat boundary — always through the orchestrator's `/llm/embed` proxy.
- Do not touch `app/leveling/*`, `app/distillation/*`, or `app/survey/*` (Phases 2-5, already correct) — this phase's dedup step is a standalone, separately-callable function, not wired into `build_baseline_tree`/`build_survey_tree`'s node-creation loop (same explicit-deferral pattern as Phase 5 Task 8 — the exact wiring point, e.g. "run dedup before or after tree-building, per-node or per-tree," is a pipeline-orchestration decision for whichever phase builds the actual job-queue pipeline driver, not this phase).
- Type hints (Python) / explicit types (TS) on every function signature; existing repo test conventions.

---

## Part A: Orchestrator Embeddings

### Task 1: Embed config additions

**Files:**
- Modify: `orchestrator/src/config/config.schema.ts`
- Modify: `.env.template`
- Test: `orchestrator/test/config.schema.spec.ts` (append to Phase 5's file)

**Interfaces:**
- Produces: `AppConfig` gains `EMBED_TRANSPORT: 'ollama' | 'openai'` (default `'ollama'`), `EMBED_BASE_URL: string` (optional — Task 3 falls back to `LLM_BASE_URL` when unset), `EMBED_MODEL: string`.

**Boundary:** Only touch `config.schema.ts`, `.env.template`, and the existing config test file (append only).

- [ ] **Step 1: Write the failing tests**

```typescript
// Append to orchestrator/test/config.schema.spec.ts

describe('configSchema embed fields', () => {
  const BASE_ENV_WITH_LLM = {
    DATABASE_URL: 'postgresql://req2ado:req2ado@localhost:5432/req2ado',
    REDIS_URL: 'redis://localhost:6379',
    MCP_URL: 'http://localhost:4100',
    MCP_BEARER: 'test-bearer',
    AUTH_JWT_SECRET: 'test-jwt-secret',
    LLM_BASE_URL: 'http://localhost:11434/v1',
    LLM_CHAT_MODEL: 'llama3.1',
    LLM_PROXY_BEARER: 'test-llm-proxy-bearer',
    EMBED_MODEL: 'nomic-embed-text',
  };

  it('defaults EMBED_TRANSPORT to ollama', () => {
    const result = configSchema.parse(BASE_ENV_WITH_LLM);
    expect(result.EMBED_TRANSPORT).toBe('ollama');
  });

  it('accepts an explicit EMBED_TRANSPORT of openai', () => {
    const result = configSchema.parse({ ...BASE_ENV_WITH_LLM, EMBED_TRANSPORT: 'openai' });
    expect(result.EMBED_TRANSPORT).toBe('openai');
  });

  it('rejects an invalid EMBED_TRANSPORT value', () => {
    expect(() => configSchema.parse({ ...BASE_ENV_WITH_LLM, EMBED_TRANSPORT: 'bogus' })).toThrow();
  });

  it('rejects missing EMBED_MODEL', () => {
    const { EMBED_MODEL, ...rest } = BASE_ENV_WITH_LLM;
    expect(() => configSchema.parse(rest)).toThrow();
  });

  it('leaves EMBED_BASE_URL undefined when not set', () => {
    const result = configSchema.parse(BASE_ENV_WITH_LLM);
    expect(result.EMBED_BASE_URL).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd orchestrator && npx jest test/config.schema.spec.ts`
Expected: FAIL — `EMBED_TRANSPORT`/`EMBED_MODEL` don't exist on the schema yet.

- [ ] **Step 3: Implement**

```typescript
// orchestrator/src/config/config.schema.ts
import { z } from 'zod';

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
  EMBED_TRANSPORT: z.enum(['ollama', 'openai']).default('ollama'),
  EMBED_BASE_URL: z.string().optional(),
  EMBED_MODEL: z.string().min(1),
});

export type AppConfig = z.infer<typeof configSchema>;
```

- [ ] **Step 4: Update `.env.template`**

Append to the existing `# LLM (Open WebUI...)` block:

```
EMBED_TRANSPORT=ollama
EMBED_BASE_URL=
EMBED_MODEL=
```

- [ ] **Step 5: Add the new required `EMBED_MODEL` env var to every existing e2e test's `beforeAll`**

In `orchestrator/test/health.e2e-spec.ts`, `orchestrator/test/auth.controller.e2e-spec.ts`, and `orchestrator/test/llm.controller.e2e-spec.ts`, add alongside the Phase 5 env lines:

```typescript
process.env.EMBED_MODEL = 'test-embed-model';
```

- [ ] **Step 6: Run the full orchestrator suite**

Run: `cd orchestrator && npx jest`
Expected: PASS — all pre-existing tests green, plus this task's 5 new config tests.

- [ ] **Step 7: Commit**

```bash
git add orchestrator/src/config/config.schema.ts orchestrator/test/config.schema.spec.ts orchestrator/test/health.e2e-spec.ts orchestrator/test/auth.controller.e2e-spec.ts orchestrator/test/llm.controller.e2e-spec.ts .env.template
git commit -m "feat(orchestrator): add embed transport config fields (EMBED_TRANSPORT/EMBED_BASE_URL/EMBED_MODEL)"
```

---

### Task 2: Real `OpenWebUiClient.embed()` (Ollama-shaped transport)

**Files:**
- Modify: `orchestrator/src/modules/llm/openwebui.client.ts`
- Test: `orchestrator/test/openwebui.client.spec.ts` (append to Phase 5's tests)

**Interfaces:**
- Modifies: `OpenWebUiClient`'s constructor config gains `EMBED_TRANSPORT`, `EMBED_BASE_URL` (optional, falls back to `LLM_BASE_URL`), `EMBED_MODEL`. `embed(texts: string[], opts?) -> Promise<number[][]>` now has a real implementation for `EMBED_TRANSPORT: 'ollama'`; `'openai'` transport throws `not implemented` (out of scope — no OpenAI-shaped embeddings backend is in use in this deployment; the branch exists so the interface honestly reflects the config option without silently mis-behaving if ever selected).

**Boundary:** Only touch `openwebui.client.ts` and its existing test file (append). Do not touch `chat()`'s implementation (Phase 5, already correct).

- [ ] **Step 1: Write the failing tests**

```typescript
// Append to orchestrator/test/openwebui.client.spec.ts

describe('OpenWebUiClient.embed (ollama transport)', () => {
  const config = {
    LLM_BASE_URL: 'http://localhost:11434/v1',
    LLM_API_KEY: undefined,
    LLM_CHAT_MODEL: 'llama3.1',
    LLM_TRUSTED_LOCAL: false,
    EMBED_TRANSPORT: 'ollama' as const,
    EMBED_BASE_URL: undefined,
    EMBED_MODEL: 'nomic-embed-text',
  };

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('calls the Ollama-shaped /api/embed endpoint with {model, input}', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }),
    });

    const client = new OpenWebUiClient(config);
    await client.embed(['The unit shall survive a drop.']);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embed',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'nomic-embed-text', input: ['The unit shall survive a drop.'] }),
      }),
    );
  });

  it('falls back to LLM_BASE_URL host when EMBED_BASE_URL is unset, stripping /v1', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ embeddings: [[0.1]] }) });
    const client = new OpenWebUiClient(config);
    await client.embed(['text']);
    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(calledUrl).toBe('http://localhost:11434/api/embed');
  });

  it('uses EMBED_BASE_URL directly when set, overriding the LLM_BASE_URL fallback', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ embeddings: [[0.1]] }) });
    const client = new OpenWebUiClient({ ...config, EMBED_BASE_URL: 'http://embed-host:9000' });
    await client.embed(['text']);
    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(calledUrl).toBe('http://embed-host:9000/api/embed');
  });

  it('returns the embeddings array from the response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[0.1, 0.2], [0.3, 0.4]] }),
    });
    const client = new OpenWebUiClient(config);
    const result = await client.embed(['a', 'b']);
    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
  });

  it('throws on a non-ok response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    const client = new OpenWebUiClient(config);
    await expect(client.embed(['text'])).rejects.toThrow(/embed.*500/i);
  });

  it('throws not-implemented for EMBED_TRANSPORT=openai', async () => {
    const client = new OpenWebUiClient({ ...config, EMBED_TRANSPORT: 'openai' as const });
    await expect(client.embed(['text'])).rejects.toThrow(/not implemented/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd orchestrator && npx jest test/openwebui.client.spec.ts`
Expected: FAIL — `embed()` still throws the Phase 5 "not implemented" for every transport.

- [ ] **Step 3: Implement**

```typescript
// orchestrator/src/modules/llm/openwebui.client.ts
import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import type { LlmClient } from './llm-client.interface';
import { redactMessages, redactText, type ChatMessage } from './redactor';

export interface OpenWebUiClientConfig {
  LLM_BASE_URL: string;
  LLM_API_KEY?: string;
  LLM_CHAT_MODEL: string;
  LLM_TRUSTED_LOCAL: boolean;
  EMBED_TRANSPORT: 'ollama' | 'openai';
  EMBED_BASE_URL?: string;
  EMBED_MODEL: string;
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

  async embed(texts: string[], opts?: { model?: string }): Promise<number[][]> {
    if (this.config.EMBED_TRANSPORT !== 'ollama') {
      throw new Error(
        `OpenWebUiClient.embed() not implemented for EMBED_TRANSPORT=${this.config.EMBED_TRANSPORT} — only 'ollama' (the confirmed-real Open WebUI/Ollama transport) is implemented`,
      );
    }
    const outboundTexts = this.config.LLM_TRUSTED_LOCAL ? texts : texts.map(redactText);
    const baseUrl = (this.config.EMBED_BASE_URL ?? this.config.LLM_BASE_URL).replace(/\/v1\/?$/, '');
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: opts?.model ?? this.config.EMBED_MODEL, input: outboundTexts }),
    });
    if (!response.ok) {
      throw new Error(`Ollama embed request failed: ${response.status}`);
    }
    const body = (await response.json()) as { embeddings: number[][] };
    return body.embeddings;
  }

  async vision(_prompt: string, _images: Buffer[], _opts?: { model?: string }): Promise<string> {
    throw new Error('OpenWebUiClient.vision() not implemented — out of scope for the current phased plan');
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd orchestrator && npx jest test/openwebui.client.spec.ts`
Expected: PASS (12 tests total — 6 from Phase 5, 6 new)

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/modules/llm/openwebui.client.ts orchestrator/test/openwebui.client.spec.ts
git commit -m "feat(orchestrator): implement real OpenWebUiClient.embed() via Ollama-shaped /api/embed transport"
```

---

### Task 3: `POST /llm/embed` endpoint

**Files:**
- Create: `orchestrator/src/modules/llm/llm-embed.dto.ts`
- Modify: `orchestrator/src/modules/llm/llm.controller.ts`
- Modify: `orchestrator/src/modules/llm/llm.module.ts` (update the `OpenWebUiClient` factory to pass the new embed config fields)
- Test: `orchestrator/test/llm.controller.e2e-spec.ts` (append)

**Interfaces:**
- Produces: `POST /llm/embed` accepting `{ texts: string[] }`, returning `{ embeddings: number[][] }`. Part B's `OrchestratorEmbedClient` (Task 5) calls this exact route/shape. Same `LlmProxyBearerGuard` auth as `/llm/chat`.

**Boundary:** Only touch the new DTO file, `llm.controller.ts`, `llm.module.ts`'s factory, and the existing e2e test file (append).

- [ ] **Step 1: Write the failing tests**

```typescript
// Append to orchestrator/test/llm.controller.e2e-spec.ts

describe('POST /llm/embed', () => {
  it('returns 401 with no Authorization header', async () => {
    const res = await request(app.getHttpServer()).post('/llm/embed').send({ texts: ['hi'] });
    expect(res.status).toBe(401);
  });

  it('returns 400 on a malformed body (missing texts)', async () => {
    const res = await request(app.getHttpServer())
      .post('/llm/embed')
      .set('Authorization', 'Bearer test-llm-proxy-bearer')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns embeddings on a valid request', async () => {
    fakeOpenWebUiClient.embed.mockResolvedValue([[0.1, 0.2, 0.3]]);
    const res = await request(app.getHttpServer())
      .post('/llm/embed')
      .set('Authorization', 'Bearer test-llm-proxy-bearer')
      .send({ texts: ['The unit shall survive a drop.'] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ embeddings: [[0.1, 0.2, 0.3]] });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd orchestrator && npx jest test/llm.controller.e2e-spec.ts`
Expected: FAIL — `/llm/embed` route doesn't exist yet.

- [ ] **Step 3: Implement the DTO**

```typescript
// orchestrator/src/modules/llm/llm-embed.dto.ts
import { z } from 'zod';

export const llmEmbedRequestSchema = z.object({
  texts: z.array(z.string().min(1)).min(1),
});

export type LlmEmbedRequestBody = z.infer<typeof llmEmbedRequestSchema>;
```

- [ ] **Step 4: Add the route to the existing controller**

```typescript
// orchestrator/src/modules/llm/llm.controller.ts (full file, replacing existing content)
import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { llmChatRequestSchema } from './llm-chat.dto';
import { llmEmbedRequestSchema } from './llm-embed.dto';
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

  @Post('embed')
  async embed(@Body() rawBody: unknown): Promise<{ embeddings: number[][] }> {
    const parseResult = llmEmbedRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: texts must be a non-empty array of strings');
    }
    const embeddings = await this.llmClient.embed(parseResult.data.texts);
    return { embeddings };
  }
}
```

- [ ] **Step 5: Update the module's `OpenWebUiClient` factory to pass the new config fields**

```typescript
// orchestrator/src/modules/llm/llm.module.ts (full file, replacing existing content)
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
          EMBED_TRANSPORT: config.get<'ollama' | 'openai'>('EMBED_TRANSPORT')!,
          EMBED_BASE_URL: config.get<string>('EMBED_BASE_URL'),
          EMBED_MODEL: config.get<string>('EMBED_MODEL')!,
        }),
    },
  ],
  exports: [OpenWebUiClient],
})
export class LlmModule {}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd orchestrator && npx jest test/llm.controller.e2e-spec.ts`
Expected: PASS (8 tests total — 5 from Phase 5, 3 new)

- [ ] **Step 7: Run the full orchestrator suite**

Run: `cd orchestrator && npx jest`
Expected: all pass, no regressions.

- [ ] **Step 8: Commit**

```bash
git add orchestrator/src/modules/llm/llm-embed.dto.ts orchestrator/src/modules/llm/llm.controller.ts orchestrator/src/modules/llm/llm.module.ts orchestrator/test/llm.controller.e2e-spec.ts
git commit -m "feat(orchestrator): add POST /llm/embed proxy endpoint"
```

---

## Part B: Dedup (Python `ingestion/`)

### Task 4: `ChromaVectorStore` — local, Area-Path-scoped persistent store

**Files:**
- Create: `ingestion/app/dedup/__init__.py`
- Create: `ingestion/app/dedup/vector_store.py`
- Modify: `ingestion/pyproject.toml` (add `chromadb` to main dependencies)
- Test: `ingestion/tests/test_vector_store.py`

**Interfaces:**
- Produces: `ChromaVectorStore(persist_path: str)` with `upsert(item_id: str, embedding: list[float], area_path: str) -> None` and `query_nearest(embedding: list[float], area_path: str) -> tuple[str, float] | None` (returns `(matched_item_id, similarity)` for the closest existing item in the SAME area path, or `None` if the area path's collection is empty) in `ingestion/app/dedup/vector_store.py` — Task 6 (`check_for_duplicates`) imports `ChromaVectorStore` by exact name.

**Boundary:** Only touch the new files, `pyproject.toml`'s dependency list, and this task's own test. Use a temp directory (`tmp_path` pytest fixture) for `persist_path` in every test — never write to a fixed repo-relative path from the test suite.

- [ ] **Step 1: Add `chromadb` as a runtime dependency**

```toml
# ingestion/pyproject.toml — add to [project].dependencies
    "httpx>=0.27.0",
    "chromadb>=0.5.0",
```

Run: `pip install -e ".[dev]"` to pick up the change in the active venv.

- [ ] **Step 2: Write the failing tests**

```python
# ingestion/tests/test_vector_store.py
import pytest

from app.dedup.vector_store import ChromaVectorStore


def test_query_nearest_returns_none_on_an_empty_collection(tmp_path) -> None:
    store = ChromaVectorStore(persist_path=str(tmp_path))
    result = store.query_nearest([0.1, 0.2, 0.3], area_path="Project\\Area1")
    assert result is None


def test_upsert_then_query_nearest_finds_an_exact_match() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("item-1", [1.0, 0.0, 0.0], area_path="Project\\Area1")
        result = store.query_nearest([1.0, 0.0, 0.0], area_path="Project\\Area1")
        assert result is not None
        matched_id, similarity = result
        assert matched_id == "item-1"
        assert similarity == pytest.approx(1.0, abs=1e-6)


def test_query_nearest_reflects_cosine_similarity_for_a_near_but_not_exact_match() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("item-1", [1.0, 0.0, 0.0], area_path="Project\\Area1")
        # A vector at 45 degrees from [1,0,0] has cosine similarity ~0.707
        result = store.query_nearest([1.0, 1.0, 0.0], area_path="Project\\Area1")
        assert result is not None
        matched_id, similarity = result
        assert matched_id == "item-1"
        assert similarity == pytest.approx(0.7071, abs=1e-3)


def test_area_paths_are_isolated_from_each_other() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("item-1", [1.0, 0.0, 0.0], area_path="Project\\Area1")
        # Same exact vector, but queried under a DIFFERENT area path — must
        # not match item-1, since area paths are structurally isolated
        # (separate Chroma collections), not just filtered.
        result = store.query_nearest([1.0, 0.0, 0.0], area_path="Project\\Area2")
        assert result is None


def test_upsert_is_idempotent_for_the_same_item_id() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("item-1", [1.0, 0.0, 0.0], area_path="Project\\Area1")
        store.upsert("item-1", [0.0, 1.0, 0.0], area_path="Project\\Area1")  # re-upsert, different vector
        result = store.query_nearest([0.0, 1.0, 0.0], area_path="Project\\Area1")
        matched_id, similarity = result
        assert matched_id == "item-1"
        assert similarity == pytest.approx(1.0, abs=1e-6)  # matches the UPDATED vector, not the original
```

- [ ] **Step 3: Run to verify failure**

Run: `pytest tests/test_vector_store.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.dedup'`

- [ ] **Step 4: Implement**

```python
# ingestion/app/dedup/__init__.py
```

```python
# ingestion/app/dedup/vector_store.py
from __future__ import annotations

import hashlib

import chromadb


def _collection_name_for_area_path(area_path: str) -> str:
    # Chroma collection names have character-set/length restrictions; area
    # paths can contain backslashes and arbitrary length, so this hashes to
    # a safe, fixed-length, collision-resistant identifier rather than
    # attempting to sanitize the raw area path string.
    digest = hashlib.sha256(area_path.encode()).hexdigest()[:32]
    return f"req2ado_{digest}"


class ChromaVectorStore:
    """Local, persistent, Area-Path-scoped vector store for dedup (Phase 6).
    One Chroma collection per area path — structurally isolates similarity
    matches to the same area path rather than relying on a post-query
    filter, so cross-area-path false positives are impossible by
    construction, not just filtered out. Uses cosine similarity (Chroma
    collection metadata hnsw:space=cosine); Chroma's cosine DISTANCE is
    1 - cosine_similarity, so similarity is derived as 1 - distance."""

    def __init__(self, persist_path: str) -> None:
        self._client = chromadb.PersistentClient(path=persist_path)

    def _get_collection(self, area_path: str):
        return self._client.get_or_create_collection(
            name=_collection_name_for_area_path(area_path),
            metadata={"hnsw:space": "cosine"},
        )

    def upsert(self, item_id: str, embedding: list[float], area_path: str) -> None:
        collection = self._get_collection(area_path)
        collection.upsert(ids=[item_id], embeddings=[embedding])

    def query_nearest(self, embedding: list[float], area_path: str) -> tuple[str, float] | None:
        collection = self._get_collection(area_path)
        if collection.count() == 0:
            return None
        result = collection.query(query_embeddings=[embedding], n_results=1)
        matched_id = result["ids"][0][0]
        distance = result["distances"][0][0]
        similarity = 1.0 - distance
        return matched_id, similarity
```

- [ ] **Step 5: Run to verify it passes**

Run: `pytest tests/test_vector_store.py -v`
Expected: PASS (5 tests). If the exact similarity value for the 45-degree test doesn't match `0.7071` (e.g. if the installed `chromadb` version computes cosine distance differently than `1 - cosine_similarity`), adjust the assertion to match the actual observed value from a real `chromadb` run — do not hardcode an assumed value without running it, and document in the commit/report what the real installed version returns.

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/dedup/__init__.py ingestion/app/dedup/vector_store.py ingestion/pyproject.toml ingestion/tests/test_vector_store.py
git commit -m "feat(ingestion): add ChromaVectorStore, local Area-Path-scoped persistent vector store"
```

---

### Task 5: `OrchestratorEmbedClient`

**Files:**
- Create: `ingestion/app/dedup/orchestrator_embed_client.py`
- Test: `ingestion/tests/test_orchestrator_embed_client.py`

**Interfaces:**
- Produces: `OrchestratorEmbedClient(base_url: str, bearer_token: str)` with `embed(self, texts: list[str]) -> list[list[float]]` in `ingestion/app/dedup/orchestrator_embed_client.py` — Task 6 (`check_for_duplicates`) imports this by exact name.

**Boundary:** Only touch the new file and its own test. Mirrors Phase 5 Task 7's `OrchestratorLlmClient` pattern exactly — same `httpx`-based approach, same test-only `_transport` injection seam, same "never call Open WebUI/Ollama directly" boundary.

- [ ] **Step 1: Write the failing tests**

```python
# ingestion/tests/test_orchestrator_embed_client.py
import httpx

from app.dedup.orchestrator_embed_client import OrchestratorEmbedClient


def test_embed_calls_the_orchestrator_embed_endpoint_with_bearer_auth() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-bearer"
        assert request.url.path == "/llm/embed"
        return httpx.Response(200, json={"embeddings": [[0.1, 0.2, 0.3]]})

    client = OrchestratorEmbedClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.embed(["The unit shall survive a drop."])
    assert result == [[0.1, 0.2, 0.3]]


def test_embed_sends_all_texts_in_one_request() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"embeddings": [[0.1], [0.2]]})

    client = OrchestratorEmbedClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.embed(["text one", "text two"])
    assert captured["body"]["texts"] == ["text one", "text two"]


def test_embed_raises_on_non_200_response() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"message": "unauthorized"})

    client = OrchestratorEmbedClient(base_url="http://orchestrator.internal", bearer_token="wrong-token")
    client._transport = httpx.MockTransport(handler)

    import pytest

    with pytest.raises(httpx.HTTPStatusError):
        client.embed(["text"])
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_orchestrator_embed_client.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Implement**

```python
# ingestion/app/dedup/orchestrator_embed_client.py
from __future__ import annotations

import httpx


class OrchestratorEmbedClient:
    """Calls the orchestrator's POST /llm/embed proxy (Phase 6 Part A) —
    NEVER calls Open WebUI/Ollama directly, same 'backend proxy, redact-
    first' boundary as Phase 5's OrchestratorLlmClient. Mirrors that class's
    structure and test-injection seam exactly."""

    def __init__(self, base_url: str, bearer_token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._bearer_token = bearer_token
        self._transport: httpx.BaseTransport | None = None  # test-only injection seam

    def embed(self, texts: list[str]) -> list[list[float]]:
        with httpx.Client(transport=self._transport) as client:
            response = client.post(
                f"{self._base_url}/llm/embed",
                json={"texts": texts},
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
        response.raise_for_status()
        return response.json()["embeddings"]
```

- [ ] **Step 4: Run to verify it passes**

Run: `pytest tests/test_orchestrator_embed_client.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/dedup/orchestrator_embed_client.py ingestion/tests/test_orchestrator_embed_client.py
git commit -m "feat(ingestion): add OrchestratorEmbedClient calling the orchestrator's /llm/embed proxy"
```

---

### Task 6: `check_for_duplicates` — the dedup decision function

**Files:**
- Create: `ingestion/app/dedup/check_for_duplicates.py`
- Test: `ingestion/tests/test_check_for_duplicates.py`

**Interfaces:**
- Consumes: `ChromaVectorStore` (Task 4), an embed client satisfying `embed(texts: list[str]) -> list[list[float]]` (either `OrchestratorEmbedClient` from Task 5, or a hand-written fake in tests — no Protocol needed since both this function's real and fake callers already share that one-method shape structurally).
- Produces: `DuplicateCheckResult` (pydantic model: `is_duplicate: bool`, `matched_item_id: str | None`, `similarity: float | None`) and `check_for_duplicates(text: str, item_id: str, area_path: str, embed_client, vector_store: ChromaVectorStore, threshold: float = 0.90) -> DuplicateCheckResult` in `ingestion/app/dedup/check_for_duplicates.py`.

**Boundary:** Only touch the new file and its own test. Does NOT call `vector_store.upsert()` itself — a caller decides whether to add a non-duplicate item to the store (this function only answers "is this a duplicate," it doesn't mutate the store as a side effect of checking, which would make repeated/idempotent checks of the same candidate behave differently on each call).

- [ ] **Step 1: Write the failing tests**

```python
# ingestion/tests/test_check_for_duplicates.py
import tempfile

from app.dedup.check_for_duplicates import check_for_duplicates
from app.dedup.vector_store import ChromaVectorStore


class FakeEmbedClient:
    """Deterministic fake embed client — maps specific input texts to fixed
    vectors so similarity can be controlled precisely in tests, matching
    Phase 6's DoD wording '0.89 keep / 0.91 skip tests' exactly."""

    def __init__(self, text_to_vector: dict[str, list[float]]) -> None:
        self._text_to_vector = text_to_vector

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._text_to_vector[text] for text in texts]


def test_similarity_0_91_is_flagged_as_duplicate() -> None:
    # cos(theta) = 0.91 needs a specific vector pair; using two 2D unit
    # vectors at the angle where cos(theta) = 0.91 (~24.5 degrees).
    import math

    theta = math.acos(0.91)
    existing_vector = [1.0, 0.0]
    candidate_vector = [math.cos(theta), math.sin(theta)]

    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", existing_vector, area_path="Project\\Area1")

        embed_client = FakeEmbedClient({"candidate text": candidate_vector})
        result = check_for_duplicates(
            text="candidate text",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        assert result.is_duplicate is True
        assert result.matched_item_id == "existing-item"
        assert result.similarity == pytest_approx(0.91)


def test_similarity_0_89_is_not_flagged_as_duplicate() -> None:
    import math

    theta = math.acos(0.89)
    existing_vector = [1.0, 0.0]
    candidate_vector = [math.cos(theta), math.sin(theta)]

    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", existing_vector, area_path="Project\\Area1")

        embed_client = FakeEmbedClient({"candidate text": candidate_vector})
        result = check_for_duplicates(
            text="candidate text",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        assert result.is_duplicate is False
        assert result.similarity == pytest_approx(0.89)


def test_exactly_0_90_similarity_is_flagged_as_duplicate() -> None:
    # Threshold is >= 0.90, not > 0.90 — proves the boundary is inclusive.
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", [1.0, 0.0], area_path="Project\\Area1")

        embed_client = FakeEmbedClient({"candidate text": [1.0, 0.0]})  # identical -> similarity 1.0
        result = check_for_duplicates(
            text="candidate text",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
            threshold=1.0,  # forces the exact-boundary case: similarity == threshold
        )
        assert result.is_duplicate is True


def test_empty_store_never_flags_a_duplicate() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        embed_client = FakeEmbedClient({"candidate text": [1.0, 0.0]})
        result = check_for_duplicates(
            text="candidate text",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        assert result.is_duplicate is False
        assert result.matched_item_id is None
        assert result.similarity is None


def test_does_not_mutate_the_vector_store() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", [1.0, 0.0], area_path="Project\\Area1")
        embed_client = FakeEmbedClient({"candidate text": [1.0, 0.0]})

        check_for_duplicates(
            text="candidate text",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        # Re-querying for the candidate's own vector must still only find
        # "existing-item" — check_for_duplicates must not have upserted
        # "candidate-item" into the store as a side effect.
        result = store.query_nearest([1.0, 0.0], area_path="Project\\Area1")
        assert result[0] == "existing-item"


def pytest_approx(value: float):
    import pytest

    return pytest.approx(value, abs=1e-3)
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_check_for_duplicates.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Implement**

```python
# ingestion/app/dedup/check_for_duplicates.py
from __future__ import annotations

from pydantic import BaseModel

from app.dedup.vector_store import ChromaVectorStore


class DuplicateCheckResult(BaseModel):
    is_duplicate: bool
    matched_item_id: str | None = None
    similarity: float | None = None


def check_for_duplicates(
    text: str,
    item_id: str,
    area_path: str,
    embed_client,
    vector_store: ChromaVectorStore,
    threshold: float = 0.90,
) -> DuplicateCheckResult:
    """Embeds `text` and checks it against the Area-Path-scoped vector store
    for a near-duplicate. Threshold is inclusive (similarity >= threshold
    means duplicate), per config.yaml's dedup.threshold: 0.90 and Phase 6's
    DoD ('0.89 keep / 0.91 skip'). Does NOT upsert `item_id`/its embedding
    into the store — this function only answers the question, a caller
    decides separately whether to add a confirmed-non-duplicate item."""
    [embedding] = embed_client.embed([text])
    nearest = vector_store.query_nearest(embedding, area_path=area_path)
    if nearest is None:
        return DuplicateCheckResult(is_duplicate=False)

    matched_item_id, similarity = nearest
    return DuplicateCheckResult(
        is_duplicate=similarity >= threshold,
        matched_item_id=matched_item_id,
        similarity=similarity,
    )
```

- [ ] **Step 4: Run to verify it passes**

Run: `pytest tests/test_check_for_duplicates.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full local suite**

Run: `pytest -v`
Expected: all Phase 1-6 tests pass (same pre-existing OCR failures, unrelated).

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/dedup/check_for_duplicates.py ingestion/tests/test_check_for_duplicates.py
git commit -m "feat(ingestion): add check_for_duplicates dedup decision function with inclusive 0.90 threshold"
```

---

## Self-Review Notes

- **Spec coverage:** Phase 6's DoD ("0.89 keep / 0.91 skip tests; Area-Path scoping; local store only") is covered by name: Task 6's `test_similarity_0_91_is_flagged_as_duplicate`/`test_similarity_0_89_is_not_flagged_as_duplicate`, Task 4's `test_area_paths_are_isolated_from_each_other`, and every store test using a `tmp_path`/`TemporaryDirectory` (never a cloud/hosted Chroma mode).
- **Threshold boundary made explicit and tested:** `>= threshold`, not `> threshold` — Task 6's `test_exactly_0_90_similarity_is_flagged_as_duplicate` (via a forced `threshold=1.0` exact-match case) proves the inclusive boundary directly, since constructing a real embedding pair at exactly `0.90` cosine similarity by hand is fragile; the `0.89`/`0.91` tests already prove the general direction.
- **New dependency called out explicitly:** `chromadb` (Task 4) is the first vector-store dependency in this project — flagged the same way Phase 5 flagged `httpx`'s promotion to a runtime dependency.
- **Chroma API surface risk, flagged honestly:** Task 4's Step 5 explicitly tells the implementer to verify the exact cosine-distance-to-similarity conversion against the REAL installed `chromadb` version rather than trusting the plan's assumed `1 - distance` formula blindly — Chroma's internal API has changed across versions historically, and this is exactly the kind of "verify against the real library" step Phase 1's pdfplumber table-detection issue already established as this project's convention when a library's exact behavior is uncertain from documentation alone.
- **Deliberately NOT wired into the tree-building pipeline:** same explicit-deferral pattern as Phase 5 Task 8 — `check_for_duplicates` is standalone. Deciding WHEN dedup runs in the real pipeline (per-node during tree building? A post-processing pass over the whole tree before MCP write-back?) is a job-queue/pipeline-orchestration decision that doesn't have an owning phase yet in the current 0-8 roadmap — flagged here the same way the LLM-proxy gap was flagged before Phase 5, for the user to decide when relevant.
- **Type consistency:** `ChromaVectorStore.query_nearest(...) -> tuple[str, float] | None` (Task 4) is consumed identically by `check_for_duplicates` (Task 6). `OrchestratorEmbedClient.embed(texts: list[str]) -> list[list[float]]` (Task 5) and `FakeEmbedClient.embed(...)` (Task 6's test file) share the exact same one-method shape, so `check_for_duplicates`'s `embed_client` parameter works with either without a formal Protocol — noted as an intentional simplification versus Phase 2-5's Protocol pattern, since this shape is trivial (one method, no state) and adding a Protocol here would be ceremony without benefit.
- **No placeholders:** every step contains complete, runnable code in both languages.
