from __future__ import annotations

import logging
from typing import Protocol

import numpy as np

from app.dedup.embedding_blend import blend_embeddings
from app.leveling.narration_publisher import LevelingProgress, ProgressCallback
from app.workitem.model import IntegrityWarning, RequirementQualityIssue, WarningKind, WorkItemNode, WorkItemType

logger = logging.getLogger(__name__)


class ConflictJudgeClient(Protocol):
    """Interface for judging a near-duplicate cluster's real relationship
    (see _detect_conflicting_duplicates's own docstring for the capability
    gap this closes -- this codebase had NO conflict/contradiction
    detection anywhere before this existed). Entirely optional (default
    None, same opt-in-capability convention as every other client here) --
    when omitted, near-duplicate Requirements are simply never checked for
    conflict, matching pre-existing behavior exactly."""

    def judge_duplicate_cluster(self, texts_by_id: dict[str, str]) -> dict: ...


_DUPLICATE_CLUSTER_COSINE_THRESHOLD = 0.85


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(y * y for y in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def _detect_conflicting_duplicates(
    all_nodes: list[WorkItemNode],
    embed_client: object | None,
    conflict_client: ConflictJudgeClient | None,
    warnings: list[IntegrityWarning],
    progress_callback: ProgressCallback | None = None,
    blocks_total: int = 0,
    branch_count: int = 0,
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
    dependency), and for each cluster of >= 2 members asks `conflict_client`
    whether they're redundant/contradictory/distinct (see
    ConflictJudgeClient's own docstring). A 'contradictory' verdict adds a
    `conflict` warning and tags every member with
    RequirementQualityIssue.CONFLICTING_VALUE.

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
    is precisely the pair this pass exists to surface.

    Entirely optional and fail-open: `embed_client`/`conflict_client`
    omitted (the default) is a no-op, matching pre-existing behavior
    exactly. An embed or judge-call failure degrades to skipping that
    step/cluster, never fails the job -- same "must never fail a SURVEY
    job" philosophy as KB retrieval and trace-link inference."""
    if embed_client is None or conflict_client is None:
        return
    requirement_nodes = [n for n in all_nodes if n.type == WorkItemType.REQUIREMENT]
    if len(requirement_nodes) < 2:
        return
    if progress_callback is not None:
        progress_callback(
            LevelingProgress(
                phase="detect_conflicts", branch_index=None, branch_count=branch_count,
                blocks_done=blocks_total, blocks_total=blocks_total,
                kb_grounded=False, kb_citations=[],
            )
        )
    node_count = len(requirement_nodes)
    try:
        raw_embeddings = embed_client.embed(
            [n.title or n.description for n in requirement_nodes]
            + [n.description for n in requirement_nodes]
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

    for member_indices in clusters.values():
        if len(member_indices) < 2:
            continue
        cluster_nodes = [requirement_nodes[i] for i in member_indices]
        texts_by_id = {n.local_id: n.description for n in cluster_nodes}
        try:
            verdict_entry = conflict_client.judge_duplicate_cluster(texts_by_id)
        except Exception as exc:
            logger.warning(
                "Duplicate-cluster conflict judgment failed for %d node(s), skipping cluster: %s",
                len(cluster_nodes), exc,
            )
            continue
        if not isinstance(verdict_entry, dict) or verdict_entry.get("verdict") != "contradictory":
            continue
        conflicting_values = verdict_entry.get("conflicting_values") or []
        # Confirmed real gap (user-reported): a bare local_id list
        # ("det0_h6_1_2_1") means nothing to a reviewer -- it isn't visible
        # anywhere in the diff-tree UI on its own. Each member's real TITLE
        # (what the reviewer actually sees in the tree) is all the prose
        # carries; the structured `node_ids` field below (not a text tag) is
        # what the frontend uses to build a real jump-to-node link -- see
        # CollapsibleWarnings.tsx, which reads warning.nodeIds directly and
        # never parses this sentence.
        member_descriptions = ", ".join(f"'{n.title}'" for n in cluster_nodes)
        message = (
            f"Near-duplicate items {member_descriptions} appear to state conflicting "
            f"values for the same parameter ({conflicting_values}) -- resolve before this "
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
