from __future__ import annotations

import dataclasses
import logging
import re
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from app.debug_capture import DebugCapture

from app.canonical.model import (
    Block,
    BlockKind,
    CanonicalDoc,
    DocumentFormat,
    Figure,
    Table,
    plain_text_rows,
)
from app.config import settings
from app.distillation.description import assemble_description
from app.job_cancel import JobCancelled
from app.kb.kb_vector_store import KbVectorStore
from app.kb.profile import KbProfile, scoring_inputs
from app.kb.retrieval import fetch_always_include_context, retrieve_context
from app.leveling.acceptance_criteria import (
    AcceptanceCriteriaClient,
    eligible_nodes,
    propose_acceptance_criteria,
    skip_criteria_stage,
)
from app.leveling.baseline_structure import adopt_baseline_structure
from app.leveling.conflict_detection import (
    ConflictJudgeClient,
    _detect_conflicting_duplicates,
)
from app.leveling.conservation import restore_lost_nodes
from app.leveling.content_authoring import ContentAuthoringClient, author_fixed_tree
from app.leveling.document_study import DocumentStudyClient
from app.leveling.hierarchy_check import HierarchyFixClient, suggest_hierarchy_fixes

# Extracted to grounding.py (Phase 6, NEW-04) so id_tree_builder.py can use
# the SAME Unicode-aware implementation instead of maintaining a second copy
# that already drifted (ASCII-only) -- see that module's own docstring for
# the real bug this closes. Aliased under their original private names so
# every existing call site in this file (11+) needs no change.
from app.leveling.hierarchy_rules import (
    ensure_ladder,
    learn_leaf_floor,
    requirement_heading_warning,
    scope_with_ancestors,
    type_headings_by_shape,
)
from app.leveling.id_hierarchy import (
    rows_from_heading_structure,
    rows_from_id_headings,
    rows_from_table,
)
from app.leveling.id_tree_builder import (
    ParentSummaryClient,
    SynthesisClient,
    TitleTagClient,
    _apply_parent_summary_pass,
    build_hierarchy_subtree,
    recompute_child_types,
)
from app.leveling.identity_v2 import assign_identity_v2
from app.leveling.live_context import current_stage_counter
from app.leveling.llm_lease_limiter import LeaseLimiter
from app.leveling.model_caps import _resolve_caps
from app.leveling.narration_publisher import LevelingProgress, ProgressCallback
from app.leveling.root_regrouping import (
    RootGroupingClient,
    _ensure_root_features_have_epic_parent,
    _regroup_disconnected_roots,
    _repair_requirement_hierarchy,
)
from app.leveling.rule_builder import (
    is_rule_built,
    tree_from_table_rules,
    verify_tree_against_rules,
)
from app.leveling.scoring import (
    BatchedScoringClient,
    _score_all_requirements,
)
from app.leveling.sheet_study import SheetMapping, SheetStudyClient, describe_plan, study_sheet
from app.leveling.study import Study, as_document_study, orientation_text, study_of
from app.leveling.study_runner import StudyHandle
from app.leveling.study_store import StudyStore
from app.leveling.trace_links import TraceLinkInferenceClient, _infer_trace_links_for_nodes
from app.leveling.tree_builder import (
    _derive_doc_title,
    _figure_line,
    _hash_description,
    _hash_identity,
    _hash_identity_for_synthesized_node,
    _is_unsupported_content_note,
    _order_key,
    _table_to_html,
    _widen_page_end,
    figures_by_id,
    strip_repeated_titles,
)
from app.leveling.tree_builder import figure_id_by_block_id as _build_figure_id_by_block_id
from app.leveling.warnings_finalize import finalize_warnings
from app.quality.criteria_retrieval import CriteriaRetriever
from app.request_identity import user_scope
from app.study.file_rules import study_tables
from app.study.heading_rules import apply_stated_type_labels, lock_types_by_depth
from app.study.model_rules import prestudy
from app.study.rulebook import FileRulebook
from app.workitem.model import (
    IntegrityWarning,
    KbCitation,
    KbCitationRelevance,
    KbCoverage,
    TraceLink,
    WarningKind,
    WorkItemNode,
    WorkItemTree,
    WorkItemType,
)

logger = logging.getLogger(__name__)


# Cheap chars/4 heuristic -- good enough for a budget GATE (deciding whether
# to skip splitting or how many blocks a merged branch can hold), not exact
# token accounting. Avoids a new tokenizer dependency; consistent with this
# module's other block-count-proxy conventions (see
# _MAX_SURVEY_BRANCH_BLOCK_COUNT's own docstring).
_CHARS_PER_TOKEN_ESTIMATE = 4


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

    def judge_kb_relevance(
        self,
        branch_content: str,
        snippets: list[dict],
        user_id: str | None = None,
    ) -> dict[str, str]: ...


class SurveyModelClient(Protocol):
    """The job's chat-model client. The structure always comes from the document (adopt_baseline_structure): the model never decides
    which items exist. Its optional passes are found by attribute, so a client without one simply skips it: `study_file_rules_table` /
    `study_file_rules_document` (the file-conventions pre-study) and `study_spreadsheet` (a sheet's layout)."""

    @property
    def model(self) -> str | None: ...


def _count_kb_files(user_id: str, vector_store: Any) -> int | None:
    """Distinct KB source files with stored vectors for this user -- the
    "available" half of WorkItemTree.kb_coverage. Best-effort: coverage
    reporting must never fail a SURVEY job, so a listing failure is logged
    and reported as unknown (None)."""
    try:
        return len(vector_store.list_documents(user_id))
    except Exception as exc:  # noqa: BLE001 - coverage reporting is best-effort, never fails a job
        logger.warning("KB file listing for coverage failed: %s", exc)
        return None


def _kb_coverage(files_available: int | None, citations: list[KbCitation]) -> KbCoverage | None:
    if files_available is None:
        return None
    return KbCoverage(
        files_available=files_available,
        files_cited=len({c.source_file for c in citations}),
    )


def _stamp_kb_files_available(
    progress_callback: Callable[[LevelingProgress], None] | None,
    files_available: int | None,
) -> Callable[[LevelingProgress], None] | None:
    """Wraps the progress callback so every narration event emitted after KB
    retrieval carries how many KB files were available, without threading a
    new argument through each of the many LevelingProgress call sites."""
    if progress_callback is None or files_available is None:
        return progress_callback

    def _stamped(progress: LevelingProgress) -> None:
        progress_callback(dataclasses.replace(progress, kb_files_available=files_available))

    return _stamped


def _resolve_kb_citations(
    outline: str,
    raw_citations: list[dict],
    kb_relevance_client: KbRelevanceClient | None,
    node_id_prefix: str = "",
    debug_capture: DebugCapture | None = None,
    user_id: str | None = None,
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
            verdicts = kb_relevance_client.judge_kb_relevance(outline, snippets, user_id=user_id)
        except Exception as exc:  # noqa: BLE001 - KB relevance verification must never fail a SURVEY job
            logger.warning("KB relevance verification failed: %s", exc)
            if debug_capture is not None:
                debug_capture.capture(
                    "kb_relevance", node_id_prefix.rstrip("_") or "root", str(exc)
                )
            verdicts = {}
    citations: list[KbCitation] = []
    for i, raw in enumerate(raw_citations):
        verdict_str = verdicts.get(str(i))
        try:
            relevance = (
                KbCitationRelevance(verdict_str)
                if verdict_str is not None
                else KbCitationRelevance.UNKNOWN
            )
        except ValueError:
            relevance = KbCitationRelevance.UNKNOWN
        citations.append(
            KbCitation(
                source_file=raw["source_file"], similarity=raw["similarity"], relevance=relevance
            )
        )
    return citations


def _merge_always_include_context(
    kb_context: str | None,
    kb_citations: list[KbCitation],
    user_id: str,
    vector_store: KbVectorStore,
    prefetched: tuple[str | None, list[dict]] | None = None,
) -> tuple[str | None, list[KbCitation]]:
    """Prepends every "always_include" KB file's full text to `kb_context`
    (see fetch_always_include_context's own docstring) and appends its
    citation to `kb_citations` -- called at BOTH doc-level kb_context
    computation sites (fallback and agentic) so an always-include file
    grounds a call regardless of whether the model is tool-capable, unlike
    retrieve_context's similarity-gated result which the agentic path skips
    in favor of the model pulling context itself via query_kb.
    Relevance is set to RELEVANT directly, never run through
    _resolve_kb_citations' judge -- an always-include file's relevance is a
    property of upload-time intent, not something a per-call verification
    should be able to override."""
    # `prefetched` lets a caller that merges many times (once per branch) read
    # the always-include files from the vector store only once.
    if prefetched is None:
        prefetched = fetch_always_include_context(user_id, vector_store)
    always_include_context, always_include_raw = prefetched
    if always_include_context is None:
        return kb_context, kb_citations
    merged_context = (
        always_include_context
        if kb_context is None
        else f"{always_include_context}\n\n{kb_context}"
    )
    merged_citations = [
        *kb_citations,
        *(
            KbCitation(
                source_file=c["source_file"],
                similarity=c["similarity"],
                relevance=KbCitationRelevance.RELEVANT,
                inclusion="always",
            )
            for c in always_include_raw
        ),
    ]
    return merged_context, merged_citations


_DOC_LEVEL_QUERY_FALLBACK_CHARS = 2000


def _blocks_query_text(blocks: list[Block]) -> str:
    """Query text for a set of blocks (one branch, or the whole document):
    the heading text, else the first ~2000 chars of block text."""
    heading_text = "\n".join(block.text for block in blocks if block.kind == BlockKind.HEADING)
    if heading_text.strip():
        return heading_text
    return "\n".join(block.text for block in blocks)[:_DOC_LEVEL_QUERY_FALLBACK_CHARS]


def _document_level_query_text(doc: CanonicalDoc) -> str:
    """Builds the ONE query text used to retrieve KB context ONCE per
    document for the §5c fallback (non-tool-capable model) path -- heading
    text is the strongest signal of what the document is about; when a
    document has no headings at all, falls back to its first ~2000 chars of
    block text (a conservative proxy, same spirit as
    _MAX_SURVEY_BRANCH_BLOCK_COUNT's block-count proxy)."""
    return _blocks_query_text(doc.blocks)


# §14 Tier 1: cheap, always-on detection of a section referencing an
# external artifact this SURVEY run did not itself ingest (an attached
# spreadsheet, a numbered ReqID, an appendix/annex) -- flags it for manual
# KB ingest rather than silently proceeding as if the referenced content
# were already accounted for. Deliberately coarse pattern matching, no
# attempt to resolve the reference itself (that's Tier 2, out of scope
# here -- KB-resolution reuses this same agentic loop via §15's
# read_kb_document; ADO-resolution needs a new cross-service route, a much
# larger follow-up, deferred).
_REFERENCED_ATTACHMENT_PATTERN = re.compile(
    r"reqid(?:\s*\d+)?|see excel|attached|refer(?:s|red)? to (?:the )?document|appendix|annex",
    re.IGNORECASE,
)


def _external_reference_warnings_for_nodes(nodes: list[WorkItemNode]) -> list[IntegrityWarning]:
    """One warning per distinct reference phrase across the whole tree (case-insensitive, first spelling kept), naming every item whose
    text carries it and the section of the first one, so a reviewer can go straight to the items that point outside the document."""
    found: dict[str, tuple[str, list[str], str | None]] = {}
    for node in nodes:
        for match in _REFERENCED_ATTACHMENT_PATTERN.finditer(node.description or ""):
            phrase, node_ids, _section = found.setdefault(
                match.group(0).lower(), (match.group(0), [], node.title)
            )
            if node.local_id not in node_ids:
                node_ids.append(node.local_id)
    warnings = []
    for key in sorted(found):
        phrase, node_ids, section = found[key]
        section_ref = f'The "{section}" section' if section else "This section"
        warnings.append(
            IntegrityWarning.make(
                WarningKind.EXTERNAL_REFERENCE,
                f"{section_ref} references an external artifact ({phrase!r}) this "
                "SURVEY run did not ingest -- consider adding it to the knowledge base.",
                node_ids=node_ids,
                detail={"section": section or "(root)", "phrase": phrase},
            )
        )
    return warnings


def _table_to_markdown(table: Table) -> str | None:
    """Renders a Table's rows as a markdown pipe table for inclusion in a
    section's rendered text (a PROMPT the model reads, unlike
    tree_builder._table_to_html's HTML rendering for an ADO rich-text
    field). Fully-blank rows are skipped, same convention as
    _table_to_html. Returns None for a table with no non-empty rows (a
    blank table contributes nothing, not an empty table block)."""
    rows = [row for row in plain_text_rows(table) if any(cell.strip() for cell in row)]
    if not rows:
        return None
    header, *body = rows
    lines = [
        "| " + " | ".join(cell.replace("|", "\\|") for cell in header) + " |",
        "| " + " | ".join("---" for _ in header) + " |",
    ]
    lines.extend("| " + " | ".join(cell.replace("|", "\\|") for cell in row) + " |" for row in body)
    return "\n".join(lines)


def _render_block_line(
    block: Block, figure_id_by_block_id: dict[str, str] | None = None
) -> str | None:
    """One block rendered as a markdown-ish line for render_section, or None
    to omit it entirely (a 'none'-caption figure placeholder, a
    never-actually-emitted TABLE-kind block -- tables live in the separate
    `tables` list render_section merges in by document order -- or a loader
    diagnostic placeholder NOTE block, see _is_unsupported_content_note).

    `figure_id_by_block_id` (known-issues item 20): when this FIGURE-kind
    block has a known Figure.id (see render_section's own docstring for how
    this map is built), the id is inserted into the rendered line -- e.g.
    "> Figure f3: <caption>" instead of "> Figure: <caption>" -- so
    analyze_section/analyze_section_agentic can name it back in a node's
    figure_ids. Never mutates `_figure_line`/block.text itself -- that
    format is shared verbatim with BASELINE (tree_builder.py) and with
    llm_leveling's own det0_*/br0_* coverage-check string-matching
    elsewhere, both of which must stay byte-identical."""
    if block.kind == BlockKind.HEADING:
        level = block.heading_level or 1
        return f"{'#' * min(level, 6)} {block.text}"
    if block.kind == BlockKind.LIST_ITEM:
        return f"- {block.text}"
    if block.kind == BlockKind.FIGURE:
        line = _figure_line(block)
        figure_id = (figure_id_by_block_id or {}).get(block.id)
        if line is not None and figure_id is not None:
            return line.replace("> Figure:", f"> Figure {figure_id}:", 1)
        return line
    if block.kind == BlockKind.TABLE:
        return None  # never actually emitted by any loader today
    if _is_unsupported_content_note(block):
        # A loader diagnostic placeholder (e.g. pdf_loader.py's multi-column
        # false-positive note) must never reach the model/output as if it
        # were real content -- see _is_unsupported_content_note's own
        # docstring.
        return None
    return block.text  # PARAGRAPH, NOTE, OPEN_TBD -- plain content lines


def render_section(
    blocks: list[Block],
    tables: list[Table] | None = None,
    figures: list[Figure] | None = None,
    figure_id_by_block_id: dict[str, str] | None = None,
) -> str:
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

    `figure_id_by_block_id` (known-issues item 20, optional): a
    block.id -> Figure.id map (see build_survey_tree, which builds it once
    for the whole document by pairing doc.blocks' FIGURE-kind blocks with
    doc.figures in loader-append order -- every loader appends a Figure and
    its corresponding Block in lockstep, confirmed for docx/pptx/pdf) --
    threaded down so each rendered figure line can carry its own real id
    (see _render_block_line), letting the model reference it in
    figure_ids. None (the default) renders the old id-less line, same as
    before this param existed.

    Tables are interleaved at their REAL document-order position (§12) --
    each loader (docx_loader.py's body-walk, pdf_loader.py's bbox-based
    per-page merge) now shares ONE monotonically increasing offset counter
    across blocks AND tables, so `source_ref.start_offset` is directly
    comparable between the two lists within the same loader run. Sorted via
    the SAME _order_key tree_builder.py's BASELINE path now uses (§F) --
    `start_offset` alone is not globally comparable across pdf_loader.py
    pages (its running counter resets to 0 per page), so a multi-page PDF's
    tables/blocks need the `(page, start_offset)` pair, not offset alone.

    Each table is preceded by its own '[TABLE <id>]' marker (item 20) --
    unlike figures, this needs no separate id map: `table.id` is already
    directly in hand from the `tables` list itself."""
    del figures  # see docstring -- not yet consulted, kept for signature symmetry
    entries: list[tuple[tuple[int, int], str]] = []
    for block in blocks:
        line = _render_block_line(block, figure_id_by_block_id)
        if line is not None:
            entries.append((_order_key(block.source_ref), line))
    for table in tables or []:
        markdown = _table_to_markdown(table)
        if markdown is not None:
            entries.append((_order_key(table.source_ref), f"[TABLE {table.id}]\n{markdown}"))
    entries.sort(key=lambda entry: entry[0])
    return "\n".join(line for _, line in entries)


def _apply_det_parent_summary(
    det_nodes: list[WorkItemNode],
    det_warnings: list[IntegrityWarning],
    parent_summary_client: ParentSummaryClient | None,
    model: str | None = None,
    progress_callback: ProgressCallback | None = None,
    tables_by_id: dict[str, Table] | None = None,
    # Forwarded unchanged to _apply_parent_summary_pass -- see
    # app.config.Settings.survey_chunk_concurrency.
    chunk_concurrency: int = 1,
    user_id: str | None = None,
) -> None:
    """Runs the Epic/Feature title+description enhancement pass over EVERY
    deterministic subtree at once, only after all of them (and every
    subsequent span-claiming/repair mutation _detect_deterministic_subtrees
    performs on det_nodes) has fully settled -- see build_hierarchy_subtree's
    own comment on why this can't run inside it: _repair_requirement_hierarchy
    and the heading-span-claiming pass below both still mutate parent/child
    structure and descriptions AFTER build_hierarchy_subtree returns, so a
    parent's summary would risk being based on a child set that's about to
    change.

    Every Epic AND Feature node passed in ONE combined call, any order --
    _apply_parent_summary_pass builds each one's payload from its full
    descendant-Requirement rollup (however deeply nested), not from a
    sibling/ancestor's own title, so there is no Feature-before-Epic (or
    nested-Epic-depth) ordering dependency to get right. The spec's own
    hierarchy rule allows arbitrary nesting at every tier -- a Requirement
    nested under another Requirement, or an Epic nested under another
    Epic (id_hierarchy.classify_by_nesting's own docstring) -- a fixed
    two-round Feature-then-Epic split would have gotten a nested Epic's
    ordering wrong; this doesn't need rounds at all."""
    # Job transparency: this runs once, after every subtree's own draft and
    # improve passes, so those two are over; summarize is counted below.
    counter = current_stage_counter()
    if counter is not None:
        counter.complete("draft")
        counter.complete("improve")
    if parent_summary_client is None:
        return
    # An Epic or Feature a table states keeps the file's title and description: it is never summarized over.
    parent_ids = [
        n.local_id
        for n in det_nodes
        if n.type in (WorkItemType.EPIC, WorkItemType.FEATURE) and not is_rule_built(n.local_id)
    ]
    # Only a document that had deterministic subtrees was planned; for any other
    # (a text PDF, a scan) a "summarize 0 of 0" marker would be noise.
    if counter is not None and counter.is_planned("summarize"):
        counter.set_total("summarize", len(parent_ids))
    if not parent_ids:  # nothing to summarize (every parent is stated by a table): no budget lookup, no call
        if counter is not None:
            counter.complete("summarize")
        return
    # parent_summary_client is the same OrchestratorLlmClient instance
    # already implementing every other Protocol here -- reused as the
    # live per-model token-budget lookup (ModelCapsClient), replacing the
    # flat default with a real derived budget for a model not already in
    # _MODEL_CAPS. _resolve_caps itself fails open to that same flat
    # default on any lookup failure, so this can never raise.
    token_budget = _resolve_caps(model, caps_client=parent_summary_client).coverage_budget_tokens
    try:
        _apply_parent_summary_pass(
            det_nodes,
            parent_ids,
            parent_summary_client,
            det_warnings,
            token_budget=token_budget,
            progress_callback=progress_callback,
            tables_by_id=tables_by_id,
            chunk_concurrency=chunk_concurrency,
            user_id=user_id,
        )
    finally:
        if counter is not None:
            counter.complete("summarize")


def _ladder_scope(det_nodes: list[WorkItemNode], all_nodes: list[WorkItemNode]) -> set[str]:
    """What SURVEY's ladder repair may complete: the document's own structure, except the items a table states (rule_builder): a stated type and
    parent are final, as in BASELINE, which never repairs them. A stated structure the ladder does not allow (a Requirement directly under an
    Epic) is kept and reported once (SOURCE_STRUCTURE_VIOLATION); bridging it would change a stated parent and make the stated-structure check
    report the repair as a mismatch."""
    return scope_with_ancestors([n for n in det_nodes if not is_rule_built(n.local_id)], all_nodes)


def _detect_deterministic_subtrees(
    doc: CanonicalDoc,
    title_tag_client: TitleTagClient | None,
    synthesis_client: SynthesisClient | None = None,
    parent_summary_client: ParentSummaryClient | None = None,
    model: str | None = None,
    progress_callback: ProgressCallback | None = None,
    # Whole-document (not residual) block.id -> Figure.id map -- see
    # figure_id_by_block_id's own docstring (tree_builder.py) and
    # build_survey_tree's own call site comment for why this must be built
    # over the FULL `doc` and passed in from there, BEFORE this function
    # ever filters anything into a residual llm_doc. None (a caller that
    # hasn't been updated, e.g. an older test) simply skips figure
    # attribution below -- every other deterministic behavior is unchanged.
    figure_id_by_block_id: dict[str, str] | None = None,
    # Forwarded unchanged to every chunked pass this function reaches
    # (build_hierarchy_subtree's title/tag + synthesis passes, and
    # _apply_det_parent_summary's parent-summary pass) -- see
    # app.config.Settings.survey_chunk_concurrency.
    chunk_concurrency: int = 1,
    user_id: str | None = None,
    # Studies the sheets of a spreadsheet the id convention does not read (see sheet_study.py). None (every caller that does not pass it)
    # leaves a spreadsheet exactly as it was: its sheets go to the model-driven path below.
    sheet_study_client: SheetStudyClient | None = None,
    # What the pre-study learned about the file's conventions (study/model_rules.py); None reads only the conventions the code recognises.
    rulebook: FileRulebook | None = None,
    # Picks one of the code-computed fixes for each item a stated table puts where the ladder does not allow (app.leveling.hierarchy_check).
    hierarchy_client: HierarchyFixClient | None = None,
) -> tuple[list[WorkItemNode], list[IntegrityWarning], CanonicalDoc]:
    """Detects and builds every deterministic hierarchy subtree this
    document's own structure already encodes -- a 2-column dotted-ID
    table (`rows_from_table`), a native Word Heading hierarchy with the ID
    typed directly into the heading text (`rows_from_id_headings`), or a
    native Word Heading hierarchy with no ID text at all
    (`rows_from_heading_structure`) -- and returns (deterministic_nodes,
    deterministic_warnings, llm_doc), where `llm_doc` is `doc` with every
    claimed block/table removed, ready to feed unchanged into this
    module's existing LLM-driven branch/analysis machinery for whatever
    residual content (if any) remains.

    Every qualifying Table becomes its OWN subtree (IDs are table-scoped,
    see `qualifying_groups`'s own docstring) -- D1 always runs regardless
    of the heading detectors, since tables and blocks are disjoint
    substrates. For headings, D2 (ID-bearing) is tried first and wins
    outright whenever it qualifies -- it carries strictly more information
    than D3 (real document IDs, is_top_level-derived root count, the
    lettered-vs-numeric-children Requirement/Feature distinction D3's
    child-count-only rule cannot express) -- D3 (pure structural) is only
    tried when D2 finds nothing. This mirrors the confirmed measurement
    that the two detectors don't compete ambiguously in practice (a
    document with real IDs typed into its headings measures ~1.0 ID-shaped
    fraction; one without measures near 0).

    Claimed headings also claim their own SPAN -- every following
    non-HEADING block, and every Table whose own document-order position
    falls before the next HEADING block in `doc.blocks` -- folded into
    that heading's own node description (recomputing both hashes), so
    real source content between two headings is never silently dropped
    from either the deterministic tree OR the LLM-handled residual.

    Returns `(det_nodes, [], doc)` unchanged (a true no-op) when nothing
    in `doc` matches any of the three conventions -- the exact guarantee
    every one of these detectors already gives individually."""
    det_nodes: list[WorkItemNode] = []
    det_warnings: list[IntegrityWarning] = []
    claimed_table_ids: set[str] = set()
    subtree_index = 0

    # Precomputed upfront (rows_from_table per table, rows_from_id_headings/
    # rows_from_heading_structure once) so subtree_count -- the "N of M"
    # narration below needs a real total, not just a running index -- is
    # known before the first event fires, rather than growing as we go.
    # rows_from_id_headings/rows_from_heading_structure themselves are pure
    # reads of doc.blocks and don't depend on which tables get claimed below
    # (tables and headings are disjoint substrates, per this function's own
    # docstring), so hoisting this computation earlier changes nothing about
    # which nodes end up in det_nodes or their order -- only WHEN the rows
    # are computed, not what they contain.
    # A table that states its items' types and nesting in columns (study/file_rules.py) is built as it states them, and no later pass retypes
    # it: neither the id convention nor the sheet study below sees it. Only for a file with no running text (a heading way reads the rest).
    stated_rules = (
        {} if any(not _is_unsupported_content_note(b) for b in doc.blocks) else study_tables(doc, rulebook)
    )
    if stated_rules:
        rule_nodes, rule_warnings = tree_from_table_rules(
            doc, stated_rules, _hash_description, _hash_identity_for_synthesized_node
        )
        if hierarchy_client is not None:
            # The model's job for a stated table: pick a fix for each item the ladder does not allow. Nothing is applied; a file the ladder
            # allows asks nothing.
            suggest_hierarchy_fixes(rule_nodes, rule_warnings, hierarchy_client, user_id, chunk_concurrency)
        det_nodes.extend(rule_nodes)
        det_warnings.extend(rule_warnings)
        claimed_table_ids.update(stated_rules)
    qualifying_table_rows = [
        (table, rows_from_table(table)) for table in doc.tables if table.id not in stated_rules
    ]
    # A spreadsheet's sheets the id convention does not read: the model studies each ONE time, from a sample, and code maps every row by
    # its answer (sheet_study.py). A sheet it cannot or will not map stays on the model-driven path below, with a warning saying so.
    sheet_mappings: dict[str, SheetMapping] = {}
    if sheet_study_client is not None and doc.document.format in (DocumentFormat.XLSX, DocumentFormat.CSV):
        for position, (table, rows) in enumerate(qualifying_table_rows):
            if rows:
                continue
            mapping = study_sheet(table, sheet_study_client, user_id)
            if mapping.rows is None:
                det_warnings.append(
                    IntegrityWarning.make(
                        WarningKind.SPREADSHEET_NOT_MAPPED,
                        raw=(
                            f'Sheet "{table.caption or table.id}" was not read row by row: {mapping.reason}. '
                            "It was analysed as ordinary content, which can miss rows in a large sheet."
                        ),
                        detail={"sheet": table.caption or table.id, "reason": mapping.reason},
                    )
                )
                continue
            sheet_mappings[table.id] = mapping
            qualifying_table_rows[position] = (table, mapping.rows)
    qualifying_table_rows = [(table, rows) for table, rows in qualifying_table_rows if rows]
    heading_rows_preview, _, _ = rows_from_id_headings(doc.blocks)
    if not heading_rows_preview:
        heading_rows_preview, _, _ = rows_from_heading_structure(doc.blocks)
    subtree_count = len(qualifying_table_rows) + (1 if heading_rows_preview else 0)

    # Job transparency: tell the progress tracker up front how many items each
    # pass will handle (a pass with none is reported as skipped). Estimated from
    # the rows; each pass then counts what it really finishes.
    counter = current_stage_counter()
    if counter is not None and subtree_count:
        plan = {"draft": 0, "improve": 0, "summarize": 0}
        subtree_rows = [r for _, r in qualifying_table_rows]
        if heading_rows_preview:
            subtree_rows.append(heading_rows_preview)
        for rows in subtree_rows:
            requirement_rows = [r for r in rows if r.node_type == "Requirement"]
            synthesized = (
                [r for r in requirement_rows if r.needs_synthesis] if synthesis_client else []
            )
            if synthesis_client:
                plan["draft"] += sum(
                    1 for r in rows if r.needs_synthesis and r.node_type is not None
                )
            if title_tag_client:
                plan["improve"] += len(requirement_rows) - len(synthesized)
            if parent_summary_client:
                plan["summarize"] += sum(1 for r in rows if r.node_type in ("Epic", "Feature"))
        counter.plan(plan)

    def _fire_subtree(label: str) -> None:
        if progress_callback is None:
            return
        progress_callback(
            LevelingProgress(
                phase="deterministic_subtree",
                branch_index=None,
                branch_count=0,
                blocks_done=0,
                blocks_total=0,
                kb_grounded=False,
                kb_citations=[],
                subtree_index=subtree_index,
                subtree_count=subtree_count,
                subtree_label=label,
            )
        )

    for table, rows in qualifying_table_rows:
        _fire_subtree(f"Table {table.id}")
        nodes, warnings = build_hierarchy_subtree(
            rows,
            f"det{subtree_index}_",
            title_tag_client,
            synthesis_client,
            progress_callback=progress_callback,
            subtree_index=subtree_index,
            subtree_count=subtree_count,
            subtree_label=f"Table {table.id}",
            # Every row here came from parsing THIS one table (see
            # rows_from_table) -- there is no heading ancestor above it to
            # walk via parent_index alone, so section_path is seeded with
            # the table's own identity as its root segment. Same
            # caption-or-id-fallback convention _build_headingless_tree's
            # own per-table title already uses.
            # A studied sheet's own first row IS the sheet, so it needs no root segment seeded in front of it.
            section_path_root=None if table.id in sheet_mappings else (table.caption or f"Table {table.id}"),
            chunk_concurrency=chunk_concurrency,
            user_id=user_id,
        )
        if not nodes:
            # The rows carry ids but none is an item (e.g. a "Pin | Signal" table numbered 1..n): the table is not
            # claimed, so the residual folds it into its section like any other table, and its rows are not reported
            # as dropped (they are not).
            subtree_index += 1
            continue
        # Every node in this subtree came from THIS one Table -- unlike a
        # heading-derived node, which can fold zero or more Tables into its
        # span (see the span-claiming loop below), a table-row subtree's
        # nodes ARE that table, so table_ids is simply every node pointing
        # back at it, unconditionally.
        # Not for a studied sheet: its rows ARE the items, and the parent summary pass re-embeds the HTML of every table a node points at, which
        # would put the whole sheet into every section's description.
        if table.id not in sheet_mappings:
            for node in nodes:
                node.table_ids = [table.id]
        studied = sheet_mappings.get(table.id)
        if studied is not None and studied.plan is not None and nodes:
            how = describe_plan(table, studied.plan)
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.SPREADSHEET_MAPPED,
                    raw=(
                        f'Sheet "{table.caption or table.id}" was read as a list of requirements: {studied.item_rows} rows became items, '
                        "taken word for word. The model chose these columns: "
                        f"id {how['id'] or 'none'}, title {how['title'] or 'none'}, text {', '.join(how['text']) or 'none'}, "
                        f"sections {', '.join(how['sections']) or 'none'}. Check them against the sheet."
                    ),
                    node_ids=[nodes[0].local_id],
                    detail={"sheet": table.caption or table.id, "rows": studied.item_rows, "blankRows": studied.blank_rows, **how},
                )
            )
        # Post-hoc structural safety net -- same reasoning and same
        # already-tested function the LLM-analysis path uses (see its own
        # docstring): a deterministic subtree can still end up with a
        # Requirement directly under an Epic (e.g. a group-of-groups row
        # whose direct children mix a further-split sub-group with a lone
        # leaf shall statement) -- confirmed live this cannot be fixed by
        # blindly retyping the parent (see id_tree_builder's own removed-
        # demotion-logic comment for the real bug that caused). Must run
        # BEFORE recompute_child_types, which depends on the FINAL
        # parent/child structure.
        _repair_requirement_hierarchy(nodes, f"det{subtree_index}_", warnings)
        recompute_child_types(nodes)
        det_nodes.extend(nodes)
        det_warnings.extend(warnings)
        claimed_table_ids.add(table.id)
        subtree_index += 1

    heading_rows, heading_warnings, heading_block_ids = rows_from_id_headings(doc.blocks)
    if not heading_rows:
        heading_rows, heading_warnings, heading_block_ids = rows_from_heading_structure(doc.blocks)

    claimed_heading_block_ids: set[str] = set()
    if heading_rows:
        _fire_subtree("Heading hierarchy")
        nodes, build_warnings = build_hierarchy_subtree(
            heading_rows,
            f"det{subtree_index}_",
            title_tag_client,
            synthesis_client,
            progress_callback=progress_callback,
            subtree_index=subtree_index,
            subtree_count=subtree_count,
            subtree_label="Heading hierarchy",
            chunk_concurrency=chunk_concurrency,
            user_id=user_id,
            strip_titles=False,
        )
        # The same typing BASELINE applies to heading documents (see tree_builder.build_baseline_tree), so both modes
        # give one shape; the missing parents are added once, over the whole tree, by ensure_ladder at the end.
        # `_repair_requirement_hierarchy` is not used here because it would add "(auto-grouped)" bridge Features and
        # change the nesting the typing reads.
        document_rules = rulebook.document if rulebook is not None else None
        stated_types = apply_stated_type_labels(
            nodes, _hash_description, labels=document_rules.labels if document_rules else None
        )
        if document_rules is not None:
            stated_types = lock_types_by_depth(nodes, document_rules.depth_types, stated_types)
        type_headings_by_shape(nodes, locked=stated_types, leaf_floor=learn_leaf_floor(nodes))
        det_nodes.extend(nodes)
        det_warnings.extend(heading_warnings)
        det_warnings.extend(build_warnings)
        claimed_heading_block_ids = set(heading_block_ids)
        node_by_local_id = {n.local_id: n for n in nodes}
        row_local_id = [
            f"det{subtree_index}_{row.id_text.replace('.', '_')}" for row in heading_rows
        ]
        block_id_to_row_index = {bid: i for i, bid in enumerate(heading_block_ids)}
        id_disambiguator_needed = any(row.id_disambiguator_needed for row in heading_rows)

        def _resolve_span_target(row_index: int) -> WorkItemNode | None:
            seen: set[int] = set()
            idx: int | None = row_index
            while idx is not None and idx not in seen:
                seen.add(idx)
                row = heading_rows[idx]
                if row.node_type is not None:
                    return node_by_local_id.get(row_local_id[idx])
                idx = row.parent_index
            return None

        # Span claiming: every heading block (in doc.blocks order) marks a
        # boundary; a claimed heading's span runs from just after itself to
        # just before the NEXT heading block in the document (claimed or
        # not) -- exactly the boundary a real Word outline reader would
        # perceive, regardless of which headings this pass happened to
        # claim.
        heading_boundaries = [
            i
            for i, b in enumerate(doc.blocks)
            if b.kind == BlockKind.HEADING and b.heading_level is not None
        ]
        fig_map = figures_by_id(doc.figures)
        current_target: WorkItemNode | None = None
        boundary_ptr = 0
        for i, block in enumerate(doc.blocks):
            while boundary_ptr < len(heading_boundaries) and heading_boundaries[boundary_ptr] < i:
                boundary_ptr += 1
            is_boundary = (
                boundary_ptr < len(heading_boundaries) and heading_boundaries[boundary_ptr] == i
            )
            if is_boundary:
                if block.id in block_id_to_row_index:
                    current_target = _resolve_span_target(block_id_to_row_index[block.id])
                else:
                    current_target = None  # an un-claimed heading resets the span -- its own
                    # content (and anything after it) belongs to the LLM path, not folded
                    # into whatever deterministic heading preceded it.
                continue
            if current_target is None or block.id in claimed_heading_block_ids:
                continue
            claimed_heading_block_ids.add(block.id)
            if _is_unsupported_content_note(block):
                # A loader diagnostic placeholder (e.g. pdf_loader.py's
                # multi-column false-positive note) must never be folded into
                # a node's description as if it were real content -- see
                # _is_unsupported_content_note's own docstring. The block was
                # already claimed above (must not fall through to the
                # residual/LLM path and get double-warned there), so this is
                # the only place left to catch it -- same convention as
                # tree_builder.py's identical `depth is None` branch guard.
                det_warnings.append(
                    IntegrityWarning.make(
                        WarningKind.UNSUPPORTED_CONTENT_NOTE,
                        f'A loader diagnostic note ("{block.text}") was stripped instead of '
                        "leaking into the proposed tree as if it were real content.",
                        node_ids=[current_target.local_id],
                        detail={"kind": "block", "sourceId": block.id, "text": block.text},
                    )
                )
                continue
            if block.kind == BlockKind.FIGURE:
                # Same known-issues item 20 pairing SURVEY's render_section
                # already relies on -- None whenever figure_id_by_block_id
                # wasn't supplied at all (an older/未-updated caller),
                # matching pre-figure_ids behavior.
                figure_id = (
                    figure_id_by_block_id.get(block.id)
                    if figure_id_by_block_id is not None
                    else None
                )
                figure_line = _figure_line(block)
                if figure_line is None:
                    # No real caption (vision disabled/failed/judged insignificant --
                    # see _figure_line's own docstring) -- the figure still exists
                    # in the source though, so it's recorded as uncaptioned on
                    # whatever node its span belongs to rather than vanishing
                    # with zero trace, same as build_baseline_tree's identical
                    # fold-site fix.
                    if figure_id is not None:
                        current_target.uncaptioned_figure_ids.append(figure_id)
                        figure = fig_map.get(figure_id)
                        if figure is not None and figure.caption_status == "insignificant":
                            current_target.insignificant_figure_ids.append(figure_id)
                    continue
                # A real caption is tracked via figure_ids only, never folded
                # into description text -- the Figures UI section
                # (NodeDetailPanel.tsx) already renders the thumbnail +
                # caption there independently of this node's description, so
                # embedding the same caption again as an inline
                # "> Figure: ..." line was pure duplication (removed per
                # explicit user request), matching build_baseline_tree's
                # identical fix.
                current_target.source_ref = _widen_page_end(
                    current_target.source_ref, block.source_ref
                )
                if figure_id is not None:
                    current_target.figure_ids.append(figure_id)
                continue

            current_target.description = assemble_description(
                current_target.description,
                block.text,
            )
            current_target.fidelity_hash = _hash_description(current_target.description)
            current_target.identity_hash = _hash_identity(
                current_target.description,
                current_target.source_ref,
            )
            current_target.source_ref = _widen_page_end(current_target.source_ref, block.source_ref)

        # Precomputed ONCE, not per table: each boundary's own upper bound is
        # just the NEXT entry in this already-document-ordered list -- a
        # plain index+1 lookup. Previously rebuilt via a fresh O(H) list
        # comprehension (`[b for b in heading_boundaries if b > boundary_idx]`)
        # inside the per-table loop below, making the whole table-attribution
        # pass O(T*H^2) instead of O(T*H).
        boundary_upper_by_idx: dict[int, tuple | None] = {}
        for k, boundary_idx in enumerate(heading_boundaries):
            next_boundary_idx = (
                heading_boundaries[k + 1] if k + 1 < len(heading_boundaries) else None
            )
            boundary_upper_by_idx[boundary_idx] = (
                _order_key(doc.blocks[next_boundary_idx].source_ref)
                if next_boundary_idx is not None
                else None
            )

        for table in doc.tables:
            if table.id in claimed_table_ids:
                continue
            table_key = _order_key(table.source_ref)
            owning_boundary_idx: int | None = None
            for boundary_idx in heading_boundaries:
                boundary_block = doc.blocks[boundary_idx]
                if boundary_block.id not in block_id_to_row_index:
                    continue
                upper = boundary_upper_by_idx[boundary_idx]
                lower = _order_key(boundary_block.source_ref)
                if lower <= table_key and (upper is None or table_key < upper):
                    owning_boundary_idx = boundary_idx
                    break
            if owning_boundary_idx is None:
                continue
            target = _resolve_span_target(block_id_to_row_index[doc.blocks[owning_boundary_idx].id])
            if target is None:
                continue
            claimed_table_ids.add(table.id)
            # Same table_ids/description pairing invariant as the
            # analyze_section post-processing loop above (known-issues item
            # 20/EMPTY_TABLE_CONTENT): a table whose span-fold position
            # claims it for `target` can still have a genuinely blank grid
            # (_table_to_html returns "" for it) -- folding nothing into
            # description while still recording table.id in target.table_ids
            # would leave the same content-less "Table tN" chip this warning
            # exists to catch. table.id is claimed either way (it belongs to
            # this span regardless of its own content -- nothing more for
            # the residual LLM path to find in it either, see
            # _table_to_markdown's own None-for-blank convention), but only
            # folded into description/table_ids when it genuinely has
            # content.
            table_html = _table_to_html(table)
            if table_html:
                target.description = assemble_description(target.description, table_html)
                target.fidelity_hash = _hash_description(target.description)
                target.identity_hash = _hash_identity(target.description, target.source_ref)
                target.source_ref = _widen_page_end(target.source_ref, table.source_ref)
                target.table_ids.append(table.id)
            else:
                message = (
                    f'"{target.title}" referenced table {table.id}, but it had no extractable content -- '
                    "worth checking the source table manually."
                )
                logger.warning(message)
                det_warnings.append(
                    IntegrityWarning.make(
                        WarningKind.EMPTY_TABLE_CONTENT,
                        message,
                        node_ids=[target.local_id],
                        detail={"tableId": table.id},
                    )
                )
        del id_disambiguator_needed  # only used to document the branch above; both heading
        # adapters always pass id_disambiguator_needed=False, so span-fold hashing always
        # uses the plain _hash_identity, never the table-row disambiguated variant.
        # Every fold into these nodes is done: now drop the repeated heading (R5).
        strip_repeated_titles(nodes)

    if not claimed_heading_block_ids and not claimed_table_ids:
        _apply_det_parent_summary(
            det_nodes,
            det_warnings,
            parent_summary_client,
            model,
            progress_callback,
            tables_by_id={t.id: t for t in doc.tables},
            chunk_concurrency=chunk_concurrency,
            user_id=user_id,
        )
        return det_nodes, det_warnings, doc

    residual_blocks = [b for b in doc.blocks if b.id not in claimed_heading_block_ids]
    residual_tables = [t for t in doc.tables if t.id not in claimed_table_ids]
    # Every Figure has a paired inline FIGURE-kind Block sharing its EXACT
    # source_ref (see docx_loader.py's own construction of the pair) --
    # render_section/_derive_section_label never consult `figures` for
    # content at all (both explicitly `del figures`, relying entirely on
    # the inline Block.text), so a Figure whose paired block was just
    # claimed above carries no content the LLM path would otherwise see;
    # excluding it here is what lets a real, fully-heading-structured
    # document (confirmed live: AirPro, 39 inline figures all claimed via
    # block span-claiming) actually reach the pure-deterministic guard
    # instead of being kept "non-empty" by 39 redundant Figure objects.
    claimed_figure_offsets = {
        (b.source_ref.document_path, b.source_ref.start_offset)
        for b in doc.blocks
        if b.kind == BlockKind.FIGURE and b.id in claimed_heading_block_ids
    }
    residual_figures = [
        f
        for f in doc.figures
        if (f.source_ref.document_path, f.source_ref.start_offset) not in claimed_figure_offsets
    ]
    llm_doc = doc.model_copy(
        update={"blocks": residual_blocks, "tables": residual_tables, "figures": residual_figures},
    )

    _apply_det_parent_summary(
        det_nodes,
        det_warnings,
        parent_summary_client,
        model,
        progress_callback,
        tables_by_id={t.id: t for t in doc.tables},
        chunk_concurrency=chunk_concurrency,
        user_id=user_id,
    )
    return det_nodes, det_warnings, llm_doc


def _build_survey_tree(
    doc: CanonicalDoc,
    analysis_client: SurveyModelClient,
    scoring_client: BatchedScoringClient | None = None,
    criteria_retriever: CriteriaRetriever | None = None,
    user_id: str | None = None,
    embed_client: object | None = None,
    vector_store: KbVectorStore | None = None,
    # Disconnected roots are grouped by a fixed embedding rule (root_regrouping.deterministic_root_groups), so the group count
    # cannot depend on the chat model; this is the cosine similarity above which two clusters merge.
    root_regroup_cosine_threshold: float = 0.75,
    # The user's KB profile (app.kb.profile): when it has categories, requirement scoring uses its ONE fixed category list
    # and a short constant context instead of the single best document's checklist and the raw retrieved KB text.
    kb_profile: KbProfile | None = None,
    link_type_client: TraceLinkInferenceClient | None = None,
    link_type_catalog: list[dict] | None = None,
    kb_relevance_client: KbRelevanceClient | None = None,
    progress_callback: ProgressCallback | None = None,
    model: str | None = None,
    # Optional capture of the raw content behind a soft-failure warning (KB
    # relevance verification, trace-link inference, Epic/Feature scoring) --
    # see app.debug_capture's own module docstring. None (the default) is
    # byte-identical to before this capability existed; every warning still
    # fires exactly as it did.
    debug_capture: DebugCapture | None = None,
    # Optional per-document title/tag enhancement for the DETERMINISTIC
    # hierarchy path (see _detect_deterministic_subtrees) -- entirely
    # separate from analysis_client above (which drives the LLM-analyzed
    # residual, if any). None (the default) is byte-identical to before
    # this capability existed: deterministic nodes keep their own
    # extract_baseline_title-derived titles and empty tags.
    title_tag_client: TitleTagClient | None = None,
    # Optional requirement-TEXT synthesis for deterministic leaves flagged
    # needs_synthesis (see id_hierarchy.HierarchyRow's own docstring for
    # the per-root-subtree fragment gate that sets it) -- None (the
    # default) is byte-identical to before this capability existed: a
    # flagged leaf keeps its raw, verbatim source text exactly as
    # constructed.
    synthesis_client: SynthesisClient | None = None,
    # Optional Epic/Feature title+description enhancement for the
    # DETERMINISTIC hierarchy path (see _apply_det_parent_summary) -- None
    # (the default) is byte-identical to before this capability existed:
    # an Epic/Feature keeps its verbatim heading-derived title, identical
    # to its description.
    parent_summary_client: ParentSummaryClient | None = None,
    # Optional rewriting of the code-built prose items' text on the fixed tree (app.leveling.content_authoring) -- None (the default) is
    # byte-identical to before: those items keep their source wording.
    content_client: ContentAuthoringClient | None = None,
    # Optional near-duplicate conflict detection (see
    # _detect_conflicting_duplicates's own docstring) -- None (the
    # default) is byte-identical to before this capability existed: a
    # near-duplicate Requirement pair is never checked for conflict.
    conflict_client: ConflictJudgeClient | None = None,
    # Optional topical root regrouping (see
    # _regroup_disconnected_roots's own docstring) -- None (the default)
    # is byte-identical to before this capability existed: disconnected
    # root nodes are left exactly as-is.
    grouping_client: RootGroupingClient | None = None,
    # How many of this document's independent top-level branches to
    # analyze concurrently (see app.config.Settings.survey_branch_concurrency's
    # own doc comment for the full reasoning). 1 (the default) is
    # byte-identical to before this capability existed: branches are
    # processed one at a time, in document order, exactly as before.
    branch_concurrency: int = 1,
    # Optional AI context primer for the whole document (Phase 6a) -- a
    # format-agnostic string that threads into every branch's global_context.
    # None (the default) is byte-identical to before this capability
    # existed: no primer is used.
    primer_context: str | None = None,
    # Acceptance-criteria proposals for requirements the scorer flagged as lacking them (see app.leveling.acceptance_criteria), after the
    # model has read the whole document once (app.leveling.document_study; optional -- without it the proposals use the hierarchy alone).
    # None (the default) is byte-identical to before this capability existed.
    acceptance_criteria_client: AcceptanceCriteriaClient | None = None,
    document_study_client: DocumentStudyClient | None = None,
    # Per-user store of the study's fully read windows (see app.leveling.study_store). None (the default) is byte-identical to before.
    study_store: StudyStore | None = None,
    # How many of a chunked LLM enhancement pass's independent chunks may
    # be in flight at once, for all five of them: the deterministic path's
    # title/tag, requirement-synthesis and Epic/Feature parent-summary
    # passes, plus both whole-document quality-scoring passes. See
    # app.config.Settings.survey_chunk_concurrency for the operator
    # guidance and for why this is a SEPARATE dial from branch_concurrency
    # above (the two never compound -- no chunked pass runs inside a branch
    # worker). 1 (the default) is byte-identical to the previous
    # strictly-sequential behavior.
    chunk_concurrency: int = 1,
    # The document study, started and closed by build_survey_tree (the public wrapper): study_handle is None when none was started, and
    # study_enabled False means the study is switched off. Direct callers leave both: the criteria step then proposes from the hierarchy alone.
    *,
    study_handle: StudyHandle | None = None,
    study_enabled: bool = True,
    # The Study the orchestrator gave on the document (CanonicalDoc.study, STUDY_PHASE on): read by the criteria step instead of a study of its own.
    given_study: Study | None = None,
    criteria_limiter: LeaseLimiter | None = None,
    rulebook: FileRulebook | None = None,
    # Picks one of the code-computed fixes for each item a stated table puts where the ladder does not allow (app.leveling.hierarchy_check).
    hierarchy_client: HierarchyFixClient | None = None,
) -> WorkItemTree:
    """The pipeline behind build_survey_tree (see its docstring); the public wrapper owns the document study."""
    # Real gap (confirmed live, 682-block AirPro ICD document): the
    # preparing_analysis kickoffs further down this function (previously the
    # ONLY ones) both fire AFTER _detect_deterministic_subtrees below --
    # which itself does real, sometimes-slow synchronous CPU work across
    # every block (numbering parsing, ID-hierarchy row extraction, subtree
    # classification) with zero narration. A large/complex document leaves
    # the UI showing nothing newer than parse_done (the end of the SEPARATE,
    # earlier /ingest call) for however long that pass takes -- exactly the
    # "multi-minute silent window" this phase's own docstring already
    # claims to close, but didn't. Firing here, before ANY work in this
    # function, actually closes it. The two later preparing_analysis calls
    # (each guarding a different subsequent synchronous span) are now
    # redundant with this one and have been removed rather than left to
    # double-fire the identical message back-to-back in the ticker.
    if progress_callback is not None:
        progress_callback(
            LevelingProgress(
                phase="preparing_analysis",
                branch_index=None,
                branch_count=0,
                blocks_done=0,
                blocks_total=0,
                kb_grounded=False,
                kb_citations=[],
                model=getattr(analysis_client, "model", None),
            )
        )

    # known-issues item 20: a block.id -> Figure.id map, built ONCE here,
    # over the FULL, ORIGINAL `doc` -- moved from its previous location
    # (after `doc = llm_doc` below, over the residual document only) to
    # HERE, before _detect_deterministic_subtrees ever runs, so the
    # deterministic path's own span-claiming fold sites (see that
    # function's docstring) can name figures too, not just the SURVEY
    # LLM-analysis path below. This reorder is safe: every loader
    # (docx/pptx/pdf) appends a Figure and its paired inline FIGURE-kind
    # Block in lockstep regardless of what happens to `doc` afterward, so
    # the pairing itself doesn't depend on WHEN it's computed -- only on
    # `doc.blocks`/`doc.figures` still being in their original loader-append
    # order (true both before and after residual filtering, which only
    # removes entries, never reorders them). Built over the full document,
    # this map is a strict SUPERSET of the old residual-only map (every key
    # the SURVEY path below could ever look up is still present, plus the
    # deterministically-claimed figures' keys it never needed before) -- so
    # the existing SURVEY branch path (still keyed by this SAME dict,
    # further down) is entirely unaffected by moving this earlier.
    figure_id_by_block_id: dict[str, str] = _build_figure_id_by_block_id(doc)

    # Deterministic hierarchy detection (table-row / ID-bearing-heading /
    # structural-heading conventions -- see _detect_deterministic_subtrees's
    # own docstring) runs BEFORE anything else in this function: every
    # claimed block/table is removed from `doc` for the remainder of this
    # function (via `llm_doc`), so the existing LLM-driven machinery below
    # is completely unaware this detection ever happened for a document
    # that doesn't use any of these conventions -- `llm_doc is doc` in that
    # case (a true no-op, not a copy).
    det_nodes, det_warnings, llm_doc = _detect_deterministic_subtrees(
        doc,
        title_tag_client,
        synthesis_client,
        parent_summary_client,
        model,
        progress_callback=progress_callback,
        figure_id_by_block_id=figure_id_by_block_id,
        chunk_concurrency=chunk_concurrency,
        user_id=user_id,
        sheet_study_client=analysis_client if hasattr(analysis_client, "study_spreadsheet") else None,
        rulebook=rulebook,
        hierarchy_client=hierarchy_client,
    )

    residual_nodes: list[WorkItemNode] = []
    if llm_doc.blocks or llm_doc.tables or llm_doc.figures:
        residual_nodes, residual_warnings = adopt_baseline_structure(llm_doc, rulebook)
        det_nodes = [*det_nodes, *residual_nodes]
        det_warnings = [*det_warnings, *residual_warnings]
        llm_doc = llm_doc.model_copy(update={"blocks": [], "tables": [], "figures": []})

    # Pure-deterministic guard: this document's ENTIRE real content was
    # already claimed above -- skip the whole-doc-gate/branch-splitting/
    # analysis_client machinery entirely rather than firing it on empty
    # input. Everything else a normal SURVEY document gets -- KB
    # retrieval + rubric-checklist grounding for scoring, and whole-tree
    # trace-link inference -- previously was NOT run here at all
    # (confirmed live: every node from a real job came back with
    # `tags: []` and no trace links even where the source text had
    # clear cross-references like "see Requirement 282393"). Uses `doc`
    # -- still the ORIGINAL, full document at this point, since the
    # `doc = llm_doc` reassignment below hasn't happened yet -- so the
    # KB query is grounded in real document content, not the (empty)
    # residual.
    all_nodes: list[WorkItemNode] = list(det_nodes)
    all_warnings: list[IntegrityWarning] = list(det_warnings)
    all_warnings.extend(_external_reference_warnings_for_nodes(all_nodes))

    # preparing_analysis already fired at function entry, before
    # _detect_deterministic_subtrees ran -- covers this guard's own KB
    # retrieval below too, so no second kickoff needed here.
    kb_deps_present = (
        user_id is not None and embed_client is not None and vector_store is not None
    )
    doc_kb_context: str | None = None
    doc_kb_citations: list[KbCitation] = []
    if kb_deps_present:
        query_text = _document_level_query_text(doc)
        doc_kb_context, raw_doc_citations = retrieve_context(
            user_id,
            query_text,
            embed_client,
            vector_store,
        )
        doc_kb_citations = _resolve_kb_citations(
            query_text,
            raw_doc_citations,
            kb_relevance_client,
            debug_capture=debug_capture,
            user_id=user_id,
        )
        doc_kb_context, doc_kb_citations = _merge_always_include_context(
            doc_kb_context,
            doc_kb_citations,
            user_id,
            vector_store,
        )
    deduped_citations = sorted(doc_kb_citations, key=lambda c: c.source_file)
    kb_files_available = _count_kb_files(user_id, vector_store) if kb_deps_present else None
    progress_callback = _stamp_kb_files_available(progress_callback, kb_files_available)

    if content_client is not None:
        # Before scoring, so the scores, the duplicate check and the criteria judge the text that is written.
        author_fixed_tree(
            residual_nodes,
            content_client,
            all_warnings,
            kb_context=doc_kb_context,
            user_id=user_id,
            concurrency=chunk_concurrency,
        )

    if scoring_client is not None:
        model_name = getattr(analysis_client, "model", None)
        requirement_nodes = [
            node for node in all_nodes if node.type == WorkItemType.REQUIREMENT
        ]
        if requirement_nodes:
            # Same cross-run determinism convention the LLM-analysis
            # path already uses (see its own comment further down this
            # function): a fixed, pre-extracted checklist for the most
            # relevant grounding document, if one exists, takes priority
            # over asking the scoring model to derive categories live.
            category_checklist: list[str] | None = None
            # Companion to category_checklist -- name -> the SAME
            # grounding document's own stated definition text, when one
            # exists (see KbVectorStore.get_quality_checklist_
            # definitions and _match_category_checklist's own
            # docstring). Fetched for the identical winning citation
            # category_checklist itself resolved to, never a different
            # one, so the two stay about the same document.
            category_checklist_definitions: dict[str, str] | None = None
            if vector_store is not None and user_id is not None:
                sorted_citations = sorted(
                    doc_kb_citations,
                    key=lambda c: c.similarity,
                    reverse=True,
                )
                for citation in sorted_citations:
                    checklist = vector_store.get_quality_checklist(
                        user_id,
                        citation.source_file,
                    )
                    if checklist:
                        category_checklist = checklist
                        category_checklist_definitions = (
                            vector_store.get_quality_checklist_definitions(
                                user_id,
                                citation.source_file,
                            )
                        )
                        break
            scoring_kb_context = doc_kb_context
            profile_checklist, profile_definitions, profile_context = scoring_inputs(kb_profile)
            if profile_checklist is not None:
                category_checklist, category_checklist_definitions, scoring_kb_context = (
                    profile_checklist,
                    profile_definitions,
                    profile_context,
                )
            _score_all_requirements(
                requirement_nodes,
                scoring_client,
                all_warnings,
                criteria_retriever,
                scoring_kb_context,
                doc_kb_citations,
                progress_callback,
                model_name,
                len(det_nodes),
                0,
                category_checklist,
                category_checklist_definitions,
                chunk_concurrency=chunk_concurrency,
                user_id=user_id,
            )

    _detect_conflicting_duplicates(
        all_nodes,
        embed_client,
        conflict_client,
        all_warnings,
        progress_callback,
        len(det_nodes),
        0,
        user_id=user_id,
    )
    # Complete the document's own structure first, so one Epic titled from the document wraps every orphan and the
    # catch-all below has nothing left to do (the same shape BASELINE gives).
    ensure_ladder(
        all_nodes,
        _derive_doc_title(doc),
        all_warnings,
        scope=_ladder_scope(det_nodes, all_nodes),
    )
    _regroup_disconnected_roots(
        all_nodes,
        "regroup_",
        grouping_client,
        all_warnings,
        progress_callback,
        len(det_nodes),
        0,
        debug_capture=debug_capture,
        user_id=user_id,
        embed_client=embed_client,
        cosine_threshold=root_regroup_cosine_threshold,
    )
    _ensure_root_features_have_epic_parent(
        all_nodes, "regroup_", all_warnings, _derive_doc_title(doc)
    )
    recompute_child_types(all_nodes)
    # Every node that came from the document's own structure must have survived the stages above.
    restore_lost_nodes(det_nodes, all_nodes, all_warnings, "structure stages")
    ensure_ladder(
        all_nodes,
        _derive_doc_title(doc),
        all_warnings,
        scope=_ladder_scope(det_nodes, all_nodes),
    )

    trace_links: list[TraceLink] = []
    if link_type_client is not None:
        trace_links = _infer_trace_links_for_nodes(
            all_nodes,
            link_type_client,
            link_type_catalog or [],
            all_warnings,
            progress_callback,
            len(det_nodes),
            0,
            debug_capture=debug_capture,
            kb_context=doc_kb_context,
            user_id=user_id,
        )

    _propose_criteria_step(
        all_nodes,
        doc,
        acceptance_criteria_client,
        document_study_client,
        all_warnings,
        user_id=user_id,
        study_handle=study_handle,
        study_enabled=study_enabled,
        given_study=given_study,
        background=primer_context,
        limiter=criteria_limiter,
        model=model,
    )
    section_notice = requirement_heading_warning(all_nodes)
    if section_notice is not None:
        all_warnings.append(section_notice)
    return WorkItemTree(
        nodes=all_nodes,
        warnings=finalize_warnings(all_warnings),
        kb_citations=deduped_citations,
        kb_coverage=_kb_coverage(kb_files_available, deduped_citations),
        trace_links=trace_links,
    )


def build_survey_tree(
    doc: CanonicalDoc,
    analysis_client: SurveyModelClient,
    scoring_client: BatchedScoringClient | None = None,
    criteria_retriever: CriteriaRetriever | None = None,
    user_id: str | None = None,
    embed_client: object | None = None,
    vector_store: KbVectorStore | None = None,
    root_regroup_cosine_threshold: float = 0.75,
    kb_profile: KbProfile | None = None,
    link_type_client: TraceLinkInferenceClient | None = None,
    link_type_catalog: list[dict] | None = None,
    kb_relevance_client: KbRelevanceClient | None = None,
    progress_callback: ProgressCallback | None = None,
    model: str | None = None,
    debug_capture: DebugCapture | None = None,
    title_tag_client: TitleTagClient | None = None,
    synthesis_client: SynthesisClient | None = None,
    parent_summary_client: ParentSummaryClient | None = None,
    content_client: ContentAuthoringClient | None = None,
    conflict_client: ConflictJudgeClient | None = None,
    grouping_client: RootGroupingClient | None = None,
    branch_concurrency: int = 1,
    primer_context: str | None = None,
    acceptance_criteria_client: AcceptanceCriteriaClient | None = None,
    document_study_client: DocumentStudyClient | None = None,
    study_store: StudyStore | None = None,
    chunk_concurrency: int = 1,
    study_limiter: LeaseLimiter | None = None,
    # What the pre-study learned about the file's conventions. None: when the analysis client can study file conventions (study_file_rules_*), the
    # model is asked once here (prestudy), its answers validated against the whole file; the rules are then fixed for the rest of the run.
    rulebook: FileRulebook | None = None,
    # Picks one of the code-computed fixes for each item a stated table puts where the ladder does not allow (app.leveling.hierarchy_check).
    hierarchy_client: HierarchyFixClient | None = None,
) -> WorkItemTree:
    """Builds the SURVEY work-item tree. Which items exist, their types and their nesting come from the document itself, never from
    the chat model, so the same file gives the same items whichever model runs and however often:

    1. the deterministic detectors (identified table rows, ID-bearing and labelled headings, the file-conventions pre-study's
       rulebook) claim what they recognise;
    2. everything else is structured by the BASELINE rules (adopt_baseline_structure);
    3. disconnected roots are grouped by a fixed embedding rule, the model only naming each group (root_regrouping), and the
       Epic -> Feature -> Requirement ladder is enforced (only Epics are roots).

    The model then only judges and enriches the fixed tree, each pass optional and fail-open (a failure is a warning, never a failed
    job): requirement quality scoring (`scoring_client`, one batched pass over every Requirement, grounded on the KB profile or the
    retrieved KB context when `user_id`, `embed_client` and `vector_store` are given), trace/coverage links (`link_type_client`, one
    whole-tree pass; a link whose source is not a node of this tree, whose type is outside a non-empty `link_type_catalog`, or whose
    evidence does not ground it is dropped; a target that is a node here is intraJob, anything else crossJob), and acceptance-criteria
    proposals for flagged requirements (`acceptance_criteria_client`, using the background document study started here so it reads
    while the other steps run)."""
    arguments = dict(
        locals()
    )  # every parameter as passed, whether it was given by position or by name
    study_limiter = arguments.pop("study_limiter")
    # A Study the orchestrator gave on the document (STUDY_PHASE on) replaces both the background study and the primer: its orientation is the
    # criteria's background, and no study of this run's own is started.
    given = study_of(doc)
    if given is not None:
        arguments["primer_context"] = orientation_text(given.orientation)
    # The study is owned here, never by the last step, so no thread of it outlives the job on any exit path (see app.leveling.study_runner).
    study_enabled = settings.survey_study_enabled
    handle: StudyHandle | None = None
    if (
        given is None
        and study_enabled
        and acceptance_criteria_client is not None
        and document_study_client is not None
    ):
        # One snapshot of the full document, taken here before any stage runs: the study thread reads this string and never the live blocks,
        # so a stage that touches them cannot change what is read (and so the stored study's key).
        try:
            document_text = render_section(doc.blocks, doc.tables)
            handle = StudyHandle.from_settings(
                render_text=lambda: document_text,
                client=document_study_client,
                user_id=user_id,
                scope=user_scope(user_id),
                model=model,
                store=study_store if user_id else None,
                limiter=study_limiter if user_id else None,
            )
            handle.start()  # before anything else runs, so it reads while the pipeline works; `doc` here is the full document, not the residual
        except JobCancelled:
            raise
        except Exception as error:  # noqa: BLE001 -- the study is context only: the criteria step falls back to reading the document itself
            logger.warning(
                "Document study could not start (%s); carrying on without it.", type(error).__name__
            )
            handle = None
    prestudy_warnings: list[IntegrityWarning] = []
    if rulebook is None and hasattr(analysis_client, "study_file_rules_table"):
        # Only for what the recognised headings do not cover; a failed or refused study leaves the file on the deterministic path, with a warning.
        rulebook, prestudy_warnings = prestudy(doc, analysis_client, user_id)  # type: ignore[arg-type]
        arguments["rulebook"] = rulebook
    try:
        tree = _build_survey_tree(
            **arguments,
            study_handle=handle,
            study_enabled=study_enabled,
            given_study=given,
            criteria_limiter=study_limiter,
        )
    except BaseException:
        if (
            handle is not None
        ):  # the job failed or was cancelled: the study's stored windows go too, even a finished study's
            try:
                handle.close(discard=True)
            except Exception as error:  # noqa: BLE001 -- must not mask the job's own exception
                logger.warning("Document study could not be closed (%s).", type(error).__name__)
        raise
    if handle is not None:
        handle.close()  # a finished job keeps the study's windows as the re-run cache; a study still running is stopped and cleaned up
    tree.warnings.extend(prestudy_warnings)
    if rulebook is not None and rulebook.tables:
        # The tables read by the model's rules are checked against those rules (the recognised ones are checked by /level itself).
        tree.warnings.extend(
            verify_tree_against_rules(
                doc, tree, {t: r for t, r in study_tables(doc, rulebook).items() if t in rulebook.tables}
            )
        )
    return assign_identity_v2(tree, doc)


def _propose_criteria_step(
    nodes: list[WorkItemNode],
    source_doc: CanonicalDoc,
    criteria_client: AcceptanceCriteriaClient | None,
    study_client: DocumentStudyClient | None,
    warnings: list[IntegrityWarning],
    user_id: str | None = None,
    study_handle: StudyHandle | None = None,
    study_enabled: bool = True,
    given_study: Study | None = None,
    background: str | None = None,
    limiter: LeaseLimiter | None = None,
    model: str | None = None,
) -> None:
    """Runs the acceptance-criteria proposals (see app.leveling.acceptance_criteria) when a client is supplied and any requirement is
    eligible. The whole-document study runs only then, so a document with nothing to propose never pays for it.

    With a `study_handle` (started by build_survey_tree) the study has been reading in the background since the job began: this joins it, or,
    when nothing is eligible, stops it and keeps the windows it had stored. Without one the proposals use the hierarchy alone, and when the study
    was wanted (`study_enabled` and a `study_client`) one warning says it could not be started: the document is never read on the job's thread.
    A `given_study` (the orchestrator's Study, CanonicalDoc.study) is read instead of any study of this run's own; its reading warnings are
    the job's, as the background study's are."""
    if criteria_client is None or not eligible_nodes(nodes):
        skip_criteria_stage()
        if study_handle is not None:
            study_handle.stop(keep_results=True)  # not needed: what is stored stays as the cache
        return
    study = None
    tables_by_id = {t.id: t for t in source_doc.tables}

    def table_text(table_id: str) -> str | None:
        table = tables_by_id.get(table_id)
        return _table_to_markdown(table) if table is not None else None

    if given_study is not None:
        study = as_document_study(given_study)
        for message in given_study.warnings:
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.DOCUMENT_STUDY_INCOMPLETE,
                    message,
                    detail={"pass": "document_study"},
                )
            )
    elif study_handle is not None:
        outcome = study_handle.result(
            timeout=settings.survey_study_hard_budget_seconds + 60
        )  # JobCancelled is not swallowed
        study = outcome.study
        for message in outcome.warnings:  # turned into warnings here, in the job's own thread
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.DOCUMENT_STUDY_INCOMPLETE,
                    message,
                    detail={"pass": "document_study"},
                )
            )
    elif (
        study_enabled and study_client is not None
    ):  # wanted, but the wrapper could not start it: the job's thread never reads the document
        warnings.append(
            IntegrityWarning.make(
                WarningKind.DOCUMENT_STUDY_INCOMPLETE,
                "The document study could not be started, so acceptance criteria proposals used the hierarchy alone.",
                detail={"pass": "document_study"},
            )
        )

    propose_acceptance_criteria(
        nodes,
        study,
        criteria_client,
        warnings,
        table_text,
        user_id=user_id,
        background=background,
        limiter=limiter,
        model=model,
    )


