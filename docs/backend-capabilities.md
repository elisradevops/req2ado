# req2ado — Backend Capabilities & Gaps (confirmed by investigation)

**Purpose of this doc:** the confirmed state of the backend, with file:line refs, as found by 5
research agents during Phase 1 planning. Read this before touching backend code for any phase —
it prevents re-running the same exploration. If a referenced file has since changed, treat the
finding as historical and re-verify the specific line, not the whole doc.

## Job routes (orchestrator)

- `POST /jobs` — multipart (`file`, `areaPath` required, `customerId?`, `mode?` default
  `'baseline'`). No formal DTO — raw `@Body('...')` extraction.
  `orchestrator/src/modules/pipeline/jobs.controller.ts:42-81`.
  - File extension allow-list `.txt .md .docx .pdf .xlsx` (`:23, 62-65`).
  - `mode` enum strictly `'baseline' | 'survey'`, rejects anything else with 400 (`:69-71`).
  - Computes SHA-256 `sourceHash` of file bytes (`:72`).
- `GET /jobs/:id` → `{id, status, dryRunDiff}` (`:83`). **No `GET /jobs` list route exists** —
  confirmed. Job history is fully persisted in Postgres (`schema.prisma`, `model Job`) but only
  queryable by exact id (`jobs.service.ts:83, 92`).
- `POST /jobs/:id/confirm` (`:92-100`) — reads only the path `id` + headers `x-ado-org-url`,
  `x-ado-pat`. **No `@Body` at all.**
- `GET /jobs/:id/audit` (`:102`) → array of `{id, message, createdAt}` — exists but never rendered
  by the current frontend.
- `Job.status` is a plain **String** column, not a real enum (`schema.prisma`) — values used in
  code: `pending | running | diff_ready | succeeded | failed`. Re-verify before building against it.

## Editable dry-run diff — NOT possible today

Critical finding, relevant to Phase 3:

- Diff is stored as one opaque `Job.dryRunDiff Json?` blob (`schema.prisma:18`), written once by
  the pipeline worker (`pipeline.worker.ts:71`).
- `POST /jobs/:id/confirm` has no `@Body` — it cannot receive edits (`jobs.controller.ts:92-100`).
- `JobsService.confirm` re-reads the job from DB and writes **exactly** what's stored — `System.Title`
  /`System.Description` come verbatim from the stored entry (`jobs.service.ts:92, 104, 137-155`).
- **Conclusion:** editing/deleting/adding a node before confirm requires a new diff-update endpoint
  (or a body-accepting confirm) plus re-validation of edited entries. Entirely net-new — this is
  what Phase 3's "editable dry-run diff" must build.

## `DryRunDiffEntry` shape

`{ localId, parentLocalId, type, title, description, action: 'create'|'reuse'|'dedup_skip',
existingAdoId, similarity, customerId, sourceHash }` — built in
`orchestrator/src/modules/pipeline/dry-run.service.ts:4-37`. `parentLocalId` is present but unused
for display in the current frontend (flat list, no tree).

## Ingestion pre-parse (`ingestion/app/main.py`, Python/FastAPI)

- `POST /ingest` (`:49-63`) parses a document (via `dispatch_by_extension`) to a `CanonicalDoc`
  **without running the LLM leveling/survey pipeline**. Not currently exposed by the orchestrator —
  `IngestionHttpClient` only wraps `level`/`checkDuplicate`/`upsertDedupEntry`. This is the hook for
  Phase 1's `/jobs/preview` (block/section count before committing to a full run).
- `POST /level` (`:66-79`) is the LLM stage proper (`mode="baseline"|"survey"`), separate from
  `/ingest`.

## ADO write capability (mcp-ado-server)

- **Fields ever written** (`orchestrator/src/modules/pipeline/jobs.service.ts:137-154`, the only
  place work items are built): `System.Title`, `System.Description`, `System.State` (hardcoded
  `'Proposed'`, `:140`), `System.AreaPath` (`:141`), and a dynamically-resolved Customer ID field
  if present on the type. **Nothing else.**
- `createWorkItem` backend contract accepts an arbitrary `Record<string,string>` fields map
  (`mcp-ado-server/src/backends/types.ts:15-18`) — the primitive supports arbitrary fields, it's
  just unused beyond the five above.
- `setFields(id, fields)` (`types.ts:39`, `realAdo.ts:191-199`) PATCHes an arbitrary field map onto
  an existing item — exists, unused for anything but the Customer ID resolution path. This is the
  primitive Phase 1's configurable State/Iteration and tags-writing should use.
- `discoverFields(workItemType)` (`types.ts:37`, `realAdo.ts:201-208`) returns field reference
  names for a type — used only to resolve the Customer ID ref name today.
- **Only parent-child hierarchy links exist.** `linkParentChild` is hardcoded to
  `System.LinkTypes.Hierarchy-Reverse` (`realAdo.ts:170`, write; `:68`, read). Zero occurrences of
  `CoveredBy`/`Covers`/`Affects`/other `System.LinkTypes.*` anywhere in source — trace/coverage
  relations are entirely absent, relevant to Phase 4.
- **No area-path read capability anywhere** — no `classificationnodes` call, no project-list call.
  Area path is always caller-supplied, never read/validated against ADO. This is the gap Phase 1's
  `AreaPathPicker` fills by adding a new `readAreaPaths` MCP tool.
- **Type→WIT mapping is hardcoded**, not configurable: depth→type rules in
  `ingestion/app/leveling/profiles.py:10-23` (`tv_style`: depth≤2→Epic, 3→Feature, ≥4→Requirement;
  `icd_style`: depth≤1→Feature, ≥2→Requirement), auto-detected per branch
  (`ingestion/app/leveling/autodetect.py:8-17`).
- **Diff-vs-live-ADO-tree is not implemented.** The existing dry-run diff compares only against a
  local idempotency map (`dry-run.service.ts` `idempotencyService.lookup` by sourceHash/customerId
  /areaPath) plus an embedding dedup check — never reads the live ADO tree. `getWorkItem` (returns
  parentId + full field bag) and `queryIds` (exact-match WIQL) make a real diff *feasible* but no
  traversal/comparison code exists. Relevant to Phase 4.

## Taxonomy tags — computed, then dropped

- Ingestion **already computes** `WorkItemNode.tags: list[RequirementTag]`, 11 categories
  (functional, non_functional, interface, performance, regulatory, safety, security, etc.) —
  `ingestion/app/workitem/model.py:21-44`.
- Tags are **dropped** when building `DryRunTreeNode` in the pipeline worker
  (`orchestrator/src/modules/pipeline/pipeline.worker.ts:48-57` maps local_id/parent/type/title/
  description/hash/customerId/areaPath — no tags field). `DryRunTreeNode`/`DryRunDiffEntry` have no
  tags field at all (`dry-run.service.ts:4-13, 15-37`). Never reaches ADO.
- **This is a near-free win** — Phase 1 carries `tags` through the diff types and sets
  `System.Tags` via the existing `setFields` primitive.

## LLM / chat / embed (orchestrator, `orchestrator/src/modules/llm/`)

- `POST /llm/chat` — `{messages: [{role, content}], temperature?}` → `{content}`. Single-shot
  completion, **no streaming, no session/history, no tool-calling**
  (`llm.controller.ts:12,23`, `llm-chat.dto.ts:3-13`).
- `POST /llm/embed` — `{texts: string[]}` → `{embeddings: number[][]}` (`llm.controller.ts:26-34`).
- Backend: `OpenWebUiClient` via the `openai` SDK against a config-driven `LLM_BASE_URL`
  (Open WebUI / Ollama's OpenAI-compatible endpoint), model from `LLM_CHAT_MODEL`
  (`openwebui.client.ts:18-25`). Comments cite a "12b-class Ollama model."
- Redaction: outbound content redacted unless `LLM_TRUSTED_LOCAL` set (`openwebui.client.ts:29,44`).
- **Auth is service-to-service only**: `LlmProxyBearerGuard` requires a fixed bearer
  (`llm-proxy-bearer.guard.ts:22`); the only current callers are the Python ingestion service.
  **Not wired to end-user auth at all.**
- **Feasibility for chat/AI-assist (Phase 3) and RAG injection (Phase 2):** the raw completion
  primitive exists and works. Net-new: user-facing auth on the endpoint, streaming, session state,
  and — critically — nothing today injects any retrieved context into the message array; `chat()`
  forwards exactly what it's given.

## Embeddings / vector store / RAG primitives (already exist, partially)

- Embedding generation via `/llm/embed` → Ollama `EMBED_PATH` (`openwebui.client.ts:38-56`).
- **Vector store**: `ChromaVectorStore` (`ingestion/app/dedup/vector_store.py:17`) — persistent
  local Chroma client, **one collection per Area Path** (`:29-33`), **cosine** space (`:32`).
  Default persist path `./.req2ado/vectors` (`config.py:19`).
- **Similarity search**: `query_nearest()`, `n_results=1`, similarity = `1 - distance` (`:39-47`).
  This is exactly how the `similarity` field on `DryRunDiffEntry` is computed — embeddings +
  cosine, not hashing. Flow: `check_for_duplicates()` embeds → queries nearest → thresholds at
  `0.90` (`ingestion/app/dedup/check_for_duplicates.py:14-35`), exposed via `POST /dedup/check` /
  `POST /dedup/upsert` (`ingestion/app/main.py:82-92`), consumed at `dry-run.service.ts:50,77`.
- **Known limitation**: the Chroma store is local/per-instance — each instance has an independent,
  incomplete corpus (`ingestion/app/main.py:23-25`).
- **Critical gap for RAG (Phase 2):** the vector store holds only `item_id` + embedding + area
  path (`vector_store.py:35-37`) — **no source text is stored**. There is also **zero**
  retrieval-to-prompt injection anywhere; retrieved neighbors feed only the dedup boolean/score,
  never a chat/generation prompt. Phase 2's KB needs net-new chunk/source-text storage.

## SharePoint — absent (confirmed)

Zero matches for `sharepoint`, `sharept`, `msgraph`, `graph.microsoft`, `_api/web`, `ntlm`,
`onedrive` anywhere in req2ado (excluding node_modules/dist/.git). Fully net-new — see
`docgen-connection-pattern.md` for the pattern DocGen uses that req2ado's SharePoint connector
(Phase 2, P2a) will mirror.

## Requirement quality scoring — absent (confirmed)

No quality scoring, EARS/"shall" validation, ambiguity detection, or quality metric anywhere in
the SURVEY pipeline. The only existing validation is **taxonomy tag enum conformance** — generated
requirements are parsed into `GeneratedRequirement`, whose tags are validated against the
`RequirementTag` pydantic enum, raising on an unknown tag
(`ingestion/app/survey/requirement_client.py:11-12`,
`ingestion/app/survey/build_survey_requirements.py:7-11`). "shall" appears only as prompt
instructions to the LLM, never as an output validator. Relevant to Phase 2, P2c.
