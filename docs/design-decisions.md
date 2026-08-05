# req2ado — Design Decisions (Phase 1)

> **Superseded for visual language only — see `/DESIGN.md`.** The visual
> language is no longer MUI-based; `frontend/src/theme/tokens.ts` no longer
> exists; the interactive accent is indigo `#4f46e5`, not cyan `#06B6D4`
> (cyan survives only as `--color-live`, meaning "streaming right now").
> Everything below this line is still current.

**Purpose of this doc:** every locked design decision for the frontend rebuild, with rationale,
so future sessions don't need to re-derive or re-litigate them. Decisions were made with the user
via a visual brainstorm companion (mockups shown in-browser, user picked). See `req2ado-roadmap.md`
for the product context and `phase1-spec.md` for the build detail.

## Visual language: "Deep Indigo Enterprise"

- Navy `#0F1B3D` rail, `#1B458F` primary, cyan `#06B6D4` live/interactive accent, slate neutrals.
- MUI 6 engine, custom theme built from a token file (keep the token-object structure and
  mono-font rationale from the current `frontend/src/theme/tokens.ts` — the mono face is
  req2ado-specific: BASELINE mode's core value is verbatim fidelity, so technical artifacts (ADO
  ids, source hashes) read as data, not prose).
- Chosen over two alternatives: a neutral-zinc "Linear/Vercel" style (best for density, but
  furthest from DocGen) and a slate+teal "dev-tool" style (distinctive, drops the blue brand tie).
  Deep Indigo evolves the existing DocGen blue rather than replacing it — brand continuity plus a
  richer navy that reads "enterprise-grade."

## App shell: collapsible dark sidebar rail

- Persistent dark rail, **collapsible** (full label rail ↔ mini icon-only rail).
- Top bar: breadcrumb (left) + org name + user avatar (right).
- Login is a separate full-screen page, outside the shell.
- Chosen over: a mini-icon-only rail with no collapse (sleeker but always cramped) and no-sidebar
  (AppBar-only, the current MVP's approach — no clear location sense as pages grow).

## Job Detail (the core screen): split view

- **Split layout**: hierarchy tree on the left, live node-detail panel on the right.
- SSE progress banner across the top while a job is running.
- Confirm-write button is **gated** — disabled/hidden until job status is `diff_ready`.
- Audit trail (`GET /jobs/:id/audit`, already in the API but never rendered by the current
  frontend) is a second tab alongside the tree.
- Chosen over a tabbed full-width-tree layout (maximizes tree width, but detail requires expanding
  a row inline) — split view was picked for careful node-by-node review, which is the primary use
  case (confirm writes real ADO items; mistakes are costly).

## Jobs list: landing page after login

- Each row: mode badge (BASELINE/SURVEY), status chip, item count, area path, relative timestamp.
- Running jobs show **live elapsed time** in the row.
- Empty state (first login, no jobs yet): a "Create your first job" CTA.
- This surfaces job history that already exists in Postgres (`model Job`) but has never been
  exposed in the UI — confirmed gap in the current MVP.

## New Job: two-step wizard with a pre-parse checkpoint

- **Step 1** — upload + parse. File dropzone; submitting calls a new preview endpoint that parses
  the document (no LLM) and returns real block/section counts.
- **Step 2** — review + configure. Shows the parsed block/section count, a per-mode ETA computed
  from that real count (not a generic estimate), the area-path picker, optional State/Iteration
  fields, then Start.
- **Why this shape:** the core flow problem in the old UI was picking BASELINE/SURVEY *blind* and
  submitting into a 15-40 minute black hole with no idea of document size. Parsing first makes the
  mode choice — and the wait it implies — a conscious decision, not a guess.
- Considered and rejected: a single smart form (parse fires async in the background, ETA appears
  inline) — fine for power users, but the wizard's explicit two-step break was preferred for
  clarity on a decision with real time cost; a minimal no-preview version (generic "15-40 min"
  copy only) was rejected because it still leaves the user committing blind to the actual run size.

## Area path: real ADO tree/autocomplete picker (not free text)

- **Why not free text:** Area Path in ADO is a per-project hierarchical classification tree
  (e.g. `Aegis\Sensors\Detection`) defined by an admin. Writing a work item with an area path that
  doesn't exist **fails** at ADO's API level. Free text lets a user run a 40-minute SURVEY job,
  review a clean dry-run diff, then have every confirm-write fail on a typo'd area path — a
  costly, silent trap.
- **Decision:** build a real tree/autocomplete picker fed by ADO's own area-path hierarchy read
  (`GET _apis/wit/classificationnodes/areas`), so only paths that actually exist can be selected.
- This is the larger of the two area-path options considered (the alternative — free text +
  validate-on-preview, or free text + recent-paths datalist — was cheaper but leaves the same
  failure mode possible, just detected slightly earlier or not at all).

## Long-running job UX: backend SSE progress

- SURVEY mode's two sequential LLM calls (`infer_hierarchy`, `generate_requirements_for_document`)
  each send the entire document in one shot — no chunking, no true streaming percentage is
  possible. Chosen approach: **coarse backend SSE stage events** (`parse → infer_hierarchy
  start/done → generate start/done → diff_ready`) rendered as a stage indicator + elapsed timer +
  "can take up to ~40 min" messaging.
- Rejected: frontend-only elapsed timer with no backend change (cheaper, but leaves the user
  guessing which of the two LLM calls is actually running); a full percentage progress bar
  (would require chunking the LLM calls — out of scope, a backend architecture change beyond this
  phase).

## Stack & structure

- **Routing:** `react-router-dom` — makes every page URL-addressable and refresh-safe (today,
  refreshing loses the credential and job id entirely; `App.tsx` does manual conditional
  rendering with no router at all).
- **State:** **Zustand** over Context/useReducer or Redux Toolkit — enough structure for the
  auth + jobs state needed, without Redux's ceremony. (The project's `package.json` already lists
  `mobx`/`mobx-react-lite` as a dependency from an earlier aspiration that was never implemented —
  Zustand replaces that unused dependency, not extends it.)
- **Rebuild approach: greenfield**, not incremental-in-place. A fresh scaffold in the same
  `frontend/` package location (so docker-compose service name and port mapping are unchanged),
  porting selectively rather than editing the MVP page-by-page. Chosen because the MVP's
  structure (prop-drilling from `App.tsx`, no router, no error handling) doesn't have clean seams
  to build routing/state into incrementally.
- **Runtime config:** fetch `/config.json` at startup instead of baking `VITE_API_BASE_URL` in at
  Vite **build** time. Today, changing the orchestrator URL requires rebuilding the frontend
  Docker image — a deployment friction point flagged in the original handoff. Runtime config makes
  the image portable across environments without a rebuild.

## Credential handling

- **PAT storage: sessionStorage**, not localStorage, not in-memory-only.
  - Rejected localStorage: a PAT is a full ADO credential (Secrets/Restricted data class per
    company policy) — localStorage persists it on disk indefinitely, survives browser restart,
    and is the widest XSS exposure window of the options considered.
  - Rejected in-memory-only: would force re-entering the PAT on every page refresh, which
    reintroduces the exact "lost session on refresh" pain point this rebuild is meant to fix.
  - sessionStorage is the middle ground: survives refresh (fixes the pain point), clears on tab
    close (bounds the exposure window).
  - PAT lives in the Zustand `authStore`, mirrored to sessionStorage; hydrated on load, cleared on
    logout.
- **ADO connectivity — mirror DocGen's pattern (standalone-first, extension-ready):** see
  `docgen-connection-pattern.md` for the full pattern this decision is based on. Phase 1 ships
  standalone mode only (user pastes org URL + PAT) but adopts DocGen's stateless per-request
  credential flow and edge token-normalization now, so a full ADO-extension mode (VSS SDK,
  `getAccessToken()`) can be added later with minimal rework instead of a redesign.
  - PAT is now needed at **upload time** too (for the area-path picker's read), not only on
    confirm as in the current MVP — the credential flow must support this from the start.

## Notes

- The Cato Networks CA-trust fix (`.certs/cato-ca-bundle.pem`) applied to the orchestrator and
  mcp-ado-server this session is **dev-machine-only** — the user's local corporate network proxy.
  It is not a product or deployment concern and must not be baked into app config, Dockerfiles, or
  the general design.
