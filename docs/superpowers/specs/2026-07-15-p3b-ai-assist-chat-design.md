# P3b — Per-Item AI-Assist Chat, Design

**Date:** 2026-07-15
**Status:** Approved, ready for planning
**Depends on:** P3a (editable dry-run diff, merged `dcae359`), P2b (RAG retrieval, `kb_context`), P2c (quality scoring)
**Feeds:** P2d (learning-loop write-back, deferred until real accept/reject edit-diffs exist)

## 1. Purpose

Second of Phase 3's three sub-specs (editable diff / AI assist / source provenance — see
`docs/req2ado-roadmap.md`). Lets a user refine a single dry-run diff entry through free-form
chat with an LLM before confirming a job, instead of hand-editing title/description via P3a's
`NodeDetailPanel` Edit form alone. Chat proposes a rewrite; the user accepts or rejects it.
Accepted rewrites feed the same edit path P3a already built — this phase adds a smarter way to
produce the patch body, not a new mutation surface.

## 2. Scope

- One conversation per diff entry (`localId`), not per job. No cross-item context sharing.
- Only `action: 'create'` entries are chattable — same restriction as P3a's `editDiffEntry`,
  since Accept calls it directly. `reuse`/`dedup_skip` and `excluded: true` entries: chat
  UI disabled.
- Job must be `status === 'diff_ready'` for a chat turn to be accepted (mirrors P3a's 409 gate).
- Out of scope: multi-item chat, chat-driven exclude/add operations, source provenance display
  (P3c), learning-loop write-back (P2d, deferred).

## 3. Architecture

Three touched services:

- **ingestion** (`app/chat/`, new): `chat_client.py` adds `OrchestratorLlmClient.stream_chat_reply()`.
  Reuses P2b's `retrieve_context()` for KB grounding. Takes `(item title, description, childType,
  qualityIssues, capped conversation history, kb_context)` → async-generates token chunks, then a
  final structured payload `{message, proposedTitle?, proposedDescription?}`. New route:
  `POST /chat/{jobId}/{localId}/turn` — kicks off the stream, publishes each chunk to Redis channel
  `chat:{jobId}:{localId}` as generated, publishes one final `done` event with the structured
  payload (or an `error` event on failure).
- **orchestrator**: new `ChatGateway` (NestJS `@WebSocketGateway`). Client connects, joins a room
  keyed by `jobId:localId`, gateway subscribes to that Redis channel via a single shared `ioredis`
  subscriber (pattern-subscribe `chat:*`, dispatch by channel name — not one raw connection per
  chat), relays chunks to the socket. On `done`: persists a new `ChatMessage` Prisma row (user turn
  + assistant turn + proposal), emits a `complete` WS event with the row id. On `error`: relays as
  WS `error`, persists nothing. New `ChatController`/`ChatService`:
  `POST /jobs/:id/diff/:localId/chat` (send user message, triggers the ingestion call),
  `GET /jobs/:id/diff/:localId/chat` (load history on reopen, capped/paginated).
- **frontend**: chat panel in `NodeDetailPanel` (new tab/section next to Edit), `useChatSocket`
  hook (connect, append streaming tokens, "stop generating" control). Structured proposal renders
  as an inline title/description diff with Accept/Reject — Accept calls the **existing**
  `PATCH /jobs/:id/diff/:localId` (P3a's `editDiffEntry`); Reject discards, no backend call.

## 4. Data model

New Prisma model, orchestrator:

```
ChatMessage {
  id, jobId, localId, role ('user'|'assistant'), content,
  proposedTitle: string?, proposedDescription: string?,
  model: string?,   // assistant turns only — which model produced this reply
  createdAt
}
```

Indexed on `[jobId, localId]`. No `accepted` flag — the row is a log, not a state machine;
acceptance is just a normal `editDiffEntry` call. Reusing that endpoint also means Accept
inherits P3a's final-review fix: only fields actually provided in the proposal are sent, so a
proposal with only `proposedDescription` set can't clobber `title` via undefined-spread.

## 4a. Model selection

Switchable per turn — a model dropdown next to the send box, changeable before every message.
No conversation-wide lock; each assistant turn records which model produced it (`ChatMessage.model`)
so history and any future P2d learning-signal analysis can see the model mix.

- **Model catalog is already reachable without a new architecture boundary.** `OpenWebUiClient`
  (`orchestrator/src/modules/llm/openwebui.client.ts`) already talks to Open WebUI via the OpenAI
  SDK (`this.openai`, pointed at `LLM_BASE_URL`) — Open WebUI exposes an OpenAI-compatible
  `/v1/models` route, so `this.openai.models.list()` gives a real catalog for free. This still
  respects the locked "never call Open WebUI/Ollama directly from ingestion or frontend, only via
  the orchestrator proxy" rule (`orchestrator_llm_client.py`'s docstring) — the catalog call is
  orchestrator-side, same as `chat`/`embed` today.
- **New endpoint:** `GET /llm/models` on `LlmController` → `{ models: string[] }` (or richer
  `{id, ...}` objects if Open WebUI returns useful metadata — id is the minimum needed). No
  filtering of embedding-only models mixed into the list — returned as-is; the dev environment's
  model set is small and known, filtering by name heuristic risks hiding a valid chat model.
- **`chat` already accepts `opts?.model`** (`OpenWebUiClient.chat`, line 28) — falls back to
  `LLM_CHAT_MODEL` when omitted. `LlmController.chat` and `llmChatRequestSchema` currently don't
  thread a `model` field through from the request body — this phase adds it (optional string,
  passed through to `llmClient.chat(messages, { model, temperature })`).
- **ingestion → orchestrator:** `chat_client.py`'s `POST /chat/{jobId}/{localId}/turn` payload
  gains an optional `model` field, forwarded to ingestion's own call to orchestrator's
  `POST /llm/chat` (mirrors the existing `/llm/chat` proxy call already used by
  `orchestrator_llm_client.py`, just with `model` added to the JSON body).
- **frontend:** `ChatPanel` fetches `GET /llm/models` once when opened (not per turn), renders a
  dropdown defaulting to the server's configured `LLM_CHAT_MODEL` (first list entry, or a
  distinguished default if Open WebUI reports one) — selection sent with each `POST .../chat` call.
- **Unavailable model at send time** (removed from Ollama between list-fetch and send): same
  failure path as any other LLM error (§5) — ingestion's call fails, `error` event, no partial
  persistence, frontend shows "reply failed, try again" (the stale model choice remains selected;
  user can pick another from a re-fetched list).

## 5. Error handling & edge cases

- **LLM/stream failure mid-turn:** ingestion publishes `error` instead of `done`; orchestrator
  relays as WS `error`, persists nothing; frontend shows "reply failed, try again." Matches
  P2b's fail-safe philosophy (KB/LLM failure never corrupts state, just degrades gracefully).
- **WS disconnect mid-stream:** ingestion keeps generating regardless of subscriber presence;
  `done` still fires, `ChatMessage` still persists. Reopening the item loads history via
  `GET .../chat` — no wasted LLM call, just a missed live animation.
- **Two tabs on the same item:** both join the same room, both see the stream. Accept-time
  conflicts resolve the same way P3a already does (last-write-wins at the DB layer).
- **Two tabs / concurrency cap:** UI limits one active streaming turn per browser tab at a time
  (disable "send" on other items' chats while one is streaming) — prevents unbounded concurrent
  WS + Redis-subscription + in-flight-LLM-call fan-out from one session.
- **No terminal event ever arrives** (ingestion process killed mid-generation): orchestrator
  enforces a hard per-turn timeout (~90s), force-emits `error` to the client, and drops the room
  subscription regardless — prevents an indefinitely-open Redis subscription from a stuck call.
- **Reconnect:** frontend WS hook retries the connection once on drop; no server-side turn retry.

## 6. Resource management

- `ChatGateway.handleDisconnect` always unsubscribes the room's Redis channel and removes the
  socket, including on ungraceful disconnects (tab crash, network drop) — not just clean close.
- Single shared `ioredis` subscriber connection with pattern-subscribe, not one raw connection
  per open chat — avoids hitting Redis's subscriber-connection ceiling under concurrent chats.
- Chat history load is capped/paginated server-side (e.g. last 50 turns) — `ChatPanel` renders
  a virtualized/truncated list for long conversations, consistent with `DiffTree`'s existing
  `react-window` approach.
- Ingestion's streaming generator closes its underlying LLM-client stream on early disconnect —
  orchestrator signals ingestion to abort (cancel call, or aborts the streaming HTTP request to
  ingestion) rather than walking away from the socket while ingestion keeps burning tokens.
- Concurrency cap: one active chat stream per browser tab (see §5).

## 7. Token usage / cost optimization

- Reuse the job's existing P2b `kb_context` (cached per job) instead of re-embedding/re-querying
  Chroma on every chat turn — retrieval is the expensive part, the item text is small.
- Conversation history sent to the LLM per turn is capped (last 6-10 turns), not the full
  persisted log — DB keeps everything for scroll-back and future P2d signal, but prompt input
  doesn't grow unbounded with conversation length.
- Item context sent to the LLM is minimal: target item's `title`/`description`/`childType`/
  `qualityIssues` + immediate parent's title. Never the full `dryRunDiff` tree.
- System prompt (response-format contract, EARS/INCOSE framing reused from P2c) is a module-level
  constant in `chat_client.py`, built once, not re-templated per call.
- Structured-output contract keeps replies short: `{message, proposedTitle?, proposedDescription?}`,
  no restating of full item or KB context back to the user.
- Model instructed to leave `proposedTitle`/`proposedDescription` empty when the user's message is
  conversational/clarifying rather than a change request — avoids forced regeneration when none
  was asked for. (Prompt-level guarantee, not structurally enforced.)
- Streaming + a "stop generating" control lets the user cut a bad reply short, aborting the LLM
  call server-side rather than paying for a full wasted completion.

## 8. Testing

- `ingestion/tests/chat/`: streaming generator yields chunks + final structured payload (mock LLM
  client); KB-context reuse asserted (not re-queried per turn when a cached context is passed);
  retrieval failure falls back to ungrounded reply, not an error; conversational (non-change)
  message yields empty proposal fields.
- `orchestrator/test/chat.gateway.spec.ts` + `chat.service.spec.ts`: Redis-relay-to-WS plumbing
  (mock ioredis pub/sub, same harness style as existing SSE tests); persistence on `done`,
  no-persistence on `error`; disconnect triggers unsubscribe; per-turn timeout force-emits error
  and drops subscription; gating (create-only / diff_ready / excluded) mirrors
  `jobs.service.spec.ts`'s P3a gating tests.
- `orchestrator/test/llm.controller.spec.ts`: `GET /llm/models` returns the catalog from
  `openai.models.list()` unfiltered; `POST /llm/chat` threads an optional `model` field through
  to `llmClient.chat()`, falling back to `LLM_CHAT_MODEL` when omitted (existing behavior,
  regression-guarded).
- `frontend/src/components/ChatPanel.test.tsx`: streaming token append, proposal render + Accept
  wiring to existing `editDiffEntry` API call, Reject discards without a network call, disabled
  state for reuse/dedup_skip/excluded entries, "stop generating" aborts the stream, history
  pagination/truncation for long conversations, model dropdown populated from `GET /llm/models`
  and selection sent per turn.

## 9. Not yet done

- Source provenance display (P3c) — separate sub-spec.
- Learning-loop write-back (P2d) — deferred until this phase produces real accept/reject
  edit-diffs to learn from.
- Chat-driven exclude/add operations — out of scope, chat only proposes title/description edits.
