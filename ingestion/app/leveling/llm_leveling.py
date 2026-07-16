from __future__ import annotations

import hashlib
from typing import Protocol

from app.canonical.model import CanonicalDoc
from app.distillation.title import extract_baseline_title
from app.kb.kb_vector_store import KbVectorStore
from app.kb.retrieval import retrieve_context
from app.leveling.depth import resolve_block_depth
from app.leveling.profiles import LevelingProfile
from app.workitem.model import (
    RequirementQualityIssue,
    RequirementTag,
    TraceLink,
    TraceLinkResolutionStatus,
    TraceLinkTargetKind,
    WorkItemMode,
    WorkItemNode,
    WorkItemTree,
    WorkItemType,
)


class LlmLevelingClient(Protocol):
    """Interface for SURVEY-mode hierarchy inference. No real implementation
    exists in this phase — the orchestrator's LLM proxy/redaction client
    (which would host the actual Open WebUI call) is separate, not-yet-built
    infrastructure. This Protocol lets tests and future callers inject any
    conforming client. Matches the runtime prompt contract documented in
    docs/architecture.md: strict JSON {node_id,type,parent_id}[]."""

    def infer_hierarchy(self, outline: str, profile_hint: LevelingProfile | None, kb_context: str | None = None) -> list[dict]: ...


class BatchedRequirementClient(Protocol):
    """Interface for whole-document SURVEY requirement generation — one call
    covering every node, not one call per node (see
    OrchestratorLlmClient.generate_requirements_for_document's docstring for
    why: a per-node design made ~101 sequential LLM calls for a 50-block
    document). Deliberately narrower than SurveyRequirementClient (which is
    still used by build_survey_requirements.py for its own single-block
    callers, untouched by this phase) — this Protocol's single method takes
    ALL blocks at once."""

    def generate_requirements_for_document(
        self, blocks_by_node_id: dict[str, str], kb_context: str | None = None
    ) -> dict[str, list[dict]]: ...


class BatchedScoringClient(Protocol):
    """Interface for whole-document SURVEY quality scoring — one call
    covering every node's FINAL formalized description, mirroring
    BatchedRequirementClient's one-call-per-document rationale. Runs
    after formalization (build_survey_tree calls it with each node's
    already-formalized description, not the raw block text)."""

    def score_requirements_for_document(
        self, descriptions_by_node_id: dict[str, str], kb_context: str | None = None
    ) -> dict[str, dict]: ...


class TraceLinkInferenceClient(Protocol):
    """Interface for SURVEY-mode trace/coverage link inference — one call
    covering every node (whole-tree), mirroring BatchedRequirementClient's
    one-call-per-document rationale. Given the full node list and a
    discovered ADO link-type catalog, proposes zero or more links; anything
    the model returns with a reference_name outside the supplied catalog is
    dropped by build_survey_tree, never trusted blind."""

    def infer_trace_links(
        self, nodes: list[dict], link_type_catalog: list[dict], kb_context: str | None = None
    ) -> list[dict]: ...


def _build_outline(doc: CanonicalDoc) -> str:
    lines = []
    for block in doc.blocks:
        _, display_text = resolve_block_depth(block)
        lines.append(display_text)
    return "\n".join(lines)


def build_survey_tree(
    doc: CanonicalDoc,
    llm_client: LlmLevelingClient,
    requirement_client: BatchedRequirementClient,
    area_path: str | None = None,
    embed_client: object | None = None,
    vector_store: KbVectorStore | None = None,
    scoring_client: BatchedScoringClient | None = None,
    link_type_client: TraceLinkInferenceClient | None = None,
    link_type_catalog: list[dict] | None = None,
) -> WorkItemTree:
    """SURVEY-mode leveling: infers hierarchy, then formalizes every node's
    description into 'shall'-style requirement text + taxonomy tags via ONE
    batched call (see BatchedRequirementClient's docstring for why this is
    one call, not one per node). Title is derived deterministically from the
    first generated requirement's text via extract_baseline_title — NO LLM
    call for titling (a first draft added a distill_title LLM call; dropped
    per the design review, since extract_baseline_title already does the
    truncation work with no quality loss and no extra round-trip). Multiple
    generated requirements for one block are joined with a blank line
    between them — a block can legitimately decompose into more than one
    formal requirement. fidelity_hash is computed over the FINAL (formalized)
    description, since that's the content actually written to ADO and the
    idempotency map's key must match what a re-run would produce — but note
    this is a WEAKER guarantee than BASELINE's verbatim-source-span hash:
    temperature=0 is mostly-but-not-guaranteed deterministic, so a model or
    prompt change can shift this hash and produce a duplicate create on
    re-run. Embedding dedup partially backstops this; it is not a substitute.
    When area_path, embed_client, and vector_store are all supplied, one KB
    retrieval call grounds both the hierarchy and requirement-generation
    calls with the same retrieved context; when any is omitted, retrieval is
    skipped entirely (kb_context stays None), matching pre-KB behavior
    exactly. kb_citations (the deduped list of KB source_file names that grounded
    kb_context) is returned once on the tree, not per node — retrieval runs
    once per document, so every node in a tree shares the same citation
    list (P3c source provenance).

    When scoring_client is supplied, one additional batched call
    scores every node's FINAL formalized description using the SAME
    kb_context already computed for the other two calls; when scoring_client
    is omitted, every node's quality_score stays None and quality_issues
    stays empty — matching pre-scoring behavior exactly. Per-node scoring
    entries that are missing, malformed, or out of the 0-100 range are
    tolerated individually and never abort the batch.

    When link_type_client is supplied, one additional batched call
    infers_trace_links over the whole node set using the SAME kb_context
    already computed for the other calls, plus link_type_catalog (the ADO
    link-type catalog discovered by the orchestrator, Task 5); when
    link_type_client is omitted, trace_links stays [] — matching
    pre-trace-link behavior exactly. Every returned link is validated
    before being trusted: a source_node_id that doesn't match any node
    actually produced by this build is always dropped, and — when a
    non-empty link_type_catalog was supplied — a reference_name outside
    that catalog is dropped too (the model is never trusted blind on
    either axis). An empty/omitted catalog does not itself suppress
    every link; it just means reference_name isn't validated against a
    known list for that call. A link's target_ref is classified as
    intraJob when it matches
    another node's local_id in this same tree, and as crossJob (treated as
    an opaque customer-id string) for anything else — this is a heuristic,
    not a lookup against ADO, since intraJob is not verifiable until write
    time."""
    outline = _build_outline(doc)
    kb_context: str | None = None
    kb_citations: list[str] = []
    if area_path is not None and embed_client is not None and vector_store is not None:
        kb_context, kb_citations = retrieve_context(area_path, outline, embed_client, vector_store)
    hierarchy = llm_client.infer_hierarchy(outline, profile_hint=None, kb_context=kb_context)
    # Tolerant of LLM non-compliance: the prompt asks for a JSON ARRAY, but a
    # small local model (observed with llama3.2:1b against a short outline)
    # sometimes collapses to a single JSON object instead of a one-element
    # array. Normalize rather than let a single well-formed-but-unwrapped
    # object crash the whole job with a cryptic "string indices must be
    # integers" (iterating a dict yields its string keys, not its values).
    if isinstance(hierarchy, dict):
        hierarchy = [hierarchy]

    block_by_index = {str(i): block for i, block in enumerate(doc.blocks)}
    hierarchy_by_node_id = {entry["node_id"]: entry for entry in hierarchy}
    blocks_by_node_id = {
        node_id: resolve_block_depth(block_by_index[node_id])[1]
        for node_id in hierarchy_by_node_id
        if node_id in block_by_index
    }
    generated_by_node_id = requirement_client.generate_requirements_for_document(blocks_by_node_id, kb_context=kb_context)

    nodes: list[WorkItemNode] = []
    for node_id, entry in hierarchy_by_node_id.items():
        block = block_by_index.get(node_id)
        if block is None:
            continue
        display_text = blocks_by_node_id[node_id]
        raw_generated = generated_by_node_id.get(node_id, [])

        # Tolerant of LLM non-compliance, same philosophy as _strip_json_fence:
        # a single malformed item (missing 'text', or a 'tags' value outside
        # RequirementTag) must not abort formalization for the whole document.
        texts = [item["text"] for item in raw_generated if item.get("text")]
        valid_tag_values = {t.value for t in RequirementTag}
        if texts:
            description = "\n\n".join(texts)
            tags = sorted(
                {
                    RequirementTag(tag)
                    for item in raw_generated
                    for tag in item.get("tags", [])
                    if tag in valid_tag_values
                },
                key=lambda t: t.value,
            )
            title = extract_baseline_title(texts[0])
        else:
            # No formal requirement extracted (e.g. a heading-only block) —
            # fall back to the raw display text rather than an empty
            # description, which would otherwise silently discard content.
            description = display_text
            tags = []
            title = extract_baseline_title(display_text)

        nodes.append(
            WorkItemNode(
                local_id=node_id,
                type=WorkItemType(entry["type"]),
                parent_local_id=entry["parent_id"],
                title=title,
                description=description,
                customer_id=None,
                source_ref=block.source_ref,
                fidelity_hash=hashlib.sha256(description.encode()).hexdigest(),
                tags=tags,
                mode=WorkItemMode.SURVEY,
            )
        )

    if scoring_client is not None:
        descriptions_by_node_id = {node.local_id: node.description for node in nodes}
        scoring_by_node_id = scoring_client.score_requirements_for_document(descriptions_by_node_id, kb_context=kb_context)
        valid_issue_values = {issue.value for issue in RequirementQualityIssue}
        for node in nodes:
            raw_entry = scoring_by_node_id.get(node.local_id, {})
            if not isinstance(raw_entry, dict):
                raw_entry = {}
            raw_score = raw_entry.get("score")
            if isinstance(raw_score, int) and not isinstance(raw_score, bool) and 0 <= raw_score <= 100:
                node.quality_score = raw_score
            raw_issues = raw_entry.get("issues", [])
            if isinstance(raw_issues, list):
                node.quality_issues = sorted(
                    {
                        RequirementQualityIssue(issue)
                        for issue in raw_issues
                        if isinstance(issue, str) and issue in valid_issue_values
                    },
                    key=lambda issue: issue.value,
                )

    trace_links: list[TraceLink] = []
    if link_type_client is not None:
        catalog = link_type_catalog or []
        valid_reference_names = {entry["reference_name"] for entry in catalog}
        node_by_local_id = {node.local_id: node for node in nodes}
        llm_nodes = [
            {"node_id": node.local_id, "type": node.type.value, "title": node.title, "text": node.description}
            for node in nodes
        ]
        raw_links = link_type_client.infer_trace_links(llm_nodes, catalog, kb_context=kb_context)
        catalog_by_ref = {entry["reference_name"]: entry.get("name", entry["reference_name"]) for entry in catalog}
        for raw_link in raw_links:
            source_node_id = raw_link.get("source_node_id")
            reference_name = raw_link.get("reference_name")
            target_ref = raw_link.get("target_ref")
            if source_node_id not in node_by_local_id:
                continue
            # Only enforce catalog membership when a catalog was actually
            # supplied. An empty catalog means discovery wasn't wired up
            # (or found nothing) for this call, not "reject everything" —
            # validation is a defense against a hallucinated reference_name
            # among real catalog entries, not a way to blanket-suppress
            # every link whenever the catalog happens to be empty.
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

    return WorkItemTree(nodes=nodes, kb_citations=kb_citations, trace_links=trace_links)
