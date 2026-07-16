# P3b — Per-Item AI-Assist Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user chat with an LLM about a single dry-run diff entry, get a streamed, model-selectable reply plus an optional structured title/description proposal, and accept it into the existing P3a edit flow.

**Architecture:** ingestion (Python) owns the LLM call and KB grounding, streaming tokens through a new `POST /llm/chat/stream` proxy on orchestrator's existing LLM module (never calling Open WebUI/Ollama directly — same boundary as every other LLM call in this codebase) and publishing each token to Redis (`chat:<jobId>:<localId>`). orchestrator's new `ChatGateway` (native `ws`, not socket.io — the frontend has no WS client library installed, so plain `WebSocket` is the contract) holds one shared pattern-subscribed Redis connection and relays to the browser. A REST `ChatController` handles client→server actions (send, stop, history); the WebSocket is server→client only.

**Tech Stack:** NestJS (orchestrator), FastAPI (ingestion), Prisma/Postgres, `ioredis` / `redis.asyncio`, `@nestjs/platform-ws` + `ws`, React 19 native `WebSocket`.

## Global Constraints

- Never call Open WebUI/Ollama directly from ingestion or the frontend — only via orchestrator's `/llm/*` proxy (`docs/architecture.md`'s Locked Decisions; re-affirmed in `orchestrator_llm_client.py`'s docstring).
- Chat/turn/accept only available on `action: 'create'` entries, not `excluded: true` — same restriction as P3a's `editDiffEntry`.
- Chat turn requires `job.status === 'diff_ready'`.
- Accept reuses the existing `PATCH /jobs/:id/diff/:localId` (`editDiffEntry`) — no new mutation path for the diff entry itself.
- One shared Redis subscriber connection for all open chats (pattern-subscribe `chat:*`), not one connection per chat — see `docs/superpowers/specs/2026-07-15-p3b-ai-assist-chat-design.md` §6 (Resource management).
- Conversation history sent to the LLM per turn is capped (last 10 turns); DB history load is capped at 50 rows.
- Every reference below to exact file paths, function signatures, and existing patterns was confirmed by reading the actual files in this repo — see the design spec for the source references.

---

## File Structure

**orchestrator** (new/modified):
- `orchestrator/prisma/schema.prisma` — modify: add `ChatMessage` model
- `orchestrator/prisma/migrations/20260716090000_add_chat_message/migration.sql` — new (generated)
- `orchestrator/src/modules/llm/llm-chat.dto.ts` — modify: add `model` field
- `orchestrator/src/modules/llm/llm-client.interface.ts` — modify: add `listModels`/`streamChat`
- `orchestrator/src/modules/llm/openwebui.client.ts` — modify: add `listModels()`/`streamChat()`
- `orchestrator/src/modules/llm/llm.controller.ts` — modify: thread `model` through `chat()`, add `GET /llm/models`, add `POST /llm/chat/stream`
- `orchestrator/src/modules/chat/chat.gateway.ts` — new
- `orchestrator/src/modules/chat/chat.service.ts` — new
- `orchestrator/src/modules/chat/chat.controller.ts` — new
- `orchestrator/src/modules/chat/chat.module.ts` — new
- `orchestrator/src/app.module.ts` — modify: import `ChatModule`
- `orchestrator/src/main.ts` — modify: `useWebSocketAdapter(new WsAdapter(app))`
- `orchestrator/package.json` — modify: add `@nestjs/websockets`, `@nestjs/platform-ws`, `ws`, `@types/ws`
- `orchestrator/test/openwebui.client.spec.ts` — modify: add `listModels`/`streamChat` tests
- `orchestrator/test/llm.controller.spec.ts` — new
- `orchestrator/test/chat.service.spec.ts` — new
- `orchestrator/test/chat.gateway.spec.ts` — new

**ingestion** (new/modified):
- `ingestion/pyproject.toml` — modify: add `redis` dependency
- `ingestion/app/config.py` — modify: add `redis_url`
- `ingestion/app/chat/__init__.py` — new (empty)
- `ingestion/app/chat/redis_publisher.py` — new
- `ingestion/app/chat/chat_client.py` — new
- `ingestion/app/chat/chat_service.py` — new
- `ingestion/app/main.py` — modify: add `POST /chat/{job_id}/{local_id}/turn`
- `ingestion/tests/chat/__init__.py` — new (empty)
- `ingestion/tests/chat/test_chat_client.py` — new
- `ingestion/tests/chat/test_chat_service.py` — new

**frontend** (new/modified):
- `frontend/src/api/chat.ts` — new
- `frontend/src/hooks/useChatSocket.ts` — new
- `frontend/src/components/ChatPanel.tsx` — new
- `frontend/src/components/NodeDetailPanel.tsx` — modify: add `jobId` prop, render `ChatPanel`
- `frontend/src/pages/JobDetail.tsx` — modify: pass `id` as `jobId` to `NodeDetailPanel`
- `frontend/src/components/ChatPanel.test.tsx` — new

**infra:**
- `docker-compose.yml` — modify: add `REDIS_URL` to the `ingestion` service's `environment:` block

---

### Task 1: Orchestrator — `ChatMessage` Prisma model + migration

**Files:**
- Modify: `orchestrator/prisma/schema.prisma`
- Test: `orchestrator/test/chat.service.spec.ts` (Task 8 depends on this model; this task just proves the migration applies cleanly)

**Interfaces:**
- Produces: Prisma model `ChatMessage { id: String, jobId: String, localId: String, role: String, content: String, proposedTitle: String | null, proposedDescription: String | null, model: String | null, createdAt: DateTime }`, accessible at runtime as `prisma.chatMessage.*`.

- [ ] **Step 1: Add the model to `schema.prisma`**

Append to `orchestrator/prisma/schema.prisma`:

```prisma
// One row per chat turn (user message or assistant reply) on a single
// dry-run diff entry. A log, not a state machine — acceptance of a
// proposal is a normal editDiffEntry PATCH, not tracked here. See
// docs/superpowers/specs/2026-07-15-p3b-ai-assist-chat-design.md §4.
model ChatMessage {
  id                  String   @id @default(uuid())
  jobId               String
  localId             String
  role                String // "user" | "assistant"
  content             String
  proposedTitle       String?
  proposedDescription String?
  model               String? // assistant turns only — which model produced this reply
  createdAt           DateTime @default(now())

  @@index([jobId, localId])
}
```

- [ ] **Step 2: Generate the migration**

Run: `cd orchestrator && npx prisma migrate dev --name add_chat_message`

Expected: creates `orchestrator/prisma/migrations/<timestamp>_add_chat_message/migration.sql` containing a `CREATE TABLE "ChatMessage"` statement, applies it to the dev database, and regenerates the Prisma client (`@prisma/client`'s types now include `ChatMessage`).

- [ ] **Step 3: Verify the client compiles against the new model**

Run: `cd orchestrator && npx tsc --noEmit`

Expected: no errors (confirms `@prisma/client` regenerated correctly).

- [ ] **Step 4: Commit**

```bash
git add orchestrator/prisma/schema.prisma orchestrator/prisma/migrations
git commit -m "feat(chat): add ChatMessage prisma model + migration"
```

---

### Task 2: Orchestrator — model selection: thread `model` through `/llm/chat`, add `listModels()` + `GET /chat/models`

**Files:**
- Modify: `orchestrator/src/modules/llm/llm-chat.dto.ts`
- Modify: `orchestrator/src/modules/llm/llm-client.interface.ts`
- Modify: `orchestrator/src/modules/llm/openwebui.client.ts`
- Modify: `orchestrator/src/modules/llm/llm.controller.ts`
- Test: `orchestrator/test/openwebui.client.spec.ts`

**Interfaces:**
- Produces: `OpenWebUiClient.listModels(): Promise<string[]>`, `LlmChatRequestBody.model?: string`, `POST /llm/chat` now honors `model` from the request body.
- Consumes: nothing new from other tasks.

- [ ] **Step 1: Write the failing test for `listModels()`**

Add to `orchestrator/test/openwebui.client.spec.ts` (inside the first `describe('OpenWebUiClient', ...)` block):

```ts
  it('lists available models from the OpenAI-compatible /v1/models endpoint', async () => {
    const client = new OpenWebUiClient(config);
    const fakeList = jest.fn().mockResolvedValue({ data: [{ id: 'llama3.1' }, { id: 'qwen2.5:14b' }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.models.list = fakeList;

    const models = await client.listModels();

    expect(models).toEqual(['llama3.1', 'qwen2.5:14b']);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd orchestrator && npx jest test/openwebui.client.spec.ts -t "lists available models"`
Expected: FAIL — `client.listModels is not a function`.

- [ ] **Step 3: Implement `listModels()`**

In `orchestrator/src/modules/llm/openwebui.client.ts`, add to the `OpenWebUiClient` class:

```ts
  async listModels(): Promise<string[]> {
    const page = await this.openai.models.list();
    return page.data.map((m) => m.id);
  }
```

Add the matching method to `LlmClient` in `orchestrator/src/modules/llm/llm-client.interface.ts`:

```ts
export interface LlmClient {
  chat(messages: ChatMessage[], opts?: { model?: string; temperature?: number }): Promise<string>;
  listModels(): Promise<string[]>;
  streamChat(messages: ChatMessage[], opts?: { model?: string; temperature?: number }): AsyncGenerator<string>;
  embed(texts: string[], opts?: { model?: string }): Promise<number[][]>;
  vision(prompt: string, images: Buffer[], opts?: { model?: string }): Promise<string>;
}
```

(`streamChat` is declared here now so the interface is complete after Task 3 implements it — it will fail to typecheck as a no-op stub, so implement Task 3 immediately after this step; do not commit Task 2 with a stubbed `streamChat` left unimplemented on the class. If splitting the commit is preferred, implement `streamChat` as a minimal `throw new Error('not implemented')` placeholder for this commit and replace it in Task 3 — this is acceptable ONLY as a same-PR intermediate state, not a final state.)

For this task, add the placeholder to `openwebui.client.ts` so the file compiles:

```ts
  async *streamChat(_messages: ChatMessage[], _opts?: { model?: string; temperature?: number }): AsyncGenerator<string> {
    throw new Error('streamChat not implemented yet — see Task 3');
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd orchestrator && npx jest test/openwebui.client.spec.ts -t "lists available models"`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `model` threading through `/llm/chat`**

Add to `orchestrator/test/openwebui.client.spec.ts` (existing `describe('OpenWebUiClient', ...)` block, alongside the temperature test):

```ts
  it('passes an explicit model through when provided, overriding LLM_CHAT_MODEL', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'hi' }], { model: 'qwen2.5:14b' });
    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'qwen2.5:14b' }));
  });
```

This test should already PASS without changes (`chat()` already accepts `opts?.model` per the existing implementation) — this step documents/locks the existing behavior with a regression test rather than adding new capability. Run it now to confirm:

Run: `cd orchestrator && npx jest test/openwebui.client.spec.ts -t "passes an explicit model"`
Expected: PASS (no implementation change needed for this step).

- [ ] **Step 6: Add `model` to the DTO and thread it through the controller**

In `orchestrator/src/modules/llm/llm-chat.dto.ts`, add the field:

```ts
export const llmChatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string().min(1),
      }),
    )
    .min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
});
```

In `orchestrator/src/modules/llm/llm.controller.ts`, update `chat()`:

```ts
  @Post('chat')
  async chat(@Body() rawBody: unknown): Promise<{ content: string }> {
    const parseResult = llmChatRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: messages must be a non-empty array');
    }
    const body = parseResult.data;
    const content = await this.llmClient.chat(body.messages, {
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    });
    return { content };
  }

  @Get('models')
  async models(): Promise<{ models: string[] }> {
    const models = await this.llmClient.listModels();
    return { models };
  }
```

Add `Get` to the `@nestjs/common` import at the top of `llm.controller.ts`.

- [ ] **Step 7: Write `orchestrator/test/llm.controller.spec.ts`**

There is no existing controller-level test in this module — create the file:

```ts
import { BadRequestException } from '@nestjs/common';
import { LlmController } from '../src/modules/llm/llm.controller';

describe('LlmController', () => {
  it('threads an explicit model from the request body into llmClient.chat', async () => {
    const chat = jest.fn().mockResolvedValue('reply');
    const controller = new LlmController({ chat, listModels: jest.fn() } as any);

    await controller.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'qwen2.5:14b' });

    expect(chat).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }], { model: 'qwen2.5:14b' });
  });

  it('omits model from opts when not provided in the request body', async () => {
    const chat = jest.fn().mockResolvedValue('reply');
    const controller = new LlmController({ chat, listModels: jest.fn() } as any);

    await controller.chat({ messages: [{ role: 'user', content: 'hi' }] });

    expect(chat).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }], {});
  });

  it('throws BadRequestException on an invalid body', async () => {
    const controller = new LlmController({ chat: jest.fn(), listModels: jest.fn() } as any);
    await expect(controller.chat({})).rejects.toThrow(BadRequestException);
  });

  it('GET /llm/models returns the catalog from llmClient.listModels()', async () => {
    const listModels = jest.fn().mockResolvedValue(['llama3.1', 'qwen2.5:14b']);
    const controller = new LlmController({ chat: jest.fn(), listModels } as any);

    const result = await controller.models();

    expect(result).toEqual({ models: ['llama3.1', 'qwen2.5:14b'] });
  });
});
```

- [ ] **Step 8: Run all four controller tests**

Run: `cd orchestrator && npx jest test/llm.controller.spec.ts -v`
Expected: PASS (4/4). Note: `controller.chat({...})` is called directly with a parsed object, not `rawBody: unknown` — this works because `chat()`'s parameter type is `unknown` and zod's `safeParse` accepts any shape; the first two tests pass a body that is already valid so `safeParse` succeeds.

- [ ] **Step 9: Run the full openwebui.client + llm.controller suites together**

Run: `cd orchestrator && npx jest test/openwebui.client.spec.ts test/llm.controller.spec.ts -v`
Expected: all PASS, no regressions in the pre-existing tests.

- [ ] **Step 10: Commit**

```bash
git add orchestrator/src/modules/llm orchestrator/test/openwebui.client.spec.ts orchestrator/test/llm.controller.spec.ts
git commit -m "feat(llm): thread model through /llm/chat, add GET /llm/models"
```

---

### Task 3: Orchestrator — `streamChat()` + `POST /llm/chat/stream`

**Files:**
- Modify: `orchestrator/src/modules/llm/openwebui.client.ts`
- Modify: `orchestrator/src/modules/llm/llm.controller.ts`
- Test: `orchestrator/test/openwebui.client.spec.ts`, `orchestrator/test/llm.controller.spec.ts`

**Interfaces:**
- Consumes: `LlmChatRequestBody` (Task 2, now includes `model`).
- Produces: `OpenWebUiClient.streamChat(messages, opts?): AsyncGenerator<string>` (yields text deltas). `POST /llm/chat/stream` — chunked `application/x-ndjson` response, one `{"delta": "..."}\n` line per token. Consumed by ingestion's `ChatLlmClient` (Task 5).

- [ ] **Step 1: Write the failing test for `streamChat()`**

Add to `orchestrator/test/openwebui.client.spec.ts`:

```ts
  it('streamChat yields text deltas from a streamed completion', async () => {
    const client = new OpenWebUiClient(config);
    async function* fakeStream() {
      yield { choices: [{ delta: { content: 'Hel' } }] };
      yield { choices: [{ delta: { content: 'lo' } }] };
      yield { choices: [{ delta: {} }] }; // no content — must be skipped, not yielded as ''
    }
    const fakeCreate = jest.fn().mockResolvedValue(fakeStream());
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    const deltas: string[] = [];
    for await (const delta of client.streamChat([{ role: 'user', content: 'hi' }], { model: 'llama3.1' })) {
      deltas.push(delta);
    }

    expect(deltas).toEqual(['Hel', 'lo']);
    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'llama3.1', stream: true }));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd orchestrator && npx jest test/openwebui.client.spec.ts -t "streamChat yields"`
Expected: FAIL — deltas array is empty or throws (current stub throws "not implemented yet").

- [ ] **Step 3: Implement `streamChat()`**

Replace the placeholder in `orchestrator/src/modules/llm/openwebui.client.ts`:

```ts
  async *streamChat(messages: ChatMessage[], opts?: { model?: string; temperature?: number }): AsyncGenerator<string> {
    const outboundMessages = this.config.LLM_TRUSTED_LOCAL ? messages : redactMessages(messages);
    const stream = await this.openai.chat.completions.create({
      model: opts?.model ?? this.config.LLM_CHAT_MODEL,
      messages: outboundMessages,
      stream: true,
      ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
    });
    for await (const chunk of stream as AsyncIterable<{ choices: { delta?: { content?: string } }[] }>) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd orchestrator && npx jest test/openwebui.client.spec.ts -t "streamChat yields"`
Expected: PASS.

- [ ] **Step 5: Add `POST /llm/chat/stream` to the controller**

In `orchestrator/src/modules/llm/llm.controller.ts`, add the `Response` import and the new route:

```ts
import type { Response } from 'express';
import { Res } from '@nestjs/common';
```

```ts
  @Post('chat/stream')
  async chatStream(@Body() rawBody: unknown, @Res() res: Response): Promise<void> {
    const parseResult = llmChatRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: messages must be a non-empty array');
    }
    const body = parseResult.data;
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    try {
      for await (const delta of this.llmClient.streamChat(body.messages, {
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      })) {
        res.write(`${JSON.stringify({ delta })}\n`);
      }
    } finally {
      res.end();
    }
  }
```

- [ ] **Step 6: Write the controller test for the streaming route**

Add to `orchestrator/test/llm.controller.spec.ts`:

```ts
  it('POST /llm/chat/stream writes one ndjson line per delta and ends the response', async () => {
    async function* fakeDeltas() {
      yield 'Hel';
      yield 'lo';
    }
    const streamChat = jest.fn().mockReturnValue(fakeDeltas());
    const controller = new LlmController({ chat: jest.fn(), listModels: jest.fn(), streamChat } as any);
    const written: string[] = [];
    const res = {
      setHeader: jest.fn(),
      write: jest.fn((chunk: string) => written.push(chunk)),
      end: jest.fn(),
    };

    await controller.chatStream({ messages: [{ role: 'user', content: 'hi' }] }, res as any);

    expect(written).toEqual([`${JSON.stringify({ delta: 'Hel' })}\n`, `${JSON.stringify({ delta: 'lo' })}\n`]);
    expect(res.end).toHaveBeenCalled();
  });
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd orchestrator && npx jest test/llm.controller.spec.ts -t "chat/stream"`
Expected: PASS.

- [ ] **Step 8: Run the full module suite**

Run: `cd orchestrator && npx jest test/openwebui.client.spec.ts test/llm.controller.spec.ts -v`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add orchestrator/src/modules/llm orchestrator/test/openwebui.client.spec.ts orchestrator/test/llm.controller.spec.ts
git commit -m "feat(llm): add POST /llm/chat/stream token-streaming proxy"
```

---

### Task 4: Ingestion — Redis dependency + `RedisChatPublisher`

**Files:**
- Modify: `ingestion/pyproject.toml`
- Modify: `ingestion/app/config.py`
- Create: `ingestion/app/chat/__init__.py`
- Create: `ingestion/app/chat/redis_publisher.py`
- Test: `ingestion/tests/chat/__init__.py`, `ingestion/tests/chat/test_chat_service.py` (publisher tests live alongside chat_service tests since they're exercised together — see Task 6)

**Interfaces:**
- Produces: `RedisChatPublisher(redis_url: str)` with `publish_chunk`, `publish_done`, `publish_error`, `is_aborted` — all `async def`. Channel naming: `chat:{job_id}:{local_id}`. Abort key: `chat:abort:{job_id}:{local_id}`.

- [ ] **Step 1: Add the `redis` dependency**

In `ingestion/pyproject.toml`, add to `dependencies`:

```toml
    "redis>=5.0.0",
```

Run: `cd ingestion && .venv/bin/pip install -e .`
Expected: installs `redis` and its deps without error.

- [ ] **Step 2: Add `redis_url` to settings**

In `ingestion/app/config.py`, add a field to `Settings`:

```python
    redis_url: str = "redis://localhost:6379"
```

- [ ] **Step 3: Create the empty package files**

```bash
mkdir -p ingestion/app/chat ingestion/tests/chat
touch ingestion/app/chat/__init__.py ingestion/tests/chat/__init__.py
```

- [ ] **Step 4: Write the failing test for `RedisChatPublisher`**

Create `ingestion/tests/chat/test_chat_service.py` (publisher section — chat_service tests are added to this same file in Task 6):

```python
import json

import pytest

from app.chat.redis_publisher import RedisChatPublisher


class _FakeRedis:
    def __init__(self) -> None:
        self.published: list[tuple[str, str]] = []
        self.store: dict[str, str] = {}

    async def publish(self, channel: str, message: str) -> None:
        self.published.append((channel, message))

    async def get(self, key: str) -> str | None:
        return self.store.get(key)

    async def delete(self, key: str) -> None:
        self.store.pop(key, None)


@pytest.mark.asyncio
async def test_publish_chunk_publishes_to_the_job_local_id_channel() -> None:
    fake = _FakeRedis()
    publisher = RedisChatPublisher.__new__(RedisChatPublisher)
    publisher._redis = fake  # noqa: SLF001 - test seam, avoids a real Redis connection

    await publisher.publish_chunk("job-1", "n0", "Hel")

    channel, message = fake.published[0]
    assert channel == "chat:job-1:n0"
    assert json.loads(message) == {"type": "chunk", "delta": "Hel"}


@pytest.mark.asyncio
async def test_publish_done_includes_proposal_and_model() -> None:
    fake = _FakeRedis()
    publisher = RedisChatPublisher.__new__(RedisChatPublisher)
    publisher._redis = fake  # noqa: SLF001

    await publisher.publish_done("job-1", "n0", "Here you go", "New title", None, "llama3.1")

    _, message = fake.published[0]
    assert json.loads(message) == {
        "type": "done",
        "message": "Here you go",
        "proposedTitle": "New title",
        "proposedDescription": None,
        "model": "llama3.1",
    }


@pytest.mark.asyncio
async def test_publish_error_includes_reason() -> None:
    fake = _FakeRedis()
    publisher = RedisChatPublisher.__new__(RedisChatPublisher)
    publisher._redis = fake  # noqa: SLF001

    await publisher.publish_error("job-1", "n0", "LLM unreachable")

    _, message = fake.published[0]
    assert json.loads(message) == {"type": "error", "reason": "LLM unreachable"}


@pytest.mark.asyncio
async def test_is_aborted_true_and_clears_the_key() -> None:
    fake = _FakeRedis()
    fake.store["chat:abort:job-1:n0"] = "1"
    publisher = RedisChatPublisher.__new__(RedisChatPublisher)
    publisher._redis = fake  # noqa: SLF001

    assert await publisher.is_aborted("job-1", "n0") is True
    assert "chat:abort:job-1:n0" not in fake.store


@pytest.mark.asyncio
async def test_is_aborted_false_when_no_key_set() -> None:
    fake = _FakeRedis()
    publisher = RedisChatPublisher.__new__(RedisChatPublisher)
    publisher._redis = fake  # noqa: SLF001

    assert await publisher.is_aborted("job-1", "n0") is False
```

Add `pytest-asyncio` to `ingestion/pyproject.toml`'s `dev` optional-dependencies if not already present:

```toml
    "pytest-asyncio>=0.24.0",
```

Add an `asyncio_mode = "auto"` setting so `@pytest.mark.asyncio` isn't required per-test going forward (optional convenience — keep the explicit marker above regardless, it's harmless either way). In `ingestion/pyproject.toml`, add:

```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/pip install -e ".[dev]" && .venv/bin/python -m pytest tests/chat/test_chat_service.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.chat.redis_publisher'`.

- [ ] **Step 6: Implement `RedisChatPublisher`**

Create `ingestion/app/chat/redis_publisher.py`:

```python
from __future__ import annotations

import json

import redis.asyncio as redis


class RedisChatPublisher:
    """Publishes chat-turn events to Redis for orchestrator's ChatGateway to
    relay over WebSocket, and checks/clears the per-turn abort flag a user's
    'stop generating' action sets. Channel: chat:{job_id}:{local_id}. Abort
    key: chat:abort:{job_id}:{local_id} (set by orchestrator's ChatService,
    short TTL, cleared here on read so a stale flag can't abort a future
    turn on the same item)."""

    def __init__(self, redis_url: str) -> None:
        self._redis = redis.from_url(redis_url)

    def _channel(self, job_id: str, local_id: str) -> str:
        return f"chat:{job_id}:{local_id}"

    async def publish_chunk(self, job_id: str, local_id: str, delta: str) -> None:
        await self._redis.publish(self._channel(job_id, local_id), json.dumps({"type": "chunk", "delta": delta}))

    async def publish_done(
        self,
        job_id: str,
        local_id: str,
        message: str,
        proposed_title: str | None,
        proposed_description: str | None,
        model: str,
    ) -> None:
        payload = {
            "type": "done",
            "message": message,
            "proposedTitle": proposed_title,
            "proposedDescription": proposed_description,
            "model": model,
        }
        await self._redis.publish(self._channel(job_id, local_id), json.dumps(payload))

    async def publish_error(self, job_id: str, local_id: str, reason: str) -> None:
        await self._redis.publish(self._channel(job_id, local_id), json.dumps({"type": "error", "reason": reason}))

    async def is_aborted(self, job_id: str, local_id: str) -> bool:
        key = f"chat:abort:{job_id}:{local_id}"
        value = await self._redis.get(key)
        if value:
            await self._redis.delete(key)
            return True
        return False
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd ingestion && .venv/bin/python -m pytest tests/chat/test_chat_service.py -v`
Expected: PASS (5/5).

- [ ] **Step 8: Commit**

```bash
git add ingestion/pyproject.toml ingestion/app/config.py ingestion/app/chat ingestion/tests/chat
git commit -m "feat(chat): add RedisChatPublisher for ingestion chat-turn events"
```

---

### Task 5: Ingestion — `ChatLlmClient` + sentinel-based message/proposal splitter

**Files:**
- Create: `ingestion/app/chat/chat_client.py`
- Test: `ingestion/tests/chat/test_chat_client.py`

**Interfaces:**
- Produces: `PROPOSAL_SENTINEL: str`, `split_message_and_proposal(full_text: str) -> tuple[str, str | None, str | None]`, `ChatLlmClient(base_url, bearer_token).stream_reply(messages, model) -> AsyncIterator[str]`.
- Consumes: orchestrator's `POST /llm/chat/stream` (Task 3), reachable at `{base_url}/llm/chat/stream`, returning ndjson lines `{"delta": "..."}\n`.

- [ ] **Step 1: Write the failing tests for `split_message_and_proposal`**

Create `ingestion/tests/chat/test_chat_client.py`:

```python
from app.chat.chat_client import PROPOSAL_SENTINEL, split_message_and_proposal


def test_no_sentinel_returns_full_text_as_message() -> None:
    message, title, description = split_message_and_proposal("Sure, here's why that's ambiguous.")
    assert message == "Sure, here's why that's ambiguous."
    assert title is None
    assert description is None


def test_sentinel_with_valid_json_extracts_proposal() -> None:
    text = (
        "Here's a tighter version.\n"
        f"{PROPOSAL_SENTINEL}\n"
        '{"proposedTitle": "New title", "proposedDescription": "New description"}'
    )
    message, title, description = split_message_and_proposal(text)
    assert message == "Here's a tighter version."
    assert title == "New title"
    assert description == "New description"


def test_sentinel_with_null_fields_returns_none() -> None:
    text = f"Just answering your question.\n{PROPOSAL_SENTINEL}\n" '{"proposedTitle": null, "proposedDescription": null}'
    message, title, description = split_message_and_proposal(text)
    assert message == "Just answering your question."
    assert title is None
    assert description is None


def test_sentinel_with_malformed_json_falls_back_to_message_only() -> None:
    text = f"Some reply.\n{PROPOSAL_SENTINEL}\nnot valid json"
    message, title, description = split_message_and_proposal(text)
    assert message == "Some reply."
    assert title is None
    assert description is None


def test_sentinel_with_non_dict_json_falls_back_to_message_only() -> None:
    text = f"Some reply.\n{PROPOSAL_SENTINEL}\n[1, 2, 3]"
    message, title, description = split_message_and_proposal(text)
    assert message == "Some reply."
    assert title is None
    assert description is None


def test_sentinel_with_non_string_field_values_treated_as_none() -> None:
    text = f"Some reply.\n{PROPOSAL_SENTINEL}\n" '{"proposedTitle": 42, "proposedDescription": "ok"}'
    message, title, description = split_message_and_proposal(text)
    assert title is None
    assert description == "ok"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/chat/test_chat_client.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.chat.chat_client'`.

- [ ] **Step 3: Implement `split_message_and_proposal` and `ChatLlmClient`**

Create `ingestion/app/chat/chat_client.py`:

```python
from __future__ import annotations

import json
from collections.abc import AsyncIterator

import httpx

_STREAM_REQUEST_TIMEOUT_SECONDS = 120.0
PROPOSAL_SENTINEL = "<<<PROPOSAL>>>"


def split_message_and_proposal(full_text: str) -> tuple[str, str | None, str | None]:
    """Splits a raw model reply into (message, proposedTitle, proposedDescription).
    The model is instructed (see chat_service.py's system prompt) to emit
    PROPOSAL_SENTINEL followed by a single-line JSON object after its
    conversational reply, only when it's actually proposing a change.
    Tolerant: a missing sentinel, malformed JSON, a non-dict JSON value, or a
    non-string field value all fall back to a safe default rather than
    raising — a caller acting on a chat reply is worse off failing the whole
    turn than getting no structured proposal for one malformed response."""
    sentinel_index = full_text.find(PROPOSAL_SENTINEL)
    if sentinel_index == -1:
        return full_text.strip(), None, None

    message = full_text[:sentinel_index].strip()
    raw_json = full_text[sentinel_index + len(PROPOSAL_SENTINEL) :].strip()
    try:
        parsed = json.loads(raw_json)
    except json.JSONDecodeError:
        return message, None, None
    if not isinstance(parsed, dict):
        return message, None, None

    proposed_title = parsed.get("proposedTitle")
    proposed_description = parsed.get("proposedDescription")
    proposed_title = proposed_title if isinstance(proposed_title, str) else None
    proposed_description = proposed_description if isinstance(proposed_description, str) else None
    return message, proposed_title, proposed_description


class ChatLlmClient:
    """Calls orchestrator's POST /llm/chat/stream proxy — NEVER calls Open
    WebUI/Ollama directly, same 'backend proxy, redact-first' boundary
    OrchestratorLlmClient documents. Unlike that class's synchronous
    httpx.Client (a single buffered response), this uses httpx.AsyncClient's
    streaming API since chat needs live token delivery, not one round trip."""

    def __init__(self, base_url: str, bearer_token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._bearer_token = bearer_token
        self._transport: httpx.AsyncBaseTransport | None = None  # test-only injection seam

    async def stream_reply(self, messages: list[dict], model: str | None) -> AsyncIterator[str]:
        payload: dict = {"messages": messages, "temperature": 0.3}
        if model is not None:
            payload["model"] = model
        async with httpx.AsyncClient(transport=self._transport, timeout=_STREAM_REQUEST_TIMEOUT_SECONDS) as client:
            async with client.stream(
                "POST",
                f"{self._base_url}/llm/chat/stream",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    chunk = json.loads(line)
                    delta = chunk.get("delta", "")
                    if delta:
                        yield delta
```

- [ ] **Step 4: Run the splitter tests to verify they pass**

Run: `cd ingestion && .venv/bin/python -m pytest tests/chat/test_chat_client.py -v`
Expected: PASS (6/6).

- [ ] **Step 5: Write a test for `ChatLlmClient.stream_reply` against a mocked transport**

Add to `ingestion/tests/chat/test_chat_client.py`:

```python
import httpx
import pytest

from app.chat.chat_client import ChatLlmClient


@pytest.mark.asyncio
async def test_stream_reply_yields_deltas_from_ndjson_lines() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer test-token"
        body = b'{"delta": "Hel"}\n{"delta": "lo"}\n'
        return httpx.Response(200, content=body)

    transport = httpx.MockTransport(handler)
    client = ChatLlmClient("http://orchestrator:3001", "test-token")
    client._transport = transport  # noqa: SLF001 - test injection seam

    deltas = [delta async for delta in client.stream_reply([{"role": "user", "content": "hi"}], model="llama3.1")]

    assert deltas == ["Hel", "lo"]


@pytest.mark.asyncio
async def test_stream_reply_omits_model_key_when_none() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, content=b"")

    import json

    transport = httpx.MockTransport(handler)
    client = ChatLlmClient("http://orchestrator:3001", "test-token")
    client._transport = transport  # noqa: SLF001

    [_ async for _ in client.stream_reply([{"role": "user", "content": "hi"}], model=None)]

    assert "model" not in captured["body"]
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd ingestion && .venv/bin/python -m pytest tests/chat/test_chat_client.py -v`
Expected: PASS (8/8).

- [ ] **Step 7: Commit**

```bash
git add ingestion/app/chat/chat_client.py ingestion/tests/chat/test_chat_client.py
git commit -m "feat(chat): add ChatLlmClient streaming proxy call + proposal splitter"
```

---

### Task 6: Ingestion — `_SentinelWindow`, `chat_service.run_chat_turn`, `POST /chat/{job_id}/{local_id}/turn`

**Files:**
- Create: `ingestion/app/chat/chat_service.py`
- Modify: `ingestion/app/main.py`
- Test: `ingestion/tests/chat/test_chat_service.py` (append to the file started in Task 4)

**Interfaces:**
- Consumes: `ChatLlmClient.stream_reply` (Task 5), `RedisChatPublisher` (Task 4), `retrieve_context` (`app/kb/retrieval.py`, existing P2b function — signature `retrieve_context(area_path, query_text, embed_client, vector_store, top_k=5, max_distance=0.7) -> str | None`).
- Produces: `run_chat_turn(job_id, local_id, item, history, user_message, model, area_path, embed_client, vector_store, chat_client, publisher) -> None` (never raises — always terminates with a `done` or `error` publish). FastAPI route `POST /chat/{job_id}/{local_id}/turn`.

- [ ] **Step 1: Write the failing tests for `_SentinelWindow`**

Append to `ingestion/tests/chat/test_chat_service.py`:

```python
from app.chat.chat_service import _SentinelWindow
from app.chat.chat_client import PROPOSAL_SENTINEL


def test_sentinel_window_emits_text_with_no_sentinel_after_holdback() -> None:
    window = _SentinelWindow(PROPOSAL_SENTINEL)
    emitted = window.feed("Hello there") + window.flush()
    assert emitted == "Hello there"


def test_sentinel_window_never_emits_sentinel_split_across_two_feeds() -> None:
    window = _SentinelWindow(PROPOSAL_SENTINEL)
    # Split the sentinel itself across two feed() calls.
    half = len(PROPOSAL_SENTINEL) // 2
    part1, part2 = PROPOSAL_SENTINEL[:half], PROPOSAL_SENTINEL[half:]
    emitted = window.feed(f"before {part1}") + window.feed(f"{part2} after")
    assert PROPOSAL_SENTINEL not in emitted


def test_sentinel_window_stops_emitting_once_sentinel_found() -> None:
    window = _SentinelWindow(PROPOSAL_SENTINEL)
    first = window.feed(f"message text{PROPOSAL_SENTINEL}")
    second = window.feed('{"proposedTitle": "x"}')
    assert first == "message text"
    assert second == ""
    assert window.flush() == ""


def test_sentinel_window_flush_after_no_sentinel_returns_remaining_buffer() -> None:
    window = _SentinelWindow(PROPOSAL_SENTINEL)
    window.feed("partial")
    assert window.flush() == "partial"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/chat/test_chat_service.py -v -k sentinel_window`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.chat.chat_service'`.

- [ ] **Step 3: Implement `_SentinelWindow`**

Create `ingestion/app/chat/chat_service.py` (this step adds only the class; `run_chat_turn` and the system-prompt builder follow in later steps):

```python
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_MAX_HISTORY_TURNS = 10


class _SentinelWindow:
    """Buffers streamed text so PROPOSAL_SENTINEL is never split across two
    published chunks, and stops emitting entirely once the sentinel is
    found (everything after it is the structured-proposal JSON, which must
    never reach the live token stream). Holds back the last
    (len(sentinel) - 1) characters of unemitted text until either more text
    proves they weren't the start of the sentinel, or the stream ends."""

    def __init__(self, sentinel: str) -> None:
        self._sentinel = sentinel
        self._buffer = ""
        self._found = False

    def feed(self, delta: str) -> str:
        if self._found:
            return ""
        self._buffer += delta
        sentinel_index = self._buffer.find(self._sentinel)
        if sentinel_index != -1:
            self._found = True
            emit, self._buffer = self._buffer[:sentinel_index], ""
            return emit
        hold_back = len(self._sentinel) - 1
        if len(self._buffer) <= hold_back:
            return ""
        emit, self._buffer = self._buffer[:-hold_back], self._buffer[-hold_back:]
        return emit

    def flush(self) -> str:
        if self._found:
            return ""
        emit, self._buffer = self._buffer, ""
        return emit
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ingestion && .venv/bin/python -m pytest tests/chat/test_chat_service.py -v -k sentinel_window`
Expected: PASS (4/4).

- [ ] **Step 5: Write the failing test for `run_chat_turn`**

Append to `ingestion/tests/chat/test_chat_service.py`:

```python
from app.chat.chat_client import PROPOSAL_SENTINEL
from app.chat.chat_service import run_chat_turn


class _FakeChatClient:
    def __init__(self, deltas: list[str]) -> None:
        self._deltas = deltas

    async def stream_reply(self, messages, model):  # noqa: ANN001, ARG002 - test double
        for delta in self._deltas:
            yield delta


class _FakePublisher:
    def __init__(self, aborted: bool = False) -> None:
        self.chunks: list[str] = []
        self.done: dict | None = None
        self.errors: list[str] = []
        self._aborted = aborted

    async def publish_chunk(self, job_id, local_id, delta):  # noqa: ANN001, ARG002
        self.chunks.append(delta)

    async def publish_done(self, job_id, local_id, message, proposed_title, proposed_description, model):  # noqa: ANN001, ARG002
        self.done = {
            "message": message,
            "proposedTitle": proposed_title,
            "proposedDescription": proposed_description,
            "model": model,
        }

    async def publish_error(self, job_id, local_id, reason):  # noqa: ANN001, ARG002
        self.errors.append(reason)

    async def is_aborted(self, job_id, local_id):  # noqa: ANN001, ARG002
        return self._aborted


@pytest.mark.asyncio
async def test_run_chat_turn_publishes_chunks_then_done_with_no_proposal() -> None:
    deltas = ["Sure, ", "here's ", "why."]
    chat_client = _FakeChatClient(deltas)
    publisher = _FakePublisher()

    await run_chat_turn(
        "job-1", "n0",
        {"type": "Requirement", "title": "T", "description": "D", "childType": None, "qualityIssues": []},
        [], "why is this ambiguous?", "llama3.1", None, None, None,
        chat_client, publisher,
    )

    assert "".join(publisher.chunks) == "Sure, here's why."
    assert publisher.done == {"message": "Sure, here's why.", "proposedTitle": None, "proposedDescription": None, "model": "llama3.1"}
    assert publisher.errors == []


@pytest.mark.asyncio
async def test_run_chat_turn_extracts_proposal_and_hides_json_from_chunks() -> None:
    deltas = [
        "Tighter version.\n",
        PROPOSAL_SENTINEL,
        '\n{"proposedTitle": "New", "proposedDescription": "Better"}',
    ]
    chat_client = _FakeChatClient(deltas)
    publisher = _FakePublisher()

    await run_chat_turn(
        "job-1", "n0",
        {"type": "Requirement", "title": "T", "description": "D", "childType": None, "qualityIssues": []},
        [], "make this testable", None, None, None, None,
        chat_client, publisher,
    )

    assert "".join(publisher.chunks) == "Tighter version."
    assert PROPOSAL_SENTINEL not in "".join(publisher.chunks)
    assert publisher.done == {
        "message": "Tighter version.",
        "proposedTitle": "New",
        "proposedDescription": "Better",
        "model": "",
    }


@pytest.mark.asyncio
async def test_run_chat_turn_stops_and_publishes_error_when_aborted() -> None:
    chat_client = _FakeChatClient(["one", "two", "three"])
    publisher = _FakePublisher(aborted=True)

    await run_chat_turn(
        "job-1", "n0",
        {"type": "Requirement", "title": "T", "description": "D", "childType": None, "qualityIssues": []},
        [], "hello", None, None, None, None,
        chat_client, publisher,
    )

    assert publisher.done is None
    assert publisher.errors == ["stopped by user"]


@pytest.mark.asyncio
async def test_run_chat_turn_publishes_error_on_llm_failure_never_raises() -> None:
    class _FailingChatClient:
        async def stream_reply(self, messages, model):  # noqa: ANN001, ARG002
            raise RuntimeError("LLM unreachable")
            yield  # pragma: no cover - unreachable, makes this an async generator

    publisher = _FakePublisher()

    await run_chat_turn(
        "job-1", "n0",
        {"type": "Requirement", "title": "T", "description": "D", "childType": None, "qualityIssues": []},
        [], "hello", None, None, None, None,
        _FailingChatClient(), publisher,
    )

    assert publisher.done is None
    assert publisher.errors == ["LLM unreachable"]
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/chat/test_chat_service.py -v -k run_chat_turn`
Expected: FAIL — `ImportError: cannot import name 'run_chat_turn'`.

- [ ] **Step 7: Implement `run_chat_turn` and the system-prompt builder**

Append to `ingestion/app/chat/chat_service.py`:

```python
from app.chat.chat_client import ChatLlmClient, PROPOSAL_SENTINEL, split_message_and_proposal
from app.chat.redis_publisher import RedisChatPublisher
from app.kb.retrieval import retrieve_context

_SYSTEM_PROMPT_TEMPLATE = (
    "You are refining ONE requirement item in a document review tool. The user "
    "may ask a question or ask you to rewrite the item. Item type: {item_type}. "
    "Item title: {title}. Item description: {description}. {quality_note}"
    "Reply conversationally first. If — and only if — the user asked for a "
    "rewrite of the title and/or description, end your reply with a new line "
    f"containing exactly '{PROPOSAL_SENTINEL}' followed by a single-line JSON "
    'object: {{"proposedTitle": <string or null>, "proposedDescription": '
    '<string or null>}}. If no rewrite was requested, omit the sentinel line '
    "entirely."
)


def _build_system_prompt(item: dict, kb_context: str | None) -> str:
    quality_note = ""
    if item.get("qualityIssues"):
        quality_note = f"Known quality issues: {', '.join(item['qualityIssues'])}. "
    prompt = _SYSTEM_PROMPT_TEMPLATE.format(
        item_type=item.get("childType") or item.get("type") or "Requirement",
        title=item["title"],
        description=item["description"],
        quality_note=quality_note,
    )
    if kb_context:
        prompt = (
            "Reference material from the knowledge base (may be incomplete or "
            f"irrelevant — use only what's genuinely helpful):\n\n{kb_context}\n\n{prompt}"
        )
    return prompt


async def run_chat_turn(
    job_id: str,
    local_id: str,
    item: dict,
    history: list[dict],
    user_message: str,
    model: str | None,
    area_path: str | None,
    embed_client: object | None,
    vector_store: object | None,
    chat_client: ChatLlmClient,
    publisher: RedisChatPublisher,
) -> None:
    """Drives one chat turn end-to-end: retrieves KB context (best-effort),
    builds the prompt, streams the reply, publishes chunks to Redis as they
    arrive, and publishes a final done/error event. Never raises — any
    failure is caught and published as an error event so the WS relay
    (orchestrator) always gets a terminal event for this turn."""
    try:
        kb_context = None
        if area_path is not None and embed_client is not None and vector_store is not None:
            kb_context = retrieve_context(area_path, user_message, embed_client, vector_store)

        system_prompt = _build_system_prompt(item, kb_context)
        capped_history = history[-_MAX_HISTORY_TURNS:]
        messages = (
            [{"role": "system", "content": system_prompt}]
            + capped_history
            + [{"role": "user", "content": user_message}]
        )

        window = _SentinelWindow(PROPOSAL_SENTINEL)
        full_text = ""
        async for delta in chat_client.stream_reply(messages, model):
            if await publisher.is_aborted(job_id, local_id):
                logger.info("Chat turn aborted for job_id=%s local_id=%s", job_id, local_id)
                await publisher.publish_error(job_id, local_id, "stopped by user")
                return
            full_text += delta
            emit = window.feed(delta)
            if emit:
                await publisher.publish_chunk(job_id, local_id, emit)

        trailing = window.flush()
        if trailing:
            await publisher.publish_chunk(job_id, local_id, trailing)

        message, proposed_title, proposed_description = split_message_and_proposal(full_text)
        await publisher.publish_done(job_id, local_id, message, proposed_title, proposed_description, model or "")
    except Exception as exc:  # noqa: BLE001 - a chat turn must always terminate with an event
        logger.warning("Chat turn failed for job_id=%s local_id=%s: %s", job_id, local_id, exc)
        await publisher.publish_error(job_id, local_id, str(exc))
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd ingestion && .venv/bin/python -m pytest tests/chat/test_chat_service.py -v`
Expected: PASS (all — `_SentinelWindow` + `run_chat_turn` tests + Task 4's publisher tests, run together in this one file).

- [ ] **Step 9: Add the FastAPI route**

In `ingestion/app/main.py`, add imports:

```python
from app.chat.chat_client import ChatLlmClient
from app.chat.chat_service import run_chat_turn
from app.chat.redis_publisher import RedisChatPublisher
```

Add request models and the route (after the existing `KbIngestUrlRequest` model):

```python
class ChatTurnItem(BaseModel):
    type: str
    title: str
    description: str
    childType: str | None = None
    qualityIssues: list[str] = []


class ChatTurnMessage(BaseModel):
    role: str
    content: str


class ChatTurnRequest(BaseModel):
    item: ChatTurnItem
    history: list[ChatTurnMessage] = []
    message: str
    model: str | None = None
    area_path: str | None = None
```

```python
@app.post("/chat/{job_id}/{local_id}/turn")
async def chat_turn(job_id: str, local_id: str, body: ChatTurnRequest) -> dict[str, bool]:
    # Fully async (httpx.AsyncClient, redis.asyncio) — no run_in_threadpool
    # needed here, unlike /level and /kb/ingest-*, which wrap synchronous
    # httpx.Client calls. The caller (orchestrator's ChatService) doesn't
    # await this request's completion either way — see chat.service.ts.
    chat_client = ChatLlmClient(settings.orchestrator_url, settings.llm_proxy_bearer)
    publisher = RedisChatPublisher(settings.redis_url)
    await run_chat_turn(
        job_id,
        local_id,
        body.item.model_dump(),
        [m.model_dump() for m in body.history],
        body.message,
        body.model,
        body.area_path,
        _embed_client,
        _kb_vector_store,
        chat_client,
        publisher,
    )
    return {"ok": True}
```

- [ ] **Step 10: Run the full ingestion test suite**

Run: `cd ingestion && .venv/bin/python -m pytest -v`
Expected: all PASS, no regressions (the same 7 pre-existing OCR/poppler failures noted in the handoff doc are expected and unrelated).

- [ ] **Step 11: Commit**

```bash
git add ingestion/app/chat/chat_service.py ingestion/app/main.py ingestion/tests/chat/test_chat_service.py ingestion/pyproject.toml
git commit -m "feat(chat): add run_chat_turn orchestration + POST /chat/{job_id}/{local_id}/turn"
```

---

### Task 7: Orchestrator — WS adapter wiring + package deps

**Files:**
- Modify: `orchestrator/package.json`
- Modify: `orchestrator/src/main.ts`

**Interfaces:**
- Produces: `app.useWebSocketAdapter(new WsAdapter(app))` — native `ws`-backed WebSocket support for `@WebSocketGateway` decorators added in Task 8.

- [ ] **Step 1: Add dependencies**

In `orchestrator/package.json`, add to `dependencies`:

```json
    "@nestjs/platform-ws": "^10.4.0",
    "@nestjs/websockets": "^10.4.0",
    "ws": "^8.18.0",
```

Add to `devDependencies`:

```json
    "@types/ws": "^8.5.12",
```

Run: `cd orchestrator && npm install`
Expected: installs cleanly, `package-lock.json` updated.

- [ ] **Step 2: Wire the adapter in `main.ts`**

Modify `orchestrator/src/main.ts`:

```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  app.useWebSocketAdapter(new WsAdapter(app));
  if (process.env.CORS_ORIGIN) {
    app.enableCors({ origin: process.env.CORS_ORIGIN, credentials: true });
  }
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
}

void bootstrap();
```

- [ ] **Step 3: Verify the app still boots**

Run: `cd orchestrator && npx tsc --noEmit`
Expected: no errors. (Full boot verification happens in Task 8 once a gateway actually exists — an adapter with zero gateways registered is a no-op change at this point, verified here only by typecheck.)

- [ ] **Step 4: Commit**

```bash
git add orchestrator/package.json orchestrator/package-lock.json orchestrator/src/main.ts
git commit -m "chore(chat): add ws/platform-ws deps, wire WsAdapter"
```

---

### Task 8: Orchestrator — `ChatGateway`, `ChatService`, `ChatController`, `ChatModule`

**Files:**
- Create: `orchestrator/src/modules/chat/chat.gateway.ts`
- Create: `orchestrator/src/modules/chat/chat.service.ts`
- Create: `orchestrator/src/modules/chat/chat.controller.ts`
- Create: `orchestrator/src/modules/chat/chat.module.ts`
- Modify: `orchestrator/src/app.module.ts`
- Test: `orchestrator/test/chat.service.spec.ts`, `orchestrator/test/chat.gateway.spec.ts`

**Interfaces:**
- Consumes: `PrismaClient.chatMessage` (Task 1), `OpenWebUiClient.listModels()` (Task 2), `ioredis` `Redis`.
- Produces: `ChatService.sendTurn/getHistory/stopTurn/persistAssistantTurn`, `ChatGateway` (relays `chat:*` Redis pub/sub to WS clients grouped by `jobId:localId`), REST routes `GET /chat/models`, `POST /jobs/:jobId/diff/:localId/chat`, `GET /jobs/:jobId/diff/:localId/chat`, `POST /jobs/:jobId/diff/:localId/chat/stop`.

- [ ] **Step 1: Write the failing tests for `ChatService`**

Create `orchestrator/test/chat.service.spec.ts`:

```ts
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ChatService } from '../src/modules/chat/chat.service';

function makeDiffJob(overrides: Partial<{ status: string; entryOverrides: Record<string, unknown> }> = {}) {
  return {
    id: 'job-1',
    status: overrides.status ?? 'diff_ready',
    areaPath: 'Project\\Area1',
    dryRunDiff: [
      {
        localId: 'n0',
        type: 'Requirement',
        title: 'T',
        description: 'D',
        action: 'create',
        excluded: false,
        childType: null,
        qualityIssues: [],
        ...overrides.entryOverrides,
      },
    ],
  };
}

describe('ChatService.sendTurn', () => {
  it('throws NotFoundException when the job does not exist', async () => {
    const prisma = { job: { findUnique: jest.fn().mockResolvedValue(null) }, chatMessage: { create: jest.fn() } };
    const service = new ChatService(prisma as any, 'http://ingestion:8000', { set: jest.fn() } as any);
    await expect(service.sendTurn('job-1', 'n0', 'hi', undefined)).rejects.toThrow(NotFoundException);
  });

  it('throws ConflictException when job.status is not diff_ready', async () => {
    const prisma = { job: { findUnique: jest.fn().mockResolvedValue(makeDiffJob({ status: 'running' })) }, chatMessage: { create: jest.fn() } };
    const service = new ChatService(prisma as any, 'http://ingestion:8000', { set: jest.fn() } as any);
    await expect(service.sendTurn('job-1', 'n0', 'hi', undefined)).rejects.toThrow(ConflictException);
  });

  it('throws NotFoundException when the diff entry does not exist', async () => {
    const prisma = { job: { findUnique: jest.fn().mockResolvedValue(makeDiffJob()) }, chatMessage: { create: jest.fn() } };
    const service = new ChatService(prisma as any, 'http://ingestion:8000', { set: jest.fn() } as any);
    await expect(service.sendTurn('job-1', 'does-not-exist', 'hi', undefined)).rejects.toThrow(NotFoundException);
  });

  it('throws ConflictException for a non-create-action entry', async () => {
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue(makeDiffJob({ entryOverrides: { action: 'reuse' } })) },
      chatMessage: { create: jest.fn() },
    };
    const service = new ChatService(prisma as any, 'http://ingestion:8000', { set: jest.fn() } as any);
    await expect(service.sendTurn('job-1', 'n0', 'hi', undefined)).rejects.toThrow(ConflictException);
  });

  it('throws ConflictException for an excluded entry', async () => {
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue(makeDiffJob({ entryOverrides: { excluded: true } })) },
      chatMessage: { create: jest.fn() },
    };
    const service = new ChatService(prisma as any, 'http://ingestion:8000', { set: jest.fn() } as any);
    await expect(service.sendTurn('job-1', 'n0', 'hi', undefined)).rejects.toThrow(ConflictException);
  });

  it('persists the user turn before returning', async () => {
    const create = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue(makeDiffJob()) },
      chatMessage: { create, findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new ChatService(prisma as any, 'http://ingestion:8000', { set: jest.fn() } as any);

    await service.sendTurn('job-1', 'n0', 'hello there', 'llama3.1');

    expect(create).toHaveBeenCalledWith({
      data: { jobId: 'job-1', localId: 'n0', role: 'user', content: 'hello there', model: 'llama3.1' },
    });
  });
});

describe('ChatService.getHistory', () => {
  it('returns the last 50 turns ordered oldest-first', async () => {
    const rows = [{ id: '1', jobId: 'job-1', localId: 'n0', role: 'user', content: 'hi', proposedTitle: null, proposedDescription: null, model: null, createdAt: new Date('2026-01-01') }];
    const findMany = jest.fn().mockResolvedValue(rows);
    const prisma = { chatMessage: { findMany } };
    const service = new ChatService(prisma as any, 'http://ingestion:8000', { set: jest.fn() } as any);

    const history = await service.getHistory('job-1', 'n0');

    expect(findMany).toHaveBeenCalledWith({ where: { jobId: 'job-1', localId: 'n0' }, orderBy: { createdAt: 'asc' }, take: 50 });
    expect(history).toEqual([{ id: '1', role: 'user', content: 'hi', proposedTitle: null, proposedDescription: null, model: null, createdAt: rows[0].createdAt }]);
  });
});

describe('ChatService.stopTurn', () => {
  it('sets the abort key with a short TTL', async () => {
    const set = jest.fn().mockResolvedValue(undefined);
    const service = new ChatService({} as any, 'http://ingestion:8000', { set } as any);

    await service.stopTurn('job-1', 'n0');

    expect(set).toHaveBeenCalledWith('chat:abort:job-1:n0', '1', 'EX', 30);
  });
});

describe('ChatService.persistAssistantTurn', () => {
  it('parses jobId/localId from the channel name and persists an assistant row', async () => {
    const create = jest.fn().mockResolvedValue(undefined);
    const service = new ChatService({ chatMessage: { create } } as any, 'http://ingestion:8000', { set: jest.fn() } as any);

    await service.persistAssistantTurn('chat:job-1:n0', {
      message: 'Here you go', proposedTitle: 'New title', proposedDescription: null, model: 'llama3.1',
    });

    expect(create).toHaveBeenCalledWith({
      data: { jobId: 'job-1', localId: 'n0', role: 'assistant', content: 'Here you go', proposedTitle: 'New title', proposedDescription: null, model: 'llama3.1' },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd orchestrator && npx jest test/chat.service.spec.ts -v`
Expected: FAIL — `Cannot find module '../src/modules/chat/chat.service'`.

- [ ] **Step 3: Implement `ChatService`**

Create `orchestrator/src/modules/chat/chat.service.ts`:

```ts
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import axios from 'axios';

const CHAT_HISTORY_LIMIT = 50;

export interface ChatMessageDto {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  proposedTitle: string | null;
  proposedDescription: string | null;
  model: string | null;
  createdAt: Date;
}

interface DoneEventPayload {
  message: string;
  proposedTitle: string | null;
  proposedDescription: string | null;
  model: string;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ingestionBaseUrl: string,
    private readonly redis: Redis,
  ) {}

  async sendTurn(jobId: string, localId: string, message: string, model: string | undefined): Promise<void> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException(`Job ${jobId} not found`);
    if (job.status !== 'diff_ready') {
      throw new ConflictException(`Job ${jobId} is not in diff_ready status`);
    }
    const diff = (job.dryRunDiff as any[] | null) ?? [];
    const entry = diff.find((e) => e.localId === localId);
    if (!entry) throw new NotFoundException(`Diff entry ${localId} not found`);
    if (entry.action !== 'create' || entry.excluded) {
      throw new ConflictException(
        `Diff entry ${localId} is not chattable (action=${entry.action}, excluded=${!!entry.excluded})`,
      );
    }

    await this.prisma.chatMessage.create({
      data: { jobId, localId, role: 'user', content: message, model: model ?? null },
    });

    const history = await this.prisma.chatMessage.findMany({
      where: { jobId, localId },
      orderBy: { createdAt: 'asc' },
      take: CHAT_HISTORY_LIMIT,
    });

    const payload = {
      item: {
        type: entry.type,
        title: entry.title,
        description: entry.description,
        childType: entry.childType ?? null,
        qualityIssues: entry.qualityIssues ?? [],
      },
      history: history.map((h: { role: string; content: string }) => ({ role: h.role, content: h.content })),
      message,
      model: model ?? null,
      area_path: job.areaPath,
    };

    // Fire-and-forget: the caller gets an immediate ack; the actual reply
    // streams over the WS relay this same call kicks off server-side in
    // ingestion. Never await the full turn here — it can take tens of
    // seconds and the REST response's only job is "the turn started".
    void axios
      .post(`${this.ingestionBaseUrl}/chat/${jobId}/${localId}/turn`, payload)
      .catch((err) => this.logger.error(`ingestion chat turn call failed: ${err}`));
  }

  async getHistory(jobId: string, localId: string): Promise<ChatMessageDto[]> {
    const rows = await this.prisma.chatMessage.findMany({
      where: { jobId, localId },
      orderBy: { createdAt: 'asc' },
      take: CHAT_HISTORY_LIMIT,
    });
    return rows.map((r: any) => ({
      id: r.id,
      role: r.role as 'user' | 'assistant',
      content: r.content,
      proposedTitle: r.proposedTitle,
      proposedDescription: r.proposedDescription,
      model: r.model,
      createdAt: r.createdAt,
    }));
  }

  async stopTurn(jobId: string, localId: string): Promise<void> {
    await this.redis.set(`chat:abort:${jobId}:${localId}`, '1', 'EX', 30);
  }

  async persistAssistantTurn(channel: string, payload: DoneEventPayload): Promise<void> {
    const [, jobId, localId] = channel.split(':');
    await this.prisma.chatMessage.create({
      data: {
        jobId,
        localId,
        role: 'assistant',
        content: payload.message,
        proposedTitle: payload.proposedTitle,
        proposedDescription: payload.proposedDescription,
        model: payload.model || null,
      },
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd orchestrator && npx jest test/chat.service.spec.ts -v`
Expected: PASS (all).

- [ ] **Step 5: Write the failing tests for `ChatGateway`**

Create `orchestrator/test/chat.gateway.spec.ts`:

```ts
import { ChatGateway } from '../src/modules/chat/chat.gateway';

function makeSocket() {
  return { readyState: 1, OPEN: 1, send: jest.fn(), close: jest.fn() };
}

describe('ChatGateway', () => {
  it('subscribes to chat:* on construction', () => {
    const subscriber = { psubscribe: jest.fn(), on: jest.fn() };
    new ChatGateway(subscriber as any, { persistAssistantTurn: jest.fn() } as any);
    expect(subscriber.psubscribe).toHaveBeenCalledWith('chat:*');
  });

  it('relays a pmessage only to sockets in the matching room', () => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const subscriber = { psubscribe: jest.fn(), on: jest.fn((event, cb) => (handlers[event] = cb)) };
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn: jest.fn() } as any);

    const socketA = makeSocket();
    const socketB = makeSocket();
    gateway.handleConnection(socketA as any, { url: '/chat?jobId=job-1&localId=n0' } as any);
    gateway.handleConnection(socketB as any, { url: '/chat?jobId=job-1&localId=n1' } as any);

    handlers.pmessage('chat:*', 'chat:job-1:n0', JSON.stringify({ type: 'chunk', delta: 'Hi' }));

    expect(socketA.send).toHaveBeenCalledWith(JSON.stringify({ type: 'chunk', delta: 'Hi' }));
    expect(socketB.send).not.toHaveBeenCalled();
  });

  it('closes a connection missing jobId/localId query params', () => {
    const subscriber = { psubscribe: jest.fn(), on: jest.fn() };
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn: jest.fn() } as any);
    const socket = makeSocket();

    gateway.handleConnection(socket as any, { url: '/chat' } as any);

    expect(socket.close).toHaveBeenCalledWith(1008, 'jobId and localId are required');
  });

  it('removes a disconnected socket from its room so a later relay no longer reaches it', () => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const subscriber = { psubscribe: jest.fn(), on: jest.fn((event, cb) => (handlers[event] = cb)) };
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn: jest.fn() } as any);
    const socket = makeSocket();
    gateway.handleConnection(socket as any, { url: '/chat?jobId=job-1&localId=n0' } as any);

    gateway.handleDisconnect(socket as any);
    handlers.pmessage('chat:*', 'chat:job-1:n0', JSON.stringify({ type: 'chunk', delta: 'Hi' }));

    expect(socket.send).not.toHaveBeenCalled();
  });

  it('calls chatService.persistAssistantTurn when a done event is relayed', () => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const subscriber = { psubscribe: jest.fn(), on: jest.fn((event, cb) => (handlers[event] = cb)) };
    const persistAssistantTurn = jest.fn().mockResolvedValue(undefined);
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn } as any);
    const socket = makeSocket();
    gateway.handleConnection(socket as any, { url: '/chat?jobId=job-1&localId=n0' } as any);

    const donePayload = { type: 'done', message: 'hi', proposedTitle: null, proposedDescription: null, model: 'llama3.1' };
    handlers.pmessage('chat:*', 'chat:job-1:n0', JSON.stringify(donePayload));

    expect(persistAssistantTurn).toHaveBeenCalledWith('chat:job-1:n0', donePayload);
  });

  it('does not call persistAssistantTurn for a chunk or error event', () => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const subscriber = { psubscribe: jest.fn(), on: jest.fn((event, cb) => (handlers[event] = cb)) };
    const persistAssistantTurn = jest.fn();
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn } as any);
    const socket = makeSocket();
    gateway.handleConnection(socket as any, { url: '/chat?jobId=job-1&localId=n0' } as any);

    handlers.pmessage('chat:*', 'chat:job-1:n0', JSON.stringify({ type: 'chunk', delta: 'x' }));
    handlers.pmessage('chat:*', 'chat:job-1:n0', JSON.stringify({ type: 'error', reason: 'boom' }));

    expect(persistAssistantTurn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd orchestrator && npx jest test/chat.gateway.spec.ts -v`
Expected: FAIL — `Cannot find module '../src/modules/chat/chat.gateway'`.

- [ ] **Step 7: Implement `ChatGateway`**

Create `orchestrator/src/modules/chat/chat.gateway.ts`:

```ts
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import type Redis from 'ioredis';
import type { ChatService } from './chat.service';

const TURN_TIMEOUT_MS = 90_000;

interface ChatSocket {
  readyState: number;
  OPEN: number;
  send: (data: string) => void;
  close: (code: number, reason: string) => void;
  jobId?: string;
  localId?: string;
}

interface DoneEvent {
  type: 'done';
  message: string;
  proposedTitle: string | null;
  proposedDescription: string | null;
  model: string;
}

@Injectable()
@WebSocketGateway({ path: '/chat' })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger(ChatGateway.name);
  private readonly rooms = new Map<string, Set<ChatSocket>>();
  private readonly channelTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly subscriber: Redis,
    private readonly chatService: ChatService,
  ) {
    // Single shared subscriber for ALL open chats (pattern-subscribe), not
    // one dedicated Redis connection per open chat — deliberate deviation
    // from the SSE precedent (job-events.controller.ts), see
    // docs/superpowers/specs/2026-07-15-p3b-ai-assist-chat-design.md §6.
    this.subscriber.psubscribe('chat:*');
    this.subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
      this.relay(channel, message);
    });
  }

  handleConnection(client: ChatSocket, request: { url?: string }): void {
    const url = new URL(request.url ?? '', 'http://localhost');
    const jobId = url.searchParams.get('jobId');
    const localId = url.searchParams.get('localId');
    if (!jobId || !localId) {
      client.close(1008, 'jobId and localId are required');
      return;
    }
    client.jobId = jobId;
    client.localId = localId;
    const channel = `chat:${jobId}:${localId}`;
    if (!this.rooms.has(channel)) this.rooms.set(channel, new Set());
    this.rooms.get(channel)!.add(client);
  }

  handleDisconnect(client: ChatSocket): void {
    if (!client.jobId || !client.localId) return;
    const channel = `chat:${client.jobId}:${client.localId}`;
    const room = this.rooms.get(channel);
    room?.delete(client);
    if (room && room.size === 0) this.rooms.delete(channel);
  }

  private relay(channel: string, message: string): void {
    const sockets = this.rooms.get(channel);
    if (sockets) {
      for (const socket of sockets) {
        if (socket.readyState === socket.OPEN) socket.send(message);
      }
    }

    let parsed: { type: string };
    try {
      parsed = JSON.parse(message) as { type: string };
    } catch {
      return;
    }

    if (parsed.type === 'done' || parsed.type === 'error') {
      const timer = this.channelTimers.get(channel);
      if (timer) {
        clearTimeout(timer);
        this.channelTimers.delete(channel);
      }
    }
    if (parsed.type === 'done') {
      void this.chatService.persistAssistantTurn(channel, parsed as unknown as DoneEvent).catch((err) => {
        this.logger.error(`failed to persist assistant turn for ${channel}: ${err}`);
      });
    }
  }

  /** Called by ChatController.sendTurn right after kicking off the
   * ingestion call — force-emits an error and drops bookkeeping if no
   * done/error event ever arrives (ingestion process killed mid-turn). */
  startTurnTimeout(jobId: string, localId: string): void {
    const channel = `chat:${jobId}:${localId}`;
    const timer = setTimeout(() => {
      this.relay(channel, JSON.stringify({ type: 'error', reason: 'turn timed out' }));
    }, TURN_TIMEOUT_MS);
    this.channelTimers.set(channel, timer);
  }

  onModuleDestroy(): void {
    this.subscriber.disconnect();
  }
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd orchestrator && npx jest test/chat.gateway.spec.ts -v`
Expected: PASS (all 6).

- [ ] **Step 9: Write a test for `startTurnTimeout` behavior**

Add to `orchestrator/test/chat.gateway.spec.ts` (use fake timers):

```ts
  it('force-emits an error and clears the timer entry when a turn times out with no terminal event', () => {
    jest.useFakeTimers();
    const handlers: Record<string, (...args: any[]) => void> = {};
    const subscriber = { psubscribe: jest.fn(), on: jest.fn((event, cb) => (handlers[event] = cb)) };
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn: jest.fn() } as any);
    const socket = makeSocket();
    gateway.handleConnection(socket as any, { url: '/chat?jobId=job-1&localId=n0' } as any);

    gateway.startTurnTimeout('job-1', 'n0');
    jest.advanceTimersByTime(90_001);

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', reason: 'turn timed out' }));
    jest.useRealTimers();
  });

  it('does not fire the timeout after a done event already arrived', () => {
    jest.useFakeTimers();
    const handlers: Record<string, (...args: any[]) => void> = {};
    const subscriber = { psubscribe: jest.fn(), on: jest.fn((event, cb) => (handlers[event] = cb)) };
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn: jest.fn().mockResolvedValue(undefined) } as any);
    const socket = makeSocket();
    gateway.handleConnection(socket as any, { url: '/chat?jobId=job-1&localId=n0' } as any);

    gateway.startTurnTimeout('job-1', 'n0');
    handlers.pmessage('chat:*', 'chat:job-1:n0', JSON.stringify({ type: 'done', message: 'hi', proposedTitle: null, proposedDescription: null, model: 'llama3.1' }));
    socket.send.mockClear();
    jest.advanceTimersByTime(90_001);

    expect(socket.send).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `cd orchestrator && npx jest test/chat.gateway.spec.ts -v`
Expected: PASS (all 8).

- [ ] **Step 11: Implement `ChatController`**

Create `orchestrator/src/modules/chat/chat.controller.ts`:

```ts
import { BadRequestException, Controller, Get, Param, Post, Body } from '@nestjs/common';
import { z } from 'zod';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { OpenWebUiClient } from '../llm/openwebui.client';

const chatTurnRequestSchema = z.object({
  message: z.string().min(1),
  model: z.string().optional(),
});

@Controller()
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
    private readonly llmClient: OpenWebUiClient,
  ) {}

  @Get('chat/models')
  async models(): Promise<{ models: string[] }> {
    return { models: await this.llmClient.listModels() };
  }

  @Post('jobs/:jobId/diff/:localId/chat')
  async sendTurn(
    @Param('jobId') jobId: string,
    @Param('localId') localId: string,
    @Body() rawBody: unknown,
  ): Promise<{ status: string }> {
    const parseResult = chatTurnRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: message is required');
    }
    const body = parseResult.data;
    await this.chatService.sendTurn(jobId, localId, body.message, body.model);
    this.chatGateway.startTurnTimeout(jobId, localId);
    return { status: 'started' };
  }

  @Get('jobs/:jobId/diff/:localId/chat')
  async getHistory(
    @Param('jobId') jobId: string,
    @Param('localId') localId: string,
  ): Promise<{ messages: Awaited<ReturnType<ChatService['getHistory']>> }> {
    return { messages: await this.chatService.getHistory(jobId, localId) };
  }

  @Post('jobs/:jobId/diff/:localId/chat/stop')
  async stop(@Param('jobId') jobId: string, @Param('localId') localId: string): Promise<{ status: string }> {
    await this.chatService.stopTurn(jobId, localId);
    return { status: 'stopping' };
  }
}
```

- [ ] **Step 12: Implement `ChatModule`**

Create `orchestrator/src/modules/chat/chat.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { LlmModule } from '../llm/llm.module';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';

@Module({
  imports: [ConfigModule, LlmModule],
  controllers: [ChatController],
  providers: [
    { provide: PrismaClient, useValue: new PrismaClient() },
    {
      provide: 'CHAT_REDIS_CLIENT',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redis = new Redis(config.get<string>('REDIS_URL')!);
        // eslint-disable-next-line no-console -- no structured logger in this module yet
        redis.on('error', (err) => console.error('Chat Redis client error:', err));
        return redis;
      },
    },
    {
      provide: 'CHAT_REDIS_SUBSCRIBER',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redis = new Redis(config.get<string>('REDIS_URL')!);
        // eslint-disable-next-line no-console -- no structured logger in this module yet
        redis.on('error', (err) => console.error('Chat Redis subscriber error:', err));
        return redis;
      },
    },
    {
      provide: ChatService,
      inject: [PrismaClient, ConfigService, 'CHAT_REDIS_CLIENT'],
      useFactory: (prisma: PrismaClient, config: ConfigService, redis: Redis) =>
        new ChatService(prisma, config.get<string>('INGESTION_BASE_URL')!, redis),
    },
    {
      provide: ChatGateway,
      inject: ['CHAT_REDIS_SUBSCRIBER', ChatService],
      useFactory: (subscriber: Redis, chatService: ChatService) => new ChatGateway(subscriber, chatService),
    },
  ],
})
export class ChatModule {}
```

Note: `OpenWebUiClient` is not listed in `providers` here — it's already exported by `LlmModule` (imported above), so `ChatController`'s constructor injecting it resolves through that import alone. Listing it again as a bare provider would construct a second, separately-configured instance.

- [ ] **Step 13: Register `ChatModule` in `app.module.ts`**

Modify `orchestrator/src/app.module.ts`:

```ts
import { ChatModule } from './modules/chat/chat.module';
```

Add `ChatModule` to the `imports` array (after `JobsModule`).

- [ ] **Step 14: Run the full orchestrator test suite + typecheck**

Run: `cd orchestrator && npx tsc --noEmit && npx jest -v`
Expected: no type errors, all tests pass (including the pre-existing 179).

- [ ] **Step 15: Commit**

```bash
git add orchestrator/src/modules/chat orchestrator/src/app.module.ts orchestrator/test/chat.service.spec.ts orchestrator/test/chat.gateway.spec.ts
git commit -m "feat(chat): add ChatGateway, ChatService, ChatController, ChatModule"
```

---

### Task 9: Infra — `REDIS_URL` for ingestion

**Files:**
- Modify: `docker-compose.yml`

**Interfaces:**
- Produces: `ingestion`'s container has `REDIS_URL=redis://redis:6379` available to `Settings.redis_url` (Task 4).

- [ ] **Step 1: Add the env var**

In `docker-compose.yml`, under the `ingestion` service's `environment:` block, add:

```yaml
    environment:
      PORT: 8000
      REDIS_URL: redis://redis:6379
```

- [ ] **Step 2: Add `depends_on: redis` to `ingestion`**

The `ingestion` service currently has no `depends_on`; since it now needs Redis at request time (not boot time — `redis.asyncio.from_url` is lazy), a hard `depends_on` isn't strictly required for correctness, but add it anyway for predictable local startup ordering:

```yaml
    depends_on:
      - redis
```

- [ ] **Step 3: Verify compose config parses**

Run: `docker compose config --quiet`
Expected: no output, exit code 0 (valid YAML + schema).

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "chore(chat): give ingestion REDIS_URL for chat-turn event publishing"
```

---

### Task 10: Frontend — `api/chat.ts` + `useChatSocket` hook

**Files:**
- Create: `frontend/src/api/chat.ts`
- Create: `frontend/src/hooks/useChatSocket.ts`

**Interfaces:**
- Consumes: `httpClient` (`frontend/src/api/httpClient.ts`), `loadRuntimeConfig` (`frontend/src/api/config.ts`).
- Produces: `listModels()`, `getChatHistory(jobId, localId)`, `sendChatTurn(jobId, localId, message, model?)`, `stopChatTurn(jobId, localId)`, `useChatSocket(jobId, localId, onEvent)`.

- [ ] **Step 1: Implement `api/chat.ts`**

Create `frontend/src/api/chat.ts`:

```ts
import { httpClient } from './httpClient';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  proposedTitle: string | null;
  proposedDescription: string | null;
  model: string | null;
  createdAt: string;
}

export async function listModels(): Promise<string[]> {
  const response = await httpClient.get<{ models: string[] }>('/chat/models');
  return response.data.models;
}

export async function getChatHistory(jobId: string, localId: string): Promise<ChatMessage[]> {
  const response = await httpClient.get<{ messages: ChatMessage[] }>(`/jobs/${jobId}/diff/${localId}/chat`);
  return response.data.messages;
}

export async function sendChatTurn(jobId: string, localId: string, message: string, model?: string): Promise<void> {
  await httpClient.post(`/jobs/${jobId}/diff/${localId}/chat`, { message, model });
}

export async function stopChatTurn(jobId: string, localId: string): Promise<void> {
  await httpClient.post(`/jobs/${jobId}/diff/${localId}/chat/stop`);
}
```

- [ ] **Step 2: Implement `useChatSocket`**

Create `frontend/src/hooks/useChatSocket.ts`:

```ts
import { useEffect, useRef } from 'react';
import { loadRuntimeConfig } from '../api/config';

export interface StreamEvent {
  type: 'chunk' | 'done' | 'error';
  delta?: string;
  message?: string;
  proposedTitle?: string | null;
  proposedDescription?: string | null;
  model?: string;
  reason?: string;
}

export function toWsUrl(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/chat';
  url.search = '';
  return url.toString();
}

export function useChatSocket(jobId: string, localId: string, onEvent: (event: StreamEvent) => void): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | undefined;

    loadRuntimeConfig().then((config) => {
      if (cancelled) return;
      const wsUrl = `${toWsUrl(config.apiBaseUrl)}?jobId=${encodeURIComponent(jobId)}&localId=${encodeURIComponent(localId)}`;
      socket = new WebSocket(wsUrl);
      socket.onmessage = (event) => {
        const parsed = JSON.parse(event.data as string) as StreamEvent;
        onEventRef.current(parsed);
      };
    });

    return () => {
      cancelled = true;
      socket?.close();
    };
  }, [jobId, localId]);
}
```

`toWsUrl` is exported (not just used internally) specifically so it's independently unit-testable in Task 11's test file without needing a live WebSocket connection.

- [ ] **Step 3: Verify the frontend still typechecks**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/chat.ts frontend/src/hooks/useChatSocket.ts
git commit -m "feat(chat): add frontend chat API client + useChatSocket hook"
```

---

### Task 11: Frontend — `ChatPanel` component + wiring into `NodeDetailPanel`/`JobDetail`

**Files:**
- Create: `frontend/src/components/ChatPanel.tsx`
- Create: `frontend/src/components/ChatPanel.test.tsx`
- Modify: `frontend/src/components/NodeDetailPanel.tsx`
- Modify: `frontend/src/pages/JobDetail.tsx`

**Interfaces:**
- Consumes: `getChatHistory`, `listModels`, `sendChatTurn`, `stopChatTurn` (Task 10), `useChatSocket` (Task 10), `useToast` (existing), `themeTokens` (existing), `onAcceptProposal: (patch: { title?: string; description?: string }) => void` (bridges to existing `NodeDetailPanel`'s `onSave`).
- Produces: `<ChatPanel jobId localId disabled onAcceptProposal />`.

- [ ] **Step 1: Write the failing test for `toWsUrl`**

Create `frontend/src/components/ChatPanel.test.tsx` (starts with the pure-function test, then component tests below use mocked API modules per the established `vi.mock('../api/...')` convention):

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toWsUrl } from '../hooks/useChatSocket';
import { ChatPanel } from './ChatPanel';
import { ToastProvider } from './ToastProvider';
import * as chatApi from '../api/chat';

vi.mock('../api/chat');
vi.mock('../hooks/useChatSocket', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useChatSocket')>('../hooks/useChatSocket');
  return { ...actual, useChatSocket: vi.fn() };
});

import { useChatSocket } from '../hooks/useChatSocket';

describe('toWsUrl', () => {
  it('swaps http for ws and sets the /chat path', () => {
    expect(toWsUrl('http://localhost:3001')).toBe('ws://localhost:3001/chat');
  });

  it('swaps https for wss', () => {
    expect(toWsUrl('https://api.example.com')).toBe('wss://api.example.com/chat');
  });
});

describe('ChatPanel', () => {
  beforeEach(() => {
    vi.mocked(chatApi.getChatHistory).mockResolvedValue([]);
    vi.mocked(chatApi.listModels).mockResolvedValue(['llama3.1', 'qwen2.5:14b']);
    vi.mocked(chatApi.sendChatTurn).mockResolvedValue(undefined);
    vi.mocked(chatApi.stopChatTurn).mockResolvedValue(undefined);
    vi.mocked(useChatSocket).mockImplementation(() => undefined);
  });

  it('renders a disabled message when disabled=true, without calling any chat API', async () => {
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled onAcceptProposal={vi.fn()} />
      </ToastProvider>,
    );
    expect(screen.getByText(/chat is unavailable/i)).toBeInTheDocument();
    expect(chatApi.getChatHistory).not.toHaveBeenCalled();
  });

  it('loads history and models on mount', async () => {
    vi.mocked(chatApi.getChatHistory).mockResolvedValue([
      { id: '1', role: 'user', content: 'hi', proposedTitle: null, proposedDescription: null, model: null, createdAt: '2026-01-01' },
    ]);
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled={false} onAcceptProposal={vi.fn()} />
      </ToastProvider>,
    );
    await waitFor(() => expect(screen.getByText('hi')).toBeInTheDocument());
    expect(screen.getByText('llama3.1')).toBeInTheDocument();
  });

  it('sends a message and appends it to history optimistically', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled={false} onAcceptProposal={vi.fn()} />
      </ToastProvider>,
    );
    const input = await screen.findByPlaceholderText(/ask the assistant/i);
    await user.type(input, 'make this testable');
    await user.click(screen.getByRole('button', { name: /send/i }));

    expect(chatApi.sendChatTurn).toHaveBeenCalledWith('job-1', 'n0', 'make this testable', undefined);
    await waitFor(() => expect(screen.getByText('make this testable')).toBeInTheDocument());
  });

  it('renders a proposal with Accept/Reject when the WS done event includes one, and Accept calls onAcceptProposal', async () => {
    let capturedOnEvent: ((event: import('../hooks/useChatSocket').StreamEvent) => void) | undefined;
    vi.mocked(useChatSocket).mockImplementation((_jobId, _localId, onEvent) => {
      capturedOnEvent = onEvent;
    });
    const onAcceptProposal = vi.fn();
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled={false} onAcceptProposal={onAcceptProposal} />
      </ToastProvider>,
    );
    await screen.findByPlaceholderText(/ask the assistant/i);

    capturedOnEvent?.({
      type: 'done',
      message: 'Here you go',
      proposedTitle: 'New title',
      proposedDescription: null,
      model: 'llama3.1',
    });

    const user = userEvent.setup();
    await screen.findByText('New title');
    await user.click(screen.getByRole('button', { name: /accept/i }));

    expect(onAcceptProposal).toHaveBeenCalledWith({ title: 'New title', description: undefined });
  });

  it('shows an error toast and stops the typing indicator on a WS error event', async () => {
    let capturedOnEvent: ((event: import('../hooks/useChatSocket').StreamEvent) => void) | undefined;
    vi.mocked(useChatSocket).mockImplementation((_jobId, _localId, onEvent) => {
      capturedOnEvent = onEvent;
    });
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled={false} onAcceptProposal={vi.fn()} />
      </ToastProvider>,
    );
    await screen.findByPlaceholderText(/ask the assistant/i);

    capturedOnEvent?.({ type: 'error', reason: 'LLM unreachable' });

    await waitFor(() => expect(screen.getByText(/reply failed/i)).toBeInTheDocument());
  });

  it('calls stopChatTurn when Stop generating is clicked while streaming', async () => {
    let capturedOnEvent: ((event: import('../hooks/useChatSocket').StreamEvent) => void) | undefined;
    vi.mocked(useChatSocket).mockImplementation((_jobId, _localId, onEvent) => {
      capturedOnEvent = onEvent;
    });
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled={false} onAcceptProposal={vi.fn()} />
      </ToastProvider>,
    );
    const input = await screen.findByPlaceholderText(/ask the assistant/i);
    await user.type(input, 'hi{Enter}');
    capturedOnEvent?.({ type: 'chunk', delta: 'thinking' });

    await user.click(screen.getByRole('button', { name: /stop generating/i }));
    expect(chatApi.stopChatTurn).toHaveBeenCalledWith('job-1', 'n0');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/ChatPanel.test.tsx`
Expected: FAIL — `Cannot find module './ChatPanel'`.

- [ ] **Step 3: Implement `ChatPanel`**

Create `frontend/src/components/ChatPanel.tsx`:

```tsx
import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import { getChatHistory, listModels, sendChatTurn, stopChatTurn, type ChatMessage } from '../api/chat';
import { useChatSocket, type StreamEvent } from '../hooks/useChatSocket';
import { useToast } from './ToastProvider';
import { themeTokens } from '../theme/tokens';

interface Proposal {
  proposedTitle: string | null;
  proposedDescription: string | null;
}

const HISTORY_DISPLAY_LIMIT = 50;

export function ChatPanel({
  jobId,
  localId,
  disabled,
  onAcceptProposal,
}: {
  jobId: string;
  localId: string;
  disabled: boolean;
  onAcceptProposal: (patch: { title?: string; description?: string }) => void;
}): React.ReactElement {
  const { showToast } = useToast();
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [streaming, setStreaming] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);

  useEffect(() => {
    if (disabled) return;
    getChatHistory(jobId, localId).then(setHistory);
    listModels()
      .then(setModels)
      .catch(() => setModels([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, localId, disabled]);

  useChatSocket(jobId, localId, (event: StreamEvent) => {
    if (disabled) return;
    if (event.type === 'chunk') {
      setStreaming((prev) => prev + (event.delta ?? ''));
    } else if (event.type === 'done') {
      setIsStreaming(false);
      setStreaming('');
      setHistory((prev) => [
        ...prev,
        {
          id: `local-${prev.length}`,
          role: 'assistant',
          content: event.message ?? '',
          proposedTitle: event.proposedTitle ?? null,
          proposedDescription: event.proposedDescription ?? null,
          model: event.model ?? null,
          createdAt: new Date().toISOString(),
        },
      ]);
      if (event.proposedTitle || event.proposedDescription) {
        setProposal({ proposedTitle: event.proposedTitle ?? null, proposedDescription: event.proposedDescription ?? null });
      }
    } else if (event.type === 'error') {
      setIsStreaming(false);
      setStreaming('');
      showToast(`Chat reply failed: ${event.reason ?? 'unknown error'}`, 'error');
    }
  });

  async function send(): Promise<void> {
    if (!draft.trim() || isStreaming) return;
    const text = draft;
    setDraft('');
    setHistory((prev) => [
      ...prev,
      {
        id: `local-user-${prev.length}`,
        role: 'user',
        content: text,
        proposedTitle: null,
        proposedDescription: null,
        model: model ?? null,
        createdAt: new Date().toISOString(),
      },
    ]);
    setIsStreaming(true);
    setProposal(null);
    try {
      await sendChatTurn(jobId, localId, text, model);
    } catch {
      setIsStreaming(false);
      showToast('Failed to send chat message.', 'error');
    }
  }

  async function stop(): Promise<void> {
    await stopChatTurn(jobId, localId);
  }

  function acceptProposal(): void {
    if (!proposal) return;
    onAcceptProposal({
      title: proposal.proposedTitle ?? undefined,
      description: proposal.proposedDescription ?? undefined,
    });
    setProposal(null);
  }

  if (disabled) {
    return (
      <Box p={2}>
        <Typography color="text.secondary">Chat is unavailable for this item.</Typography>
      </Box>
    );
  }

  const visibleHistory = history.slice(-HISTORY_DISPLAY_LIMIT);

  return (
    <Box p={2} sx={{ borderTop: `1px solid ${themeTokens.color.border}` }}>
      <Typography variant="overline">Chat</Typography>
      <Box sx={{ maxHeight: 240, overflowY: 'auto', mb: 1 }}>
        {visibleHistory.map((m) => (
          <Box key={m.id} sx={{ mb: 1 }}>
            <Typography variant="caption" color="text.secondary">
              {m.role === 'user' ? 'You' : m.model ? `Assistant (${m.model})` : 'Assistant'}
            </Typography>
            <Typography variant="body2">{m.content}</Typography>
          </Box>
        ))}
        {isStreaming && (
          <Box sx={{ mb: 1 }}>
            <Typography variant="caption" sx={{ color: themeTokens.color.liveAccent }}>
              Assistant (typing…)
            </Typography>
            <Typography variant="body2">{streaming}</Typography>
          </Box>
        )}
      </Box>
      {proposal && (
        <Box sx={{ border: `1px solid ${themeTokens.color.border}`, borderRadius: `${themeTokens.radius.sm}px`, p: 1, mb: 1 }}>
          <Typography variant="caption">Proposed change</Typography>
          {proposal.proposedTitle && (
            <Typography variant="body2">
              <strong>Title:</strong> {proposal.proposedTitle}
            </Typography>
          )}
          {proposal.proposedDescription && (
            <Typography variant="body2">
              <strong>Description:</strong> {proposal.proposedDescription}
            </Typography>
          )}
          <Button size="small" variant="contained" onClick={acceptProposal}>
            Accept
          </Button>
          <Button size="small" onClick={() => setProposal(null)}>
            Reject
          </Button>
        </Box>
      )}
      <TextField
        select
        label="Model"
        value={model ?? ''}
        onChange={(e) => setModel(e.target.value || undefined)}
        size="small"
        sx={{ minWidth: 160, mr: 1 }}
      >
        <MenuItem value="">Default</MenuItem>
        {models.map((m) => (
          <MenuItem key={m} value={m}>
            {m}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        size="small"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Ask the assistant to refine this item…"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <Button variant="contained" onClick={send} disabled={isStreaming}>
        Send
      </Button>
      {isStreaming && <Button onClick={stop}>Stop generating</Button>}
    </Box>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/ChatPanel.test.tsx`
Expected: PASS (all).

- [ ] **Step 5: Wire `ChatPanel` into `NodeDetailPanel`**

Modify `frontend/src/components/NodeDetailPanel.tsx` — add a `jobId` prop and render `ChatPanel` beneath the existing content in the non-editing branch (chat needs a stable, saved item to discuss; hide it while the user is mid-edit to avoid discussing an unsaved draft):

```tsx
import { ChatPanel } from './ChatPanel';
```

```tsx
export function NodeDetailPanel({
  jobId,
  entry,
  onSave,
}: {
  jobId: string;
  entry: DryRunDiffEntry | null;
  onSave?: (localId: string, patch: { title: string; description: string }) => void;
}): React.ReactElement {
```

At the end of the non-editing return block (after the existing `{canEdit && <Button onClick={startEditing}>Edit</Button>}` line), add:

```tsx
      {entry && (
        <ChatPanel
          jobId={jobId}
          localId={entry.localId}
          disabled={!canEdit}
          onAcceptProposal={(patch) =>
            onSave?.(entry.localId, {
              title: patch.title ?? entry.title,
              description: patch.description ?? entry.description,
            })
          }
        />
      )}
```

- [ ] **Step 6: Thread `jobId` from `JobDetail.tsx`**

Modify `frontend/src/pages/JobDetail.tsx` — the `<NodeDetailPanel entry={selectedEntry} onSave={handleSaveEdit} />` call becomes:

```tsx
            <NodeDetailPanel jobId={id!} entry={selectedEntry} onSave={handleSaveEdit} />
```

- [ ] **Step 7: Run the full frontend test suite + typecheck**

Run: `cd frontend && npx tsc -b --noEmit && npx vitest run`
Expected: no type errors, all tests pass (pre-existing 79 + the new `ChatPanel.test.tsx` suite).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/ChatPanel.tsx frontend/src/components/ChatPanel.test.tsx frontend/src/components/NodeDetailPanel.tsx frontend/src/pages/JobDetail.tsx
git commit -m "feat(chat): add ChatPanel, wire into NodeDetailPanel/JobDetail"
```

---

### Task 12: End-to-end manual verification

**Files:** none (verification only, no code changes).

- [ ] **Step 1: Rebuild the docker-compose stack**

Run: `docker compose up --build -d`
Expected: all services (including `ingestion` and `orchestrator`) start healthy; `docker compose logs ingestion` shows no `redis` connection errors at boot (connection is lazy, so this confirms nothing crashes eagerly).

- [ ] **Step 2: Open a job in `diff_ready` status, select a `create`-action entry**

In the browser, navigate to an existing `diff_ready` job (or create one via BASELINE mode for a fast round trip), select a node whose `action` is `create` and `excluded` is falsy in `NodeDetailPanel`.

Expected: the new Chat section renders below the node details, with a model dropdown populated from `GET /chat/models` (confirm via browser devtools Network tab that the call succeeds and returns real Ollama/Open WebUI model ids).

- [ ] **Step 3: Send a message and observe streaming**

Type "make this more testable" and send.

Expected: a typing indicator appears, tokens accumulate live in the UI (confirm via Network tab's WS frames tab that `ws://localhost:3001/chat?jobId=...&localId=...` receives a sequence of `{"type":"chunk","delta":"..."}` frames followed by one `{"type":"done",...}` frame). If a structured proposal was requested, an Accept/Reject block appears.

- [ ] **Step 4: Accept a proposal and confirm it lands via the existing edit path**

Click Accept.

Expected: a `PATCH /jobs/:id/diff/:localId` request fires (same endpoint P3a's manual Edit button uses), the node's title/description updates in `DiffTree`/`NodeDetailPanel`.

- [ ] **Step 5: Reload the page, confirm chat history persists**

Reload the browser tab, reselect the same node.

Expected: `GET /jobs/:id/diff/:localId/chat` returns the prior turns, rendered in the same order.

- [ ] **Step 6: Verify gating — a `reuse`/`dedup_skip` or excluded entry shows the disabled state**

Select a node with `action: 'reuse'` or `action: 'dedup_skip'`, or toggle a `create` node's exclude checkbox.

Expected: Chat section shows "Chat is unavailable for this item." and issues no `GET /jobs/:id/diff/:localId/chat` or `GET /chat/models` calls (per `ChatPanel`'s `disabled` early return).

- [ ] **Step 7: Verify stop-generating**

Send a message, click "Stop generating" mid-stream.

Expected: `POST /jobs/:id/diff/:localId/chat/stop` fires, the WS stream receives `{"type":"error","reason":"stopped by user"}` shortly after (within one token's latency — depends on how quickly `run_chat_turn`'s next `is_aborted` check runs), the typing indicator clears.

- [ ] **Step 8: Update the handoff doc**

Add a "§4e — P3b — Per-item AI-assist chat" section to `docs/handoff-frontend-rebuild.md` following the pattern of §4d, documenting: the new `ChatMessage` table, the `POST /llm/chat/stream` proxy addition, the WS relay architecture, the sentinel-based proposal-splitting mechanism, and the new API routes (`GET /chat/models`, `POST/GET /jobs/:id/diff/:localId/chat`, `POST /jobs/:id/diff/:localId/chat/stop`). Update the roadmap's "What's next" section (§8) to mark P3b done and P3c as next.

- [ ] **Step 9: Commit the handoff update**

```bash
git add docs/handoff-frontend-rebuild.md
git commit -m "docs: document P3b AI-assist chat in handoff"
```

---

## Self-Review Notes

- **Spec coverage:** All sections of `docs/superpowers/specs/2026-07-15-p3b-ai-assist-chat-design.md` are covered — §3 architecture (Tasks 1-11), §4 data model (Task 1), §4a model selection (Tasks 2-3, 10-11), §5 error handling (abort/timeout/disconnect paths in Tasks 6-8), §6 resource management (single shared subscriber in Task 8, disconnect cleanup, capped history in Tasks 1/8/11), §7 token optimization (capped history in Task 6, minimal item context in Task 6, streaming stop-generating in Tasks 6/8/11), §8 testing (a test step in every task).
- **New architecture beyond the spec's original sketch:** the spec didn't work out exactly how ingestion gets token-level streaming while being forbidden from calling Open WebUI directly. This plan resolves it with a new `POST /llm/chat/stream` proxy (Task 3) that ingestion's `ChatLlmClient` consumes (Task 5) — this preserves both locked constraints (ingestion never calls Open WebUI directly; ingestion owns the chat LLM call + Redis publish, per the approved brainstorming decision) without contradicting either.
- **Sentinel-based proposal splitting** is a new mechanism not explicitly specified in the design doc (which only said the reply "includes conversational text AND a structured proposal") — implemented as the simplest robust way to carry both a live-streamable message and a structured proposal over one token stream. Fully covered by unit tests in Tasks 5-6 with no real LLM required.
- **Type consistency check:** `ChatMessageDto`/`ChatMessage` (frontend) fields match across Task 1 (Prisma), Task 8 (`ChatService.getHistory`/`persistAssistantTurn`), Task 10 (`api/chat.ts`), Task 11 (`ChatPanel`) — `role`, `content`, `proposedTitle`, `proposedDescription`, `model`, `createdAt` used identically everywhere. `StreamEvent`'s `type: 'chunk' | 'done' | 'error'` matches the Redis payload shapes published in Task 4's `RedisChatPublisher` and consumed in Task 8's `ChatGateway`/Task 11's `ChatPanel`.
- **No placeholders:** every step has complete, runnable code — no "add appropriate error handling" or "similar to Task N" shortcuts.
