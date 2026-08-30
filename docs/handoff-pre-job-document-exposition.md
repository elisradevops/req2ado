# Handoff — Pre-Job Document Exposition (2026-08-30, fourth session)

Repo: `/Users/EdenZviSchwartz/Repos/Projects/elisradevops/req2ado`, branch `ui-glowup-phase1-foundation`.
Complements `SWEEP.md` (the living tracker — item 5's own section now points
here) and the two prior sweep handoffs (`docs/handoff-sweep-executive-triage.md`,
`docs/handoff-sweep-low-medium-complete.md`). This session grew out of
SWEEP.md item 5 ("Document-understanding UI summary") but ended up shipping
a genuinely new capability well beyond what that item originally asked for.

## Scope and approach

The user asked to look at item 5's `grounding_score`/`flagged` surfacing
gaps, but reframed the actual goal mid-brainstorm into something sharper:
not a stats dashboard, but a *trust check* — does the AI's understanding of
a document look right *before* the pipeline commits any real work to it,
the way an ALM/requirements engineer would skim a document's shape before
reading it line by line. That reframe went through several real pivots
before landing:

1. **First attempt**: a mid-pipeline narration phase inside `build_survey_tree`.
   Rejected — the only phase available at that point in the pipeline fires
   *before* branch-splitting/outline-building even run, and it still would
   only have caught a misunderstanding *after* the whole pipeline ran.
2. **Second attempt**: a stats-card "Document understanding" panel (block/
   table/figure counts, page-align ratio, warning-by-kind) on the job page.
   Superseded once the user clarified the goal was closer to reading
   comprehension than parsing telemetry — no counts, no lists, pure prose.
3. **Final design**: a real, LLM-generated synopsis paragraph plus a
   *deterministic* (never model-decided) structural caveat, computed as
   early as possible and shown as a genuinely new third step in the New Job
   Wizard — "Confirm understanding" — that only exists for SURVEY mode, and
   is the actual point where job creation happens (not step 2's button
   anymore, for SURVEY specifically).

Full design rationale: `docs/superpowers/specs/2026-08-30-pre-job-document-exposition-design.md`.
Full task breakdown: `docs/superpowers/plans/2026-08-30-pre-job-document-exposition.md`.

Execution used `subagent-driven-development`: 12 tasks, each with its own
TDD implementation + task-scoped spec/quality review, followed by one
whole-branch final review and one fix wave.

**17 commits**, all on `ui-glowup-phase1-foundation`, `13eb3af` through
`edb8785` (the last being a live-browser-discovered fix — see below).

## What's actually built

- **Backend (`orchestrator/`)**: `Job.documentOverview` (new nullable JSON
  column, hand-authored migration, unapplied from any automated session —
  same convention as this repo's other migrations); `DocumentOverviewService`
  (a pure deterministic caveat function + one LLM call producing the
  synopsis); `POST /jobs/preview/exposition` (reuses the wizard's existing
  step-1 preview data — heading outline, section count, depth — never
  re-parses the file); `documentOverview` threaded through `submit()`,
  `resubmit()`, and `getById()`.
- **Frontend (`frontend/`)**: the New Job Wizard gains a real third step,
  SURVEY-only — the stepper itself grows from 2 dots to 3 the instant SURVEY
  is selected. Step 2's button becomes "Continue" (not "Start job") for
  SURVEY; step 3 shows the synopsis (with a caveat banner when the
  deterministic thresholds fire), a "← Back to configure" escape hatch that
  preserves every field, and "Looks right — start job" as the real creation
  trigger. `DiffTree.tsx` now defaults every Feature-typed row to collapsed
  (the ONE deliberately mode-agnostic piece of this whole feature — it
  applies to BASELINE too), shows a `⚠ Review` chip on flagged rows, and a
  toolbar "⚠ Needs review · N" filter that isolates them and correctly scopes
  the bulk Exclude/Include actions to just the filtered set.
  `NodeDetailPanel.tsx` shows a `Grounding` metric alongside `Quality`.
  `JobDetail.tsx` shows the persisted "Document overview" card for SURVEY
  jobs, and an explicit dashed absence note for BASELINE (never a silent gap
  — `documentOverview: null` means two different things depending on
  `job.mode`, and the UI never conflates them).

## What the final whole-branch review caught (all fixed, one fix wave)

- **Critical**: `documentOverview: (input.documentOverview ?? null) as any`
  wrote a literal JS `null` to a Prisma `Json?` column. Fixed to
  `Prisma.DbNull`. **Correction worth remembering**: live-verifying this
  against the actual running Postgres + Prisma client (5.22.0) found the
  review's own predicted symptom ("crashes every job creation") didn't
  reproduce — literal `null` silently stored as a JSON-null *value* inside
  the JSONB column rather than a real SQL NULL, a semantic bug, not a
  crash. The prescribed fix was still correct and applied regardless; the
  lesson is to verify a review's predicted failure mode against the real
  runtime before citing it as fact in a future retro.
- **Important**: the wizard didn't distinguish the server's own real
  `null` fail-open response (which NestJS serializes as an *empty body*,
  not JSON `null`) from a real synopsis — silently showed an empty
  confirmation card instead of the "Couldn't generate a summary" copy.
  Fixed and regression-tested with a `previewExposition` mock that
  *resolves* to `null` (not rejects) — the untested branch that turned out
  to be the most likely real-world path (see below).
- **Important**: bulk Exclude/Include ignored the new "Needs review" filter
  — clicking "Exclude all" while isolated to flagged rows silently acted on
  the *entire* diff. Fixed, verified live on real data (see below).
- **Important**: `resubmit()` didn't forward `documentOverview` — a
  resubmitted SURVEY job silently lost its synopsis. Fixed, same precedent
  this file's own comment already documents for the `model` field.
- **6 Minor fixes bundled into the same pass**: caveat/heading-list
  construction moved inside the service's `try` block; the controller
  guard now checks `Array.isArray`; the heading list sent to the LLM is now
  capped at 150 with a trailing count; `JobDetail.documentOverview` is now
  optional (matching sibling fields' convention); two duplicate frontend
  imports merged; one misleadingly-named test renamed to match what it
  actually verifies.

Full final-review verdict, all 10 findings' fix-round evidence, and the
scoped re-review are in git history only (the SDD workspace was deleted
per that skill's own convention once the loop closed clean) — this handoff
and the commit messages are the durable record.

## What live browser-testing found that no automated review could

After the whole-branch review closed clean, the feature was actually driven
against a rebuilt, running docker-compose stack (real Postgres, real
orchestrator/frontend images, the deployment's real configured LLM backend)
— not mocks. Two real things came out of this that 12 tasks' worth of
task-review, one whole-branch review, and 910+788 passing tests never
caught:

1. **Confirmed working, not just tested**: opened a real existing 557-item
   AirPro ICD job (the same document used throughout this feature's design
   mockups) and confirmed the "⚠ Needs review · 93" filter genuinely
   isolates flagged rows on real historical data, that bulk-action labels
   correctly switch to "…matching", and that the `Grounding` metric renders
   real per-node scores (0.73, 0.80 — both correctly shown without warning
   styling, since the flagging on those particular nodes came from
   `qualityScore`, not `groundingScore` — proving the OR-logic holds on
   real data, not just fixture data).

2. **A real, previously-undetected bug**: `DocumentOverviewService.generate()`'s
   `chat()` call had no `think: false`. On this environment's actual
   configured backend (a real reasoning-capable model, `qwen3.6:35b`), the
   call silently burned its entire 300-token budget on hidden chain-of-thought
   and returned empty `content` — **every single time**, meaning the
   feature's own fail-open path (which the final review had just fixed and
   tested!) was the *only* path a real user would ever see. Root-caused by
   direct `curl` calls against the live LLM backend (confirmed
   `finish_reason: "length"`, `content: ''`, 300/300 completion tokens all
   reasoning), confirmed the fix (`think: false` → `reasoning_effort: 'none'`,
   a knob this codebase already has and documents for exactly this class of
   problem), applied it, added a regression assertion to the existing test,
   reran the full suite (910/910 + clean typecheck), rebuilt, and
   re-verified live — a real, specific synopsis rendered
   ("This document defines the product requirements for a target tracking
   system…"), persisted correctly through a full pipeline run to
   `diff_ready`, and survived unchanged.

**The lesson, worth repeating for whoever adds the next LLM call to this
codebase**: mocked `chat()` calls in unit tests can never catch a reasoning-
budget exhaustion bug, because a mock doesn't reason. If a call is meant to
produce one short, structured answer with no need for multi-step reasoning,
set `think: false` explicitly and don't rely on the model's default — and
before calling any new LLM-touching feature "done," drive it at least once
against the real configured backend, not just mocks.

## Verification

- Orchestrator: `910/910` jest tests passing (up from `899` at the start of
  this session), `tsc --noEmit -p tsconfig.build.json` clean, `prisma
  validate` clean (the one new migration is unapplied by any automated
  session — it *was* applied manually, once, directly to the local dev
  Postgres, specifically to live-verify the Critical Prisma finding above;
  see that finding's own note).
- Frontend: `788/788` vitest tests passing (up from `759` at the start of
  this session), `tsc --noEmit` clean.
- Live: full wizard flow (upload → configure → SURVEY → Confirm
  understanding → real synopsis → job creation → full pipeline run →
  `diff_ready`) driven end-to-end in a real browser against a rebuilt,
  running stack. The one test job created during this verification
  (`a87feaa6…`, `mock_prd_sensor.docx`) was deleted afterward — confirmed
  removed from Postgres (`SELECT` returns 0 rows) and absent from the jobs
  list UI.

## What's next, in priority order

1. **The entire 🟠 High tier** (SWEEP.md sections 2, 3, 4, 6, 7, 8a, 8b, 9,
   10) — still fully untouched across all four sessions so far.
2. **Item 5's cross-format/cross-mode consistency half** (SWEEP.md's own
   lines ~104+: page-provenance labels, silently-vanishing panels, no
   format-branch template) — genuinely untouched by this session, still
   needs its own `/design` pass.
3. Item 5's `pageAlignAnchoredRatio`, warning-count-by-kind, and persisted
   `parse_done` counts — all explicitly scoped out of this session's design,
   still open.
4. The deferred-with-reasoning items from the third session (Prisma
   `dryRunDiff` optimistic concurrency, SSE replay ordering, embed
   model-version pin, the `JobDetail.tsx` hook-extraction refactor — this
   session added yet another feature's worth of state/JSX to that same
   file, which only strengthens the case for that refactor being worth
   doing sooner rather than later — the Prisma-mock test-double factory,
   the `analyze_section*` dataclass).

`SWEEP.md`'s own item 5 section and "Notes for whoever picks this up next"
have been refreshed to match this; if you're only going to read one file
before continuing, read that one — it's kept current with checkbox state,
this doc is the point-in-time narrative.
