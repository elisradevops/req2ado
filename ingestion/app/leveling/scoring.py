from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from app.debug_capture import DebugCapture

from app.leveling.bounded_chunks import run_chunks_bounded
from app.leveling.narration_publisher import LevelingProgress, Phase, ProgressCallback, _sample_titles
from app.quality.criteria_retrieval import CriteriaRetriever
from app.workitem.model import (
    IntegrityWarning,
    KbCitation,
    QualityCategoryScores,
    QualityConfidence,
    RequirementQualityIssue,
    WarningKind,
    WorkItemNode,
    WorkItemType,
)

logger = logging.getLogger(__name__)


class BatchedScoringClient(Protocol):
    """Interface for whole-document (or whole-branch) SURVEY quality
    scoring — one call judging every node's FINAL formalized description
    against EARS/INCOSE/ISO/IEC/IEEE-29148 criteria, not one call per node.
    Fully optional in build_survey_tree (a None scoring_client, the
    default, means no scoring at all — byte-identical to before this
    capability existed).

    `criteria_context` is optional retrieval-grounded reference material
    (see app.quality.criteria_retrieval.CriteriaRetriever) -- when supplied,
    a real implementation should cite it in the judgment instead of relying
    solely on the model's own parametric knowledge of the public standards.
    `kb_context` is the SAME SharePoint/OneDrive KB context already computed
    for infer_hierarchy/generate_requirements_for_document, threaded through
    for consistency across all three calls. Both grounding params are
    independent and orthogonal -- one grounds against customer content, the
    other against quality-criteria reference material -- and either or both
    may be omitted (None), byte-identical to before either capability
    existed.

    `category_checklist` is a FIXED categoryScores key list extracted once
    at KB ingestion time (see KbVectorStore.get_quality_checklist) -- a
    genuine cross-run determinism guarantee, taking priority over
    `kb_context`'s own live-derive fallback. Optional; omitting it is
    byte-identical to before this capability existed."""

    def score_requirements_for_document(
        self,
        descriptions_by_node_id: dict[str, str],
        criteria_context: str | None = None,
        kb_context: str | None = None,
        category_checklist: list[str] | None = None,
    ) -> dict[str, dict]: ...


def _build_criteria_context(criteria_retriever: CriteriaRetriever, nodes: list[WorkItemNode]) -> str:
    """Retrieves the top-k criteria most relevant to this BRANCH's nodes as a
    whole (one retrieve() call on the concatenated descriptions, not one per
    node -- see CriteriaRetriever's docstring for why), formatted as plain
    reference text the scoring prompt can cite. Empty string if the branch's
    nodes have no description text at all (nothing to retrieve against)."""
    combined_text = " ".join(node.description for node in nodes if node.description)
    if not combined_text.strip():
        return ""
    criteria = criteria_retriever.retrieve(combined_text)
    return "\n".join(f"- {c.issue.value}: {c.text}" for c in criteria)


# §2c: output-token budget derived cap, not an arbitrary round number --
# _MAX_OUTPUT_TOKENS (orchestrator_llm_client.py) is 20_000; a scoring
# response entry (score + up to 7 issue tags + a 5-field categoryScores
# breakdown) runs ~80 tokens/node observed live, and reserving 40% of the
# cap for JSON structural overhead (braces, keys, node_id strings) leaves
# room for ~150 nodes before a single call risks truncation.
_SCORING_CHUNK_NODE_COUNT = 150


def _score_all_requirements(
    nodes: list[WorkItemNode],
    scoring_client: BatchedScoringClient,
    warnings: list[IntegrityWarning],
    criteria_retriever: CriteriaRetriever | None,
    kb_context: str | None,
    kb_citations: list[KbCitation],
    progress_callback: ProgressCallback | None,
    model_name: str | None,
    blocks_total: int,
    branch_count: int,
    category_checklist: list[str] | None = None,
    category_checklist_definitions: dict[str, str] | None = None,
    # How many of this pass's independent chunks may be in flight at once
    # (see app.config.Settings.survey_chunk_concurrency). 1 (the default)
    # is the byte-identical previous behavior.
    chunk_concurrency: int = 1,
) -> None:
    """Whole-document quality scoring (§2c redesign): replaces the old
    one-batched-call-per-branch design with one (or, for a very large
    document, a handful of chunked) call(s) over every Requirement-type node
    across the WHOLE document -- fewer, larger LLM calls instead of many
    small ones, the same token-efficiency motivation as this module's other
    batching decisions. `nodes` mutated in place via _apply_quality_scores,
    same as before.

    `criteria_context` is built ONCE here (over every requirement node's
    description, not per chunk) -- see _build_criteria_context's own
    per-call docstring for why a single retrieve() call over the combined
    text is preferred to one per node; doing it once here instead of once
    per chunk is the same principle applied one level up.

    Chunked by _SCORING_CHUNK_NODE_COUNT so a document with hundreds of
    requirement nodes doesn't risk one call's output being truncated by the
    model's output-token cap (see that constant's own docstring). A
    document with <= that many requirement nodes (the common case) makes
    exactly one call, byte-identical in spirit to the old per-branch design
    when there was only one branch.

    Deduplicates by description text BEFORE chunking (confirmed real bug: a
    document that restates the same content twice -- e.g. a body section
    and its appendix duplicate -- produced byte-identical descriptions on
    different nodes that landed in DIFFERENT 150-node chunks and came back
    with wildly different scores, 85 vs 20 observed live, since a chunk's
    score is dominated by its neighboring context, not the item alone at
    temperature=0. Only ONE representative per unique description is ever
    sent to the model; every other node sharing that exact text gets the
    SAME result copied over afterward, making the score a genuine property
    of the text again, not of which chunk it happened to land in.

    `category_checklist_definitions` (see KbVectorStore.
    get_quality_checklist_definitions), when supplied, is passed straight
    through to _apply_quality_scores per chunk to build each node's own
    quality_category_checklist -- see _match_category_checklist's own
    docstring for the matching heuristic.

    Chunks may run concurrently, bounded by `chunk_concurrency` (see
    app.config.Settings.survey_chunk_concurrency). Determinism is preserved
    structurally: the client call is the only work off the calling thread,
    outcomes come back by chunk INDEX rather than completion order, and
    every mutation, warning append, and narration event happens in the
    fixed-order merge loop -- so scores, warning order, and the narration
    stream are byte-identical to a serial run. Per-chunk fail-soft is
    unchanged."""
    if not nodes:
        return
    criteria_context = (
        _build_criteria_context(criteria_retriever, nodes)
        if criteria_retriever is not None
        else None
    )
    kb_citations_raw = [
        {"source_file": c.source_file, "similarity": c.similarity} for c in kb_citations
    ]
    nodes_by_description: dict[str, list[WorkItemNode]] = {}
    for node in nodes:
        nodes_by_description.setdefault(node.description, []).append(node)
    representative_nodes = [group[0] for group in nodes_by_description.values()]
    # Known upfront -- unlike figure/table totals (not known until parsing
    # finishes walking the document), every representative node to score is
    # already in hand before this loop starts, so chunk_index/chunk_count
    # and nodes_done/nodes_total below are real progress, not a guess.
    total_nodes = len(representative_nodes)
    total_chunks = -(-total_nodes // _SCORING_CHUNK_NODE_COUNT) if total_nodes else 0

    def _fire(
        phase: Phase, chunk: list[WorkItemNode], nodes_done: int, chunk_index: int, issues_found: int | None = None,
    ) -> None:
        if progress_callback is None:
            return
        progress_callback(
            LevelingProgress(
                # branch_index=None + the document's REAL branch_count (not
                # hardcoded 1) -- SectionStepList's rendering (ProgressBanner.tsx)
                # derives its section-count display from the latest event's
                # own branchCount, so hardcoding 1 here would visibly shrink
                # the section list to 1 for the duration of scoring.
                phase=phase, branch_index=None, branch_count=branch_count,
                # Real cumulative node-scoring progress -- previously always
                # blocks_done=blocks_total (fabricated 100%), confirmed live
                # as actively misleading (the UI showed a "done" chip while
                # scoring was still running). nodes_done/total_nodes IS a
                # real, known-upfront count now.
                blocks_done=nodes_done, blocks_total=total_nodes,
                kb_grounded=bool(kb_context), kb_citations=kb_citations_raw,
                model=model_name, draft_count=len(chunk), issues_found=issues_found,
                # Real titles for (a prefix of) this chunk -- previously only
                # a bare count ("150 drafted requirement(s)") with no way to
                # tell which actual items were being scored.
                sample_titles=_sample_titles([n.title for n in chunk]),
                chunk_index=chunk_index, chunk_count=total_chunks,
            )
        )

    # PHASE 1 -- chunk construction on the calling thread, in document
    # order. The per-chunk PRE-dispatch narration event is NOT fired here:
    # it fires from the merge loop below, immediately before that chunk's
    # outcome is pulled (run_chunks_bounded is lazy, so pulling is what
    # performs the call at chunk_concurrency=1). Firing every chunk's event
    # here instead would emit them all back-to-back before the first call
    # even started -- and the frontend derives its "batch N of M" chip and
    # its percentage from the LAST narration event it received, so that
    # reads as an instant jump to ~100% followed by a multi-minute freeze,
    # not as progress. Narration stays on the calling thread either way
    # (never inside a worker), which is what keeps it in document order
    # with no lock -- the same reasoning
    # llm_leveling._map_figures_tables_to_nodes' _fire_map_scope already
    # documents for its own concurrent batches.
    chunks: list[list[WorkItemNode]] = []
    for start in range(0, len(representative_nodes), _SCORING_CHUNK_NODE_COUNT):
        chunk = representative_nodes[start : start + _SCORING_CHUNK_NODE_COUNT]
        chunks.append(chunk)

    # PHASE 2 -- the worker. _apply_quality_scores both appends warnings and
    # fires progress_callback of its own (SCORING_MISSING,
    # SCORING_INCONSISTENT_CATEGORIES), so it is given a per-chunk LOCAL
    # warnings list and a COLLECTING callback here; the merge loop below
    # replays both into the shared list / real callback in chunk order. This
    # is what keeps the warning order and narration order byte-identical to
    # a serial run without changing _apply_quality_scores' own signature.
    #
    # The worker DOES mutate nodes -- _apply_quality_scores writes
    # `quality_score`/`quality_issues`/`quality_category_scores` on the
    # nodes it is given. That is safe only because each chunk is a DISJOINT
    # slice of `representative_nodes`, so no two workers can ever touch the
    # same node. The duplicate-scoring fan-out below reads and writes nodes
    # OUTSIDE the chunk (every other node sharing a representative's
    # description) and must therefore stay in the merge loop -- moving it
    # into the worker would make concurrent chunks write overlapping node
    # sets.
    def _score_one_chunk(chunk: list[WorkItemNode]) -> tuple[list[IntegrityWarning], list[LevelingProgress]]:
        chunk_warnings: list[IntegrityWarning] = []
        chunk_events: list[LevelingProgress] = []
        _apply_quality_scores(
            chunk, scoring_client, chunk_warnings, "", criteria_context, kb_context, category_checklist,
            category_checklist_definitions, progress_callback=chunk_events.append,
        )
        return chunk_warnings, chunk_events

    outcomes = run_chunks_bounded(chunks, _score_one_chunk, chunk_concurrency)

    # PHASE 3 -- merge in fixed CHUNK order on the calling thread.
    for kickoff_index in range(len(chunks)):
        # Narrate immediately BEFORE pulling this chunk's outcome -- see
        # PHASE 1 for why this is not hoisted above the dispatch.
        _fire(
            "score_requirements", chunks[kickoff_index],
            nodes_done=kickoff_index * _SCORING_CHUNK_NODE_COUNT, chunk_index=kickoff_index,
        )
        outcome = next(outcomes)
        chunk = chunks[outcome.chunk_index]
        chunk_index = outcome.chunk_index
        if outcome.error is not None:
            # One chunk's transient failure (confirmed live: a real job lost
            # 45+ minutes of prior parse/tree-build/title-tag/synthesis work
            # to a single 500 from the LLM backend here) must never discard
            # the rest of an already-mostly-complete SURVEY job. Requirement
            # quality scoring is an enhancement on top of the already-built
            # tree, never a dependency of its correctness -- same "must never
            # fail a SURVEY job" philosophy _score_epics_and_features (below)
            # already uses for the identical kind of call.
            message = f"Requirement quality scoring failed for {len(chunk)} node(s): {outcome.error}"
            logger.warning(message)
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.SCORING_FAILED,
                    message,
                    node_ids=[n.local_id for n in chunk],
                    detail={"scope": "requirement", "chunkSize": len(chunk)},
                )
            )
            if progress_callback is not None:
                progress_callback(
                    LevelingProgress(
                        phase="chunk_warning", branch_index=None, branch_count=branch_count,
                        blocks_done=0, blocks_total=blocks_total, kb_grounded=False, kb_citations=[],
                        warning_message=message,
                    )
                )
            continue
        chunk_warnings, chunk_events = outcome.value
        warnings.extend(chunk_warnings)
        if progress_callback is not None:
            for event in chunk_events:
                progress_callback(event)
        # Fan each representative's real result out to every OTHER node
        # sharing that same description text -- see this function's own
        # docstring for why deduplication happens before chunking at all.
        for representative in chunk:
            for duplicate in nodes_by_description[representative.description][1:]:
                duplicate.quality_score = representative.quality_score
                duplicate.quality_issues = representative.quality_issues
                duplicate.quality_category_scores = representative.quality_category_scores
                duplicate.quality_category_checklist = representative.quality_category_checklist
                duplicate.quality_confidence = representative.quality_confidence
        issues_found = sum(len(node.quality_issues) for node in chunk)
        nodes_done = chunk_index * _SCORING_CHUNK_NODE_COUNT + len(chunk)
        _fire(
            "score_requirements_done", chunk, nodes_done=nodes_done,
            chunk_index=chunk_index, issues_found=issues_found,
        )


def _score_epics_and_features(
    nodes: list[WorkItemNode],
    scoring_client: object,
    warnings: list[IntegrityWarning],
    progress_callback: ProgressCallback | None,
    model_name: str | None,
    blocks_total: int,
    branch_count: int,
    debug_capture: "DebugCapture | None" = None,
    # How many of this pass's independent chunks may be in flight at once
    # (see app.config.Settings.survey_chunk_concurrency). 1 (the default)
    # is the byte-identical previous behavior.
    chunk_concurrency: int = 1,
) -> None:
    """Epic/Feature quality review -- the counterpart to
    _score_all_requirements, run separately (see
    OrchestratorLlmClient.score_epics_and_features_for_document's own
    docstring for why this is a different call/prompt, not the same one
    widened). Optional capability: `scoring_client` is duck-typed via
    getattr rather than a required Protocol method, since a test double (or
    a future scoring backend) implementing only score_requirements_for_
    document must keep working unchanged -- reusing this same object
    (rather than a second constructor param) since the real
    OrchestratorLlmClient implements both. Reuses the existing
    score_requirements/score_requirements_done narration phases (no new
    Phase enum value needed for what is, narration-wise, a brief
    continuation of the same "scoring" activity) -- draft_count reflects
    however many Epic/Feature nodes this pass covers, distinguishing it
    from the Requirement pass's own count.

    A failure here (network error, malformed response) is an enhancement
    failing, never a reason to fail the whole SURVEY job -- caught, logged,
    and warned, same tolerant philosophy as every other best-effort scoring
    path in this module. quality_issues is deliberately left untouched
    ([], its default) -- see epic_feature_scores_schema's own docstring for
    why Epic/Feature review has no issues vocabulary.

    Chunks may run concurrently, bounded by `chunk_concurrency` (see
    app.config.Settings.survey_chunk_concurrency). Determinism is preserved
    structurally: the client call is the only work off the calling thread,
    outcomes come back by chunk INDEX rather than completion order, and
    every mutation, warning append, and narration event happens in the
    fixed-order merge loop -- so scores, warning order, and the narration
    stream are byte-identical to a serial run. Per-chunk fail-soft is
    unchanged."""
    score_fn = getattr(scoring_client, "score_epics_and_features_for_document", None)
    if score_fn is None:
        return
    epic_feature_types = (WorkItemType.EPIC, WorkItemType.FEATURE)
    epic_feature_nodes = [
        node
        for node in nodes
        if node.type in epic_feature_types
        # Any mechanically-inserted grouping node -- a bridge Feature from
        # _repair_requirement_hierarchy, a topical root-regrouping node
        # from _regroup_disconnected_roots, or a catch-all root Epic from
        # _ensure_root_features_have_epic_parent -- every one of these
        # local_ids CONTAINS the substring "synth_" (never asserted via
        # endswith, since each suffixes a real id or index after the
        # marker). None was ever a real authorial decision -- each is a
        # mechanically inserted node whose own description literally says
        # so. Scoring any of them against scopeCoherence/capabilityClarity
        # would produce a guaranteed-low, misleading score the reviewer
        # can't act on, so all are excluded from Epic/Feature quality
        # review entirely rather than scored and shown as if they were a
        # real quality judgment.
        and "synth_" not in node.local_id
    ]
    if not epic_feature_nodes:
        return

    total_epic_feature_nodes = len(epic_feature_nodes)
    total_chunks = -(-total_epic_feature_nodes // _SCORING_CHUNK_NODE_COUNT)

    def _fire(phase: Phase, chunk: list[WorkItemNode], nodes_done: int, chunk_index: int) -> None:
        if progress_callback is None:
            return
        progress_callback(
            LevelingProgress(
                phase=phase, branch_index=None, branch_count=branch_count,
                blocks_done=nodes_done, blocks_total=total_epic_feature_nodes,
                kb_grounded=False, kb_citations=[],
                model=model_name, draft_count=len(chunk),
                sample_titles=_sample_titles([n.title for n in chunk]),
                chunk_index=chunk_index, chunk_count=total_chunks,
            )
        )

    # PHASE 1 -- chunk construction on the calling thread, in document order
    # (see _score_all_requirements' own identical structure). The per-chunk
    # PRE-dispatch narration event fires from the merge loop below, not
    # here -- same reasoning, spelled out there.
    chunks: list[list[WorkItemNode]] = []
    payloads: list[dict[str, dict]] = []
    for start in range(0, len(epic_feature_nodes), _SCORING_CHUNK_NODE_COUNT):
        chunk = epic_feature_nodes[start : start + _SCORING_CHUNK_NODE_COUNT]
        chunks.append(chunk)
        payloads.append(
            {node.local_id: {"type": node.type.value, "text": node.description} for node in chunk}
        )

    # PHASE 2 -- only the client call leaves the calling thread.
    outcomes = run_chunks_bounded(payloads, lambda nodes_by_id: score_fn(nodes_by_id), chunk_concurrency)

    # PHASE 3 -- merge in fixed CHUNK order on the calling thread.
    for kickoff_index in range(len(chunks)):
        # Narrate immediately BEFORE pulling this chunk's outcome -- see
        # _score_all_requirements' PHASE 1 comment.
        _fire(
            "score_requirements", chunks[kickoff_index],
            nodes_done=kickoff_index * _SCORING_CHUNK_NODE_COUNT, chunk_index=kickoff_index,
        )
        outcome = next(outcomes)
        chunk = chunks[outcome.chunk_index]
        chunk_index = outcome.chunk_index
        if outcome.error is not None:
            message = f"Epic/Feature quality scoring failed: {outcome.error}"
            logger.warning(message)
            if debug_capture is not None:
                debug_capture.capture(
                    "score_epics_and_features",
                    f"chunk_{chunk_index * _SCORING_CHUNK_NODE_COUNT}",
                    str(outcome.error),
                )
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.SCORING_FAILED,
                    message,
                    node_ids=[n.local_id for n in chunk],
                    detail={"scope": "epic_feature", "chunkSize": len(chunk)},
                )
            )
            if progress_callback is not None:
                progress_callback(
                    LevelingProgress(
                        phase="chunk_warning", branch_index=None, branch_count=branch_count,
                        blocks_done=0, blocks_total=total_epic_feature_nodes, kb_grounded=False, kb_citations=[],
                        warning_message=message,
                    )
                )
            continue
        scores_by_id = outcome.value or {}
        for node in chunk:
            entry = scores_by_id.get(node.local_id)
            if not isinstance(entry, dict):
                continue
            raw_score = entry.get("score")
            is_int = isinstance(raw_score, int) and not isinstance(raw_score, bool)
            if is_int and 0 <= raw_score <= 100:
                node.quality_score = raw_score
            node.quality_category_scores = _parse_category_scores(entry.get("categoryScores"))
        nodes_done = chunk_index * _SCORING_CHUNK_NODE_COUNT + len(chunk)
        _fire("score_requirements_done", chunk, nodes_done=nodes_done, chunk_index=chunk_index)


def score_single_requirement_text(
    description: str,
    scoring_client: BatchedScoringClient,
    criteria_retriever: CriteriaRetriever | None,
    kb_context: str | None,
    category_checklist: list[str] | None,
) -> tuple[int | None, list[str], "QualityCategoryScores | None", "QualityConfidence | None"]:
    """CR-7d rescore: the single ad-hoc-string counterpart to
    _apply_quality_scores below, for re-judging ONE already-formalized
    requirement's current title+description after a manual/AI-chat edit --
    reuses the exact same call/prompt/tolerant-parsing rules instead of a
    second, drifting implementation, just with no WorkItemNode/tree to
    mutate in place (returns the parsed result instead).

    `category_checklist`, when supplied (the item's OWN previously-scored
    categoryScores keys), forces the rescore to judge the SAME rubric as the
    original scoring pass -- see score_requirements_for_document's own
    docstring for why this is a genuine determinism guarantee, not just a
    hint. Passing None (e.g. the item was never successfully scored before)
    falls back to that method's own kb_context-derived/fixed-5-dimension
    behavior, same as a first-time scoring pass would.

    Returns (score, issues, category_scores, confidence) -- the 4th element
    is SWEEP.md section 7's abstain channel (see QualityConfidence,
    app.workitem.model), parsed with the same tolerance as everything else
    here: a missing/malformed value is None, never a crash."""
    criteria_context = None
    if criteria_retriever is not None and description.strip():
        criteria = criteria_retriever.retrieve(description)
        criteria_context = "\n".join(f"- {c.issue.value}: {c.text}" for c in criteria)
    scores_by_id = scoring_client.score_requirements_for_document(
        {"adhoc": description}, criteria_context, kb_context, category_checklist
    )
    entry = scores_by_id.get("adhoc")
    if not isinstance(entry, dict):
        return None, [], None, None
    valid_issue_values = {i.value for i in RequirementQualityIssue}
    raw_score = entry.get("score")
    score = (
        raw_score
        if isinstance(raw_score, int) and not isinstance(raw_score, bool) and 0 <= raw_score <= 100
        else None
    )
    issues = sorted({issue for issue in entry.get("issues", []) if issue in valid_issue_values})
    category_scores = _parse_category_scores(entry.get("categoryScores"))
    return score, issues, category_scores, _parse_confidence(entry.get("confidence"))


def _parse_category_scores(raw: object) -> QualityCategoryScores | None:
    """Tolerant of a missing/malformed/wrongly-shaped categoryScores entry --
    same all-or-nothing philosophy as quality_score itself: any single
    dimension being absent, non-int, or out of 0-100 range discards the
    WHOLE breakdown for this node (a partial breakdown would be misleading
    -- e.g. showing clarity but silently omitting testability reads as
    "testability wasn't judged" rather than "the model's response was
    malformed"), falling back to quality_category_scores=None, never
    crashing the batch.

    Dynamic keys (not the old fixed clarity/testability/atomicity/style/
    rationale 5-tuple) -- see QualityCategoryScores' own docstring (app.
    workitem.model) for why: an org's ingested KB checklist can define its
    own category names. Still requires at least one entry and every value
    to be a genuine 0-100 int -- an empty object or one malformed value
    still discards the whole thing, same tolerance as before."""
    if not isinstance(raw, dict) or not raw:
        return None
    values: dict[str, int] = {}
    for key, value in raw.items():
        if not isinstance(value, int) or isinstance(value, bool) or not (0 <= value <= 100):
            return None
        values[key] = value
    return values


def _parse_confidence(raw: object) -> QualityConfidence | None:
    """Tolerant of a missing, non-string, or off-vocabulary 'confidence'
    value -- returns None, never raises, same closed-vocabulary philosophy
    as the `issues` filter and the same "one malformed field never crashes
    the batch" rule as _parse_category_scores above.

    None means "the model said nothing usable about its confidence", which
    is deliberately NOT the same as HIGH and deliberately NOT treated as a
    review signal: `responseSchema` is best-effort in this system (an
    Ollama version that rejects response_format degrades to a schema-less
    retry, see _response_schemas.py's header), so a missing value is far
    more likely a transport/degradation artifact than a real judgment, and
    flagging every item on a degraded run would drown the real signal."""
    if not isinstance(raw, str):
        return None
    try:
        return QualityConfidence(raw)
    except ValueError:
        return None


def _match_category_checklist(
    category_scores: "QualityCategoryScores | None",
    category_checklist_definitions: dict[str, str] | None,
) -> dict[str, str] | None:
    """Builds this node's quality_category_checklist -- the source for
    QualityGauge's "Per your organization's document" citation on the
    frontend -- by matching each of THIS node's own scored category keys
    against the org's ingested checklist's stated definitions.

    Matching heuristic: when `category_checklist_definitions` is supplied
    at all, its keys are, by construction, the SAME FIXED name strings
    `category_checklist` (see score_requirements_for_document's own
    docstring) instructs the scoring model to use VERBATIM as its
    categoryScores keys -- so a case-insensitive, whitespace-normalized
    EXACT lookup is enough for the overwhelming majority of real matches.
    No fuzzy/substring matching is attempted here (deliberately -- see
    known limitations below); this is a lookup, not a search.

    Known limitations: (1) a model that still drifts and renames/retypes a
    key despite the "use EXACTLY these" instruction produces no match for
    that key, even though a human would recognize it as the same category
    -- falls back to QualityGauge's generic description, same as if no KB
    checklist existed at all. (2) the always-injected
    'completeness_as_requirement' key (added in every category_instruction
    branch regardless of checklist source, see score_requirements_for_
    document) never has a checklist definition -- it's req2ado's own
    structural check, not part of any org's document, so it correctly never
    matches. (3) a category whose document lists only a bare name with no
    stated definition (common -- org checklists vary widely in how much
    they write per category) has no entry in category_checklist_definitions
    at all, indistinguishable here from case (1) -- both fall back the same
    way, which is the intended, honest behavior (there is genuinely nothing
    real to cite in either case).

    Returns None (not {}) when nothing matched at all -- same "absent, not
    empty" convention as quality_category_checklist's own docstring
    (app.workitem.model), letting a partial match (some categories cited,
    others not) still populate real entries rather than being discarded
    wholesale like quality_category_scores' own all-or-nothing parsing."""
    if not category_scores or not category_checklist_definitions:
        return None
    normalized = {name.strip().lower(): definition for name, definition in category_checklist_definitions.items()}
    matched = {
        key: normalized[key.strip().lower()]
        for key in category_scores
        if key.strip().lower() in normalized
    }
    return matched or None


def _apply_quality_scores(
    nodes: list[WorkItemNode],
    scoring_client: BatchedScoringClient,
    warnings: list[IntegrityWarning],
    node_id_prefix: str,
    criteria_context: str | None = None,
    kb_context: str | None = None,
    category_checklist: list[str] | None = None,
    category_checklist_definitions: dict[str, str] | None = None,
    progress_callback: ProgressCallback | None = None,
) -> None:
    """Judges every node's FINAL formalized description in ONE batched call
    (mutates `nodes` in place -- WorkItemNode is a plain, mutable pydantic
    model). Tolerant of a missing, malformed (non-int, out of 0-100 range),
    or wrongly-shaped scoring entry for one node_id -- falls back to
    quality_score=None/quality_issues=[] for that node only, never crashes
    the batch or affects sibling nodes, same philosophy as every other
    LLM-response-parsing path in this module.

    `criteria_context` is a PRECOMPUTED reference-criteria string (see
    _build_criteria_context) -- built ONCE by the caller over the whole
    document's requirement nodes, not per chunk, so a document scored across
    several chunks (see _score_all_requirements) doesn't re-run retrieval
    once per chunk. `kb_context` is the same SharePoint/OneDrive KB context
    computed once for the whole document, threaded through for consistency.
    `category_checklist` (see KbVectorStore.get_quality_checklist), when
    supplied, is the FIXED categoryScores key list extracted once at KB
    ingestion time for the grounding document -- takes priority over
    `kb_context`'s own live-derive fallback (see score_requirements_for_
    document's own docstring for the determinism guarantee this provides).
    `category_checklist_definitions` (see KbVectorStore.
    get_quality_checklist_definitions) is category_checklist's own
    companion -- name -> the org's own stated definition text, when one
    exists -- used ONLY to populate each node's quality_category_checklist
    below (see _match_category_checklist's own docstring); never sent to
    the LLM, which has no need to be told back the definitions of names it
    was itself instructed to use. All four are independent/optional;
    omitting them is byte-identical to before any of these capabilities
    existed."""
    descriptions_by_node_id = {node.local_id: node.description for node in nodes}
    scores_by_node_id = scoring_client.score_requirements_for_document(
        descriptions_by_node_id, criteria_context, kb_context, category_checklist
    )
    valid_issue_values = {i.value for i in RequirementQualityIssue}

    for node in nodes:
        entry = scores_by_node_id.get(node.local_id)
        if not isinstance(entry, dict):
            continue
        raw_score = entry.get("score")
        if isinstance(raw_score, int) and not isinstance(raw_score, bool) and 0 <= raw_score <= 100:
            node.quality_score = raw_score
        node.quality_issues = sorted(
            {
                RequirementQualityIssue(issue)
                for issue in entry.get("issues", [])
                if issue in valid_issue_values
            },
            key=lambda i: i.value,
        )
        node.quality_category_scores = _parse_category_scores(entry.get("categoryScores"))
        node.quality_category_checklist = _match_category_checklist(
            node.quality_category_scores, category_checklist_definitions,
        )
        node.quality_confidence = _parse_confidence(entry.get("confidence"))

    missing_nodes = [node for node in nodes if node.quality_score is None]
    missing_or_invalid = [node.local_id for node in missing_nodes]
    if missing_or_invalid:
        preview = ", ".join(f'"{n.title}"' for n in missing_nodes[:5])
        if len(missing_nodes) > 5:
            preview += f", and {len(missing_nodes) - 5} more"
        message = f"Quality scoring returned no valid score for {len(missing_or_invalid)} item(s): {preview}."
        logger.warning(message)
        warnings.append(
            IntegrityWarning.make(
                WarningKind.SCORING_MISSING,
                message,
                node_ids=missing_or_invalid,
                detail={"branch": node_id_prefix or "(root)"},
            )
        )
        if progress_callback is not None:
            progress_callback(
                LevelingProgress(
                    phase="chunk_warning", branch_index=None, branch_count=0,
                    blocks_done=0, blocks_total=0, kb_grounded=False, kb_citations=[],
                    warning_message=message,
                )
            )

    # Determinism guard (user-reported concern): categoryScores keys are now
    # dynamic (see QualityCategoryScores' own docstring) -- the model is
    # instructed to fix its category names ONCE from the KB material and
    # reuse the SAME set for every node in this call, but nothing besides
    # the prompt enforces that. A model that drifts to a different key set
    # partway through the SAME batched response is a real correctness
    # signal worth surfacing to a reviewer (inconsistent categories would
    # render as different gauge dimensions per node in the UI) -- not a
    # crash, since each node's own breakdown is still independently valid.
    scored_key_sets = {
        frozenset(node.quality_category_scores.keys())
        for node in nodes
        if node.quality_category_scores
    }
    if len(scored_key_sets) > 1:
        message = (
            f"Quality scoring used {len(scored_key_sets)} different sets of category names across items in "
            "the same batch -- the model did not stay consistent, so quality breakdowns may not line up "
            "for comparison."
        )
        logger.warning(message)
        warnings.append(
            IntegrityWarning.make(
                WarningKind.SCORING_INCONSISTENT_CATEGORIES,
                message,
                detail={"branch": node_id_prefix or "(root)", "distinctKeySetCount": len(scored_key_sets)},
            )
        )
        if progress_callback is not None:
            progress_callback(
                LevelingProgress(
                    phase="chunk_warning", branch_index=None, branch_count=0,
                    blocks_done=0, blocks_total=0, kb_grounded=False, kb_citations=[],
                    warning_message=message,
                )
            )
