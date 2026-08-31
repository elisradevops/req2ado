# Handoff — shared Prisma test-double factory, partial adoption (2026-08-31)

Repo: `/Users/EdenZviSchwartz/Repos/Projects/elisradevops/req2ado`, branch `sweep/deferred-items-closure`.
Complements `SWEEP.md` (the living, checklist-format tracker) — this doc is the narrative record of
exactly what landed, what didn't, and why, for section 2's "No shared Prisma test double" item.
`SWEEP.md` itself has the up-to-date checkbox state; treat it as the source of truth if the two ever
disagree.

Implements `docs/superpowers/plans/2026-08-31-sweep-shared-prisma-test-double.md`. Commits:
`02793f6` (the factory + its own unit tests), `933b484` (the one converted `describe` block).

## What landed

`orchestrator/test/helpers/prismaMock.ts` exports `makeConfirmPrismaMock(jobRow, overrides?)`,
reproducing the exact fake-Prisma shape the `confirm()`-family tests have hand-written 90+ times:
`job.{updateMany,findUnique,update}` + `auditEntry.create` + `createdItemMapping.{findMany,upsert,update}`.
9 direct unit tests in `test/helpers/prismaMock.spec.ts` cover the default shape, override merging,
spy-identity installation, per-call independence, and the deliberate absence of auto-vivification.

One `describe` block was converted onto it as a proof of the pattern:
`describe('JobsService.confirm resume (P4b)')`, 5 tests. It was picked because it uses the full
canonical shape in every test *and* exercises real per-test variation — a locally-named `upsert` spy,
a locally-named `update` spy, two different `createdItemMapping.findMany` override values, four
distinct `dryRunDiff` payloads — so converting it without flattening any of that is real evidence the
design works, not just that it compiles.

**Verification, stated as evidence rather than as a claim:**

- The full verbose test-name list for `jobs.service.spec.ts` was captured before the conversion
  (206 passed, 206 total) and after (206 passed, 206 total) and `diff`'d to **zero differences** —
  not one test vanished, was renamed, or flipped its pass/fail marker.
- A deliberate mutation — changing the factory's `job.updateMany` default from `{ count: 1 }` to
  `{ count: 0 }` — made **all 5 converted tests fail**, each with `confirm()`'s own
  `"is not in a confirmable state"` claim-guard error. That proves the converted tests are still
  genuinely exercising the atomic-claim path through the factory, not being waved through by a mock
  that would satisfy anything unconditionally. The mutation was reverted immediately after and the
  suite re-confirmed green (215 = 9 factory tests + 206 `jobs.service.spec.ts` tests).
- Full orchestrator suite: 989/989 passing (55 suites). `npx tsc --noEmit -p tsconfig.build.json`
  clean. (`tsconfig.json` — which this plan's own text expected to use for the `test/` directory,
  since `tsconfig.build.json` excludes it — currently fails with a pre-existing, project-wide `TS6059`
  rootDir error on *every* file under `test/`, old and new alike; confirmed unrelated to this change
  by checking the error also fires on files this plan never touched. `tsconfig.build.json` was used
  for the type-check gate instead, matching every other plan on this branch.)

## What did NOT get converted, and the measured size of it

Measured directly against the post-conversion file (5050 lines, up from the 4758 recorded when this
plan was authored — two sibling plans landed tests in this same file in between):

- `job: {` still appears **149** times.
- `const prisma` is declared **152** times.
- `makeConfirmPrismaMock(` is used **5** times — exactly the one converted block.
- The `updateMany: jest.fn().mockResolvedValue({ count: 1 })` claim stub still appears **91** times
  verbatim outside the converted block.
- `auditEntry: { create: jest.fn().mockResolvedValue(undefined) }` still appears **66** times verbatim.

The great majority of the duplication SWEEP.md describes is still there. This is a foundation, not a
completed refactor.

## Blocks that are off-limits right now, and why

Two other efforts are landing in this exact file on this same branch:

- **The `dryRunDiff` optimistic-concurrency migration** (already merged as of this doc — commits
  `72ef64c..ea60b3d`), which rewrote all five `describe('JobsService.setDiffEntryExcluded'/…)` blocks
  to route through its own new `mutateDiffVersioned` helper and a `diffVersion`-guarded `updateMany`.
- **SWEEP.md item 10's childless-parent-warning work** (not yet landed as of this doc), which will
  land inside `confirm()` and most plausibly touches `describe('JobsService.confirm — exclusion')`
  and the large top-level `describe('JobsService.confirm')`.

Converting any of those blocks onto this factory before (or instead of) those efforts land would have
bought a merge conflict for no benefit — this plan's own text called this out before either
implementation started, and both `describe` blocks it named as off-limits were confirmed still in
that state at execution time.

## Recommended order for a future broader pass

Take the `confirm()`-family blocks that use the full canonical shape and are *not* currently
off-limits, one `describe` per commit, re-running this task's own before/after test-list diff plus a
mutation check for each. Candidates, confirmed still present at their original names in the
post-conversion file:

- `describe('JobsService.confirm — sibling creation order')` (line 3868)
- `describe('JobsService.confirm — figure attachments')` (line 3406)
- `describe('JobsService.confirm — trace links')` (line 2976)
- `describe('JobsService.confirm — dryRunDiff refresh on success')` (line 3734) — convert this one
  **only** after item 10's childless-parent work has merged, since it's a `dryRunDiff`-refresh block
  and sits adjacent to that work's likely target.

## Blocks that should NOT be converted at all

`cancel`, `delete`, `getFigureFile`, `storeFigureFile`, `getDedupSkips`, `getDebugCaptures`, `list`,
`getById`, `submit`, `resubmit`, `onModuleInit`, `attachFigureToAdo`, `retryTraceLinkWrite`,
`validateCreatedTree`, `getSummary`, `reject`, `buildFigureAttachmentFilename` — all use deliberately
*lean*, method-specific mocks (often a single `job.findUnique`, or a `$transaction` with several
`deleteMany` spies for `delete`). These are not copies of the canonical `confirm()` shape; forcing them
onto `makeConfirmPrismaMock` would *add* noise and over-provision each mock with models the method
under test should never touch. Leanness is the correct assertion at those call sites, not a gap.

## Cross-file finding: there is no cross-file duplication to collapse

The SWEEP item's own "per spec" framing (implying the same duplication recurs across multiple spec
files) does not hold up. Per-file `job: {` counts measured at plan-authoring time: 6 in
`stale-job-watchdog.service.spec.ts`, 6 in `chat.service.spec.ts`, exactly 1 each in
`pipeline.worker.spec.ts` / `job-retention.service.spec.ts` / `eta.service.spec.ts` /
`batch.service.spec.ts`, and **zero** in `jobs.controller.spec.ts` (it mocks the service, not Prisma).
Each of those is a genuinely different shape serving a different service under test — the watchdog
needs `jobEvent.groupBy`, chat needs `chatMessage`, the worker needs `dedupSkipAudit.createMany`.
`batch.service.spec.ts` already has its own local `makePrisma()` factory, which is the correct scope
for a shape used by exactly one file. The duplication this item describes is intra-file, concentrated
almost entirely in `jobs.service.spec.ts`'s `confirm()` family — not a pattern to promote into a
repo-wide shared module.

## Why incremental, not a big-bang conversion

1. **The item's own risk statement.** SWEEP.md flags over-generalization as the specific hazard. The
   only way to keep that risk bounded is to convert a sample small enough to read line-by-line in
   review, then judge whether the pattern earned a wider pass.
2. **`jobs.service.spec.ts` is the regression guard for the `confirm()` duplicate-ADO-write blockers.**
   Both of the Executive Triage 🔴 fixes are held in place by this file. A conversion bug that silently
   weakens one of those assertions re-opens a data-integrity blocker while showing green.
3. **A big-bang diff is unreviewable.** A ~150-site diff across 5000+ lines cannot be meaningfully
   code-reviewed; a 5-test, ~185-line diff can. Correctness here is established by review plus a
   mutation check rather than by the type checker, so reviewability *is* the safety mechanism.
4. **Merge conflicts.** With two other efforts editing this same file concurrently, a wide rewrite
   would have conflicted with both. A single-block conversion outside their target blocks did not.
