from __future__ import annotations

import logging
from typing import Literal, Protocol

import numpy as np

from app.dedup.embedding_blend import blend_embeddings
from app.leveling.description_text import description_for_model
from app.leveling.live_context import current_live_emitter
from app.leveling.narration_publisher import LevelingProgress, ProgressCallback
from app.leveling.quantities import Comparison, compare
from app.workitem.model import (
    IntegrityWarning,
    RequirementQualityIssue,
    WarningKind,
    WorkItemNode,
    WorkItemType,
)

logger = logging.getLogger(__name__)


class ConflictJudgeClient(Protocol):
    """Judges pairs of near-duplicate statements (see _detect_conflicting_duplicates). Entirely optional (default None, same opt-in
    convention as every other client here): when omitted, near-duplicate Requirements are never checked for conflict.

    `pairs_by_id` maps a pair id to {"a": text, "b": text}; the answer maps each pair id it could judge to {"same_parameter",
    "values_agree"}, each "yes", "no" or "uncertain". A pair id absent from the answer was not judged."""

    def judge_parameter_pairs(
        self, pairs_by_id: dict[str, dict[str, str]], user_id: str | None = None
    ) -> dict[str, dict]: ...


_DUPLICATE_CLUSTER_COSINE_THRESHOLD = 0.85


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(y * y for y in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


# A cluster's pairs are judged in one call. If that call fails it is asked again once -- split in halves when there are two pairs or
# more (a smaller, simpler request), the same call once more otherwise -- and any pair still unanswered is reported, never dropped.
_MIN_PAIRS_TO_SPLIT = 2


def _judge_once(
    conflict_client: ConflictJudgeClient,
    pairs: dict[str, dict[str, str]],
    user_id: str | None,
) -> tuple[dict[str, dict], str | None]:
    """(answers, None) on success, ({}, short reason) when the call failed."""
    try:
        answers = conflict_client.judge_parameter_pairs(pairs, user_id=user_id)
    except Exception as exc:  # noqa: BLE001 -- a failed judgment must never fail the job
        reason = " ".join(str(exc).split())[:200] or type(exc).__name__
        logger.warning("Near-duplicate pair judgment failed for %d pair(s): %s", len(pairs), reason)
        return {}, reason
    if not isinstance(answers, dict):
        return {}, "the model returned no usable verdict"
    return {
        pair_id: answers[pair_id] for pair_id in pairs if isinstance(answers.get(pair_id), dict)
    }, None


def _judge_pairs_resilient(
    conflict_client: ConflictJudgeClient,
    pairs: dict[str, dict[str, str]],
    user_id: str | None,
) -> tuple[dict[str, dict], dict[str, str]]:
    """(answers, unanswered): an answer per pair the model judged, and for every other pair the reason it could not be asked."""
    answers, reason = _judge_once(conflict_client, pairs, user_id)
    if reason is None:
        return answers, {
            pair_id: "the model gave no usable answer"
            for pair_id in pairs
            if pair_id not in answers
        }
    ids = list(pairs)
    retries = (
        [ids[: len(ids) // 2], ids[len(ids) // 2 :]] if len(ids) >= _MIN_PAIRS_TO_SPLIT else [ids]
    )
    answers, unanswered = {}, {}
    for part in retries:
        part_answers, part_reason = _judge_once(
            conflict_client, {pair_id: pairs[pair_id] for pair_id in part}, user_id
        )
        answers.update(part_answers)
        for pair_id in part:
            if pair_id not in part_answers:
                unanswered[pair_id] = part_reason or "the model gave no usable answer"
    return answers, unanswered


Outcome = Literal["conflict", "uncertain"]


def _outcome(comparison: Comparison, answer: dict) -> Outcome | None:
    """What one judged pair means. Wherever code compared the values ("differ"), only "same parameter?" is the model's: yes is a
    conflict, uncertain is for the reviewer. Where code could not compare them ("incomparable"), the model's values_agree decides too."""
    same, agree = answer.get("same_parameter"), answer.get("values_agree")
    if same == "no":
        return None
    if comparison.status == "differ":
        return "conflict" if same == "yes" else "uncertain"
    if agree == "yes":
        return None
    return "conflict" if same == "yes" and agree == "no" else "uncertain"


def _same_text(a: str, b: str) -> bool:
    return " ".join(a.split()).casefold() == " ".join(b.split()).casefold()


def _detect_conflicting_duplicates(
    all_nodes: list[WorkItemNode],
    embed_client: object | None,
    conflict_client: ConflictJudgeClient | None,
    warnings: list[IntegrityWarning],
    progress_callback: ProgressCallback | None = None,
    blocks_total: int = 0,
    branch_count: int = 0,
    user_id: str | None = None,
) -> None:
    """Real capability gap closed here: this codebase had NO conflict/
    contradiction detection anywhere. The existing dedup vector store
    (app.dedup.vector_store) answers "does this already exist in ADO,"
    scoped cross-job per area path -- never "do these two nodes in THIS
    job say opposite things." Confirmed live, real document: the SAME
    power-supply spec restated in a body section and its appendix produced
    9 exact-duplicate description pairs in one real job's output,
    including a genuine conflict (85% vs 93% efficiency, 500W vs 600W,
    28VAC vs 28VDC input) that was silently kept as two unrelated
    Requirement nodes with no signal either was wrong.

    Embeds every Requirement-type node's TITLE and DESCRIPTION (one batched
    call, 2N texts -- titles then descriptions, same batching shape as
    /dedup/upsert-batch) and blends each node's pair 50/50 into a single
    vector (app.dedup.embedding_blend.blend_embeddings, weight_a=0.5 -- the
    same function and weight the cross-job dedup check uses, see
    check_for_duplicates's own docstring for that measurement). Clusters at
    >= _DUPLICATE_CLUSTER_COSINE_THRESHOLD cosine similarity (a plain
    in-memory pass over this job's own nodes, not a new vector-store
    dependency). Within a cluster, each similar PAIR is settled by code
    where it can be: app.leveling.quantities reads both statements' values
    and normalises their units, so the same text, or values that agree in
    every unit both state, is never a conflict and costs no call. The other
    pairs of the cluster go to `conflict_client` in one call, which judges
    per pair only what needs language: "is this the same parameter?" and,
    only for a pair whose values code could not compare, "do the values
    agree?" -- either may be "uncertain" (see _outcome). A conflict adds one
    NEAR_DUPLICATE_CONFLICT warning per cluster, carrying the differing
    values as the texts state them, and tags each conflicting node with
    RequirementQualityIssue.CONFLICTING_VALUE; an uncertain pair adds a
    CONFLICT_JUDGMENT_SKIPPED "compare them manually" warning and tags
    nothing.

    Title/description blend (confirmed real bug, fixed here): embedding the
    description ALONE never got the real conflicts above to `conflict_client`
    at all. Measured live against the configured embed model on that same
    document, the 28VAC/28VDC pair scored 0.65 and the 85%/93% efficiency
    pair 0.80 -- both under the 0.85 clustering threshold, because one side
    of each pair is a terse table fragment ("Input 28VAC") and the other a
    full formal sentence ("The power supply shall accept an input of 28V DC
    from the platform."): length and register dominate a small
    general-purpose sentence embedding. The nodes' TITLES are what leveling
    has already normalized ("Power Supply Efficiency" vs "Power Supply
    Efficiency"; "Power Supply Input Voltage" vs "Input Voltage
    Specification"), so blending the title in carries a same-parameter pair
    over the threshold without dragging unrelated descriptions with it -- a
    title is at most HALF of each blended vector, so two nodes with an
    IDENTICAL title but genuinely unrelated descriptions still blend to
    ~0.5-0.75, under threshold. _DUPLICATE_CLUSTER_COSINE_THRESHOLD is
    deliberately unchanged at 0.85: the blend fixes a recall gap, not a
    threshold. `n.title or n.description` guards the (type-permitted, see
    WorkItemNode.title's max_length-only Field) empty title -- falling back
    to the description makes the blend a no-op for that node instead of
    giving every empty-titled node the same shared half-vector.

    Deliberately does NOT port check_for_duplicates's numeric-literal veto
    (_numeric_tokens), even though the blend comes from that same module: it
    downgrades a match whose numeric tokens DIFFER, which is the exact
    opposite of this function's purpose -- same-parameter-different-number
    is precisely the pair this pass exists to surface (the value comparison
    above happens after clustering, never instead of it).

    Entirely optional and fail-open: `embed_client`/`conflict_client`
    omitted (the default) is a no-op, matching pre-existing behavior
    exactly. An embed or judge-call failure degrades to skipping that
    step or reporting the unjudged pairs, never fails the job -- same "must never fail a SURVEY
    job" philosophy as KB retrieval and trace-link inference."""
    if embed_client is None or conflict_client is None:
        return
    requirement_nodes = [n for n in all_nodes if n.type == WorkItemType.REQUIREMENT]
    if len(requirement_nodes) < 2:
        return
    if progress_callback is not None:
        progress_callback(
            LevelingProgress(
                phase="detect_conflicts",
                branch_index=None,
                branch_count=branch_count,
                blocks_done=blocks_total,
                blocks_total=blocks_total,
                kb_grounded=False,
                kb_citations=[],
            )
        )
    node_count = len(requirement_nodes)
    try:
        raw_embeddings = embed_client.embed(
            [n.title or description_for_model(n.description) for n in requirement_nodes]
            + [description_for_model(n.description) for n in requirement_nodes],
            user_id=user_id,
        )
    except Exception as exc:
        logger.warning("Duplicate-cluster embedding failed, skipping conflict detection: %s", exc)
        return
    title_embeddings = raw_embeddings[:node_count]
    description_embeddings = raw_embeddings[node_count:]
    embeddings = [
        blend_embeddings(title_embedding, description_embedding)
        for title_embedding, description_embedding in zip(title_embeddings, description_embeddings)
    ]

    # Union-find over cosine-similar pairs. The O(n^2) PAIR COUNT is
    # unavoidable (every Requirement must be compared against every other),
    # but the arithmetic itself doesn't have to be: this used to call
    # _cosine_similarity (pure-Python, and redundantly recomputing both
    # vectors' norms on EVERY pair even though blend_embeddings already
    # returns unit-normalized vectors -- provably always 1.0) once per pair
    # in a Python-level loop. Real cost this closes, confirmed live: at
    # n=500 requirements this was minutes of single-threaded interpreter
    # time inside a job. Computing the full similarity matrix as one
    # vectorized matmul (numpy is already a transitive dependency via
    # chromadb) turns that into a single sub-millisecond BLAS call; the
    # remaining Python loop below is just cheap float comparisons + union-
    # find bookkeeping, not per-pair arithmetic.
    embeddings_matrix = np.asarray(embeddings, dtype=np.float64)
    norms = np.linalg.norm(embeddings_matrix, axis=1, keepdims=True)
    zero_norm = (norms == 0).flatten()
    # Matches _cosine_similarity's own norm_a==0-or-norm_b==0 -> 0.0
    # short-circuit -- a genuinely zero-vector embedding (never seen live,
    # but defensively handled the same way the old pairwise function did)
    # must never divide by zero or be silently treated as maximally similar.
    normalized = embeddings_matrix / np.where(norms == 0, 1.0, norms)
    similarity_matrix = normalized @ normalized.T
    if zero_norm.any():
        similarity_matrix[zero_norm, :] = 0.0
        similarity_matrix[:, zero_norm] = 0.0

    parent = list(range(len(requirement_nodes)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        root_i, root_j = find(i), find(j)
        if root_i != root_j:
            parent[root_j] = root_i

    for i in range(len(requirement_nodes)):
        for j in range(i + 1, len(requirement_nodes)):
            if similarity_matrix[i, j] >= _DUPLICATE_CLUSTER_COSINE_THRESHOLD:
                union(i, j)

    clusters: dict[int, list[int]] = {}
    for i in range(len(requirement_nodes)):
        clusters.setdefault(find(i), []).append(i)

    texts = [description_for_model(n.description) for n in requirement_nodes]
    for member_indices in clusters.values():
        if len(member_indices) < 2:
            continue
        # Only the similar pairs themselves (a cluster is transitive, its ends need not be alike), and only where code cannot settle
        # the pair alone: the same text, or values that agree in every unit both state, cannot be a conflict.
        pending: dict[str, tuple[int, int, Comparison]] = {}
        for position, i in enumerate(member_indices):
            for j in member_indices[position + 1 :]:
                if similarity_matrix[i, j] < _DUPLICATE_CLUSTER_COSINE_THRESHOLD or _same_text(
                    texts[i], texts[j]
                ):
                    continue
                comparison = compare(texts[i], texts[j])
                if comparison.status != "agree":
                    pending[f"p{len(pending)}"] = (i, j, comparison)
        if not pending:
            continue
        answers, unanswered = _judge_pairs_resilient(
            conflict_client,
            {pair_id: {"a": texts[i], "b": texts[j]} for pair_id, (i, j, _) in pending.items()},
            user_id,
        )
        conflicts: list[tuple[int, int, Comparison]] = []
        uncertain: list[tuple[int, int]] = []
        for pair_id, (i, j, comparison) in pending.items():
            if pair_id not in answers:
                continue
            outcome = _outcome(comparison, answers[pair_id])
            if outcome == "conflict":
                conflicts.append((i, j, comparison))
            elif outcome == "uncertain":
                uncertain.append((i, j))
        by_reason: dict[str, list[tuple[int, int]]] = {}
        for pair_id, reason in unanswered.items():
            i, j, _ = pending[pair_id]
            by_reason.setdefault(reason, []).append((i, j))
        for reason, pairs in by_reason.items():
            skipped_nodes = _nodes_of(requirement_nodes, pairs)
            titles = ", ".join(f"'{n.title}'" for n in skipped_nodes)
            skipped_message = (
                f"Could not check these near-duplicate items for conflicting values: {titles} (the model call "
                "failed) -- compare them manually."
            )
            logger.warning(skipped_message)
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.CONFLICT_JUDGMENT_SKIPPED,
                    skipped_message,
                    node_ids=[n.local_id for n in skipped_nodes],
                    detail={"reason": reason},
                )
            )
        if uncertain:
            unsure_nodes = _nodes_of(requirement_nodes, uncertain)
            titles = ", ".join(f"'{n.title}'" for n in unsure_nodes)
            unsure_message = (
                f"Could not tell whether these near-duplicate items state different values for the same parameter: {titles} "
                "-- compare them manually."
            )
            logger.warning(unsure_message)
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.CONFLICT_JUDGMENT_SKIPPED,
                    unsure_message,
                    node_ids=[n.local_id for n in unsure_nodes],
                    detail={"reason": "uncertain"},
                )
            )
        if not conflicts:
            continue
        # Job transparency (B9): show the first two conflicting statements side by side on the running screen. Observation only (a
        # no-op unless live progress is on) and never raises.
        live_emitter = current_live_emitter()
        if live_emitter is not None:
            first, second, _ = conflicts[0]
            node_a, node_b = requirement_nodes[first], requirement_nodes[second]
            live_emitter.compare(
                kind="conflict",
                a_ref=node_a.local_id,
                a_text=node_a.description,
                b_ref=node_b.local_id,
                b_text=node_b.description,
                similarity=float(similarity_matrix[first, second]),
            )
        conflicting_values = list(dict.fromkeys(v for *_, c in conflicts for v in c.differing))
        cluster_nodes = _nodes_of(requirement_nodes, [(i, j) for i, j, _ in conflicts])
        # A bare local_id means nothing to a reviewer: the prose carries each member's TITLE (what the diff tree shows), and the
        # structured `node_ids` field is what the frontend builds the jump-to-node link from (CollapsibleWarnings.tsx).
        member_descriptions = ", ".join(f"'{n.title}'" for n in cluster_nodes)
        stated = f" ({' vs '.join(conflicting_values)})" if conflicting_values else ""
        message = (
            f"Near-duplicate items {member_descriptions} appear to state conflicting "
            f"values for the same parameter{stated} -- resolve before this "
            "can be finalized."
        )
        logger.warning(message)
        warnings.append(
            IntegrityWarning.make(
                WarningKind.NEAR_DUPLICATE_CONFLICT,
                message,
                node_ids=[n.local_id for n in cluster_nodes],
                detail={"conflictingValues": conflicting_values},
            )
        )
        for node in cluster_nodes:
            if RequirementQualityIssue.CONFLICTING_VALUE not in node.quality_issues:
                node.quality_issues = sorted(
                    [*node.quality_issues, RequirementQualityIssue.CONFLICTING_VALUE],
                    key=lambda i: i.value,
                )


def _nodes_of(nodes: list[WorkItemNode], pairs: list[tuple[int, int]]) -> list[WorkItemNode]:
    """The nodes of `pairs`, each once, in document order."""
    return [nodes[i] for i in sorted({i for pair in pairs for i in pair})]
