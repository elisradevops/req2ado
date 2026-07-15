# P3a — Editable Dry-Run Diff (Phase 3, part 1)

## Context

Roadmap Phase 3 ("Review power") bundles three subsystems: editable dry-run diff, per-item AI
assist/chat, and source provenance display. Decomposed into three specs; this is the first —
editable diff — since it's a prerequisite for the other two (AI assist writes into edited state;
the deferred P2d learning loop needs real edit-diffs from a per-item accept/reject flow).

Today, `POST /jobs/:id/confirm` re-reads `job.dryRunDiff` (a DB JSON blob written once by the
pipeline worker) and takes no request body — there is no way to change a diff entry before
confirming.

## Reference

Work item types in play (`WorkItemType` enum: Epic/Feature/Requirement) map onto Azure DevOps'
[CMMI process template](https://learn.microsoft.com/en-us/azure/devops/boards/work-items/guidance/cmmi-process?view=azure-devops),
which defines Requirement, Change Request, Task, Bug, plus Epic/Feature at the portfolio level.
req2ado only creates Epic/Feature/Requirement today (`ingestion/app/leveling/profiles.py`'s
`type_for_depth`) — Change Request/Task/Bug are out of scope, no code path creates them.

**`type_for_depth(profile, depth)` cannot be re-run in the orchestrator as-is** — `profile`
(`tv_style`/`icd_style`) is resolved per-branch by `detect_profile_for_branch`
(`ingestion/app/leveling/autodetect.py`), so a single document can mix profiles across its tree,
and neither `profile` nor absolute depth ever reaches `WorkItemNode` today (computed transiently
in `tree_builder.py`, then discarded). Reimplementing the depth/profile table in TypeScript would
duplicate business logic across two languages. Instead: ingestion computes each node's
**`child_type`** once, at tree-build time (`type_for_depth(profile, depth+1)` — always resolves to
something, no None case, since a Requirement's own children are just more Requirements), and
carries it forward as an opaque field, the same "compute once in Python, pass through
TypeScript/React untouched" pattern already used for `tags`/`qualityScore`/`qualityIssues`.

## Data model

`WorkItemNode` (ingestion, `ingestion/app/workitem/model.py`) gains `child_type: WorkItemType` —
set in `tree_builder.py` alongside the existing `type=type_for_depth(profile, depth)` call, as
`type_for_depth(profile, depth + 1)`. Threaded through to `DryRunTreeNode`/`DryRunDiffEntry`
(orchestrator, `dry-run.service.ts`) as `childType`, same pass-through as `tags`/`qualityScore`.

`DryRunDiffEntry` and the persisted `job.dryRunDiff` blob also gain:

- `excluded: boolean` (default `false`) — unified delete/reject. No separate delete op: deleting
  an item and rejecting it are the same user intent (don't create this), so one field covers both.
- Manually-added entries: `action: 'create'`, `existingAdoId: null`, `similarity: null`,
  `qualityScore: null`, `qualityIssues: []` (no LLM scoring for hand-authored items — P2c's scoring
  pass already ran before the diff reached the UI). `childType: null` — a manually-added node's own
  next-level type isn't computable without ingestion's table, so it can't itself be the parent of
  another Add this round (see Out of scope). `sourceHash` is computed server-side at creation time
  using the same hash scheme ingestion uses (over title+description+areaPath+customerId), so
  idempotency/dedup keep working across job re-runs.

**Exclusion cascades transitively, computed at read time — never written to descendant rows.**
Excluding a node makes it and every descendant uncreatable regardless of the descendant's own
`excluded` value. `confirm()` walks the tree and treats a node as excluded if it or any ancestor
is excluded. This avoids stale-cascade-flag bugs from recursively writing `excluded=true` to N
descendant rows on every toggle — the tree walk is already there in `confirm()`'s ordered pass.

## Backend (orchestrator)

Autosave: each UI mutation is its own request, applied directly to the DB blob. No frontend
buffering, no new request body on `confirm()`.

- `PATCH /jobs/:id/diff/:localId` — body `{ title?, description? }`. 400 if the entry's
  `action !== 'create'` (edit is create-only — `reuse`/`dedup_skip` entries point at an existing
  ADO work item; editing their local copy would be a no-op on confirm, so it's rejected rather
  than silently ignored).
- `PATCH /jobs/:id/diff/:localId/exclude` — body `{ excluded: boolean }`. Any action type.
- `POST /jobs/:id/diff` — body `{ parentLocalId, type, title, description }`. Server validates
  `type === parentEntry.childType`; 400 on mismatch. 400 if `parentEntry.childType` is missing
  (only possible for a manually-added parent — see Out of scope: nesting under an added node).
- All three: 409 if `job.status !== 'diff_ready'` (no edits once confirm has started writing).
- `confirm()`: one change — skip any entry excluded itself or via ancestor, same `continue`
  pattern already used for `reuse`/`dedup_skip` (no `adoIdByLocalId` entry recorded, so any
  non-excluded child pointing at an excluded parent would fail loudly rather than silently
  create under a wrong/missing parent — should not happen if cascade exclusion is enforced in the
  UI, but the transitive check makes it structurally impossible regardless of UI state).

## Frontend

- `DiffTree` rows: exclude/include toggle icon on every node (dims/strikes the row when excluded,
  matching whatever muted-state styling `StatusChip`/`ActionBadge` already establish — no new
  visual language). Edit (pencil) icon only on nodes where `action === 'create' && !excluded`.
  "Add child" (plus) icon only where additionally `childType !== null` (excludes manually-added
  nodes as Add targets — see Out of scope).
- Edit: inline in `NodeDetailPanel` — title/description become editable fields + Save button,
  PATCHes `/diff/:localId` on save.
- Add: inline form anchored under the selected node (title, description, type dropdown
  pre-filled with the parent's `childType` — a single fixed option, not a free choice, since
  req2ado's hierarchy is a strict ladder).

## Testing

TDD. Touches ingestion (small: `child_type` field + its computation) in addition to orchestrator
and frontend.

- `test_tree_builder.py` (ingestion) — `child_type` set correctly per profile/depth, including a
  document with mixed profiles across branches.
- `dry-run.service.spec.ts` — `childType` passthrough (mirrors existing `qualityScore` passthrough
  tests), excluded skip, cascade-through-ancestor skip.
- `jobs.service.spec.ts` — confirm skips excluded entries, 409 on mutation attempts once
  `status !== 'diff_ready'`, 400 on editing a non-`create` entry, 400 on `type !== parentEntry.childType`,
  400 on adding under a node with `childType === null`.
- `DiffTree.test.tsx` / `NodeDetailPanel.test.tsx` — edit/add/exclude UI, icons hidden for
  non-`create`/excluded rows and for Add specifically when `childType === null`.
- One new golden-e2e scenario if `scripts/run-golden-e2e.sh` supports mutating the diff between
  `diff_ready` and `confirm` — exclude one node, add one manual node, confirm, assert ADO write
  reflects both changes.

## Out of scope (this spec)

- **Nesting under a manually-added node.** A manually-added entry's `childType` is `null` (its
  own next-level type isn't computable without ingestion's per-branch profile table), so it can't
  be an Add target — its "Add child" icon is hidden, and the backend 400s if attempted directly.
  Revisit if a real need for deeper manual nesting shows up.
- AI assist/chat per item, source provenance display — separate specs (Phase 3 parts 2 and 3).
- Re-scoring an edited item's quality score — P2c's scoring pass is a one-time whole-document call
  during ingestion; re-triggering it per edit is a future concern, not this spec.
- Change Request/Task/Bug work item types — CMMI defines them, req2ado doesn't create them today;
  no change to that scope here.
