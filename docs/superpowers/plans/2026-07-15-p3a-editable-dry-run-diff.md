# P3a — Editable Dry-Run Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user edit/exclude/add dry-run diff entries before confirming a job, so BASELINE and SURVEY jobs both support inline correction instead of an all-or-nothing confirm.

**Architecture:** `job.dryRunDiff` is a single Prisma `Json?` blob (no per-entry DB rows) — every mutation is a read-modify-write of the whole array via `JobsService`. Exclusion cascades transitively at read time inside `confirm()`, never written to descendant rows. A BASELINE node's next-level type (`childType`) is precomputed once in ingestion and passed through untouched, mirroring how `tags`/`qualityScore` already flow from ingestion to the frontend; SURVEY nodes never get a `childType` (the LLM assigns types freely, no ladder), and neither does a manually-added node (flagged via a separate `isManual` boolean, since `childType === null` is true for both cases and can't disambiguate them).

**Tech Stack:** Python (ingestion, Pydantic model + pytest), NestJS/TypeScript (orchestrator, Jest), React/MUI (frontend, Vitest + Testing Library).

## Global Constraints

- No Prisma schema/migration changes — `dryRunDiff` stays `Json?`; new fields are TypeScript-interface-only.
- No new npm/pip dependencies.
- `sourceHash` for any new entry is `sha256(description)` — the exact scheme `fidelity_hash` already uses (`ingestion/app/leveling/tree_builder.py`'s `_hash_description`, `llm_leveling.py`'s identical inline hash).
- Existing `DryRunTreeNode`/`DryRunDiffEntry` fields (`localId`, `parentLocalId`, `type`, `title`, `description`, `action`, `existingAdoId`, `similarity`, `sourceHash`, `customerId`, `tags`, `qualityScore`, `qualityIssues`) are unchanged in shape — only new optional fields are added, so every existing test's `toEqual` assertion (which ignores `undefined`-valued keys) keeps passing untouched.

---

### Task 1: Ingestion — `child_type` field + BASELINE computation

**Files:**
- Modify: `ingestion/app/workitem/model.py` (`WorkItemNode` class, line 45)
- Modify: `ingestion/app/leveling/tree_builder.py` (`build_baseline_tree`, `_build_headingless_tree`)
- Test: `ingestion/tests/test_tree_builder.py`

**Interfaces:**
- Produces: `WorkItemNode.child_type: WorkItemType | None` — `None` for every SURVEY node (untouched, `llm_leveling.py` never sets it) and for BASELINE, always a concrete `WorkItemType`.

- [ ] **Step 1: Write the failing test**

Add to `ingestion/tests/test_tree_builder.py` (reuses the existing `_tv_style_doc()`/`_icd_style_doc()`/`_headingless_doc()` fixtures already in this file):

```python
def test_child_type_is_computed_one_level_deeper_per_node_tv_style() -> None:
    tree = build_baseline_tree(_tv_style_doc())
    child_types = [n.child_type for n in tree.nodes]
    assert child_types == [
        WorkItemType.EPIC,        # depth1 Epic -> depth2 is still Epic in tv_style
        WorkItemType.FEATURE,     # depth2 Epic -> depth3 is Feature
        WorkItemType.REQUIREMENT, # depth3 Feature -> depth4 is Requirement
        WorkItemType.REQUIREMENT, # depth4 Requirement -> depth5 stays Requirement
        WorkItemType.REQUIREMENT, # depth5 Requirement -> depth6 stays Requirement
    ]


def test_child_type_is_computed_one_level_deeper_per_node_icd_style() -> None:
    tree = build_baseline_tree(_icd_style_doc())
    child_types = [n.child_type for n in tree.nodes]
    assert child_types == [WorkItemType.REQUIREMENT, WorkItemType.REQUIREMENT]


def test_headingless_document_child_types_follow_the_synthetic_epic_feature_requirement_shape() -> None:
    tree = build_baseline_tree(_headingless_doc())
    epic, feature = tree.nodes[0], tree.nodes[1]
    requirements = tree.nodes[2:]
    assert epic.child_type == WorkItemType.FEATURE
    assert feature.child_type == WorkItemType.REQUIREMENT
    assert all(r.child_type == WorkItemType.REQUIREMENT for r in requirements)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && python -m pytest tests/test_tree_builder.py -k child_type -v`
Expected: FAIL with `AttributeError: 'WorkItemNode' object has no attribute 'child_type'`

- [ ] **Step 3: Add the field to `WorkItemNode`**

In `ingestion/app/workitem/model.py`, add one line to the `WorkItemNode` class (after `mode: WorkItemMode`):

```python
    mode: WorkItemMode
    child_type: WorkItemType | None = None
```

- [ ] **Step 4: Compute `child_type` in `build_baseline_tree`**

In `ingestion/app/leveling/tree_builder.py`, the node-construction call inside `build_baseline_tree`'s branch loop (currently ends `tags=[], mode=WorkItemMode.BASELINE,`) gains one line:

```python
            node = WorkItemNode(
                local_id=local_id,
                type=type_for_depth(profile, depth),
                parent_local_id=parent_local_id,
                title=extract_baseline_title(display_text),
                description=display_text,
                customer_id=customer_id,
                source_ref=block.source_ref,
                fidelity_hash=_hash_description(display_text),
                tags=[],
                mode=WorkItemMode.BASELINE,
                child_type=type_for_depth(profile, depth + 1),
            )
```

- [ ] **Step 5: Compute `child_type` in `_build_headingless_tree`**

Same file — the three `WorkItemNode(...)` constructions in `_build_headingless_tree` each gain a `child_type`:

```python
    epic = WorkItemNode(
        local_id="n0",
        type=WorkItemType.EPIC,
        parent_local_id=None,
        title=doc_title,
        description=doc_title,
        customer_id=customer_id,
        source_ref=first_source_ref,
        fidelity_hash=_hash_description(doc_title),
        tags=[],
        mode=WorkItemMode.BASELINE,
        child_type=WorkItemType.FEATURE,
    )
    feature = WorkItemNode(
        local_id="n1",
        type=WorkItemType.FEATURE,
        parent_local_id=epic.local_id,
        title=doc_title,
        description=doc_title,
        customer_id=customer_id,
        source_ref=first_source_ref,
        fidelity_hash=_hash_description(doc_title),
        tags=[],
        mode=WorkItemMode.BASELINE,
        child_type=WorkItemType.REQUIREMENT,
    )
    nodes: list[WorkItemNode] = [epic, feature]
    for index, block in enumerate(doc.blocks):
        description = block.text
        nodes.append(
            WorkItemNode(
                local_id=f"n{index + 2}",
                type=WorkItemType.REQUIREMENT,
                parent_local_id=feature.local_id,
                title=extract_baseline_title(description),
                description=description,
                customer_id=customer_id,
                source_ref=block.source_ref,
                fidelity_hash=_hash_description(description),
                tags=[],
                mode=WorkItemMode.BASELINE,
                child_type=WorkItemType.REQUIREMENT,
            )
        )
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd ingestion && python -m pytest tests/test_tree_builder.py -v`
Expected: all PASS (new + pre-existing)

- [ ] **Step 7: Commit**

```bash
git add ingestion/app/workitem/model.py ingestion/app/leveling/tree_builder.py ingestion/tests/test_tree_builder.py
git commit -m "feat(ingestion): compute WorkItemNode.child_type for BASELINE trees"
```

---

### Task 2: Orchestrator — thread `childType` through `DryRunTreeNode`/`DryRunDiffEntry`

**Files:**
- Modify: `orchestrator/src/modules/writeback/dry-run.service.ts`
- Test: `orchestrator/test/dry-run.service.spec.ts`

**Interfaces:**
- Consumes: nothing new from Task 1 directly (ingestion's `child_type` reaches the orchestrator via `pipeline.worker.ts`'s existing node-mapping — that mapping is untouched by this task; it already forwards unknown extra fields is NOT true, so this task's Step 3 below explicitly adds the mapping).
- Produces: `DryRunTreeNode.childType?: string | null`, `DryRunDiffEntry.childType?: string | null`, `DryRunDiffEntry.excluded?: boolean`, `DryRunDiffEntry.isManual?: boolean` — consumed by Task 3+.

- [ ] **Step 1: Write the failing test**

Add to `orchestrator/test/dry-run.service.spec.ts`:

```typescript
it('passes childType through on every action branch (create, reuse, dedup_skip)', async () => {
  (fakeIdempotencyService.lookup as jest.Mock).mockResolvedValue(null);
  const service = new DryRunService();
  const result = await service.diff(
    [
      {
        localId: 'n0', parentLocalId: null, type: 'Feature', title: 'T', description: 'D',
        sourceHash: 'h0', customerId: null, areaPath: 'Project\\Area1', tags: [],
        childType: 'Requirement',
      },
    ],
    fakeIdempotencyService,
  );
  expect(result[0].childType).toBe('Requirement');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd orchestrator && npx jest test/dry-run.service.spec.ts -t childType`
Expected: FAIL — `result[0].childType` is `undefined`, not `'Requirement'`

- [ ] **Step 3: Add the fields and thread them through**

In `orchestrator/src/modules/writeback/dry-run.service.ts`, extend both interfaces:

```typescript
export interface DryRunTreeNode {
  localId: string;
  parentLocalId: string | null;
  type: string;
  title: string;
  description: string;
  sourceHash: string;
  customerId: string | null;
  areaPath: string;
  tags: string[];
  qualityScore?: number | null;
  qualityIssues?: string[];
  childType?: string | null;
}

export interface DryRunDiffEntry {
  localId: string;
  parentLocalId: string | null;
  type: string;
  title: string;
  description: string;
  action: 'create' | 'reuse' | 'dedup_skip';
  existingAdoId: number | null;
  similarity: number | null;
  sourceHash: string;
  customerId: string | null;
  tags: string[];
  qualityScore?: number | null;
  qualityIssues?: string[];
  childType?: string | null;
  excluded?: boolean;
  isManual?: boolean;
}
```

Then add `childType: node.childType,` to all three `results.push({...})` call sites in `diff()` (the `reuse` branch, the `dedup_skip` branch, and the final `create` branch) — each already has `qualityScore: node.qualityScore, qualityIssues: node.qualityIssues,` as its last line; append `childType: node.childType,` right after it in all three.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd orchestrator && npx jest test/dry-run.service.spec.ts`
Expected: all PASS (new + pre-existing — pre-existing `toEqual` assertions still pass since they don't set `childType` on input nodes, so `undefined` is ignored by `toEqual`)

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/modules/writeback/dry-run.service.ts orchestrator/test/dry-run.service.spec.ts
git commit -m "feat(orchestrator): thread childType through DryRunTreeNode/DryRunDiffEntry"
```

---

### Task 3: Orchestrator — `pipeline.worker.ts` maps ingestion's `child_type` onto `childType`

**Files:**
- Modify: `orchestrator/src/modules/pipeline/pipeline.worker.ts`
- Test: `orchestrator/test/pipeline.worker.spec.ts`

**Interfaces:**
- Consumes: `WorkItemNode.child_type` (Task 1, arrives over the ingestion HTTP boundary as a JSON field `child_type`, since Python/Pydantic serializes snake_case).
- Produces: `LeveledNode.childType` (or equivalent field on whatever node-shaped type `pipeline.worker.ts` maps ingestion nodes into before calling `DryRunService.diff`) — consumed by Task 2's `diff()`.

- [ ] **Step 1: Read the current mapping to find the exact interface/line to extend**

Run: `grep -n "child_type\|quality_score\|LeveledNode\|sourceHash: node" orchestrator/src/modules/pipeline/pipeline.worker.ts`

This surfaces the existing `quality_score` → `qualityScore` mapping line (already confirmed at `pipeline.worker.ts:76`'s neighborhood, alongside `sourceHash: node.fidelity_hash`) — add `childType` as a sibling line in the same object-literal mapping, using the same `node.child_type` (snake_case) → `childType` (camelCase) rename pattern the existing `quality_score`/`qualityScore` mapping already uses.

- [ ] **Step 2: Write the failing test**

Find the existing test in `orchestrator/test/pipeline.worker.spec.ts` that asserts `qualityScore` is mapped from a `quality_score` input field, and add an equivalent assertion for `childType` from `child_type` in the same test case (same input fixture, same assertion style — do not create a new test, extend the existing mapping-fidelity test).

- [ ] **Step 3: Run test to verify it fails**

Run: `cd orchestrator && npx jest test/pipeline.worker.spec.ts`
Expected: FAIL — mapped node's `childType` is `undefined`

- [ ] **Step 4: Add the mapping line**

Add `childType: node.child_type,` immediately after the existing `qualityScore: node.quality_score,` line (or whatever the exact existing line reads) in the node-mapping object literal.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd orchestrator && npx jest test/pipeline.worker.spec.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/modules/pipeline/pipeline.worker.ts orchestrator/test/pipeline.worker.spec.ts
git commit -m "feat(orchestrator): map ingestion's child_type onto DryRunTreeNode.childType"
```

---

### Task 4: Orchestrator — `JobsService.setDiffEntryExcluded` + transitive-exclusion in `confirm()`

**Files:**
- Modify: `orchestrator/src/modules/pipeline/jobs.service.ts`
- Test: `orchestrator/test/jobs.service.spec.ts`

**Interfaces:**
- Produces: `JobsService.setDiffEntryExcluded(id: string, localId: string, excluded: boolean): Promise<DryRunDiffEntry[]>` — throws `NotFoundException` if job or entry not found, `ConflictException` if `job.status !== 'diff_ready'`. Returns the updated full diff array.
- Consumes/modifies: `confirm()`'s existing loop (unchanged otherwise) — adds an `isExcluded(entry)` helper walking `parentLocalId` ancestry.

- [ ] **Step 1: Write the failing tests**

Add to `orchestrator/test/jobs.service.spec.ts`:

```typescript
describe('JobsService.setDiffEntryExcluded', () => {
  it('flips excluded on the matching entry and persists the whole array', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: 'diff_ready',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'A', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null },
          ],
        }),
        update,
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.setDiffEntryExcluded('job-1', 'n0', true);

    expect(result[0].excluded).toBe(true);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: { dryRunDiff: [expect.objectContaining({ localId: 'n0', excluded: true })] },
    });
  });

  it('throws a conflict when the job is not diff_ready', async () => {
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'writing', dryRunDiff: [] }) },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    await expect(service.setDiffEntryExcluded('job-1', 'n0', true)).rejects.toThrow('not in a diff-editable state');
  });

  it('throws not found when the entry localId does not exist', async () => {
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', dryRunDiff: [] }) },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    await expect(service.setDiffEntryExcluded('job-1', 'missing', true)).rejects.toThrow('not found');
  });
});

describe('JobsService.confirm — exclusion', () => {
  it('skips an excluded entry and any child of it, even if the child itself is not excluded', async () => {
    const createWorkItem = jest.fn();
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, excluded: true },
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null, excluded: false },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn() } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntry: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1');

    expect(result).toEqual({ status: 'succeeded', createdCount: 0 });
    expect(createWorkItem).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd orchestrator && npx jest test/jobs.service.spec.ts -t "setDiffEntryExcluded|exclusion"`
Expected: FAIL — `setDiffEntryExcluded` is not a function; the confirm exclusion test creates both items since exclusion isn't checked yet

- [ ] **Step 3: Add `ConflictException`/`NotFoundException` imports and the new method**

At the top of `orchestrator/src/modules/pipeline/jobs.service.ts`, extend the import:

```typescript
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
```

Add this method to the `JobsService` class (near `getById`):

```typescript
  async setDiffEntryExcluded(id: string, localId: string, excluded: boolean): Promise<DryRunDiffEntry[]> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    if (job.status !== 'diff_ready') {
      throw new ConflictException(`Job ${id} is not in a diff-editable state`);
    }
    const diff = (job.dryRunDiff as DryRunDiffEntry[]) ?? [];
    const index = diff.findIndex((entry) => entry.localId === localId);
    if (index === -1) throw new NotFoundException(`Diff entry ${localId} not found`);
    diff[index] = { ...diff[index], excluded };
    await this.prisma.job.update({ where: { id }, data: { dryRunDiff: diff } });
    return diff;
  }
```

Add the `DryRunDiffEntry` import at the top of the file:

```typescript
import type { DryRunDiffEntry } from '../writeback/dry-run.service';
```

- [ ] **Step 4: Add the transitive-exclusion check to `confirm()`**

In `confirm()`, right after `const diff = job.dryRunDiff as {...}[];` (keep the existing inline type — this task doesn't need to change it since `excluded` is read via a helper, not the object type itself), add a helper and a skip check as the FIRST line inside the `for (const entry of diff)` loop (before the existing `reuse`/`dedup_skip` check):

```typescript
    const diffById = new Map(diff.map((entry) => [entry.localId, entry] as const));
    function isExcluded(entry: (typeof diff)[number]): boolean {
      let current: typeof entry | undefined = entry;
      while (current) {
        if ((current as unknown as { excluded?: boolean }).excluded) return true;
        current = current.parentLocalId ? diffById.get(current.parentLocalId) : undefined;
      }
      return false;
    }

    for (const entry of diff) {
      if (isExcluded(entry)) continue;
      // ... existing reuse/dedup_skip/create logic unchanged below ...
```

The second loop (parent/child linking) needs the same guard — add `if (isExcluded(entry)) continue;` as its first line too, right after the existing `if (entry.parentLocalId === null) continue;`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd orchestrator && npx jest test/jobs.service.spec.ts`
Expected: all PASS (new + pre-existing)

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/modules/pipeline/jobs.service.ts orchestrator/test/jobs.service.spec.ts
git commit -m "feat(orchestrator): add setDiffEntryExcluded + transitive exclusion in confirm()"
```

---

### Task 5: Orchestrator — `JobsService.editDiffEntry` (create-only, title/description)

**Files:**
- Modify: `orchestrator/src/modules/pipeline/jobs.service.ts`
- Test: `orchestrator/test/jobs.service.spec.ts`

**Interfaces:**
- Produces: `JobsService.editDiffEntry(id: string, localId: string, patch: { title?: string; description?: string }): Promise<DryRunDiffEntry[]>` — `NotFoundException` if job/entry missing, `ConflictException` if not `diff_ready`, `BadRequestException` if `entry.action !== 'create'`.

- [ ] **Step 1: Write the failing tests**

Add to `orchestrator/test/jobs.service.spec.ts`:

```typescript
describe('JobsService.editDiffEntry', () => {
  const baseEntry = { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Old', description: 'Old desc', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null };

  it('updates title and description on a create entry', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', dryRunDiff: [baseEntry] }),
        update,
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.editDiffEntry('job-1', 'n0', { title: 'New', description: 'New desc' });

    expect(result[0].title).toBe('New');
    expect(result[0].description).toBe('New desc');
  });

  it('rejects editing a reuse entry', async () => {
    const reuseEntry = { ...baseEntry, action: 'reuse', existingAdoId: 42 };
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', dryRunDiff: [reuseEntry] }) },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    await expect(service.editDiffEntry('job-1', 'n0', { title: 'New' })).rejects.toThrow('only create entries can be edited');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd orchestrator && npx jest test/jobs.service.spec.ts -t editDiffEntry`
Expected: FAIL — `editDiffEntry` is not a function

- [ ] **Step 3: Add the method**

```typescript
  async editDiffEntry(id: string, localId: string, patch: { title?: string; description?: string }): Promise<DryRunDiffEntry[]> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    if (job.status !== 'diff_ready') {
      throw new ConflictException(`Job ${id} is not in a diff-editable state`);
    }
    const diff = (job.dryRunDiff as DryRunDiffEntry[]) ?? [];
    const index = diff.findIndex((entry) => entry.localId === localId);
    if (index === -1) throw new NotFoundException(`Diff entry ${localId} not found`);
    if (diff[index].action !== 'create') {
      throw new BadRequestException('only create entries can be edited');
    }
    diff[index] = { ...diff[index], ...patch };
    await this.prisma.job.update({ where: { id }, data: { dryRunDiff: diff } });
    return diff;
  }
```

Extend the `@nestjs/common` import to include `BadRequestException`:

```typescript
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd orchestrator && npx jest test/jobs.service.spec.ts`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/modules/pipeline/jobs.service.ts orchestrator/test/jobs.service.spec.ts
git commit -m "feat(orchestrator): add JobsService.editDiffEntry (create-only)"
```

---

### Task 6: Orchestrator — `JobsService.addDiffEntry` (manual add, mode-aware type validation)

**Files:**
- Modify: `orchestrator/src/modules/pipeline/jobs.service.ts`
- Test: `orchestrator/test/jobs.service.spec.ts`

**Interfaces:**
- Produces: `JobsService.addDiffEntry(id: string, input: { parentLocalId: string; type: string; title: string; description: string }): Promise<DryRunDiffEntry[]>`.
- Validation: `NotFoundException` if job/parent entry missing, `ConflictException` if not `diff_ready`, `BadRequestException` if parent `isManual`, `BadRequestException` if BASELINE job and `type !== parentEntry.childType`, `BadRequestException` if SURVEY job and `type` not one of `Epic`/`Feature`/`Requirement`.

- [ ] **Step 1: Write the failing tests**

Add to `orchestrator/test/jobs.service.spec.ts`:

```typescript
describe('JobsService.addDiffEntry', () => {
  const parent = { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, childType: 'Requirement' };

  it('appends a new create entry with sha256(description) as sourceHash, for a matching BASELINE childType', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', mode: 'baseline', dryRunDiff: [parent] }),
        update,
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.addDiffEntry('job-1', { parentLocalId: 'n0', type: 'Requirement', title: 'New Req', description: 'New desc' });

    expect(result).toHaveLength(2);
    const added = result[1];
    expect(added.action).toBe('create');
    expect(added.parentLocalId).toBe('n0');
    expect(added.isManual).toBe(true);
    expect(added.childType).toBeNull();
    const crypto = require('crypto');
    expect(added.sourceHash).toBe(crypto.createHash('sha256').update('New desc').digest('hex'));
  });

  it('rejects a BASELINE add whose type does not match the parent childType', async () => {
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', mode: 'baseline', dryRunDiff: [parent] }) },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    await expect(
      service.addDiffEntry('job-1', { parentLocalId: 'n0', type: 'Feature', title: 'X', description: 'Y' }),
    ).rejects.toThrow('does not match');
  });

  it('accepts any of the three types for a SURVEY job', async () => {
    const surveyParent = { ...parent, childType: null };
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', mode: 'survey', dryRunDiff: [surveyParent] }),
        update,
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.addDiffEntry('job-1', { parentLocalId: 'n0', type: 'Epic', title: 'X', description: 'Y' });

    expect(result[1].type).toBe('Epic');
  });

  it('rejects an invalid type for a SURVEY job', async () => {
    const surveyParent = { ...parent, childType: null };
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', mode: 'survey', dryRunDiff: [surveyParent] }) },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    await expect(
      service.addDiffEntry('job-1', { parentLocalId: 'n0', type: 'Bug', title: 'X', description: 'Y' }),
    ).rejects.toThrow('must be one of');
  });

  it('rejects adding under a manually-added parent', async () => {
    const manualParent = { ...parent, isManual: true, childType: null };
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', mode: 'baseline', dryRunDiff: [manualParent] }) },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    await expect(
      service.addDiffEntry('job-1', { parentLocalId: 'n0', type: 'Requirement', title: 'X', description: 'Y' }),
    ).rejects.toThrow('manually-added');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd orchestrator && npx jest test/jobs.service.spec.ts -t addDiffEntry`
Expected: FAIL — `addDiffEntry` is not a function

- [ ] **Step 3: Add the method**

```typescript
  async addDiffEntry(
    id: string,
    input: { parentLocalId: string; type: string; title: string; description: string },
  ): Promise<DryRunDiffEntry[]> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    if (job.status !== 'diff_ready') {
      throw new ConflictException(`Job ${id} is not in a diff-editable state`);
    }
    const diff = (job.dryRunDiff as DryRunDiffEntry[]) ?? [];
    const parentEntry = diff.find((entry) => entry.localId === input.parentLocalId);
    if (!parentEntry) throw new NotFoundException(`Diff entry ${input.parentLocalId} not found`);
    if (parentEntry.isManual) {
      throw new BadRequestException('cannot add a child under a manually-added entry');
    }
    if (job.mode === 'baseline') {
      if (input.type !== parentEntry.childType) {
        throw new BadRequestException(`type '${input.type}' does not match the required child type '${parentEntry.childType}'`);
      }
    } else {
      const validTypes = ['Epic', 'Feature', 'Requirement'];
      if (!validTypes.includes(input.type)) {
        throw new BadRequestException(`type must be one of ${validTypes.join(', ')}`);
      }
    }
    const sourceHash = createHash('sha256').update(input.description).digest('hex');
    const newEntry: DryRunDiffEntry = {
      localId: `manual-${diff.length}-${Date.now()}`,
      parentLocalId: input.parentLocalId,
      type: input.type,
      title: input.title,
      description: input.description,
      action: 'create',
      existingAdoId: null,
      similarity: null,
      sourceHash,
      customerId: null,
      tags: [],
      qualityScore: null,
      qualityIssues: [],
      childType: null,
      isManual: true,
    };
    const updated = [...diff, newEntry];
    await this.prisma.job.update({ where: { id }, data: { dryRunDiff: updated } });
    return updated;
  }
```

Add the `createHash` import at the top of the file (mirrors `jobs.controller.ts`'s existing use of the same import for `sourceHash`):

```typescript
import { createHash } from 'crypto';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd orchestrator && npx jest test/jobs.service.spec.ts`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/modules/pipeline/jobs.service.ts orchestrator/test/jobs.service.spec.ts
git commit -m "feat(orchestrator): add JobsService.addDiffEntry with mode-aware type validation"
```

---

### Task 7: Orchestrator — wire the three new routes on `JobsController`

**Files:**
- Modify: `orchestrator/src/modules/pipeline/jobs.controller.ts`

**Interfaces:**
- Consumes: `JobsService.editDiffEntry`, `JobsService.setDiffEntryExcluded`, `JobsService.addDiffEntry` (Tasks 4-6).
- Produces: `PATCH /jobs/:id/diff/:localId`, `PATCH /jobs/:id/diff/:localId/exclude`, `POST /jobs/:id/diff`.

No new automated test in this task — this codebase has no controller-level unit tests for existing routes either (`confirm`, `getById` etc. are only covered by `JobsService`'s own spec file plus the golden-e2e script); Task 8 adds an e2e scenario that exercises these routes over real HTTP instead.

- [ ] **Step 1: Add the `Patch` import**

```typescript
import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Patch,
  PayloadTooLargeException,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
```

- [ ] **Step 2: Add the three route handlers**

Add these methods to `JobsController`, after `getById`:

```typescript
  @Patch(':id/diff/:localId')
  async editDiffEntry(
    @Param('id') id: string,
    @Param('localId') localId: string,
    @Body('title') title: string | undefined,
    @Body('description') description: string | undefined,
  ): Promise<{ dryRunDiff: unknown }> {
    const dryRunDiff = await this.jobsService.editDiffEntry(id, localId, { title, description });
    return { dryRunDiff };
  }

  @Patch(':id/diff/:localId/exclude')
  async setDiffEntryExcluded(
    @Param('id') id: string,
    @Param('localId') localId: string,
    @Body('excluded') excluded: boolean | undefined,
  ): Promise<{ dryRunDiff: unknown }> {
    if (typeof excluded !== 'boolean') {
      throw new BadRequestException('excluded must be a boolean');
    }
    const dryRunDiff = await this.jobsService.setDiffEntryExcluded(id, localId, excluded);
    return { dryRunDiff };
  }

  @Post(':id/diff')
  async addDiffEntry(
    @Param('id') id: string,
    @Body('parentLocalId') parentLocalId: string | undefined,
    @Body('type') type: string | undefined,
    @Body('title') title: string | undefined,
    @Body('description') description: string | undefined,
  ): Promise<{ dryRunDiff: unknown }> {
    if (!parentLocalId || !type || !title || !description) {
      throw new BadRequestException('parentLocalId, type, title, and description are all required');
    }
    const dryRunDiff = await this.jobsService.addDiffEntry(id, { parentLocalId, type, title, description });
    return { dryRunDiff };
  }
```

- [ ] **Step 3: Type-check and run the full orchestrator suite**

Run: `cd orchestrator && npx tsc --noEmit && npx jest`
Expected: type-check clean, all tests PASS (no existing test touches these new routes, so this is a regression check, not new coverage)

- [ ] **Step 4: Commit**

```bash
git add orchestrator/src/modules/pipeline/jobs.controller.ts
git commit -m "feat(orchestrator): wire edit/exclude/add diff routes on JobsController"
```

---

### Task 8: Frontend — API client functions

**Files:**
- Modify: `frontend/src/api/jobs.ts`
- Test: `frontend/src/api/jobs.test.ts` (create — no existing test file for this module today; check `frontend/src/api/` for an existing `.test.ts` naming convention first via `ls frontend/src/api/*.test.ts` before assuming none exist)

**Interfaces:**
- Produces: `editDiffEntry(jobId, localId, patch)`, `setDiffEntryExcluded(jobId, localId, excluded)`, `addDiffEntry(jobId, input)` — each returns `Promise<{ dryRunDiff: unknown }>`, matching the controller's response shape from Task 7.

- [ ] **Step 1: Check for an existing test convention**

Run: `ls frontend/src/api/*.test.ts 2>/dev/null || echo "none"`

If a convention exists, match its import/mock style exactly. If none exists (most likely, given no prior `api/*.test.ts` was found while researching this plan), write plain Vitest tests mocking `httpClient` the same way component tests mock props — no MSW/network layer, per this codebase's existing "hand-built plain mocks" testing philosophy (see `orchestrator/test/jobs.service.spec.ts`'s style, same philosophy applies frontend-side).

- [ ] **Step 2: Write the failing tests**

Create `frontend/src/api/jobs.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { httpClient } from './httpClient';
import { editDiffEntry, setDiffEntryExcluded, addDiffEntry } from './jobs';

vi.mock('./httpClient', () => ({ httpClient: { patch: vi.fn(), post: vi.fn() } }));

describe('diff mutation API functions', () => {
  it('editDiffEntry PATCHes title/description to the right URL', async () => {
    (httpClient.patch as any).mockResolvedValue({ data: { dryRunDiff: [] } });
    await editDiffEntry('job-1', 'n0', { title: 'New', description: 'New desc' });
    expect(httpClient.patch).toHaveBeenCalledWith('/jobs/job-1/diff/n0', { title: 'New', description: 'New desc' });
  });

  it('setDiffEntryExcluded PATCHes the exclude sub-route', async () => {
    (httpClient.patch as any).mockResolvedValue({ data: { dryRunDiff: [] } });
    await setDiffEntryExcluded('job-1', 'n0', true);
    expect(httpClient.patch).toHaveBeenCalledWith('/jobs/job-1/diff/n0/exclude', { excluded: true });
  });

  it('addDiffEntry POSTs to the diff collection route', async () => {
    (httpClient.post as any).mockResolvedValue({ data: { dryRunDiff: [] } });
    await addDiffEntry('job-1', { parentLocalId: 'n0', type: 'Requirement', title: 'T', description: 'D' });
    expect(httpClient.post).toHaveBeenCalledWith('/jobs/job-1/diff', { parentLocalId: 'n0', type: 'Requirement', title: 'T', description: 'D' });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/api/jobs.test.ts`
Expected: FAIL — `editDiffEntry`/`setDiffEntryExcluded`/`addDiffEntry` are not exported

- [ ] **Step 4: Add the functions**

Append to `frontend/src/api/jobs.ts`:

```typescript
export async function editDiffEntry(
  jobId: string,
  localId: string,
  patch: { title?: string; description?: string },
): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.patch(`/jobs/${jobId}/diff/${localId}`, patch);
  return response.data;
}

export async function setDiffEntryExcluded(jobId: string, localId: string, excluded: boolean): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.patch(`/jobs/${jobId}/diff/${localId}/exclude`, { excluded });
  return response.data;
}

export interface AddDiffEntryInput {
  parentLocalId: string;
  type: string;
  title: string;
  description: string;
}

export async function addDiffEntry(jobId: string, input: AddDiffEntryInput): Promise<{ dryRunDiff: unknown }> {
  const response = await httpClient.post(`/jobs/${jobId}/diff`, input);
  return response.data;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/api/jobs.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/jobs.ts frontend/src/api/jobs.test.ts
git commit -m "feat(frontend): add editDiffEntry/setDiffEntryExcluded/addDiffEntry API functions"
```

---

### Task 9: Frontend — `DiffTree` exclude toggle + edit/add icon gating

**Files:**
- Modify: `frontend/src/components/DiffTree.tsx`
- Test: `frontend/src/components/DiffTree.test.tsx`

**Interfaces:**
- Consumes: `editDiffEntry`/`setDiffEntryExcluded`/`addDiffEntry` are NOT called from `DiffTree` itself — this task only adds visual affordances (icons) and an `onToggleExclude` callback prop; the actual API call is wired in `JobDetail.tsx` in Task 11. `DiffTree`'s existing `onSelect` callback pattern is followed for the new callback.
- Produces: `DiffTree`'s exported `DryRunDiffEntry` interface gains `excluded?: boolean`, `isManual?: boolean`, `childType?: string | null`. New required prop `onToggleExclude: (localId: string, excluded: boolean) => void`.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/components/DiffTree.test.tsx`:

```typescript
it('renders an exclude toggle for every row and calls onToggleExclude with the flipped value', () => {
  const onToggleExclude = vi.fn();
  render(
    <DiffTree entries={ENTRIES} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={onToggleExclude} />,
  );
  const toggles = screen.getAllByRole('checkbox', { name: /exclude/i });
  expect(toggles).toHaveLength(ENTRIES.length);
  toggles[0].click();
  expect(onToggleExclude).toHaveBeenCalledWith('e1', true);
});

it('dims an excluded row', () => {
  const excludedEntries = [{ ...ENTRIES[0], excluded: true }, ...ENTRIES.slice(1)];
  render(
    <DiffTree entries={excludedEntries} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />,
  );
  expect(screen.getByText('Root Epic').closest('[data-excluded="true"]')).not.toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/DiffTree.test.tsx`
Expected: FAIL — no `onToggleExclude` prop, no checkbox rendered, `data-excluded` attribute doesn't exist

- [ ] **Step 3: Extend the interface and add the toggle**

In `frontend/src/components/DiffTree.tsx`:

```typescript
import { useMemo } from 'react';
import { FixedSizeList } from 'react-window';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Checkbox from '@mui/material/Checkbox';
import { ActionBadge } from './ActionBadge';
import { TagChips } from './TagChips';

export interface DryRunDiffEntry {
  localId: string;
  parentLocalId: string | null;
  type: string;
  title: string;
  description: string;
  action: 'create' | 'reuse' | 'dedup_skip';
  existingAdoId?: number | null;
  customerId: string | null;
  tags?: string[];
  qualityScore?: number | null;
  qualityIssues?: string[];
  childType?: string | null;
  excluded?: boolean;
  isManual?: boolean;
}
```

Add `onToggleExclude` to the component's props type and destructuring:

```typescript
export function DiffTree({
  entries,
  selectedId,
  onSelect,
  filterAction,
  filterText,
  onToggleExclude,
}: {
  entries: DryRunDiffEntry[];
  selectedId: string | null;
  onSelect: (localId: string) => void;
  filterAction: string | null;
  filterText: string;
  onToggleExclude: (localId: string, excluded: boolean) => void;
}): React.ReactElement {
```

Update the row rendering to add the checkbox and the dim styling:

```typescript
        return (
          <ListItemButton
            key={row.entry.localId}
            style={{ ...style, paddingLeft: row.depth * 16 + 16, opacity: row.entry.excluded ? 0.5 : 1 }}
            selected={row.entry.localId === selectedId}
            onClick={() => onSelect(row.entry.localId)}
            data-excluded={row.entry.excluded ? 'true' : 'false'}
          >
            <Checkbox
              aria-label="exclude"
              checked={!!row.entry.excluded}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onToggleExclude(row.entry.localId, e.target.checked)}
            />
            <ActionBadge action={row.entry.action} existingAdoId={row.entry.existingAdoId} />
            <ListItemText
              primary={row.entry.title}
              secondary={<TagChips tags={row.entry.tags} />}
              sx={row.entry.excluded ? { textDecoration: 'line-through' } : undefined}
            />
          </ListItemButton>
        );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/DiffTree.test.tsx`
Expected: all PASS (new + pre-existing — update the 3 pre-existing `render(<DiffTree ... />)` calls in this file to add `onToggleExclude={vi.fn()}`, since it's now a required prop)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/DiffTree.tsx frontend/src/components/DiffTree.test.tsx
git commit -m "feat(frontend): add exclude toggle + dim styling to DiffTree rows"
```

---

### Task 10: Frontend — `NodeDetailPanel` inline edit mode

**Files:**
- Modify: `frontend/src/components/NodeDetailPanel.tsx`
- Test: `frontend/src/components/NodeDetailPanel.test.tsx`

**Interfaces:**
- Produces: `NodeDetailPanel` gains an `onSave: (localId: string, patch: { title: string; description: string }) => void` prop (called when the user clicks Save in edit mode). Edit affordance (a Save button entering edit mode) only rendered when `entry.action === 'create' && !entry.excluded`.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/components/NodeDetailPanel.test.tsx`:

```typescript
it('shows an Edit button for a create entry and switches to editable fields on click', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const user = userEvent.setup();
  render(
    <NodeDetailPanel
      entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
      onSave={vi.fn()}
    />,
  );
  await user.click(screen.getByRole('button', { name: /edit/i }));
  expect(screen.getByDisplayValue('Req Title')).toBeInTheDocument();
  expect(screen.getByDisplayValue('Req body')).toBeInTheDocument();
});

it('calls onSave with the edited title/description', async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const user = userEvent.setup();
  const onSave = vi.fn();
  render(
    <NodeDetailPanel
      entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
      onSave={onSave}
    />,
  );
  await user.click(screen.getByRole('button', { name: /edit/i }));
  const titleField = screen.getByDisplayValue('Req Title');
  await user.clear(titleField);
  await user.type(titleField, 'Updated Title');
  await user.click(screen.getByRole('button', { name: /save/i }));
  expect(onSave).toHaveBeenCalledWith('e1', { title: 'Updated Title', description: 'Req body' });
});

it('does not show an Edit button for a reuse entry', () => {
  render(
    <NodeDetailPanel
      entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'reuse', existingAdoId: 42, customerId: null, tags: [] }}
      onSave={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
});
```

Add `vi` and `userEvent` to the test file's imports at the top (`import { describe, it, expect, vi } from 'vitest';` — `vi` isn't currently imported since no prior test in this file needed mocks). Check `frontend/package.json` for `@testing-library/user-event` before assuming it's available — if absent, use `fireEvent.change`/`fireEvent.click` from `@testing-library/react` instead (already imported) and drop the dynamic `userEvent` import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/NodeDetailPanel.test.tsx`
Expected: FAIL — no Edit button rendered, `onSave` prop not accepted

- [ ] **Step 3: Add edit mode**

Rewrite `frontend/src/components/NodeDetailPanel.tsx`:

```typescript
import { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import { TagChips } from './TagChips';
import { IssueChips } from './IssueChips';
import type { DryRunDiffEntry } from './DiffTree';

export function NodeDetailPanel({
  entry,
  onSave,
}: {
  entry: DryRunDiffEntry | null;
  onSave?: (localId: string, patch: { title: string; description: string }) => void;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDescription, setDraftDescription] = useState('');

  if (!entry) {
    return <Box p={2}><Typography color="text.secondary">Select a node to view details.</Typography></Box>;
  }

  const canEdit = entry.action === 'create' && !entry.excluded;

  function startEditing(): void {
    setDraftTitle(entry!.title);
    setDraftDescription(entry!.description);
    setEditing(true);
  }

  function save(): void {
    onSave?.(entry!.localId, { title: draftTitle, description: draftDescription });
    setEditing(false);
  }

  if (editing) {
    return (
      <Box p={2}>
        <Typography variant="overline">{entry.type}</Typography>
        <TextField
          fullWidth
          label="Title"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          margin="normal"
        />
        <TextField
          fullWidth
          multiline
          label="Description"
          value={draftDescription}
          onChange={(e) => setDraftDescription(e.target.value)}
          margin="normal"
        />
        <Button variant="contained" onClick={save}>Save</Button>
        <Button onClick={() => setEditing(false)}>Cancel</Button>
      </Box>
    );
  }

  return (
    <Box p={2}>
      <Typography variant="overline">{entry.type}</Typography>
      <Typography variant="h6">{entry.title}</Typography>
      <Typography variant="body2">{entry.description}</Typography>
      <TagChips tags={entry.tags} />
      {entry.qualityScore != null && (
        <>
          <Typography variant="body2">Quality score: {entry.qualityScore} / 100</Typography>
          <IssueChips issues={entry.qualityIssues} />
        </>
      )}
      {canEdit && <Button onClick={startEditing}>Edit</Button>}
    </Box>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/NodeDetailPanel.test.tsx`
Expected: all PASS (new + pre-existing)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/NodeDetailPanel.tsx frontend/src/components/NodeDetailPanel.test.tsx
git commit -m "feat(frontend): add inline edit mode to NodeDetailPanel"
```

---

### Task 11: Frontend — Add-child form + `JobDetail` wiring

**Files:**
- Create: `frontend/src/components/AddChildForm.tsx`
- Test: `frontend/src/components/AddChildForm.test.tsx`
- Modify: `frontend/src/pages/JobDetail.tsx`

**Interfaces:**
- Produces: `AddChildForm({ parentEntry, jobMode, onAdd }: { parentEntry: DryRunDiffEntry; jobMode: 'baseline' | 'survey'; onAdd: (input: { type: string; title: string; description: string }) => void }): React.ReactElement` — renders nothing if `parentEntry.isManual`; a fixed, disabled type field pre-filled with `parentEntry.childType` for BASELINE; a free `Select` of the 3 types for SURVEY.
- Consumes: `editDiffEntry`, `setDiffEntryExcluded`, `addDiffEntry` (Task 8) — wired into `JobDetail.tsx`'s existing `diff`/`setDiff` state, refetching via the existing `getJob` pattern already used after `handleConfirm`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/AddChildForm.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AddChildForm } from './AddChildForm';
import type { DryRunDiffEntry } from './DiffTree';

const BASELINE_PARENT: DryRunDiffEntry = {
  localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd',
  action: 'create', customerId: null, tags: [], childType: 'Requirement',
};

describe('AddChildForm', () => {
  it('renders nothing for a manually-added parent', () => {
    const { container } = render(
      <AddChildForm parentEntry={{ ...BASELINE_PARENT, isManual: true }} jobMode="baseline" onAdd={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('BASELINE: pre-fills and fixes the type to childType, calls onAdd with it on submit', () => {
    const onAdd = vi.fn();
    render(<AddChildForm parentEntry={BASELINE_PARENT} jobMode="baseline" onAdd={onAdd} />);
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'New Req' } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'New desc' } });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));
    expect(onAdd).toHaveBeenCalledWith({ type: 'Requirement', title: 'New Req', description: 'New desc' });
  });

  it('SURVEY: offers a free choice of all 3 types', () => {
    const surveyParent = { ...BASELINE_PARENT, childType: null };
    render(<AddChildForm parentEntry={surveyParent} jobMode="survey" onAdd={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: /type/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/AddChildForm.test.tsx`
Expected: FAIL — `./AddChildForm` module doesn't exist

- [ ] **Step 3: Write the component**

Create `frontend/src/components/AddChildForm.tsx`:

```typescript
import { useState } from 'react';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import type { DryRunDiffEntry } from './DiffTree';

const ALL_TYPES = ['Epic', 'Feature', 'Requirement'];

export function AddChildForm({
  parentEntry,
  jobMode,
  onAdd,
}: {
  parentEntry: DryRunDiffEntry;
  jobMode: 'baseline' | 'survey';
  onAdd: (input: { type: string; title: string; description: string }) => void;
}): React.ReactElement | null {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [surveyType, setSurveyType] = useState(ALL_TYPES[2]);

  if (parentEntry.isManual) return null;

  const type = jobMode === 'baseline' ? parentEntry.childType ?? '' : surveyType;

  function submit(): void {
    onAdd({ type, title, description });
    setTitle('');
    setDescription('');
  }

  return (
    <Box p={2}>
      {jobMode === 'baseline' ? (
        <TextField label="Type" value={type} disabled fullWidth margin="normal" />
      ) : (
        <TextField
          select
          label="Type"
          value={surveyType}
          onChange={(e) => setSurveyType(e.target.value)}
          fullWidth
          margin="normal"
          slotProps={{ select: { 'aria-label': 'Type' } as any }}
        >
          {ALL_TYPES.map((t) => (
            <MenuItem key={t} value={t}>{t}</MenuItem>
          ))}
        </TextField>
      )}
      <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth margin="normal" />
      <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} fullWidth multiline margin="normal" />
      <Button variant="contained" onClick={submit}>Add</Button>
    </Box>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/AddChildForm.test.tsx`
Expected: PASS. If the SURVEY combobox test fails on MUI's `Select` accessible-name resolution, use `screen.getByLabelText(/type/i)` instead of `getByRole('combobox', ...)` — adjust the test to whichever query MUI's rendered markup actually satisfies, don't change the component to fit a query that doesn't match how MUI renders `TextField select`.

- [ ] **Step 5: Wire into `JobDetail.tsx`**

In `frontend/src/pages/JobDetail.tsx`, import the new API functions and component:

```typescript
import { getJob, confirmJob, getAudit, editDiffEntry, setDiffEntryExcluded, addDiffEntry, type AuditEntry } from '../api/jobs';
import { AddChildForm } from '../components/AddChildForm';
```

Add three handlers (near `handleConfirm`):

```typescript
  async function handleToggleExclude(localId: string, excluded: boolean): Promise<void> {
    if (!id) return;
    const result = await setDiffEntryExcluded(id, localId, excluded);
    setDiff((result.dryRunDiff as DryRunDiffEntry[] | null) ?? []);
  }

  async function handleSaveEdit(localId: string, patch: { title: string; description: string }): Promise<void> {
    if (!id) return;
    const result = await editDiffEntry(id, localId, patch);
    setDiff((result.dryRunDiff as DryRunDiffEntry[] | null) ?? []);
  }

  async function handleAddChild(parentLocalId: string, input: { type: string; title: string; description: string }): Promise<void> {
    if (!id) return;
    const result = await addDiffEntry(id, { parentLocalId, ...input });
    setDiff((result.dryRunDiff as DryRunDiffEntry[] | null) ?? []);
  }
```

Pass `onToggleExclude={handleToggleExclude}` to `<DiffTree ... />`, `onSave={handleSaveEdit}` to `<NodeDetailPanel ... />`, and render `<AddChildForm parentEntry={selectedEntry} jobMode={mode as 'baseline' | 'survey'} onAdd={(input) => handleAddChild(selectedId!, input)} />` underneath `<NodeDetailPanel ... />` when `selectedId` is set and `status === 'diff_ready'` (define `const selectedEntry = diff.find((entry) => entry.localId === selectedId) ?? null;` once, reuse it for both `NodeDetailPanel` and the new conditional render, replacing the current inline `.find()` call).

- [ ] **Step 6: Type-check and run the full frontend suite**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: type-check clean, all tests PASS

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/AddChildForm.tsx frontend/src/components/AddChildForm.test.tsx frontend/src/pages/JobDetail.tsx
git commit -m "feat(frontend): add AddChildForm, wire edit/exclude/add into JobDetail"
```

---

### Task 12: Golden E2E — exclude + add + confirm, real ADO write

**Files:**
- Modify: `scripts/run-golden-e2e.sh` (only if it already supports post-diff_ready mutation before confirm — check first)

- [ ] **Step 1: Check whether the golden-e2e script has a hook for this**

Run: `grep -n "diff_ready\|confirm" scripts/run-golden-e2e.sh`

If the script only drives submit → poll-until-diff_ready → confirm with no mutation step in between, this task is a manual verification checklist instead of a script change — do not force a script change that doesn't fit its existing structure.

- [ ] **Step 2: Manual verification (if no scripted hook fits)**

With `docker compose up --build` running:
1. Submit a BASELINE job, wait for `diff_ready`.
2. `PATCH /jobs/:id/diff/:localId/exclude` with `{"excluded": true}` on one `create`-action node that has at least one child — via `curl` with the `X-Ado-Org-Url`/`X-Ado-Pat` headers `scripts/run-golden-e2e.sh` already uses.
3. `POST /jobs/:id/diff` with a valid `{parentLocalId, type, title, description}` (type matching the parent's `childType` from the `GET /jobs/:id` response).
4. `POST /jobs/:id/confirm`.
5. `GET /jobs/:id/audit` and confirm `createdCount` excludes the excluded subtree and includes the manually-added node.

Document the exact commands run and their output in the task's completion report (per this project's existing completion-report convention — see `docs/task-*-report.md` files referenced in memory) rather than only asserting "it worked."

- [ ] **Step 3: Commit (only if Step 1 found a script change was made)**

```bash
git add scripts/run-golden-e2e.sh
git commit -m "test: extend golden-e2e with a diff-mutation-before-confirm scenario"
```

---

## Self-Review Notes

- **Spec coverage:** Data model (`excluded`, `isManual`, `childType`, manual-entry defaults) → Tasks 1-2, 6. Backend routes (edit/exclude/add, 400/409 semantics) → Tasks 4-7. Confirm's transitive skip → Task 4. Frontend icons/edit/add UI → Tasks 9-11. Testing section → every task carries its own tests; golden-e2e → Task 12. Out-of-scope items (AI assist, provenance, re-scoring, CR/Task/Bug types, nesting under manual nodes) are correctly NOT implemented anywhere in this plan.
- **Type consistency:** `DryRunDiffEntry.excluded`/`isManual`/`childType` names match verbatim from Task 2 (orchestrator) through Task 9 (frontend) — no renaming drift. `editDiffEntry`/`setDiffEntryExcluded`/`addDiffEntry` names match verbatim across Tasks 4-6 (service), 7 (controller), 8 (API client), 11 (JobDetail wiring).
- **No placeholders:** every step has complete code, not descriptions of code.
