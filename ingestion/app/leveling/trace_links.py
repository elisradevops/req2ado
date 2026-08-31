from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from app.debug_capture import DebugCapture

from app.leveling.narration_publisher import LevelingProgress, ProgressCallback, _sample_titles
from app.workitem.model import (
    IntegrityWarning,
    TraceLink,
    TraceLinkResolutionStatus,
    TraceLinkTargetKind,
    WarningKind,
    WorkItemNode,
)

logger = logging.getLogger(__name__)

_EMBEDDED_TABLE_HTML_PATTERN = re.compile(r"<table.*?</table>", re.DOTALL)


def _without_embedded_table_html(description: str) -> str:
    """Strips any `<table>...</table>` block a table-fold pass (either
    BASELINE's/SURVEY's LLM-authored path or the deterministic-subtree
    span-claiming loop, see id_tree_builder.py's own parent-summary
    preservation fix) embedded into a node's description via
    assemble_description. Confirmed real job failure (live SURVEY run):
    this codebase's own convention is "text is NOT truncated" for
    trace-link inference (a real external ref can appear anywhere in real
    PROSE) -- but a table's raw cell data is categorically different
    content, carries essentially zero cross-reference signal (trace links
    are about phrases like "see Requirement 282393", never about table
    cell values), and can be very large (confirmed: 84KB+ across the
    tables of one real ICD's deterministic-subtree nodes alone). Left
    unstripped, it was measured to more-than-triple this call's total
    payload size for that document -- the direct, quantified cause of a
    real crash (a malformed non-object entry in the model's response,
    after the LLM's own JSON grammar came under pressure from the larger
    prompt). Figure captions are deliberately NOT stripped here -- they
    are real authored prose (unlike table markup) and stay small even
    with several folded into one node."""
    return _EMBEDDED_TABLE_HTML_PATTERN.sub("", description).strip()


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
    all_warnings: list[IntegrityWarning],
    progress_callback: ProgressCallback | None,
    blocks_total: int,
    branch_count: int,
    debug_capture: "DebugCapture | None" = None,
    kb_context: str | None = None,
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
    # both wasted ~8-12 tokens/node for no signal. Prose text is NOT
    # truncated here (and must not be) -- external ref ids like
    # "REQ-SYS-012" can appear anywhere in the description and the prompt
    # above depends on seeing them in full. Embedded table HTML IS
    # stripped (see _without_embedded_table_html's own docstring) -- it
    # carries no cross-reference signal and can be very large.
    llm_nodes = [
        {"node_id": node.local_id, "type": node.type.value, "text": _without_embedded_table_html(node.description)}
        for node in all_nodes
    ]
    # Whether two nodes relate AT ALL is still judged from node text alone,
    # same as before -- that relationship-EXISTENCE question genuinely
    # doesn't benefit from KB grounding. But WHICH link type to choose for
    # an ambiguous custom type (one ADO itself gives no definition for) can
    # benefit from the document's own KB material -- e.g. an org's own
    # traceability conventions doc may define what a specific custom link
    # type is meant to capture -- so `kb_context` is threaded through to
    # infer_trace_links despite the existence question not needing it.
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
        raw_links = link_type_client.infer_trace_links(llm_nodes, catalog, kb_context=kb_context)
    except ValueError as exc:
        logger.warning("Trace-link inference failed: %s", exc)
        if debug_capture is not None:
            debug_capture.capture("infer_trace_links", "document", str(exc))
        all_warnings.append(
            IntegrityWarning.make(
                WarningKind.TRACE_LINK_INFERENCE_FAILED,
                "Trace/coverage link inference failed for this document -- no trace links were added, "
                "but every proposed work item above is otherwise unaffected.",
            )
        )
        raw_links = []
    catalog_by_ref = {entry["reference_name"]: entry.get("name", entry["reference_name"]) for entry in catalog}
    text_by_node_id = {n["node_id"]: n["text"] for n in llm_nodes}
    for raw_link in raw_links:
        # Confirmed real job failure (live SURVEY run): the model can return
        # a syntactically-valid JSON list where most entries are proper
        # {source_node_id, reference_name, target_ref} objects but one is a
        # bare string -- not the "whole response is prose" failure the
        # try/except above already guards, so it reached here and crashed
        # the entire /level call on a single malformed element. Same
        # fail-open philosophy as the rest of this function: skip the one
        # bad entry, keep every valid link either side of it.
        if not isinstance(raw_link, dict):
            logger.warning("Trace-link inference returned a non-object entry, skipped: %r", raw_link)
            continue
        source_node_id = raw_link.get("source_node_id")
        reference_name = raw_link.get("reference_name")
        target_ref = raw_link.get("target_ref")
        # Real anti-hallucination guard (SWEEP.md section 7's "highest-
        # leverage fix in the whole audit"): a proposed link with no
        # evidence quote, or a quote that isn't a literal substring of the
        # exact text this call sent the model (llm_nodes' stripped text,
        # not the raw node.description -- see this function's own
        # llm_nodes construction comment for why), has no verifiable
        # textual basis and is dropped here, same fail-open-per-entry
        # philosophy as every other validation check in this loop.
        evidence_quote = raw_link.get("evidence_quote")
        source_text = text_by_node_id.get(source_node_id, "")
        if not evidence_quote or evidence_quote not in source_text:
            logger.warning("Trace-link inference proposed a link with no valid evidence quote, skipped: %r", raw_link)
            continue
        if source_node_id not in node_by_local_id:
            continue
        if catalog and reference_name not in valid_reference_names:
            continue
        if target_ref == source_node_id:
            # A self-referencing "link" carries no information -- confirmed
            # a real possibility, not a hypothetical: the model has no
            # structural signal preventing it from proposing a node relates
            # to itself.
            continue
        if target_ref in node_by_local_id:
            target_node = node_by_local_id[target_ref]
            source_node = node_by_local_id[source_node_id]
            if target_node.parent_local_id == source_node_id or source_node.parent_local_id == target_ref:
                # CONFIRMED REAL BUG, found via live testing: this whole-tree
                # call has no structural signal telling it two nodes are
                # already directly related via the tree's OWN parent/child
                # hierarchy (that's a separate field entirely, never part of
                # the `llm_nodes` payload above) -- it can and does propose
                # e.g. an "Affects" trace link from a parent requirement to
                # its own child, which confirm() then writes as a SECOND,
                # fully redundant ADO link alongside the real Parent/Child
                # hierarchy link already covering the exact same pair.
                # Direct parent/child (either direction) is dropped here,
                # before it ever reaches confirm() -- a trace/coverage link
                # is meant to capture relationships the hierarchy does NOT
                # already express.
                continue
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
