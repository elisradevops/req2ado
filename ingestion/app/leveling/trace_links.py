from __future__ import annotations

import logging
import re
import time
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

# One item cannot attach to more targets than this: a source that "references" dozens of others is the model listing
# everything, not a reference (a Sonnet run proposed 124 links where the other models proposed 27 to 31).
MAX_LINKS_PER_SOURCE = 8
_MIN_TARGET_WORD_CHARS = 4


# Words that appear in requirement titles everywhere and therefore say nothing about which item a quote refers to.
_GENERIC_WORDS = frozenset(
    "shall should must will that this with from have each when where which their there than then into only also such "
    "system systems requirement requirements item items document section provide provides support supports".split()
)


def _words(text: str) -> list[str]:
    return re.findall(r"\w+", text.casefold())


def _quote_names_target(quote: str, target_ref: str, target_node: "WorkItemNode | None") -> bool:
    """True when the evidence quote refers to the item it links to: it contains the target's customer id, the target's whole
    title, or a distinctive word of that title (not a word every requirement uses); for a target in another job, the target
    reference itself. A quote that is real but says nothing about the target is no evidence that the source refers to it."""
    lowered = quote.casefold()
    if target_node is None:
        return target_ref.casefold() in lowered
    if target_node.customer_id and target_node.customer_id.casefold() in lowered:
        return True
    title_words = _words(target_node.title)
    quote_words = _words(quote)
    if title_words and any(quote_words[i:i + len(title_words)] == title_words for i in range(len(quote_words) - len(title_words) + 1)):
        return True
    return any(w in quote_words for w in title_words if len(w) >= _MIN_TARGET_WORD_CHARS and w not in _GENERIC_WORDS)


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
        self,
        nodes: list[dict],
        link_type_catalog: list[dict],
        kb_context: str | None = None,
        user_id: str | None = None,
    ) -> list[dict]: ...


# Bounds for one trace-link request: node count and the characters of node text it carries. The upstream cuts
# a request at ~300 s; a whole 545-block tree in one call ran into that, and a Sonnet run of 4-5 large chunks took ~530 s in total
# (about 2 min each), so chunks stay small enough for one call to finish well under that cut.
_TRACE_CHUNK_MAX_NODES = 80
_TRACE_CHUNK_MAX_CHARS = 30_000


def _chunk_nodes(llm_nodes: list[dict]) -> list[list[dict]]:
    """Consecutive (document-order) chunks, each within both bounds; a single oversized node is its own chunk."""
    chunks: list[list[dict]] = []
    current: list[dict] = []
    current_chars = 0
    for node in llm_nodes:
        size = len(node["text"])
        if current and (len(current) >= _TRACE_CHUNK_MAX_NODES or current_chars + size > _TRACE_CHUNK_MAX_CHARS):
            chunks.append(current)
            current, current_chars = [], 0
        current.append(node)
        current_chars += size
    if current:
        chunks.append(current)
    return chunks


def _infer_chunk_once(
    client: "TraceLinkInferenceClient", nodes: list[dict], catalog: list[dict], kb_context: str | None,
    user_id: str | None,
) -> tuple[list[dict] | None, str | None]:
    """(links, None) on success, (None, short reason) when the call failed or answered with something unusable."""
    started = time.monotonic()
    chars = sum(len(n["text"]) for n in nodes)
    try:
        links = client.infer_trace_links(nodes, catalog, kb_context=kb_context, user_id=user_id)
    except Exception as exc:  # noqa: BLE001 -- enrichment must never fail the job
        reason = " ".join(str(exc).split())[:200] or type(exc).__name__
        logger.warning(
            "Trace-link call failed: nodes=%d chars=%d seconds=%.1f reason=%s", len(nodes), chars, time.monotonic() - started, reason,
        )
        return None, reason
    logger.info(
        "Trace-link call: nodes=%d chars=%d seconds=%.1f links=%d", len(nodes), chars, time.monotonic() - started,
        len(links) if isinstance(links, list) else 0,
    )
    return (links if isinstance(links, list) else []), None


def _infer_chunk_resilient(
    client: "TraceLinkInferenceClient", nodes: list[dict], catalog: list[dict], kb_context: str | None,
    user_id: str | None,
) -> tuple[list[list[dict]], list[tuple[list[dict], str]]]:
    """(answered link lists, [(skipped nodes, reason)]): one retry as two halves (a smaller request) when the
    chunk has more than one node, the same call once more otherwise."""
    links, reason = _infer_chunk_once(client, nodes, catalog, kb_context, user_id)
    if links is not None:
        return [links], []
    groups = [nodes[: len(nodes) // 2], nodes[len(nodes) // 2:]] if len(nodes) > 1 else [nodes]
    answered: list[list[dict]] = []
    skipped: list[tuple[list[dict], str]] = []
    for group in groups:
        group_links, group_reason = _infer_chunk_once(client, group, catalog, kb_context, user_id)
        if group_links is not None:
            answered.append(group_links)
        else:
            skipped.append((group, group_reason or reason or "unknown"))
    return answered, skipped


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
    user_id: str | None = None,
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
    # Trace links are an enrichment pass over finished analysis and scoring work, so no failure here may fail the
    # job (a ValueError from a prose reply aborted whole jobs; a 502 after the upstream's ~300 s cut did the same
    # after 25 minutes). The nodes go in bounded chunks (count and request characters); a failed chunk is asked
    # again as two halves, and whatever is still unanswered is reported, never dropped silently.
    raw_links: list[dict] = []
    skipped_groups: list[tuple[list[dict], str]] = []
    any_answered = False
    for chunk in _chunk_nodes(llm_nodes):
        answered, skipped = _infer_chunk_resilient(link_type_client, chunk, catalog, kb_context, user_id)
        for links in answered:
            any_answered = True
            raw_links.extend(links)
        skipped_groups.extend(skipped)
    if skipped_groups and not any_answered:
        first_reason = skipped_groups[0][1]
        logger.warning("Trace-link inference failed: %s", first_reason)
        if debug_capture is not None:
            debug_capture.capture("infer_trace_links", "document", first_reason)
        all_warnings.append(
            IntegrityWarning.make(
                WarningKind.TRACE_LINK_INFERENCE_FAILED,
                "Trace/coverage link inference failed for this document -- no trace links were added, "
                "but every proposed work item above is otherwise unaffected.",
            )
        )
    else:
        for group, reason in skipped_groups:
            logger.warning("Trace-link inference skipped %d node(s): %s", len(group), reason)
            all_warnings.append(
                IntegrityWarning.make(
                    WarningKind.TRACE_LINKS_PARTIAL,
                    f"Trace/coverage links could not be inferred for {len(group)} item(s) (the model call failed) "
                    "-- add their links in Azure DevOps after you confirm.",
                    node_ids=[n["node_id"] for n in group],
                    detail={"reason": reason},
                )
            )
    catalog_by_ref = {entry["reference_name"]: entry.get("name", entry["reference_name"]) for entry in catalog}
    text_by_node_id = {n["node_id"]: n["text"] for n in llm_nodes}
    links_per_source: dict[str, int] = {}
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
        if not isinstance(evidence_quote, str) or not evidence_quote or evidence_quote not in source_text:
            logger.warning("Trace-link inference proposed a link with no valid evidence quote, skipped: %r", raw_link)
            continue
        if source_node_id not in node_by_local_id:
            continue
        if catalog and reference_name not in valid_reference_names:
            continue
        if not isinstance(target_ref, str) or not _quote_names_target(evidence_quote, target_ref, node_by_local_id.get(target_ref)):
            logger.info("Trace-link inference proposed a link whose evidence does not name its target, skipped: %r", raw_link)
            continue
        if links_per_source.get(source_node_id, 0) >= MAX_LINKS_PER_SOURCE:
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
            links_per_source[source_node_id] = links_per_source.get(source_node_id, 0) + 1
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
            links_per_source[source_node_id] = links_per_source.get(source_node_id, 0) + 1
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
