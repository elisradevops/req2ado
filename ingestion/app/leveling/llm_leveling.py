from __future__ import annotations

import hashlib
import logging
import re
from typing import Callable, Protocol

from app.canonical.model import Block, BlockKind, CanonicalDoc, Figure, Table
from app.distillation.title import extract_baseline_title
from app.kb.kb_vector_store import KbVectorStore
from app.kb.retrieval import retrieve_context
from app.leveling.depth import resolve_block_depth
from app.leveling.narration_publisher import LevelingProgress, Phase, ProgressCallback
from app.leveling.profiles import LevelingProfile
from app.leveling.tree_builder import _bound_branch_size, _split_into_branches
from app.quality.criteria_retrieval import CriteriaRetriever
from app.workitem.model import (
    KbCitation,
    KbCitationRelevance,
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

logger = logging.getLogger(__name__)

# Fraction of a candidate-dropped block's own significant vocabulary that
# must appear somewhere in the generated output (any node, not just an
# adjacent one) before it's considered "merged into another node's text"
# rather than genuinely dropped. Deliberately low, same rationale as
# _LOW_GROUNDING_THRESHOLD: a legitimate merge/paraphrase can reuse a
# minority of the block's exact words while still incorporating its
# content -- this only needs to rule out "no trace at all".
_BLOCK_COVERAGE_OVERLAP_THRESHOLD = 0.3

# grounding_score below this is flagged in warnings -- deliberately low: a
# legitimate formalization/paraphrase of a source sentence into "shall"
# language can genuinely reuse a minority of the source's exact words while
# still being fully grounded (different phrasing, added standard terms like
# "shall"/"the system"). This is a coarse hallucination SIGNAL for a human
# reviewer, not a hard quality gate -- it does not fail or drop anything.
_LOW_GROUNDING_THRESHOLD = 0.2
# Ceiling on how many blocks a single SURVEY branch's infer_hierarchy/
# generate_requirements_for_document calls are ever handed at once. Real
# documents can have very few, wildly unbalanced top-level sections
# (observed live: an ICD with only 4 top-level sections, one 372 blocks) --
# _split_into_branches's document-structure-driven split alone cannot
# guarantee a small branch; _bound_branch_size enforces this ceiling
# directly regardless of the document's actual heading structure. Not a
# precisely-tuned token budget -- a conservative block-count proxy for "this
# branch is small enough that one more level of recursive splitting isn't
# needed".
#
# Originally 60, chosen deliberately small to avoid the per-call timeout
# that motivated this whole mechanism. Live testing against the same 679
# block ICD showed the real bottleneck is the OPPOSITE problem: at 60, the
# document's own fine-grained numbering recursively split down to 152
# branches (avg ~4.5 blocks each), and 2-4 sequential LLM calls per branch
# (~300-600 total, strictly one-at-a-time) made total /level wall time
# dominated by fixed per-call overhead, not model inference time -- pasting
# the WHOLE document into a chat UI in one shot was fast precisely because
# it's one call, not many. Raised to 200: modern local models here run with
# 32k+ context, comfortably fitting a 200-block branch's prompt+response, so
# this still guards against genuine context overflow on an unbounded branch
# while cutting round-trip count roughly in proportion (this same document
# now produces a handful of branches instead of 152).
_MAX_SURVEY_BRANCH_BLOCK_COUNT = 200
# Common connective/requirement-boilerplate words excluded from the overlap
# calculation so they don't inflate the score for genuinely unrelated
# content that merely happens to also be phrased as a "shall" statement.
_GROUNDING_STOPWORDS = {
    "a", "an", "the", "shall", "system", "is", "are", "of", "to", "and", "or",
    "in", "on", "for", "with", "be", "will", "this", "that", "it", "its",
}
_WORD_PATTERN = re.compile(r"[a-z0-9]+")


def _significant_words(text: str) -> set[str]:
    return {word for word in _WORD_PATTERN.findall(text.lower()) if word not in _GROUNDING_STOPWORDS}


def _grounding_score(generated_text: str, source_text: str) -> float:
    """Fraction of the generated text's own significant vocabulary that
    also appears in its source block's text -- precision, not similarity:
    a generated description using mostly words absent from the source
    (invented/unrelated content) scores low regardless of the source's own
    length. 1.0 when the generated text has no significant words at all
    (nothing to be ungrounded about) or when every significant word is
    present in the source."""
    generated_words = _significant_words(generated_text)
    if not generated_words:
        return 1.0
    source_words = _significant_words(source_text)
    return len(generated_words & source_words) / len(generated_words)


def _block_content_appears_in_generated_output(block_text: str, all_generated_texts: list[str]) -> bool:
    """True if the block's own significant vocabulary meaningfully overlaps
    with the generated output taken as a WHOLE (every node's text, not just
    one) -- a block whose node_id the LLM never referenced in `hierarchy`
    can still have had its content folded into a DIFFERENT node's formalized
    text (a legitimate merge), which per-node lookups can't detect. Trivially
    True for a block with no significant words at all (nothing to lose)."""
    block_words = _significant_words(block_text)
    if not block_words:
        return True
    combined_words = _significant_words(" ".join(all_generated_texts))
    overlap = len(block_words & combined_words) / len(block_words)
    return overlap >= _BLOCK_COVERAGE_OVERLAP_THRESHOLD


class LlmLevelingClient(Protocol):
    """Interface for SURVEY-mode hierarchy inference. No real implementation
    exists in this phase — the orchestrator's LLM proxy/redaction client
    (which would host the actual Open WebUI call) is separate, not-yet-built
    infrastructure. This Protocol lets tests and future callers inject any
    conforming client. Matches the runtime prompt contract documented in
    docs/architecture.md: strict JSON {node_id,type,parent_id}[].
    `kb_context` (see app.kb.retrieval.retrieve_context) is optional
    SharePoint/OneDrive-sourced reference material -- omitted (None) is
    byte-identical to before KB grounding existed."""

    def infer_hierarchy(
        self, outline: str, profile_hint: LevelingProfile | None, kb_context: str | None = None
    ) -> list[dict]: ...


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
    existed."""

    def score_requirements_for_document(
        self,
        descriptions_by_node_id: dict[str, str],
        criteria_context: str | None = None,
        kb_context: str | None = None,
    ) -> dict[str, dict]: ...


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


class KbRelevanceClient(Protocol):
    """Interface for verifying whether KB snippets OFFERED to a branch
    (see app.kb.retrieval.retrieve_context) were actually relevant to it --
    passing the retrieval similarity cutoff and being pasted into a prompt
    is not proof the model found a snippet relevant, only that it was
    provided (see OrchestratorLlmClient.judge_kb_relevance's docstring).
    Entirely optional (default None, same opt-in-capability convention as
    scoring_client/criteria_retriever) -- when omitted, every KbCitation's
    relevance stays at its default (KbCitationRelevance.UNKNOWN), matching
    pre-verification behavior exactly."""

    def judge_kb_relevance(self, branch_content: str, snippets: list[dict]) -> dict[str, str]: ...


class SectionAnalysisClient(Protocol):
    """Interface for the holistic SURVEY redesign's one-call-per-branch
    analysis, replacing the LlmLevelingClient + BatchedRequirementClient pair
    above (kept, unchanged, for any caller not yet migrated). Given ONE
    coherent, structure-preserving rendering of a whole section (see
    render_section), returns the COMPLETE node set the model decides the
    section contains -- however many, not one per input block.

    `analyze_section` is the fallback path for models without tool-calling
    support: `kb_context` is a pre-computed once-per-document string (see
    §5c's capability gate in _build_survey_tree_for_branch).

    `analyze_section_agentic` is the tool-capable path: the model actively
    pulls KB context via a query_kb tool call during analysis instead of a
    pre-computed kb_context. `retrieve_fn` is injected by the caller (closing
    over area_path/embed_client/vector_store -> retrieve_context) so this
    Protocol/its real implementation stays free of KB dependencies -- it only
    executes tool calls the model asks for. Returns (nodes, citations)."""

    def analyze_section(self, section_text: str, kb_context: str | None = None) -> list[dict]: ...

    def analyze_section_agentic(
        self,
        section_text: str,
        retrieve_fn: Callable[[str], tuple[str | None, list[dict]]],
    ) -> tuple[list[dict], list[dict]]: ...


def _resolve_kb_citations(
    outline: str,
    raw_citations: list[dict],
    kb_relevance_client: KbRelevanceClient | None,
) -> list[KbCitation]:
    """Builds the final KbCitation list for one branch's retrieved
    snippets: verifies relevance via kb_relevance_client when supplied,
    degrading to KbCitationRelevance.UNKNOWN for any snippet the
    verification call didn't (or couldn't) judge -- verification is an
    enhancement, never a hard dependency, so any failure here must never
    fail the SURVEY job itself."""
    if not raw_citations:
        return []
    verdicts: dict[str, str] = {}
    if kb_relevance_client is not None:
        snippets = [{"source_file": c["source_file"], "text": c["text"]} for c in raw_citations]
        try:
            verdicts = kb_relevance_client.judge_kb_relevance(outline, snippets)
        except Exception as exc:  # noqa: BLE001 - KB relevance verification must never fail a SURVEY job
            logger.warning("KB relevance verification failed: %s", exc)
            verdicts = {}
    citations: list[KbCitation] = []
    for i, raw in enumerate(raw_citations):
        verdict_str = verdicts.get(str(i))
        try:
            relevance = KbCitationRelevance(verdict_str) if verdict_str is not None else KbCitationRelevance.UNKNOWN
        except ValueError:
            relevance = KbCitationRelevance.UNKNOWN
        citations.append(KbCitation(source_file=raw["source_file"], similarity=raw["similarity"], relevance=relevance))
    return citations


def _build_outline(blocks: list[Block]) -> str:
    lines = []
    for block in blocks:
        _, display_text = resolve_block_depth(block)
        lines.append(display_text)
    return "\n".join(lines)


_FIGURE_TEXT_PATTERN = re.compile(r"^\[FIGURE:\s*(.*?)\s*\]$")


def _figure_line(block: Block) -> str | None:
    """FIGURE-kind blocks carry their caption embedded in block.text as
    "[FIGURE: {caption or 'none'}]" (see docx_loader.py/pdf_loader.py) --
    parse it back out. A 'none' placeholder (no real caption -- vision
    disabled, or the vision call failed for this image) is omitted from the
    rendered section entirely: the literal placeholder string must never
    reach the model and be mistaken for real content (the root cause of the
    "[FIGURE: none]" fake-requirement bug this redesign fixes). A real
    caption is rendered as a clearly-labeled blockquote line."""
    match = _FIGURE_TEXT_PATTERN.match(block.text)
    caption = match.group(1) if match else block.text
    if not caption or caption.lower() == "none":
        return None
    return f"> Figure: {caption}"


def _table_to_markdown(table: Table) -> str | None:
    """Renders a Table's rows as a markdown pipe table for inclusion in a
    section's rendered text (a PROMPT the model reads, unlike
    tree_builder._table_to_html's HTML rendering for an ADO rich-text
    field). Fully-blank rows are skipped, same convention as
    _table_to_html. Returns None for a table with no non-empty rows (a
    blank table contributes nothing, not an empty table block)."""
    rows = [row for row in table.rows if any(cell.strip() for cell in row)]
    if not rows:
        return None
    header, *body = rows
    lines = [
        "| " + " | ".join(cell.replace("|", "\\|") for cell in header) + " |",
        "| " + " | ".join("---" for _ in header) + " |",
    ]
    lines.extend("| " + " | ".join(cell.replace("|", "\\|") for cell in row) + " |" for row in body)
    return "\n".join(lines)


def render_section(blocks: list[Block], tables: list[Table] | None = None, figures: list[Figure] | None = None) -> str:
    """Replaces _build_outline for the holistic SURVEY redesign: renders a
    whole section as ONE coherent, structure-preserving markdown passage
    instead of one outline line per block, so the model can synthesize a
    bullet run into one requirement instead of receiving it pre-shredded
    into one candidate node per line (see analyze_section/
    analyze_section_agentic). `figures` is accepted for API symmetry with
    the xlsx-only synthetic-branch call site (build_survey_tree) but is not
    consulted here yet -- every loader already embeds each Figure's caption
    directly in its corresponding FIGURE-kind Block.text (see
    _figure_line), which is what's actually rendered.

    Tables are appended at the section's END under a "### Tables" marker,
    not interleaved at their real document position -- neither docx nor pdf
    tables carry a reliable document-order SourceRef yet (both are
    (0,0) placeholders), matching BASELINE's own "attach after everything
    else" approximation (tree_builder._table_to_html). True document-order
    placement is a follow-up (see the plan's loader body-walk-ordering
    section) that will remove this approximation by giving tables a real
    order index to interleave by."""
    del figures  # see docstring -- not yet consulted, kept for signature symmetry
    lines: list[str] = []
    for block in blocks:
        if block.kind == BlockKind.HEADING:
            level = block.heading_level or 1
            lines.append(f"{'#' * min(level, 6)} {block.text}")
        elif block.kind == BlockKind.LIST_ITEM:
            lines.append(f"- {block.text}")
        elif block.kind == BlockKind.FIGURE:
            figure_line = _figure_line(block)
            if figure_line is not None:
                lines.append(figure_line)
        elif block.kind == BlockKind.TABLE:
            continue  # never actually emitted by any loader today -- tables live in `tables` below
        else:  # PARAGRAPH, NOTE, OPEN_TBD -- plain content lines
            lines.append(block.text)

    table_sections = [md for table in (tables or []) if (md := _table_to_markdown(table)) is not None]
    if table_sections:
        lines.append("### Tables")
        for md in table_sections:
            lines.append(md)

    return "\n".join(lines)


def build_survey_tree(
    doc: CanonicalDoc,
    llm_client: LlmLevelingClient,
    requirement_client: BatchedRequirementClient,
    scoring_client: BatchedScoringClient | None = None,
    customer_id: str | None = None,
    criteria_retriever: CriteriaRetriever | None = None,
    area_path: str | None = None,
    embed_client: object | None = None,
    vector_store: KbVectorStore | None = None,
    link_type_client: TraceLinkInferenceClient | None = None,
    link_type_catalog: list[dict] | None = None,
    kb_relevance_client: KbRelevanceClient | None = None,
    progress_callback: ProgressCallback | None = None,
) -> WorkItemTree:
    """SURVEY-mode leveling entry point. Splits the document into top-level
    branches (_split_into_branches, the same depth-1-heading split
    BASELINE's build_baseline_tree already uses) and processes each branch
    through its own infer_hierarchy + generate_requirements_for_document
    call pair, instead of always sending the ENTIRE document in one call —
    a large/deep document previously risked overflowing the LLM's context
    window in a single whole-document call, producing truncated/malformed
    JSON that aborted the whole job rather than a partial/degraded result.

    A document with only ONE branch (the common case: no heading structure,
    or one top-level section) behaves BYTE-IDENTICALLY to before this
    change — same single call pair, same unprefixed node_ids ("0", "1", ...)
    — chunking is invisible unless a document genuinely has multiple
    top-level branches. Only a genuinely multi-branch document gets
    per-branch node_id namespacing (see _build_survey_tree_for_branch); each
    branch's own hierarchy is entirely self-contained (a branch's node_ids
    only ever reference other node_ids within that SAME branch/outline, so
    there is no cross-branch parent-reference case to reconcile).

    `scoring_client` is entirely optional (default None, same as every
    pre-existing test/call site) — when supplied, every branch's nodes get
    a real quality_score/quality_issues judgment via ONE extra batched call
    per branch; when omitted, every node's quality_score/quality_issues
    stay at their model defaults (None/[]), byte-identical to before this
    capability existed.

    Warnings from every branch are concatenated into one list, in branch
    order.

    `customer_id` is a single value applied uniformly to every node produced
    (same contract as build_baseline_tree's own customer_id parameter) --
    previously this parameter did not exist at all here, so /level silently
    dropped the job's customer_id for every SURVEY-mode node (always None),
    while BASELINE nodes got it correctly. Confirm()'s Customer ID field
    resolution has therefore never been reachable for a SURVEY job.

    `criteria_retriever` is entirely optional (default None, same
    opt-in-capability convention as scoring_client) -- when supplied
    alongside scoring_client, each branch's quality scoring call is grounded
    against retrieved reference criteria (see
    app.quality.criteria_retrieval.CriteriaRetriever) instead of relying
    solely on the model's own parametric knowledge of public standards.

    `area_path`/`embed_client`/`vector_store`, when ALL supplied, run one KB
    retrieval call PER BRANCH (see app.kb.retrieval.retrieve_context) — same
    per-branch batching as everything else in this function, not one
    whole-document call — grounding that branch's infer_hierarchy,
    generate_requirements_for_document, AND score_requirements_for_document
    calls with the SAME retrieved kb_context. When any of the three is
    omitted, KB retrieval is skipped entirely (kb_context stays None for
    every call), matching pre-KB behavior exactly. `kb_citations` (the
    deduped list of KB source_file names that grounded any branch's
    kb_context) is returned once on the tree, unioned across all branches.

    `link_type_client`/`link_type_catalog`, when link_type_client is
    supplied, run ONE additional whole-tree call (after every branch has
    been processed, using the full combined node list — see
    TraceLinkInferenceClient's docstring for why this is whole-tree, not
    per-branch) inferring trace/coverage links; when omitted, trace_links
    stays [] — matching pre-trace-link behavior exactly. Every returned link
    is validated before being trusted: a source_node_id that doesn't match
    any node actually produced by this build is always dropped, and — when
    a non-empty link_type_catalog was supplied — a reference_name outside
    that catalog is dropped too. A link's target_ref is classified as
    intraJob when it matches another node's local_id in this same tree, and
    as crossJob (an opaque customer-id string) otherwise."""
    branches = _split_into_branches(doc)
    # Document-structure-driven splitting alone cannot guarantee a small
    # branch (a real document can have very few, wildly unbalanced
    # top-level sections) -- bound each branch's size directly, regardless
    # of the document's own heading structure. See _bound_branch_size's own
    # docstring for why this is SURVEY-only, not applied to
    # build_baseline_tree's branches.
    branches = [
        bounded_branch
        for branch in branches
        for bounded_branch in _bound_branch_size(branch, _MAX_SURVEY_BRANCH_BLOCK_COUNT)
    ]
    all_nodes: list[WorkItemNode] = []
    all_warnings: list[str] = []
    all_kb_citations: list[KbCitation] = []
    blocks_total = sum(len(b) for b in branches)
    blocks_done = 0
    if len(branches) <= 1:
        branch_tree = _build_survey_tree_for_branch(
            doc.blocks, llm_client, requirement_client, scoring_client,
            node_id_prefix="", customer_id=customer_id, criteria_retriever=criteria_retriever,
            area_path=area_path, embed_client=embed_client, vector_store=vector_store,
            kb_relevance_client=kb_relevance_client,
            branch_index=0, branch_count=1, blocks_done_before=0, blocks_total=blocks_total,
            progress_callback=progress_callback,
        )
        all_nodes.extend(branch_tree.nodes)
        all_warnings.extend(branch_tree.warnings)
        all_kb_citations.extend(branch_tree.kb_citations)
    else:
        for branch_index, branch_blocks in enumerate(branches):
            branch_tree = _build_survey_tree_for_branch(
                branch_blocks, llm_client, requirement_client, scoring_client,
                node_id_prefix=f"br{branch_index}_", customer_id=customer_id, criteria_retriever=criteria_retriever,
                area_path=area_path, embed_client=embed_client, vector_store=vector_store,
                kb_relevance_client=kb_relevance_client,
                branch_index=branch_index, branch_count=len(branches), blocks_done_before=blocks_done,
                blocks_total=blocks_total, progress_callback=progress_callback,
            )
            all_nodes.extend(branch_tree.nodes)
            all_warnings.extend(branch_tree.warnings)
            all_kb_citations.extend(branch_tree.kb_citations)
            blocks_done += len(branch_blocks)

    # kb_citations deduped across branches by source_file, keeping the
    # highest-similarity hit -- retrieve_context runs once per branch now
    # (not once per document), so the same source file can legitimately
    # ground more than one branch's kb_context.
    best_by_file: dict[str, KbCitation] = {}
    for citation in all_kb_citations:
        existing = best_by_file.get(citation.source_file)
        if existing is None or citation.similarity > existing.similarity:
            best_by_file[citation.source_file] = citation
    deduped_citations = [best_by_file[name] for name in sorted(best_by_file)]

    trace_links: list[TraceLink] = []
    if link_type_client is not None:
        catalog = link_type_catalog or []
        valid_reference_names = {entry["reference_name"] for entry in catalog}
        node_by_local_id = {node.local_id: node for node in all_nodes}
        llm_nodes = [
            {"node_id": node.local_id, "type": node.type.value, "title": node.title, "text": node.description}
            for node in all_nodes
        ]
        # Trace-link inference judges relationships between already-generated
        # nodes, not raw source text, so it isn't grounded against KB context
        # the way the other three calls are -- passing None here is a
        # deliberate simplification, not an oversight.
        if progress_callback is not None:
            progress_callback(
                LevelingProgress(
                    phase="infer_trace_links", branch_index=None, branch_count=len(branches),
                    blocks_done=blocks_total, blocks_total=blocks_total, kb_grounded=False, kb_citations=[],
                )
            )
        raw_links = link_type_client.infer_trace_links(llm_nodes, catalog, kb_context=None)
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

    return WorkItemTree(nodes=all_nodes, warnings=all_warnings, kb_citations=deduped_citations, trace_links=trace_links)


def _build_survey_tree_for_branch(
    blocks: list[Block],
    llm_client: LlmLevelingClient,
    requirement_client: BatchedRequirementClient,
    scoring_client: BatchedScoringClient | None,
    node_id_prefix: str,
    customer_id: str | None = None,
    criteria_retriever: CriteriaRetriever | None = None,
    area_path: str | None = None,
    embed_client: object | None = None,
    vector_store: KbVectorStore | None = None,
    kb_relevance_client: KbRelevanceClient | None = None,
    branch_index: int = 0,
    branch_count: int = 1,
    blocks_done_before: int = 0,
    blocks_total: int = 0,
    progress_callback: ProgressCallback | None = None,
) -> WorkItemTree:
    """Does the actual per-branch (or, for a single-branch document, whole-
    document) SURVEY leveling: infers hierarchy, then formalizes every
    node's description into 'shall'-style requirement text + taxonomy tags
    via ONE batched call (see BatchedRequirementClient's docstring for why
    this is one call, not one per node). Title is derived deterministically
    from the first generated requirement's text via extract_baseline_title —
    NO LLM call for titling (a first draft added a distill_title LLM call;
    dropped per the design review, since extract_baseline_title already does
    the truncation work with no quality loss and no extra round-trip).
    Multiple generated requirements for one block are joined with a blank
    line between them — a block can legitimately decompose into more than
    one formal requirement. fidelity_hash is computed over the FINAL
    (formalized) description, since that's the content actually written to
    ADO and the idempotency map's key must match what a re-run would
    produce — but note this is a WEAKER guarantee than BASELINE's
    verbatim-source-span hash: temperature=0 is mostly-but-not-guaranteed
    deterministic, so a model or prompt change can shift this hash and
    produce a duplicate create on re-run. Embedding dedup partially
    backstops this; it is not a substitute.

    `node_id_prefix`: "" for a single-branch document (byte-identical
    node_ids to pre-chunking behavior); "br{N}_" for one of several
    branches in a multi-branch document. Applied to both a node's own
    local_id and its parent_local_id (never to the LLM-facing node_id used
    in the outline/hierarchy call itself — the LLM only ever sees this
    branch's own local, unprefixed indices).

    `area_path`/`embed_client`/`vector_store`: when all three are supplied,
    retrieve_context is called ONCE for this branch's own outline (see
    build_survey_tree's docstring) and the resulting kb_context is threaded
    into every one of this branch's LLM calls (hierarchy, generation,
    scoring)."""
    outline = _build_outline(blocks)
    kb_context: str | None = None
    raw_kb_citations: list[dict] = []
    if area_path is not None and embed_client is not None and vector_store is not None:
        kb_context, raw_kb_citations = retrieve_context(area_path, outline, embed_client, vector_store)
    kb_citations = _resolve_kb_citations(outline, raw_kb_citations, kb_relevance_client)
    kb_citations_raw_dicts = [{"source_file": c.source_file, "similarity": c.similarity} for c in kb_citations]

    def _fire(phase: Phase) -> None:
        if progress_callback is None:
            return
        progress_callback(
            LevelingProgress(
                phase=phase, branch_index=branch_index, branch_count=branch_count,
                blocks_done=blocks_done_before, blocks_total=blocks_total,
                kb_grounded=bool(kb_citations), kb_citations=kb_citations_raw_dicts,
            )
        )

    _fire("infer_hierarchy")
    hierarchy = llm_client.infer_hierarchy(outline, profile_hint=None, kb_context=kb_context)
    # Tolerant of LLM non-compliance: the prompt asks for a JSON ARRAY, but a
    # small local model (observed with llama3.2:1b against a short outline)
    # sometimes collapses to a single JSON object instead of a one-element
    # array. Normalize rather than let a single well-formed-but-unwrapped
    # object crash the whole job with a cryptic "string indices must be
    # integers" (iterating a dict yields its string keys, not its values).
    if isinstance(hierarchy, dict):
        hierarchy = [hierarchy]

    block_by_index = {str(i): block for i, block in enumerate(blocks)}
    hierarchy_by_node_id = {entry["node_id"]: entry for entry in hierarchy}
    blocks_by_node_id = {
        node_id: resolve_block_depth(block_by_index[node_id])[1]
        for node_id in hierarchy_by_node_id
        if node_id in block_by_index
    }
    _fire("generate_requirements")
    generated_by_node_id = requirement_client.generate_requirements_for_document(blocks_by_node_id, kb_context=kb_context)

    # Per-block completeness check: nothing anywhere previously compared the
    # LLM's output against the input document's blocks at anything finer
    # than an aggregate count ratio, so two different failure modes looked
    # identical to a correctly-processed document -- (a) a document whose
    # second half got silently dropped, or (b) a hierarchy padded with
    # invented, non-grounded node_ids -- no error, no log, no signal to a
    # reviewer, and no way to tell WHICH content was affected. This checks
    # every individual block, not just the aggregate count: a block whose
    # node_id the LLM never referenced is only flagged as dropped if its own
    # content ALSO doesn't appear (even paraphrased) anywhere in the
    # generated output -- a legitimate merge of that block's content into a
    # sibling node's text is not flagged (see
    # _block_content_appears_in_generated_output). This doesn't fail the job
    # -- it surfaces a specific, reviewable warning naming exactly which
    # block(s) are actually missing.
    warnings: list[str] = []
    input_block_count = len(blocks)
    covered_node_ids = set(hierarchy_by_node_id) & set(block_by_index)
    uncovered_node_ids = [node_id for node_id in block_by_index if node_id not in covered_node_ids]
    if uncovered_node_ids:
        all_generated_texts = [
            item["text"] for items in generated_by_node_id.values() for item in items if item.get("text")
        ]
        dropped_node_ids = [
            node_id
            for node_id in uncovered_node_ids
            if not _block_content_appears_in_generated_output(
                resolve_block_depth(block_by_index[node_id])[1], all_generated_texts
            )
        ]
        if dropped_node_ids:
            message = (
                f"SURVEY hierarchy did not reference {len(dropped_node_ids)} of {input_block_count} "
                "source block(s), and their content does not appear (even paraphrased) in any "
                f"generated node -- likely dropped, not merged: {dropped_node_ids[:10]}"
            )
            logger.warning(message)
            warnings.append(message)
    invented_node_ids = [node_id for node_id in hierarchy_by_node_id if node_id not in block_by_index]
    if invented_node_ids:
        message = (
            f"SURVEY hierarchy referenced {len(invented_node_ids)} node_id(s) not present in the "
            f"source document (discarded): {invented_node_ids[:10]}"
        )
        logger.warning(message)
        warnings.append(message)

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
            # Source-grounding check: the LLM's generated text was
            # previously trusted verbatim with zero comparison against the
            # source block it supposedly formalized -- a model could
            # rewrite or invent "shall" content unrelated to the input and
            # it flowed straight through to the dry-run diff a human
            # reviews, with the diff review as the ONLY gate. Computed only
            # when real generated text exists (the raw-display-text
            # fallback below is trivially fully grounded, it IS the source).
            grounding_score = _grounding_score(description, display_text)
            if grounding_score < _LOW_GROUNDING_THRESHOLD:
                message = (
                    f"Node {node_id_prefix}{node_id}'s generated description has low grounding "
                    f"({grounding_score:.0%} of its vocabulary traces back to the source block) -- "
                    "worth reviewing for possible fabrication."
                )
                logger.warning(message)
                warnings.append(message)
        else:
            # No formal requirement extracted (e.g. a heading-only block) —
            # fall back to the raw display text rather than an empty
            # description, which would otherwise silently discard content.
            description = display_text
            tags = []
            title = extract_baseline_title(display_text)
            grounding_score = 1.0  # IS the source text verbatim, trivially fully grounded

        parent_id = entry["parent_id"]
        try:
            node_type = WorkItemType(entry["type"])
        except ValueError:
            # Tolerant of LLM non-compliance (same philosophy as the
            # array-vs-object normalization above): the prompt explicitly
            # lists "one of: Epic, Feature, Requirement", but a model can
            # still hallucinate an out-of-vocabulary type (observed live:
            # gemma4:e4b returned "Recommendation"). Falling back to
            # Requirement -- the safest default, since it never implies a
            # parent/child expectation the way Epic/Feature do -- keeps one
            # bad node from crashing the entire branch/job; a human
            # reviewing the dry-run diff can still correct the type.
            message = (
                f"Node {node_id_prefix}{node_id} had an invalid type "
                f"({entry['type']!r}) from hierarchy inference -- defaulted to Requirement."
            )
            logger.warning(message)
            warnings.append(message)
            node_type = WorkItemType.REQUIREMENT
        nodes.append(
            WorkItemNode(
                local_id=f"{node_id_prefix}{node_id}",
                type=node_type,
                parent_local_id=f"{node_id_prefix}{parent_id}" if parent_id is not None else None,
                title=title,
                description=description,
                customer_id=customer_id,
                source_ref=block.source_ref,
                fidelity_hash=hashlib.sha256(description.encode()).hexdigest(),
                tags=tags,
                mode=WorkItemMode.SURVEY,
                grounding_score=grounding_score,
            )
        )

    if scoring_client is not None and nodes:
        _fire("score_requirements")
        _apply_quality_scores(nodes, scoring_client, warnings, node_id_prefix, criteria_retriever, kb_context)

    return WorkItemTree(nodes=nodes, warnings=warnings, kb_citations=kb_citations)


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


def _apply_quality_scores(
    nodes: list[WorkItemNode],
    scoring_client: BatchedScoringClient,
    warnings: list[str],
    node_id_prefix: str,
    criteria_retriever: CriteriaRetriever | None = None,
    kb_context: str | None = None,
) -> None:
    """Judges every node's FINAL formalized description in ONE batched call
    (mutates `nodes` in place -- WorkItemNode is a plain, mutable pydantic
    model). Tolerant of a missing, malformed (non-int, out of 0-100 range),
    or wrongly-shaped scoring entry for one node_id -- falls back to
    quality_score=None/quality_issues=[] for that node only, never crashes
    the batch or affects sibling nodes, same philosophy as every other
    LLM-response-parsing path in this module.

    `criteria_retriever`, when supplied, grounds this call against retrieved
    reference criteria (see _build_criteria_context). `kb_context` is the
    same SharePoint/OneDrive KB context computed for this branch's other two
    calls, threaded through for consistency. Both are independent/optional;
    omitting either (or both) is byte-identical to before either capability
    existed."""
    descriptions_by_node_id = {node.local_id: node.description for node in nodes}
    criteria_context = _build_criteria_context(criteria_retriever, nodes) if criteria_retriever is not None else None
    scores_by_node_id = scoring_client.score_requirements_for_document(
        descriptions_by_node_id, criteria_context, kb_context
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

    missing_or_invalid = [node.local_id for node in nodes if node.quality_score is None]
    if missing_or_invalid:
        message = (
            f"Quality scoring returned no valid score for {len(missing_or_invalid)} node(s) in branch "
            f"'{node_id_prefix or '(root)'}': {missing_or_invalid[:10]}"
        )
        logger.warning(message)
        warnings.append(message)
