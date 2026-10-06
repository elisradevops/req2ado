# Requirements-to-ADO Ingestion Platform — Planning Deliverable

> **Post-Phase-7 update:** this document's Phase 0-7 planning content (below)
> describes `mcp-ado-server` speaking the MCP protocol over an HTTP
> Streamable transport, as originally designed and built. That transport was
> later replaced with a plain REST API (`POST /api/ado/:operation`,
> `mcp-ado-server/src/rest/router.ts`) once it became clear no LLM ever
> tool-calls it — every caller is deterministic orchestrator code
> (`orchestrator/src/modules/pipeline/mcp.client.ts`), so the MCP protocol
> was pure overhead with no corresponding benefit. The service name
> (`mcp-ado-server`), the `McpClient` class name, and every ADO operation's
> name/shape (`ado_create_work_item`, etc.) were kept as-is through that
> change to avoid a large, purely-cosmetic rename across both services — the
> "MCP" in these names is now historical, not a live protocol claim. The
> operation catalog itself lives in `mcp-ado-server/src/operations/registry.ts`,
> not in the individual "MCP tool" descriptions this document goes on to
> reference below.

## Context

**Why.** Customer requirements arrive as heterogeneous documents (signed contracts, informal surveys, deeply-nested engineering ICDs) in mixed formats (txt/md/docx/pdf/scanned-pdf/xlsx, with tables and figures). Today they are hand-entered into on-prem Azure DevOps / TFS as work items — slow, error-prone, non-traceable. This platform automates conversion into a hierarchical work-item tree (Epic → Feature → Requirement, with sub-levels) with full traceability (Customer ID + source ref + fidelity hash), in two operating modes:

- **BASELINE** (contract-signed): strict, verbatim, provably faithful (hash-verifiable), LLM disabled by default, deterministic.
- **SURVEY** (informal): generative — distills formal "shall"-style requirements with taxonomy tags.

**Outcome.** A **full GUI web platform** (DocGen visual language) where a user logs in with a PAT, uploads a document, picks mode, previews the inferred tree (dry-run), and writes idempotent parent/child-linked work items to on-prem ADO. Heavy work (parse/OCR/embed/LLM) runs on a **job queue + worker pool** for scale. ADO writes go through **our own custom MCP server** (HTTP Streamable). LLM calls go **server-side through a redaction proxy** to a config-driven Open WebUI URL. Fully documented in code, with an **in-app wiki/guidelines + tooltips/popovers**.

---

## Locked Decisions (planning Q&A)

| Area | Decision |
|---|---|
| Repo | Standalone repo **inside** `elisradevops/` workspace (own boundary, own deps). |
| Stack | **Hybrid: TypeScript + Python.** React/MUI GUI + Node/TS orchestrator & MCP server + Python ingestion/OCR/embeddings service. |
| MCP server | **Fresh, ours, from scratch.** Do NOT use `elisra-mcp-ado`. Reuse only generic ADO REST conventions (below). |
| MCP transport | **HTTP Streamable** (networked, multi-client, containerized). |
| ADO target | **On-prem TFS/ADO Server**: api-version `7.1` (fallback `7.1 → 7.0 → 5.1 → none`), self-signed TLS via CA-trust. |
| PAT entry | **Login screen** (DocGen / `ado-hierarchy-viewer` pattern). Header-passed, in-memory/session only, never persisted or logged. |
| LLM access | **Backend proxy, redact-first.** Open WebUI reached server-side by config URL; redaction runs before every egress call. |
| Scale | **Job queue + workers** (Redis + BullMQ; Python ingestion as horizontally-scaled compute service). |
| Leveling | **Auto-detect** default (heuristic in BASELINE = deterministic; LLM in SURVEY). |
| Ingestion | **All formats** in Phase 1 (txt/md/docx/pdf/scanned-OCR/xlsx/tables/figures). |
| GUI | DocGen visual language, built with the **frontend-design** skill; MUI + AntD patterns; design tokens. |
| Docs | Full TSDoc/docstrings + in-app **Wiki/Help page** (renders `docs/user-guide.md`) + **tooltips/popovers** on every non-trivial control. |
| Backend fw | **NestJS** (DI, guards, validation) for the scalable/secured goal. |
| Database | **Postgres + Prisma** (jobs, audit, idempotency map, users/roles). |
| App auth | **ADO PAT is the sole credential for both identity AND permissions — no app-level RBAC.** Login validates `{orgUrl, pat}` against the ADO Server's own `connectionData` endpoint — no external IdP (Azure AD requires an App Registration, unavailable in this deployment; kept in the codebase as an unused future option). Every authenticated user is just a `User` row keyed by ADO identity, with no role field — ADO's own permission system (whatever the PAT's account can do in ADO) is the sole access-control gate. **Resolved in Phase 9: the NestJS `RolesGuard`/`Role` enum scaffolding from Phase 0 was removed entirely** (confirmed dead code with zero runtime authorization effect — no route ever used `@Roles()`, and nothing ever read `.role` back off a decoded session JWT), rather than building it out further. |

**Generic ADO REST conventions reused as knowledge (ported into our MCP server):**
- PAT = HTTP Basic, empty username. On-prem TLS = CA-trust (not `rejectUnauthorized:false`).
- api-version fallback ladder `7.1 → 7.0 → 5.1 → none` (7.0 added after a real on-prem Server 2022.1 rejected 7.1 as preview-only).
- Retry/backoff on 429/5xx + network errors, exp backoff + jitter.
- Bounded concurrency + `workitemsbatch` chunk at **200**.
- Write = JSON-Patch: `POST/PATCH {org}/{project}/_apis/wit/workitems/${type}`, `Content-Type: application/json-patch+json`, body `[{op:'add', path:'/fields/<RefName>', value}]`; parent link via relation op `/relations/-` with `System.LinkTypes.Hierarchy-Reverse` (child→parent).
- Field ref names: `System.Title/Description/State/AreaPath`, `Microsoft.VSTS.CMMI.RequirementType`. Customer ID ref name is resolved via a verified candidate list, not hardcoded — see "Customer ID Field Resolution" below. Verify exact custom ref names at runtime via `GET workitemtypes/{type}/fields` — do not hardcode.

---

## 1a. Problem Restatement + Assumptions + Open Questions

**Restatement.** Ingest a document → normalize → infer a work-item hierarchy (context-dependent leveling, not blind depth mapping) → distill titles (≤256 chars) + descriptions → tag for traceability → dedup against already-ingested items (≥0.90) → write idempotent parent/child work items to on-prem ADO via our MCP server. Verbatim in BASELINE (provably faithful), formalized in SURVEY. All through a scalable, secured, fully-documented GUI platform.

**Assumptions.**
- On-prem ADO only. Dev off-network via a **mock ADO backend** (SQLite/JSON) behind the same MCP tool contract.
- LLM only via OpenAI-compatible Open WebUI endpoint; model names always from config; backend-proxied with redaction.
- BASELINE runs with LLM disabled and still produces a tree (deterministic parsers + heuristic auto-detect).
- A custom Customer ID field exists in target project under one of a known set of candidate ref names, resolved and verified at runtime (see "Customer ID Field Resolution" below) — not assumed to be `System.CustomerId`.
- Vector store local (Chroma) — no external cloud.
- Postgres for durable state (jobs, audit trail, idempotency mapping). Redis for queue + LLM/embed cache.

**Open questions:** numbered list at end.

---

## 1b. System Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Frontend — React 19 + Vite + MUI/AntD + MobX  (DocGen visual language)    │
│  Login(PAT) · Upload · Mode select · Dry-run tree preview · Run/Write ·    │
│  Job progress (SSE) · Results/audit · In-app Wiki/Help · Tooltips/Popovers │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ HTTPS  (X-Ado-PAT, X-Ado-Org-Url — in-memory only)
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Orchestrator API — Node/TS (Express/NestJS)                               │
│  · App login (ADO PAT identity, no app-level RBAC — see Locked Decisions) │
│  · Per-user ADO PAT handling (never persisted/logged)                      │
│  · REST + job submission + SSE progress stream                             │
│  · LLM Proxy:  redact → Open WebUI (config URL) → response                 │
│  · MCP HTTP client → our ADO MCP server                                    │
│  · Zod validation, rate-limit, structured logging (pino/winston)           │
│  · Prisma → Postgres (jobs, audit, idempotency map)                        │
└───┬──────────────────────┬───────────────────────┬───────────────────────┘
    │ enqueue (BullMQ)      │ MCP HTTP (Streamable) │ redacted HTTPS
    ▼                       ▼                        ▼
┌───────────────┐   ┌──────────────────────┐   ┌────────────────────┐
│ Redis + BullMQ│   │ ADO MCP Server (TS,  │   │ Open WebUI         │
│ queue + cache │   │ Streamable HTTP)     │   │ (OpenAI-compatible)│
└───┬───────────┘   │ Tools:               │   │ chat / embeddings  │
    │ TS workers    │  create_work_item    │   └────────────────────┘
    │ consume jobs  │  set_fields (any)    │
    ▼               │  link_parent_child   │   ┌────────────────────┐
┌───────────────┐   │  update_work_item    │──▶│ On-prem ADO / TFS  │
│ Python        │   │  discover_fields     │   │ (api 7.1, CA-trust)│
│ Ingestion svc │   │  query_ids (dedup)   │   └────────────────────┘
│ (FastAPI,     │   │  dry_run/preview     │        ▲ mock backend
│  scaled ×N)   │   └──────────────────────┘        │ (SQLite/JSON)
│  parse/OCR/   │                                   for off-network dev
│  tables/figs/ │   ┌────────────────────┐
│  embeddings   │──▶│ Chroma vector store│  (dedup ≥0.90, local)
└───────────────┘   └────────────────────┘
```

**Job flow:** Orchestrator creates a Job (Postgres) → enqueues to BullMQ → TS worker drives the pipeline, calling the Python ingestion service (HTTP) for parse/OCR/embed and the LLM proxy for SURVEY/auto-detect → builds `WorkItemTree` → dry-run preview back to UI (SSE) → on confirm, worker calls MCP tools to write + link items idempotently → audit trail persisted.

**Module boundaries (each package = one responsibility):**
- `frontend/` — GUI only (upload, preview, progress, results, wiki, tooltips).
- `orchestrator/` — API, auth, LLM redaction proxy, MCP client, job submission, Prisma/Postgres, BullMQ producer + TS workers (pipeline driver).
- `ingestion/` (Python/FastAPI) — loaders → CanonicalDoc; OCR; tables; figures; embeddings; leveling heuristics. Stateless and scalable ×N **only when `CHROMA_MODE=http`** points at a real, shared Chroma server (see `docker-compose.yml`'s `chroma` service) — the default `CHROMA_MODE=embedded` (a local `PersistentClient`) is single-instance-only, each replica would otherwise hold an independent, incomplete dedup corpus.
- `mcp-ado-server/` (TS) — MCP tools for ADO write/read; PAT auth; retry/batch/api-version; mock backend adapter.
- `shared/` — cross-package types (CanonicalDoc, WorkItemTree, DTOs) — TS types + Python pydantic mirror (or JSON Schema single-source).
- `deploy/` — docker-compose, nginx, env templates.
- `docs/` — repo wiki (architecture, runbook, API, prompts) feeding the in-app Help page.

### Live run view: events and REST contracts

Observation only: nothing here changes what a job produces. Source of truth for the payloads:
`shared/schemas/job-live.schema.json` (generated into `@req2ado/shared-ts`; mirrored by hand in
`frontend/src/api/liveTypes.ts`, with a test that fails on drift). Flags: see `runbook.md`.

Flow: **ingestion** parses, writes the document map, and while leveling publishes exact stage units and rate-limited
live frames to Redis (`LiveEmitter`, `StageCounter`); the **pipeline worker** turns units into one weighted,
never-decreasing percentage (`ProgressService`, one publisher per job); the **orchestrator SSE route** relays
them to the owner's browser; the **frontend** keeps them in a store of its own and renders the live view.

| Redis (per job id) | Written by | Holds | Lifetime |
|---|---|---|---|
| `job-events:{id}:map` | ingestion | document map: counts and outline, at most 5,000 items | 24 h |
| `:units` (channel), `:units-latest` (hash) | ingestion | exact units per stage (`parse`, `draft`, `improve`, `summarize`, `skeleton`, `map`, `write`, `score`, `link`) | 24 h |
| `:progress` (channel), `:progress-latest` | pipeline worker | the percentage and the step running | 24 h |
| `:live` (channel), `:live-latest` (hash by lane), `:live-seq`, `:live-done` (hash of finished refs) | ingestion | what each lane is on, finished items, comparisons | 2 h |

| Browser-facing | Contract |
|---|---|
| `GET /jobs/:id/events` (SSE) | existing `stage` and `narration`; with the flag also `progress`, `live`, `notice` (typed run notices, also replayed from `job-events:{id}:notices` and stored as phase `notice` job events) and `heartbeat` (every 15 s, with `idleSeconds` and what is in flight). On connect it replays the latest progress and the latest frame per lane. A slow client drops progress and "working on" style frames; it never drops a finished item, a comparison or a lane reset. |
| `GET /jobs/:id/run-map` | the map; 404 when the feature is off, not parsed yet, or not the caller's job |
| `GET /jobs/:id/run-done` | `{ refs: [...] }` of finished items, so a page opened mid-run can fill its outline; same access rules |

Every route is owner-scoped (404 for anyone else). Ids on the wire are the run's own node ids; the browser maps them
to headings through the document map and never shows an id.

Streaming the drafting calls: `POST /llm/chat/stream` accepts an optional `includeDone`; the stream then ends with
`{done, finishReason, model}`, and a missing terminal line means the answer may be cut off. See the decision record
"Stream the drafting calls; the stream is a view" in `design-decisions.md`.

---

## 1c. Canonical Intermediate Data Model

```
Document (raw file + metadata: path, format, sha256)
   │  ingestion (Python)
   ▼
CanonicalDoc
   ├─ blocks[]  Block{ id, kind, text, heading_level?, number_label?, source_ref, offsets }
   │            kind ∈ {heading, paragraph, list_item, table, figure, note, open_tbd}
   ├─ tables[]  Table{ id, rows:[[cell]], caption, source_ref }
   └─ figures[] Figure{ id, caption|None, source_ref }   → "[FIGURE: <caption/none>]"
   │  leveling (auto-detect: heuristic BASELINE / LLM SURVEY)
   ▼
WorkItemTree
   └─ nodes[]  WorkItemNode{
        local_id, type∈{Epic,Feature,Requirement}, parent_local_id,
        title(≤256; extracted BASELINE / distilled SURVEY),
        description(verbatim BASELINE / formalized SURVEY),
        customer_id, source_ref, fidelity_hash(sha256 over normalized source span),
        tags[](SURVEY taxonomy), mode∈{BASELINE,SURVEY}
      }
   │  MCP writer (idempotent)
   ▼
ADO items (System.Id from ADO; parent links via Hierarchy-Reverse)
```

Traceability: every node's `source_ref` → a `Block`/offset; `fidelity_hash` proves BASELINE description == source span (re-hash on re-run detects drift). Idempotency: Postgres map `(source_hash, customer_id, area_path) → System.Id` prevents duplicate writes on re-run.

---

## 1d. Phased Milestone Plan (Phase 0–8)

| Phase | Goal | Scope / IO | LLM | Risks | Definition of Done |
|---|---|---|---|---|---|
| **0** Foundations | Monorepo skeleton, docker-compose, config, Postgres+Prisma+Redis, CI, mock ADO backend, GUI shell, **app login + RBAC[^rbac-removed]** | config/env schema; `MockAdoBackend`; app login (users/roles) + per-user PAT capture (header, not persisted); DocGen-style app shell | None | Over-scaffolding | `docker-compose up` runs all services; tests green; app login + role guard works; PAT validates ADO conn via `connectionData`[^pat-validate-deferred]; mock backend creates+links |
| **1** Ingestion + redaction | **All** loaders → CanonicalDoc; redaction | file → CanonicalDoc (tables→grids, figures→placeholders, OCR fallback); redaction pass | Vision (opt) scanned/diagrams | OCR/docx/pdf edge cases | Golden CanonicalDoc per format; redaction strips part#/host/url/email/GUID; OCR path covered; runs as FastAPI service |
| **2** Hierarchy + auto-detect leveling | Numbering + heading-depth + profile auto-detect → WorkItemTree | CanonicalDoc → WorkItemTree; heuristic (BASELINE) / LLM (SURVEY) | Chat (SURVEY) via redaction proxy | Wrong level/profile | Golden trees both profiles; same-depth→different-type case; BASELINE deterministic w/ LLM off |
| **3** Distillation | Title strategies + 256-char guard; description assembly | node text → title+description | Chat (SURVEY only) | Truncation correctness | 255/256/257 + multibyte tests; BASELINE title = extracted substring; description verbatim |
| **4** BASELINE mode | Verbatim + fidelity hashing + Customer ID | WorkItemTree(BASELINE) w/ hashes+customer_id | Off by default | Hidden mutation | Fidelity test byte-for-byte; re-hash stable; TBD/OPEN preserved; deterministic |
| **5** SURVEY mode | Generative "shall" reqs + taxonomy tags | informal narrative → formal reqs + tags | Chat (temp 0) via proxy | Hallucination | Golden survey output; taxonomy tags applied; each req individually verifiable |
| **6** Dedup | Embeddings + ≥0.90 skip, Chroma, scoped by Area Path | new tree + corpus → skip decisions | Embeddings via configurable transport (Ollama-shaped default) | Threshold tuning | 0.89 keep / 0.91 skip tests; Area-Path scoping; local store only |
| **7** MCP server + write-back | Our ADO MCP server (HTTP Streamable): create/set-fields/link/update/dry-run; idempotent | WorkItemTree → ADO items via MCP | None | Dup writes; on-prem api-version | MCP tools unit+integration tested vs mock; dry-run diff; re-run zero dupes; parent links correct; 429 backoff; api-version fallback |
| **8** Scale, security, docs, validation | Job queue+workers hardening; security pass; full docs + in-app wiki/tooltips; E2E golden | synthetic corpus → full pipeline under load | As configured | Coverage/perf gaps | Load test (N concurrent jobs) stable; security checklist passed; TSDoc/docstrings complete; in-app Wiki + tooltips shipped; full golden E2E green |

[^pat-validate-deferred]: PAT-connection-validation (`connectionData` round-trip) is DEFERRED until the orchestrator's real `/connection/validate` route + MCP client integration lands in Phase 7 — tracked as a Phase 0 follow-up, not a Phase 0 blocker.

[^rbac-removed]: The RBAC guard/role scaffolding built in Phase 0 was REMOVED in Phase 9 — confirmed dead code with zero runtime authorization effect (no route ever used `@Roles()`, nothing ever read a decoded session JWT's `.role` field), per the "App auth" locked decision above: ADO's own permission system is the sole access-control gate, not app-level RBAC.

---

## 1e. Tech Stack + Justification

**Frontend** — React 19 + Vite + TypeScript, MUI + AntD (DocGen parity), MobX state, react-virtuoso for large trees, axios. Built with the **frontend-design** skill for DocGen visual language. In-app Wiki page + MUI `Tooltip`/`Popover` on controls.

**Orchestrator** — Node 22 + TypeScript, NestJS (or Express) — DI, validation, structured; BullMQ (jobs), Prisma + Postgres (durable state), pino logging, zod DTO validation, `@modelcontextprotocol/sdk` client (HTTP), OpenAI SDK (LLM proxy → Open WebUI base_url).

**Ingestion (Python 3.11 + FastAPI)** — `python-docx`, `pypdf`+`pdfplumber`, `pytesseract`+`pdf2image` (OCR) / vision model, `openpyxl`, `markdown-it-py`; `chromadb` (dedup); embeddings via a configurable transport (Ollama-shaped by default, since Open WebUI doesn't expose OpenAI-shaped embeddings — see section 2c). Scaled by uvicorn workers / replicas.

**MCP server (Node/TS)** — `@modelcontextprotocol/sdk` StreamableHTTP transport; `httpx`/axios ADO client (Basic auth, CA-trust TLS, retry, batch, api-version ladder); mock backend adapter.

**Infra** — Redis (queue + cache), Postgres (Prisma), Chroma; Docker Compose + nginx, mirroring DocGen deploy. Testing: vitest/jest (TS), pytest (Python), respx/nock (HTTP mocks), golden fixtures. Lint/type: eslint+tsc / ruff+mypy.

**Justification:** hybrid gives DocGen-parity GUI + workspace-native TS backend/MCP + Python's superior document/OCR/embedding libs; queue+workers meet the scale requirement; backend LLM proxy preserves the redaction guarantee; MCP HTTP isolates ADO writes behind an auditable, testable tool boundary.

---

## 1f. Test Strategy

- **Golden files** (synthetic only): per-format → CanonicalDoc / WorkItemTree / MCP patch payloads.
- **Fidelity (BASELINE):** description byte-for-byte == source span; hash stable; TBD/OPEN/figure placeholders preserved; no LLM mutation.
- **256-char:** 255/256/257, multibyte/emoji, newline strip, truncation guard.
- **Dedup-threshold:** near-dupes 0.89 keep / 0.91 skip; Area-Path scoping; deterministic embedding stub.
- **Hierarchy/leveling:** numbering (1 / 1.1 / .a), deep heading nesting, same-depth→different-type, both profiles, auto-detect.
- **MCP + idempotency:** tool contract tests vs mock backend; re-run → zero new items; dry-run diff accurate; parent links correct.
- **Redaction:** each pattern stripped before egress; trusted_local bypass honored.
- **Security:** PAT never logged/persisted (assert on logs); MCP bearer required; input validation rejects malformed uploads.
- **Scale/E2E:** N concurrent jobs through the queue complete without corruption; determinism run (BASELINE, LLM off) identical twice.
- **Golden files** (mock reference docs): `ingestion/tests/fixtures/build_mock_icd_docx.py` / `build_mock_tv_remote_docx.py` / `build_mock_flat_docx.py` generate real `.docx` files embodying the real ICD/TV-Remote/headingless conventions named in the original request (the real reference material itself lives in a production environment and cannot be brought into this repo — see "Leveling Resolution" below). `ingestion/tests/test_mock_reference_golden.py` proves leveling/fidelity against these, not just hand-built in-memory `Block` lists.

---

## 1g. Leveling Resolution — Context-Dependent Depth (Scope Confirmed Against Mock Reference Docs)

A Scope & Gap review of this project against the ORIGINAL request found that the "same heading depth resolves to a different work-item type in different branches" requirement (the "Title 2 dual-role" case) needed to be checked against something closer to a real document than a synthetic in-memory fixture. `ingestion/tests/test_mock_reference_golden.py` (built from `mock_tv_remote.docx`, a mock stand-in for the real TV-Receiver + Remote-Control worked example) confirms:

- **What IS solved (BASELINE, deterministic):** `detect_profile_for_branch` (`ingestion/app/leveling/autodetect.py`) auto-detects a leveling profile PER TOP-LEVEL BRANCH, not once globally — proven with two branches in the same document where the identical nominal depth-1 position resolves to `Epic` in one branch (5 levels deep → `tv_style`) and `Feature` in the other (2 levels deep → `icd_style`). This is branch-granularity dual-role resolution, and it is genuinely context-dependent (based on that branch's own structure), not a single document-wide setting.
- **What is NOT solved:** true intra-branch semantic dual-role — inferring differing intent from local CONTENT within a single branch at the same depth — is not attempted in BASELINE. `autodetect.py`'s own docstring is explicit that this is SURVEY/LLM territory. This is an accepted BASELINE limitation, not a gap to close deterministically: content-driven type inference without an LLM would require heuristics with no principled stopping point.
- **Fixed: the depth-3 ICD sub-requirement gap.** The heuristic was `max_depth <= 2` → `icd_style` / `max_depth >= 3` → `tv_style`, which meant a genuine ICD-style sub-requirement (a depth-3 node under a Feature/Requirement branch) flipped the WHOLE branch to `tv_style` (Epic/Epic/Feature) instead. The ceiling is now `max_depth <= 3` → `icd_style` / `max_depth >= 4` → `tv_style` (`ingestion/app/leveling/autodetect.py::detect_profile_for_branch`), distinguishing "one extra depth level past an otherwise-icd_style branch" (stops at 3) from "a genuinely deep tv_style branch" (the golden `mock_tv_remote.docx` reference reaches depth 5) — the exact fix this section previously flagged as a follow-up. `mock_icd.docx` now includes a real depth-3 "Ripple Sub-Requirement" node proving this (`test_mock_reference_golden.py::test_mock_icd_docx_each_top_heading_is_a_feature_everything_nested_is_a_requirement`).
  - **Known, accepted tradeoff (documented in `detect_profile_for_branch`'s own docstring):** a tv_style branch that stops exactly at depth 3 with no depth-4 child (e.g. `Epic/Epic/Feature`, no individual Requirement written under that Feature) will now misclassify as icd_style. This narrows the original gap rather than eliminating it outright — still cannot be fully resolved without checking against the real ICD document, which is unavailable in this repo.

---

## 2. Deliverable Structure

### 2a. Repository Skeleton (monorepo)

```
req2ado/
├─ package.json / pnpm-workspace.yaml      # TS workspace
├─ docker-compose.yml
├─ config.yaml  .env.template
├─ README.md
├─ docs/                                   # wiki source → in-app Help
│   ├─ architecture.md  runbook.md  api.md  prompts.md  security.md  user-guide.md
├─ frontend/
│   ├─ src/
│   │   ├─ App.tsx  main.tsx
│   │   ├─ pages/  Login  Upload  Preview  JobStatus  Results  Wiki  Settings
│   │   ├─ components/  TreePreview  UploadDropzone  ModeSelector  ProgressBar
│   │   │              InfoTooltip  HelpPopover  ...
│   │   ├─ api/  httpClient  authHeaders  jobsApi  sseClient
│   │   ├─ store/  (MobX)  connectionStore  jobStore  uiStore
│   │   ├─ theme/  tokens.ts  AppThemeProvider   # DocGen parity
│   │   └─ content/  wiki/*.md  tooltips.ts       # in-app help content
│   └─ ado-extension/                         # optional ADO embed (later)
├─ orchestrator/
│   ├─ src/
│   │   ├─ main.ts
│   │   ├─ modules/ auth(login, no RBAC)  users  jobs  llm-proxy  mcp-client  ingestion-client  audit
│   │   ├─ pipeline/  worker.ts  stages/*      # BullMQ worker drives pipeline
│   │   ├─ llm/  redactor.ts  openwebuiClient.ts
│   │   ├─ prisma/  schema.prisma  migrations/
│   │   ├─ config/  schema.ts  loader.ts
│   │   └─ common/  logger  validation(zod)  errors
│   └─ test/
├─ ingestion/                                # Python FastAPI
│   ├─ app/
│   │   ├─ main.py
│   │   ├─ loaders/ text docx pdf ocr xlsx tables figures
│   │   ├─ canonical/ model.py
│   │   ├─ leveling/ numbering headings autodetect profiles
│   │   ├─ distillation/ title description
│   │   ├─ modes/ baseline survey
│   │   ├─ dedup/ embeddings store(chroma)
│   │   ├─ redaction/ redactor.py
│   │   └─ audit/ hashing.py
│   └─ tests/  fixtures/ (synthetic) + golden
├─ mcp-ado-server/                           # our MCP server (TS)
│   ├─ src/
│   │   ├─ index.ts  server.ts (StreamableHTTP)
│   │   ├─ tools/ create_work_item  set_fields  link_parent_child
│   │   │         update_work_item  discover_fields  query_ids  dry_run
│   │   ├─ ado/  client.ts (Basic auth, CA-trust, retry, batch, apiVersionLadder)
│   │   ├─ backends/ realAdo.ts  mockAdo.ts (SQLite/JSON)
│   │   ├─ auth/ patAuth.ts  redact.ts
│   │   └─ config/ env.ts
│   └─ test/
└─ shared/  types (TS)  + json-schema (single source) → pydantic mirror
```

### 2b. Config Schema

**config.yaml (no secrets):**
```yaml
mode: baseline                 # baseline | survey
llm:
  provider: openai_compatible
  base_url: ${LLM_BASE_URL}    # Open WebUI endpoint (backend-proxied)
  api_key:  ${LLM_API_KEY}
  chat_model:   ${LLM_CHAT_MODEL}
  embed_model:  ${LLM_EMBED_MODEL}
  vision_model: ${LLM_VISION_MODEL}   # optional
  temperature: 0
  trusted_local: false         # true → relax redaction egress guard
  enabled_in_baseline: false   # LLM off in baseline unless explicitly true (extraction only)
ado:
  base_url: ${ADO_BASE_URL}    # on-prem, https
  project:  ${ADO_PROJECT}
  area_path: ${ADO_AREA_PATH}
  api_version: "7.1"           # ladder 7.1 -> 7.0 -> 5.1 -> none
  ca_cert_path: ${ADO_CA_CERT} # self-signed CA trust (NODE_EXTRA_CA_CERTS)
  bypass_rules: false
  batch_size: 200
  concurrency: 8
  dry_run: true                # default safe
  backend: real                # real | mock
mcp:
  url: ${MCP_URL}              # our MCP server (Streamable HTTP)
  bearer: ${MCP_BEARER}
fields:
  title: System.Title
  description: System.Description
  state: System.State
  state_value: Proposed
  area_path: System.AreaPath
  customer_id: null                    # unset = auto-resolve via candidate list (Custom.CustomerId, Custom.CustomerRequirementId, Custom.CustomerID), verified at runtime; set explicitly to override
  requirement_type: Microsoft.VSTS.CMMI.RequirementType
  parent_link: System.LinkTypes.Hierarchy-Reverse
leveling:
  profile: auto                # auto | tv_style | icd_style | custom
  auto_baseline_strategy: heuristic   # heuristic (deterministic) | llm (opt-in)
dedup:
  store: chroma
  path: ./.req2ado/vectors
  threshold: 0.90
  scope_by_area_path: true
queue:
  redis_url: ${REDIS_URL}
  concurrency: 4
db:
  url: ${DATABASE_URL}         # Postgres (Prisma)
redaction:
  patterns: [part_number, hostname, url, email, guid]
audit:
  log_path: ./.req2ado/audit.jsonl
```

**.env.template:**
```
# LLM (Open WebUI)
LLM_BASE_URL=  LLM_API_KEY=  LLM_CHAT_MODEL=  LLM_EMBED_MODEL=  LLM_VISION_MODEL=
# ADO on-prem
ADO_BASE_URL=  ADO_PROJECT=  ADO_AREA_PATH=  ADO_CA_CERT=
# PAT is NOT here — entered at login screen, in-memory only
# MCP
MCP_URL=  MCP_BEARER=
# Infra
REDIS_URL=  DATABASE_URL=
```

### 2c. Provider-Agnostic LLM Client Interface (orchestrator)

```ts
// orchestrator/src/llm/openwebuiClient.ts
export interface LlmClient {
  chat(messages: ChatMessage[], opts?: { model?: string; temperature?: number; responseFormat?: object }): Promise<string>;
  embed(texts: string[], opts?: { model?: string }): Promise<number[][]>;
  vision(prompt: string, images: Buffer[], opts?: { model?: string }): Promise<string>;
}
// Models always from config (never hardcoded). base_url = Open WebUI.
// Embeddings use a SEPARATE transport from chat: Open WebUI does not expose
// an OpenAI-shaped /embeddings endpoint (confirmed via research) — only an
// Ollama-shaped /ollama/api/embed proxy exists. EMBED_TRANSPORT ('ollama' |
// 'openai', default 'ollama') and EMBED_BASE_URL select the real backend;
// this public embed() signature is unchanged, only the internal transport
// adapter differs. Not implemented yet — Phase 6 (dedup) is unbuilt.
// Every method wrapped by redactor.ts unless cfg.trusted_local.
```

### 2d. Runtime Prompts (`orchestrator/src/llm/prompts/` + `docs/prompts.md`)

- **Hierarchy inference / profile auto-detect (SURVEY):** outline + profile rules → strict JSON `{node_id,type,parent_id}[]`; honor "same depth → different type per branch"; never invent nodes; temp 0.
- **Title distillation (SURVEY):** item text + 256 limit → single-line title (first sentence if descriptive, else concise summary/paraphrase); enforce ≤256.
- **Survey requirement generation:** informal block → formal "shall" requirement(s) + taxonomy tags (functional/non-functional/interface/performance/regulatory/safety/security/operation/maintenance/feature/behavior); each individually verifiable.
- **(Optional) Vision extraction:** scanned page/diagram → text + `[FIGURE: <caption>]`.
- BASELINE policy: no generative prompt runs; if `enabled_in_baseline`, only an *extraction* prompt returning a source substring (hash-guarded).

### 2e. Custom MCP Server — Tool Contract (`mcp-ado-server/`)

| Tool | Purpose |
|---|---|
| `ado_discover_fields` | `GET workitemtypes/{type}/fields` — verify ref names before writing. |
| `ado_query_ids` | WIQL query for dedup / idempotency lookup, scoped by Area Path. |
| `ado_preview_write` | Dry-run: return the JSON-Patch payloads + planned links, no write. |
| `ado_create_work_item` | Create Epic/Feature/Requirement (JSON-Patch, State=Proposed). |
| `ado_set_fields` | Set arbitrary fields (Title/Description/AreaPath/CustomerId/RequirementType/…). |
| `ado_link_parent_child` | Add relation `System.LinkTypes.Hierarchy-Reverse` (child→parent). |
| `ado_update_work_item` | Update-by-id (idempotent re-run reconciliation). |

Transport Streamable HTTP + bearer. Backend swappable: `realAdo` (on-prem REST) / `mockAdo` (SQLite/JSON). Shared client: Basic PAT auth, CA-trust TLS, retry/backoff, batch@200, api-version ladder.

> Note: `ado_ping` (the only tool actually built in Phase 0) is a liveness/health check, not part of the pipeline contract above.

### 2f. Security & Docs (cross-cutting, hardened in Phase 8)

- **Secrets:** PAT in-memory/session only, header-passed, never persisted/logged (log-assertion test). LLM/ADO/MCP secrets via env. Redaction before every LLM egress.
- **Transport:** HTTPS; MCP bearer; on-prem CA-trust (no TLS disable). Zod input validation on all routes. Rate limiting. Upload size/type limits + malware-safe parsing.
- **Docs:** TSDoc on all exported TS APIs, docstrings on Python; `docs/` wiki (architecture/runbook/api/prompts/security/user-guide); **in-app Wiki page** renders the user-guide; **tooltips/popovers** on every non-trivial control (`content/tooltips.ts`).

---

## Verification (end-to-end)

1. `docker-compose up` → all services healthy (frontend, orchestrator, mcp, ingestion, redis, postgres, chroma).
2. `pnpm test` + `pytest` → full golden suite green.
3. GUI: log in with PAT → upload synthetic fixture → BASELINE dry-run → tree preview matches golden → confirm → items+links created in **mock** backend → re-run → zero dupes (idempotency).
4. BASELINE determinism: run twice, LLM off → identical output + stable fidelity hashes.
5. SURVEY: informal fixture → "shall" reqs + taxonomy tags via redaction proxy (assert redaction ran).
6. Dedup: follow-up fixture → ≥0.90 skipped, <0.90 kept (Area-Path scoped).
7. Scale: enqueue N concurrent jobs → all complete without corruption; progress streamed to UI.
8. Real ADO (gated): `dry_run: true` first vs scratch project → verify parent links + Customer ID + State=Proposed.
9. Security: grep logs → no PAT/secret; MCP rejects missing bearer; malformed upload → 400.

---

## Resolved Decisions (Q&A round 2)

- Orchestrator = **NestJS**. DB = **Postgres + Prisma**. App auth = **login only, no app-level RBAC (superseded — see Phase 9)**. Docs = **in-app Wiki page (user-guide) + tooltips/popovers**.

## Customer ID Field Resolution

**Why this needs a design, not a hardcoded name.** DocGen (the sibling app in this workspace, same org/ADO instance) was investigated for its Customer ID handling to reuse — it turned out to have **no single canonical mechanism**: four independently-hardcoded strategies across different code paths (`docgen-data-provider-package/src/modules/TicketsDataProvider.ts:191` reads a literal `wi.fields['System.CustomerId']`; a WIQL-column display-name match on `'CustomerRequirementId'` relabels whatever field is actually named `Custom.CustomerRequirementId`; an open substring scan `key.toLowerCase().includes('customer')` picks the first match non-deterministically; a stricter MEWP-only allow-list matches normalized keys `customerid`/`customcustomerid`, corresponding to real ref name `Custom.CustomerID`). **None of DocGen's strategies verify the field exists via ADO's Fields API before use** — they just probe `wi.fields` and silently omit the value if absent.

req2ado's own commitment (see "Field ref names" above: "Verify exact custom ref names at runtime via `GET workitemtypes/{type}/fields` — do not hardcode") is stricter than anything DocGen does, so the field is NOT simply hardcoded to `System.CustomerId` (which is likely wrong or vestigial anyway — `System.*` is ADO's reserved namespace for built-in fields, not custom ones; DocGen's own real, working custom fields are all under `Custom.*`).

**Resolution algorithm (used by the MCP server's `ado_discover_fields` tool, `mcp-ado-server/`):**
1. Call `GET {org}/{project}/_apis/wit/workitemtypes/{type}/fields` for the target work-item type.
2. Check `config.yaml`'s `fields.customer_id` value first — if the operator has explicitly configured a ref name, use it and verify it appears in the fields response (fail loudly if it doesn't, rather than silently falling through). **Not yet wired** — Phase 9's `JobsService.resolveCustomerIdField` implements steps 1/3/4/5 (runtime candidate-list resolution against `ado_discover_fields`) but this explicit-override step requires a `fields.customer_id`-equivalent config surface that doesn't exist yet in `orchestrator`'s config schema. Tracked as a follow-up, not silently dropped.
3. If unset/left at default, check candidates in this priority order against the fields response, reusing DocGen's real-world discovered naming conventions as candidates (not blindly trusting them — each is verified to actually exist before use):
   - `Custom.CustomerId`
   - `Custom.CustomerRequirementId`
   - `Custom.CustomerID`
4. Use the first candidate confirmed present. If none match, `customer_id` is left `null` on written work items (not a hard failure) — Customer ID is traceability metadata, not a required field for a valid ADO write.
5. Cache the resolved ref name per (org, project, work-item-type) for the duration of a run — don't re-call the Fields API per work item.

This keeps the "verify at runtime, don't hardcode" architecture commitment while reusing DocGen's field-naming conventions as a starting candidate list rather than as unverified truth.

## SE Coverage Reference Field Resolution (WID NEW-02: hook only, not data)

The customer's spec asks that generated requirements form "a basis for coverage by the
Systems-Engineering requirements layer" — but no deployed org's ADO setup has a concrete
SE-layer artifact to link to today, and this feature deliberately does NOT invent one. It
adds only a mechanism to hold a future manual reference, mirroring Customer ID's own field-
resolution shape exactly:

- `WorkItemNode.se_coverage_ref` (ingestion) — always `null` out of ingestion, never
  auto-populated under any circumstance (unlike `customer_id`, which extraction can populate
  from the document). Requirement-only, same type gate.
- `JobsService.resolveSeCoverageRefField` (orchestrator) — same runtime-verified
  candidate-list resolution as Customer ID, via `SE_COVERAGE_REF_FIELD_CANDIDATES`
  (comma-separated env override, see `.env.template`).
- **Candidate list is empty by default** — deliberately, since (unlike Customer ID's
  DocGen-sourced candidate list) there is no real-world evidence for what this field would
  even be named on any org. Shipping a guessed name risks silently writing to the wrong
  field on an org that happens to have something similarly named. Until an operator
  configures a real candidate, the field stays reviewer-visible/editable in the diff (via
  `editDiffEntry`) but is never written to ADO — the value sits in req2ado's own database
  only.
- No `System.Tags` fallback, ever, for this field — same "resolve a real field or drop it"
  rule Customer ID/source-ref both follow.
- Explicitly out of scope: no matching logic against any real SE-layer artifact, no new
  work-item type, no ADO relation. This is a place to type a future reference by hand,
  nothing more.

## Remaining Minor Questions (safe defaults chosen; confirm at Phase 0 or override)

1. **App login mechanism:** RESOLVED — ADO PAT validated against the ADO Server's own `connectionData` endpoint (see "Locked Decisions" above). Azure AD remains available as a backend config option (`AUTH_PROVIDER=azure_ad`) for deployments that can register an app, but is not the default and is not surfaced in the current login UI.
2. **Roles set:** RESOLVED — no app-level roles at all. Phase 0 built an `Admin/Operator/Viewer` `RolesGuard` scaffold as a hedge; Phase 9 removed it after confirming it had zero runtime authorization effect. ADO's own permission system (whatever the PAT's account can do in ADO) is the sole access-control gate.
3. **Customer ID field:** RESOLVED — see "Customer ID Field Resolution" below. Runtime-verified candidate list, not a single hardcoded ref name.
4. **Shared types single-source:** JSON Schema → generate TS + pydantic. Default: **JSON Schema single-source**.
5. **Vision/OCR:** local Tesseract default + optional Open WebUI vision model (config switch). OK?
