# Handoff — Point 5: Large/convoluted hierarchy handling

Source: `docs/handoff.md`'s code-review §5 ("Large/convoluted hierarchical
tree handling"). Also closes §6's node-count/grounding finding for
`infer_hierarchy` (folded into the same code path — see below). All 3
findings from §5 are done.

## What changed

1. **SURVEY output-vs-input count/structure sanity check** (also serves as
   §6's `infer_hierarchy` grounding validation) — nothing previously
   compared the LLM's returned node count against the input document's
   actual block count, and a fabricated `node_id` not present in the
   source document was silently filtered out with zero error or count
   surfaced. `WorkItemTree` gained a `warnings: list[str]` field (always
   `[]` for BASELINE); `build_survey_tree` now logs (`logging.warning`) and
   records a warning when (a) the ratio of valid nodes to input blocks
   diverges by more than 50%, or (b) the hierarchy referenced any
   `node_id` not present in the source document (names up to 10 of them).
   Neither fails the job — both are reviewable signals, not hard errors.
   (`ingestion/app/workitem/model.py`, `ingestion/app/leveling/llm_leveling.py`)

2. **`confirm()`'s write loop now has bounded concurrency instead of being
   fully sequential** — every create is independent of every other create
   (fields are self-contained), and every parent/child link is independent
   of every other link, so both phases now run through a new
   `mapWithConcurrency` helper (default 8, configurable via
   `CONFIRM_WRITE_CONCURRENCY`) instead of one ADO round-trip at a time.
   Customer-ID field resolution is pre-resolved sequentially for every
   distinct type *before* the concurrent create phase starts, so
   `customerIdFieldByType`'s "resolved at most once per type" guarantee
   stays exact even under concurrency (no possible race). Error semantics
   preserved exactly: the first failure (by original diff order, not
   completion order) is what gets thrown to the outer try/catch that
   decides `diff_ready` vs `failed`; `createdCount` reflects every create
   that actually succeeded, not just ones before the first failure — a
   correctness improvement over the old strictly-sequential version, which
   would report undercounts if concurrency were ever added later without
   this. (`orchestrator/src/modules/pipeline/map-with-concurrency.ts`,
   `jobs.service.ts`)

3. **SURVEY chunks large documents by top-level branch instead of always
   sending the whole document in one LLM call** — `infer_hierarchy` and
   `generate_requirements_for_document` previously always covered every
   block in one call regardless of document size, risking context-window
   overflow on a large/deep document (truncated/malformed JSON aborting the
   *entire* job). `build_survey_tree` now splits the document via
   `_split_into_branches` (the same depth-1-heading split BASELINE's
   `build_baseline_tree` already uses) and runs each branch through its own
   call pair. **A single-branch document (no heading structure, or one
   top-level section — the common case) behaves byte-identically to
   before this change**: same one call pair, same unprefixed node_ids
   ("0", "1", ...). Only a genuinely multi-branch document gets per-branch
   node_id namespacing (`br{N}_` prefix) to avoid collisions — each
   branch's hierarchy is entirely self-contained (a branch's node_ids only
   ever reference other node_ids within that same branch's outline, so
   there's no cross-branch parent-reference case to reconcile). Warnings
   from every branch are concatenated in branch order.
   (`ingestion/app/leveling/llm_leveling.py`)

## Verification

- `ingestion`: `.venv/bin/python -m pytest` — 196/203 passing (7
  pre-existing, unrelated poppler failures — same count as every prior
  point this session). New coverage: 3 count/grounding-warning tests, 4
  chunking tests (per-branch call isolation, node_id namespacing,
  single-branch byte-identical behavior). Every pre-existing SURVEY test
  (23 across `test_llm_leveling.py`/`test_survey_golden.py`/
  `test_worktree_schema_conformance.py`/`test_level_endpoint.py`) passed
  **unchanged** — direct proof the single-branch path is untouched
  behaviorally.
- `orchestrator`: `npx jest --forceExit` — 137/137 passing (was 131 before
  this point). New coverage: `mapWithConcurrency` (6 tests: order
  preservation, concurrency bound, per-item failure isolation, dispatch
  order, edge cases). Note: running `jobs.service.spec.ts` in isolation
  (not the full suite) can hang well past its actual test completion due
  to dangling BullMQ/Redis connection retries against `redis://unused` — a
  pre-existing test-infra quirk (unrelated to this point's changes,
  confirmed via `--silent` output showing all 11 tests passed before the
  hang); always verify via the full suite (`npx jest`), which force-exits
  cleanly.
- Not re-verified against the live ADO org or a real multi-branch document
  through a real LLM this round — every change here is either additive
  (`warnings` field, defaults preserve exact prior behavior) or an internal
  restructuring proven behavior-identical for the common single-branch
  case via the full pre-existing SURVEY test suite passing unchanged.
