# Handoff — Point 8: Backfill reuse/dedup from an ADO project's existing work items

Source: `docs/handoff.md`'s code-review §8 — the review's headline finding:
both of req2ado's duplicate-prevention mechanisms (`IdempotencyMapping`,
the Chroma dedup vector store) were populated **exclusively by req2ado's
own past writes**. An engineer's manually-created ADO work item was
completely invisible to reuse/dedup, and submitting a document describing
it would silently create a true duplicate. This closes that gap.

## What changed

New `BackfillService.backfillAreaPath(areaPath, credential?)`
(`orchestrator/src/modules/writeback/backfill.service.ts`):

1. Queries the area path's existing work items via
   **`mcpClient.queryIds({'System.AreaPath': areaPath})`** — this MCP tool
   already existed (`ado_query_ids`, exact-field-match WIQL) but had no
   `McpClient` method wired to it at all in this worktree; added one
   (mirrors every other method's pattern exactly).
2. Bulk-reads them via **`mcpClient.getWorkItemsBatch`** — this session's
   earlier Point 3 work (chunked/concurrency-bounded batch read,
   `ado_get_work_items_batch`) turned out to be a direct prerequisite for
   this task, as flagged when it was built.
3. For each item of type `Epic`/`Feature`/`Requirement` (req2ado's own
   taxonomy — a `Bug`/`Task`/anything else from the same area path is
   skipped, never seeded as a false-positive match):
   - `sourceHash = sha256(description or title)` — same scheme
     ingestion's `fidelity_hash` uses, so a document whose content matches
     this manually-created item verbatim resolves to `reuse`, not
     `create`, on the next submission.
   - Records it in `IdempotencyMapping` (`customerId: null` — consistent
     with how any req2ado node whose source document never supplied a
     customer ID is already recorded, not a new assumption).
   - Collects it for a single **batched** `upsertDedupEntriesBatch` call
     (Point 4's batching work) seeding the Chroma embedding-similarity
     dedup store too, for near-duplicate (not just exact-hash) matches.
   - Per-item and per-batch failures are caught and logged, never abort
     the whole run (same fail-open philosophy as `confirm()`'s own dedup
     upsert).
4. New `POST /backfill` route (`{areaPath}` body, `X-Ado-Org-Url`/
   `X-Ado-Pat` headers, same credential pattern as `/jobs/:id/confirm`),
   returns `{scanned, seeded, skipped, skippedReasons}`.

This is a manually-triggered maintenance operation (an operator runs it
once per area path when adopting req2ado into an ADO project with
pre-existing manual content), not part of the automatic per-job pipeline.

## Verified live against the real ADO org (this session's target org)

- Created a genuinely new, real ADO work item (**#441**, "Battery Thermal
  Cutoff") via direct ADO REST API — bypassing req2ado entirely, exactly
  simulating "an engineer already created this manually."
- Ran `POST /backfill` against `elisradevops-project` (the real area path
  used throughout this session): **`{"scanned":388,"seeded":82,
  "skipped":306,"skippedReasons":{"unsupported type":306}}`** — correctly
  scanned the whole real area path's history, seeded every Epic/Feature/
  Requirement (including #441), and correctly skipped every non-taxonomy
  type without crashing.
- **Submitted a document containing #441's exact requirement text through
  req2ado's normal `/jobs` flow afterward** — the dry-run diff resolved
  that node to `"action":"reuse","existingAdoId":441"` — direct proof the
  backfill closed the exact gap described in the original finding:
  req2ado now recognizes a pre-existing manually-created item it never
  wrote itself.
- #441 has since been soft-deleted (recycle bin, reversible), same cleanup
  pattern as every other test item created during this session.

## Verification

- `orchestrator`: `npx jest --forceExit` — 158/158 passing (was 146 before
  this task). New: 8 `BackfillService` unit tests (empty area path,
  successful seeding, unsupported-type skip, blank-description skip +
  title fallback, idempotent re-run against an existing mapping,
  per-item/per-batch failure isolation, credential forwarding), 3
  `BackfillController` e2e tests (400 on missing `areaPath`, successful
  call + result passthrough, credential-header forwarding), 1 new
  `McpClient.queryIds` unit test.
- `mcp-ado-server`: `npx vitest run` — 70/70 passing (unchanged — no
  backend/tool code needed changing, `ado_query_ids` and
  `ado_get_work_items_batch` already existed).
- `ingestion`: `.venv/bin/python -m pytest` — 219/226 passing (7
  pre-existing unrelated poppler failures, unchanged count — this task
  touched no ingestion code at all).
- **This is the one task this whole review round that was verified against
  real, live ADO data end-to-end**, not just mocked unit tests — the
  `scanned`/`seeded`/`skipped` counts above are real numbers from the real
  target org, and the `reuse` resolution against #441 is a real dry-run
  diff from a real submitted job.

## What's not done (scope boundary, not a gap)

- No frontend UI for triggering a backfill — it's a `curl`/API-only
  maintenance operation for now, matching the "manually triggered once per
  area path" use case. A frontend button could be added later if this
  becomes a recurring workflow rather than a one-time adoption step.
- No automatic re-backfill on a schedule — an operator re-running it
  periodically (or after a bulk manual import into ADO) is the assumed
  usage pattern, not a background job.

---

**This closes the 8th and final point from `docs/handoff.md`'s code
review.** All 8 points (on-prem hardening, large-file optimization,
hierarchy handling, hallucination guardrails, k8s readiness, and this
existing-item backfill) are now addressed in this worktree, each with its
own handoff doc and live-verified where a real dependency (ADO, Chroma,
docker) was reachable this session.
