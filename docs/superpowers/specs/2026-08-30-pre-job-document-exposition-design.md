# Pre-Job Document Exposition — Design

Date: 2026-08-30
Status: Approved, pending implementation plan

## Problem

SWEEP.md's item 5 ("Document-understanding UI summary") flagged that
several signals the pipeline already computes are never shown to the
user, and that no job-level "did the AI understand this document"
summary survives past the live SSE stream. Investigating it surfaced a
sharper, more useful framing than "surface more numbers": give the
person reviewing a SURVEY job a way to catch a misread *before* the
pipeline commits any real work to it — a trust check, not a data
dump.

Three concrete, confirmed gaps:

**No whole-document semantic summary exists anywhere.**
`_build_document_outline` (`ingestion/app/leveling/llm_leveling.py:877-896`)
is described in its own surrounding comments as producing "headings + a
short per-section synopsis," but the real implementation only joins
heading text — no LLM call anywhere generates a synopsis. It also only
ever runs on the chunked/multi-branch path (its sole call site,
`llm_leveling.py:2062`, sits inside the `if not fits_whole_document`
branch, `:2019-2021`), and the resulting string never leaves
`build_survey_tree` — `WorkItemTree` (`ingestion/app/workitem/model.py:493-518`)
has no outline/synopsis field, and `/level`'s response model is
literally `WorkItemTree` (`ingestion/app/main.py:1170`). The only
"what is this document" signal a user sees today is the raw uploaded
filename (`Job.originalFilename`, `orchestrator/prisma/schema.prisma:89`,
surfaced verbatim at `frontend/src/pages/JobsList.tsx:317` and
`JobDetail.tsx:260/1135`).

**`groundingScore` is computed on every node and shown nowhere.**
`DryRunDiffEntry` carries `groundingScore?: number | null` alongside
`qualityScore?: number | null` (`orchestrator/src/modules/writeback/dry-run.service.ts:145-176`),
but `NodeDetailPanel.tsx:589-635` renders `qualityScore` via
`QualityGauge` and stops there. `flagged`
(`groundingScore < 0.2 || qualityScore < 50`, `diff-summary.ts:20-25`)
is computed on read for job/batch summaries
(`jobs.service.ts:1008-1020`, `batch.service.ts:262-265`) but never
offered as a way to find the flagged rows in the tree itself.

**The tree always loads fully expanded, with no way to see its shape
first.** `DiffTree.tsx:417`'s `collapsedIds` state starts as an empty
set — every Epic/Feature/Requirement renders open on first load,
regardless of document size, and there's no bulk expand/collapse
control (confirmed: zero hits for "expand all"/"collapse to Epic
level" anywhere in this component).

## Chosen approach

### Where the exposition actually runs: the wizard, not the pipeline

The first design pass placed the exposition mid-`build_survey_tree`,
right after branch-splitting — reusing the (fixed) outline step and
firing a new narration phase. That was rejected: `preparing_analysis`
(`llm_leveling.py:1765-1772`) is the only phase available at that point
in the pipeline and fires *before* branch-splitting/outline-building
even run, so a new phase and new SSE-replay/persistence plumbing would
have been needed for no real benefit — and it still only would have
caught a misunderstanding *after* the whole pipeline had already run.

Research into `POST /jobs/preview` (`jobs.controller.ts:180-262`)
changed the shape of the design for the better. Preview is already
fully synchronous, creates no `Job` record, and already does a **full
structural parse** (blocks, headings, tables, figures — everything
except vision captioning, via `ingestionClient.ingest(buffer, filename,
true)`, `:235`) the instant a file is dropped in the New Job Wizard
(`NewJobWizard.tsx:240-262`, `handleFileSelected`). Its response already
includes a real heading/document-map (`buildDocumentMap(doc.blocks)`,
`jobs.controller.ts:27,260`). So the exposition can run entirely inside
the wizard, before any `Job` exists, reusing data that's already been
computed for free — no second parse, no pipeline change, no narration
phase.

That relocation surfaces a real sequencing constraint: preview fires on
file-select, **before** mode (BASELINE/SURVEY) is even chosen on the
wizard's existing configure step. Since the exposition is SURVEY-only,
it can't ride along on preview — it has to be its own step, gated on
SURVEY actually being selected.

### The wizard gains a real third step, SURVEY-only

The wizard has exactly two steps today: Upload (file drop → preview),
and Configure & review (mode cards, an LLM model dropdown that only
appears inside the SURVEY card — `ModeCards.tsx:199-206`, state owned
by `NewJobWizard.tsx:170` — area/iteration path fields, and the "Start
job" button gated on `areaPath`/`project`/`isSubmitting`,
`NewJobWizard.tsx:601`). Both existing step transitions are plain
field-completeness-gated buttons — there is no "approve and continue"
pattern anywhere in this wizard today (the closest precedent,
`JobDetail.tsx`'s post-run confirm-before-write dialog, is a different
page and a different phase entirely).

This design adds a third step, **rendered only when `mode === 'survey'`**:

- **Step 2 (unchanged fields, changed behavior):** for BASELINE, the
  button stays "Start job" and creates the job directly, exactly as
  today. For SURVEY, the same button becomes **"Continue"** and
  advances to step 3 instead — no job is created yet.
- **Step 3, "Confirm understanding" (new, SURVEY-only):** fires the new
  exposition call on entry, using step 1's already-fetched heading/
  document-map data (no re-upload, no second parse). Shows the
  synopsis, a caveat when structurally warranted, a "← Back to
  configure" action that returns to step 2 with its fields intact, and
  the real "Looks right — start job" action, which is what actually
  creates the Job.
- Whatever the wizard's own step-indicator UI is today must reflect a
  **conditional step count** — 2 for BASELINE, 3 for SURVEY — the exact
  current implementation of that indicator should be confirmed at
  plan-writing time rather than assumed.

**Model selection doesn't gate this.** The model dropdown is optional,
defaults to empty/"Default," and isn't resolved into anything real
until deep inside the worker post-creation
(`pipeline.worker.ts:380`: `job.model ?? deps.defaultLlmModel`) —
`POST /jobs/preview` only ever uses an optional `model` param for a
cosmetic ETA number (`jobs.controller.ts:242-247`). The exposition call
therefore uses its own fixed, default lightweight model, independent of
whatever the user does or doesn't pick for the real job.

### What the exposition actually says

One short paragraph, generated by a single new LLM call, asserting:

1. **Document identity & scope** — specific enough that a wrong guess
   is obviously wrong (names the real subject/domain, not "this
   document describes requirements").
2. **A processing expectation** — one sentence tying the synopsis to
   what the job is about to produce, so it can be cross-checked against
   the real output later.
3. **A caveat, computed deterministically, not left for the model to
   invent.** A plain function judges the real structural facts already
   available from step 1's preview (section count, max heading depth,
   per-section size distribution) against fixed thresholds, and only
   when they're unusual does it instruct the synopsis call to include a
   caveat sentence. The model never decides on its own whether to raise
   a concern.

### Persistence: one new column, written once, at creation

New nullable Prisma column on `Job`, matching this repo's existing
precedent for values that used to live only in live SSE state
(`warnings`/`figureDescriptions`/`tableDescriptions`/`blockCount`/
`figureCount`, `schema.prisma:98-147`, each with a comment explaining
exactly this):

```prisma
documentOverview Json?  // { synopsis: string, caveat: string | null }
```

Hand-authored migration, not applied against a live database from this
session, matching this repo's own established convention.

Written once, directly in the `POST /jobs` payload's `prisma.job.create()`
call — not patched in mid-run, no new narration phase, no SSE-replay
concern, because this never touches the SURVEY pipeline at all.
Read-through added to `jobs.service.ts`'s `getById()` (`:485-575`,
return object `:548-574`) and `jobs.controller.ts`'s mirrored return
type (`:280-317`), same pattern as every other field there.

### Job page: the same card, plus the two other item-5 signals it exposed

- **Document overview card** (SURVEY-only): renders `job.documentOverview`
  as-is — no client computation, no live dependency. Includes a small
  "generated from the document's real structure, not a literal excerpt"
  attribution line.
- **BASELINE gets an explicit note, never a silent gap**, matching the
  template SWEEP.md itself pointed to (`JobLifecycleSteps.tsx`'s
  `SURVEY_STEPS`/`BASELINE_STEPS` arrays, `:16-38`, already branch
  cleanly by mode): *"Document overview isn't produced for BASELINE
  jobs — deterministic extraction, nothing to verify."* This is mode-
  driven (`job.mode === 'baseline'`), not failure-driven — see Error
  handling for how a genuine SURVEY-side failure is distinguished.
- **`Grounding` metric** added to `NodeDetailPanel.tsx` alongside the
  existing `Quality`/`QualityGauge` — reads `groundingScore` straight
  off the already-fetched `DryRunDiffEntry`. Renders only when
  `groundingScore != null`, which naturally excludes BASELINE nodes
  (they never have one) without any explicit mode check.
- **A "⚠ Review" chip** on `DiffTree` rows where the entry is flagged,
  reusing the existing `isFlaggedDiffEntry` logic (`diff-summary.ts:20-25`)
  rather than re-deriving the threshold client-side.
- **A "Needs review · N" toolbar filter chip** that isolates flagged
  rows, alongside the existing action `Select`.
- **The tree defaults to collapsed at Epic/Feature level** —
  `DiffTree.tsx`'s `collapsedIds` initializes populated with every
  Epic/Feature id instead of empty, plus a new bulk "Expand all"
  control. This one is **mode-agnostic** — it applies identically to
  BASELINE and SURVEY, since it's a generic scale/legibility fix, not
  tied to any LLM-produced signal.

## Data flow

```
Wizard, step 1 (unchanged):
  file selected -> POST /jobs/preview(file, skipVision=true)
    -> full structural parse via ingestion /ingest
    -> { blockCount, sectionCount, figureCount, depth, documentMap, ... }
       (no LLM, no Job record)

Wizard, step 2 (unchanged fields):
  mode = 'baseline' -> "Start job" -> POST /jobs (documentOverview omitted)
  mode = 'survey'   -> "Continue"  -> advance to step 3

Wizard, step 3 (new, SURVEY-only), on entry:
  POST /jobs/preview/exposition({ heading outline from step 1's documentMap })
    -> compute caveat deterministically from real structural facts
         (section count, max depth, size distribution) against fixed thresholds
    -> one LLM call, fixed default model, synopsis paragraph only
    -> { synopsis, caveat } | fails open to null

  "Looks right -- start job"
    -> POST /jobs({ ...existing fields, documentOverview: { synopsis, caveat } | null })
    -> prisma.job.create() persists documentOverview directly

Later, any time:
  GET /jobs/:id -> documentOverview read through unchanged
    -> JobDetail's Document overview card (SURVEY, non-null)
    -> explicit absence note (BASELINE, by job.mode)
    -> nothing rendered (SURVEY, documentOverview null -- exposition failed)
```

The exposition endpoint's exact input shape (what step 1's
`documentMap`/`buildDocumentMap` actually looks like — that function
lives in `orchestrator/src/modules/pipeline/document-map.ts`, not
directly inspected during this design) should be confirmed against the
real type during implementation; the shape of the decision — heading
outline in, `{synopsis, caveat}` out, no file bytes involved — is the
load-bearing part, not the literal field names.

## Error handling

- Exposition call failure (LLM unreachable, timeout, malformed output):
  step 3 must never block job creation. Show a neutral inline note
  ("Couldn't generate a summary — you can still continue") and keep
  "Looks right — start job" available; the job is created with
  `documentOverview: null`. Same fail-open contract as every other
  optional LLM-dependent signal in this codebase.
- **A `null` `documentOverview` means two different things, and the UI
  must not conflate them.** For a BASELINE job it's structural (never
  attempted) and gets the explicit dashed note. For a SURVEY job it
  means the exposition call failed at wizard time, and — matching this
  codebase's established silent-degrade convention for KB/vision
  failures — the card is simply omitted, not replaced with an error
  state. The distinction is made by branching on `job.mode`, never by
  trying to infer failure-vs-not-applicable from the null value itself.
- "← Back to configure" must preserve every field already filled on
  step 2 (mode, model, area path, iteration path) — no data loss on
  going back to re-check the upload or mode.
- The deterministic caveat function never raises — an unexpected input
  shape degrades to "no caveat," never to blocking the synopsis call.

## Testing

- New caveat-threshold function: unit tests against real-shaped
  fixtures — a small, shallow document (few sections, low depth) never
  gets a caveat; a deep/fragmented one (mirroring the real shape used
  throughout this design's mockups: ~79 sections, depth 5, sizes 0-37)
  does.
- New exposition endpoint: valid heading data → `{synopsis, caveat}`;
  malformed/empty heading data degrades gracefully, never throws.
- `jobs.service.spec.ts`/`jobs.controller.spec.ts`: `documentOverview`
  threads through `submit()` and `getById()`; omitted/`null` on old
  jobs stays backward compatible.
- Wizard tests: BASELINE selection never renders step 3 and submits
  directly from step 2, unchanged from today; SURVEY selection renders
  step 3; "← Back to configure" preserves field state; exposition
  failure still allows job creation.
- `NodeDetailPanel.test.tsx`: renders `Grounding` when
  `groundingScore != null`; omits it otherwise (the BASELINE case, with
  no explicit mode check needed).
- `DiffTree.test.tsx`: default `collapsedIds` includes every Epic/
  Feature id on mount, for both modes; "Expand all" clears it; a
  flagged entry renders the review chip; the toolbar filter isolates
  flagged rows.
- `JobDetail.test.tsx`: SURVEY job with a real `documentOverview`
  renders the card; SURVEY job with `documentOverview: null` renders
  nothing for that card; BASELINE job renders the absence note.

## Global Constraints

- Never fail or block job creation on exposition-call failure —
  fail-open, matching this codebase's convention everywhere else an
  LLM call is optional.
- SURVEY-only, structurally, not just visually: no BASELINE code path
  ever calls the exposition endpoint or reads `groundingScore`/
  `qualityScore`-derived UI. The one exception is the tree's default-
  collapse behavior, which is intentionally mode-agnostic.
- The exposition call must never re-parse the uploaded file — it
  consumes only the structured heading/document-map data step 1's
  existing preview call already returned.
- The caveat is deterministic, computed from real thresholds in plain
  code — never something the LLM decides to raise on its own.
- No new narration phase, no SSE-replay plumbing — this feature never
  enters `build_survey_tree` or the ingestion pipeline at all.

## Explicitly out of scope

- `pageAlignAnchoredRatio` persistence/surfacing, and persisting
  `parse_done`'s block/table/figure counts as their own summary object —
  part of an earlier version of this design (a stats-card "Document
  understanding" panel) that was superseded once the exposition became
  pure prose. Not reintroduced here; a real gap SWEEP.md's item 5 still
  names, left for a separate pass.
- Promoting `CollapsibleWarnings`' warning-by-kind breakdown out of its
  collapsed panel — proposed alongside the item above, dropped for the
  same reason, not reintroduced here.
- A `React.memo`/prop-stability audit for `DiffTreeRow`/`ProgressBanner` —
  unrelated pre-existing SWEEP.md item, untouched by this design.
- Any BASELINE-mode exposition or grounding surfacing — structurally
  impossible without a parallel deterministic-path implementation
  (`build_baseline_tree` never runs branch-splitting or any LLM call);
  not attempted here.
- Item 5's "format-aware UI states" half (page-provenance label
  unification across formats, panels that silently return `null`
  instead of degrading explicitly, a general per-format-capability UI
  template) — this design covers only the "understanding signals" half
  of item 5; that other half remains its own, separate future design
  pass, as already scoped earlier in this same effort.
