# P4a — Trace/Coverage Link Types (Phase 4, part 1)

## Context

Roadmap Phase 4 bundles three independent subsystems: trace/coverage link types (this spec),
diff-vs-live-ADO + round-trip re-import (P4b, not yet designed), and baselining (P4c, not yet
designed). This spec covers P4a only.

Today req2ado writes exactly one relation type: `System.LinkTypes.Hierarchy-Reverse`
(parent→child), hardcoded in `mcp-ado-server/src/backends/realAdo.ts:159-170` and exposed via a
single-purpose MCP tool (`linkParentChildTool.ts`). No other link type exists anywhere in the
codebase (`docs/backend-capabilities.md:71-73`). This is confirmed net-new work, not an extension
of an existing generic mechanism.

**Driving use case**: the real-world pattern this exists to support is System Requirements
covering/tracing Customer Requirements — the same relationship DocGen's SysRS/SRS document pair
represents. A separate, unrelated MCP server (`elisra-mcp-ado`) already solved link-type discovery
and classification for DocGen's use case
(`elisra-mcp-ado/src/domain/adoLinkTypes.ts`, `mcp/tools/linkTypeTools.ts`) — this spec ports the
*pattern* (discover-live-with-seed-fallback, substring/exact classification, semantic hints), not
the code, into req2ado's own independently-built `mcp-ado-server`, per the existing architecture
decision that req2ado's MCP server is a fresh implementation
(`docs/requirements-traceability-matrix.md` §2.3).

**Scope: SURVEY mode only.** BASELINE mode has no LLM call anywhere in its pipeline
(`ingestion/app/leveling/tree_builder.py:109`, deterministic heading/numbering walk) and an
open-set link-type catalog cannot be reliably hand-mapped by regex — trace-link inference does not
run for BASELINE jobs; their trace-link list is always empty.

## Link-type scope: open catalog, closed per call

The catalog of usable link types is **not** fixed to a hardcoded set (e.g. not just
Covers/CoveredBy/Affects/AffectedBy) — it is whatever work-item link types the target ADO
project's process template actually exposes, discovered live per job. This matters because
different ADO projects/process templates can expose different custom relation types beyond the
Elisra CoveredBy pair.

Reliability constraint: the LLM backend behind `/llm/chat` (a local Ollama model via
`orchestrator_llm_client.py`) has no schema-constrained decoding — only prompt engineering + raw
`json.loads` + validation (same as today's `infer_hierarchy`/`generate_requirements_for_document`).
An unconstrained "pick anything" prompt over an open catalog would be unreliable. The resolution:
discover the real catalog **once per job**, then present that concrete, finite list as a closed
enum *within that one call's prompt* — same proven ergonomics as today's
Epic/Feature/Requirement-in-prompt pattern — and hard-validate the response against that same list
afterward. "Open catalog" and "reliable/testable" are reconciled by closing the set at
prompt-construction time from live data, not by hardcoding it at build time.

## Data model

New `TraceLink`, one list per job's tree (parallel to nodes, not embedded per-node — mirrors the
existing `kb_citations: list[str]` on `WorkItemTree`, avoiding a schema change to every node for a
feature most nodes won't use):

```
TraceLink {
  sourceLocalId: string          // local_id of the node this link is "on"
  referenceName: string          // real ADO rel, e.g. "Elisra.CoveredBy-Forward",
                                  // "System.LinkTypes.Affects-Forward"
  displayName: string            // catalog "name" for UI, e.g. "Covers"
  targetKind: 'intraJob' | 'crossJob'
  targetLocalId?: string         // set when targetKind = 'intraJob'
  targetCustomerId?: string      // set when targetKind = 'crossJob' — doc-cited customer id
  resolvedAdoId?: number         // filled once resolved
  resolutionStatus: 'resolved' | 'unresolved' | 'pending'
}
```

- Python: `WorkItemTree` (`ingestion/app/workitem/model.py:61-63`) gains `trace_links: list[TraceLink]`.
- TypeScript: `DryRunTreeNode`/`DryRunDiffEntry` (`orchestrator/src/modules/writeback/dry-run.service.ts`)
  carry the same list through unchanged to the frontend — no separate mapping layer.

Target semantics:

- **`intraJob`**: target is another node in the *same* job's tree. Doesn't have a real ADO id yet
  (only gets one on creation, same as any node) — `resolutionStatus: 'pending'` until confirm.
- **`crossJob`**: target is a work item confirmed by a *prior* job, cited in the source doc by the
  customer's own requirement-ID scheme (e.g. "REQ-SYS-012"), stored in ADO's `Custom.CustomerId`-style
  field (already runtime-resolved and written today — `jobs.service.ts:88` `resolveCustomerIdField`,
  `jobs.service.ts:239-289`). Resolved via `queryIds({customerIdField: targetCustomerId})`
  (`mcp-ado-server/src/backends/realAdo.ts:178`, `queryIdsTool.ts`) — same WIQL mechanism already
  used for dedup, just a different field filter.

## Link-type discovery (MCP)

New MCP tool `ado_discover_link_types` in `mcp-ado-server`:

- Live: `GET {orgUrl}/_apis/wit/workitemrelationtypes`, filtered to work-item links only (excludes
  `ArtifactLink`/`Hyperlink`/`AttachedFile` — mirrors `elisra-mcp-ado`'s `isWorkItemRel`).
- Fallback: small seed catalog (Hierarchy, Related, Affects/Affected By, Tested By/Tests, any
  project-custom types already known) if the live call fails — same discover-then-fallback shape
  as `resolveCustomerIdField`'s runtime field discovery (`jobs.service.ts:81-92`), not a new pattern.
- Each entry: `{referenceName, name, semanticHint?}` — semantic hints seeded for well-known types
  (e.g. "source item affects the target item" for `Affects-Forward`), absent for unrecognized
  project-custom types (LLM gets the name alone in that case).
- Orchestrator caches the discovered list **once per job**, not per link/item — same caching shape
  as `customerIdFieldByType` (`jobs.service.ts:243`). One live-catalog fetch per job, regardless of
  tree size.

## LLM link-type decision (SURVEY only)

One new batched call per job, `infer_trace_links`, sibling to `infer_hierarchy`
(`orchestrator_llm_client.py:86`) and `generate_requirements_for_document`
(`orchestrator_llm_client.py:121`) — same one-call-for-the-whole-document shape, not one call per
node:

- Input: full node list (id, type, title, text) + the discovered link-type catalog (filtered,
  with hints) + optional KB context via the existing `_with_kb_context` helper
  (`orchestrator_llm_client.py:29-35`), reused verbatim — RAG-first, optional, never blocks, per the
  project's core principle. No KB, or nothing relevant → LLM decides from doc content and the
  catalog alone.
- Prompt states explicitly: choose EXACTLY one `referenceName` from the supplied list, or omit the
  link entirely if nothing fits — closes the open catalog into a concrete enum for that one call.
- Output per link: `{sourceLocalId, targetRef: string, referenceName: string}` where `targetRef` is
  either a same-tree `node_id` or a doc-cited customer id string; which one it is gets decided by a
  cheap post-hoc check (matches a known `node_id` in this tree → `intraJob`; otherwise treated as a
  `crossJob` customer-id candidate).
- Validation: any `referenceName` not in the discovered catalog for this job is dropped — becomes
  an `unresolved` trace link (see Error handling), never retried, matching the project's "never
  block" pattern. Mirrors `elisra-mcp-ado`'s `metadataValidator` `UNKNOWN_LINK_TYPE` check as prior
  art for the same problem, reimplemented fresh here.
- Testability: deterministic given a fixed catalog + fixed doc text + `temperature: 0` (already
  used everywhere in this client) — same test-double shape as `test_llm_leveling.py`'s
  `FakeBatchedScoringClient`, no new test infrastructure required.

## Resolution & confirm-time write

MCP: generalize the existing single-purpose `linkParentChild` into a generic primitive:

- `AdoBackend.linkWorkItems(fromId: number, toId: number, referenceName: string): Promise<void>`
  (supersedes `linkParentChild(childId, parentId)` — the parent-child call becomes
  `linkWorkItems(childId, parentId, HIERARCHY_REVERSE)`, no behavior change to existing writes).
- `realAdo.ts:159-170`'s PATCH becomes parameterized on `rel` instead of hardcoded.

Resolution timing:

- `crossJob` targets: resolved at **dry-run build time**, via `queryIds`, so `resolvedAdoId`/
  `resolutionStatus` are known before the user ever sees the diff. Cached on the diff entry —
  confirm does not re-query.
- `intraJob` targets: `resolutionStatus: 'pending'` through dry-run, resolved to the sibling's real
  WI id during confirm, in the same tree-order loop that already links parent→child
  (`jobs.service.ts:319`) — trace-link writes fire immediately after that loop, once both endpoints
  have real ids.

## Error handling: unresolved links

Per the project's RAG-first "never blocks" philosophy, applied consistently here: an unresolved
trace link (bad/typo'd customer id, no such item confirmed yet, or a validation-dropped
`referenceName`) is **shown in the diff as unresolved, and confirm still proceeds** — the link is
simply not written; the rest of the tree (and all its other links) writes normally. Logged
server-side for operator follow-up. No blocking, no partial-tree rollback.

## Diff / review UI

- `DiffTree.tsx`: each row gets a small chip per trace link — `displayName → <target title or
  customer id>`. Muted/amber styling for `unresolved`, plain for `resolved`/`pending`. Read-only —
  no add/edit/override control for this slice (auto-inferred only, matching how the feature is
  sourced).
- `NodeDetailPanel.tsx`: full link list for the selected node (`referenceName` + resolution status),
  same visual weight as existing quality-issue chips.

## Out of scope (this slice)

- Manual link add/edit in the review UI (auto-inferred only).
- BASELINE-mode link inference (no LLM available; not attempted).
- Cross-job target resolution via anything other than the exact customer-ID field match (no fuzzy/
  semantic matching against prior items).
- Diff-vs-live-ADO tree traversal and baselining — P4b/P4c, separate specs.
