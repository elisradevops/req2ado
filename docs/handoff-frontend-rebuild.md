# Handoff: req2ado Frontend — Plan a Modern UI

**Purpose of this doc:** context for a *new* session that will plan (not yet build) a properly modern frontend for req2ado. The current frontend is a minimal, functionally-thin MVP built fast to prove the backend pipeline works end-to-end. It works, but the UI itself was never actually designed — this handoff is so the next session can plan a real one without re-deriving everything above.

---

## 1. What req2ado actually does (one paragraph)

Converts a customer requirements document (contract-signed spec, informal narrative, or engineering ICD) into a hierarchical Azure DevOps work-item tree (Epic → Feature → Requirement, with sub-levels). Two modes: **BASELINE** (deterministic, verbatim, no LLM — for signed contracts) and **SURVEY** (LLM-driven, distills informal text into formal "shall" requirements with taxonomy tags — for messy customer narratives). Flow: upload → dry-run diff (preview, nothing written) → review → confirm (writes to ADO via a custom MCP server).

## 2. Current repo state

- **Location:** `/Users/EdenZviSchwartz/Repos/Projects/elisradevops/req2ado` — as of this session, its **own standalone git repo** (own `.git`, branch `master`), no longer part of the `Projects` monorepo. No remote configured (fully local).
- **Stack:** monorepo of 4 packages — `frontend/` (React 19 + Vite + MUI, MobX not actually used despite early docs mentioning it), `orchestrator/` (NestJS, Postgres/Prisma, BullMQ+Redis, MCP client), `ingestion/` (Python/FastAPI — parsing, leveling, LLM calls), `mcp-ado-server/` (custom MCP server for ADO reads/writes, mock + real backend).
- **Full docker-compose stack works** (all 7 services incl. frontend, see below) — was verified end-to-end this session, including real on-prem ADO login.
- **`docs/architecture.md`** — the original (aspirational, over-scoped) design doc. Treat with skepticism; a lot of it was never built or was later simplified (see `docs/runbook.md`, recent git log for what's real).
- **`docs/production-readiness-gaps.md`**, **`docs/requirements-traceability-matrix.md`**, **`docs/prod-cross-validation-report.txt`** — pre-existing docs from a prior audit session, not authored by me this session, worth reading for more scope context.

## 3. The frontend as it exists today (the thing to replace/redesign)

**Location:** `frontend/src/`

- **4 pages, no router:** `App.tsx` does manual conditional rendering (`!credential && <Login/>`, `credential && !jobId && <Upload/>`, etc.) — no `react-router`, no URL-addressable state at all. Refreshing the page loses everything (credential, job id).
- **Pages:**
  - `pages/Login.tsx` — single form (org URL + PAT), validates against orchestrator's `/auth/login`, which validates against ADO's own `connectionData` endpoint. No session persistence — refresh = logged out.
  - `pages/Upload.tsx` — file picker + area path text field + BASELINE/SURVEY radio. No drag-and-drop polish, no file preview, no validation feedback beyond basic required-field disabling.
  - `pages/JobStatus.tsx` — polls `GET /jobs/:id` every 2s. Shows a flat list of dry-run diff entries (type badge, title, description, action, similarity/existing-ADO-id) — **just fixed this session** to actually show title/type/description (was previously only showing `localId` + raw action string, useless for review). Still very basic: no hierarchy/tree rendering (parentLocalId is sent by the backend but never used to nest the display), no collapse/expand, no search/filter, no progress bar (see gap below).
  - `pages/Wiki.tsx` — renders `GET /wiki` (markdown) raw.
- **Components:** `AppShell.tsx` (AppBar-only, DocGen-style top bar, no sidebar), that's essentially it — no shared component library beyond MUI defaults.
- **Theme:** `theme/tokens.ts` — hand-copied DocGen color/font tokens (primary `#1B458F`, Inter font). `theme/AppThemeProvider.tsx` wraps MUI's theme provider. This part is fine to keep/reuse if brand consistency with DocGen matters.
- **State:** plain `useState` in `App.tsx` passed down as props. No global store despite `docs/architecture.md` claiming MobX — never actually implemented.
- **API client:** `api/httpClient.ts` — bare axios instance, `baseURL` from `VITE_API_BASE_URL` (build-time env var, baked into the bundle — can't be changed post-build without rebuilding the image).

## 4. Real, confirmed UX/functional gaps (found by actually using the app this session)

1. **No progress indication for long-running jobs.** SURVEY mode can take 15-40+ minutes on a real document (see §6). The UI just shows a spinner + "Processing…" the whole time, no step indicator, no ETA, no partial results. SSE progress was planned in `docs/architecture.md` but never built.
2. **No job history / list.** Once you have a `jobId` you can check it, but there's no page listing past jobs. Confirmed via direct DB query this session (`SELECT * FROM "Job"`) that job history *is* persisted (Postgres), just never exposed in the UI.
3. **No hierarchy visualization.** The dry-run diff is a flat list. `parentLocalId` is in the API response and completely unused for display — a real reviewer needs to see the actual Epic→Feature→Requirement tree structure, not a flat list of 65+ rows, to sanity-check the inferred hierarchy before confirming.
4. **No persistence of login/session across refresh.** Losing your tab = re-entering PAT.
5. **No real error surfacing for pipeline failures.** If a job fails (real example from this session: `/dedup/check` 500s, `/level` 500s from a network misconfiguration), the UI's `JobStatus` page shows nothing useful — you have to go check `docker logs` manually. The job's own `status: 'failed'` state isn't even distinguished from `pending`/`running` in the current `JobStatus.tsx` logic (`if (!job || job.status === 'pending' || job.status === 'running')` — a `'failed'` job falls through to render the diff section with `job.dryRunDiff` null, likely a blank/broken screen; never actually hit this state in testing to confirm the exact failure mode, but the code path is visibly unhandled).
6. **Frontend is genuinely minimal** — built to prove the pipeline works, not designed. No onboarding, no empty states, no responsive design consideration, no accessibility pass, single giant JS bundle with no code-splitting (Vite warns: 624KB main chunk).

## 5. Backend API surface the new frontend needs to work against (confirmed, current)

All routes on the orchestrator (`http://localhost:3001` in dev, or wherever it's deployed):

- `POST /auth/login` — body `{ adoOrgUrl, pat }` → `{ displayName }`. No token/session returned (deliberately — DocGen pattern, PAT resent per-request on writes).
- `POST /jobs` — multipart form: `file`, `areaPath`, `customerId?`, `mode` (`baseline`|`survey`) → `{ jobId }`.
- `GET /jobs/:id` → `{ id, status, dryRunDiff }`. `status` ∈ `pending | running | diff_ready | succeeded | failed` (worth double-checking exact enum against `orchestrator/prisma/schema.prisma`'s `Job.status` comment before building against it — it's a plain `String` column, not a real enum).
- `POST /jobs/:id/confirm` — headers `X-Ado-Org-Url`, `X-Ado-Pat` (only needed if writing to real ADO; harmless/unused against the mock backend) → `{ status, createdCount }`.
- `GET /jobs/:id/audit` → array of `{ id, message, createdAt }` — an audit trail table that **exists in the API but the current frontend never renders it at all**. Good candidate for a new UI's job detail page.
- `GET /wiki` → raw markdown string (`docs/user-guide.md`).
- `GET /health` → `{ ok: true }`.

**`DryRunDiffEntry` shape** (per node in `dryRunDiff`): `{ localId, parentLocalId, type, title, description, action: 'create'|'reuse'|'dedup_skip', existingAdoId, similarity, customerId, sourceHash }`. Use `parentLocalId` to actually build a tree in the new UI — it's already there, just unused today.

## 6. Real-world performance characteristics to design around

Confirmed this session against a real ~65-block document (`Project_Aegis_Eye_Detailed_CRD_v2_5_0.docx`):

- BASELINE mode: fast (seconds), no LLM involved, works well.
- SURVEY mode: **very slow** on real documents — each of its 2 sequential LLM calls (`infer_hierarchy`, `generate_requirements_for_document`) sends the **entire document in one shot**, no chunking/parallelization, no streaming. On a 12B local model on consumer hardware, this can take 15-40+ minutes for a real-sized document (vs. ~2-4 min on tiny 3-13 node test fixtures). This is a backend architecture limitation, not something the frontend can hide — but the **frontend absolutely needs real progress/status communication** for this to be usable (see gap #1). Don't design a UI that assumes sub-second or even sub-minute responses for SURVEY jobs.

## 7. Known infra quirks (only matters if the new UI session also touches deployment/dev-server config)

- CORS: orchestrator only enables CORS when `CORS_ORIGIN` env var is set (added this session) — needed whenever frontend runs on a different origin/port than the orchestrator (which is the current default dev setup).
- `VITE_API_BASE_URL` is baked in at Vite **build** time, not runtime — changing the orchestrator's URL requires rebuilding the frontend image, not just restarting the container. If the new frontend build is more sophisticated (e.g. runtime config), that's a legitimate improvement to design in.
- Docker Compose services + ports (all confirmed working end-to-end this session): frontend `4082`, orchestrator `3001`, ingestion `8010`, mcp-ado-server `4100`, postgres `5434`, redis `6381`. (Ports are non-default because 5432/6379/4080/4081/8000 were already occupied by unrelated containers on this dev machine — check for conflicts fresh on a different machine.)
- Corporate network runs outbound HTTPS through a Cato Networks TLS-inspecting proxy — any *new* container that makes outbound HTTPS calls (e.g. if the new frontend's dev tooling fetches anything external at build/runtime) may need the same CA-trust fix already applied to `orchestrator`/`mcp-ado-server` (`.certs/cato-ca-bundle.pem`, gitignored, machine-specific — regenerate via `security find-certificate -a -c "Cato" -p /Library/Keychains/System.keychain` if rebuilding on a fresh machine).

## 8. What "modern frontend" should probably mean here (a starting menu, not a decision)

Not prescribing an answer — just listing the axes worth deciding on explicitly in the next planning session:

- **Routing:** add `react-router` (or similar) so job status/upload/login are real URLs, refresh-safe.
- **State management:** something better than prop-drilling from `App.tsx` — doesn't have to be MobX (the old docs' aspiration, never built); Zustand/Redux Toolkit/plain Context are all reasonable, pick based on actual complexity needed.
- **Job list / history page** — surfacing what's already in Postgres but never shown.
- **Tree view for the dry-run diff** — using `parentLocalId`, probably worth a virtualized tree component given real docs can have dozens+ of nodes.
- **Long-running job UX** — given SURVEY's real latency (§6), this is probably the single highest-value design problem: some combination of clear elapsed-time display, "this can take up to 40 minutes" messaging, maybe backend work to add actual progress events (would need backend changes too, flag as a joint front+backend design problem, not frontend-only).
- **Error states** — job failures, network errors, malformed responses — currently almost entirely unhandled.
- **Design system depth** — current DocGen-token reuse is a reasonable brand-consistency starting point; decide whether to keep MUI or reconsider given whatever "modern" means for this project (could just mean: actually designed, not necessarily a framework change).

## 9. Testing conventions already established (keep using these if rebuilding incrementally)

- `vitest` + `@testing-library/react`, `vi.mock('../api/httpClient')` pattern for API mocking — see `frontend/src/pages/JobStatus.test.tsx` for the most complete example.
- `npm run build` = `tsc -b && vite build` — **the build tsconfig excludes test files** (`frontend/tsconfig.json`'s `exclude`, added this session — was previously broken, `tsc -b` failed on vitest globals it didn't know about).
