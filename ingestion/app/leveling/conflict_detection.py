from __future__ import annotations

import logging
from typing import Protocol

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

    Embeds every Requirement-type node's description (one batched call),
    clusters at >= _DUPLICATE_CLUSTER_COSINE_THRESHOLD cosine similarity
    (a plain in-memory pass over this job's own nodes, not a new
    vector-store dependency), and for each cluster of >= 2 members asks
    `conflict_client` whether they're redundant/contradictory/distinct
    (see ConflictJudgeClient's own docstring). A 'contradictory' verdict
    adds a `conflict` warning and tags every member with
    RequirementQualityIssue.CONFLICTING_VALUE.

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
    try:
        embeddings = embed_client.embed([n.description for n in requirement_nodes])
    except Exception as exc:
        logger.warning("Duplicate-cluster embedding failed, skipping conflict detection: %s", exc)
        return

    # Union-find over cosine-similar pairs -- O(n^2) pairwise comparisons
    # is acceptable here (pure arithmetic, no LLM/network call per pair;
    # runs once over a job's own Requirement count, typically hundreds).
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
            similarity = _cosine_similarity(embeddings[i], embeddings[j])
            if similarity >= _DUPLICATE_CLUSTER_COSINE_THRESHOLD:
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
