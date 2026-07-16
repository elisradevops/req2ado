# P3c — Source Provenance Display (Phase 3, part 3)

## Context

Roadmap Phase 3 bundles three subsystems: editable dry-run diff (P3a, done), per-item AI
assist/chat (P3b, done), and source provenance display — this spec, the third. Purpose: show
where a generated item's content/score came from (KB doc, standard).

P2b (`retrieve_context()`, `ingestion/app/kb/retrieval.py`) runs exactly once per document inside
`build_survey_tree` (`ingestion/app/leveling/llm_leveling.py`), and the resulting `kb_context`
string is reused, unchanged, across all three SURVEY LLM calls: `infer_hierarchy`,
`generate_requirements_for_document`, and P2c's `score_requirements_for_document`. There is no
per-node retrieval — one job (one uploaded document) has exactly one KB-grounding state, shared by
every node in its tree. Provenance is therefore **job-level**, not per-node, matching the existing
retrieval architecture; per-node/per-chunk attribution would require re-architecting retrieval to
run per-node and is out of scope.

Separately, P2c's quality scoring always judges against EARS/INCOSE/ISO/IEC/IEEE 29148 criteria
baked into the system prompt (`orchestrator_llm_client.py:173`) — this is an always-on baseline,
not a fallback branch; `kb_context`, when present, is prepended as additive org-specific rules on
top of it. So quality-score provenance has two independent parts: a static standards line (always
true) and an optional KB-doc list (true only when the job's `kb_context` was non-null). Content
generation (hierarchy/description) has no standards baseline at all — only the optional KB list
applies there.

**Scope:** SURVEY mode only. BASELINE has no LLM/KB involvement anywhere in its pipeline — its
jobs always have an empty citation list and the Sources section does not render for them.

## Data model

`KbVectorStore.query()` (`ingestion/app/kb/kb_vector_store.py:91`) already returns `source_file`
per hit; unchanged. `retrieve_context()` currently discards hit metadata, returning only the
joined text. It changes to return `(context: str | None, citations: list[str])`:

- `citations` = unique `source_file` values from hits that survive the existing similarity cutoff
  (`distance <= max_distance`), dedup'd, order-preserving (first-seen order, nearest-first per the
  existing query ordering).
- Empty list when the collection is empty, no hit clears the bar, or the embed/query call raises
  (same failure-safe seam as today — an exception still yields `(None, [])`, never propagates).

`build_survey_tree` threads `citations` through unchanged and returns it once at the top of the
tree result (`WorkItemTree`, `ingestion/app/workitem/model.py`) as `kb_citations: list[str]` —
not attached to any individual `WorkItemNode`, since it's identical for every node in the tree.
Defaults to `[]` when `area_path`/`embed_client`/`vector_store` are omitted (matches every other
KB-optional parameter's default-empty behavior).

`POST /level`'s response gains `kb_citations: list[str]` alongside the existing `nodes` list
(`ingestion/app/main.py`).

Orchestrator: new Prisma field `Job.kbCitations String[] @default([])`
(`orchestrator/prisma/schema.prisma`). `pipeline.worker.ts` (~line 98) persists it in the same
write that sets `dryRunDiff`: `data: { status: 'diff_ready', dryRunDiff, kbCitations }`. Only
`/level`'s SURVEY-mode caller supplies a real (possibly empty) list; BASELINE jobs never call
`/level` with KB params, so `kbCitations` stays `[]` — the DB default already covers this, no
mode-branching needed in the worker.

`GET /jobs/:id` response gains `kbCitations: string[]`, read straight off the `Job` row — same
pattern as `mode`.

## Frontend

New "Sources" section in `NodeDetailPanel`, rendered only when the selected node's
`action === 'create'` and `job.mode === 'survey'` (mirrors P2c's `qualityScore` display gating —
`reuse`/`dedup_skip` entries and BASELINE jobs never show it):

- Always: a static line — "Judged against EARS, INCOSE, ISO/IEC/IEEE 29148" (standards baseline
  is always active for every SURVEY node's quality score, regardless of KB grounding).
- When `job.kbCitations.length > 0`: "KB references: " + the citation list (e.g.
  `doc1.docx, Sub/nested.docx`) — read directly off the already-loaded job object, no per-node
  fetch, since the list is identical for every node in the job.
- When `job.kbCitations` is empty: no KB line at all — omit, don't render an explicit
  "ungrounded" state (avoids noise on every node of every KB-less job).

No new API calls from the frontend: `kbCitations` rides along on the existing `GET /jobs/:id`
response already backing `JobDetail`/`NodeDetailPanel`.

## Testing

TDD.

- `test_retrieval.py` (ingestion) — `retrieve_context` returns `(context, citations)`; citations
  dedup'd and order-preserving across multiple hits from the same file; empty tuple element on
  empty collection, no-hit-clears-bar, and embed/query exception paths.
- `test_llm_leveling.py` — `build_survey_tree`'s `kb_citations` passthrough: populated when KB
  params supplied and hits survive, `[]` when KB params omitted, `[]` when KB params supplied but
  retrieval returns none.
- `test_main.py` (or existing `/level` test file) — response includes `kb_citations`.
- `pipeline-worker.spec.ts` (or wherever `pipeline.worker.ts` is covered) — `kbCitations`
  persisted alongside `dryRunDiff` on `diff_ready`.
- `jobs.service.spec.ts` / `jobs.controller.e2e-spec.ts` — `GET /jobs/:id` returns `kbCitations`.
- `NodeDetailPanel.test.tsx` — standards line always renders for SURVEY `create` nodes; KB line
  renders only when `kbCitations` non-empty; Sources section absent for `reuse`/`dedup_skip`
  entries and for BASELINE jobs.
- One golden-e2e SURVEY scenario with KB content pre-ingested, asserting the returned job's
  `kbCitations` is non-empty and contains the expected source file name.

## Out of scope (this spec)

- **Per-node/per-chunk citation attribution.** Would require retrieval to run per-node (or a
  chunk-to-node attribution mechanism) instead of once per document — a bigger change to P2b's
  retrieval architecture, not justified by current usage.
- **doc_type badges / linking citations to `IngestedDocument` rows.** `query()` could be extended
  to also return `doc_type`/`source_id` (both already in chunk metadata,
  `kb_vector_store.py:39-56`) for a richer citation (type badge, link to the KB page's document
  row), but the citation list stays doc-name-only for this spec.
- **P2d (learning-loop write-back).** Still deferred per the roadmap — this spec doesn't produce
  or consume any accept/reject signal; it only surfaces existing retrieval metadata that was
  already being computed and discarded.
