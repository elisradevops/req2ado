# Handoff — Point 6: Hallucination guardrails

Source: `docs/handoff.md`'s code-review §6 ("Hallucination guardrails —
real gaps found"). All findings from that section are done, including
node_id grounding validation (folded into Point 5's work, see
`docs/handoff-point5-large-hierarchy-handling.md`).

## What changed

1. **`infer_hierarchy` node_id grounding validation** — done as part of
   Point 5 (`WorkItemTree.warnings`, hallucinated node_ids logged/counted
   instead of silently filtered). Not repeated here.

2. **Source-grounding check for generated requirement text** — the LLM's
   generated description was previously trusted verbatim with **zero**
   comparison against the source block it supposedly formalized. Added
   `WorkItemNode.grounding_score: float | None` (SURVEY-only) and a cheap,
   deterministic `_grounding_score(generated_text, source_text)` — word-set
   precision (what fraction of the generated text's own significant
   vocabulary, minus common requirement-boilerplate stopwords, actually
   appears in its source block), not an LLM call. Below 20% flags a
   job-level warning. The raw-display-text fallback (no generated
   requirement extracted) is trivially `1.0` — it IS its own source.
   (`ingestion/app/leveling/llm_leveling.py`, `ingestion/app/workitem/model.py`)

3. **`score_requirements_for_document` (quality scoring) built end-to-end**
   — didn't exist anywhere in this worktree (confirmed via grep before
   starting). Added:
   - `RequirementQualityIssue` (closed 7-value enum: ambiguous,
     not_testable, compound, missing_acceptance_criteria, vague_term,
     passive_voice, missing_rationale) and
     `WorkItemNode.quality_score`/`quality_issues` fields.
   - `OrchestratorLlmClient.score_requirements_for_document` — one batched
     LLM call per branch judging every node's FINAL formalized description
     against EARS/INCOSE/ISO/IEC/IEEE-29148 criteria baked into the prompt.
     **This worktree has no KB/retrieval subsystem** (confirmed absent
     earlier this session) to ground scoring against instead — noted
     explicitly in the docstring, not silently assumed away.
   - `build_survey_tree` gained an optional `scoring_client` param
     (default `None` — every pre-existing call site needed zero changes,
     byte-identical behavior when omitted). When supplied, scores every
     branch's nodes in one extra batched call per branch, tolerant of a
     missing/malformed/out-of-range entry for one node_id (falls back to
     `None`/`[]` for that node only, warns, never crashes the batch).
   - Threaded through the orchestrator: `DryRunTreeNode`/`DryRunDiffEntry`
     gained `groundingScore`/`qualityScore`/`qualityIssues`, populated in
     `pipeline.worker.ts`'s ingestion-response mapping and carried through
     every action branch (`create`/`reuse`/`dedup_skip`) in
     `DryRunService.diff()`.
   - `ingestion/app/main.py`'s `/level` route passes the same
     `OrchestratorLlmClient` instance as `scoring_client` (it already
     satisfies `LlmLevelingClient`/`BatchedRequirementClient`, and now
     `BatchedScoringClient` too — one real client, three Protocols).

4. **Frontend low-confidence visual flag** — this worktree's diff view is
   `frontend/src/pages/JobStatus.tsx` (no separate `DiffTree`/
   `NodeDetailPanel` component pair exists here — confirmed, this
   worktree's frontend predates that rebuild). Added a `Review` chip
   (amber, MUI `Chip`) rendered on any diff row where `groundingScore <
   0.2` or `qualityScore < 50`, with a tooltip naming the specific reason
   (low grounding percentage, or quality score + issue list). Both
   thresholds are named module-level constants, not inline magic numbers.

## Verification

- `ingestion`: `.venv/bin/python -m pytest` — 213/220 passing (7
  pre-existing, unrelated poppler failures — same count as every prior
  point this session). New coverage: 6 grounding-score unit tests (pure
  function), 3 `build_survey_tree` grounding-integration tests, 5
  quality-scoring tests (no-scoring-client default, batched call, closed
  vocabulary filtering, malformed/missing entry tolerance + warning,
  once-per-branch for multi-branch documents), 3
  `OrchestratorLlmClient.score_requirements_for_document` tests.
- `orchestrator`: `npx jest --forceExit` — 139/139 passing (was 137).
  Updated 2 pre-existing `pipeline.worker.spec.ts` assertions and all 9
  `dry-run.service.spec.ts` object literals for the 3 new
  `DryRunTreeNode`/`DryRunDiffEntry` fields; added 2 new pass-through
  regression tests (real non-null values surviving the full
  ingestion-response → diff-entry mapping, for both files).
- `frontend`: `npx vitest run` — 19/19 passing (was 15). 4 new
  `JobStatus.test.tsx` tests: low-grounding chip, low-quality chip with
  issues, no chip for a high-confidence entry, no chip/no crash for a
  BASELINE entry with `undefined` scoring fields (predates this
  capability). `npm run build`'s `tsc -b` step fails on every `.test.tsx`
  file including ones untouched by this round (e.g. `Wiki.test.tsx`) —
  confirmed pre-existing (a tsconfig gap: the build-step tsconfig doesn't
  include vitest's global types), not a regression from this work. Actual
  application source compiles cleanly (verified by filtering `tsc`'s
  output to non-test files).
- Not re-verified against the live ADO org or a real LLM this round —
  every change here is additive/config-gated (`scoring_client` optional,
  defaults preserve exact prior behavior) or a pure deterministic function
  with direct unit coverage.
