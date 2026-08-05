# Handoff: req2ado — Phase 1 + KB (Graph) Shipped

> Point-in-time handoff, 2026-07. Visual-system claims superseded by `/DESIGN.md`.

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
- **KB connector, current** (commits `8f22cec`, `b28cd20`, `7647604`, `d02f779`, `4c701f0`): replaced the folder-crawl with a Microsoft Graph single-share-link document ingest, then verified against a real tenant, then added single-level folder-crawl back via Graph's `/children` endpoint (a different mechanism than the deleted P2a folder-crawl — see §4a), then closed 3 of 4 deferred robustness gaps, then added opt-in recursive subfolder descent.
- **Full docker-compose stack** (7 services incl. frontend) — live-verified end-to-end this round: login-session bypass → upload → wizard → reload-driven diff → confirm → audit, and separately the full `/knowledge-base` Graph-ingest flow for both single-document AND folder links (paste sharing link → real graph.microsoft.com calls → real documents parsed/chunked/stored → skip-unchanged on re-ingest → renders in the UI — see §4a). Ingested 3 real documents (1 docx + 2 pdfs) into the `Custom Test Project CMMI\Test` area path this round.
- **`docs/architecture.md`** — the original (aspirational, over-scoped) design doc. Still treat with skepticism.
- **`~/.claude/plans/glowing-prancing-valiant.md`** — the approved design/plan for the Graph-ingest replacement (the current KB model).
- **`docs/superpowers/specs/2026-07-12-p2a-sharepoint-kb-connector-design.md`** + **`docs/superpowers/plans/2026-07-12-p2a-sharepoint-kb-connector.md`** — the *superseded* P2a folder-crawl design/plan. Historical only; the connector they describe was deleted in `8f22cec`.
- **`.superpowers/sdd/progress.md`** (Phase 1), **`progress-p2a.md`** (superseded folder-crawl), **`progress-graph-kb.md`** (current Graph connector, incl. real-tenant verification + folder-crawl addition + independent review findings) — execution ledgers: which task found which bug, which commit fixed it. **Note:** `.superpowers/sdd/progress.md` is overwritten fresh per feature branch (it's git-ignored scratch, not append-only) — the P3c ledger that lived there during P3c's execution is gone now that branch merged; this doc (§4f) is P3c's durable record.
- **Branch note:** despite this doc's title/§2 above saying `master`, the actual default branch is now `main` (confirmed via `git log`) — P3c (§4f, commits `663b997`→`6583d68`) merged there via fast-forward.

## 3. The frontend as it exists today

**Location:** `frontend/src/`

- **Routing:** `react-router-dom`, real URLs — `/login`, `/jobs`, `/jobs/new`, `/jobs/:id`, `/knowledge-base`, `/help`. `RouteGuard` redirects unauthenticated users to `/login`. Refresh-safe (auth persisted, see below).
- **State:** Zustand — `authStore` (`orgUrl`/`pat`/`displayName`, mirrored to `sessionStorage`, hydrated on load, selector hooks only), `jobsStore` (job-list cache + id-keyed job-detail cache, `JobDetail` now includes `mode`).
- **Pages:**
  - `pages/Login.tsx` — org URL + PAT form, validates via `POST /auth/login` against the **real** target ADO org (there is no mock branch for login — see §4's testing note). On success calls `authStore.login()` and navigates to `/jobs`.
  - `pages/JobsList.tsx` — landing page, `GET /jobs`, mode badge + status chip + item count + area path + relative time, empty-state CTA.
  - `pages/NewJobWizard.tsx` — two-step wizard: Step 1 upload (`FileDropzone` → `POST /jobs/preview`), Step 2 review+configure (`ModeCards`, computed ETA, `AreaPathPicker` — now `freeSolo`, see §4 — optional State/Iteration fields, submit).
  - `pages/JobDetail.tsx` — split view: virtualized `DiffTree` (left) + `NodeDetailPanel` (right), SSE-driven `ProgressBanner` (now mode-aware, see §4) while `status === 'running'`, Confirm button gated on `status === 'diff_ready'`, Audit tab, explicit failure screen for `status === 'failed'`.
  - `pages/KnowledgeBase.tsx` — KB document ingest (current Graph model, §4a): form with **Sharing URL / "This is a folder" checkbox / Area Path / Doc Type (optional)** + an Ingest button (async-mutation-guarded, shared between both modes) — unchecked = single document via `ingestUrl`, checked = every file directly inside a shared folder via `ingestFolderUrl` (single level, no subfolders); a list of ingested documents (name, docType, size, ingestedAt). **No bearer-token field** — the SharePoint/Graph token is a server-side env var now, not a user input. A helper line states this.
  - `pages/Wiki.tsx` — unchanged, renders `GET /wiki` markdown.
- **Components:** `AppShell.tsx` (nav now includes Knowledge Base), `RouteGuard`, `StatusChip`/`ModeBadge`/`ActionBadge`/`TagChips` (now null-safe — see §4), `DiffTree` (virtualized via `react-window`, `tags` field now optional to match legacy DB rows), `NodeDetailPanel`, `AreaPathPicker` (MUI Autocomplete, now `freeSolo` + error-toasts on fetch failure), `FileDropzone`, `ModeCards`, `ProgressBanner`+`ElapsedTimer`, `ErrorBoundary`, `ToastProvider`+`useToast()`.
- **Theme:** Tailwind v4 CSS-first tokens in `frontend/src/index.css` (`@theme`). There is no `theme/tokens.ts`. Token semantics are normative in `/DESIGN.md`.
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

## 4a. KB connector — Microsoft Graph document ingest (current, commits `8f22cec` → `4c701f0`)

Foundation for Phase 2's RAG-first knowledge layer. **No retrieval is wired into any LLM stage yet** — this only fetches, chunks, embeds, and stores. Two ingest modes, both via Microsoft Graph: a **single sharing-URL** (one document) and a **folder crawl** (every file inside a shared folder — single-level by default, or **recursive** into subfolders when opted in, see below). Replaced the earlier P2a SharePoint-REST folder-crawl connector (`375da94`) wholesale — this is a different mechanism (Graph API, not SharePoint REST) reintroduced after the single-doc-only design proved too narrow for real use.

- **ingestion** (`app/kb/`):
  - `chunker.py` — heading-aware chunking, fixed-window fallback for headless docs. *(kept from P2a, unchanged)*
  - `kb_vector_store.py` — `KbVectorStore`, per-area-path Chroma namespace `req2ado_kb_<hash>` (separate from dedup's `req2ado_<hash>`), stores chunk **text + metadata**. `source_id` = the Graph **driveItem id** (stable per-document identity, enables skip-unchanged + delete-before-reingest). `upsert_chunk` takes an optional `doc_type` (omitted from metadata when `None` — chromadb rejects `None` values, so P2b queries must treat the key as sparse).
  - `url_security.py` — SSRF `validate_share_url` for user-typed sharing links (scheme + **domain-boundary-anchored** host allowlist + private/loopback/link-local IP-literal reject), `validate_fetch_url` for Graph-supplied URLs (https-only + private/loopback/link-local IP reject, no host allowlist since these are legitimate CDN hosts — added when the folder-crawl addition's independent review caught a fetch with zero SSRF guard, see below), `MAX_FILE_SIZE_BYTES` (50 MB), `verify_supported_content` (magic-byte sniff: `%PDF`, ZIP `PK\x03\x04` for docx/xlsx, UTF-8-decodable for txt/md).
  - `graph_client.py` — `GraphClient(token, base_url)` (raises if token empty). `encode_share_id` = `"u!" + base64url(url).rstrip("=")`. `get_drive_item`/`fetch_content` (single-doc, GET `/shares/{shareId}/driveItem`(`/content`), follow redirects). `list_folder_children` (GET `/shares/{shareId}/driveItem/children` → each file child carries Graph's own pre-signed `@microsoft.graph.downloadUrl` + `drive_id` from `parentReference.driveId`) + `fetch_child_content` (fetches that download URL directly, **no Authorization header** — Graph already authorized it, so the bearer token never reaches the download/CDN host; validated via `validate_fetch_url` first). `list_children_by_id(drive_id, item_id)` (commit `4c701f0`) — the by-id sibling of `list_folder_children`, GET `/drives/{driveId}/items/{itemId}/children`, needed to descend into a subfolder past the shared root (the `/shares/{shareId}/...` path only resolves the root). Status map: 401/403/404 → `GraphApiError` with that status; transport failure (timeout/connreset) → `GraphApiError(502)`. Token never appears in errors/logs.
  - `ingest_service.py` — shared core `_store_document(name, item_id, content, ...)`: verify content-type → hash → skip-unchanged (by driveItem id) → parse (reuses `dispatch_by_extension`) → chunk → **embed all, then delete old chunks, then upsert** (the data-integrity ordering carried over from P2a). `ingest_document_from_url` (single doc): validate URL → get metadata → size gate (pre-download) → fetch bytes → size re-check → `_store_document`; exceptions propagate (no swallow — it's one document). `ingest_folder_from_url(recursive=False)`: validate URL → list children → per file: size gate → fetch via download URL → size re-check → `_store_document`; **one file's failure is caught and recorded, never aborts the batch** (per-file isolation, matches the old P2a sync semantics), returns `{files: [{file, status: ingested|skipped_unchanged|failed, chunksStored, driveitemId, mimeType, sizeBytes, reason, relativePath}]}`. **Recursive mode** (commit `4c701f0`, opt-in via `recursive=True`): sequential depth-first descent into subfolders via `list_children_by_id`, capped at `MAX_FOLDER_DEPTH = 5` (a folder found at depth 5 is listed but not descended into — silent, documented limitation, re-run against that subfolder's own share link if needed); one subfolder's listing failure is caught and recorded as a single `failed` entry, never aborts sibling subtrees. Every file's `relativePath` (e.g. `"Sub/nested.docx"`) distinguishes same-named files across subfolders — equal to `file` at the top level.
  - Routes: `POST /kb/ingest-url` (single doc, body `{url, area_path, doc_type?}`) and `POST /kb/ingest-folder-url` (folder, same body shape **plus optional `recursive: bool` — default `false`**; ignored by `/kb/ingest-url`). Both `run_in_threadpool`, map `ValueError`→400, `GraphApiError`→its status (400/401/403/404 pass through) else 502.
  - **Token:** read from env `SHAREPOINT_TOKEN` (fallback `GRAPH_TOKEN`) in `config.py`, `graph_base_url` overridable. Optional-with-`None` so ingestion still boots tokenless; `GraphClient` raises at route-call time, not import.
- **orchestrator** (`src/modules/kb/`): `IngestedDocument` Prisma model (**replaced `KbSource`**) — non-secret metadata only (`areaPath`/`driveItemId`/`name`/`sizeBytes`/`mimeType?`/`docType?`/`ingestedAt`), unique on `[areaPath, driveItemId]` (re-ingest updates the same row; folder ingest upserts one row per non-failed file via `Promise.allSettled` — see §4a gap notes below; `name` stores the file's `relativePath` when recursive, so nested files show their subfolder in the ingested-doc list). `KbController` (`@Controller('kb')`): `POST /kb/ingest-url`, `POST /kb/ingest-folder-url` (now also reads `recursive` from the body), `GET /kb/documents?areaPath=`. Both ingest routes run a fast domain-boundary-anchored host allowlist pre-check (400 before forwarding) and re-map a downstream `IngestionHttpError` to `HttpException` with the same status. `IngestionHttpClient.ingestUrl`/`ingestFolderUrl` forward (reuse `LONG_RUNNING_AGENT`); `ingestFolderUrl` now takes a `recursive` param and maps `relative_path`/`relativePath`.
- **frontend**: `pages/KnowledgeBase.tsx` — URL / **"This is a folder" checkbox** (which reveals an **"Include subfolders" checkbox**, commit `4c701f0`) / areaPath / docType form + ingested-doc list, **no token field**. `api/kb.ts` (`ingestUrl`, `ingestFolderUrl` — now takes an optional `recursive` param, `listIngestedDocuments`).
- **infra**: Chroma persist path (`./.req2ado/vectors`) has a docker-compose volume mount (`req2ado_chroma`) — KB chunks + dedup vectors survive `docker compose up --build`. Ingestion `env_file: .env` carries `SHAREPOINT_TOKEN`/`GRAPH_TOKEN`.
- **Accepted link hosts:** `*.sharepoint.com`, `*.onedrive.com`, `*.sharepoint.us`, `onedrive.live.com`, `1drv.ms`.

**Security posture (deliberate, differs from ADO):** the SharePoint/Graph token is a **single shared server identity** read from env on ingestion — every ingest uses the same token/permissions, and the browser never handles it. This consciously overturns req2ado's per-request-credential rule *for SharePoint only* (the ADO PAT stays strictly per-request). Never persisted, never logged, never forwarded from the frontend. For folder children specifically, our bearer token is never even sent to the download/CDN host — Graph's own pre-signed URL carries its own short-lived auth.

**Reviews caught & fixed (all with regression tests):**
1. **Critical SSRF host-spoofing bypass** (single-doc connector, commit `8f22cec`) — the initial allowlist used a raw `endswith`, so `fakeonedrive.com` passed; fixed by anchoring at a domain-label boundary (`host === s || host.endsWith('.'+s)`), applied at **both** the ingestion and orchestrator allowlist layers.
2. **Important robustness gap** (`8f22cec`) — Graph network/timeout errors were uncaught → opaque 500; now wrapped as `GraphApiError(502)`.
3. **Important SSRF gap** (folder-crawl addition, commit `7647604`) — `fetch_child_content` followed redirects to a Graph-supplied download URL with **no SSRF guard**, unlike every other fetch in the connector; fixed with the new `validate_fetch_url`.

**Real-tenant happy path — verified, both modes.** Single-doc: ingested a real `.docx` (1.4MB) via a real `graph.microsoft.com` sharing link — parsed content confirmed in the KB Chroma collection (correct `source_id`/`doc_type`/`file_hash` metadata), `IngestedDocument` row persisted, re-ingest correctly returned `skippedUnchanged: true`. Also confirmed the 403 path against real Graph along the way (a token with only `openid profile User.Read email` scopes → genuine Graph `accessDenied` → cleanly surfaced as HTTP 403). **Scope note:** `Files.Read` (not `Files.Read.All`) was sufficient — the tenant didn't allow `.All`, and a delegated `Files.Read` token covers files the signed-in user can access via a sharing link, which is the only case this connector needs. Folder: ingested a real shared folder containing 2 PDFs, both via curl AND via an actual browser click-through of the "This is a folder" checkbox — both files' chunks landed in the KB collection, both `IngestedDocument` rows persisted, re-ingest correctly skip-unchanged for both.

**Also worth knowing:** `IngestedDocument` uniqueness is `[areaPath, driveItemId]` — a document is identified by its Graph driveItem id, so the same file re-shared under a new link (same driveItem) correctly updates in place; a genuinely different copy (different driveItem) is a distinct row.

**Known gaps in the folder-crawl addition — 3 of 4 fixed this round (commit `d02f779`):**
- ~~`KbService.ingestFolderUrl`'s DB-persistence step uses `Promise.all`, not `allSettled`~~ — **fixed**: now `allSettled`; a rejected Prisma upsert flips only that file's status to `failed` (reason: `KB store succeeded but database persistence failed: ...`) instead of throwing away the whole batch's already-committed results. Still unbounded (no concurrency cap) for very large folders — not addressed, low risk at current expected folder sizes.
- ~~A user checking "This is a folder" on a link to a single file returns a **502** rather than a clean 400~~ — **fixed**: `/kb/ingest-folder-url` now passes Graph's own 400 (non-folder driveItem) through as-is instead of folding it into the generic 502 bucket.
- ~~An empty folder reports `0 ingested, 0 skipped` as a *success* toast~~ — **fixed**: distinct `info`-severity toast ("Folder is empty — no files were found to ingest.") when the folder yields zero files.
- `driveitemId` (ingest-result types) vs `driveItemId` (Prisma column/persisted-summary type) — **still open**, cosmetic only. Consistently mapped end-to-end, just an odd casing mismatch to be aware of if extending this code.

Regression tests added for all three: `orchestrator/test/kb.service.spec.ts` (allSettled), `ingestion/tests/kb/test_ingest_folder_route.py` (400 passthrough, new file), `frontend/src/pages/KnowledgeBase.test.tsx` (empty-folder toast). Full suites green: orchestrator 159/159, frontend 61/61, ingestion 227/234 (7 pre-existing OCR/`pdf2image` failures on this machine — missing `poppler` binary, unrelated to KB).

**Recursive subfolder ingest (commit `4c701f0`):** opt-in via the "Include subfolders" checkbox / `recursive: true` on `/kb/ingest-folder-url`. Sequential depth-first, capped at `MAX_FOLDER_DEPTH = 5` — a folder found at depth 5 is not descended into (documented limitation, not a hard error). Traversal stays sequential/unbounded-breadth (no concurrency cap), same low-risk-at-current-sizes tradeoff as the non-recursive path. Regression tests: `ingestion/tests/kb/test_graph_client.py` (`list_children_by_id`, `drive_id` population), `ingestion/tests/kb/test_ingest_service.py` (2-level recursion, depth-cap enforcement, per-subtree failure isolation), `ingestion/tests/kb/test_ingest_folder_route.py` (`recursive` forwarded), `orchestrator/test/kb.service.spec.ts` + `kb.controller.spec.ts` + `ingestion-http.client.spec.ts` (`recursive`/`relativePath` threaded end-to-end), `frontend/src/pages/KnowledgeBase.test.tsx` (checkbox visibility + forwarding). Full suites green: orchestrator 162/162, frontend 62/62, ingestion 235/242 (same 7 pre-existing OCR/poppler failures, unrelated).

**Real-tenant verified.** Rebuilt/recreated the `ingestion`+`orchestrator` containers, then ingested the real `Custom Test Project CMMI\Test` KB root folder with `recursive: true`: a new PDF the user had just dropped into a real subfolder (`Sub Items/03_CMMI_Project_Engineering_Principles.pdf`) was descended into, chunked (2 chunks), and stored — confirmed both at the ingestion layer (direct curl, `chunks_stored: 2`) and end-to-end through the orchestrator (`GET /kb/documents` shows the row with `name: "Sub Items/03_CMMI_Project_Engineering_Principles.pdf"`, correct `driveItemId`/`sizeBytes`/`mimeType`). Sibling top-level docs correctly reported `skipped_unchanged`; a second recursive call correctly skip-unchanged'd the new file too.

## 4b. P2b — RAG retrieval-injection into SURVEY (current)

Wires the read side of the KB store into SURVEY mode's two whole-document LLM calls. `build_survey_tree` (`ingestion/app/leveling/llm_leveling.py`) now accepts optional `area_path`/`embed_client`/`vector_store` params; when all three are supplied it calls the new `retrieve_context()` (`ingestion/app/kb/retrieval.py`) exactly once per document — embeds the outline, queries `KbVectorStore.query()` (new method, `ingestion/app/kb/kb_vector_store.py`) for the area_path's KB collection, keeps hits at cosine similarity ≥ 0.3 (distance ≤ 0.7) out of top-5, and joins survivors into one context string. That same string is threaded into both `infer_hierarchy` and `generate_requirements_for_document` (`ingestion/app/survey/orchestrator_llm_client.py`), each prepending it to their system prompt as a labeled "reference material, may be irrelevant" block when present.

**Fully additive, fully optional.** Every new parameter defaults to `None`; when `area_path` is omitted (as every pre-KB caller does), retrieval is skipped entirely and behavior is byte-for-byte identical to before this phase. `POST /level` gained an optional `area_path` query param for this reason — omitted, it behaves exactly as before.

**Failure-safe by construction.** `retrieve_context` catches any exception from the embed call or the Chroma query and returns `None` (logged as a warning) — a KB outage never blocks or fails a SURVEY job, it just falls back to the model's baseline knowledge, identical to the empty-collection case.

**No doc_type filtering** — queries the whole area_path collection regardless of doc_type (which is sparse metadata to begin with, see §4a). **One retrieval per document**, not per node/block — matches the batching philosophy `generate_requirements_for_document` was already built around.

**Not yet done:** no chat feature exists to retrieve into (roadmap mentions it as a future target). P2c (RAG-grounded quality scoring) and P2d (learning-loop write-back) are separate, later phases.

## 4c. P2c — RAG-grounded quality scoring (current)

Every SURVEY-mode node now gets a 0-100 quality score and zero or more flagged issue labels, judged against org rules retrieved from the KB when available, falling back to EARS/INCOSE/ISO-29148 criteria baked into the prompt (the model's general knowledge of these public standards, not a second retrieval) when it isn't. A new batched whole-document call, `OrchestratorLlmClient.score_requirements_for_document` (`ingestion/app/survey/orchestrator_llm_client.py`), runs inside `build_survey_tree` (`ingestion/app/leveling/llm_leveling.py`) after the existing formalization loop, scoring every node's FINAL formalized description in one call. It reuses the SAME `kb_context` string already computed once per document by P2b's `retrieve_context` — zero new retrieval calls, one new LLM round-trip per document.

**Fully additive.** `build_survey_tree` gained a new optional `scoring_client` param defaulting to `None` — every pre-existing test call site needed zero changes. `POST /level`'s production caller (`app/main.py`) always supplies the real `OrchestratorLlmClient` instance as `scoring_client` (the same instance already used for `llm_client`/`requirement_client`).

**Tolerant per-node parsing.** A missing, malformed (non-int, out of 0-100 range), or wrongly-shaped (e.g. not even a dict) scoring entry for one node_id falls back to `quality_score=None`/`quality_issues=[]` for that node only — never crashes the batch or affects sibling nodes. `RequirementQualityIssue` (`ingestion/app/workitem/model.py`) is a closed 7-value enum (`ambiguous`, `not_testable`, `compound`, `missing_acceptance_criteria`, `vague_term`, `passive_voice`, `missing_rationale`); an issue string from the LLM outside this set is silently dropped, same tolerant philosophy as `RequirementTag` today.

**Data flow.** `WorkItemNode.quality_score`/`quality_issues` (ingestion) → `DryRunTreeNode`/`DryRunDiffEntry.qualityScore`/`qualityIssues` (orchestrator, `pipeline.worker.ts` + `dry-run.service.ts`) → `NodeDetailPanel` (frontend), which renders a `{score}/100` line plus a new `IssueChips` component (mirrors `TagChips`, own color mapping via `issueColors.ts`) — detail-panel-only, the `DiffTree` tree rows are unchanged.

**Not yet done:** P2d (learning-loop write-back of confirmed/accepted items into the KB). Editable/re-scoreable items from the review UI (Phase 3's per-item chat/refine work may eventually trigger re-scoring; not this phase). Org-authored custom scoring rubrics beyond what's already retrievable via the existing per-document `kb_context`.

## 4d. P3a — Editable dry-run diff (current, branch merged `dcae359`)

First of Phase 3's three sub-specs (editable diff, AI assist/chat, source provenance — see
`docs/superpowers/specs/2026-07-14-p3a-editable-dry-run-diff-design.md`). Lets a user exclude,
edit, or add diff entries before confirming a job — previously `POST /jobs/:id/confirm` took no
request body and re-read `job.dryRunDiff` as-is.

- **Exclude/reject unified into one `excluded: boolean` flag** on `DryRunDiffEntry` — no separate
  delete op. Cascades **transitively at read time**: `confirm()` walks `parentLocalId` ancestry and
  skips a node if it or any ancestor is excluded — never written to descendant rows, so there's no
  stale-cascade-flag risk from a partial recursive write.
- **Edit is create-only** — `reuse`/`dedup_skip` entries point at an existing ADO item, so editing
  their local copy would be a silent no-op on confirm; the endpoint 400s instead.
- **Manually-added entries** get `isManual: true`, `childType: null`, and a server-computed
  `sourceHash = sha256(description)` (matching `fidelity_hash`'s exact scheme) so idempotency/dedup
  keep working. They can't themselves be an Add target (`isManual` gates this — `childType === null`
  alone can't, since it's *also* true for every real SURVEY node, see below).
- **BASELINE vs SURVEY type validation differs** — BASELINE has a fixed ladder (`WorkItemNode` gains
  `child_type`, computed once in ingestion via `type_for_depth(profile, depth + 1)` and passed
  through untouched, same pattern as `tags`/`qualityScore`), so a manual Add must match
  `parentEntry.childType` exactly. SURVEY has no such ladder — the LLM assigns each node's type
  freely — so `childType` stays `null` for every SURVEY node and Add accepts any of
  `Epic`/`Feature`/`Requirement`.
- **Frontend**: `DiffTree` rows get an exclude/include checkbox (dims + strikes the row). Edit moved
  into `NodeDetailPanel` (an Edit button switches to editable title/description fields + Save/Cancel)
  rather than a tree-row icon. Add is a separate `AddChildForm` component below the panel — fixed,
  disabled type field for BASELINE, free dropdown for SURVEY.
- **Verified end-to-end** against a real docker-compose stack (`ADO_BACKEND=mock`), cross-checked at
  the mock ADO backend's own SQLite store, not just API responses: excluded subtree never written,
  manually-added node created and linked correctly, negative paths (409 post-confirm, 400 type
  mismatch, 400 nesting under a manual node) all matched spec.
- **One bug caught in final review, fixed**: `editDiffEntry` originally spread `{ title, description }`
  from the controller unconditionally, so a partial PATCH (title only) sent `description: undefined`
  through to the stored entry and silently wiped it via object-spread semantics. Fixed to only apply
  fields actually provided. Not reachable via the shipped UI (Save always sends both fields), but a
  real data-loss bug on the documented `{ title?, description? }` contract — worth knowing if a
  future caller (e.g. Phase 3's AI-assist chat) ever sends a genuinely partial patch.

## 4e. P3b — Per-item AI-assist chat (current, commits `b566ab9` → `4802fd0`)

Third of Phase 3's three sub-specs (see
`docs/superpowers/specs/2026-07-15-p3b-ai-assist-chat-design.md` and
`docs/superpowers/plans/2026-07-16-p3b-ai-assist-chat.md`). Lets a user free-form chat with an
LLM about a single `action: 'create'` diff entry, get a streamed, model-selectable reply plus an
optional structured title/description proposal, and Accept it into P3a's existing edit flow —
Accept just calls `PATCH /jobs/:id/diff/:localId` (`editDiffEntry`), no new mutation path for the
diff entry itself.

- **Architecture** — ingestion owns the LLM call and KB grounding (never calls Open
  WebUI/Ollama directly, same locked boundary as every other LLM call in this codebase); tokens
  are relayed to the browser via orchestrator, not called directly by ingestion:
  - **ingestion → orchestrator**: `ChatLlmClient` (`ingestion/app/chat/chat_client.py`) streams
    from the new `POST /llm/chat/stream` proxy on `LlmController` (ndjson, one
    `{"delta": "..."}\n` line per token) instead of buffering one full completion like the
    existing `/llm/chat`/`/llm/embed` calls.
  - **ingestion → Redis**: `run_chat_turn` (`ingestion/app/chat/chat_service.py`) drives one turn
    end-to-end — reuses P2b's `retrieve_context()` for KB grounding (best-effort, failure never
    aborts the turn), builds a system prompt capped at the last 10 history turns, streams the
    reply through a `_SentinelWindow` (buffers text so a `PROPOSAL_SENTINEL` marker is never
    split across two published chunks and nothing after it ever reaches the live token stream),
    and publishes to Redis via `RedisChatPublisher` (`ingestion/app/chat/redis_publisher.py`) —
    channel `chat:{job_id}:{local_id}`, `{"type": "chunk"|"done"|"error", ...}` payloads. Also
    polls a Redis key `chat:abort:{job_id}:{local_id}` (set by orchestrator's `stopTurn`, 30s TTL,
    cleared on read) between chunks to support "stop generating". Route:
    `POST /chat/{job_id}/{local_id}/turn`.
  - **orchestrator relay**: `ChatGateway` (`orchestrator/src/modules/chat/chat.gateway.ts`, plain
    `ws` via `@nestjs/platform-ws`'s `WsAdapter` — not socket.io, the frontend has no WS client
    library) holds one shared `ioredis` subscriber pattern-subscribed to `chat:*` and relays by
    channel to whichever sockets are in that channel's room. On a `done` event it persists a new
    `ChatMessage` row (`ChatService.persistAssistantTurn`); on `error` it persists nothing. A
    per-turn timeout (`startTurnTimeout`, 150s) force-emits a synthetic `error` if no terminal
    event ever arrives.
  - **frontend**: `ChatPanel` (`frontend/src/components/ChatPanel.tsx`) renders inside
    `NodeDetailPanel` (new `jobId` prop threaded from `JobDetail`), backed by `useChatSocket`
    (`frontend/src/hooks/useChatSocket.ts`, plain `WebSocket`) and `api/chat.ts`.
- **Sentinel-based proposal splitting** — not specified in the design doc's original sketch
  (only "reply includes conversational text AND a structured proposal"), implemented as the
  simplest robust way to carry both a live-streamable message and a structured proposal over one
  token stream: the model is prompted to end its reply with a literal `PROPOSAL_SENTINEL` line
  followed by a single-line JSON object, only when an actual rewrite was requested.
  `split_message_and_proposal` (`ingestion/app/chat/chat_client.py`) parses the full text after
  streaming ends; tolerant of a missing sentinel, malformed JSON, non-dict JSON, or non-string
  field values — all fall back to a safe default (message-only, no proposal) rather than raising.
- **Model selection** — switchable per turn via a dropdown, not locked for the conversation.
  `GET /chat/models` (and the underlying `GET /llm/models`) call `OpenWebUiClient.listModels()`
  (`this.openai.models.list()` against Open WebUI's OpenAI-compatible `/v1/models` — no new
  architecture boundary, same client `/llm/chat`/`/llm/embed` already use), unfiltered. `model` is
  now threaded through `POST /llm/chat`'s request body (optional, falls back to
  `LLM_CHAT_MODEL`) and forwarded end-to-end: frontend dropdown → `POST .../chat` body → ingestion
  payload → `ChatLlmClient.stream_reply(messages, model)` → `/llm/chat/stream`. Each assistant
  turn records which model produced it (`ChatMessage.model`) for history and any future P2d
  signal analysis.
- **Data model** — new `ChatMessage` Prisma model (`orchestrator/prisma/schema.prisma`):
  `{ id, jobId, localId, role: 'user'|'assistant', content, proposedTitle?, proposedDescription?,
  model?, createdAt }`, indexed on `[jobId, localId]`. A log, not a state machine — no `accepted`
  flag; acceptance is a normal `editDiffEntry` PATCH. History load is capped at 50 rows
  (`CHAT_HISTORY_LIMIT`); LLM-facing history per turn is capped at the last 10 turns.
- **Gating** — mirrors P3a's `editDiffEntry` restrictions: chat only allowed on
  `action: 'create'` entries with `excluded` falsy, and only while `job.status === 'diff_ready'`
  (`ChatService.sendTurn` 404s on unknown job/entry, 409s otherwise). `useChatSocket`'s `enabled`
  param (default `true`) skips opening a WebSocket entirely when the panel is disabled.
- **Verified live** against a real docker-compose stack + real local Ollama models (`gemma4:12b`,
  `llama3.2:1b`, `all-minilm`), driven end-to-end through the actual browser UI (not curl-only):
  real WS handshake (`101 Switching Protocols`), model dropdown populated from the live Ollama
  catalog, a streamed reply rendering token-by-token in the UI, a structured proposal
  (`gemma4:12b` reliably emits the sentinel+JSON; `llama3.2:1b` — 1B params — did not, falling
  back to message-only exactly as the tolerant parser is designed to), Accept via a real UI click
  landing in the diff tree, stop-generating mid-stream (turn aborted, no assistant row
  persisted), and disabled-gating on an excluded entry (zero WS/API calls fired at all).

**Two Critical bugs caught in Task 11's own review, fixed before merge:**
1. `ChatPanel` wasn't resetting its history/proposal/draft/model state when the selected
   diff-tree node changed — an unaccepted proposal drafted against node A could be silently
   applied to node B if the user switched nodes mid-draft. Fixed with a node-change reset effect.
2. The WebSocket connection was opened even when chat was disabled for
   `reuse`/`dedup_skip`/excluded entries — wasted a connection per non-chattable node. Fixed with
   the `enabled` param on `useChatSocket` (see Gating above).

**Three lifecycle bugs caught in a final whole-branch review (commit `5d17d5a`), after all 12
plan tasks were individually done — worth knowing for future work on this path:**
1. **Redis pool leak** — ingestion constructed a fresh `RedisChatPublisher` (and its underlying
   `redis.asyncio` connection pool, never `aclose()`d) on every `/chat/{job_id}/{local_id}/turn`
   request. Fixed by promoting it to a module-level singleton in `ingestion/app/main.py`,
   mirroring the existing `_embed_client`/`_kb_vector_store` pattern.
2. **Mismatched timeout windows** — orchestrator's `TURN_TIMEOUT_MS` (90s) fired *before*
   ingestion's own stream timeout (120s), so a legitimately slow reply got a spurious "timed out"
   error followed by a late real `done` event still being relayed and persisted on top of it.
   Fixed by raising the orchestrator timeout to 150s (strictly greater than ingestion's 120s) and
   adding a `timedOutChannels` guard on `ChatGateway` so any late done/error after a fired timeout
   is dropped instead of relayed/persisted; the marker resets when a fresh turn starts on the same
   channel.
3. **Stop-generating didn't stop the upstream LLM call** — it only broke ingestion's relay loop;
   orchestrator's `POST /llm/chat/stream` kept iterating `streamChat()` to completion regardless,
   so the actual Ollama/Open WebUI generation kept running and burning compute after nobody was
   reading tokens. Fixed by wiring `res.on('close', ...)` in `LlmController.chatStream` to a
   `clientDisconnected` flag checked after each write — stops writing/consuming further chunks as
   soon as the current await resolves (not an instant mid-network-call abort, but the best
   granularity available without deeper SDK abort-signal plumbing).

**A fourth Critical bug — found only by live E2E, invisible to every unit/integration test
(commit `4802fd0`):** `ChatGateway` was registered via `useFactory` in `chat.module.ts` (the same
pattern used elsewhere in this codebase to work around `import type`-erased constructor params —
see `IdempotencyService`/`JobEventsPublisher` in `jobs.module.ts`). That pattern is incompatible
with NestJS's WebSocket gateway auto-discovery: `SocketModule.connectGatewayToServer` reads
`wrapper.metatype` to find the `@WebSocketGateway()` metadata, and a factory provider's
`wrapper.metatype` is `null` — so the gateway was constructed (as a normal injectable) but never
actually connected to the WS server. Every unit test passed because `chat.gateway.spec.ts`
constructs `ChatGateway` directly with `new`, bypassing Nest's DI/discovery path entirely; the
bug only surfaced when a real WS handshake against the live orchestrator returned a plain HTTP
404 (Node's http server falls through to the normal request path when no `'upgrade'` listener is
attached). Fixed by registering `ChatGateway` as a plain class provider and injecting the shared
Redis subscriber via `@Inject('CHAT_REDIS_SUBSCRIBER')` on the constructor parameter instead.
Fixing this surfaced a second-order issue: six pre-existing e2e-spec files
(`auth.controller.e2e-spec.ts`, `health.e2e-spec.ts`, `jobs.controller.e2e-spec.ts`,
`llm.controller.e2e-spec.ts`, `security-headers.e2e-spec.ts`, `wiki.controller.e2e-spec.ts`) boot
the full `AppModule` via `@nestjs/testing` without calling `useWebSocketAdapter` (only `main.ts`'s
real bootstrap does) — once the gateway actually registers, `SocketModule` falls back to
autoloading `@nestjs/platform-socket.io` (not installed) and crashes. Fixed by adding the same
`app.useWebSocketAdapter(new WsAdapter(app))` call to each spec's bootstrap, mirroring `main.ts`.
**Lesson for future WS/gateway work in this codebase:** the `useFactory`-for-type-erasure pattern
is safe for ordinary providers but silently breaks NestJS's decorator-metadata-based discovery
(gateways, and likely anything else keyed off `wrapper.metatype`) — prefer `@Inject()` on a plain
class provider whenever the class itself carries framework-relevant class-level decorators.

**Not yet done — no accept/reject signal feeds P2d yet.** Accept still just calls the existing
P3a `editDiffEntry` PATCH; it doesn't write anything back to the KB or produce a learning
signal. P2d (learning-loop write-back) remains deferred per the roadmap — see §8.

## 4f. P3c — Source provenance display (current, commits `663b997` → `6583d68`)

Third of Phase 3's three sub-specs (see
`docs/superpowers/specs/2026-07-16-p3c-source-provenance-design.md` and
`docs/superpowers/plans/2026-07-16-p3c-source-provenance.md`). Shows, per SURVEY diff entry, which
KB documents (if any) grounded its content/quality score, plus the always-on EARS/INCOSE/ISO-29148
standards baseline P2c's scoring already judges against.

- **Job-level, not per-node.** `retrieve_context()` (`ingestion/app/kb/retrieval.py`) runs exactly
  once per document inside `build_survey_tree` and its result is reused, unchanged, across all
  three SURVEY LLM calls (hierarchy, generate, score) — so one job has exactly one KB-grounding
  state, shared by every node in its tree. Per-node/per-chunk attribution was explicitly out of
  scope; it would need retrieval to run per-node instead of once per document.
- **`retrieve_context()` now returns `(context, citations)`** instead of a bare context string —
  `citations` is the deduped, first-seen-order list of surviving hits' `source_file` names
  (`KbVectorStore.query()` already carried this metadata; it was previously discarded). Threaded
  through `build_survey_tree` onto `WorkItemTree.kb_citations: list[str]` (`ingestion/app/workitem/model.py`),
  which rides `/level`'s existing `response_model=WorkItemTree` serialization with zero extra
  production code — `ingestion/app/main.py` needed no changes at all.
- **Persisted on the `Job` row** — `Job.kbCitations String[] @default([])` (Prisma), written by
  `pipeline.worker.ts` in the same `diff_ready` update that stores `dryRunDiff`
  (`kbCitations: tree.kb_citations ?? []`). Exposed on `GET /jobs/:id` (§5).
- **Frontend**: a "Sources" section in `NodeDetailPanel`, gated on `jobMode === 'survey' && entry.action === 'create'`
  (mirrors P2c's `qualityScore` display gating). Always shows a static "Judged against EARS,
  INCOSE, ISO/IEC/IEEE 29148" line when the section renders (the standard is always active for
  scoring, independent of KB grounding); shows a "KB references: ..." line only when
  `kbCitations.length > 0`. Both `jobMode`/`kbCitations` are optional props, backward-compatible
  with every pre-existing `NodeDetailPanel` caller/test.

**Critical bug found and fixed during this round, not previously known:**
`IngestionHttpClient.level()` (orchestrator) never forwarded `area_path` to ingestion's `/level`
endpoint — the real pipeline (`pipeline.worker.ts` → `ingestionClient.level()`) has therefore
**never actually triggered KB retrieval in production** since P2b/P2c shipped; only direct-curl
testing against ingestion exercised that path (see §4b/§4c's "real-tenant verified" notes — those
verifications called ingestion directly, bypassing the orchestrator's own broken call site). Fixed
by adding an optional 4th `areaPath` param to `level()`, forwarded as `area_path` when present, and
wiring `job.areaPath` through from `pipeline.worker.ts`. `area_path` is harmless for BASELINE jobs
(`build_baseline_tree` never reads it) — the worker now passes it unconditionally rather than
mode-branching. **This means P2b/P2c's KB grounding is, as of this round, verified working in the
real pipeline for the first time** — previously "verified" claims in §4b/§4c were curl-only.

**Two plan gaps caught and fixed during implementation, not anticipated by the plan itself:**
1. `retrieve_context()` has a second production caller the plan missed —
   `ingestion/app/chat/chat_service.py`'s `run_chat_turn` (P3b's per-item chat feature also calls
   it for its own KB grounding). Fixed alongside the main signature change; currently untested
   directly (deferred, see below).
2. Making `pipeline.worker.ts` actually pass `job.areaPath` to `level()` broke two *pre-existing*
   `pipeline.worker.spec.ts` assertions that expected exactly 3 args — mechanical fix, verified
   against the tests' own fixtures (both already had non-empty `areaPath` values) to confirm it
   wasn't papering over a real behavior change.

**Verified**: all three test suites green post-merge — ingestion 301/307 (7 pre-existing
OCR/poppler failures, unrelated), orchestrator 213/213, frontend 94/94.

**Live-verified against a real docker-compose stack + real local Ollama** (a follow-up round,
closing the loose ends left above): `docker compose up -d --build`, then `ADO_BACKEND=mock` +
`gemma4:12b`/`all-minilm` (same local models P3b used). No real SharePoint/Graph tenant link was
on hand this round, so the KB collection was seeded directly (one chunk, embedded via Ollama's
`all-minilm` for a genuine cosine match, upserted into `KbVectorStore` inside the running
`ingestion` container) rather than through a real Graph ingest — P3c's own new code (retrieval →
citations → persistence → UI) is what needed proving, not the already-verified Graph connector
(§4a). Submitted a real SURVEY job (`docs/golden-e2e-survey-fixture.txt`) against that area path
through the real HTTP API (not curl-to-ingestion-only, unlike every prior "verified" claim in
§4b/§4c) — confirmed `GET /jobs/:id` returned `"kbCitations": ["spec.docx"]`, then opened the job
in a real browser (session-storage login bypass, same technique as §4's testing-infra note),
selected the `create` node, and confirmed the Sources section rendered exactly as designed:
"Judged against EARS, INCOSE, ISO/IEC/IEEE 29148" + "KB references: spec.docx". This is also the
first real-pipeline exercise of this round's `area_path`-forwarding bug fix — confirmed it
actually activates KB retrieval end-to-end, not just in unit tests.

**Also closed this round:**
- `chat_service.py`'s KB-grounded chat-turn branch now has a dedicated regression test
  (`test_run_chat_turn_grounds_system_prompt_with_kb_context_when_area_path_supplied`) — the
  exact class of caller that got missed once already during planning.
- The docstring run-on sentence in `llm_leveling.py`'s `build_survey_tree` is fixed.

**Still deferred, not blocking:**
- **P2d still unfed.** P3c only *displays* existing retrieval metadata; it produces no new
  accept/reject signal. P2d (learning-loop write-back) remains deferred — see §8.

## 5. Backend API surface (current)

All routes on the orchestrator (`http://localhost:3001` in dev):

- `POST /auth/login` — body `{ adoOrgUrl, pat }` → `{ displayName }`. Calls the **real** ADO org directly (no mock path — see §4).
- `POST /llm/chat` — body `{ messages, model?, temperature? }` → `{ content }`. **`model` added this round** (§4e) — optional, forwarded to `llmClient.chat()`, falls back to `LLM_CHAT_MODEL` when omitted. Bearer-guarded (`LlmProxyBearerGuard`), service-to-service only.
- `POST /llm/chat/stream` — same body shape as `/llm/chat`, new this round (§4e) → chunked `application/x-ndjson`, one `{"delta": "..."}` line per token. Bearer-guarded, service-to-service only — consumed by ingestion's `ChatLlmClient`, never called from the frontend. Aborts the underlying stream on downstream (ingestion) disconnect (§4e's stop-generating fix).
- `GET /chat/models` — new this round (§4e) → `{ models: string[] }` from `OpenWebUiClient.listModels()` (Open WebUI's `/v1/models`), unfiltered. Not bearer-guarded (`ChatController` has no `@UseGuards`) — called directly from the frontend's model dropdown.
- `POST /jobs/:id/diff/:localId/chat` — new this round (§4e). Body `{ message, model? }` → `{ status: 'started' }`. 404 unknown job/entry, 409 if not `action: 'create'`/excluded or `job.status !== 'diff_ready'`. Fire-and-forget — kicks off ingestion's turn and the WS relay, doesn't await the reply.
- `GET /jobs/:id/diff/:localId/chat` — new this round (§4e) → `{ messages: ChatMessageDto[] }`, capped at last 50 rows, oldest first.
- `POST /jobs/:id/diff/:localId/chat/stop` — new this round (§4e) → `{ status: 'stopping' }`. Sets a short-TTL Redis abort flag ingestion's `run_chat_turn` polls between chunks.
- `WS /chat?jobId=&localId=` — new this round (§4e), plain `ws` (not socket.io) via `ChatGateway`. Server→client only: relays `{"type":"chunk"|"done"|"error", ...}` events published by ingestion over the shared Redis `chat:*` subscription.
- `GET /jobs` → `{ id, mode, status, areaPath, itemCount, createdAt }[]`, newest first.
- `POST /jobs/preview` — multipart `file` → `{ blockCount, sectionCount, fileType }`. No LLM, no credentials required.
- `POST /jobs` — multipart form: `file`, `areaPath`, `customerId?`, `mode` (`baseline`|`survey`), `state?`, `iterationPath?` → `{ jobId }`.
- `GET /jobs/:id` → `{ id, status, mode, dryRunDiff, kbCitations }` — **`kbCitations` added this round** (§4f), `mode` added in an earlier round. `status` ∈ `pending | running | diff_ready | writing | succeeded | failed`. `kbCitations: string[]` is job-level (one list, shared by every node in `dryRunDiff`), always `[]` for BASELINE jobs.
- `GET /ado/area-paths?depth=5` — headers `X-Ado-Org-Url`/`X-Ado-Pat` → nested `{ path, children }` tree.
- `GET /jobs/:id/events` — SSE stream, `event: stage\ndata: {"stage":"..."}\n\n` frames.
- `POST /jobs/:id/confirm` — headers `X-Ado-Org-Url`, `X-Ado-Pat` → `{ status, createdCount }`.
- `PATCH /jobs/:id/diff/:localId` — body `{ title?, description? }` → `{ dryRunDiff }`. Create-only
  (400 on `reuse`/`dedup_skip`), 409 if `status !== 'diff_ready'`. See §4d.
- `PATCH /jobs/:id/diff/:localId/exclude` — body `{ excluded: boolean }` → `{ dryRunDiff }`. Any
  action type. See §4d.
- `POST /jobs/:id/diff` — body `{ parentLocalId, type, title, description }` → `{ dryRunDiff }`.
  Mode-aware type validation (BASELINE exact-match, SURVEY any of the 3 types), 400 on adding under
  a manually-added parent. See §4d.
- `GET /jobs/:id/audit` → array of `{ id, message, createdAt }`.
- `POST /kb/ingest-url` — body `{ url, areaPath, docType? }` → `{ documentName, driveitemId, mimeType, sizeBytes, chunksStored, skippedUnchanged }` (single document). No token in the request (server-side env). 400 on bad/lookalike host or SSRF URL; 401/403/404 passed through from Graph; 502 on Graph unreachable. *(The old `/kb/sources` + `/kb/sources/:id/sync` routes were removed in `8f22cec`.)*
- `POST /kb/ingest-folder-url` — body `{ url, areaPath, docType?, recursive? }` (`recursive` default `false`, commit `4c701f0`) → `{ files: [{ file, status: 'ingested'|'skipped_unchanged'|'failed', chunksStored, driveitemId, mimeType, sizeBytes, reason, relativePath }] }`. `relativePath` (e.g. `"Sub/nested.docx"`) distinguishes nested files when `recursive: true`; equals `file` at the top level. One file's (or one subfolder's, when recursive) failure never aborts the batch — see §4a for the `allSettled` persistence note and the depth-5 cap.
- `GET /kb/documents?areaPath=` → `IngestedDocument[]` (non-secret metadata; `areaPath` filter optional).
- `GET /wiki` → raw markdown string.
- `GET /health` → `{ ok: true }`.

**`DryRunDiffEntry` shape** (per node in `dryRunDiff`): `{ localId, parentLocalId, type, title, description, action: 'create'|'reuse'|'dedup_skip', existingAdoId: number | null, similarity, customerId, sourceHash, tags?: string[], qualityScore?: number | null, qualityIssues?: string[], childType?: string | null, excluded?: boolean, isManual?: boolean }`. `tags` is now optional (legacy pre-Phase-1 rows lack it — see §4). `action` values are lowercase. `childType`/`excluded`/`isManual` are P3a additions (§4d) — all optional, so pre-existing rows read back with them `undefined` (treated as not-excluded/not-manual).

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

## 7a. Prod infra — self-hosted Postgres/Valkey (in progress, not yet deployed)

Prod k8s (on-prem, k3s, 4-node cluster) has shared `devops-postgresql`/`redis` instances already running other apps (DocGen included), but the team decided against reusing them (flagged as outdated — Postgres 11/Debian 10-era, Redis pre-license-change) in favor of dedicated, current-version instances for req2ado.

- **Valkey over Redis** — Redis Inc.'s 2024 license change (RSALv2/SSPL from 7.4+) only restricts reselling Redis as a managed service, not self-hosting; free either way. Chose **Valkey** anyway (Linux Foundation fork of Redis 7.2.4, BSD-licensed, protocol-compatible, actively maintained, currently 8.x) to stay license-clean *and* current — `ioredis`/BullMQ need zero code changes, same wire protocol.
- **Custom-published images, not raw upstream** — pulling arbitrary Docker Hub images (even official ones under an unfamiliar path, or an unrelated third-party publisher like `itsthenetwork/*`) through this cluster's Artifactory-backed registry mirror is unreliable; some paths proxy cleanly, others hit a TLS handshake wall. `docgen-api-gate`'s existing `mongodb-initializer` pattern — a thin Dockerfile (`FROM mongo:latest` + config) built via GitHub Actions and published under the `elisradevops` Docker Hub org — was already proven to pull cleanly in this cluster, so the same pattern was replicated: `postgres-initializer/` (`FROM postgres:16-alpine`) and `valkey-initializer/` (`FROM valkey/valkey:8-alpine`), each with a `VERSION` file driving real semver tags (not the mongodb workflow's raw `$GITHUB_RUN_ID` counter), published via `.github/workflows/{postgres,valkey}-init-release.yml` to `elisradevops/req2ado-postgres` / `elisradevops/req2ado-valkey`.
- **First publish attempt still failed to pull** (TLS handshake *timeout*, distinct from the earlier handshake *rejection*) even though it was under the already-trusted `elisradevops` org and an official-tag pull (`postgres:15-alpine`) succeeded moments earlier from the same cluster — ruled out both "unproxied namespace" and "nothing new can be fetched live" as explanations. Root cause: Artifactory listed the freshly-published images as **OCI type**, not the same type as the working `docgen-mongodb`/official images — modern `docker/buildx` now defaults to attaching build provenance/SBOM attestations, which forces an OCI image *index* (multi-manifest, attestations included) that this cluster's Artifactory Docker remote-repo config can't cleanly proxy. Fixed by adding `provenance: false` / `sbom: false` to both `build-push-action` steps — republished as `1.0.1`, confirmed pulling cleanly in-cluster.
- **k8s manifests written, not yet applied** (`k8s/namespace.yaml`, `k8s/postgres.yaml`, `k8s/valkey.yaml`) — `req2ado` namespace, single-replica Postgres `StatefulSet` (`nfs-client` `StorageClass`, 5Gi PVC via `volumeClaimTemplates` — the cluster's only actually-used storage class; `local-path` was ruled out for a DB workload since its `Delete` reclaim policy + node-pinned hostPath volume are riskier than `nfs-client`'s `Retain` policy + node-independent NFS backing), Valkey `Deployment` (no PVC — queue/pub-sub state is transient, matches dev's volumeless `redis:7-alpine`). Both sized `250m/256Mi` (Postgres) / `100m/256Mi` (Valkey) requests, no limits (avoids OOM-killing under a legitimate load spike) — comfortable against confirmed node headroom (2 of 4 nodes have 60-70%+ free CPU/mem; the other 2 are tighter but not blocking). Credentials via `kubectl create secret` (never committed, never passed through chat) — deploy commands are documented in the PR/commit history, not repeated here since **deployment itself is deliberately the last phase**, on hold pending the rest of this infra decision being finalized.
- **req2ado now has its own GitHub repo** (`github.com/elisradevops/req2ado`, private) — didn't exist before this round; `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` secrets configured on it (reused from `docgen-api-gate`'s Docker Hub account) for the two publish workflows above.

## 8. What's next (per `docs/req2ado-roadmap.md`)

- **Phase 2, P2b — RAG-first retrieval-injection** — done (§4b). `infer_hierarchy` and `generate_requirements_for_document` are grounded by a per-document `kb_context` retrieved once from the KB, falling back to baseline model knowledge when no KB material exists. Retrieval into a future chat feature remains out of scope (no chat feature exists yet).
- **P2c — RAG-grounded quality scoring** — done (§4c). Every SURVEY node gets a 0-100 quality score + issue chips, reusing the same `kb_context` P2b computes — zero new retrieval calls.
- **P2d — learning loop** (write confirmed items back into the KB) — **deferred**, see `docs/req2ado-roadmap.md`'s P2d entry for the full rationale: the signal available today (P2c's own `quality_score`/`quality_issues`) is circular for deriving "learned rules" — a second LLM call grading the first LLM's grading mostly restates generic advice, not genuine org-specific learning. The real signal is a diff between an LLM-generated item and what a human actually edited it to, which needs Phase 3's per-item edit/accept/reject flow to exist first. Revisit P2d once Phase 3 ships.
- **Phase 3, P3a — Editable dry-run diff** — done (§4d). Exclude/edit/add before confirm, verified end-to-end. Also unblocks P2d (above) once P3b's AI-assist accept/reject produces real per-item edit-diffs to learn from.
- **P3b — AI assist/chat per item** — done (§4e). Per-item streamed chat with model selection, sentinel-based proposal splitting, and Accept via P3a's existing `editDiffEntry`. Two Critical bugs (cross-node proposal leak, WS opened while disabled) fixed in Task 11's own review; three lifecycle bugs (Redis pool leak, mismatched timeout windows, stop-generating not propagated upstream) fixed in a final whole-branch review (`5d17d5a`). **Still doesn't feed P2d** — Accept just calls `editDiffEntry`, no KB write-back yet (see P2d above).
- **P3c — Source provenance display** — done (§4f), live-verified against a real docker-compose stack + real local Ollama. "Sources" section in `NodeDetailPanel` shows job-level KB citations + the always-on standards baseline. Also fixed a Critical latent bug: the orchestrator never forwarded `area_path` to ingestion's `/level`, so P2b/P2c's KB retrieval had never actually fired in the real pipeline before this round — only curl-direct testing had exercised it; this round's live verification is the first real-pipeline proof it now works. **Still doesn't feed P2d** — P3c only displays existing retrieval metadata, produces no new accept/reject signal (see P2d above).
- **Phase 4 — Traceability** (Covers/CoveredBy/Affects link types, diff-vs-live-ADO, baselining) — next up.

The KB ingest happy path is verified against a real Graph token/tenant (§4a), and P2b's retrieval + P2c's scoring are both verified end-to-end against real ingested KB content (§4b, §4c) — the whole RAG-first knowledge layer (Phase 2) is feature-complete except for the deferred P2d. Phase 3 (P3a §4d, P3b §4e, P3c §4f) is now fully done, with P2d still unfed pending a real learning signal (needs a live human edit/accept/reject stream, which none of P3a/b/c produce on their own).

## 9. Testing conventions (established, keep using)

- **orchestrator**: Jest, `*.spec.ts`, hand-built plain-object mocks passed positionally to constructors — no NestJS `TestingModule` bootstrap. See `orchestrator/test/jobs.service.spec.ts`, `orchestrator/test/kb.service.spec.ts`.
- **mcp-ado-server**: Vitest, `*.test.ts`, real `McpServer` + `MockAdoBackend(':memory:')`.
- **frontend**: Vitest + `@testing-library/react`, `vi.mock('../api/...')` pattern. See `frontend/src/pages/KnowledgeBase.test.tsx` for the newest example (toast-on-error coverage for both fetch-in-effect and form-submit paths).
- **ingestion**: pytest, `.venv/bin/python -m pytest` (not bare `pytest`). See `ingestion/tests/kb/` (50 tests) — `test_url_security.py` (SSRF + content-sniff, incl. the lookalike-domain regression and `validate_fetch_url`'s private-IP/non-https rejection), `test_graph_client.py` (share-id, status/transport-error mapping, folder-children listing, the no-auth-header + SSRF-guard checks on `fetch_child_content`), `test_ingest_service.py` (size-before-download, SSRF-before-Graph, embed-before-delete ordering, per-file folder-crawl isolation).
- `npm run build` = `tsc -b && vite build` in `frontend/`.
