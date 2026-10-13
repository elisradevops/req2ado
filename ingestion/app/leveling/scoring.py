from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from typing import TYPE_CHECKING, Protocol, TypeVar

import httpx

if TYPE_CHECKING:
    from app.debug_capture import DebugCapture

from app.config import settings
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
        user_id: str | None = None,
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


# Scoring batch size. The output-token cap (_MAX_OUTPUT_TOKENS, 20_000; a
# scoring entry runs ~80 tokens/node) would allow ~150 nodes per call, but
# the binding limit is TIME, not tokens: scoring is one blocking, non-streamed
# call, and in prod a 150-node batch sometimes ran past ~300 s, after which the
# upstream returned an empty reply or dropped the connection (two of four
# batches in job 0b9a134f, ~15 minutes lost each once the identical request
# was re-sent). At the ~1 s per node observed, 50 nodes is ~45 s per call --
# far under any gateway ceiling -- and a lost batch costs 50 nodes, not 150.
# It also gives the screen real progress every minute or so.
_SCORING_CHUNK_NODE_COUNT = 50
# A chunk also closes once its description text would exceed this many
# characters (a lone oversized item still gets its own chunk): a few huge
# descriptions make a call slow regardless of the node count. A typical chunk
# (~140 chars/node in prod) is bounded by the node count (50 nodes ~ 7k chars);
# the budget only cuts description-heavy chunks earlier. 12k closed after every
# one of the few 7k+ char requirements, producing one-to-three-item calls in
# prod (batches of 3 and 1); 20k lets 2-3 of them share a call while input
# size stays far from anything that mattered (batch time tracks output tokens,
# ~1 s per node, not input chars).
_SCORING_CHUNK_CHAR_BUDGET = 20_000

_T = TypeVar("_T")


def _chunk_by_count_and_chars(items: Sequence[_T], size_of: Callable[[_T], int]) -> list[list[_T]]:
    """Splits `items` (document order preserved) into chunks of at most
    _SCORING_CHUNK_NODE_COUNT items AND at most _SCORING_CHUNK_CHAR_BUDGET
    total `size_of` characters; an item larger than the budget on its own
    still forms a chunk of one."""
    chunks: list[list[_T]] = []
    current: list[_T] = []
    current_chars = 0
    for item in items:
        item_chars = size_of(item)
        if current and (
            len(current) >= _SCORING_CHUNK_NODE_COUNT or current_chars + item_chars > _SCORING_CHUNK_CHAR_BUDGET
        ):
            chunks.append(current)
            current = []
            current_chars = 0
        current.append(item)
        current_chars += item_chars
    if current:
        chunks.append(current)
    return chunks


def _split_in_half(items: list[_T]) -> tuple[list[_T], list[_T]]:
    middle = (len(items) + 1) // 2
    return items[:middle], items[middle:]

# §7 canary/drift probe: one fixed, known-bad sentinel requirement injected
# into every batched scoring call, asserted server-side, and stripped before
# any caller sees it (see _apply_quality_scores' injection/pop pair and
# _check_scoring_canary below).
#
# What this buys: nothing else in this repo can tell the difference between
# "the model judged these requirements to be good" and "the model/config
# drifted and is now scoring everything ~85 regardless of input" -- the same
# class of silent degradation this codebase has already been bitten by twice
# live (a missing `think: False` burning the whole token budget on hidden
# chain-of-thought and returning empty content; an unset numCtx silently
# truncating the tail of a large batch). A single item whose correct score is
# not in dispute converts that from an invisible failure into a log line.
#
# NOT a gate. A failed canary logs and nothing else -- no IntegrityWarning
# (that is a USER-VISIBLE surface and the sentinel must never leak to a
# user, not even as prose about a canary), no chunk_warning, no job failure.
# Same fail-open philosophy as every other path in this module: requirement
# quality scoring is an enhancement on top of an already-built tree, never a
# dependency of its correctness.
#
# The id is deliberately dunder-wrapped so it cannot collide with a real
# WorkItemNode.local_id (those are section/index derived, e.g. "det0_h1",
# "n1"); _apply_quality_scores still guards against a collision rather than
# trusting that.
_CANARY_NODE_ID = "__req2ado_scoring_canary__"
# Deliberately, unambiguously bad on every dimension the prompt judges: no
# subject-modal-predicate shape, two vague terms the prompt names verbatim
# ('user-friendly', 'fast'), compound, passive, untestable, no acceptance
# criteria. Any model scoring this above _CANARY_MAX_SCORE is not applying
# the rubric. Fixed text, never randomized -- a stable sentinel keeps the
# cache key stable and makes the log line comparable run to run.
_CANARY_TEXT = "It should be user-friendly and fast and stuff should be handled appropriately."
# Generous on purpose. This is a drift alarm, not a calibration test: the
# question is "is the rubric being applied at all", and a false alarm on a
# merely-strict model would train readers to ignore the log line. Matches
# LOW_QUALITY_THRESHOLD (50) in diff-summary.ts/diffFlagging.ts -- the same
# number this system already calls "low enough that a human should look".
_CANARY_MAX_SCORE = 50


def _scoring_failed_warning(
    nodes: list[WorkItemNode], error: BaseException, scope: str, message: str,
) -> IntegrityWarning:
    """One SCORING_FAILED warning with enough context to diagnose WHY (the
    job that prompted this had only "timed out" to go on): exception type,
    the timeout in force, chunk size and the chunk's description size."""
    return IntegrityWarning.make(
        WarningKind.SCORING_FAILED,
        message,
        node_ids=[n.local_id for n in nodes],
        detail={
            "scope": scope,
            "chunkSize": len(nodes),
            "chunkChars": sum(len(n.description) for n in nodes),
            "errorType": type(error).__name__,
            "timeoutSeconds": settings.llm_request_timeout_seconds,
        },
    )


def _is_splittable_upstream_failure(error: BaseException) -> bool:
    """A failure for which scoring the same nodes as two smaller calls can succeed: a request timeout, a 5xx from
    the proxy (the orchestrator answers 5xx when the upstream model call hangs, returns an empty completion or drops
    the connection), or a 400. A 400 here is the orchestrator's answer after its own schema-less retry also failed;
    prod saw Claude answer one batch with an instant, body-less 400 while every other batch of the same shape passed,
    so a smaller request is worth one more try (bounded: each half once). Other 4xx (auth, not found) are not."""
    if isinstance(error, httpx.TimeoutException):
        return True
    return isinstance(error, httpx.HTTPStatusError) and (
        error.response.status_code >= 500 or error.response.status_code == 400
    )


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
    user_id: str | None = None,
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
    chunks = _chunk_by_count_and_chars(representative_nodes, lambda node: len(node.description))
    total_chunks = len(chunks)
    # Chunks are no longer a fixed node count, so cumulative progress is the
    # running sum of earlier chunk sizes rather than index * chunk size.
    chunk_start_offsets = [sum(len(c) for c in chunks[:i]) for i in range(len(chunks))]

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

        def _score(nodes_to_score: list[WorkItemNode]) -> None:
            _apply_quality_scores(
                nodes_to_score, scoring_client, chunk_warnings, "", criteria_context, kb_context,
                category_checklist, category_checklist_definitions,
                progress_callback=chunk_events.append, user_id=user_id,
            )

        try:
            _score(chunk)
        except Exception as error:  # noqa: BLE001 -- narrowed just below; anything else is re-raised
            if not _is_splittable_upstream_failure(error) or len(chunk) < 2:
                raise
            # A full chunk timed out or hit a 5xx. Retry each half ONCE
            # (never recursively -- bounded cost) so a slow model loses at
            # most a half-chunk instead of the whole chunk. Halves run one
            # after the other on this worker, so node mutation stays
            # confined to this chunk's own nodes. The first call raised
            # before parsing any response, so no node was partly written.
            logger.warning(
                "Requirement scoring chunk of %d failed (%s) -- retrying as two halves", len(chunk), error,
            )
            for half in _split_in_half(chunk):
                try:
                    _score(half)
                except Exception as half_error:  # noqa: BLE001 -- same fail-soft contract as a whole-chunk failure
                    message = f"Requirement quality scoring failed for {len(half)} node(s): {half_error}"
                    logger.warning(message)
                    chunk_warnings.append(_scoring_failed_warning(half, half_error, "requirement", message))
        return chunk_warnings, chunk_events

    outcomes = run_chunks_bounded(chunks, _score_one_chunk, chunk_concurrency)

    # PHASE 3 -- merge in fixed CHUNK order on the calling thread.
    for kickoff_index in range(len(chunks)):
        # Narrate immediately BEFORE pulling this chunk's outcome -- see
        # PHASE 1 for why this is not hoisted above the dispatch.
        _fire(
            "score_requirements", chunks[kickoff_index],
            nodes_done=chunk_start_offsets[kickoff_index], chunk_index=kickoff_index,
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
            warnings.append(_scoring_failed_warning(chunk, outcome.error, "requirement", message))
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
        nodes_done = chunk_start_offsets[chunk_index] + len(chunk)
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
    user_id: str | None = None,
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
    chunks = _chunk_by_count_and_chars(epic_feature_nodes, lambda node: len(node.description))
    total_chunks = len(chunks)
    chunk_start_offsets = [sum(len(c) for c in chunks[:i]) for i in range(len(chunks))]

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
    payloads: list[dict[str, dict]] = [
        {node.local_id: {"type": node.type.value, "text": node.description} for node in chunk} for chunk in chunks
    ]

    # PHASE 2 -- only the client call leaves the calling thread.
    def _score_payload(nodes_by_id: dict[str, dict]) -> dict[str, dict]:
        try:
            return score_fn(nodes_by_id, user_id=user_id)
        except Exception as error:  # noqa: BLE001 -- narrowed just below; anything else is re-raised
            if not _is_splittable_upstream_failure(error) or len(nodes_by_id) < 2:
                raise
            # Same bounded split-and-retry as the requirement pass: each
            # half once, results merged. Unlike the requirement pass a
            # failed half fails the whole chunk (the response is a plain
            # dict, so there is no per-half warning channel here) -- still
            # no worse than before.
            logger.warning("Epic/Feature scoring chunk of %d failed (%s) -- retrying as two halves", len(nodes_by_id), error)
            keys = list(nodes_by_id)
            first, second = _split_in_half(keys)
            merged: dict[str, dict] = {}
            for half in (first, second):
                merged.update(score_fn({key: nodes_by_id[key] for key in half}, user_id=user_id))
            return merged

    outcomes = run_chunks_bounded(payloads, _score_payload, chunk_concurrency)

    # PHASE 3 -- merge in fixed CHUNK order on the calling thread.
    for kickoff_index in range(len(chunks)):
        # Narrate immediately BEFORE pulling this chunk's outcome -- see
        # _score_all_requirements' PHASE 1 comment.
        _fire(
            "score_requirements", chunks[kickoff_index],
            nodes_done=chunk_start_offsets[kickoff_index], chunk_index=kickoff_index,
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
                    f"chunk_{chunk_start_offsets[chunk_index]}",
                    str(outcome.error),
                )
            warnings.append(_scoring_failed_warning(chunk, outcome.error, "epic_feature", message))
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
        nodes_done = chunk_start_offsets[chunk_index] + len(chunk)
        _fire("score_requirements_done", chunk, nodes_done=nodes_done, chunk_index=chunk_index)


def score_single_requirement_text(
    description: str,
    scoring_client: BatchedScoringClient,
    criteria_retriever: CriteriaRetriever | None,
    kb_context: str | None,
    category_checklist: list[str] | None,
    user_id: str | None = None,
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
        {"adhoc": description}, criteria_context, kb_context, category_checklist, user_id=user_id,
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


def _check_scoring_canary(entry: object) -> None:
    """Asserts the injected sentinel (see _CANARY_TEXT) came back scored
    below _CANARY_MAX_SCORE. Log-only on every failure path -- see the
    canary constants' own comment for why this is never a gate and never an
    IntegrityWarning.

    A missing or malformed entry counts as a failure too, and for the same
    reason a too-high score does: the prompt demands an entry for EVERY
    input key, so the sentinel being absent means either the model stopped
    honoring that instruction or the response was truncated -- both are
    exactly the drift this probe exists to surface. Distinct messages per
    case so a log reader can tell 'the rubric moved' from 'the response
    didn't come back whole'."""
    if not isinstance(entry, dict):
        logger.warning(
            "Scoring drift probe: the known-bad canary item got no usable entry back (%r) -- the model "
            "either stopped returning one entry per input key, returned an empty object, or the response was truncated. Quality "
            "scores in this batch may not be trustworthy.",
            entry,
        )
        return
    raw_score = entry.get("score")
    if not isinstance(raw_score, int) or isinstance(raw_score, bool) or not (0 <= raw_score <= 100):
        logger.warning(
            "Scoring drift probe: the known-bad canary item came back with a non-usable score (%r). "
            "Quality scores in this batch may not be trustworthy.",
            raw_score,
        )
        return
    if raw_score > _CANARY_MAX_SCORE:
        logger.warning(
            "Scoring drift probe FAILED: a deliberately known-bad requirement scored %d (expected <= %d). "
            "The scoring model or its configuration has likely drifted -- every quality score in this "
            "batch should be treated as suspect until this is investigated.",
            raw_score, _CANARY_MAX_SCORE,
        )


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
    user_id: str | None = None,
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
    existed.

    A fixed, known-bad canary requirement (see _CANARY_TEXT) is injected
    into the batch sent to the model and its result popped off the response
    immediately, before anything else here reads it -- a cheap model/config
    drift probe (§7). It is log-only and never reaches `nodes`, `warnings`,
    the progress callback, or any caller; see _check_scoring_canary and the
    canary constants' own comments for why it is not a gate. Gated on
    settings.survey_scoring_canary_enabled (default True, preserving prior
    behavior) -- see that setting's own comment in config.py for why an
    operator kill switch exists."""
    descriptions_by_node_id = {node.local_id: node.description for node in nodes}
    # §7 canary: injected here (the one place the real batch is built) and
    # popped on the very next line after the call, so nothing else in this
    # function -- and no caller -- can observe it. Skipped when the
    # survey_scoring_canary_enabled kill switch is off, or (independently)
    # in the vanishingly-unlikely event a real node already owns this id,
    # since overwriting a real node's text to run a probe would be strictly
    # worse than not running the probe.
    canary_enabled = settings.survey_scoring_canary_enabled
    inject_canary = canary_enabled and _CANARY_NODE_ID not in descriptions_by_node_id
    if inject_canary:
        descriptions_by_node_id[_CANARY_NODE_ID] = _CANARY_TEXT
    elif canary_enabled:
        logger.warning(
            "Scoring drift probe skipped: a real node already uses the reserved canary id %r.",
            _CANARY_NODE_ID,
        )
    scores_by_node_id = scoring_client.score_requirements_for_document(
        descriptions_by_node_id, criteria_context, kb_context, category_checklist, user_id=user_id,
    )
    if inject_canary:
        _check_scoring_canary(scores_by_node_id.pop(_CANARY_NODE_ID, None))
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
                detail={
                    "branch": node_id_prefix or "(root)",
                    # "no_matching_keys": not one requested item got a score
                    # (a systematic fault -- the answer carried none of our
                    # keys), as opposed to "partial": some were scored and
                    # these were skipped or invalid.
                    "reason": "no_matching_keys" if len(missing_nodes) == len(nodes) else "partial",
                },
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
