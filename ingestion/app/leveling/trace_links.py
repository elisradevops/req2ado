from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from app.debug_capture import DebugCapture

from app.leveling.narration_publisher import LevelingProgress, ProgressCallback, _sample_titles
from app.workitem.model import (
    TraceLink,
    TraceLinkResolutionStatus,
    TraceLinkTargetKind,
    WorkItemNode,
)

logger = logging.getLogger(__name__)


class TraceLinkInferenceClient(Protocol):
    """Interface for SURVEY-mode trace/coverage link inference — one call
    covering every node ACROSS THE WHOLE TREE (all branches combined, not
    per-branch — a trace/coverage link can legitimately point from one
    branch's node to another's), mirroring BatchedRequirementClient's
    one-call-per-document rationale. Given the full node list and a
    discovered ADO link-type catalog, proposes zero or more links; anything
    the model returns with a reference_name outside the supplied catalog is
    dropped by build_survey_tree, never trusted blind."""

    def infer_trace_links(
        self, nodes: list[dict], link_type_catalog: list[dict], kb_context: str | None = None
    ) -> list[dict]: ...


def _infer_trace_links_for_nodes(
    all_nodes: list[WorkItemNode],
    link_type_client: TraceLinkInferenceClient,
    catalog: list[dict],
    all_warnings: list[str],
    progress_callback: ProgressCallback | None,
    blocks_total: int,
    branch_count: int,
    debug_capture: "DebugCapture | None" = None,
) -> list[TraceLink]:
    """Whole-tree trace-link inference, shared by both the LLM-analysis path
    (build_survey_tree's own main body) and the pure-deterministic guard
    (build_survey_tree, above) -- previously only wired for the former,
    confirmed live to leave real cross-references in a deterministically-
    built document ("see Requirement 282393: BP - PS_GA") as dead prose
    with no resolved link at all."""
    trace_links: list[TraceLink] = []
    valid_reference_names = {entry["reference_name"] for entry in catalog}
    node_by_local_id = {node.local_id: node for node in all_nodes}
    # title dropped -- description already carries the same content, and
    # the model references node_id (not title) in its output; sending
    # both wasted ~8-12 tokens/node for no signal. text is NOT truncated
    # here (and must not be) -- external ref ids like "REQ-SYS-012" can
    # appear anywhere in the description and the prompt above depends on
    # seeing them in full.
    llm_nodes = [
        {"node_id": node.local_id, "type": node.type.value, "text": node.description}
        for node in all_nodes
    ]
    # Trace-link inference judges relationships between already-generated
    # nodes, not raw source text, so it isn't grounded against KB context
    # the way the other three calls are -- passing None here is a
    # deliberate simplification, not an oversight.
    if progress_callback is not None:
        progress_callback(
            LevelingProgress(
                phase="infer_trace_links", branch_index=None, branch_count=branch_count,
                blocks_done=blocks_total, blocks_total=blocks_total, kb_grounded=False, kb_citations=[],
                model=getattr(link_type_client, "model", None),
            )
        )
    # Confirmed real job failure: this call serializes EVERY node in the
    # whole document into one prompt (the largest single payload in this
    # module) and, unlike analyze_section/scoring, has no fallback
    # degradation of its own -- a model occasionally ignoring the "no
    # prose" instruction (observed live: a 5-character non-JSON reply,
    # 'Based') previously raised ValueError and aborted the ENTIRE job,
    # discarding all already-completed analysis and scoring work over
    # what is purely an enrichment pass. Same "must never fail a SURVEY
    # job" fail-open philosophy already applied to KB retrieval
    # (retrieve_context) and KB relevance verification
    # (_resolve_kb_citations) above -- trace links degrade to [], not
    # the whole job.
    try:
        raw_links = link_type_client.infer_trace_links(llm_nodes, catalog, kb_context=None)
    except ValueError as exc:
        logger.warning("Trace-link inference failed: %s", exc)
        if debug_capture is not None:
            debug_capture.capture("infer_trace_links", "document", str(exc))
        all_warnings.append(
            "Trace/coverage link inference failed for this document -- no trace links were added, "
            "but every proposed work item above is otherwise unaffected."
        )
        raw_links = []
    catalog_by_ref = {entry["reference_name"]: entry.get("name", entry["reference_name"]) for entry in catalog}
    for raw_link in raw_links:
        source_node_id = raw_link.get("source_node_id")
        reference_name = raw_link.get("reference_name")
        target_ref = raw_link.get("target_ref")
        if source_node_id not in node_by_local_id:
            continue
        if catalog and reference_name not in valid_reference_names:
            continue
        if target_ref in node_by_local_id:
            trace_links.append(
                TraceLink(
                    source_local_id=source_node_id,
                    reference_name=reference_name,
                    display_name=catalog_by_ref.get(reference_name, reference_name),
                    target_kind=TraceLinkTargetKind.INTRA_JOB,
                    target_local_id=target_ref,
                    resolution_status=TraceLinkResolutionStatus.PENDING,
                )
            )
        elif target_ref:
            trace_links.append(
                TraceLink(
                    source_local_id=source_node_id,
                    reference_name=reference_name,
                    display_name=catalog_by_ref.get(reference_name, reference_name),
                    target_kind=TraceLinkTargetKind.CROSS_JOB,
                    target_customer_id=target_ref,
                    resolution_status=TraceLinkResolutionStatus.PENDING,
                )
            )
    # Completion event, real endpoint titles rather than a bare phase name --
    # the single kickoff fire above only signals "this whole-tree call is
    # starting"; without this there was previously no way to see WHICH
    # relationships were actually found (source_node_id/target_ref are
    # opaque local ids, meaningless to a human reading the activity log).
    if progress_callback is not None and trace_links:
        endpoint_labels = [
            f"{node_by_local_id[link.source_local_id].title} -> "
            f"{node_by_local_id[link.target_local_id].title if link.target_local_id else link.target_customer_id} "
            f"({link.display_name})"
            for link in trace_links
            if link.source_local_id in node_by_local_id
        ]
        progress_callback(
            LevelingProgress(
                phase="infer_trace_links", branch_index=None, branch_count=branch_count,
                blocks_done=blocks_total, blocks_total=blocks_total, kb_grounded=False, kb_citations=[],
                model=getattr(link_type_client, "model", None),
                sample_titles=_sample_titles(endpoint_labels),
            )
        )
    return trace_links
