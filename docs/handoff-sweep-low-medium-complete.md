# Handoff — SWEEP.md Low + Medium tiers complete (2026-08-30, second session)

Repo: `/Users/EdenZviSchwartz/Repos/Projects/elisradevops/req2ado`, branch `ui-glowup-phase1-foundation`.
Complements `SWEEP.md` (the living, checklist-format tracker) and
`docs/handoff-sweep-executive-triage.md` (the first session, same day, which closed
all 8 Executive Triage Blockers). This doc covers the **second** session, which worked
through `SWEEP.md` severity-tier by severity-tier — 🟢 Low first, then 🟡 Medium — across
all 10 categories, then did a final closure pass to make sure nothing at Medium-or-below
was left silently unresolved. **`SWEEP.md` itself is the source of truth** for per-item
status; this document is the narrative summary and pointer to what's next.

## Scope and approach

The user asked to work section by section, low severity to high, fixing what could be
safely fixed and verified, and explicitly deferring (with written reasoning) anything that
needed a larger refactor, a schema migration, a product decision, or a dedicated design
session. Every item that wasn't fixed still got an explicit resolution note in `SWEEP.md`
— `**Investigated, not fixed**`, `**Deferred, needs a migration**`, `**Rejected**`,
`**Moot**`, etc. — so nothing reads as silently skipped.

**29 commits**, all on `ui-glowup-phase1-foundation`, `f4c7892` through `d3b88eb`. Every
commit runs the affected package's full test suite (not just the touched file) before
being made; no regressions were introduced anywhere across the whole session.

## What's actually fixed (the real bugs, not just cleanup)

Most of the ~40 fixed items are legitimate but modest (dead code, duplication,
perf micro-fixes). These are the ones worth knowing about specifically because they're
either genuinely surprising or were found _while_ fixing something else:

- **`ElapsedTimer.tsx` rendered a literal `"NaN:NaN"`** for an unparseable `startedAt` —
  found by a test written to verify a _different_ component's (`ProgressBanner`) NaN guard;
  the test failed against `ElapsedTimer`, not the component under test. Fixed with an
  explicit `Number.isFinite` check.
- **`KbVectorStore`'s new collection-handle cache (ported from the dedup store) would have
  gone stale after `purge_user()`** — dedup's own cache has no equivalent "drop the whole
  collection" operation, so porting its cache verbatim would have introduced a real bug the
  source it was copied from doesn't have. Caught before committing; added the missing
  invalidation plus a regression test.
- **`isExcluded()`'s ancestor walk had no cycle guard** — a cyclic `parentLocalId` chain in
  a persisted diff would hang a confirm request forever. Added a visited-set guard.
- **The figure-storage call site's own comment claimed it reused `_describe_figure`'s
  rasterized bytes but actually rasterized a second time** — confirmed via a strengthened
  test that now asserts the underlying conversion function is called exactly once.
- **`Number(matchedItemId)` had no finiteness check** — a corrupted dedup-store record
  could inject a literal `NaN` as an ADO work-item id, reaching a `PATCH .../workItems/NaN`
  call. Added a `Number.isFinite` guard, falls through to `'create'` (the same safe path a
  dedup-check error already falls through to).
- **Non-UTF-8 `.txt`/`.csv`/`.rtf` uploads (e.g. Hebrew CP1255) raised and aborted
  ingestion entirely**, against this codebase's own degrade-don't-raise discipline used
  everywhere else. Fixed with a shared `read_text_degrading()` helper that surfaces the
  degradation as a real `[UNSUPPORTED: ...]` warning instead of crashing or (RTF's case)
  silently corrupting text with zero signal.
- **`OCR_RECOVERED_TABLE_TEXT`/`EXTERNAL_REFERENCE` warnings were never grouped** — a
  scanned PDF with many recovered tables spammed one row per table instead of one summary.
- **`OPEN_TBD` classification only ever ran for scanned PDFs** — a docx/txt/native-text-PDF
  paragraph with the exact same "OPEN:"/"TBD:" marker silently never got flagged. Now runs
  once, centrally, in `dispatch.py` for every format that produces `Block`s.
- **The agentic `build_skeleton` narration hardcoded `kb_grounded=False` and never
  re-fired** with the real result once retrieval actually happened — the UI permanently
  showed "Not grounded" even when it worked. Fixed with the same in-flight-then-real-result
  convention `describe_figure` narration already uses.
- **`streamChat()` had no code path for `numCtx`/`topK`/`minP`/`think`** even though the DTO
  already accepted them and the non-streaming `chat()` already forwarded them.
- **`resolveCrossJobTraceLinks` issued one sequential WIQL query per link**, even when
  several links shared the same target customer-id. Now dedupes the target set and resolves
  concurrently.
- **`AuditEntry`/`DedupSkipAudit` had zero indexes on `jobId`** despite real
  `findMany`/`deleteMany({jobId: ...})` query patterns — added via a hand-authored Prisma
  migration (not applied against a live DB from this session).
- **`backfillMissedEvents` used Redis `KEYS`** (blocks the whole instance for a full-keyspace
  scan) — replaced with cursor-based `SCAN` via ioredis's `scanStream()`.

## What was investigated and found _not_ to hold up

A recurring theme this session: several of the original audit's findings, read literally,
turned out to be either already-fixed-by-design or actively contradicted by an existing,
deliberate comment in the code. These were **not** force-fixed — each has a documented
investigation in `SWEEP.md`:

- `page_alignment` never firing for PDF — correct by design (PDF gets real page numbers
  natively; the phase is a docx-only remediation for a format with no native pagination).
- The `useWindowStartedAt`/`useWindowBaselineUnits` "redundant dep array" claim — both
  hooks' `storageKey` is independently read inside the effect body, not merely derived.
- Vision-captioning determinism "by accident" — it's a deliberately documented, tested fix
  for a real live incident, not an accident with nothing protecting it.
- Trace-link prompt truncation — `trace_links.py`'s own comment explicitly rejects exactly
  this ("Prose text is NOT truncated here (and must not be)"), for a good reason.
- The shared test-render-helper claim — the ~17 files each have a genuinely different,
  intentionally-configured local wrapper, not one duplicated wrapper.
- `stripProjectPrefix`'s "unused export" — its own comment documents deliberate future
  reuse other call sites haven't been wired to yet; removing it would remove that seam.

## What's deferred, and why (in case you pick one of these up)

Every deferred item names the _shape_ of a real fix, not just "this is hard":

| Item                                                             | Needs                                                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dryRunDiff` lost updates (5 call sites, not 2)                  | A `version` column + Prisma migration + `updateMany`-with-count-check at all 5 sites, same pattern as the Executive Triage `confirm()` fix                   |
| SSE replay-then-subscribe ordering gap                           | A second (non-per-request) Redis client + buffer-then-merge-with-dedup logic — can't just reorder on one connection (ioredis subscriber-mode constraint)     |
| Embeddings model-version pin                                     | A cross-service contract change — `EMBED_MODEL` never crosses the `/llm/embed` HTTP boundary into ingestion today                                            |
| `JobDetail.tsx` hook extraction (`useJobData`/`useJobNarration`) | Its own multi-hour session — 1625 lines, 45 `useState`, 5 `useEffect`, heavily interdependent                                                                |
| Shared Prisma test-double factory                                | Its own session — `jobs.service.spec.ts` alone is 4591 lines with 136 inline mock literals, and it's the file guarding the `confirm()` duplicate-write fixes |
| `analyze_section*` dataclass                                     | Touches a `Protocol`, its sole implementation, and several test fakes with intentionally-divergent signatures                                                |
| `DiffTreeRow`/`ProgressBanner` full `React.memo`                 | A real prop-stability audit first — `DiffTreeRow` alone takes ~15 props, several functions/`Set`/`Map`                                                       |
| Fabricated KB citation identity (item 4, line 86)                | Same data-flow region as the still-open Critical bug below — fix together                                                                                    |
| Item 5 (document-understanding UI summary)                       | An actual `/design` session — this document only gathered the data inventory                                                                                 |
| Scoring confidence field + canary probe                          | Real product/UX decisions (how confidence changes the review UI; where/how a canary is injected and asserted)                                                |

## Verification

Every commit's affected package suite was run in full before committing. Final state,
end of session:

- **orchestrator**: `892/892` jest tests passing, `tsc --noEmit -p tsconfig.build.json`
  clean, `prisma validate` clean (new migration not applied against a live DB).
- **frontend**: `764/764` vitest tests passing, `tsc --noEmit -p .` clean.
- **ingestion**: `1630/1630` pytest tests passing (1 pre-existing, unrelated failure —
  `test_ingest_survey_mode_still_captions_when_vision_is_configured` — documented in the
  first session's own handoff, confirmed still failing identically on an unmodified branch).
- **mcp-ado-server**: `112/112` vitest tests passing.

## Addendum (third session, same day)

The one still-open 🔴 Blocker this doc's own "What's next" section flagged first —
item 4's KB-grounding merge bug at `llm_leveling.py`'s `scoring_kb_context` (agentic path
overwrote it with query_kb hits instead of merging in the always-include text) — is now
fixed, together with its paired fabricated-citation-identity finding (the fallback path's
`build_skeleton` narration synthesized a fake `"(document-level)"` citation instead of the
real per-file one), exactly as planned: both touch the same data-flow region in
`_build_survey_skeleton_for_branch`, so they were done in one pass. 2 new regression tests;
ingestion suite 1632/1633 (same 1 pre-existing unrelated failure as every prior session).
See `SWEEP.md`'s Executive Triage and item 4 entries for the per-item detail — this is the
per-item source of truth, not this addendum.

## What's next, in priority order

1. **The entire 🟠 High tier** — sections 2, 3, 4, 6, 7, 8a, 8b, 9, 10 all still have
   untouched High-severity items (real bugs and gaps), exactly as originally investigated.
   With the last Blocker now closed, this is the natural next thing to pick up.
2. The deferred-with-reasoning items in the table above, whenever there's a dedicated
   session for one of them.
3. Item 5's `/design` session, whenever there's UI design bandwidth.

`SWEEP.md`'s own "Notes for whoever picks this up next" section has been refreshed to
match this; if you're only going to read one file before continuing, read that one — it's
kept current with checkbox state, this doc is the point-in-time narrative.
