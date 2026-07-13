# P2a — SharePoint Connector + Knowledge Base — Design

**Status:** approved, not yet implemented. First sub-phase of Phase 2 (RAG-first knowledge layer)
per `docs/req2ado-roadmap.md`. Prior context: `docs/handoff-frontend-rebuild.md` (Phase 1 shipped).

## Purpose

Build the foundation the rest of Phase 2 depends on: fetch documents from on-prem/online
SharePoint, chunk them, embed them, and persist chunk text + embeddings in a per-area-path
knowledge base. Nothing else in Phase 2 (retrieval-injection, quality scoring, learning loop) can
work without this. **P2a itself does not wire any retrieval into any LLM call** — that's P2b.

## Prior state (confirmed by investigation)

- `ingestion/app/dedup/vector_store.py` — `ChromaVectorStore`, one Chroma collection per area path
  (`req2ado_<sha256(areaPath)[:32]>`), **stores only embeddings + ids**, no source text. Runs as an
  embedded `chromadb.PersistentClient` inside the `ingestion` container at
  `./.req2ado/vectors` (`ingestion/app/config.py: chroma_persist_path`) — **no docker-compose
  volume mount today**, so it resets on container rebuild.
- `ingestion/app/dedup/check_for_duplicates.py` — calls an `embed_client.embed([text])` abstraction
  (`ingestion/app/dedup/orchestrator_embed_client.py`) which hits orchestrator's existing
  `POST /llm/embed` route. This client is reused as-is for KB embedding.
- `ingestion/app/canonical/model.py` — `CanonicalDoc`/`Block`/`BlockKind` — existing per-format
  loaders (`docx_loader.py`, `pdf_loader.py`, `xlsx_loader.py`, `text_loader.py`) already parse
  arbitrary documents into structured blocks with heading levels. **Reused as-is** for KB document
  parsing — no new parser needed.
- `docs/docgen-connection-pattern.md` — DocGen's SharePoint connector (reference, internal reuse,
  not third-party IP): credential travels **in the request body** (not headers, unlike ADO),
  bearer token for SharePoint Online, only non-secret config (`siteUrl`/`library`/`folder`)
  persists server-side (Mongo model in DocGen; Postgres/Prisma here). REST endpoints:
  `GetFolderByServerRelativeUrl('...')/Files`, `.../Folders`,
  `GetFileByServerRelativeUrl('...')/$value`.
- User confirmed their SharePoint access is a **literal bearer token** — no OAuth popup flow or
  MSAL dependency needed for this case. NTLM on-prem path explicitly deferred (not this phase).

## Architecture

### ingestion (Python/FastAPI) — new `app/kb/` package

- `sharepoint_client.py` — lists a folder's files and fetches file bytes via SharePoint REST,
  `Authorization: Bearer <token>` per request (DocGen's Online path, `SharePointService.ts:239-268`
  mirrored). No credential is held beyond the single sync call's lifetime.
- Parsing reuses the **existing** format-dispatched loaders (`docx_loader.py` etc.) — a fetched
  file becomes a `CanonicalDoc` exactly like an uploaded requirements document does today.
- `chunker.py` — groups a `CanonicalDoc`'s `Block`s into chunks by heading section (a `HEADING`
  block starts a new chunk, subsequent blocks until the next heading of equal-or-higher level join
  it); falls back to a fixed-size block window (e.g. 10 blocks) for documents with no heading
  structure.
- `ChromaVectorStore` extended: KB chunks are stored in a **separate collection namespace**,
  `req2ado_kb_<sha256(areaPath)[:32]>`, distinct from dedup's `req2ado_<hash>` collections — same
  per-area-path scoping, no risk of KB chunks polluting dedup queries or vice versa. Each upsert
  includes `documents=[chunk_text]` and `metadatas=[{source_file, chunk_index, file_hash}]` — the
  net-new part; dedup's collections stay embeddings-only, unchanged.
- New route `POST /kb/sync` — body `{ siteUrl, library, folder, areaPath, bearerToken }`. Per file:
  compute `sha256`; if the KB collection already has chunks whose `metadata.file_hash` matches for
  that `source_file`, skip re-embedding it (hash-based skip-unchanged, same pattern as
  `DryRunDiffEntry.sourceHash`); otherwise delete that file's old chunks (if any, e.g. content
  changed) and re-parse/chunk/embed/upsert. Returns
  `{ filesProcessed, filesSkipped, filesFailed: [{file, reason}], chunksStored }`.

### orchestrator (NestJS) — new `kb` module

Mirrors the existing `ado` module's per-request-credential pattern (see
`docs/docgen-connection-pattern.md` summary: credential acquired client-side, sent fresh per
request, gateway holds nothing).

- New Prisma model:
  ```prisma
  model KbSource {
    id            String    @id @default(uuid())
    areaPath      String
    siteUrl       String
    library       String
    folder        String
    displayName   String
    lastSyncedAt  DateTime?
    createdAt     DateTime  @default(now())
  }
  ```
  No token/secret field — matches DocGen's `SharePointConfig` (non-secret config only).
- `POST /kb/sources` — create a source config (site/library/folder/areaPath/displayName).
- `GET /kb/sources` — list configured sources with `lastSyncedAt`.
- `POST /kb/sources/:id/sync` — body `{ bearerToken }` (never persisted) → orchestrator reads the
  source's persisted config, forwards `{siteUrl, library, folder, areaPath, bearerToken}` to
  ingestion's `POST /kb/sync`, updates `lastSyncedAt` on success, relays the sync summary.

### frontend — new `/knowledge-base` page

- Nav link added alongside Jobs/New Job/Help.
- Form: site URL, library, folder, target area path, bearer token (component-local state only —
  never written to Zustand/sessionStorage, since unlike the ADO PAT it's only needed for the
  in-flight Sync call, not the whole session).
- List of configured sources with last-synced time; "Sync" button per source triggers
  `POST /kb/sources/:id/sync`, awaits the summary synchronously (no SSE — sync is a bounded
  request/response, unlike SURVEY's long LLM run), shows result via the existing `ToastProvider`
  (success / partial-failure with `filesFailed` count / hard failure).

## Data flow

1. User fills the KB source form → `POST /kb/sources` (orchestrator persists non-secret config) →
   returns `sourceId`.
2. User clicks Sync → `POST /kb/sources/:id/sync` with bearer token in the body → orchestrator
   reads the persisted config, forwards the bearer token + config to ingestion's `POST /kb/sync` —
   orchestrator never touches file contents, only proxies and awaits the summary.
3. Ingestion lists the folder's files; per file: hash-check (skip unchanged) → parse via existing
   loader → chunk → embed via `/llm/embed` → upsert into the area path's KB collection.
4. Ingestion returns the sync summary → orchestrator updates `lastSyncedAt`, relays it → frontend
   toasts success or partial-failure.

## Error handling (RAG-first "never blocks" principle applies here too)

- SharePoint folder-listing failure (401/network) → whole sync fails, surfaced as an error toast,
  `lastSyncedAt` left untouched.
- Individual file parse failure (corrupt/unsupported format) → that file is skipped, the rest of
  the sync continues, failure reported in `filesFailed` with a reason — never aborts the whole
  sync.
- Sync has no downstream consumers yet in P2a — a KB with zero or partial content is a valid,
  non-blocking state; P2b's retrieval will simply find nothing relevant until synced.

## Testing

- **ingestion** (pytest, mirrors `dedup` test conventions): chunker block-grouping logic,
  hash-skip-unchanged logic, KB `ChromaVectorStore` upsert/query with `documents`+`metadata`.
- **orchestrator** (Jest, mirrors `jobs.service.spec.ts`/`ado-pat.provider.spec.ts` conventions):
  `KbController`/`KbService` spec with a mocked ingestion HTTP client, Prisma `KbSource` CRUD, and
  an explicit assertion that the bearer token is never persisted (same style as the existing PAT
  non-persistence check).
- **frontend** (Vitest+RTL, `vi.mock('../api/kb')` pattern): `KnowledgeBasePage` form validation,
  Sync button states/disabled-during-flight, toast on success/partial-failure/hard-failure.
- **No live-SharePoint e2e this phase** — no real tenant/token available in local dev, same
  deferral golden-e2e already applies to `/auth/login`'s real-ADO dependency. Flagged, not silently
  skipped.

## Explicitly out of scope for P2a (deferred to later Phase 2 sub-phases)

- No retrieval-injection into any LLM stage (`infer_hierarchy`, `generate_requirements`, chat) —
  that is P2b.
- No quality scoring — P2c.
- No learning-loop write-back (confirmed items → KB) — P2d.
- No NTLM/on-prem-without-token SharePoint path — bearer-token-only, per the user's confirmed
  real-world case; NTLM can be added later without redesigning this connector (same reasoning
  DocGen's `docgen-connection-pattern.md` gives for its own dual-path design).

## Infra note (open item, not a P2a blocker)

`ChromaVectorStore`'s persist path (`./.req2ado/vectors`) has no docker-compose volume mount today
— dedup's vectors already reset on every container rebuild, and this was apparently acceptable
since dedup is best-effort. Once the KB holds real synced content, losing it on every rebuild is a
worse UX (users would re-sync after every `docker compose up --build`). Recommend adding a named
volume for `./.req2ado/vectors` in `docker-compose.yml` as part of P2a's implementation — small,
localized addition, not a redesign.
