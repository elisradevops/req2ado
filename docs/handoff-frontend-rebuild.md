# Handoff: req2ado — Phase 1 + KB (Graph) Shipped

**Purpose of this doc:** context for a *new* session picking up work after Phase 1's frontend rebuild, its post-merge gap closures, and the Phase-2 knowledge-base connector all landed on `master`. **Note on history:** the KB connector was first built as a SharePoint-REST folder-crawl (commit `375da94`, "P2a") and then **replaced** by a Microsoft Graph single-share-link ingest (commit `8f22cec`). This doc describes the *current* Graph model; ignore any older doc/spec text describing folder-crawl / `KbSource` / `/kb/sources` — that connector no longer exists. Roadmap: `docs/req2ado-roadmap.md`.

---

## 1. What req2ado actually does (one paragraph)

Converts a customer requirements document (contract-signed spec, informal narrative, or engineering ICD) into a hierarchical Azure DevOps work-item tree (Epic → Feature → Requirement, with sub-levels). Two modes: **BASELINE** (deterministic, verbatim, no LLM — for signed contracts) and **SURVEY** (LLM-driven, distills informal text into formal "shall" requirements with taxonomy tags — for messy customer narratives). Flow: upload → dry-run diff (preview, nothing written) → review → confirm (writes to ADO via a custom MCP server). RAG-first grounding now has its foundation (a Microsoft Graph document-ingest connector that populates a per-area-path KB corpus) but **no retrieval is wired into any LLM call yet** — that's P2b.

## 2. Current repo state

- **Location:** `/Users/EdenZviSchwartz/Repos/Projects/elisradevops/req2ado` — own standalone git repo, branch `master`, no remote configured (fully local).
- **Stack:** monorepo of 4 packages — `frontend/` (React 19 + Vite + MUI 6 + react-router-dom + Zustand), `orchestrator/` (NestJS, Postgres/Prisma, BullMQ+Redis, MCP client), `ingestion/` (Python/FastAPI — parsing, leveling, LLM calls, KB ingest), `mcp-ado-server/` (custom MCP server for ADO reads/writes, mock + real backend).
- **Phase 1 merged to `master`**: 24 tasks + 1 final-review fix, 31 commits.
- **Phase 1 gap closures merged** (commit `c68a122`): the five gaps flagged in the previous version of this doc are now closed — see §4.
- **KB connector, first cut** (commit `375da94`, "P2a"): SharePoint-REST folder-crawl + `KbSource` config + Sync button. **Superseded — do not build on it.**
- **KB connector, current** (commit `8f22cec`): replaced the folder-crawl with a Microsoft Graph single-share-link document ingest. This is the live model — see §4a.
- **Full docker-compose stack** (7 services incl. frontend) — live-verified end-to-end this round: login-session bypass → upload → wizard → reload-driven diff → confirm → audit, and separately the full `/knowledge-base` Graph-ingest flow (paste sharing link → real graph.microsoft.com call → real document parsed/chunked/stored → skip-unchanged on re-ingest → renders in the UI — see §4a).
- **`docs/architecture.md`** — the original (aspirational, over-scoped) design doc. Still treat with skepticism.
- **`~/.claude/plans/glowing-prancing-valiant.md`** — the approved design/plan for the Graph-ingest replacement (the current KB model).
- **`docs/superpowers/specs/2026-07-12-p2a-sharepoint-kb-connector-design.md`** + **`docs/superpowers/plans/2026-07-12-p2a-sharepoint-kb-connector.md`** — the *superseded* P2a folder-crawl design/plan. Historical only; the connector they describe was deleted in `8f22cec`.
- **`.superpowers/sdd/progress.md`** (Phase 1), **`progress-p2a.md`** (superseded folder-crawl), **`progress-graph-kb.md`** (current Graph connector) — execution ledgers: which task found which bug, which commit fixed it.

## 3. The frontend as it exists today

**Location:** `frontend/src/`

- **Routing:** `react-router-dom`, real URLs — `/login`, `/jobs`, `/jobs/new`, `/jobs/:id`, `/knowledge-base`, `/help`. `RouteGuard` redirects unauthenticated users to `/login`. Refresh-safe (auth persisted, see below).
- **State:** Zustand — `authStore` (`orgUrl`/`pat`/`displayName`, mirrored to `sessionStorage`, hydrated on load, selector hooks only), `jobsStore` (job-list cache + id-keyed job-detail cache, `JobDetail` now includes `mode`).
- **Pages:**
  - `pages/Login.tsx` — org URL + PAT form, validates via `POST /auth/login` against the **real** target ADO org (there is no mock branch for login — see §4's testing note). On success calls `authStore.login()` and navigates to `/jobs`.
  - `pages/JobsList.tsx` — landing page, `GET /jobs`, mode badge + status chip + item count + area path + relative time, empty-state CTA.
  - `pages/NewJobWizard.tsx` — two-step wizard: Step 1 upload (`FileDropzone` → `POST /jobs/preview`), Step 2 review+configure (`ModeCards`, computed ETA, `AreaPathPicker` — now `freeSolo`, see §4 — optional State/Iteration fields, submit).
  - `pages/JobDetail.tsx` — split view: virtualized `DiffTree` (left) + `NodeDetailPanel` (right), SSE-driven `ProgressBanner` (now mode-aware, see §4) while `status === 'running'`, Confirm button gated on `status === 'diff_ready'`, Audit tab, explicit failure screen for `status === 'failed'`.
  - `pages/KnowledgeBase.tsx` — KB document ingest (current Graph model, §4a): form with **Sharing URL / Area Path / Doc Type (optional)** + an Ingest button (async-mutation-guarded); a list of ingested documents (name, docType, size, ingestedAt). **No bearer-token field** — the SharePoint/Graph token is a server-side env var now, not a user input. A helper line states this.
  - `pages/Wiki.tsx` — unchanged, renders `GET /wiki` markdown.
- **Components:** `AppShell.tsx` (nav now includes Knowledge Base), `RouteGuard`, `StatusChip`/`ModeBadge`/`ActionBadge`/`TagChips` (now null-safe — see §4), `DiffTree` (virtualized via `react-window`, `tags` field now optional to match legacy DB rows), `NodeDetailPanel`, `AreaPathPicker` (MUI Autocomplete, now `freeSolo` + error-toasts on fetch failure), `FileDropzone`, `ModeCards`, `ProgressBanner`+`ElapsedTimer`, `ErrorBoundary`, `ToastProvider`+`useToast()`.
- **Theme:** `theme/tokens.ts` — DocGen tokens (`#1B458F` primary) + `railBackground: '#0F1B3D'` + `liveAccent: '#06B6D4'`.
- **API client:** `api/httpClient.ts` — axios instance, runtime-configured `baseURL` via `/config.json`. `api/jobs.ts`, `api/ado.ts`, `api/events.ts`, `api/kb.ts` wrap all backend routes. The ADO PAT/org-URL travel only as per-request `X-Ado-Org-Url`/`X-Ado-Pat` headers, never persisted server-side. The SharePoint/Graph token is **not** a frontend concern at all anymore — it lives in the ingestion service's env (see §4a).

## 4. Phase 1 gaps — now closed (previously listed here as open)

All five verified live against docker-compose this round:

1. **`ProgressBanner`'s `mode` prop** was hardcoded to `"survey"` — `GET /jobs/:id` now returns `mode`, threaded through.
2. **Pending→running mount race** — the SSE-subscription effect now also fires while `status === 'pending'`, not just `'running'`; confirmed live (`Diff Ready` appears without a manual reload).
3. **`AreaPathPicker` free-text entry** — now `freeSolo`; confirmed live (typed a path not in the loaded tree, submitted successfully).
4. **No error toast on `AreaPathPicker`'s fetch failure** — now wired to `useToast()`.
5. **Live docker-compose end-to-end run** — done. Also surfaced a real, previously-unknown bug (see below).

**Bonus bug found during live verification (fixed, not previously known):** opening any pre-Phase-1 job crashed with `Cannot read properties of undefined (reading 'map')` — `TagChips` did an unguarded `.map()` over `tags`, and legacy DB rows (created before the taxonomy-tags field existed) have no `tags` at all. Fixed with `(tags ?? []).map(...)`.

**New testing-infra note discovered this round:** `POST /auth/login` has **no mock branch** — `AdoPatProvider` always calls the real target ADO org's `connectionData` endpoint regardless of `ADO_BACKEND=mock`. The existing `scripts/run-golden-e2e.sh` never exercises `/auth/login` for exactly this reason (it drives `/jobs` directly). To live-test the UI without real ADO credentials, seed `sessionStorage`'s `req2ado-auth` key directly (`{orgUrl, pat, displayName}`) to bypass the login screen — everything downstream (mcp-ado-server writes) is mock-backed regardless.

## 4a. KB connector — Microsoft Graph document ingest (current, commit `8f22cec`)

Foundation for Phase 2's RAG-first knowledge layer. **No retrieval is wired into any LLM stage yet** — this only fetches, chunks, embeds, and stores. On-demand, **single sharing-URL** ingest via the Microsoft Graph `/shares` endpoint (not a folder crawl). Replaced the earlier folder-crawl connector (`375da94`) wholesale.

- **ingestion** (`app/kb/`):
  - `chunker.py` — heading-aware chunking, fixed-window fallback for headless docs. *(kept from P2a, unchanged)*
  - `kb_vector_store.py` — `KbVectorStore`, per-area-path Chroma namespace `req2ado_kb_<hash>` (separate from dedup's `req2ado_<hash>`), stores chunk **text + metadata**. `source_id` = the Graph **driveItem id** (stable per-document identity, enables skip-unchanged + delete-before-reingest). `upsert_chunk` takes an optional `doc_type` (omitted from metadata when `None` — chromadb rejects `None` values, so P2b queries must treat the key as sparse).
  - `url_security.py` — SSRF `validate_share_url` (scheme + **domain-boundary-anchored** host allowlist + private/loopback/link-local IP-literal reject), `MAX_FILE_SIZE_BYTES` (50 MB), `verify_supported_content` (magic-byte sniff: `%PDF`, ZIP `PK\x03\x04` for docx/xlsx, UTF-8-decodable for txt/md).
  - `graph_client.py` — `GraphClient(token, base_url)` (raises if token empty). `encode_share_id` = `"u!" + base64url(url).rstrip("=")`. `get_drive_item` (GET `/shares/{shareId}/driveItem` → id/name/mimeType/size) + `fetch_content` (GET `/shares/{shareId}/driveItem/content`, follow redirects). Status map: 401/403/404 → `GraphApiError` with that status; transport failure (timeout/connreset) → `GraphApiError(502)`. Token never appears in errors/logs.
  - `ingest_service.py` — `ingest_document_from_url` — validate URL → get metadata → size gate (pre-download, on `item.size`) → fetch bytes → size re-check + content-type verify → hash → skip-unchanged (by driveItem id) → parse (reuses `dispatch_by_extension`) → chunk → **embed all, then delete old chunks, then upsert** (the data-integrity ordering carried over from P2a). Single document → exceptions propagate (no swallow).
  - Route `POST /kb/ingest-url` (body `{url, area_path, doc_type?}`), `run_in_threadpool`, maps `ValueError`→400, `GraphApiError`→its status (401/403/404) else 502.
  - **Token:** read from env `SHAREPOINT_TOKEN` (fallback `GRAPH_TOKEN`) in `config.py`, `graph_base_url` overridable. Optional-with-`None` so ingestion still boots tokenless; `GraphClient` raises at route-call time, not import.
- **orchestrator** (`src/modules/kb/`): `IngestedDocument` Prisma model (**replaced `KbSource`**) — non-secret metadata only (`areaPath`/`driveItemId`/`name`/`sizeBytes`/`mimeType?`/`docType?`/`ingestedAt`), unique on `[areaPath, driveItemId]` (re-ingest updates the same row). `KbController` (`@Controller('kb')`): `POST /kb/ingest-url`, `GET /kb/documents?areaPath=`. `IngestionHttpClient.ingestUrl` forwards (reuses `LONG_RUNNING_AGENT`) and throws `IngestionHttpError` carrying the ingestion status; the controller re-maps it to `HttpException` with the same status. Controller also runs a fast domain-boundary-anchored host allowlist pre-check (400 before forwarding).
- **frontend**: `pages/KnowledgeBase.tsx` (URL/areaPath/docType form + ingested-doc list, **no token field**), `api/kb.ts` (`ingestUrl`, `listIngestedDocuments`).
- **infra**: Chroma persist path (`./.req2ado/vectors`) has a docker-compose volume mount (`req2ado_chroma`) — KB chunks + dedup vectors survive `docker compose up --build`. Ingestion `env_file: .env` carries `SHAREPOINT_TOKEN`/`GRAPH_TOKEN`.
- **Accepted link hosts:** `*.sharepoint.com`, `*.onedrive.com`, `*.sharepoint.us`, `onedrive.live.com`, `1drv.ms`.

**Security posture (deliberate, differs from ADO):** the SharePoint/Graph token is a **single shared server identity** read from env on ingestion — every ingest uses the same token/permissions, and the browser never handles it. This consciously overturns req2ado's per-request-credential rule *for SharePoint only* (the ADO PAT stays strictly per-request). Never persisted, never logged, never forwarded from the frontend.

**Reviews caught & fixed (both with regression tests):** (1) a **Critical SSRF host-spoofing bypass** — the initial allowlist used a raw `endswith`, so `fakeonedrive.com` passed; fixed by anchoring at a domain-label boundary (`host === s || host.endsWith('.'+s)`), applied at **both** the ingestion and orchestrator allowlist layers. (2) an **Important robustness gap** — Graph network/timeout errors were uncaught → opaque 500; now wrapped as `GraphApiError(502)`.

**Real-tenant happy path — verified.** Ingested a real `.docx` (1.4MB) via a real `graph.microsoft.com` sharing link: parsed content confirmed in the KB Chroma collection (correct `source_id`/`doc_type`/`file_hash` metadata), `IngestedDocument` row persisted, re-ingest correctly returned `skippedUnchanged: true`, and it renders on `/knowledge-base`. Also confirmed the 403 path against real Graph along the way (a token with only `openid profile User.Read email` scopes → genuine Graph `accessDenied` → cleanly surfaced as HTTP 403). **Scope note:** `Files.Read` (not `Files.Read.All`) was sufficient — the tenant didn't allow `.All`, and a delegated `Files.Read` token covers files the signed-in user can access via a sharing link, which is the only case this connector needs.

**Also worth knowing:** `IngestedDocument` uniqueness is `[areaPath, driveItemId]` — a document is identified by its Graph driveItem id, so the same file re-shared under a new link (same driveItem) correctly updates in place; a genuinely different copy (different driveItem) is a distinct row.

## 5. Backend API surface (current)

All routes on the orchestrator (`http://localhost:3001` in dev):

- `POST /auth/login` — body `{ adoOrgUrl, pat }` → `{ displayName }`. Calls the **real** ADO org directly (no mock path — see §4).
- `GET /jobs` → `{ id, mode, status, areaPath, itemCount, createdAt }[]`, newest first.
- `POST /jobs/preview` — multipart `file` → `{ blockCount, sectionCount, fileType }`. No LLM, no credentials required.
- `POST /jobs` — multipart form: `file`, `areaPath`, `customerId?`, `mode` (`baseline`|`survey`), `state?`, `iterationPath?` → `{ jobId }`.
- `GET /jobs/:id` → `{ id, status, mode, dryRunDiff }` — **`mode` added this round**. `status` ∈ `pending | running | diff_ready | writing | succeeded | failed`.
- `GET /ado/area-paths?depth=5` — headers `X-Ado-Org-Url`/`X-Ado-Pat` → nested `{ path, children }` tree.
- `GET /jobs/:id/events` — SSE stream, `event: stage\ndata: {"stage":"..."}\n\n` frames.
- `POST /jobs/:id/confirm` — headers `X-Ado-Org-Url`, `X-Ado-Pat` → `{ status, createdCount }`.
- `GET /jobs/:id/audit` → array of `{ id, message, createdAt }`.
- `POST /kb/ingest-url` — body `{ url, areaPath, docType? }` → `{ documentName, driveitemId, mimeType, sizeBytes, chunksStored, skippedUnchanged }`. No token in the request (server-side env). 400 on bad/lookalike host or SSRF URL; 401/403/404 passed through from Graph; 502 on Graph unreachable. *(The old `/kb/sources` + `/kb/sources/:id/sync` routes were removed in `8f22cec`.)*
- `GET /kb/documents?areaPath=` → `IngestedDocument[]` (non-secret metadata; `areaPath` filter optional).
- `GET /wiki` → raw markdown string.
- `GET /health` → `{ ok: true }`.

**`DryRunDiffEntry` shape** (per node in `dryRunDiff`): `{ localId, parentLocalId, type, title, description, action: 'create'|'reuse'|'dedup_skip', existingAdoId: number | null, similarity, customerId, sourceHash, tags?: string[] }`. `tags` is now optional (legacy pre-Phase-1 rows lack it — see §4). `action` values are lowercase.

## 6. Real-world performance characteristics (unchanged)

- BASELINE mode: fast (seconds), no LLM, works well.
- SURVEY mode: **very slow** on real documents — 15-40+ minutes on a 12B local model, no chunking/streaming in `/level`. The SSE progress banner surfaces the coarse stage + elapsed timer, not a true percentage.
- KB ingest (Graph): untested against real documents at volume — expect it to scale with document size × per-chunk embed round-trips (one `/llm/embed` call per chunk, not batched — a known deferred optimization). Also: `fetch_content` buffers the whole body in memory before the post-download size re-check (low risk — the Graph host is SSRF-restricted; flagged for a future streamed cap if needed).

## 7. Known infra quirks

- CORS: orchestrator only enables CORS when `CORS_ORIGIN` env var is set.
- Docker Compose services + ports: frontend `4082`, orchestrator `3001`, ingestion `8010`, mcp-ado-server `4100`, postgres `5434`, redis `6381`.
- `pipeline-worker` is a **separate container/process** from `orchestrator` — Redis pub/sub carries SSE stage-progress across the process boundary.
- Corporate network runs outbound HTTPS through a Cato Networks TLS-inspecting proxy — `.certs/cato-ca-bundle.pem` (gitignored, machine-specific).
- **New this round:** `orchestrator/.env`'s `DATABASE_URL` points at `localhost:5432` (a leftover local-process Postgres from prior golden-e2e runs), NOT the docker-compose stack's Postgres (mapped to host port `5434`). When running `npx prisma migrate dev` locally, target `5434` explicitly or it'll diff against the wrong database.
- Chroma's vector store now persists across rebuilds via the `req2ado_chroma` docker volume (previously reset every `docker compose up --build` — see §4a).

## 8. What's next (per `docs/req2ado-roadmap.md`)

- **Phase 2, P2b — RAG-first retrieval-injection** (next up): prepend retrieve+inject to `infer_hierarchy`, `generate_requirements`, and future chat — grounds each LLM call when relevant KB material exists, falls back to the model's baseline knowledge when it doesn't. The KB store + ingest path exist, but nothing reads from the `req2ado_kb_<hash>` collection yet. Note the `doc_type` metadata key is sparse (absent when not supplied at ingest) — retrieval filters must handle key-absent.
- **P2c — RAG-grounded quality scoring**, **P2d — learning loop** (write confirmed items back into the KB).
- **Phase 3 — Review power** (editable dry-run diff, AI assist/chat per item).
- **Phase 4 — Traceability** (Covers/CoveredBy/Affects link types, diff-vs-live-ADO, baselining).

The KB ingest happy path has now been verified against a real Graph token/tenant (§4a) — the fetch→chunk→embed→store path works against real document content, which is what P2b's retrieval will build on.

## 9. Testing conventions (established, keep using)

- **orchestrator**: Jest, `*.spec.ts`, hand-built plain-object mocks passed positionally to constructors — no NestJS `TestingModule` bootstrap. See `orchestrator/test/jobs.service.spec.ts`, `orchestrator/test/kb.service.spec.ts`.
- **mcp-ado-server**: Vitest, `*.test.ts`, real `McpServer` + `MockAdoBackend(':memory:')`.
- **frontend**: Vitest + `@testing-library/react`, `vi.mock('../api/...')` pattern. See `frontend/src/pages/KnowledgeBase.test.tsx` for the newest example (toast-on-error coverage for both fetch-in-effect and form-submit paths).
- **ingestion**: pytest, `.venv/bin/python -m pytest` (not bare `pytest`). See `ingestion/tests/kb/` for the newest suite — `test_url_security.py` (SSRF + content-sniff, incl. the lookalike-domain regression), `test_graph_client.py` (share-id + status/transport-error mapping), `test_ingest_service.py` (size-before-download, SSRF-before-Graph, embed-before-delete ordering).
- `npm run build` = `tsc -b && vite build` in `frontend/`.
