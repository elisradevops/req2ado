# req2ado — Phase 1 Spec: Frontend Rebuild + Cheap ADO Wins

**Purpose of this doc:** self-contained execution spec for Phase 1, so it can be built from this
file alone. Background: `req2ado-roadmap.md` (product context, why Phase 1 comes first).
Rationale for each design call: `design-decisions.md`. Backend facts referenced below:
`backend-capabilities.md`. ADO/SharePoint auth pattern referenced below: `docgen-connection-pattern.md`.

## Scope

Rebuild the frontend (`frontend/`, greenfield) and add 6 small, bounded backend capabilities. Ships
the rebuild backbone over the **existing, ungrounded** SURVEY pipeline — RAG-first grounding is
Phase 2, not Phase 1.

## Design decisions in effect (see `design-decisions.md` for rationale)

- Visual: Deep Indigo Enterprise palette, MUI 6.
- Shell: collapsible dark sidebar rail + breadcrumb/org/avatar top bar; Login is a separate
  full-screen page.
- Job Detail: split view (tree left, node detail right), SSE progress banner, Confirm gated on
  `diff_ready`, Audit as a 2nd tab.
- Jobs list: landing page, mode badge + status chip + item count + area path + relative time,
  live elapsed on running rows, empty-state CTA.
- New Job: two-step wizard (Step 1 upload+parse, Step 2 review+configure with real ETA).
- Area path: real ADO tree/autocomplete picker, not free text.
- Long-job UX: backend SSE coarse-stage progress + elapsed timer + "~40 min" messaging.
- Stack: react-router-dom + Zustand, greenfield rebuild in `frontend/`, runtime `/config.json`.
- PAT: sessionStorage, Zustand `authStore`.
- ADO connectivity: standalone-first, extension-ready — mirrors DocGen's stateless per-request
  header pattern + edge token-normalization (see `docgen-connection-pattern.md`).

## Backend additions

All six are additive — no removal of existing routes/behavior.

### 1. `GET /jobs` — list route

- Orchestrator. Add a `list()` method to `jobs.service.ts` alongside the existing `confirm`/
  lookup-by-id methods. Query recent `Job` rows from Postgres, project
  `{id, mode, status, areaPath, itemCount, createdAt}`. `itemCount` = length of the stored
  `dryRunDiff` array (or track a count column if convenient).
- Route in `jobs.controller.ts` alongside the existing job routes.
- Consumed by the new `JobsList` page.

### 2. `POST /jobs/preview` — pre-parse route

- Orchestrator. Accept the uploaded file (same multipart shape as `POST /jobs`). Call ingestion's
  existing `POST /ingest` (`ingestion/app/main.py:49` — parses to `CanonicalDoc`, **no LLM
  involved**). Return `{ blockCount, sectionCount, fileType }`.
- Add a thin wrapper method to `orchestrator/src/modules/pipeline/ingestion-http.client.ts`
  (today it only wraps `level`/`checkDuplicate`/`upsertDedupEntry` — add an `ingest`/`preview`
  method following the same pattern).
- Frontend computes ETA client-side as a function of `(blockCount, mode)` — no backend timing
  logic needed; keep this a simple, tunable formula in one place (e.g. a constant per mode ×
  blockCount, clamped to the documented 15-40 min range for SURVEY).
- No credentials required for this route (matches `POST /jobs`, which also needs none).

### 3. Area-path read (the largest of the six — spans 3 packages)

- **`mcp-ado-server`**:
  - Add `readAreaPaths(project: string, depth: number)` to the `AdoBackend` interface
    (`mcp-ado-server/src/backends/types.ts:20`), following the existing method signatures'
    conventions (`getWorkItem`, `queryIds`, etc.).
  - Implement in the **mock** backend (return a small fixed tree, matching how `mockAdo.ts`
    fakes `discoverFields`) and the **real** backend (`realAdo.ts` →
    `GET {orgUrl}/{project}/_apis/wit/classificationnodes/areas?$depth={depth}`, parse the nested
    JSON tree into a flat or nested `{path, children}` shape).
  - Register a new MCP tool alongside the existing ones in `mcp-ado-server/src/server.ts:78`
    (same pattern as `discoverFieldsTool.ts`).
- **Orchestrator**:
  - New read route, e.g. `GET /ado/area-paths?project=...`, forwarding through the existing
    `McpClient` (`orchestrator/src/modules/pipeline/mcp.client.ts`).
  - **New wiring needed**: today `X-Ado-Org-Url`/`X-Ado-Pat` headers are read only on the confirm
    controller method (`jobs.controller.ts:92-100`). This new route needs the same header-reading
    logic — factor it into a small shared helper if it's not already, rather than duplicating the
    header-extraction code inline.
- **Frontend**: `AreaPathPicker` component — tree/autocomplete, calls the new route with the
  current session's org URL + PAT headers (per the DocGen-mirrored per-request pattern), used in
  the New Job wizard's Step 2.

### 4. SSE progress — `GET /jobs/:id/events`

- Orchestrator. New SSE route on `jobs.controller.ts`. The pipeline worker
  (`orchestrator/src/modules/pipeline/pipeline.worker.ts`) emits coarse stage events at these
  points: `parse` (ingestion `/ingest` call) → `infer_hierarchy` start/done → `generate_requirements`
  start/done → `diff_ready`. Exact mechanism: an in-process event emitter the SSE route subscribes
  to per job id (BullMQ is already in use for the job queue — check whether its event hooks or a
  simple EventEmitter keyed by job id is the lower-friction fit before building a new pub/sub
  layer).
- Frontend: `api/events.ts` wraps `EventSource`; `ProgressBanner` component renders the current
  stage + an `ElapsedTimer` + static "can take up to ~40 min" copy for SURVEY jobs.
- No true percentage — the two LLM calls send the whole document in one shot (confirmed in
  `backend-capabilities.md`); stages are the only granularity available without chunking, which is
  out of scope for this phase.

### 5. Write taxonomy tags to ADO

- Ingestion already computes `WorkItemNode.tags` (11 categories,
  `ingestion/app/workitem/model.py:21-44`) but they're dropped before reaching the diff. Carry
  `tags: string[]` through:
  - `DryRunTreeNode` / `DryRunDiffEntry` types in
    `orchestrator/src/modules/pipeline/dry-run.service.ts:4-37`.
  - The mapping in `pipeline.worker.ts:48-57` that currently omits tags.
- In `jobs.service.ts:137-154` (the work-item-build step), join tags with `;` and set
  `System.Tags` using the existing `setFields`/field-write path (same mechanism already used for
  Title/Description/State/AreaPath — this is additive, not a new write path).
- Frontend: render tags as chips in the `DiffTree` rows and the `NodeDetailPanel`, using a shared
  `TagChips` component with a tag→color mapping util (keep the mapping in one place, not inlined
  per component, per the project's DRY-helpers convention).

### 6. Configurable State / Iteration

- `System.State` is hardcoded `'Proposed'` (`jobs.service.ts:140`); `System.IterationPath` is
  never set. Add optional `state` and `iterationPath` fields:
  - New Job wizard Step 2 — optional inputs (default `state` to `'Proposed'` to preserve current
    behavior if left blank).
  - Persist on the `Job` row (add columns via a Prisma migration) so they're available when the
    worker builds work items.
  - Set via the existing `setFields` primitive / field-write path in `jobs.service.ts` — same
    mechanism as tags (#5), not a new integration.

## Frontend rebuild (greenfield, in `frontend/`)

Fresh Vite + React 19 + MUI 6 scaffold, same package location (docker-compose service/ports
unchanged). Deps: `react-router-dom`, `zustand`, `@mui/material`, `axios`, `react-markdown`,
`vitest` + `@testing-library/react`.

### Structure

- **`theme/tokens.ts`** — new Indigo-palette token object; keep the existing token-object
  structure and mono-font rationale from `frontend/src/theme/tokens.ts` (current file, being
  replaced but its documented rationale still applies).
- **`theme/AppThemeProvider.tsx`** — MUI theme built from tokens.
- **Routing** (`react-router-dom`): `/login`, `/jobs`, `/jobs/new`, `/jobs/:id`, `/help`. Route
  guard redirects to `/login` when no credential in the auth store. Every page is URL-addressable
  and refresh-safe.
- **State (Zustand)**:
  - `authStore`: `{orgUrl, pat, displayName}`, mirrored to sessionStorage, hydrated on load,
    cleared on logout. Selectors only — do not expose the raw store internals to consuming
    components (per the project's Hook Encapsulation convention).
  - `jobsStore`: job list cache + per-job status/diff cache.
- **API layer**:
  - `api/httpClient.ts` — axios instance; `baseURL` read from a runtime-fetched `/config.json`
    (fetched once at app startup), not a build-time `VITE_API_BASE_URL`.
  - `api/jobs.ts` — `POST /jobs`, `POST /jobs/preview`, `GET /jobs`, `GET /jobs/:id`,
    `POST /jobs/:id/confirm`, `GET /jobs/:id/audit`.
  - `api/ado.ts` — `GET /ado/area-paths`.
  - `api/events.ts` — `EventSource` wrapper for `GET /jobs/:id/events`.
  - PAT sent as `X-Ado-Org-Url` / `X-Ado-Pat` headers on area-path reads and confirm (per
    `docgen-connection-pattern.md`'s per-request pattern).
- **Components**:
  - `AppShell` — collapsible dark rail + top bar (breadcrumb, org, avatar).
  - `StatusChip`, `ModeBadge`, `ActionBadge` (CREATE / REUSE #id / SKIP·dup), `TagChips` — shared
    mapping utilities, not inlined per usage site.
  - `DiffTree` — builds the Epic→Feature→Requirement tree from `parentLocalId`; collapse/expand;
    filter by action + text; **virtualized** (real documents produce 60+ nodes — do not render an
    unvirtualized list).
  - `NodeDetailPanel` — right-hand detail for the selected tree node.
  - `ProgressBanner` — SSE-driven stage indicator + `ElapsedTimer`.
  - `AreaPathPicker` — tree/autocomplete against `GET /ado/area-paths`.
  - `FileDropzone`, `ModeCards` (descriptive cards for BASELINE/SURVEY, not bare radio buttons).
- **Pages**:
  - `Login` — org URL + PAT form, validates via `POST /auth/login`, on success populates
    `authStore` and routes to `/jobs`.
  - `JobsList` — `GET /jobs`; rows route to `/jobs/:id`; empty-state CTA.
  - `NewJobWizard` — Step 1 (`FileDropzone` → `POST /jobs/preview`) → Step 2 (parsed
    summary + `ModeCards` with computed ETA + `AreaPathPicker` + optional State/Iteration →
    `POST /jobs`) → routes to `/jobs/:id`.
  - `JobDetail` — split `DiffTree` + `NodeDetailPanel`; `ProgressBanner` while status is
    `running`; Audit tab (`GET /jobs/:id/audit`); Confirm button gated on `status === 'diff_ready'`,
    sends PAT headers to `POST /jobs/:id/confirm`.
  - `Wiki` — renders `GET /wiki` markdown via `react-markdown` (existing behavior, ported as-is).
- **Error/failed states**: router error boundaries; an explicit screen for `status === 'failed'`
  (the current MVP's `JobStatus.tsx` lets a failed job fall through to a blank/broken diff render —
  this must not recur); network-error and malformed-response handling; toast notifications for
  transient errors.
- **Before building**: verify the exact `Job.status` string values against
  `orchestrator/prisma/schema.prisma` (it's a plain String column, not a real enum) — don't assume
  the documented `pending | running | diff_ready | succeeded | failed` set is exhaustive or unchanged.

## Verification

1. **Unit (vitest + `@testing-library/react`, `vi.mock('../api/httpClient')` pattern — same
   convention as the current `frontend/src/pages/JobStatus.test.tsx`)**:
   - `DiffTree` builds correct nesting from a set of `parentLocalId` values, including orphans
     and multiple roots.
   - `StatusChip` / `ActionBadge` / `TagChips` mapping functions cover all known values.
   - A job with `status: 'failed'` renders the explicit failure screen, not a blank diff.
   - `ProgressBanner` renders each SSE stage correctly as events arrive.
   - The ETA function returns sane values across a range of block counts for both modes.
   - Keep the `tsconfig.json` test-file exclusion (added previously so `tsc -b` doesn't choke on
     vitest globals) intact in the new scaffold.
2. **Integration (docker-compose stack, mock ADO backend)**: login → New Job wizard Step 1
   (preview returns a real block count for a test fixture) → Step 2 area picker populates from the
   mock backend's area tree → submit → JobDetail shows SSE progress stages → tree renders nested
   with action badges and tag chips → select a node → detail panel updates → Confirm (mock
   backend) → job reaches `succeeded`. Separately, force/simulate a `failed` job and confirm the
   failure screen renders correctly instead of a blank diff.
3. **Backend routes, direct check**: `GET /jobs` returns the list shape; `POST /jobs/preview`
   returns real block/section counts for a known fixture; `GET /ado/area-paths` returns the mock
   backend's tree; `GET /jobs/:id/events` streams the expected stage sequence for a test job.
   Confirm a created work item in the mock backend actually carries `System.Tags` and any
   configured State/Iteration values.
4. **Real ADO (optional, per the existing real-ADO-write runbook)**: area picker lists actual
   classification nodes from a real ADO project; a job configured with a real picked area path,
   tags, and State/Iteration writes successfully end-to-end.

## Explicitly out of scope for Phase 1

- Any RAG/SharePoint/knowledge-base work — that's Phase 2 (`req2ado-roadmap.md`).
- Quality scoring of any kind — deliberately deferred to Phase 2 P2c (RAG-grounded when
  available, falls back to public standards otherwise) rather than shipping a throwaway version
  now.
- Editable dry-run diff, AI chat/assist — Phase 3.
- Trace/coverage links beyond parent-child, diff-vs-live-ADO — Phase 4.
- Full ADO-extension mode (VSS SDK) — a later phase; Phase 1 only lays the groundwork
  (per-request headers + edge token-normalization) that makes it low-friction later.
- Baking the Cato Networks CA-trust fix into product config — it's dev-machine-only.
