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
duplicate business logic across two languages. Instead: ingestion computes each BASELINE node's
**`child_type`** once, at tree-build time (`type_for_depth(profile, depth+1)` — always resolves to
something, no None case, since a Requirement's own children are just more Requirements), and
carries it forward as an opaque field, the same "compute once in Python, pass through
TypeScript/React untouched" pattern already used for `tags`/`qualityScore`/`qualityIssues`.

**This only applies to BASELINE mode.** SURVEY mode (`llm_leveling.py:build_survey_tree`) assigns
each node's `type` directly from the LLM's hierarchy-inference output (`WorkItemType(entry["type"])`)
— no depth, no profile, no fixed ladder invariant at all; the LLM is free to assign any
parent/child type combination. So `child_type` is never computed for SURVEY nodes (stays `None`
on `WorkItemNode`) — there is no single valid child type to derive. Add's type selector must
therefore behave differently per job mode: a fixed pre-filled option for BASELINE (derived from
`childType`), a free choice among all three types for SURVEY (no `childType` to constrain it).

## Data model

`WorkItemNode` (ingestion, `ingestion/app/workitem/model.py`) gains `child_type: WorkItemType` —
set in `tree_builder.py` alongside the existing `type=type_for_depth(profile, depth)` call, as
`type_for_depth(profile, depth + 1)`. Threaded through to `DryRunTreeNode`/`DryRunDiffEntry`
(orchestrator, `dry-run.service.ts`) as `childType`, same pass-through as `tags`/`qualityScore`.

`DryRunDiffEntry` and the persisted `job.dryRunDiff` blob also gain:

- `excluded: boolean` (default `false`) — unified delete/reject. No separate delete op: deleting
  an item and rejecting it are the same user intent (don't create this), so one field covers both.
- `isManual: boolean` (default `false`) — `true` only for entries created via the Add endpoint.
  Distinct from `childType === null`, which is *also* true for every real SURVEY-mode node (see
  Reference) — `isManual` is the actual "was this hand-authored" signal, independent of mode.
- Manually-added entries: `action: 'create'`, `existingAdoId: null`, `similarity: null`,
  `qualityScore: null`, `qualityIssues: []` (no LLM scoring for hand-authored items — P2c's scoring
  pass already ran before the diff reached the UI), `childType: null`, `isManual: true`. A
  manually-added node's own next-level type isn't computable (no ingestion table ran for it), so
  it can't itself be an Add target (see Out of scope) — enforced via `isManual`, not `childType`,
  since `childType` alone can't distinguish "manual node" from "real SURVEY node" (both null).
  `sourceHash` is computed server-side at creation time as `sha256(description)` — the exact
  scheme ingestion uses for `fidelity_hash` (`tree_builder.py`'s `_hash_description`,
  `llm_leveling.py`'s identical inline hash), which is what `DryRunTreeNode.sourceHash` is set from
  (`pipeline.worker.ts`). `customerId`/`areaPath` are separate fields in the idempotency lookup's
  compound key (`IdempotencyService.lookup`), not folded into the hash — so idempotency/dedup keep
  working across job re-runs without needing anything beyond the description hash.

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
- `POST /jobs/:id/diff` — body `{ parentLocalId, type, title, description }`. 400 if
  `parentEntry.isManual` (no nesting under a manually-added node — see Out of scope). Otherwise,
  validated per `job.mode`: **BASELINE** — `type === parentEntry.childType`, 400 on mismatch.
  **SURVEY** — `type` must be one of `Epic`/`Feature`/`Requirement` (any value, no ladder
  constraint — matches how SURVEY nodes are typed today), 400 on anything else.
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
  "Add child" (plus) icon only where additionally `!isManual` (excludes manually-added nodes as
  Add targets — see Out of scope; note this is `isManual`, not `childType`, since `childType` is
  null for every SURVEY node too).
- Edit: inline in `NodeDetailPanel` — title/description become editable fields + Save button,
  PATCHes `/diff/:localId` on save.
- Add: inline form anchored under the selected node (title, description, type selector). For a
  BASELINE job, pre-filled and fixed to the parent's `childType` (single option, matching the
  ladder). For a SURVEY job, a free dropdown of all three types (no `childType` to constrain it —
  matches how SURVEY assigns types today, see Reference).

## Testing

TDD. Touches ingestion (small: `child_type` field + its computation) in addition to orchestrator
and frontend.

- `test_tree_builder.py` (ingestion) — `child_type` set correctly per profile/depth, including a
  document with mixed profiles across branches.
- `dry-run.service.spec.ts` — `childType` passthrough (mirrors existing `qualityScore` passthrough
  tests), excluded skip, cascade-through-ancestor skip.
- `jobs.service.spec.ts` — confirm skips excluded entries, 409 on mutation attempts once
  `status !== 'diff_ready'`, 400 on editing a non-`create` entry, 400 on adding under an
  `isManual` parent, 400 on `type !== parentEntry.childType` for a BASELINE job, 400 on an invalid
  `type` value for a SURVEY job, 200 on any of the 3 types for a SURVEY job.
- `DiffTree.test.tsx` / `NodeDetailPanel.test.tsx` — edit/add/exclude UI, icons hidden for
  non-`create`/excluded rows and for Add specifically when `isManual`, type selector renders fixed
  vs free-dropdown per `job.mode`.
- One new golden-e2e scenario if `scripts/run-golden-e2e.sh` supports mutating the diff between
  `diff_ready` and `confirm` — exclude one node, add one manual node, confirm, assert ADO write
  reflects both changes.

## Out of scope (this spec)

- **Nesting under a manually-added node.** A manually-added entry's own next-level type isn't
  computable (no ingestion table ran for it), so it can't be an Add target (`isManual: true` gates
  this) — its "Add child" icon is hidden, and the backend 400s if attempted directly. Revisit if a
  real need for deeper manual nesting shows up.
- AI assist/chat per item, source provenance display — separate specs (Phase 3 parts 2 and 3).
- Re-scoring an edited item's quality score — P2c's scoring pass is a one-time whole-document call
  during ingestion; re-triggering it per edit is a future concern, not this spec.
- Change Request/Task/Bug work item types — CMMI defines them, req2ado doesn't create them today;
  no change to that scope here.
