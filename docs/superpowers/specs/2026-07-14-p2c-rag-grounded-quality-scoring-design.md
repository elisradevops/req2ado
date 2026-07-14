# P2c — RAG-grounded quality scoring design

## Goal

Give every SURVEY-mode requirement a quality score and a list of flagged
issues, judged against org-specific rules/definitions retrieved from the
KB when available, falling back to general EARS/INCOSE/ISO-29148 criteria
(baked into the prompt, not a retrieval fallback) when no KB material
exists. Builds directly on P2b's retrieval-injection plumbing — reuses
the same per-document `kb_context`, adds no new retrieval call.

## Scope

- SURVEY mode only. Every node in every SURVEY job gets scored — no
  opt-in toggle, no size/mode threshold. BASELINE mode is untouched (no
  LLM calls today, this phase doesn't add any).
- One batched whole-document call, `score_requirements_for_document`,
  matching the existing "one call per document, not per node" pattern
  `generate_requirements_for_document` and `infer_hierarchy` already use.
- Scoring runs as a third call, after formalization — it scores the
  FINAL formalized description (what's actually written to ADO), not the
  raw block text. This is a separate call from `generate_requirements_for_document`,
  not merged into it: keeps formalization and scoring as distinct
  concerns/prompts/schemas.
- Reuses the SAME `kb_context` string already computed once per document
  by P2b's `retrieve_context` call inside `build_survey_tree` — no second
  retrieval, no doc_type filtering, no separate "rules-scoped" query.
- Fallback to public standards is NOT a second retrieval path — it's the
  system prompt's baseline instruction (EARS/INCOSE/ISO-29148 criteria,
  using the model's general knowledge), always present. `kb_context`,
  when non-None, is prepended the same way P2b's existing calls do —
  org-specific rules supplement the baseline, they don't replace it.

## Components

### `BatchedScoringClient` Protocol (new, `app/leveling/llm_leveling.py`)

```python
class BatchedScoringClient(Protocol):
    """Interface for whole-document SURVEY quality scoring — one call
    covering every node's FINAL formalized description, mirroring
    BatchedRequirementClient's batching rationale (one call per document,
    not one per node)."""

    def score_requirements_for_document(
        self, descriptions_by_node_id: dict[str, str], kb_context: str | None = None
    ) -> dict[str, dict]: ...
```

Response shape per node_id: `{"score": int, "issues": list[str]}`. A
node_id absent from the response, or present with a malformed `score`
(non-int, out of 0-100 range) or malformed `issues` (non-list, non-string
entries), is tolerated exactly like today's tag/hierarchy handling:
that node's `quality_score` stays `None` and `quality_issues` stays `[]`
— never crash the whole job over one bad entry. A totally malformed
top-level JSON response (not parseable at all) raises `ValueError`,
same precedent as `generate_requirements_for_document` today.

### `OrchestratorLlmClient.score_requirements_for_document` (new method, `app/survey/orchestrator_llm_client.py`)

Same shape as `generate_requirements_for_document`: one `POST /llm/chat`
call, `temperature=0`, system prompt instructs the model to score each
node_id's description against EARS/INCOSE/ISO-29148 criteria (clarity,
testability, atomicity, no ambiguous terms, single requirement per
statement) on a 0-100 scale, returning zero or more short issue labels
per node (e.g. `"ambiguous"`, `"not testable"`, `"compound requirement"`,
`"missing acceptance criteria"`). Reuses `_with_kb_context` (added in
P2b's Task 3) to prepend `kb_context` when present — org rules are
additive to the baseline standards instruction, not a replacement branch.

### `build_survey_tree` (modified, `app/leveling/llm_leveling.py`)

After the existing formalization loop produces each node's final
`description`, builds `descriptions_by_node_id = {node_id: node.description
for node_id in ...}` and calls `scoring_client.score_requirements_for_document(descriptions_by_node_id,
kb_context=kb_context)` once — reusing the same `kb_context` variable
already computed for the other two calls (P2b's Global Constraint "one
retrieval per document" is honored: scoring adds zero new retrieval
calls, only one new LLM call). Gains a new optional parameter `scoring_client: BatchedScoringClient
| None = None`. (Correction from an earlier draft of this spec: a
required param would have forced touching all ~15 existing
`build_survey_tree` call sites in tests for no real benefit — optional
is fully additive, matching P2b's precedent. Semantically, scoring still
has no KB-availability-dependent skip branch — it runs whenever a
`scoring_client` is supplied, independent of `kb_context` being `None`
or not — this is just about whether the Python parameter itself is
required.) When `scoring_client` is `None` (as every pre-existing test
call site is), scoring is skipped entirely: every node's `quality_score`
stays `None` and `quality_issues` stays `[]`. `app/main.py`'s `/level`
route (the one real production caller) always supplies a real
`OrchestratorLlmClient` instance as `scoring_client` — the same instance
already used for `llm_client`/`requirement_client`, since one instance
satisfies all three Protocols.

### `WorkItemNode` (modified, `app/workitem/model.py`)

Two new optional fields:

```python
quality_score: int | None = None
quality_issues: list[RequirementQualityIssue] = Field(default_factory=list)
```

`RequirementQualityIssue` is a new closed enum (mirrors `RequirementTag`'s
`str, Enum` pattern) rather than a free-string list, so the frontend can
apply consistent chip coloring/labels without guessing at arbitrary LLM
output strings:

```python
class RequirementQualityIssue(str, Enum):
    AMBIGUOUS = "ambiguous"
    NOT_TESTABLE = "not_testable"
    COMPOUND = "compound"
    MISSING_ACCEPTANCE_CRITERIA = "missing_acceptance_criteria"
    VAGUE_TERM = "vague_term"
    PASSIVE_VOICE = "passive_voice"
    MISSING_RATIONALE = "missing_rationale"
```

These seven map directly to the standard EARS/INCOSE/ISO-29148 quality
criteria named in the system prompt (testability, atomicity, unambiguous
language, active voice, traceable rationale). An issue string from the
LLM response that doesn't match any enum value is dropped (same
tolerant-parsing philosophy as `RequirementTag` values today), not an
error.

BASELINE-mode nodes: `quality_score` stays `None`, `quality_issues` stays
`[]` — untouched, matching existing behavior for all BASELINE fields
that don't apply to it (e.g. `tags` is also always `[]` for BASELINE
today).

### Orchestrator (`orchestrator/src/modules/pipeline/pipeline.worker.ts`, `dry-run.service.ts`)

`DryRunDiffEntry` gains `qualityScore?: number | null` and
`qualityIssues?: string[]`, threaded through the same
`tree.nodes.map((node) => ({...}))` block that already maps `tags` today
(pipeline.worker.ts). No schema/DB change needed — `dryRunDiff` is stored
as a JSON blob on the Job row (per existing `DryRunDiffEntry` handling),
so new optional fields are additive with no migration.

### Frontend (`frontend/src/components/`)

- New `IssueChips.tsx` component, structurally mirroring `TagChips.tsx`
  (same `Stack`/`Chip` pattern) but with its own color mapping
  (`issueColor` util, mirroring `tagColors.ts`'s pattern) since issue
  labels are a different vocabulary from `RequirementTag`.
- `NodeDetailPanel.tsx` gains a score display (e.g. `Typography` showing
  `{score}/100` when `entry.qualityScore != null`) and renders
  `<IssueChips issues={entry.qualityIssues} />` below the existing
  `<TagChips tags={entry.tags} />` line. Detail-panel-only — the
  `DiffTree` tree rows are unchanged, keeping row density as-is.
- `DryRunDiffEntry` interface (`DiffTree.tsx`) gains the two optional
  fields to match the orchestrator's shape.

## Error handling

- Per-node tolerance: a missing/malformed score or issues list for one
  node_id never affects sibling nodes — same philosophy as today's
  tag/text extraction in `build_survey_tree`.
- Whole-response malformed JSON: `ValueError`, same as
  `generate_requirements_for_document`'s existing precedent — a job-level
  failure, not swallowed.
- No new failure mode from KB reuse: `kb_context` is already `None`-safe
  by construction (P2b), scoring adds no new way for KB unavailability to
  cause a job failure.

## Testing

- `OrchestratorLlmClient.score_requirements_for_document`: prompt
  construction (baseline standards instruction always present, kb_context
  prepended when supplied), malformed-JSON raises, per-node tolerant
  parsing.
- `build_survey_tree`: scoring called exactly once per document (not per
  node), same `kb_context` value passed to it as the other two calls,
  `quality_score`/`quality_issues` correctly populated on nodes, malformed
  per-node entries fall back to `None`/`[]`, BASELINE-mode nodes unaffected
  (no scoring client invoked for BASELINE — `build_baseline_tree` is a
  separate code path untouched by this phase).
- Orchestrator: `pipeline.worker.ts` test asserting `qualityScore`/
  `qualityIssues` thread through into `DryRunDiffEntry` alongside `tags`.
- Frontend: `IssueChips` render test, `NodeDetailPanel` test asserting
  score + issue chips render when present and are absent/omitted when
  `quality_score` is `None`.

## Out of scope (future phases)

- P2d (learning-loop write-back of confirmed/accepted items into the KB).
- Editable/re-scoreable items from the review UI (Phase 3's per-item
  chat/refine work may eventually trigger re-scoring; not this phase).
- Org-authored custom scoring rubrics beyond what's already retrievable
  from the KB via the existing per-document `kb_context`.
