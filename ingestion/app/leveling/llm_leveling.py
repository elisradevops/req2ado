from __future__ import annotations

import hashlib
import logging
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING, Callable, NamedTuple, Protocol

if TYPE_CHECKING:
    from app.debug_capture import DebugCapture

from app.canonical.model import Block, BlockKind, CanonicalDoc, Figure, Table, plain_text_rows
from app.distillation.description import assemble_description
from app.distillation.title import extract_baseline_title
from app.kb.kb_vector_store import _MAX_DOCUMENT_CHUNKS as _KB_GET_DOCUMENT_MAX_CHUNKS
from app.kb.kb_vector_store import KbVectorStore
from app.kb.retrieval import fetch_always_include_context, retrieve_context
from app.leveling.conflict_detection import (
    ConflictJudgeClient,
    _detect_conflicting_duplicates,
)
from app.leveling.depth import resolve_block_depth
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
from app.leveling.model_caps import ModelCapsClient, _ModelCaps, _resolve_caps
from app.leveling.narration_publisher import LevelingProgress, Phase, ProgressCallback
from app.leveling.root_regrouping import (
    RootGroupingClient,
    _ensure_root_features_have_epic_parent,
    _regroup_disconnected_roots,
    _repair_requirement_hierarchy,
)
from app.leveling.scoring import (
    BatchedScoringClient,
    _score_all_requirements,
    _score_epics_and_features,
)
from app.leveling.table_groups import TableGroupInfo, qualifying_table_groups
from app.leveling.trace_links import TraceLinkInferenceClient, _infer_trace_links_for_nodes
from app.leveling.tree_builder import (
    _bound_branch_size,
    _figure_line,
    _hash_description,
    _hash_identity,
    _hash_identity_for_synthesized_node,
    _order_key,
    _partition_tables_by_branch,
    _split_into_branches,
    _table_to_html,
    _widen_page_end,
)
from app.leveling.tree_builder import figure_id_by_block_id as _build_figure_id_by_block_id
from app.quality.criteria_retrieval import CriteriaRetriever
from app.leveling.warnings_finalize import finalize_warnings
from app.workitem.model import (
    IntegrityWarning,
    KbCitation,
    KbCitationRelevance,
    RequirementTag,
    TraceLink,
    WarningKind,
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

# Reserved out of coverage_budget_tokens for the KB context, system prompt,
# and the model's own output -- the whole-document gate (§3) and budget-merge
# splitter (§4) compare rendered TEXT size against (coverage_budget_tokens -
# this headroom), not the raw budget, so there's real room left for the rest
# of the payload.
_WHOLE_DOC_HEADROOM_TOKENS = 4_000

# Cheap chars/4 heuristic -- good enough for a budget GATE (deciding whether
# to skip splitting or how many blocks a merged branch can hold), not exact
# token accounting. Avoids a new tokenizer dependency; consistent with this
# module's other block-count-proxy conventions (see
# _MAX_SURVEY_BRANCH_BLOCK_COUNT's own docstring).
_CHARS_PER_TOKEN_ESTIMATE = 4


def _estimate_tokens(text: str) -> int:
    return len(text) // _CHARS_PER_TOKEN_ESTIMATE


def _merge_branches_by_budget(branches: list[list[Block]], budget_tokens: int) -> list[list[Block]]:
    """§4: structure-aware budget-merge for the doesn't-fit-in-one-call
    fallback path. _split_into_branches (tree_builder.py, shared with
    BASELINE mode -- deliberately left untouched, see its own docstring)
    splits on every occurrence of the document's shallowest heading/
    numbering depth. That's correct as a never-split-mid-section structural
    primitive, but produces one branch per heading regardless of how small
    each section actually is -- the AirPro document has ~79 depth-2 headings
    and no depth-1 ones at all, so every single heading became its own
    isolated branch, each analyzed with zero awareness of its neighbors.

    Greedily merges ADJACENT branches (preserving document order -- a
    section is never split apart, only whole sections joined together) into
    the current running branch until the NEXT branch would push the merged
    rendered text over budget_tokens; only then closes the current branch
    and starts a fresh one. Collapses many small sections into a handful of
    budget-sized branches instead of one per heading. Token cost is tracked
    via a running sum of each branch's OWN _estimate_tokens(render_section(..))
    rather than re-rendering the full merged buffer on every step -- O(n)
    instead of O(n^2); a good-enough approximation for a budget gate, not
    exact accounting (see _CHARS_PER_TOKEN_ESTIMATE's own docstring).

    _bound_branch_size still runs AFTER this (unchanged) as the safety net
    for any single section that alone exceeds the model's block-count cap,
    regardless of how small its token footprint is."""
    if not branches:
        return branches
    merged: list[list[Block]] = []
    current: list[Block] = list(branches[0])
    current_tokens = _estimate_tokens(render_section(current, None, None))
    for branch in branches[1:]:
        branch_tokens = _estimate_tokens(render_section(branch, None, None))
        if current_tokens + branch_tokens <= budget_tokens:
            current.extend(branch)
            current_tokens += branch_tokens
        else:
            merged.append(current)
            current = list(branch)
            current_tokens = branch_tokens
    merged.append(current)
    return merged


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


_PREVIEW_LENGTH = 80


def _truncate_for_preview(text: str) -> str:
    """One-line, length-capped rendering of a block's text for the dropped-
    block warning -- collapses embedded newlines (list items, wrapped
    paragraphs) so each preview stays a single readable line."""
    collapsed = " ".join(text.split())
    if len(collapsed) <= _PREVIEW_LENGTH:
        return f'"{collapsed}"' if collapsed else "(empty block)"
    return f'"{collapsed[:_PREVIEW_LENGTH]}…"'


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


# A 1-2-significant-word block ("APOLLO2", "SBC", "Notes:") is a structural
# label or list-intro, not content that could ever plausibly re-appear
# verbatim (even paraphrased) inside a synthesized shall-statement -- the
# overlap check below would always flag it as "dropped" even when the model
# correctly absorbed it as context rather than restating it, exactly what
# the analysis prompt tells it to do. Same accepted-imprecision trade-off as
# _LOW_GROUNDING_THRESHOLD above: a genuinely short 2-word requirement could
# in theory be missed, but in practice this class of block is never one.
_MIN_SIGNIFICANT_WORDS_FOR_COVERAGE_CHECK = 2


def _label_match_candidates(label: str, nodes: list[WorkItemNode]) -> list[WorkItemNode]:
    """Shared matching core for both _group_label_became_a_node (existence)
    and _find_node_by_label (identification) -- factored out after
    confirming live (see _find_node_by_label's own docstring history) that
    a single fractional-word-overlap threshold was both too loose to
    IDENTIFY one specific node (false ambiguity: "Audio Control"
    fractional-matched 6 unrelated titles) AND, separately confirmed via
    the same real document, too loose to reliably signal EXISTENCE either:
    "System Settings and User Experience" and "System Description and
    Information" (both genuinely MISSING as their own nodes) each
    fractional-matched an unrelated node on a single common word
    ("settings" / "description" respectively), silently swallowing 2 of 3
    real missing-Epic cases from the "did not produce a distinctly-titled
    node" coverage-check warning -- the warning that exists specifically to
    catch this.

    Returns, tightest first:
    1. Every node whose title exactly equals `label` (case/whitespace-
       insensitive) -- the generated title IS frequently the model's own
       verbatim attempt at the source label.
    2. Failing that, every node whose title FULLY CONTAINS every one of the
       label's significant words (not just a fraction), ordered by fewest
       extra words beyond the label (closest, most specific match first).
    Returns [] when nothing matches at either tier. Deliberately does not
    rank across tiers or invent a match beyond these two -- "under-trigger,
    don't over-trigger" is the same accepted trade-off this module's
    table_groups sibling documents for its own "shall"-based
    discriminator."""
    label_words = _significant_words(label)
    if not label_words:
        return []
    normalized_label = " ".join(label.split()).casefold()
    exact_matches = [
        node for node in nodes if " ".join(node.title.split()).casefold() == normalized_label
    ]
    if exact_matches:
        return exact_matches

    candidates: list[tuple[int, WorkItemNode]] = []
    for node in nodes:
        title_words = _significant_words(node.title)
        if label_words <= title_words:
            candidates.append((len(title_words - label_words), node))
    candidates.sort(key=lambda pair: pair[0])
    return [node for _extra, node in candidates]


def _group_label_became_a_node(label: str, nodes: list[WorkItemNode]) -> bool:
    """True if some generated node's own TITLE (not its full description
    body) identifies this source table group's label -- an EXISTENCE check
    only (unlike _find_node_by_label, a tie between multiple equally-close
    candidates still counts as "yes, it became A node somewhere", since
    this function never needs to pick ONE of them). Checked against TITLES
    specifically, NOT the combined-description-text check
    _block_content_appears_in_generated_output uses -- confirmed live that
    every leaf requirement under a missing group still survives somewhere
    in SOME node's description even when the group itself never became its
    own node (that's the exact bug this check exists to catch), so a
    body-text overlap check would trivially "find" the group via its own
    merged children's vocabulary and never fire. Checking titles targets
    the real question: did this group get its OWN node, not just did its
    content survive somewhere.

    Empty `label` returns True (nothing meaningful to check for), matching
    _label_match_candidates' own "no significant words -> []" convention
    inverted for this function's existence semantics."""
    if not _significant_words(label):
        return True
    return bool(_label_match_candidates(label, nodes))


def _find_node_by_label(label: str, nodes: list[WorkItemNode]) -> WorkItemNode | None:
    """The single node that best identifies `label`, or None when there is
    no match or a genuine tie -- deliberately does not guess (see
    _repair_group_attachment's own docstring for why). Uses
    _label_match_candidates (exact title match first, then full word
    containment ordered closest-first) and resolves to a single answer only
    when the top candidate is unambiguous: exactly one exact-tier match, OR
    (no exact match, and either only one containment candidate, or the
    closest containment candidate is STRICTLY closer than the next)."""
    label_words = _significant_words(label)
    if not label_words:
        return None
    candidates = _label_match_candidates(label, nodes)
    if not candidates:
        return None
    normalized_label = " ".join(label.split()).casefold()
    if " ".join(candidates[0].title.split()).casefold() == normalized_label:
        # Exact-tier result -- _label_match_candidates returns ALL exact
        # matches when any exist, never a containment fallback alongside
        # them, so more than one entry here means a genuine exact-title tie.
        return candidates[0] if len(candidates) == 1 else None
    if len(candidates) == 1:
        return candidates[0]
    extra_first = len(_significant_words(candidates[0].title) - label_words)
    extra_second = len(_significant_words(candidates[1].title) - label_words)
    return candidates[0] if extra_first < extra_second else None


def _repair_group_attachment(
    nodes: list[WorkItemNode],
    table_groups: list[TableGroupInfo] | None,
    node_id_prefix: str,
    warnings: list[IntegrityWarning],
) -> None:
    """Confirmed real bug, live-tested against a human-authored reference
    hierarchy: a source table group that DID get correctly detected,
    correctly typed, and correctly split into its own child nodes can still
    end up attached to the WRONG ancestor in the generated tree (e.g. "Mute
    and Volume-Restore Behavior" landing under "Channel Scan and Automatic
    Search" instead of "Audio Control") -- a different failure mode from
    _repair_requirement_hierarchy's (wrong node TYPE in the parent slot);
    this is a wrong SPECIFIC node in an otherwise-valid parent slot.

    The table's own ID hierarchy already fully determines the correct
    parent for every qualifying group (see TableGroupInfo.parent_label) --
    a fact already 100% known before generation even starts. A prior fix
    this session tried threading MORE of this into the prompt (a
    root-count instruction) and confirmed a real regression: the model
    over-anchored on the added instruction at the expense of unrelated
    coverage, collapsing total node count. Given prompt real estate is a
    scarce, shared resource across every instruction already in
    _SECTION_ANALYSIS_SYSTEM_PROMPT, this repairs the known-wrong
    attachment DETERMINISTICALLY after generation instead of asking the
    model (again) to get it right -- zero risk to any other prompt-driven
    behavior, mirroring _repair_requirement_hierarchy's own established
    "fix a known-bad shape after the fact" pattern rather than adding a
    5th round of prompt tuning.

    Deliberately conservative, matching this module's "under-trigger, not
    over-trigger" convention: does nothing (no repair, no warning) when
    either the group's own node or its correct parent's node can't be
    found, or is ambiguous (_find_node_by_label returns None for both
    cases) -- a genuinely missing group is already reported by the
    separate _group_label_became_a_node coverage-check warning; there is
    nothing correct to re-parent to if the correct parent was never itself
    emitted as a node, and guessing among multiple ambiguous candidates
    risks a WRONG repair, worse than leaving the original (already wrong)
    attachment as-is. Also a no-op when the node is already correctly
    parented -- must never repeat this action or warn every run."""
    if not table_groups:
        return
    for group in table_groups:
        if not group.parent_label:
            continue
        node = _find_node_by_label(group.label, nodes)
        if node is None:
            continue
        correct_parent = _find_node_by_label(group.parent_label, nodes)
        if correct_parent is None or correct_parent.local_id == node.local_id:
            continue
        if node.parent_local_id == correct_parent.local_id:
            continue  # already correctly parented -- true no-op
        if node.type == WorkItemType.REQUIREMENT and correct_parent.type == WorkItemType.EPIC:
            # A REQUIREMENT-typed group's correct parent (per the table's ID
            # hierarchy) can itself be an EPIC-typed group -- structurally
            # legal per TableGroupInfo, but re-parenting straight there would
            # violate the Epic -> Feature -> Requirement chain
            # _repair_requirement_hierarchy already established (which runs
            # BEFORE this pass and won't see this new violation). Not
            # observed on any document so far -- a generality guard, not a
            # live regression -- so leave the existing (already
            # chain-valid) attachment alone rather than re-breaking it.
            continue
        message = (
            f'"{node.title}" ({node.type.value}) matching source table group '
            f"'{group.label}' was attached under the wrong ancestor -- re-parented under "
            f'"{correct_parent.title}" to match its known correct parent (\'{group.parent_label}\') '
            "from the table's own ID hierarchy."
        )
        logger.warning(message)
        warnings.append(
            IntegrityWarning.make(
                WarningKind.GROUP_REPARENTED,
                message,
                node_ids=[node.local_id],
                detail={
                    "targetParentId": correct_parent.local_id,
                    "targetParentTitle": correct_parent.title,
                    "groupLabel": group.label,
                },
            )
        )
        node.parent_local_id = correct_parent.local_id


def _block_content_appears_in_generated_output(block_text: str, combined_words: set[str]) -> bool:
    """True if the block's own significant vocabulary meaningfully overlaps
    with the generated output taken as a WHOLE (every node's text, not just
    one) -- a block whose node_id the LLM never referenced in `hierarchy`
    can still have had its content folded into a DIFFERENT node's formalized
    text (a legitimate merge), which per-node lookups can't detect. Trivially
    True for a block with no significant words at all (nothing to lose), or
    too few to be meaningful content rather than a structural label.

    `combined_words` is the PRECOMPUTED significant-word set of every
    generated node's text, joined once by the caller -- recomputing it (via
    `" ".join(all_generated_texts)` + `_significant_words`) inside this
    function, called once per source block, made the whole coverage check
    O(blocks * total_description_chars) instead of O(blocks +
    total_description_chars)."""
    block_words = _significant_words(block_text)
    if len(block_words) < _MIN_SIGNIFICANT_WORDS_FOR_COVERAGE_CHECK:
        return True
    overlap = len(block_words & combined_words) / len(block_words)
    return overlap >= _BLOCK_COVERAGE_OVERLAP_THRESHOLD


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
    over user_id/embed_client/vector_store -> retrieve_context) so this
    Protocol/its real implementation stays free of KB dependencies -- it only
    executes tool calls the model asks for. `list_documents_fn`/
    `read_document_fn` (§15) are optional, same injected-closure convention --
    when supplied, the model can additionally read a FULL previously-ingested
    KB document (see KbVectorStore.get_document), not just top-k similarity
    snippets; omitting either (the pre-§15 default) offers only query_kb.
    `read_other_section_fn` (§3.3) is the same injected-closure convention for
    reading a specific OTHER SECTION of the CURRENT document (not the KB) on
    demand -- only populated on the compact-outline path (build_survey_tree's
    whole-doc gate found the document too large for one call).
    Returns (nodes, citations)."""

    def analyze_section(
        self,
        section_text: str,
        kb_context: str | None = None,
        whole_document: bool = False,
        topic_count: int | None = None,
        # (label, suggested_type) pairs for this section's own qualifying
        # table groups (see table_groups.qualifying_table_groups) -- names
        # the specific groups counted in topic_count's floor AND states
        # which work-item type each one should become, so the model knows
        # WHICH groups must get their own node, not just how many, and
        # isn't left to guess Feature vs Requirement vs Epic on its own.
        table_group_hints: list[tuple[str, str]] | None = None,
        # Count of independent top-level table groups (see
        # table_groups.TableGroupInfo.is_top_level) with no common
        # ancestor -- lets the model know a real multi-root document is
        # expected instead of the default single-root assumption. None/<2
        # (the common case) preserves today's exact single-root wording.
        expected_root_count: int | None = None,
    ) -> tuple[list[dict], bool]: ...

    def analyze_section_agentic(
        self,
        section_text: str,
        retrieve_fn: Callable[[str], tuple[str | None, list[dict]]],
        list_documents_fn: Callable[[], list[str]] | None = None,
        read_document_fn: Callable[[str], str | None] | None = None,
        read_other_section_fn: Callable[[str], str | None] | None = None,
        whole_document: bool = False,
        topic_count: int | None = None,
        table_group_hints: list[tuple[str, str]] | None = None,
        expected_root_count: int | None = None,
    ) -> tuple[list[dict], list[dict], bool]: ...


def _resolve_kb_citations(
    outline: str,
    raw_citations: list[dict],
    kb_relevance_client: KbRelevanceClient | None,
    node_id_prefix: str = "",
    debug_capture: "DebugCapture | None" = None,
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
            if debug_capture is not None:
                debug_capture.capture("kb_relevance", node_id_prefix.rstrip("_") or "root", str(exc))
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


def _merge_always_include_context(
    kb_context: str | None,
    kb_citations: list[KbCitation],
    user_id: str,
    vector_store: KbVectorStore,
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
    always_include_context, always_include_raw = fetch_always_include_context(user_id, vector_store)
    if always_include_context is None:
        return kb_context, kb_citations
    merged_context = always_include_context if kb_context is None else f"{always_include_context}\n\n{kb_context}"
    merged_citations = [
        *kb_citations,
        *(KbCitation(source_file=c["source_file"], similarity=c["similarity"], relevance=KbCitationRelevance.RELEVANT) for c in always_include_raw),
    ]
    return merged_context, merged_citations


_DOC_LEVEL_QUERY_FALLBACK_CHARS = 2000


def _document_level_query_text(doc: CanonicalDoc) -> str:
    """Builds the ONE query text used to retrieve KB context ONCE per
    document for the §5c fallback (non-tool-capable model) path -- heading
    text is the strongest signal of what the document is about; when a
    document has no headings at all, falls back to its first ~2000 chars of
    block text (a conservative proxy, same spirit as
    _MAX_SURVEY_BRANCH_BLOCK_COUNT's block-count proxy)."""
    heading_text = "\n".join(block.text for block in doc.blocks if block.kind == BlockKind.HEADING)
    if heading_text.strip():
        return heading_text
    return "\n".join(block.text for block in doc.blocks)[:_DOC_LEVEL_QUERY_FALLBACK_CHARS]


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
    r"reqid(?:\s*\d+)?|see excel|attached|refer(?:s|red)? to (?:the )?document|appendix|annex", re.IGNORECASE
)


def _referenced_attachment_warnings(section_text: str, section_label: str | None) -> list[IntegrityWarning]:
    """One warning per distinct matched reference phrase in this branch's
    rendered section text, deduped case-insensitively (so a phrase repeated
    many times in one section doesn't spam the warnings list) while
    preserving the first occurrence's original casing in the message."""
    seen_by_key: dict[str, str] = {}
    for m in _REFERENCED_ATTACHMENT_PATTERN.finditer(section_text):
        seen_by_key.setdefault(m.group(0).lower(), m.group(0))
    section_ref = f'The "{section_label}" section' if section_label else "This section"
    return [
        IntegrityWarning.make(
            WarningKind.EXTERNAL_REFERENCE,
            f"{section_ref} references an external artifact ({seen_by_key[key]!r}) this "
            "SURVEY run did not ingest -- consider adding it to the knowledge base.",
            detail={"section": section_label or "(root)", "phrase": seen_by_key[key]},
        )
        for key in sorted(seen_by_key)
    ]


_SECTION_LABEL_EXCERPT_CHARS = 60


def _derive_section_label(blocks: list[Block], tables: list[Table] | None, figures: list[Figure] | None) -> str | None:
    """Human-readable label for a branch's section, threaded into narration
    (see NarrationPublisher) so the progress UI can show WHICH real content
    a job is analyzing/failed on, not just an anonymous "Section N of M".
    Prefers the branch's own first heading text (the common case --
    _split_into_branches splits on depth-1 headings, so a branch's first
    block IS usually its heading); falls back to a short excerpt of the
    first block's text for a headingless branch, then a table's caption for
    the blocks-empty xlsx-only case (§4); None for a branch with nothing to
    label at all."""
    del figures  # no caption/label signal distinct from what tables/blocks already provide
    for block in blocks:
        if block.kind == BlockKind.HEADING:
            return block.text
    if blocks:
        text = blocks[0].text.strip()
        if len(text) > _SECTION_LABEL_EXCERPT_CHARS:
            return text[:_SECTION_LABEL_EXCERPT_CHARS] + "…"
        return text or None
    if tables and tables[0].caption:
        return tables[0].caption
    return None


def _branch_heading_labels(blocks: list[Block]) -> list[str]:
    """Every heading-equivalent block's text within a branch -- real
    HEADING-kind blocks AND numbered-paragraph pseudo-headings alike, via
    the SAME predicate _split_into_branches itself trusts
    (resolve_block_depth), not the narrower BlockKind.HEADING check
    _derive_section_label uses for its OWN (deliberately first-only)
    narration label. Prepends a docx-loader-synthesized number_label
    (see docx_loader.py's heading-number synthesis) when present, so a
    cross-referencing branch sees the same "3.2" a human reader would."""
    labels = []
    for block in blocks:
        if resolve_block_depth(block)[0] is None:
            continue
        labels.append(f"{block.number_label} {block.text}" if block.number_label else block.text)
    return labels


def _build_document_outline(branches: list[list[Block]]) -> str:
    """Compact document outline (§3.3) -- section labels only, NOT raw
    section text -- threaded as `global_context` into every branch's
    analyze_section call when the whole document doesn't fit in one call
    (build_survey_tree's whole-doc gate). Gives every branch document-wide
    awareness without repeating the confirmed degrading pattern of
    re-sending the same raw full document on every one of many separate
    calls (see build_survey_tree's own docstring for the research citation).
    1-based numbering matches read_other_section_fn's section_id convention
    so the model can ask for e.g. "3" the same way this outline names it."""
    lines = [
        "Document outline (for orientation only -- you are analyzing ONE "
        "section below; call read_other_section with a number from this list "
        "if you need another section's full text for a cross-reference):"
    ]
    for i, branch in enumerate(branches, start=1):
        labels = _branch_heading_labels(branch)
        label = "; ".join(labels) if labels else f"(section {i})"
        lines.append(f"{i}. {label}")
    return "\n".join(lines)


_GLOSSARY_HEADING_PATTERN = re.compile(r"(?i)\b(definition|acronym|glossary|abbreviation|terminolog)")
_GLOSSARY_INLINE_MAX_TOKENS = 500

# Mirrors _GLOSSARY_HEADING_PATTERN's own shape exactly -- a deterministic,
# zero-LLM-cost signal that a branch's heading is typical front matter
# (Introduction/TOC/Revision History/Appendix/References), used ONLY to
# inject a soft guard instruction into that branch's own analyze_section
# call. Never skips or merges the branch -- a genuine requirement
# accidentally placed under "Introduction" must still be able to surface.
_FRONT_MATTER_HEADING_PATTERN = re.compile(
    r"(?i)\b(introduction|table of contents|revision history|document history|appendix|references?)\b"
)

_FRONT_MATTER_GUARD_TEXT = (
    "This section's heading matches typical front-matter (Introduction/"
    "Table of Contents/Revision History/Appendix). Only emit work items if "
    "genuine testable/actionable content exists in this section's text -- "
    "do not fabricate an Epic/Feature/Requirement merely to represent this "
    "section's existence."
)


def _find_glossary_sections(
    branches: list[list[Block]], branch_tables: list[list[Table]]
) -> list[tuple[int, str, str]]:
    """(branch_index, section_label, rendered_text) for every branch whose
    heading matches a definitions/acronyms/glossary/abbreviations/
    terminology keyword AND whose full rendered content fits under
    _GLOSSARY_INLINE_MAX_TOKENS. An oversized match is excluded entirely
    (never partially inlined -- an unpredictable truncation appearing
    mid-glossary would be worse than the label-only status quo)."""
    matches = []
    for i, (branch, tables) in enumerate(zip(branches, branch_tables)):
        labels = _branch_heading_labels(branch)
        if not any(_GLOSSARY_HEADING_PATTERN.search(label) for label in labels):
            continue
        rendered = render_section(branch, tables)
        if not rendered or _estimate_tokens(rendered) > _GLOSSARY_INLINE_MAX_TOKENS:
            continue
        section_label = labels[0] if labels else "(untitled section)"
        matches.append((i, section_label, rendered))
    return matches


def _find_front_matter_branches(branches: list[list[Block]]) -> set[int]:
    """Branch indices whose heading label matches a front-matter keyword.
    Same heading-label source as _find_glossary_sections (_branch_heading_labels)
    -- deterministic, computed once before any LLM call."""
    indices: set[int] = set()
    for i, branch in enumerate(branches):
        labels = _branch_heading_labels(branch)
        if any(_FRONT_MATTER_HEADING_PATTERN.search(label) for label in labels):
            indices.add(i)
    return indices


def _glossary_context_for_branch(
    branch_index: int, glossary_sections: list[tuple[int, str, str]]
) -> str | None:
    """Every glossary_sections entry EXCEPT the branch's own (a branch
    already sees its own content in full as section_text -- re-inlining
    it into the SAME call's global_context would duplicate it within one
    prompt, risking a duplicate-node result for that one call)."""
    others = [(label, rendered) for i, label, rendered in glossary_sections if i != branch_index]
    if not others:
        return None
    parts = [f'Reference section "{label}":\n{rendered}' for label, rendered in others]
    return (
        "The following short reference section(s) from elsewhere in this "
        "document are inlined in full because every section may need them "
        "(definitions/acronyms/units):\n\n" + "\n\n".join(parts)
    )


def _combine_global_context(
    base: str | None, branch_index: int, glossary_sections: list[tuple[int, str, str]],
    primer_context: str | None = None, front_matter_branch_indices: set[int] | None = None,
) -> str | None:
    extra = _glossary_context_for_branch(branch_index, glossary_sections)
    guard = (
        _FRONT_MATTER_GUARD_TEXT
        if front_matter_branch_indices is not None and branch_index in front_matter_branch_indices
        else None
    )
    parts = [part for part in (base, extra, primer_context, guard) if part]
    return "\n\n".join(parts) if parts else None


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


def _render_block_line(block: Block, figure_id_by_block_id: dict[str, str] | None = None) -> str | None:
    """One block rendered as a markdown-ish line for render_section, or None
    to omit it entirely (a 'none'-caption figure placeholder, or a
    never-actually-emitted TABLE-kind block -- tables live in the separate
    `tables` list render_section merges in by document order).

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
    if parent_summary_client is None:
        return
    parent_ids = [n.local_id for n in det_nodes if n.type in (WorkItemType.EPIC, WorkItemType.FEATURE)]
    # parent_summary_client is the same OrchestratorLlmClient instance
    # already implementing every other Protocol here -- reused as the
    # live per-model token-budget lookup (ModelCapsClient), replacing the
    # flat default with a real derived budget for a model not already in
    # _MODEL_CAPS. _resolve_caps itself fails open to that same flat
    # default on any lookup failure, so this can never raise.
    token_budget = _resolve_caps(model, caps_client=parent_summary_client).coverage_budget_tokens
    _apply_parent_summary_pass(
        det_nodes, parent_ids, parent_summary_client, det_warnings,
        token_budget=token_budget, progress_callback=progress_callback,
    )


def _detect_deterministic_subtrees(
    doc: CanonicalDoc,
    customer_id: str | None,
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
    qualifying_table_rows = [(table, rows_from_table(table)) for table in doc.tables]
    qualifying_table_rows = [(table, rows) for table, rows in qualifying_table_rows if rows]
    heading_rows_preview, _, _ = rows_from_id_headings(doc.blocks)
    if not heading_rows_preview:
        heading_rows_preview, _, _ = rows_from_heading_structure(doc.blocks)
    subtree_count = len(qualifying_table_rows) + (1 if heading_rows_preview else 0)

    def _fire_subtree(label: str) -> None:
        if progress_callback is None:
            return
        progress_callback(
            LevelingProgress(
                phase="deterministic_subtree", branch_index=None, branch_count=0,
                blocks_done=0, blocks_total=0, kb_grounded=False, kb_citations=[],
                subtree_index=subtree_index, subtree_count=subtree_count, subtree_label=label,
            )
        )

    for table, rows in qualifying_table_rows:
        _fire_subtree(f"Table {table.id}")
        nodes, warnings = build_hierarchy_subtree(
            rows, f"det{subtree_index}_", customer_id, title_tag_client, synthesis_client,
            progress_callback=progress_callback, subtree_index=subtree_index,
            subtree_count=subtree_count, subtree_label=f"Table {table.id}",
            # Every row here came from parsing THIS one table (see
            # rows_from_table) -- there is no heading ancestor above it to
            # walk via parent_index alone, so section_path is seeded with
            # the table's own identity as its root segment. Same
            # caption-or-id-fallback convention _build_headingless_tree's
            # own per-table title already uses.
            section_path_root=table.caption or f"Table {table.id}",
        )
        # Every node in this subtree came from THIS one Table -- unlike a
        # heading-derived node, which can fold zero or more Tables into its
        # span (see the span-claiming loop below), a table-row subtree's
        # nodes ARE that table, so table_ids is simply every node pointing
        # back at it, unconditionally.
        for node in nodes:
            node.table_ids = [table.id]
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
            heading_rows, f"det{subtree_index}_", customer_id, title_tag_client, synthesis_client,
            progress_callback=progress_callback, subtree_index=subtree_index,
            subtree_count=subtree_count, subtree_label="Heading hierarchy",
        )
        # See the table-subtree call site's identical comment above.
        _repair_requirement_hierarchy(nodes, f"det{subtree_index}_", build_warnings)
        recompute_child_types(nodes)
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
            i for i, b in enumerate(doc.blocks)
            if b.kind == BlockKind.HEADING and b.heading_level is not None
        ]
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
            # A FIGURE-kind block's raw text is the literal
            # "[FIGURE: {caption or 'none'}]" wire format (see
            # docx_loader.py/pdf_loader.py) -- folding it in unfiltered
            # leaks the bare placeholder string into a deterministic
            # node's description verbatim whenever a figure has no real
            # caption (vision disabled, or genuinely non-informative).
            # `_figure_line` already exists and is already proven correct
            # for exactly this (the LLM-analysis path's `render_section`
            # uses it), it just was never reused here -- None means "no
            # real caption, fold nothing"; a real caption folds in as the
            # same clearly-labeled "> Figure: ..." line the LLM path uses.
            span_text = _figure_line(block) if block.kind == BlockKind.FIGURE else block.text
            # Same known-issues item 20 pairing SURVEY's render_section
            # already relies on -- None whenever this isn't a FIGURE-kind
            # block, or figure_id_by_block_id wasn't supplied at all (an
            # older/未-updated caller), matching pre-figure_ids behavior.
            figure_id = (
                figure_id_by_block_id.get(block.id)
                if block.kind == BlockKind.FIGURE and figure_id_by_block_id is not None
                else None
            )
            if span_text is None:
                # No real caption (vision disabled/failed/judged insignificant --
                # see _figure_line's own docstring) -- the figure still exists
                # in the source though, so it's recorded as uncaptioned on
                # whatever node its span belongs to rather than vanishing
                # with zero trace, same as build_baseline_tree's identical
                # fold-site fix.
                if figure_id is not None:
                    current_target.uncaptioned_figure_ids.append(figure_id)
                continue
            current_target.description = assemble_description(
                current_target.description, span_text,
            )
            current_target.fidelity_hash = _hash_description(current_target.description)
            current_target.identity_hash = _hash_identity(
                current_target.description, current_target.source_ref,
            )
            current_target.source_ref = _widen_page_end(current_target.source_ref, block.source_ref)
            if figure_id is not None:
                current_target.figure_ids.append(figure_id)

        for table in doc.tables:
            if table.id in claimed_table_ids:
                continue
            table_key = _order_key(table.source_ref)
            owning_boundary_idx: int | None = None
            for boundary_idx in heading_boundaries:
                boundary_block = doc.blocks[boundary_idx]
                if boundary_block.id not in block_id_to_row_index:
                    continue
                next_boundaries = [b for b in heading_boundaries if b > boundary_idx]
                upper = (
                    _order_key(doc.blocks[next_boundaries[0]].source_ref)
                    if next_boundaries
                    else None
                )
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
            target.description = assemble_description(target.description, _table_to_html(table))
            target.fidelity_hash = _hash_description(target.description)
            target.identity_hash = _hash_identity(target.description, target.source_ref)
            target.source_ref = _widen_page_end(target.source_ref, table.source_ref)
            target.table_ids.append(table.id)
        del id_disambiguator_needed  # only used to document the branch above; both heading
        # adapters always pass id_disambiguator_needed=False, so span-fold hashing always
        # uses the plain _hash_identity, never the table-row disambiguated variant.

    if not claimed_heading_block_ids and not claimed_table_ids:
        _apply_det_parent_summary(det_nodes, det_warnings, parent_summary_client, model, progress_callback)
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
        f for f in doc.figures
        if (f.source_ref.document_path, f.source_ref.start_offset) not in claimed_figure_offsets
    ]
    llm_doc = doc.model_copy(
        update={"blocks": residual_blocks, "tables": residual_tables, "figures": residual_figures},
    )

    _apply_det_parent_summary(det_nodes, det_warnings, parent_summary_client, model, progress_callback)
    return det_nodes, det_warnings, llm_doc


def build_survey_tree(
    doc: CanonicalDoc,
    analysis_client: SectionAnalysisClient,
    scoring_client: BatchedScoringClient | None = None,
    customer_id: str | None = None,
    criteria_retriever: CriteriaRetriever | None = None,
    user_id: str | None = None,
    embed_client: object | None = None,
    vector_store: KbVectorStore | None = None,
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
    debug_capture: "DebugCapture | None" = None,
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
) -> WorkItemTree:
    """SURVEY-mode leveling entry point. Splits the document into top-level
    branches (_split_into_branches, the same depth-1-heading split
    BASELINE's build_baseline_tree already uses) and processes each branch
    through ONE holistic analyze_section (or analyze_section_agentic) call,
    replacing the old per-branch infer_hierarchy + generate_requirements_for_document
    call pair -- see SectionAnalysisClient's docstring and the redesign plan's
    §1/§2 for why: the old pair mechanically atomized structure (one input
    Block -> exactly one output node), while analyze_section lets the model
    return however many nodes a section actually contains.

    `model` (the per-job model override, same value threaded from main.py's
    /level route) resolves via `_resolve_caps` to this document's branch-size
    cap AND whether the model supports tool-calling (§5c): tool-capable
    models drive KB retrieval AGENTICALLY per-branch via analyze_section_agentic
    (a query_kb tool call during analysis); other models get a single
    pre-computed, once-per-document KB context threaded into every branch's
    plain analyze_section call (the ORIGINAL, pre-agentic KB design, kept as
    the fallback). Splitting the ENTIRE document into one call previously
    risked overflowing the LLM's context window in a single whole-document
    call, producing truncated/malformed JSON that aborted the whole job
    rather than a partial/degraded result.

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

    `user_id`/`embed_client`/`vector_store`, when ALL supplied, ground
    every branch's analysis call, but HOW depends on `_resolve_caps(model)`'s
    tool-calling verdict (§5c): a tool-capable model gets a `retrieve_fn`
    closure (wrapping app.kb.retrieval.retrieve_context) passed into every
    branch's analyze_section_agentic call, which actively pulls KB context
    per its own query_kb tool calls; a non-tool-capable model instead gets
    ONE retrieve_context call made HERE, up front, against
    `_document_level_query_text(doc)` -- the SAME resulting kb_context string
    is threaded into every branch's plain analyze_section call (and into
    score_requirements_for_document). When any of the three KB params is
    omitted, KB retrieval is skipped entirely (kb_context/retrieve_fn stay
    None for every call), matching pre-KB behavior exactly. `kb_citations`
    (deduped by source_file, keeping the highest similarity) is returned once
    on the tree — for the fallback path this is the single document-level
    retrieval's citations; for the agentic path it's the union of every
    branch's own query_kb hits, each marked KbCitationRelevance.RELEVANT
    (the model chose to pull and use them, so relevance verification via
    kb_relevance_client does not apply on this path).

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
                phase="preparing_analysis", branch_index=None, branch_count=0,
                blocks_done=0, blocks_total=0, kb_grounded=False, kb_citations=[],
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
        doc, customer_id, title_tag_client, synthesis_client, parent_summary_client, model,
        progress_callback=progress_callback,
        figure_id_by_block_id=figure_id_by_block_id,
    )

    if llm_doc.blocks == [] and llm_doc.tables == [] and llm_doc.figures == []:
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
                user_id, query_text, embed_client, vector_store,
            )
            doc_kb_citations = _resolve_kb_citations(
                query_text, raw_doc_citations, kb_relevance_client, debug_capture=debug_capture
            )
            doc_kb_context, doc_kb_citations = _merge_always_include_context(
                doc_kb_context, doc_kb_citations, user_id, vector_store,
            )
        deduped_citations = sorted(doc_kb_citations, key=lambda c: c.source_file)

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
                        doc_kb_citations, key=lambda c: c.similarity, reverse=True,
                    )
                    for citation in sorted_citations:
                        checklist = vector_store.get_quality_checklist(
                            user_id, citation.source_file,
                        )
                        if checklist:
                            category_checklist = checklist
                            category_checklist_definitions = vector_store.get_quality_checklist_definitions(
                                user_id, citation.source_file,
                            )
                            break
                _score_all_requirements(
                    requirement_nodes, scoring_client, all_warnings, criteria_retriever,
                    doc_kb_context, doc_kb_citations, progress_callback, model_name,
                    len(det_nodes), 0, category_checklist, category_checklist_definitions,
                )
            _score_epics_and_features(
                all_nodes, scoring_client, all_warnings, progress_callback, model_name,
                len(det_nodes), 0, debug_capture=debug_capture,
            )

        _detect_conflicting_duplicates(
            all_nodes, embed_client, conflict_client, all_warnings,
            progress_callback, len(det_nodes), 0,
        )
        _regroup_disconnected_roots(
            all_nodes, "regroup_", grouping_client, all_warnings,
            progress_callback, len(det_nodes), 0,
        )
        _ensure_root_features_have_epic_parent(all_nodes, "regroup_", all_warnings)
        recompute_child_types(all_nodes)

        trace_links: list[TraceLink] = []
        if link_type_client is not None:
            trace_links = _infer_trace_links_for_nodes(
                all_nodes, link_type_client, link_type_catalog or [], all_warnings,
                progress_callback, len(det_nodes), 0, debug_capture=debug_capture,
            )

        return WorkItemTree(
            nodes=all_nodes, warnings=finalize_warnings(all_warnings),
            kb_citations=deduped_citations, trace_links=trace_links,
        )

    doc = llm_doc  # every remaining read below sees only the residual, non-claimed content

    # figure_id_by_block_id was already built above, BEFORE
    # _detect_deterministic_subtrees ran, over the FULL original document --
    # see that assignment's own comment for why this reorder is safe. Every
    # key any branch below could ever look up (a FIGURE-kind block still
    # present in this RESIDUAL `doc`) is still present in that
    # whole-document map, since residual filtering only ever REMOVES
    # entries, never adds or reorders them.

    # preparing_analysis already fired at function entry, before
    # _detect_deterministic_subtrees ran -- covers the branch splitting/
    # merging and KB retrieval below too, so no second kickoff needed here.
    # analysis_client is the same OrchestratorLlmClient instance already
    # implementing every other Protocol here -- reused as the live caps
    # lookup for a model not already in _MODEL_CAPS, no new client wiring.
    branch_cap, context_budget_tokens, coverage_budget_tokens, supports_tools = _resolve_caps(model, caps_client=analysis_client)

    # §3: whole-document single-call gate. A single long-context call over
    # the WHOLE document is not the "repeated raw-text stuffing across many
    # calls" pattern adversarially-verified research warns against (see this
    # module's docstring for build_survey_tree) -- it's one call, so if the
    # rendered document fits this model's COVERAGE budget (with headroom for
    # KB context/system prompt/output), skip branch-splitting entirely and
    # let the existing single-branch path below (len(branches) <= 1) handle
    # the whole document exactly as it already does for a headingless
    # document. Gated on coverage_budget_tokens, NOT context_budget_tokens --
    # confirmed live that a document comfortably fitting the context window
    # still under-synthesizes in one holistic call (see _ModelCaps.
    # coverage_budget_tokens's own docstring).
    whole_doc_text = render_section(doc.blocks, doc.tables, doc.figures)
    fits_whole_document = _estimate_tokens(whole_doc_text) + _WHOLE_DOC_HEADROOM_TOKENS <= coverage_budget_tokens

    # Real heading count, computed once here (where doc.blocks is already in
    # scope) for the whole-document coverage hint (§3, see
    # _whole_document_hint's docstring) -- confirmed live that a qualitative-
    # only reminder doesn't change model behavior; a concrete floor tied to
    # the document's OWN real structure is a much stronger signal. Counts
    # ALL heading blocks regardless of depth (deliberately not the
    # min(known_depths) heuristic _split_into_branches uses -- that's a
    # split-boundary decision, this is a coverage floor, and over-counting
    # sub-headings only raises the floor, the safe direction for a coverage
    # bug). Only meaningful on the single-branch path (whole_document=True
    # there); the multi-branch loop never uses it.
    heading_count = sum(1 for b in doc.blocks if resolve_block_depth(b)[0] is not None)
    # Confirmed real gap, live-tested: source TABLE rows that are pure group
    # labels (a dotted-ID row with no 'shall' statement, grouping 2+ child
    # rows -- e.g. "1.2.1 Display", "2.2.4 Media Buttons") never contributed
    # to this floor at all -- heading_count only ever looked at
    # BlockKind.HEADING blocks. Folded ADDITIVELY into the same topic_count
    # integer below (one coherent floor number in the prompt, not a second
    # parallel N) -- see table_groups.qualifying_table_groups's own
    # docstring for the detection heuristic and its documented limitations.
    doc_table_groups = qualifying_table_groups(doc.tables)

    global_context: str | None = None
    glossary_sections: list[tuple[int, str, str]] = []
    if fits_whole_document:
        branches: list[list[Block]] = [doc.blocks] if doc.blocks else []
    else:
        branches = _split_into_branches(doc)
        if len(branches) <= 1:
            # Flat/single-section document (no heading structure, or only
            # one top-level section) that still exceeded the coverage gate
            # above -- _split_into_branches has no heading boundary to split
            # on, so without this it would fall through to the single-call
            # path below and hit the exact under-synthesis this redesign
            # fixes. Window-chunk its own blocks into coverage-sized units
            # instead, reusing _merge_branches_by_budget as a token-window
            # chunker (fed one block per "branch" -- it already greedily
            # packs adjacent items up to a token budget, seeded from the
            # first item, so this is a correct, order-preserving chunker
            # with no new primitive needed). This is what makes the fix
            # generalize to headingless documents, not just headed ones.
            flat_blocks = branches[0] if branches else doc.blocks
            branches = _merge_branches_by_budget([[b] for b in flat_blocks], coverage_budget_tokens)
        else:
            # §4: the document's own structural split alone produces one
            # branch PER heading occurrence, however small each section is --
            # greedily merge adjacent branches back together up to this
            # model's COVERAGE budget (not context budget -- see gate above)
            # before ever bounding by block count. See
            # _merge_branches_by_budget's own docstring.
            branches = _merge_branches_by_budget(branches, coverage_budget_tokens)
        # Document-structure-driven splitting alone cannot guarantee a small
        # branch (a real document can have very few, wildly unbalanced
        # top-level sections) -- bound each branch's size directly, regardless
        # of the document's own heading structure. See _bound_branch_size's own
        # docstring for why this is SURVEY-only, not applied to
        # build_baseline_tree's branches.
        branches = [
            bounded_branch for branch in branches for bounded_branch in _bound_branch_size(branch, branch_cap)
        ]
        # §3.3: the document doesn't fit in one call, so every branch's own
        # call would otherwise see ONLY its own fragment -- the exact
        # fragmentation this redesign fixes. A compact outline (headings +
        # per-section synopsis, NOT the raw full text) is threaded into every
        # branch's analyze_section call instead, giving document-wide
        # awareness without repeating the confirmed degrading pattern of
        # re-sending the same raw full document on every one of many calls.
        global_context = _build_document_outline(branches)
        glossary_branch_tables = _partition_tables_by_branch(branches, doc.tables) if branches else []
        glossary_sections = _find_glossary_sections(branches, glossary_branch_tables)
        front_matter_branch_indices = _find_front_matter_branches(branches)

    kb_deps_present = user_id is not None and embed_client is not None and vector_store is not None
    doc_kb_context: str | None = None
    doc_kb_citations: list[KbCitation] = []
    retrieve_fn: Callable[[str], tuple[str | None, list[dict]]] | None = None
    list_documents_fn: Callable[[], list[str]] | None = None
    read_document_fn: Callable[[str], str | None] | None = None
    if kb_deps_present and not supports_tools:
        # Fallback path (§5c): ONE retrieve_context call for the whole
        # document, not one per branch -- the SAME resulting kb_context
        # string grounds every branch's analyze_section + scoring call.
        query_text = _document_level_query_text(doc)
        doc_kb_context, raw_doc_citations = retrieve_context(user_id, query_text, embed_client, vector_store)
        doc_kb_citations = _resolve_kb_citations(
            query_text, raw_doc_citations, kb_relevance_client, debug_capture=debug_capture
        )
        doc_kb_context, doc_kb_citations = _merge_always_include_context(
            doc_kb_context, doc_kb_citations, user_id, vector_store,
        )
    elif kb_deps_present and supports_tools:
        # Agentic path (§5c): the model pulls KB context itself via query_kb
        # during analyze_section_agentic -- retrieve_fn just executes
        # whatever query the model asks for, closing over these three deps
        # so OrchestratorLlmClient/analyze_section_agentic stay KB-agnostic.
        def retrieve_fn(query: str, _uid=user_id, _ec=embed_client, _vs=vector_store) -> tuple[str | None, list[dict]]:
            return retrieve_context(_uid, query, _ec, _vs)

        # §15: same injected-closure convention, offering the model a
        # FULL-document read (KbVectorStore.get_document/list_documents)
        # alongside query_kb's top-k snippets.
        def list_documents_fn(_uid=user_id, _vs=vector_store) -> list[str]:
            return _vs.list_documents(_uid)

        def read_document_fn(source_file: str, _uid=user_id, _vs=vector_store) -> str | None:
            text, truncated = _vs.get_document(_uid, source_file)
            if text is None:
                return None
            if truncated:
                # Honest truncation marker at the tool boundary, same voice
                # as _execute_agentic_tool_call's other sentinels -- without
                # this, the model would silently reason over a partial
                # document and cite it as if complete.
                return text + (
                    "\n\n(document truncated: showing the first "
                    f"{_KB_GET_DOCUMENT_MAX_CHUNKS} chunks; ask a narrower "
                    "query_kb question for the rest)"
                )
            return text

        # Unlike retrieve_context's similarity-gated result (which the
        # agentic path deliberately skips in favor of the model pulling
        # context itself via query_kb), an always-include file's whole
        # point is that its relevance is NOT something the model should
        # have to decide to go looking for -- merged into doc_kb_context
        # here too so it grounds every branch call the same way it does on
        # the fallback path above.
        doc_kb_context, doc_kb_citations = _merge_always_include_context(
            doc_kb_context, doc_kb_citations, user_id, vector_store,
        )

    # §3.3: only built on the compact-outline path (global_context is set) --
    # lets a tool-capable model pull a specific OTHER section's full text on
    # demand, matching the confirmed research finding that agent-directed
    # selective retrieval beats blind full-context stuffing. IDs match the
    # 1-based numbering _build_document_outline uses so the model can refer
    # to "section 3" the same way the outline names it.
    read_other_section_fn: Callable[[str], str | None] | None = None
    if global_context is not None:
        branch_texts_by_id = {str(i + 1): render_section(b, None, None) for i, b in enumerate(branches)}

        def read_other_section_fn(section_id: str, _texts=branch_texts_by_id) -> str | None:
            return _texts.get(section_id)

    # Deterministic nodes first -- they are the source-derived primary
    # structure this document's own author wrote; the LLM-handled residual
    # (below) is appended after. No cheap document-order key exists across
    # the two (LLM nodes share a coarse branch-representative source_ref).
    all_nodes: list[WorkItemNode] = list(det_nodes)
    all_warnings: list[IntegrityWarning] = list(det_warnings)
    all_kb_citations: list[KbCitation] = list(doc_kb_citations)
    # Every branch's own scoring-grounding text (see _BranchAnalysisResult's
    # docstring) -- collected here so the single whole-document scoring pass
    # below (_score_all_requirements) stays grounded exactly as well as the
    # old per-branch design was, instead of losing agentic-path grounding
    # when scoring moved out of the per-branch loop.
    branch_scoring_kb_contexts: list[str] = []
    blocks_total = sum(len(b) for b in branches)
    blocks_done = 0

    # §12 fix: multi-branch table placement. Figures never needed a fix here
    # -- every loader already embeds each Figure's caption directly in an
    # inline FIGURE-kind Block (see render_section's own docstring), which
    # _split_into_branches already carries into whichever branch it belongs
    # to like any other block. Tables are the real gap: they have no inline
    # Block representation at all, so the multi-branch loop below used to
    # never pass `tables=` to any branch, silently dropping every table on a
    # document that goes multi-branch. _partition_tables_by_branch (already
    # used by BASELINE's tree_builder for the identical problem) buckets
    # each table into its real document-order branch by source_ref offset;
    # a table positioned before every branch's first block falls back to
    # the first branch (the same documented approximation BASELINE uses),
    # so every table always lands somewhere -- there is no genuinely
    # "unplaced" case left to warn about.
    branch_tables = _partition_tables_by_branch(branches, doc.tables) if len(branches) > 1 else None

    if len(branches) <= 1:
        # §4: a table-only document (xlsx: doc.blocks=[], doc.tables=[one per
        # sheet]) has no headings at all, so _split_into_branches yields []
        # and this is the single/zero-branch path -- WITHOUT passing tables
        # here, this call would render an empty section (render_section([])
        # == "") and the document would silently produce an empty tree. This
        # is also the single home for ANY single-branch document's tables
        # (not just xlsx) -- a multi-branch document's tables are a separate,
        # not-yet-solved placement question (see §12, unaffected by this fix).
        branch_result = _build_survey_tree_for_branch(
            doc.blocks, analysis_client,
            node_id_prefix="", customer_id=customer_id,
            tables=doc.tables, figures=doc.figures,
            supports_tools=supports_tools, retrieve_fn=retrieve_fn, kb_context=doc_kb_context,
            list_documents_fn=list_documents_fn, read_document_fn=read_document_fn,
            # True precisely when the entire document was analyzed in one
            # pass with no compact outline built (global_context is None) --
            # even a "single branch" can have global_context set if
            # _merge_branches_by_budget collapsed everything back into one
            # branch on the doesn't-fit path (§4), which is NOT the
            # whole-doc-gate's "fits in one call outright" case.
            whole_document=(global_context is None),
            topic_count=heading_count + len(doc_table_groups),
            table_groups=doc_table_groups,
            branch_index=0, branch_count=1, blocks_done_before=0, blocks_total=blocks_total,
            progress_callback=progress_callback,
            figure_id_by_block_id=figure_id_by_block_id,
        )
        branch_tree = branch_result.tree
        all_nodes.extend(branch_tree.nodes)
        all_warnings.extend(branch_tree.warnings)
        all_kb_citations.extend(branch_tree.kb_citations)
        if branch_result.scoring_kb_context:
            branch_scoring_kb_contexts.append(branch_result.scoring_kb_context)
    else:
        # blocks_done_before is precomputed per branch (each branch's own
        # fixed offset into the document, from branch sizes known upfront)
        # rather than a running counter incremented after each branch
        # finishes -- required for concurrent execution below (branches can
        # finish out of order), but computed unconditionally here so the
        # sequential path (branch_concurrency<=1) and concurrent path share
        # the exact same values instead of two divergent implementations.
        blocks_done_before_by_branch = [0] * len(branches)
        running_total = 0
        for i, b in enumerate(branches):
            blocks_done_before_by_branch[i] = running_total
            running_total += len(b)

        # progress_callback is invoked from multiple branches concurrently
        # once branch_concurrency > 1 -- narration events themselves don't
        # need to be strictly ordered (they're informational), but each
        # individual call must complete without interleaving with another
        # (the underlying Redis publish is a single command, but a future
        # multi-step narration write must not tear). A plain
        # threading.Lock has negligible cost here: narration fires far less
        # often than the LLM calls that dominate wall time. No-op (the
        # exact same callable, uncontended) when running sequentially.
        callback_lock = threading.Lock()

        def _fire_progress(progress: LevelingProgress) -> None:
            if progress_callback is None:
                return
            with callback_lock:
                progress_callback(progress)

        def _run_branch(branch_index: int, branch_blocks: list[Block]) -> _BranchAnalysisResult:
            # Per-BRANCH heading count (not the whole-document heading_count
            # above, which only applies on the single-branch/whole-doc path)
            # -- generalizes the confirmed-live "concrete, countable floor
            # beats a qualitative reminder" finding to the multi-branch path,
            # which previously passed no topic_count here at all. See
            # orchestrator_llm_client._branch_topic_hint's own docstring.
            branch_heading_count = sum(1 for b in branch_blocks if resolve_block_depth(b)[0] is not None)
            # Per-branch table-group floor -- mirrors branch_heading_count's
            # own per-branch scoping directly above. A single Table's rows
            # are never split across branches (branch_tables buckets whole
            # tables by source_ref, see _partition_tables_by_branch), so
            # this only ever sees the table(s) actually routed to THIS
            # branch, never another branch's groups.
            branch_table_groups = qualifying_table_groups(
                branch_tables[branch_index] if branch_tables is not None else None
            )
            return _build_survey_tree_for_branch(
                branch_blocks, analysis_client,
                node_id_prefix=f"br{branch_index}_", customer_id=customer_id,
                tables=branch_tables[branch_index] if branch_tables is not None else None,
                supports_tools=supports_tools, retrieve_fn=retrieve_fn, kb_context=doc_kb_context,
                list_documents_fn=list_documents_fn, read_document_fn=read_document_fn,
                global_context=_combine_global_context(
                    global_context, branch_index, glossary_sections, primer_context, front_matter_branch_indices,
                ),
                read_other_section_fn=read_other_section_fn,
                topic_count=branch_heading_count + len(branch_table_groups),
                table_groups=branch_table_groups,
                branch_index=branch_index, branch_count=len(branches),
                blocks_done_before=blocks_done_before_by_branch[branch_index],
                blocks_total=blocks_total, progress_callback=_fire_progress,
                figure_id_by_block_id=figure_id_by_block_id,
            )

        if branch_concurrency <= 1:
            # Byte-identical to this loop's pre-concurrency form: one
            # branch at a time, in document order. No ThreadPoolExecutor
            # involved at all -- zero new risk for every deployment that
            # hasn't opted into concurrency.
            branch_results: list[_BranchAnalysisResult] = [
                _run_branch(i, branch_blocks) for i, branch_blocks in enumerate(branches)
            ]
        else:
            # Submission order doesn't determine completion order -- results
            # are collected by INDEX below, not by whichever finishes first,
            # so the final node list is assembled in the same document order
            # a sequential run would produce regardless of which branch's
            # LLM call happens to come back first.
            with ThreadPoolExecutor(max_workers=branch_concurrency) as executor:
                futures = [executor.submit(_run_branch, i, branch_blocks) for i, branch_blocks in enumerate(branches)]
                branch_results = [future.result() for future in futures]

        for branch_result in branch_results:
            branch_tree = branch_result.tree
            all_nodes.extend(branch_tree.nodes)
            all_warnings.extend(branch_tree.warnings)
            all_kb_citations.extend(branch_tree.kb_citations)
            if branch_result.scoring_kb_context:
                branch_scoring_kb_contexts.append(branch_result.scoring_kb_context)
        blocks_done = running_total

    # kb_citations deduped across branches by source_file, keeping the
    # highest-similarity hit -- on the fallback path every branch shares the
    # SAME doc-level citations (harmless duplication, deduped here); on the
    # agentic path each branch can genuinely surface different source files.
    best_by_file: dict[str, KbCitation] = {}
    for citation in all_kb_citations:
        existing = best_by_file.get(citation.source_file)
        if existing is None or citation.similarity > existing.similarity:
            best_by_file[citation.source_file] = citation
    deduped_citations = [best_by_file[name] for name in sorted(best_by_file)]

    # §2c: quality scoring moved to whole-document scope, out of the
    # per-branch loop above -- one (or a handful, chunked) batched call over
    # every Requirement-type node across the ENTIRE document instead of one
    # extra LLM call per branch. Deduping every branch's own real grounding
    # text (agentic path) or reusing the single fallback-path doc_kb_context
    # preserves the exact same grounding correctness the old per-branch
    # design had -- see _BranchAnalysisResult's docstring.
    if scoring_client is not None:
        model_name = getattr(analysis_client, "model", None)
        requirement_nodes = [node for node in all_nodes if node.type == WorkItemType.REQUIREMENT]
        if requirement_nodes:
            combined_kb_context = "\n\n".join(dict.fromkeys(branch_scoring_kb_contexts)) or None
            # Cross-run scoring determinism (user-reported requirement: the
            # SAME document run any number of times must yield the SAME
            # categoryScores keys) -- reads the FIXED checklist extracted
            # ONCE at KB ingestion time (see KbVectorStore.
            # get_quality_checklist) for whichever grounding document is the
            # most relevant (highest similarity), instead of ever asking the
            # scoring LLM to derive categories live. `None` (vector_store/
            # user_id unavailable, or no grounding document has a stored
            # checklist -- either never extracted, or genuinely found none)
            # falls back to score_requirements_for_document's own live-derive/
            # fixed-5-dimension behavior, unchanged.
            category_checklist: list[str] | None = None
            # Companion to category_checklist -- see the deterministic-
            # hierarchy path's own identical comment further up this file
            # for why this is fetched for the SAME winning citation, never
            # a different one.
            category_checklist_definitions: dict[str, str] | None = None
            if vector_store is not None and user_id is not None:
                for citation in sorted(deduped_citations, key=lambda c: c.similarity, reverse=True):
                    checklist = vector_store.get_quality_checklist(user_id, citation.source_file)
                    if checklist:
                        category_checklist = checklist
                        category_checklist_definitions = vector_store.get_quality_checklist_definitions(
                            user_id, citation.source_file,
                        )
                        break
            _score_all_requirements(
                requirement_nodes, scoring_client, all_warnings, criteria_retriever,
                combined_kb_context, deduped_citations, progress_callback, model_name, blocks_total,
                len(branches), category_checklist, category_checklist_definitions,
            )
        # Separate rubric/prompt from Requirement scoring above -- see
        # OrchestratorLlmClient.score_epics_and_features_for_document's own
        # docstring. Runs regardless of whether the document had any
        # Requirement nodes at all (an Epic/Feature-only tree still gets
        # reviewed) -- its own internal empty-list guard is a no-op when
        # there's nothing of that type either.
        _score_epics_and_features(
            all_nodes, scoring_client, all_warnings, progress_callback, model_name, blocks_total, len(branches),
            debug_capture=debug_capture,
        )

    _detect_conflicting_duplicates(
        all_nodes, embed_client, conflict_client, all_warnings,
        progress_callback, blocks_total, len(branches),
    )
    _regroup_disconnected_roots(
        all_nodes, "regroup_", grouping_client, all_warnings,
        progress_callback, blocks_total, len(branches),
    )
    _ensure_root_features_have_epic_parent(all_nodes, "regroup_", all_warnings)
    recompute_child_types(all_nodes)

    trace_links: list[TraceLink] = []
    if link_type_client is not None:
        trace_links = _infer_trace_links_for_nodes(
            all_nodes, link_type_client, link_type_catalog or [], all_warnings,
            progress_callback, blocks_total, len(branches), debug_capture=debug_capture,
        )

    return WorkItemTree(
        nodes=all_nodes, warnings=finalize_warnings(all_warnings),
        kb_citations=deduped_citations, trace_links=trace_links,
    )




class _BranchAnalysisResult(NamedTuple):
    """Internal (build_survey_tree <-> _build_survey_tree_for_branch) carrier
    -- not part of the module's external WorkItemTree contract. `tree` is
    this branch's normal result; `scoring_kb_context` is the SAME grounding
    text this branch would have scored against under the old per-branch
    design (None on the fallback path unless doc_kb_context was set, or the
    real assembled query_kb hit text on the agentic path) -- now surfaced so
    build_survey_tree can aggregate every branch's real grounding text into
    ONE whole-document scoring call (see _score_all_requirements) instead of
    losing per-branch agentic grounding entirely."""

    tree: WorkItemTree
    scoring_kb_context: str | None


def _build_survey_tree_for_branch(
    blocks: list[Block],
    analysis_client: SectionAnalysisClient,
    node_id_prefix: str,
    customer_id: str | None = None,
    tables: list[Table] | None = None,
    figures: list[Figure] | None = None,
    supports_tools: bool = False,
    retrieve_fn: Callable[[str], tuple[str | None, list[dict]]] | None = None,
    list_documents_fn: Callable[[], list[str]] | None = None,
    read_document_fn: Callable[[str], str | None] | None = None,
    kb_context: str | None = None,
    global_context: str | None = None,
    read_other_section_fn: Callable[[str], str | None] | None = None,
    whole_document: bool = False,
    topic_count: int | None = None,
    # Full TableGroupInfo objects (label + child_count + id_text) for THIS
    # branch's own qualifying table groups -- used two ways below: reduced
    # to bare labels and forwarded to the analysis client for the
    # generation-time hint, and kept in full for the post-hoc coverage-check
    # warning after nodes are built (see qualifying_table_groups's own
    # docstring for the detection heuristic).
    table_groups: list[TableGroupInfo] | None = None,
    branch_index: int = 0,
    branch_count: int = 1,
    blocks_done_before: int = 0,
    blocks_total: int = 0,
    progress_callback: ProgressCallback | None = None,
    # known-issues item 20: whole-document block.id -> Figure.id map (see
    # build_survey_tree, built once over the residual doc.blocks/doc.figures)
    # -- threaded into render_section so this branch's own figure lines
    # carry real ids the model can name in a node's figure_ids. None is
    # byte-identical to before this param existed (id-less figure lines).
    figure_id_by_block_id: dict[str, str] | None = None,
) -> WorkItemTree:
    """Does the actual per-branch (or, for a single-branch document, whole-
    document) SURVEY leveling via ONE holistic analyze_section /
    analyze_section_agentic call (see SectionAnalysisClient's docstring),
    replacing the old infer_hierarchy + generate_requirements_for_document
    pair -- the model returns the COMPLETE node set it decides this section
    contains, not one node per input Block. Title comes from the model's own
    'title' field on each node (a short, distinct label -- see
    _SECTION_ANALYSIS_SYSTEM_PROMPT), clamped to 256 chars via
    extract_baseline_title; a model response that omits it (schema
    non-compliance) falls back to extract_baseline_title(text) instead, same
    as before this capability existed, with a warning noting the fallback.
    fidelity_hash is computed over the description, since that's the
    content actually written to ADO and the idempotency map's key must match
    what a re-run would produce — but note this is a WEAKER guarantee than
    BASELINE's verbatim-source-span hash: temperature=0 is
    mostly-but-not-guaranteed deterministic, so a model or prompt change can
    shift this hash and produce a duplicate create on re-run. Embedding dedup
    partially backstops this; it is not a substitute.

    `node_id_prefix`: "" for a single-branch document (byte-identical
    node_ids to pre-chunking behavior); "br{N}_" for one of several
    branches in a multi-branch document. Applied to both a node's own
    local_id and its parent_local_id (never to the model-facing temp_id used
    in the analyze_section call itself — the model only ever sees this
    branch's own local temp_ids).

    **Accepted trade-off, not a silent regression:** with the old 1:1
    block<->node mapping gone, `source_ref` and `grounding_score` both
    coarsen -- every node in a branch shares the branch's representative
    source_ref (first block's, or first table's/figure's for a blocks-empty
    branch), and grounding is measured against the WHOLE rendered section
    text rather than one source block. This is an inherent consequence of
    holistic synthesis: the model can merge N input blocks into M != N
    nodes, so no exact per-node source span exists any more. True
    document-order per-node source spans are out of scope here (loader
    body-walk ordering is a separate follow-up).

    `supports_tools`/`retrieve_fn`/`kb_context` (§5c's capability gate):
    when `supports_tools` is True and `retrieve_fn` is supplied, this branch
    is analyzed via analyze_section_agentic (the model pulls KB context
    itself via query_kb); otherwise via plain analyze_section using the
    pre-computed `kb_context` (None when KB isn't configured at all).

    `global_context` (§3.3): a COMPACT document outline (headings + a short
    per-section synopsis, NOT the raw full document) prepended to this
    branch's own section text -- only populated when the whole document
    didn't fit in one call (build_survey_tree's whole-doc gate), giving every
    branch document-wide awareness without repeating the confirmed
    degrading pattern of re-sending the same raw full text on every one of
    many separate calls. `read_other_section_fn`, when supplied (tool-capable
    models only), additionally lets the model pull a specific OTHER section's
    full text on demand if the outline alone isn't enough.

    `whole_document` (True only when build_survey_tree's whole-doc gate found
    the ENTIRE document fits in one call -- i.e. global_context is None and
    this is the single branch) appends a coverage hint to the analysis
    prompt: applied once to hundreds of blocks instead of many times (once
    per branch/heading, the pre-whole-doc-gate design), the base prompt's
    synthesis-maximizing instructions otherwise drive over-consolidation --
    observed live: 82 nodes (old per-branch) vs 12-25 (new single-call,
    varying by run) for the same 679-block document. `topic_count` (the
    document's real heading count, see build_survey_tree) makes that hint
    quantitative -- confirmed live across 3 separate real runs that a
    qualitative-only hint does not change model behavior (node count stayed
    floored at 12-16 with no coverage improvement); see
    orchestrator_llm_client._whole_document_hint's own docstring."""
    section_text = render_section(blocks, tables, figures, figure_id_by_block_id)
    if global_context:
        section_text = f"{global_context}\n\n---\n\n{section_text}"
    section_label = _derive_section_label(blocks, tables, figures)

    # getattr, not a Protocol member: SectionAnalysisClient only declares the
    # analyze_section*/scoring methods (structural typing), and several test
    # doubles implement it without a `model` attribute at all -- defensive
    # lookup keeps this a pure narration enhancement with zero behavior
    # change for any caller that doesn't have one.
    model_name = getattr(analysis_client, "model", None)

    def _fire(
        phase: Phase,
        kb_grounded: bool,
        kb_citations_raw: list[dict],
        draft_count: int | None = None,
        issues_found: int | None = None,
        section_nodes: list[dict] | None = None,
    ) -> None:
        if progress_callback is None:
            return
        progress_callback(
            LevelingProgress(
                phase=phase, branch_index=branch_index, branch_count=branch_count,
                blocks_done=blocks_done_before, blocks_total=blocks_total,
                kb_grounded=kb_grounded, kb_citations=kb_citations_raw,
                section_label=section_label, model=model_name,
                draft_count=draft_count, issues_found=issues_found,
                section_nodes=section_nodes,
            )
        )

    # Scoring (_apply_quality_scores, below) needs an actual kb_context
    # STRING, not just kb_citations metadata -- on the agentic path the
    # outer `kb_context` parameter stays None (only the fallback path
    # populates it upfront), so without this, scoring ran completely
    # ungrounded even when the model successfully pulled real KB content
    # during analysis. `raw_hits` already carries each hit's full retrieved
    # text (see _execute_agentic_tool_call's `citations.extend(hits)`,
    # where `hits` comes straight from retrieve_context) -- this was already
    # in hand, just never assembled into a context string and threaded to
    # scoring. Defaults to the outer `kb_context` param (fallback path, or
    # None when no query_kb calls happened / no KB deps at all).
    scoring_kb_context = kb_context
    # (label, suggested_type) pairs cross into the client -- child_count/
    # id_text are this function's own bookkeeping for the coverage-check
    # warning below, the client only needs to know what to name AND what
    # type to use for its prompt hint (see qualifying_table_groups's own
    # docstring for how suggested_type is determined).
    table_group_hints = (
        [(g.label, g.suggested_type) for g in table_groups] if table_groups else None
    )
    # Count of this branch's own independent top-level table groups (no
    # common ancestor in the table's ID hierarchy) -- e.g. "Television
    # Receiver" and "Remote Control" each their own root Epic. Confirmed
    # live: both were already individually named in table_group_hints, yet
    # the model still invented a single wrapping root, because the base
    # prompt's hardcoded "at most ONE null-parent node" rule left no room
    # for a real multi-root document. `None` (fewer than 2 top-level
    # groups, or no qualifying groups at all) preserves today's exact
    # single-root prompt wording -- see
    # orchestrator_llm_client._root_count_clause's own docstring.
    top_level_group_count = sum(1 for g in (table_groups or []) if g.is_top_level)
    expected_root_count = top_level_group_count if top_level_group_count >= 2 else None
    if supports_tools and retrieve_fn is not None:
        _fire("analyze_section", kb_grounded=False, kb_citations_raw=[])
        raw_nodes, raw_hits, truncated = analysis_client.analyze_section_agentic(
            section_text, retrieve_fn, list_documents_fn=list_documents_fn, read_document_fn=read_document_fn,
            read_other_section_fn=read_other_section_fn, whole_document=whole_document, topic_count=topic_count,
            table_group_hints=table_group_hints, expected_root_count=expected_root_count,
        )
        # The model chose to pull and use these snippets itself, so relevance
        # verification (kb_relevance_client) doesn't apply on this path --
        # mark every hit RELEVANT outright (see build_survey_tree's docstring).
        #
        # Deduped by source_file, keeping the highest-similarity hit -- a
        # real query_kb call can legitimately pull several DIFFERENT chunks
        # from the SAME file across separate tool rounds (confirmed live:
        # 4 query_kb calls, 2 hits from the same file), but this citation
        # list is a "which files backed this" UI signal (ProgressBanner's
        # "Grounded against" chips, NodeDetailPanel's "Sources"), not a
        # per-chunk log -- showing the identical file twice there is pure
        # noise, not two distinct pieces of grounding. Same best-per-file
        # convention retrieval.py's own best_by_file already uses; NOT the
        # same dedup as unique_texts below, which is by exact TEXT (for the
        # scoring PROMPT's content, a different concern from this list).
        best_citation_by_file: dict[str, KbCitation] = {}
        for hit in raw_hits:
            existing = best_citation_by_file.get(hit["source_file"])
            if existing is None or hit["similarity"] > existing.similarity:
                best_citation_by_file[hit["source_file"]] = KbCitation(
                    source_file=hit["source_file"], similarity=hit["similarity"], relevance=KbCitationRelevance.RELEVANT
                )
        kb_citations = list(best_citation_by_file.values())
        # Dedup by exact text (not by source_file -- a real query_kb call
        # can legitimately pull several DIFFERENT chunks from the same
        # file) so a model re-issuing an identical query across tool rounds
        # doesn't repeat the same chunk in the scoring prompt.
        seen_texts: set[str] = set()
        unique_texts = []
        for hit in raw_hits:
            hit_text = hit.get("text", "")
            if hit_text and hit_text not in seen_texts:
                seen_texts.add(hit_text)
                unique_texts.append(hit_text)
        scoring_kb_context = "\n\n".join(unique_texts) if unique_texts else None
    else:
        kb_citations_raw_dicts = (
            [{"source_file": "(document-level)", "similarity": 1.0}] if kb_context else []
        )
        _fire("analyze_section", kb_grounded=bool(kb_context), kb_citations_raw=kb_citations_raw_dicts)
        raw_nodes, truncated = analysis_client.analyze_section(
            section_text, kb_context=kb_context, whole_document=whole_document,
            topic_count=topic_count, table_group_hints=table_group_hints,
            expected_root_count=expected_root_count,
        )
        kb_citations = []  # doc-level citations are collected once in build_survey_tree, not per-branch

    by_temp_id = {n["temp_id"]: n for n in raw_nodes if isinstance(n, dict) and n.get("temp_id")}
    valid_tag_values = {t.value for t in RequirementTag}
    warnings: list[IntegrityWarning] = []
    if truncated:
        warnings.append(
            IntegrityWarning.make(
                WarningKind.OUTPUT_TRUNCATED,
                "Model output was truncated by the token limit -- results may be incomplete; "
                "consider raising the model's output cap.",
                detail={"branch": node_id_prefix or "(root)"},
            )
        )
    nodes: list[WorkItemNode] = []

    representative_source_ref = (
        blocks[0].source_ref if blocks else (tables[0].source_ref if tables else (figures[0].source_ref if figures else None))
    )
    if representative_source_ref is not None:
        # section_label (computed above, right next to where this ref is
        # built) is this branch's own heading/excerpt label -- see
        # _derive_section_label's own docstring. A single-element path, not
        # a full ancestor chain: SURVEY branches are split at the
        # document's shallowest heading depth only (_split_into_branches),
        # so there is no multi-level ancestry available here the way
        # BASELINE's stack-walk or the deterministic path's parent_index
        # walk have -- this is the coarser, section-level granularity every
        # node in this branch already shares (see representative_source_ref
        # itself). `.model_copy(...)`, never an in-place mutation -- same
        # reasoning as every other section_path call site in this codebase
        # (pydantic v2 doesn't copy a nested BaseModel on assignment, so
        # mutating this copy in place would corrupt the ORIGINAL block's/
        # table's/figure's own source_ref too).
        representative_source_ref = representative_source_ref.model_copy(
            update={"section_path": [section_label] if section_label else []}
        )

    # known-issues item 20: the real candidate ids THIS branch's own
    # rendered section_text actually offered the model (see render_section's
    # figure/table id injection) -- a model-returned figure_ids/table_ids
    # entry outside this set is a hallucination (an id that doesn't exist,
    # or belongs to a DIFFERENT branch/section the model never saw) and is
    # dropped, never trusted verbatim. valid_table_ids comes straight from
    # this branch's own `tables` param; valid_figure_ids is derived from
    # this branch's own `blocks` via the whole-document figure_id_by_block_id
    # map (branch-scoped implicitly, since only this branch's own FIGURE-kind
    # blocks are in `blocks`) -- restricted to CAPTIONED figures only
    # (`_figure_line(b) is not None`): an uncaptioned figure's id is never
    # rendered into section_text at all (_render_block_line returns None for
    # it, so its id-injection branch never runs -- see that function's own
    # docstring), and is attributed separately, POSITIONALLY, into
    # uncaptioned_figure_ids below. Excluding it here keeps figure_ids and
    # uncaptioned_figure_ids provably disjoint regardless of what the model
    # returns (e.g. a hallucinated id that happens to collide with a real
    # uncaptioned figure's id), not just in the common case where the model
    # never sees the id to begin with.
    valid_table_ids = {t.id for t in (tables or [])}
    valid_figure_ids = {
        figure_id_by_block_id[b.id]
        for b in blocks
        if figure_id_by_block_id is not None
        and b.kind == BlockKind.FIGURE
        and b.id in figure_id_by_block_id
        and _figure_line(b) is not None
    }
    tables_by_id = {t.id: t for t in (tables or [])}

    for temp_id, entry in by_temp_id.items():
        text = entry.get("text")
        if not text:
            continue
        raw_title = entry.get("title")
        if raw_title:
            title = extract_baseline_title(raw_title)
        else:
            # Tolerant of LLM non-compliance: the schema marks 'title'
            # required, but a model can still omit it -- degrade to the
            # pre-title-distillation behavior (derive from the full
            # description text) rather than crashing the branch.
            message = f"An item near {_truncate_for_preview(text)} had no model title -- derived from its description text."
            logger.warning(message)
            warnings.append(
                IntegrityWarning.make(WarningKind.NO_MODEL_TITLE, message, node_ids=[f"{node_id_prefix}{temp_id}"])
            )
            title = extract_baseline_title(text)
        tags = sorted(
            {RequirementTag(tag) for tag in entry.get("tags", []) if tag in valid_tag_values},
            key=lambda t: t.value,
        )
        raw_figure_ids = entry.get("figure_ids") or []
        figure_ids = sorted({fid for fid in raw_figure_ids if isinstance(fid, str) and fid in valid_figure_ids})
        if len(figure_ids) < len(raw_figure_ids):
            dropped_figure_count = len(raw_figure_ids) - len(figure_ids)
            message = (
                f'"{title}" referenced {dropped_figure_count} figure(s) not offered in this section -- '
                "the invalid reference(s) were dropped."
            )
            logger.warning(message)
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.INVALID_FIGURE_IDS,
                    message,
                    node_ids=[f"{node_id_prefix}{temp_id}"],
                    detail={"requested": raw_figure_ids, "kept": figure_ids},
                )
            )
        raw_table_ids = entry.get("table_ids") or []
        table_ids = sorted({tid for tid in raw_table_ids if isinstance(tid, str) and tid in valid_table_ids})
        if len(table_ids) < len(raw_table_ids):
            dropped_table_count = len(raw_table_ids) - len(table_ids)
            message = (
                f'"{title}" referenced {dropped_table_count} table(s) not offered in this section -- '
                "the invalid reference(s) were dropped."
            )
            logger.warning(message)
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.INVALID_TABLE_IDS,
                    message,
                    node_ids=[f"{node_id_prefix}{temp_id}"],
                    detail={"requested": raw_table_ids, "kept": table_ids},
                )
            )

        # Embeds each named table's real HTML into the description (§ known
        # issues item 20, "the easy half" -- tables need no new ADO write
        # capability, unlike figures, see WorkItemNode.table_ids' own
        # docstring). Same assemble_description join-with-newline convention
        # BASELINE's own table fold-in uses (tree_builder.py) -- the
        # orchestrator's toAdoDescriptionHtml already has a TABLE_BLOCK_PATTERN
        # carve-out that passes this exact `<table>...</table>` shape through
        # untouched to ADO.
        description = text
        for table_id in table_ids:
            table = tables_by_id.get(table_id)
            if table is None:
                continue
            table_html = _table_to_html(table)
            if table_html:
                description = assemble_description(description, table_html)
        try:
            node_type = WorkItemType(entry.get("type"))
        except ValueError:
            # Tolerant of LLM non-compliance: the prompt explicitly lists "one
            # of: Epic, Feature, Requirement", but a model can still
            # hallucinate an out-of-vocabulary type (observed live:
            # gemma4:e4b returned "Recommendation"). Falling back to
            # Requirement -- the safest default, since it never implies a
            # parent/child expectation the way Epic/Feature do.
            message = (
                f'"{title}" had an invalid type ({entry.get("type")!r}) from section analysis -- '
                "defaulted to Requirement."
            )
            logger.warning(message)
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.INVALID_NODE_TYPE,
                    message,
                    node_ids=[f"{node_id_prefix}{temp_id}"],
                    detail={"rawType": entry.get("type")},
                )
            )
            node_type = WorkItemType.REQUIREMENT

        parent_temp_id = entry.get("parent_temp_id")
        if parent_temp_id is not None and parent_temp_id not in by_temp_id:
            message = f'"{title}" referenced a parent that could not be resolved -- attached as a root of this section instead.'
            logger.warning(message)
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.DANGLING_PARENT,
                    message,
                    node_ids=[f"{node_id_prefix}{temp_id}"],
                    detail={"unresolvedParentTempId": parent_temp_id},
                )
            )
            parent_temp_id = None

        grounding_score = _grounding_score(text, section_text)
        if grounding_score < _LOW_GROUNDING_THRESHOLD:
            message = (
                f'"{title}"\'s generated description has low grounding '
                f"({grounding_score:.0%} of its vocabulary traces back to the source section) -- "
                "worth reviewing for possible fabrication."
            )
            logger.warning(message)
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.LOW_GROUNDING,
                    message,
                    node_ids=[f"{node_id_prefix}{temp_id}"],
                    detail={"groundingScore": grounding_score, "threshold": _LOW_GROUNDING_THRESHOLD},
                )
            )

        local_id = f"{node_id_prefix}{temp_id}"
        nodes.append(
            WorkItemNode(
                local_id=local_id,
                type=node_type,
                parent_local_id=f"{node_id_prefix}{parent_temp_id}" if parent_temp_id is not None else None,
                title=title,
                description=description,
                customer_id=customer_id,
                source_ref=representative_source_ref,
                # Hashes the FINAL description (text plus any embedded table
                # HTML), not just `text` -- fidelity_hash exists to detect
                # drift in the actual persisted field; hashing `text` alone
                # would never notice a change to the embedded table half.
                fidelity_hash=hashlib.sha256(description.encode()).hexdigest(),
                # Confirmed real bug (live, via golden-e2e's BASELINE re-run
                # assertion, which surfaced the same class of issue this
                # SURVEY path has too): plain _hash_identity(text, ...) hashed
                # the LLM-GENERATED `text` -- unstable run-to-run wording for
                # the SAME semantic content -- combined with
                # representative_source_ref, which every node in THIS
                # section shares (analyze_section has no per-node source
                # attribution, only a whole-section one). Re-keyed on
                # local_id instead: still deterministic given the SAME
                # section producing the SAME node count/order, and no longer
                # poisoned by wording drift. Residual, known limitation: if
                # the model's OWN node count/ordering for a section varies
                # between runs (not just wording), local_id-based identity
                # can't fully paper over that -- fixing it for real needs
                # per-node source offsets from the model, a bigger schema/
                # prompt change tracked separately, not this hash function.
                identity_hash=_hash_identity_for_synthesized_node(local_id, representative_source_ref),
                tags=tags,
                figure_ids=figure_ids,
                table_ids=table_ids,
                mode=WorkItemMode.SURVEY,
                grounding_score=grounding_score,
            )
        )

    # known-issues item 20 extension: an UNCAPTIONED figure's id is never
    # rendered into section_text at all (_render_block_line returns None
    # for it -- see that function's own docstring), so the model never sees
    # it and can never name it in a node's own figure_ids the way a
    # captioned figure can. Unlike BASELINE/the deterministic path, which
    # walk blocks sequentially and always have a real currently-"open" node
    # to attach an uncaptioned figure to, SURVEY nodes carry no individual
    # per-node source position at all (see representative_source_ref's own
    # trade-off comment above -- every node in this branch shares ONE
    # coarse, section-level source_ref). With no true per-node offset to
    # bracket against, the best available deterministic proxy is `nodes`'
    # own list order: by_temp_id preserves the model's own raw_nodes
    # response order, which in practice tracks the section's top-to-bottom
    # structure closely enough to stand in for real document order. Each
    # uncaptioned figure's own block-order position (within this branch's
    # `blocks`) is mapped proportionally onto that same node ordering --
    # same "bucket by document-order position" spirit as
    # _partition_tables_by_branch's forward-scan bucketing and
    # _detect_deterministic_subtrees's heading-boundary bracketing, just
    # applied at node-LIST granularity instead of an offset/boundary
    # comparison, since a node-list index is all a SURVEY node actually
    # carries. A branch that produced zero nodes has nowhere to attach one
    # -- silently skipped, consistent with every other content this branch
    # would also be unable to place.
    if nodes:
        for i, block in enumerate(blocks):
            if block.kind != BlockKind.FIGURE or _figure_line(block) is not None:
                continue  # non-figure, or captioned (already handled via the model's own figure_ids)
            figure_id = (figure_id_by_block_id or {}).get(block.id)
            if figure_id is None:
                continue
            bracket_index = min(len(nodes) - 1, i * len(nodes) // len(blocks))
            nodes[bracket_index].uncaptioned_figure_ids.append(figure_id)

    # §CMMI hierarchy repair (task confirmed real bug: the prompt alone is a
    # soft LLM instruction with no backstop -- a model still occasionally
    # emits a Requirement directly under an Epic, chained under another
    # Requirement, or orphaned with no parent at all despite Epic/Feature
    # nodes existing elsewhere in the same branch). Runs AFTER every node in
    # this branch already exists, so it can walk the real parent chain.
    _repair_requirement_hierarchy(nodes, node_id_prefix, warnings)

    # Correct known-wrong ATTACHMENT for a group that otherwise generated
    # correctly (right type, right content, right children) -- see
    # _repair_group_attachment's own docstring for why this runs as a
    # deterministic post-hoc repair instead of more prompt tuning. Runs
    # after _repair_requirement_hierarchy so a node that was JUST re-parented
    # onto a real Feature (type-repair) can still be corrected to the
    # SPECIFIC right Feature/Epic here if the table's own ID hierarchy says
    # otherwise.
    _repair_group_attachment(nodes, table_groups, node_id_prefix, warnings)

    if not nodes and (blocks or tables or figures):
        # A non-empty branch contributing exactly 0 nodes was previously
        # silent (only a debug-level logger.warning inside
        # analyze_section_agentic, never surfaced to the reviewer) -- this
        # is a real, user-visible gap (confirmed real cause of a branch
        # silently missing from the proposed tree entirely, not just a
        # dropped-block coverage note) distinct from the dropped_blocks
        # check below, which assumes at least SOME nodes exist to compare
        # source blocks against.
        section_ref = f'The "{section_label}" section' if section_label else "This section"
        message = (
            f"{section_ref} produced 0 work items from {len(blocks)} block(s)/"
            f"{len(tables or [])} table(s)/{len(figures or [])} figure(s) of real content -- "
            "likely a model or tool-calling failure for this section; nothing from it will "
            "appear in the proposed tree."
        )
        logger.warning(message)
        warnings.append(
            IntegrityWarning.make(
                WarningKind.ZERO_NODES,
                message,
                detail={"branch": node_id_prefix or "(root)", "blockCount": len(blocks), "tableCount": len(tables or []), "figureCount": len(figures or [])},
            )
        )

    # Coverage check: since analyze_section can merge N input blocks into
    # M != N nodes, there is no 1:1 node<->block mapping left to check
    # per-block coverage against -- instead, run each INPUT block's own text
    # against the combined generated node texts as a whole (same helper the
    # old two-call design used for its own "merged, not dropped" signal).
    # Computed once, not per block -- see _block_content_appears_in_generated_output's
    # own docstring for why recomputing this inside the loop was O(blocks * chars).
    combined_words = _significant_words(" ".join(node.description for node in nodes))
    # resolve_block_depth(block)[1] was previously called 2x per block below
    # (once per boolean check in the comprehension) plus again for the
    # preview line -- resolved once per block here instead.
    resolved_block_texts = [resolve_block_depth(block)[1] for block in blocks]
    # A block that references an external artifact (e.g. "ReqID XXXX") gets
    # its own, far more actionable warning below -- reporting it a second
    # time as a generic "dropped block" would double-report the same root
    # cause under two different messages for the same block.
    dropped_blocks = [
        i
        for i, block in enumerate(blocks)
        if not (block.kind == BlockKind.FIGURE and _figure_line(block) is None)
        and not _block_content_appears_in_generated_output(resolved_block_texts[i], combined_words)
        and not _REFERENCED_ATTACHMENT_PATTERN.search(resolved_block_texts[i])
    ]
    if dropped_blocks:
        # A bare index list ("[14, 48, 58, ...]") tells a reviewer nothing --
        # they'd have to go dig up the raw parsed document to judge whether
        # each one is a real lost requirement or benign non-requirement
        # content (a caption, a cross-reference, a blank list item). A short
        # text preview per index lets that judgment happen right in the
        # warning itself.
        previews = "\n".join(
            f"  - {_truncate_for_preview(resolved_block_texts[i])}" for i in dropped_blocks[:10]
        )
        message = (
            f"SURVEY analysis did not reference {len(dropped_blocks)} of {len(blocks)} source "
            "block(s), and their content does not appear (even paraphrased) in any generated node "
            f"-- likely dropped, not merged:\n{previews}"
        )
        logger.warning(message)
        warnings.append(
            IntegrityWarning.make(
                WarningKind.DROPPED_BLOCKS,
                message,
                detail={"branch": node_id_prefix or "(root)", "droppedIndices": dropped_blocks[:10], "totalBlocks": len(blocks)},
            )
        )

    # Table-group coverage check -- the "catch" half of this fix, pairing
    # with the generation-time floor (topic_count + _table_group_hint)
    # threaded in above, which is the "steer" half. Steering can still fail
    # even with a good hint (confirmed live: the floor alone doesn't
    # guarantee every named group gets used) -- this gives a human-visible
    # signal when it does, the same complementary relationship
    # topic_count/_whole_document_hint (steer) and the dropped_blocks check
    # above (catch) already have for paragraph blocks. A missing table
    # group previously produced ZERO warning of any kind (the dropped_blocks
    # check above only ever scans `blocks`, never table rows).
    missing_groups = [
        g for g in (table_groups or []) if not _group_label_became_a_node(g.label, nodes)
    ]
    if missing_groups:
        group_previews = "; ".join(
            f"'{g.label}' (row {g.id_text}, {g.child_count} children)" for g in missing_groups[:10]
        )
        message = (
            f"{len(missing_groups)} source table group(s) with 2+ child items of their own did not "
            "produce a distinctly-titled node in SURVEY analysis (their children may have been "
            f"folded into a broader ancestor instead): {group_previews}"
        )
        logger.warning(message)
        warnings.append(
            IntegrityWarning.make(
                WarningKind.MISSING_TABLE_GROUP_COVERAGE,
                message,
                detail={"branch": node_id_prefix or "(root)", "groupLabels": [g.label for g in missing_groups[:10]]},
            )
        )

    warnings.extend(_referenced_attachment_warnings(section_text, section_label))

    # Quality scoring moved to whole-document scope (see
    # _score_all_requirements, called once from build_survey_tree after
    # every branch has been analyzed) -- this branch's Requirement-type
    # nodes are still unscored (quality_score=None) at this point; scoring
    # runs in a later pass and mutates them in place. See build_survey_tree's
    # docstring for why (fewer, larger scoring calls instead of one per
    # branch -- same token-efficiency motivation as this module's other
    # batching decisions).

    # The real "parsed and formatted response" for this section -- fired
    # once per branch, right after analysis, rather than waiting for the
    # whole job to reach diff_ready before a reviewer can see what THIS
    # section actually produced. quality_score is always None here now
    # (scoring is a later, whole-document pass -- see the comment above) --
    # the frontend patches it in once score_requirements_done fires.
    #
    # kb_grounded/kb_citations_raw use THIS branch's own `kb_citations` (built
    # above from either the agentic path's real query_kb hits, or the
    # fallback path's precomputed doc-level context) -- NOT `bool(kb_context)`.
    # `kb_context` is only ever non-None on the fallback (non-tool-capable
    # model) path; on the agentic path it stays None even when the model DID
    # ground itself via real query_kb calls, which made every agentic-path
    # narration event report "not grounded" regardless of what the model
    # actually did. Confirmed live once a genuinely tool-capable local model
    # (gemma4:12b) started actually taking the agentic path.
    _fire(
        "section_complete",
        kb_grounded=bool(kb_citations),
        kb_citations_raw=[{"source_file": c.source_file, "similarity": c.similarity} for c in kb_citations],
        section_nodes=[
            {"type": node.type.value, "title": node.title, "text": node.description, "quality_score": node.quality_score}
            for node in nodes
        ],
    )

    return _BranchAnalysisResult(
        tree=WorkItemTree(nodes=nodes, warnings=warnings, kb_citations=kb_citations),
        scoring_kb_context=scoring_kb_context,
    )

