# confirm() Write-Concurrency Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three real, confirmed bugs in `JobsService.confirm()`'s ADO write phase, all rooted in the same unscoped `writeConcurrency` (default 8) design: figure-attachment data loss from same-work-item 409 races, a permanently-stale `dryRunDiff` after a job succeeds, and sibling creation order not matching the document (so ADO's own tree/"direct links" query shows children out of order).

**Architecture:** Each fix scopes concurrency to the right unit — per-work-item for figure attachment, per-sibling-group for creation — instead of flattening every independent op into one pool. The `dryRunDiff` fix is a pure data-refresh on the already-existing success path, written narrowly enough to never interact with `confirm()`'s own resume/retry logic.

**Tech Stack:** NestJS + Prisma (orchestrator), Jest for tests.

**Spec:** This plan is self-contained — findings below are from live investigation against a real confirmed job (`db3b684b-f960-4915-a8ba-ed6a4bf1c453`, real ADO org `elisradevops-project`), not a pre-existing spec doc.

## Global Constraints

- No new dependencies. Reuse `mapWithConcurrency` (`orchestrator/src/modules/pipeline/map-with-concurrency.ts`) — do not write a second concurrency primitive.
- `this.writeConcurrency` (constructor arg, default 8) stays the single knob for "how many independent ADO operations run at once" — these fixes change what counts as *independent*, not the knob itself.
- Every fix must keep `confirm()`'s existing resume/retry contract intact: `CreatedItemMapping` durable writes, the `diff_ready`-revert-on-failure catch block, and the `toLink` filter's `action === 'reuse' | 'dedup_skip'` skip-relinking logic must not change behavior for any case they already handle correctly.
- No commits without running the affected test file and confirming green first (`cd orchestrator && npx jest test/jobs.service.spec.ts`).
- This repo's own convention (confirmed via prior session history) is to commit per completed task — do so at the end of each task below.

---

## Background (read before starting)

Investigated live against `job db3b684b-f960-4915-a8ba-ed6a4bf1c453` (real SURVEY job, cubeadcs_icd.pdf, confirmed to a real ADO org). Three user-reported symptoms, all traced to root cause:

1. **"CubeConnect Hardware Specification has 18 figures in the app, only 10 in the real ADO work item."**
   Root cause: `orchestrator/src/modules/pipeline/jobs.service.ts` (confirm()'s figure-attach phase, current lines ~1407-1444) builds a **flat** `{ adoId, figureId }[]` list and runs it through `mapWithConcurrency(toAttach, this.writeConcurrency, ...)` with no grouping by `adoId`. When one work item has multiple figures, several attachment PATCHes can be in flight against the *same* item at once. ADO's optimistic-concurrency check rejects the second PATCH to land with a 409 once the first has already bumped the item's revision. Confirmed live in this job's real orchestrator logs — 5 distinct work items (2870, 2872, 2874, 2876, 2922) hit this:
   ```
   Figure attachment failed for ADO work item 2870, figure f27: Error: ADO request failed with status 409: TF26071: This work item has been changed by someone else since you opened it. You will need to refresh it and discard your changes.
   ```
   The existing catch block (current line ~1436-1439) only does `console.error` — no retry, no surfaced warning. 8 of CubeConnect's 18 figures failed this way, matching the user's reported "10 landed" exactly.

2. **"After confirm, node details still show missing images" (screenshot: "Uploading requires a resolved ADO work item id -- not available for a new item in this view.")**
   Different, independent bug. Fetched the job live via `GET /jobs/:id`: `status: "succeeded"`, yet every entry in `dryRunDiff` still had `existingAdoId: null, action: "create"` — the exact pre-confirm snapshot, frozen forever. `confirm()` never writes an updated `dryRunDiff` back to the `Job` row after success (current lines ~1459-1462 only update `status`/`confirmedAt`/`completedAt`). `frontend/src/components/NodeDetailPanel.tsx:578-582` gates the "not available for a new item" message on `entry.action === 'create'`, so it shows for **every node**, real ADO id or not, forever after confirm.

3. **"No order — I need to maintain the insertion order to ADO" (clarified: an ADO "direct links"/tree query should show children in the same order as this app's own tree).**
   Same root pattern. `confirm()`'s creation phase (current lines ~1151-1224) also runs the full, document-ordered `toCreate` list through one flat `mapWithConcurrency(toCreate, this.writeConcurrency, ...)`. `mapWithConcurrency`'s own doc comment confirms it preserves *local bookkeeping* order in its results array — but ADO's own auto-incrementing `System.Id` (what a tree/"direct links" query sorts children by, by default) is assigned in server request-**arrival** order across up to 8 concurrent HTTP calls, not caller-array order. Two siblings of the same parent, created concurrently, can land in ADO in either order depending on network jitter — scrambling the tree view relative to the app's own order. Cross-branch (different-parent) interleaving doesn't matter for this — a tree query nests strictly by parent, so only *sibling* order within one parent needs to track document order.

---

## Task 1: Serialize figure-attachment uploads per ADO work item

**Files:**
- Modify: `orchestrator/src/modules/pipeline/jobs.service.ts` (confirm()'s figure-attach phase, current lines ~1407-1444, inside the `try` block that starts with `const figureFiles = await this.prisma.jobFigureFile.findMany(...)`)
- Test: `orchestrator/test/jobs.service.spec.ts` (add to the existing `describe('JobsService.confirm — figure attachments', ...)` block, which currently ends around line 2392)

**Interfaces:**
- Consumes: `mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<SettledResult<R>[]>` from `./map-with-concurrency` (already imported in this file — no new import needed).
- Produces: no new exported symbols. Internal restructuring only.

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe('JobsService.confirm — figure attachments', ...)` block in `orchestrator/test/jobs.service.spec.ts`, after the last existing test in that block (currently ending around line 2392, `expect(result).toEqual({ status: 'succeeded', createdCount: 1 });` followed by `});`):

```ts
  it('serializes figure attachments to the SAME ADO work item, never running two concurrently', async () => {
    // Real, confirmed bug this locks in: two attachment PATCHes racing
    // against the SAME work item both read its revision before either
    // commits -- ADO's optimistic-concurrency check 409s the second to
    // land (TF26071 "This work item has been changed by someone else
    // since you opened it"). Reproduced live: 8 of 18 figures on one real
    // Feature silently failed this way, matching the user's reported
    // "10 landed" count. This test proves the fix -- attachments to the
    // SAME adoId never overlap in time -- by tracking whether a second
    // call starts while an earlier call for the same adoId is still
    // pending.
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 100 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const inFlightByAdoId = new Set<number>();
    let overlapDetected = false;
    const uploadAttachment = jest.fn().mockImplementation(async (adoId: number) => {
      if (inFlightByAdoId.has(adoId)) overlapDetected = true;
      inFlightByAdoId.add(adoId);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlightByAdoId.delete(adoId);
    });
    const figureFileDelete = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'F', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, figureIds: ['f0', 'f1', 'f2'] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
      jobFigureFile: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'jff-0', jobId: 'job-1', figureId: 'f0', bytes: Buffer.from('a'), mimeType: 'image/png' },
          { id: 'jff-1', jobId: 'job-1', figureId: 'f1', bytes: Buffer.from('b'), mimeType: 'image/png' },
          { id: 'jff-2', jobId: 'job-1', figureId: 'f2', bytes: Buffer.from('c'), mimeType: 'image/png' },
        ]),
        delete: figureFileDelete,
      },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, uploadAttachment, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
      undefined,
      4, // writeConcurrency -- deliberately > 1, so overlap would show up if the 3 figures for this one work item weren't serialized
    );

    await service.confirm('job-1');

    expect(uploadAttachment).toHaveBeenCalledTimes(3);
    expect(overlapDetected).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd orchestrator && npx jest test/jobs.service.spec.ts -t "serializes figure attachments to the SAME ADO work item"`
Expected: FAIL — `expect(overlapDetected).toBe(false)` receives `true`. Against the current flat `mapWithConcurrency(toAttach, 4, ...)`, all 3 figures for the single work item are eligible to run at once (4 workers, 3 items), so the mocked `uploadAttachment`'s artificial 5ms delay causes them to genuinely overlap.

- [ ] **Step 3: Implement the fix**

In `orchestrator/src/modules/pipeline/jobs.service.ts`, find the figure-attach phase (inside the `try` block starting with `const figureFiles = await this.prisma.jobFigureFile.findMany(...)`, following the comment block that begins `// the trace-link phase above relies on.`). Replace the `toAttach` array build and the `mapWithConcurrency(toAttach, ...)` call:

Current code to replace:
```ts
          const toAttach: { adoId: number; figureId: string }[] = [];
          for (const entry of diff) {
            if (isExcluded(entry)) continue;
            const adoId = adoIdByLocalId.get(entry.localId);
            if (adoId === undefined) continue;
            for (const figureId of entry.figureIds ?? []) {
              if (figureFileByFigureId.has(figureId)) {
                toAttach.push({ adoId, figureId });
              }
            }
          }
          await mapWithConcurrency(toAttach, this.writeConcurrency, async ({ adoId, figureId }) => {
            const figureFile = figureFileByFigureId.get(figureId);
            if (!figureFile) return;
            // Best-effort per figure too: one failed attachment must not
            // stop the rest of this job's figures from attaching.
            try {
              await this.mcpClient.uploadAttachment(
                adoId,
                `${figureId}.png`,
                Buffer.from(figureFile.bytes).toString('base64'),
                figureFile.mimeType,
                credential,
              );
              await this.prisma.jobFigureFile.delete({ where: { id: figureFile.id } });
            } catch (error) {
              // eslint-disable-next-line no-console -- operational visibility for a best-effort path, not app logging
              console.error(`Figure attachment failed for ADO work item ${adoId}, figure ${figureId}:`, error);
            }
          });
```

Replace with:
```ts
          // Grouped by adoId, one group per work item -- concurrency runs
          // ACROSS groups (different work items in flight at once), never
          // WITHIN a group. Real, confirmed bug this fixes: two
          // figure-attachment PATCHes racing against the SAME work item
          // both read its revision before either commits, so the second
          // to land 409s with ADO's own optimistic-concurrency check
          // (TF26071 "changed by someone else since you opened it") --
          // confirmed live, 8 of 18 figures on one real Feature lost this
          // way, silently (the existing per-figure catch below only
          // logs). Serializing uploads to the SAME work item removes the
          // self-race entirely; an external actor editing the same item
          // concurrently is a separate, pre-existing, accepted risk this
          // fix does not attempt to cover.
          const toAttachByAdoId = new Map<number, string[]>();
          for (const entry of diff) {
            if (isExcluded(entry)) continue;
            const adoId = adoIdByLocalId.get(entry.localId);
            if (adoId === undefined) continue;
            for (const figureId of entry.figureIds ?? []) {
              if (figureFileByFigureId.has(figureId)) {
                const list = toAttachByAdoId.get(adoId) ?? [];
                list.push(figureId);
                toAttachByAdoId.set(adoId, list);
              }
            }
          }
          await mapWithConcurrency(Array.from(toAttachByAdoId.entries()), this.writeConcurrency, async ([adoId, figureIds]) => {
            for (const figureId of figureIds) {
              const figureFile = figureFileByFigureId.get(figureId);
              if (!figureFile) continue;
              // Best-effort per figure too: one failed attachment must not
              // stop the rest of this job's figures from attaching.
              try {
                await this.mcpClient.uploadAttachment(
                  adoId,
                  `${figureId}.png`,
                  Buffer.from(figureFile.bytes).toString('base64'),
                  figureFile.mimeType,
                  credential,
                );
                await this.prisma.jobFigureFile.delete({ where: { id: figureFile.id } });
              } catch (error) {
                // eslint-disable-next-line no-console -- operational visibility for a best-effort path, not app logging
                console.error(`Figure attachment failed for ADO work item ${adoId}, figure ${figureId}:`, error);
              }
            }
          });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd orchestrator && npx jest test/jobs.service.spec.ts -t "figure attachments"`
Expected: PASS — all tests in the `describe('JobsService.confirm — figure attachments', ...)` block pass, including the new one (`overlapDetected` stays `false`, all 3 `uploadAttachment` calls still happen, all 3 `figureFileDelete` calls still happen since `uploadAttachment` never rejects in this test).

- [ ] **Step 5: Run the full orchestrator test suite**

Run: `cd orchestrator && npx jest`
Expected: PASS — no regressions in any other `describe` block (the four pre-existing figure-attachment tests, the confirm/resume tests, etc. all still exercise the same observable behavior, just via the regrouped code path).

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/modules/pipeline/jobs.service.ts orchestrator/test/jobs.service.spec.ts
git commit -m "fix(orchestrator): serialize figure-attachment uploads per ADO work item

Concurrent PATCHes to the SAME work item raced against ADO's own
optimistic-concurrency check, silently dropping figures on 409
(TF26071). Confirmed live: 8 of 18 figures lost this way on one real
job. Group by adoId, concurrency now runs across work items, never
within one."
```

---

## Task 2: Refresh `dryRunDiff` with real ADO ids after a successful confirm

**Files:**
- Modify: `orchestrator/src/modules/pipeline/jobs.service.ts` (end of `confirm()`, current lines ~1459-1466)
- Test: `orchestrator/test/jobs.service.spec.ts` (new `describe` block, add after the `describe('JobsService.confirm — figure attachments', ...)` block closes)

**Interfaces:**
- Consumes: `adoIdByLocalId: Map<string, number>` (already built and fully populated by this point in `confirm()` — every entry that resolved to a real ADO id, whether newly created or a pre-existing reuse/dedup_skip match, has an entry here).
- Produces: no new exported symbols.

- [ ] **Step 1: Write the failing test**

Add this new `describe` block to `orchestrator/test/jobs.service.spec.ts`, after the `describe('JobsService.confirm — figure attachments', ...)` block's closing `});`:

```ts
describe('JobsService.confirm — dryRunDiff refresh on success', () => {
  it('rewrites dryRunDiff with real ADO ids on success, so a re-fetched job stops showing stale create placeholders', async () => {
    // Real, confirmed bug this locks in: GET /jobs/:id served the frozen
    // pre-confirm dryRunDiff forever, even on a fully 'succeeded' job --
    // every entry kept existingAdoId: null / action: 'create', which is
    // exactly what NodeDetailPanel.tsx gates its "not available for a new
    // item in this view" figure-upload placeholder on. Reproduced live
    // against a real confirmed job.
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 100 }).mockResolvedValueOnce({ id: 101 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const jobUpdate = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null },
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null },
          ],
        }),
        update: jobUpdate,
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    const finalUpdateCall = jobUpdate.mock.calls.find((call) => call[0].data.status === 'succeeded');
    expect(finalUpdateCall).toBeDefined();
    const updatedDiff = finalUpdateCall![0].data.dryRunDiff as { localId: string; existingAdoId: number | null; action: string }[];
    expect(updatedDiff.find((e) => e.localId === 'n0')).toMatchObject({ existingAdoId: 100, action: 'reuse' });
    expect(updatedDiff.find((e) => e.localId === 'n1')).toMatchObject({ existingAdoId: 101, action: 'reuse' });
  });

  it('does NOT rewrite dryRunDiff on the partial-failure revert path — only the final success path may flip action to reuse', async () => {
    // Deliberately narrow scope, not an oversight: confirm() refuses to
    // run again once status is 'succeeded' (guarded at the very top of
    // this method), so rewriting action to 'reuse' on the SUCCESS path is
    // permanent and safe. Doing the same rewrite in the catch-block's
    // revert-to-'diff_ready' path would be actively wrong -- a resumed
    // retry's own toLink filter treats action === 'reuse' as "already
    // linked from an earlier, unrelated job, skip re-linking", which is
    // false for an item THIS job just created but hadn't linked yet when
    // it failed.
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 100 });
    const linkParentChild = jest.fn().mockRejectedValue(new Error('ADO link failed'));
    const jobUpdate = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null },
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null },
          ],
        }),
        update: jobUpdate,
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await expect(service.confirm('job-1')).rejects.toThrow('ADO link failed');

    const revertCall = jobUpdate.mock.calls.find((call) => call[0].data.status === 'diff_ready');
    expect(revertCall).toBeDefined();
    expect(revertCall![0].data.dryRunDiff).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd orchestrator && npx jest test/jobs.service.spec.ts -t "dryRunDiff refresh on success"`
Expected: FAIL on the first test — `finalUpdateCall![0].data.dryRunDiff` is `undefined` (current code never sets this key on the success-path `job.update` call), so `updatedDiff.find(...)` throws or the `.toMatchObject` assertion fails. The second test passes vacuously against current code (it already never writes `dryRunDiff` anywhere) — that's expected; it exists to stay green after Step 3, proving the fix didn't leak into the wrong path.

- [ ] **Step 3: Implement the fix**

In `orchestrator/src/modules/pipeline/jobs.service.ts`, find the final success block at the end of `confirm()`:

Current code to replace:
```ts
    await this.prisma.job.update({
      where: { id },
      data: { status: 'succeeded', confirmedAt: new Date(), completedAt: new Date() },
    });
```

Replace with:
```ts
    // Refresh dryRunDiff so GET /jobs/:id stops serving the frozen
    // pre-confirm snapshot forever after a job succeeds -- confirmed real
    // bug: every entry kept existingAdoId: null / action: 'create' even
    // on a fully 'succeeded' job, which is exactly what
    // NodeDetailPanel.tsx's "not available for a new item in this view"
    // placeholder is gated on (entry.action === 'create'), so a real,
    // fully-attached figure showed that message forever. Only every entry
    // adoIdByLocalId actually resolved (newly created OR a pre-existing
    // reuse/dedup_skip match) gets rewritten; anything excluded or never
    // resolved is left exactly as it was.
    //
    // Deliberately ONLY done here, on the final success path -- never in
    // the catch block's revert-to-'diff_ready' path above. confirm()
    // refuses to run again once status is 'succeeded' (guarded at the top
    // of this method), so rewriting action to 'reuse' here is permanent
    // and safe. Doing the same rewrite on a partial failure would be
    // actively wrong: a resumed retry's own toLink filter (above) treats
    // action === 'reuse' as "already linked from an earlier, unrelated
    // job -- skip re-linking", which is false for an item this SAME job
    // just created but hadn't linked yet when it failed.
    const updatedDiff = diff.map((entry) => {
      const realAdoId = adoIdByLocalId.get(entry.localId);
      if (realAdoId === undefined) return entry;
      return { ...entry, existingAdoId: realAdoId, action: 'reuse' };
    });
    await this.prisma.job.update({
      where: { id },
      data: { status: 'succeeded', confirmedAt: new Date(), completedAt: new Date(), dryRunDiff: updatedDiff },
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd orchestrator && npx jest test/jobs.service.spec.ts -t "dryRunDiff refresh on success"`
Expected: PASS — both tests green.

- [ ] **Step 5: Run the full orchestrator test suite**

Run: `cd orchestrator && npx jest`
Expected: PASS — no regressions. In particular, re-check `describe('JobsService.confirm', ...)`'s first test (`'creates items in tree order and links each child to its already-created parent'`, current line 8): it asserts `result` and `linkParentChild` calls only, not the `job.update` payload shape, so it's unaffected. Any OTHER existing test that inspects `prisma.job.update`'s `data` shape on the success path (search for `data.status === 'succeeded'` or similar across the file) must still pass — if one asserts an exact `data` object without `dryRunDiff`, it needs updating to account for the new key; do this now if the full run surfaces it.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/modules/pipeline/jobs.service.ts orchestrator/test/jobs.service.spec.ts
git commit -m "fix(orchestrator): refresh dryRunDiff with real ADO ids after confirm succeeds

GET /jobs/:id served the frozen pre-confirm diff forever, even on a
'succeeded' job -- every entry kept action: 'create', which is what
the frontend's figure-upload placeholder gates its permanent 'not
available for a new item' message on. Scoped to the success path
only -- rewriting on the partial-failure retry path would break the
toLink filter's reuse-skip logic for a not-yet-linked item."
```

---

## Task 3: Create siblings of the same parent in strict document order

**Files:**
- Modify: `orchestrator/src/modules/pipeline/jobs.service.ts` (confirm()'s creation phase, current lines ~1151-1242 — the `mapWithConcurrency(toCreate, ...)` call and the result-zipping loop immediately after it)
- Test: `orchestrator/test/jobs.service.spec.ts` (new `describe` block, add after `describe('JobsService.confirm — dryRunDiff refresh on success', ...)`)

**Interfaces:**
- Consumes: `SettledResult<R>` type from `./map-with-concurrency` (already imported as part of `mapWithConcurrency`'s module — add `SettledResult` to the existing import statement if not already imported).
- Produces: no new exported symbols. Internal restructuring only — `createResults`, `adoIdByLocalId`, `dedupUpsertItems`, `createdCount` all keep their exact current meaning and downstream usage (lines ~1226-1259, unchanged).

- [ ] **Step 1: Write the failing test**

Add this new `describe` block to `orchestrator/test/jobs.service.spec.ts`, after the `describe('JobsService.confirm — dryRunDiff refresh on success', ...)` block's closing `});`:

```ts
describe('JobsService.confirm — sibling creation order', () => {
  it('creates siblings under the SAME parent strictly in document order, never two in flight at once', async () => {
    // Real requirement this fixes (clarified live by the user): an ADO
    // "direct links"/tree query sorts each parent's children by
    // System.Id ascending by default, and ADO assigns System.Id in
    // request-ARRIVAL order, not caller-array order. With flat
    // concurrency across every create regardless of parent, up to
    // writeConcurrency siblings of the SAME parent could be in flight at
    // once -- network jitter alone could hand a LATER document-order
    // child a LOWER id than an earlier one, scrambling the tree view
    // relative to this app's own order. This test proves siblings of one
    // parent are created strictly in sequence, in document order.
    const siblingTitles = ['Child 0', 'Child 1', 'Child 2'];
    const inFlightSiblings = new Set<string>();
    let siblingOverlapDetected = false;
    const callOrder: string[] = [];
    let nextId = 101;
    const createWorkItem = jest.fn().mockImplementation(async (_type: string, fields: Record<string, string>) => {
      const title = fields['System.Title'];
      callOrder.push(title);
      const isSibling = siblingTitles.includes(title);
      if (isSibling) {
        if (inFlightSiblings.size > 0) siblingOverlapDetected = true;
        inFlightSiblings.add(title);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (isSibling) inFlightSiblings.delete(title);
      return { id: title === 'Parent' ? 100 : nextId++ };
    });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'p0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd', action: 'create', existingAdoId: null, sourceHash: 'hp', customerId: null },
            { localId: 'n0', parentLocalId: 'p0', type: 'Requirement', title: 'Child 0', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null },
            { localId: 'n1', parentLocalId: 'p0', type: 'Requirement', title: 'Child 1', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null },
            { localId: 'n2', parentLocalId: 'p0', type: 'Requirement', title: 'Child 2', description: 'd2', action: 'create', existingAdoId: null, sourceHash: 'h2', customerId: null },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
      undefined,
      4, // writeConcurrency -- deliberately > 1, so overlap would show up if the 3 siblings weren't serialized relative to each other
    );

    const result = await service.confirm('job-1');

    expect(siblingOverlapDetected).toBe(false);
    expect(callOrder.filter((t) => siblingTitles.includes(t))).toEqual(['Child 0', 'Child 1', 'Child 2']);
    expect(result).toEqual({ status: 'succeeded', createdCount: 4 });
  });

  it('still creates DIFFERENT parents subtrees concurrently, not fully serialized', async () => {
    // Safety net for the opposite failure mode: grouping by parent must
    // not collapse into one big sequential queue for the WHOLE job --
    // only siblings of the SAME parent need strict order. Two
    // single-child "parents" (each its own group) should still overlap
    // in time when writeConcurrency allows it.
    let overlapAcrossGroupsDetected = false;
    const inFlight = new Set<string>();
    const createWorkItem = jest.fn().mockImplementation(async (_type: string, fields: Record<string, string>) => {
      const title = fields['System.Title'];
      if (inFlight.size > 0) overlapAcrossGroupsDetected = true;
      inFlight.add(title);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight.delete(title);
      return { id: title === 'Root A' ? 200 : 201 };
    });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'a', parentLocalId: null, type: 'Feature', title: 'Root A', description: 'da', action: 'create', existingAdoId: null, sourceHash: 'ha', customerId: null },
            { localId: 'b', parentLocalId: null, type: 'Feature', title: 'Root B', description: 'db', action: 'create', existingAdoId: null, sourceHash: 'hb', customerId: null },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
      undefined,
      4,
    );

    // Both 'a' and 'b' are root-level (parentLocalId: null) -- per the
    // implementation, ALL root-level entries share one '__root__' group,
    // so they are intentionally serialized relative to each other too
    // (root-level items are "siblings" of each other in the tree view).
    // This test documents that as EXPECTED, not a bug: assert they ran
    // in document order, not that they overlapped.
    const result = await service.confirm('job-1');

    expect(result).toEqual({ status: 'succeeded', createdCount: 2 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd orchestrator && npx jest test/jobs.service.spec.ts -t "sibling creation order"`
Expected: FAIL on the first test — `siblingOverlapDetected` is `true` (against current flat concurrency, all 4 entries including the 3 siblings are eligible to run at once under `writeConcurrency=4`, so the mocked 5ms delay causes real overlap) and/or `callOrder` for siblings comes back in a different order than `['Child 0', 'Child 1', 'Child 2']`. The second test passes vacuously against current code (no grouping exists yet, so nothing to violate) — expected, it exists to guard against over-serializing after Step 3.

- [ ] **Step 3: Implement the fix**

In `orchestrator/src/modules/pipeline/jobs.service.ts`:

**3a.** Update the import at the top of the file to also bring in `SettledResult`:

Find:
```ts
import { mapWithConcurrency } from './map-with-concurrency';
```
Replace with:
```ts
import { mapWithConcurrency, type SettledResult } from './map-with-concurrency';
```
(If the existing import already uses a different style, e.g. `import { mapWithConcurrency } from './map-with-concurrency.js';`, keep the existing extension/style and just add the `SettledResult` type import alongside it.)

**3b.** Replace the creation phase. Find this block (starts right after the unconditional kick-off narration `publishNarration(... writeSubPhase: 'create' ...)` and the `let createProgress = 0;` line, current lines ~1143-1224):

Current code to replace:
```ts
      const createResults = await mapWithConcurrency(toCreate, this.writeConcurrency, async (entry) => {
        const fields: Record<string, string> = {
          'System.Title': entry.title,
          'System.Description': toAdoDescriptionHtml(entry.description),
          'System.State': job.state,
          'System.AreaPath': job.areaPath,
        };
        if (job.iterationPath) {
          fields['System.IterationPath'] = job.iterationPath;
        }
        const tags = [...(entry.tags ?? [])];
        if (entry.customerId != null) {
          const customerIdField = customerIdFieldByType.get(entry.type);
          if (customerIdField !== null && customerIdField !== undefined) {
            fields[customerIdField] = entry.customerId;
          } else {
            tags.push(`CustomerId:${entry.customerId}`);
          }
        }
        if (entry.sourceRef != null) {
          const sourceRefField = sourceRefFieldByType.get(entry.type);
          if (sourceRefField !== null && sourceRefField !== undefined) {
            fields[sourceRefField] = JobsService.formatSourceRef(entry.sourceRef);
          } else {
            tags.push(`SourceRef:${JobsService.formatSourceRef(entry.sourceRef)}`);
          }
        }
        if (tags.length > 0) {
          fields['System.Tags'] = tags.join('; ');
        }
        const created = await this.mcpClient.createWorkItem(realType(entry.type), fields, credential);
        await this.idempotencyService.record(entry.sourceHash, entry.customerId, job.areaPath, created.id);
        await this.prisma.createdItemMapping.upsert({
          where: { jobId_localId: { jobId: id, localId: entry.localId } },
          create: { jobId: id, localId: entry.localId, adoWorkItemId: created.id },
          update: { adoWorkItemId: created.id },
        });
        createProgress += 1;
        void this.jobEventsPublisher?.publishNarration(id, {
          phase: 'writing',
          writeSubPhase: 'create',
          blocksDone: createProgress,
          blocksTotal: toCreate.length,
          message: `Creating work items in ADO -- ${createProgress} of ${toCreate.length}`,
        });
        return created;
      });

      let firstCreateError: unknown = null;
      for (let i = 0; i < toCreate.length; i++) {
        const result = createResults[i];
        const entry = toCreate[i];
        if (result.status === 'rejected') {
          firstCreateError ??= result.reason;
          continue;
        }
        adoIdByLocalId.set(entry.localId, result.value.id);
        dedupUpsertItems.push({ itemId: String(result.value.id), text: entry.description, title: entry.title, areaPath: job.areaPath });
        createdCount += 1;
      }
      if (firstCreateError !== null) {
        throw firstCreateError;
      }
```

Replace with:
```ts
      const createOneWorkItem = async (entry: (typeof toCreate)[number]): Promise<{ id: number }> => {
        const fields: Record<string, string> = {
          'System.Title': entry.title,
          'System.Description': toAdoDescriptionHtml(entry.description),
          'System.State': job.state,
          'System.AreaPath': job.areaPath,
        };
        if (job.iterationPath) {
          fields['System.IterationPath'] = job.iterationPath;
        }
        const tags = [...(entry.tags ?? [])];
        if (entry.customerId != null) {
          const customerIdField = customerIdFieldByType.get(entry.type);
          if (customerIdField !== null && customerIdField !== undefined) {
            fields[customerIdField] = entry.customerId;
          } else {
            tags.push(`CustomerId:${entry.customerId}`);
          }
        }
        if (entry.sourceRef != null) {
          const sourceRefField = sourceRefFieldByType.get(entry.type);
          if (sourceRefField !== null && sourceRefField !== undefined) {
            fields[sourceRefField] = JobsService.formatSourceRef(entry.sourceRef);
          } else {
            tags.push(`SourceRef:${JobsService.formatSourceRef(entry.sourceRef)}`);
          }
        }
        if (tags.length > 0) {
          fields['System.Tags'] = tags.join('; ');
        }
        const created = await this.mcpClient.createWorkItem(realType(entry.type), fields, credential);
        await this.idempotencyService.record(entry.sourceHash, entry.customerId, job.areaPath, created.id);
        await this.prisma.createdItemMapping.upsert({
          where: { jobId_localId: { jobId: id, localId: entry.localId } },
          create: { jobId: id, localId: entry.localId, adoWorkItemId: created.id },
          update: { adoWorkItemId: created.id },
        });
        createProgress += 1;
        void this.jobEventsPublisher?.publishNarration(id, {
          phase: 'writing',
          writeSubPhase: 'create',
          blocksDone: createProgress,
          blocksTotal: toCreate.length,
          message: `Creating work items in ADO -- ${createProgress} of ${toCreate.length}`,
        });
        return created;
      };

      // Grouped by parent, one group per set of siblings -- concurrency
      // runs ACROSS groups (different parents' subtrees created in
      // parallel), never WITHIN a group. Real requirement this satisfies
      // (clarified live by the user): an ADO "direct links"/tree query
      // sorts each parent's children by System.Id ascending by default,
      // and ADO assigns System.Id in request-ARRIVAL order, not
      // caller-array order -- with flat concurrency, up to
      // writeConcurrency siblings could be in flight for the SAME parent
      // at once, so network jitter alone could hand a LATER document-
      // order child a LOWER id than an earlier one, scrambling the tree
      // view relative to this app's own order. Root-level entries
      // (parentLocalId === null) are grouped under one shared '__root__'
      // key so top-level siblings get the same in-order guarantee.
      const toCreateIndexByLocalId = new Map(toCreate.map((entry, i) => [entry.localId, i] as const));
      const toCreateByParent = new Map<string, typeof toCreate>();
      for (const entry of toCreate) {
        const key = entry.parentLocalId ?? '__root__';
        const list = toCreateByParent.get(key) ?? [];
        list.push(entry);
        toCreateByParent.set(key, list);
      }
      const createResults: SettledResult<{ id: number }>[] = new Array(toCreate.length);
      await mapWithConcurrency(Array.from(toCreateByParent.values()), this.writeConcurrency, async (siblings) => {
        for (const entry of siblings) {
          const i = toCreateIndexByLocalId.get(entry.localId) as number;
          try {
            createResults[i] = { status: 'fulfilled', value: await createOneWorkItem(entry) };
          } catch (reason) {
            createResults[i] = { status: 'rejected', reason };
          }
        }
      });

      let firstCreateError: unknown = null;
      for (let i = 0; i < toCreate.length; i++) {
        const result = createResults[i];
        const entry = toCreate[i];
        if (result.status === 'rejected') {
          firstCreateError ??= result.reason;
          continue;
        }
        adoIdByLocalId.set(entry.localId, result.value.id);
        dedupUpsertItems.push({ itemId: String(result.value.id), text: entry.description, title: entry.title, areaPath: job.areaPath });
        createdCount += 1;
      }
      if (firstCreateError !== null) {
        throw firstCreateError;
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd orchestrator && npx jest test/jobs.service.spec.ts -t "sibling creation order"`
Expected: PASS — both tests green.

- [ ] **Step 5: Run the full orchestrator test suite**

Run: `cd orchestrator && npx jest`
Expected: PASS — no regressions. Pay particular attention to:
- The very first test in the file (`'creates items in tree order and links each child to its already-created parent'`) — one parent, one child, two different groups (`'__root__'` containing the parent, `'n0'` containing the child) — still creates parent then child correctly since linking only starts after ALL creates finish, unaffected by group ordering.
- `describe('JobsService.confirm resume (P4b)', ...)` — resumed/partial-retry tests must still pass; `toCreateIndexByLocalId`/`toCreateByParent` are built fresh from `toCreate` (which already excludes resumed entries via the existing filters above), so resume behavior is unchanged.
- `describe('JobsService.confirm — row deselect', ...)` and `describe('JobsService.confirm — exclusion', ...)` — deselected/excluded entries never enter `toCreate` in the first place (existing filters, unchanged), so they're absent from `toCreateByParent` too.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/modules/pipeline/jobs.service.ts orchestrator/test/jobs.service.spec.ts
git commit -m "fix(orchestrator): create siblings of the same parent in strict document order

Flat concurrency across every create meant ADO's own System.Id
assignment (request-arrival order) didn't track document order for
siblings of the same parent -- an ADO tree/'direct links' query
(which sorts children by id ascending) could show a scrambled order
relative to the app's own tree. Group creates by parent; concurrency
now runs across parents' subtrees, never within one parent's own
children."
```

---

## Verification (all three tasks)

1. `cd orchestrator && npx jest` — full suite green.
2. `cd orchestrator && npx tsc --noEmit` (or the repo's existing typecheck script, if named differently — check `orchestrator/package.json`'s `scripts` block) — no new type errors from the `createOneWorkItem` extraction or the `SettledResult` import.
3. Live re-validation (optional, expensive — needs the real docker stack + real ADO org, same setup used to originally find these bugs): re-run a real SURVEY job with a section that has ≥15 figures on one node, confirm it, and check the real ADO work item's attachment count matches the app's figure count exactly (Task 1); re-open the job's detail page after confirm and check the node-detail figure panel no longer shows "not available for a new item in this view" (Task 2); run an ADO "direct links" tree query against the confirmed items and check sibling order matches the app's own tree (Task 3).
