from __future__ import annotations

import hashlib
import itertools
import logging
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING, Callable, NamedTuple, Protocol

if TYPE_CHECKING:
    from app.debug_capture import DebugCapture

from app.canonical.model import Block, BlockKind, CanonicalDoc, Figure, SourceRef, Table, plain_text_rows
from app.distillation.description import assemble_description
from app.distillation.title import extract_baseline_title, title_is_low_quality
from app.distillation.survey_title import TitleDistillationClient, distill_survey_title
from app.kb.kb_vector_store import _MAX_DOCUMENT_CHUNKS as _KB_GET_DOCUMENT_MAX_CHUNKS
from app.kb.kb_vector_store import KbVectorStore
from app.kb.retrieval import fetch_always_include_context, retrieve_context
from app.section_analysis_options import DEFAULT_SECTION_ANALYSIS_OPTIONS, SectionAnalysisOptions
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
from app.leveling.heading_outline import HeadingOutlineEntry, entries_for_blocks, heading_outline_entries
from app.leveling.requirement_rows import RequirementRowInfo, qualifying_requirement_rows, repeated_customer_code_in_table
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
    _is_boilerplate_label_text,
    _is_unsupported_content_note,
    _order_key,
    _partition_tables_by_branch,
    _split_into_branches,
    _table_to_html,
    _widen_page_end,
)
from app.leveling.tree_builder import figure_id_by_block_id as _build_figure_id_by_block_id
from app.leveling.tree_builder import figures_by_id
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


# Extracted to grounding.py (Phase 6, NEW-04) so id_tree_builder.py can use
# the SAME Unicode-aware implementation instead of maintaining a second copy
# that already drifted (ASCII-only) -- see that module's own docstring for
# the real bug this closes. Aliased under their original private names so
# every existing call site in this file (11+) needs no change.
from app.leveling.grounding import grounding_score as _grounding_score
from app.leveling.grounding import significant_words as _significant_words

_PREVIEW_LENGTH = 80


def _truncate_for_preview(text: str) -> str:
    """One-line, length-capped rendering of a block's text for the dropped-
    block warning -- collapses embedded newlines (list items, wrapped
    paragraphs) so each preview stays a single readable line."""
    collapsed = " ".join(text.split())
    if len(collapsed) <= _PREVIEW_LENGTH:
        return f'"{collapsed}"' if collapsed else "(empty block)"
    return f'"{collapsed[:_PREVIEW_LENGTH]}…"'


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


# A model dumping a whole sentence into 'customer_id' is not an
# identifier -- real customer codes/section numbers seen in this
# codebase's own fixtures top out well under this (e.g.
# "P-SENSOR-001#" is 13 chars); this is a generous ceiling, not a tight
# format constraint (no format is enforced beyond length -- see
# _validated_skeleton_customer_id's own docstring for why).
_MAX_MODEL_REPORTED_CUSTOMER_ID_LENGTH = 64


def _validated_skeleton_customer_id(
    raw_value: object, node_type: WorkItemType, rendered_section_text: str, local_id: str, title: str
) -> str | None:
    """Stage 1's model-reported 'customer_id' (see section_skeleton_schema),
    validated before being trusted -- never fabricated, same "never invent
    a value with no real basis" rule the rest of this codebase already
    enforces for this field. Rejects, in order (each rejection logged, not
    warned -- the resulting None is already surfaced downstream by
    main.py's own MISSING_SOURCE_REFERENCE exit-pass warning, so a second
    warning here would be redundant noise, not new information):

    1. not a non-empty string once stripped (a model that returns null,
       omits the field, or returns "" -- the normal case for most nodes);
    2. longer than _MAX_MODEL_REPORTED_CUSTOMER_ID_LENGTH (a leaked
       sentence, not an identifier);
    3. node_type is not Requirement -- Customer ID is a per-Requirement,
       document-derived attribute (see WorkItemNode.customer_id's own
       docstring); an Epic/Feature value is silently corrected, matching
       main.py's own established "internal invariant, not a reviewer-
       actionable gap" treatment for exactly this field;
    4. NOT found verbatim in this branch's own rendered_section_text -- the
       honest bar for "never fabricated": deliberately NOT required to
       also match customer_id.py's own regex, since the whole point of
       asking the model (rather than only ever regex-scanning afterward,
       see _author_branch_content's fallback) is that it can correctly
       read a convention that pattern cannot (a dotted "3.2.1-a", a
       "Req. 14", an RTL-numbered id) -- verbatim presence in the actual
       source text is what makes "never fabricated" provable, not the
       shape of the string itself."""
    if not isinstance(raw_value, str):
        return None
    value = raw_value.strip()
    if not value:
        return None
    if len(value) > _MAX_MODEL_REPORTED_CUSTOMER_ID_LENGTH:
        logger.warning(
            "Dropped an implausibly long model-reported customer_id (%d chars) for %r (%r): %r",
            len(value), local_id, title, value,
        )
        return None
    if node_type is not WorkItemType.REQUIREMENT:
        return None
    if value not in rendered_section_text:
        logger.warning(
            "Dropped a model-reported customer_id not found verbatim in this branch's own source "
            "text for %r (%r): %r",
            local_id, title, value,
        )
        return None
    return value


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

    def judge_kb_relevance(
        self, branch_content: str, snippets: list[dict], user_id: str | None = None,
    ) -> dict[str, str]: ...


class SectionAnalysisClient(Protocol):
    """Interface for the holistic SURVEY redesign's per-branch analysis,
    replacing the LlmLevelingClient + BatchedRequirementClient pair above
    (kept, unchanged, for any caller not yet migrated). Given ONE coherent,
    structure-preserving rendering of a whole section (see render_section),
    returns the COMPLETE node set the model decides the section contains --
    however many, not one per input block.

    That work is now split across TWO calls per branch rather than one (see
    _build_survey_skeleton_for_branch / _author_branch_content):

    - STAGE 1, `analyze_section_skeleton` / `analyze_section_skeleton_agentic`
      -- STRUCTURE only: which nodes exist, what type each is, how they nest,
      what each is titled. No requirement text, no tags, no figure/table ids.
    - STAGE 3, `author_content` -- CONTENT only: each node's description and
      tags, authored against the section text AND the already-decided,
      already-repaired, already-regrouped skeleton. This call may not change
      the tree, only fill it in.

    (Stage 2, whole-document figure/table mapping, slots BETWEEN the two --
    it is deliberately NOT part of this Protocol, since it is optional and
    resolved by duck-typing; see FigureTableMappingClient's own docstring.
    Without it, every node's figure_ids/table_ids simply stay empty, their
    WorkItemNode default.)

    `analyze_section`/`analyze_section_agentic` are the pre-split single call
    that did all of the above at once. They are no longer called by this
    module, and are retained on the Protocol only because
    `analyze_section_skeleton_agentic`'s own degraded path falls back through
    the same client -- a caller supplying a client for build_survey_tree must
    still satisfy them.

    The non-agentic methods are the fallback path for models without
    tool-calling support: `kb_context` is a pre-computed once-per-document
    string (see §5c's capability gate in _build_survey_skeleton_for_branch).

    The `_agentic` variants are the tool-capable path: the model actively
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
    whole-doc gate found the document too large for one call). Only STAGE 1
    is agentic: whatever the model pulls there is handed to `author_content`
    as a plain pre-computed kb_context, so both stages end up grounded in the
    same real material for the price of ONE agentic loop rather than two.
    Returns (nodes, citations)."""

    # The pre-split single call. Takes the same SectionAnalysisOptions the
    # skeleton pair does (see app.section_analysis_options) but honors only
    # `whole_document`/`topic_count`/`table_group_hints`/
    # `expected_root_count` -- `requirement_row_hints`/
    # `heading_type_hints` landed with the two-stage split and are ignored
    # here, exactly as they were absent from this signature before the
    # bundle existed. One shared options type rather than a second
    # four-field one: a separate dataclass for two fields would
    # reintroduce the very restatement bundling removes.
    def analyze_section(
        self,
        section_text: str,
        kb_context: str | None = None,
        *,
        options: SectionAnalysisOptions = DEFAULT_SECTION_ANALYSIS_OPTIONS,
        user_id: str | None = None,
    ) -> tuple[list[dict], bool]: ...

    def analyze_section_agentic(
        self,
        section_text: str,
        retrieve_fn: Callable[[str], tuple[str | None, list[dict]]],
        list_documents_fn: Callable[[], list[str]] | None = None,
        read_document_fn: Callable[[str], str | None] | None = None,
        read_other_section_fn: Callable[[str], str | None] | None = None,
        *,
        options: SectionAnalysisOptions = DEFAULT_SECTION_ANALYSIS_OPTIONS,
        user_id: str | None = None,
    ) -> tuple[list[dict], list[dict], bool]: ...

    # STAGE 1 -- structure only. Every prompt-steering hint that shaped
    # analyze_section's own structural decisions now arrives as one
    # SectionAnalysisOptions (see app.section_analysis_options, which
    # documents each field and why bundling them is safe: all six steer a
    # STRUCTURAL decision -- node-count floors, which table groups and
    # requirement rows must each get their own node and with what type,
    # whether a real multi-root document is expected, the document's own
    # relative heading outline -- and every one is consumed only by
    # prompt-suffix assembly plus the response cache key).
    #
    # `section_text`, `kb_context` and the agentic variant's
    # `retrieve_fn`/`list_documents_fn`/`read_document_fn`/
    # `read_other_section_fn` stay standalone: they are the payload, the
    # path-defining pre-computed context, and injected capability closures
    # respectively -- different kinds of input from a prompt hint.
    #
    # Returns skeleton entries {temp_id, type, parent_temp_id, title,
    # customer_id} -- no text, no tags, no figure/table ids; `customer_id`
    # is the one deliberate exception (see section_skeleton_schema's own
    # docstring).
    def analyze_section_skeleton(
        self,
        section_text: str,
        kb_context: str | None = None,
        *,
        options: SectionAnalysisOptions = DEFAULT_SECTION_ANALYSIS_OPTIONS,
        user_id: str | None = None,
    ) -> tuple[list[dict], bool]: ...

    def analyze_section_skeleton_agentic(
        self,
        section_text: str,
        retrieve_fn: Callable[[str], tuple[str | None, list[dict]]],
        list_documents_fn: Callable[[], list[str]] | None = None,
        read_document_fn: Callable[[str], str | None] | None = None,
        read_other_section_fn: Callable[[str], str | None] | None = None,
        *,
        options: SectionAnalysisOptions = DEFAULT_SECTION_ANALYSIS_OPTIONS,
        user_id: str | None = None,
    ) -> tuple[list[dict], list[dict], bool]: ...

    # STAGE 3 -- `skeleton_nodes` maps each node's own local_id to
    # {'type', 'title', 'parent_id'}; returns {local_id: {'description',
    # 'tags'}} plus the same output-truncation signal stage 1 reports. There
    # is no agentic variant deliberately: stage 1 already did the retrieval
    # (see this Protocol's own docstring).
    def author_content(
        self,
        section_text: str,
        skeleton_nodes: dict[str, dict],
        kb_context: str | None = None,
        user_id: str | None = None,
    ) -> tuple[dict[str, dict], bool]: ...


def _resolve_kb_citations(
    outline: str,
    raw_citations: list[dict],
    kb_relevance_client: KbRelevanceClient | None,
    node_id_prefix: str = "",
    debug_capture: "DebugCapture | None" = None,
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


def _unsupported_content_warnings(blocks: list[Block], section_label: str | None) -> list[IntegrityWarning]:
    """One warning per distinct loader diagnostic NOTE block (see
    _is_unsupported_content_note) in this branch, deduped by exact text (so a
    diagnostic repeated verbatim across several blocks in one section doesn't
    spam the warnings list) -- mirrors _referenced_attachment_warnings just
    above. These blocks are already omitted from section_label
    (_derive_section_label) and rendered section text (_render_block_line);
    this converts every drop into a visible, reviewable signal instead of
    letting it silently vanish."""
    seen: dict[str, None] = {}
    for block in blocks:
        if _is_unsupported_content_note(block):
            seen.setdefault(block.text, None)
    section_ref = f'The "{section_label}" section' if section_label else "This section"
    return [
        IntegrityWarning.make(
            WarningKind.UNSUPPORTED_CONTENT_NOTE,
            f"{section_ref} contained a loader diagnostic note ({text!r}) that was stripped "
            "instead of being treated as document content.",
            detail={"section": section_label or "(root)", "text": text},
        )
        for text in seen
    ]


def _ocr_recovered_table_warnings(tables: list[Table] | None, section_label: str | None) -> list[IntegrityWarning]:
    """One warning per table in this branch with 1+ OCR-recovered cell
    (TableCell.ocr_recovered, set by pdf_loader.py's _cell_ocr_recovery) --
    one warning per TABLE, not per cell, same "don't spam the warnings
    list" convention as _unsupported_content_warnings/
    _referenced_attachment_warnings just above. Scans the whole branch's
    table list at once (unlike tree_builder.py's BASELINE counterpart,
    _ocr_recovered_table_warning, which checks one table at a time inline
    at its single table-fold site) because this function is called once
    per branch at the very end of branch analysis, mirroring where
    _unsupported_content_warnings/_referenced_attachment_warnings are
    already called (see this function's own call site)."""
    section_ref = f'The "{section_label}" section' if section_label else "This section"
    out: list[IntegrityWarning] = []
    for table in tables or []:
        recovered_count = sum(1 for row in table.cells for cell in row if cell is not None and cell.ocr_recovered)
        if recovered_count == 0:
            continue
        out.append(
            IntegrityWarning.make(
                WarningKind.OCR_RECOVERED_TABLE_TEXT,
                f"{section_ref} contains a table ({table.id}) with {recovered_count} cell(s) whose text "
                "could not be extracted directly and was recovered via OCR -- please spot-check against "
                "the source document.",
                detail={"section": section_label or "(root)", "tableId": table.id, "recoveredCellCount": recovered_count},
            )
        )
    return out


def _nested_table_dropped_warnings(tables: list[Table] | None, section_label: str | None) -> list[IntegrityWarning]:
    """One warning per table in this branch with 1+ cell whose nested table
    was dropped (TableCell.nested_table_dropped) -- mirrors
    _ocr_recovered_table_warnings exactly (same branch-wide scan, same
    call-site convention, see that function's own docstring for why this
    shape differs from tree_builder.py's single-table BASELINE
    counterpart)."""
    section_ref = f'The "{section_label}" section' if section_label else "This section"
    out: list[IntegrityWarning] = []
    for table in tables or []:
        dropped_count = sum(1 for row in table.cells for cell in row if cell is not None and cell.nested_table_dropped)
        if dropped_count == 0:
            continue
        out.append(
            IntegrityWarning.make(
                WarningKind.NESTED_TABLE_DROPPED,
                f"{section_ref} contains a table ({table.id}) with {dropped_count} cell(s) containing a "
                "nested table whose content was not extracted -- please check the source document manually.",
                detail={"section": section_label or "(root)", "tableId": table.id, "droppedCellCount": dropped_count},
            )
        )
    return out


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
    for block in blocks:
        # A loader diagnostic placeholder (e.g. pdf_loader.py's multi-column
        # false-positive note) must never become the section's own label --
        # see _is_unsupported_content_note's own docstring. Falls through to
        # the next block instead, same fallback cascade as before this check
        # existed.
        if _is_unsupported_content_note(block):
            continue
        # Real live bug this closes, confirmed via a real SURVEY run: a
        # headingless branch whose first remaining block is a FIGURE
        # placeholder ("[FIGURE: none]" or "[FIGURE: <a real caption>]")
        # rendered that literal placeholder text as the section's own
        # label -- visible as "Section 1 of 1: [FIGURE: none] --
        # Analyzing..." in the live progress UI. This is the EXACT same bug
        # class _figure_line's own docstring already names ("the root cause
        # of the '[FIGURE: none]' fake-requirement bug") -- that fix closed
        # the leak into rendered SECTION CONTENT (_render_block_line calls
        # _figure_line), but this label-derivation fallback was never given
        # the parallel check. A figure's own block text is never legitimate
        # label content regardless of whether it has a real caption -- a
        # section label should name what the section is ABOUT (heading or
        # body text), not describe an embedded image.
        if block.kind == BlockKind.FIGURE:
            continue
        # Real live bug this closes (confirmed via cubeadcs_icd.pdf, whole
        # document collapsed to one headingless branch): the first
        # remaining block was a page-1 copyright/footer line, which this
        # fallback then rendered verbatim as the section's own label. See
        # _is_boilerplate_label_text's own docstring for why pdf_loader.py's
        # recurrence-based header/footer stripping doesn't already catch
        # every such line before it reaches here.
        if _is_boilerplate_label_text(block):
            continue
        text = block.text.strip()
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


def _front_matter_guard_for_whole_document(blocks: list[Block]) -> str | None:
    """The same advisory front-matter guard `_combine_global_context` injects
    per-branch, adapted for the SINGLE-call path (build_survey_tree's
    whole-document gate, or a document whose branches collapsed back into
    one). That path previously got no guard at all -- yet a short document
    that fits in one call is just as likely to open with an "Introduction" as
    a long one.

    Why not simply reuse _FRONT_MATTER_GUARD_TEXT here: that text says "THIS
    section's heading matches typical front-matter", which is true of a branch
    but false of a whole document -- one call covering an Introduction AND
    real requirement sections would be told the entire input is front matter,
    risking suppression of the whole document. This variant names the matching
    headings instead and states explicitly that every other section is
    unaffected.

    Deliberately avoids the words 'appendix'/'annex'/'attached' in its own
    prose: this string is prepended to section_text, which
    _referenced_attachment_warnings scans -- an example list containing those
    words would manufacture a spurious EXTERNAL_REFERENCE warning out of the
    guard itself. The document's own matching headings ARE named, which adds
    no new match (they already appear in the rendered section text).

    Returns None when no heading matches -- byte-identical prompt to before
    this guard existed. Purely advisory, exactly like the per-branch guard:
    nothing is ever skipped, merged, or suppressed."""
    labels = [label for label in _branch_heading_labels(blocks) if _FRONT_MATTER_HEADING_PATTERN.search(label)]
    if not labels:
        return None
    named = "; ".join(f'"{label}"' for label in dict.fromkeys(labels))
    return (
        "Some heading(s) in this document match typical front-matter "
        f"(introductory, table-of-contents, revision-history or reference-list "
        f"sections): {named}. Only emit work items for those sections if "
        "genuine testable/actionable content exists in their text -- do not "
        "fabricate an Epic/Feature/Requirement merely to represent such a "
        "section's existence. Every other section of this document is "
        "unaffected by this note."
    )


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
        tables_by_id=tables_by_id, chunk_concurrency=chunk_concurrency, user_id=user_id,
    )


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
            rows, f"det{subtree_index}_", title_tag_client, synthesis_client,
            progress_callback=progress_callback, subtree_index=subtree_index,
            subtree_count=subtree_count, subtree_label=f"Table {table.id}",
            # Every row here came from parsing THIS one table (see
            # rows_from_table) -- there is no heading ancestor above it to
            # walk via parent_index alone, so section_path is seeded with
            # the table's own identity as its root segment. Same
            # caption-or-id-fallback convention _build_headingless_tree's
            # own per-table title already uses.
            section_path_root=table.caption or f"Table {table.id}",
            chunk_concurrency=chunk_concurrency, user_id=user_id,
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
            heading_rows, f"det{subtree_index}_", title_tag_client, synthesis_client,
            progress_callback=progress_callback, subtree_index=subtree_index,
            subtree_count=subtree_count, subtree_label="Heading hierarchy",
            chunk_concurrency=chunk_concurrency, user_id=user_id,
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
                    figure_id_by_block_id.get(block.id) if figure_id_by_block_id is not None else None
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
                current_target.source_ref = _widen_page_end(current_target.source_ref, block.source_ref)
                if figure_id is not None:
                    current_target.figure_ids.append(figure_id)
                continue

            current_target.description = assemble_description(
                current_target.description, block.text,
            )
            current_target.fidelity_hash = _hash_description(current_target.description)
            current_target.identity_hash = _hash_identity(
                current_target.description, current_target.source_ref,
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
            next_boundary_idx = heading_boundaries[k + 1] if k + 1 < len(heading_boundaries) else None
            boundary_upper_by_idx[boundary_idx] = (
                _order_key(doc.blocks[next_boundary_idx].source_ref) if next_boundary_idx is not None else None
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

    if not claimed_heading_block_ids and not claimed_table_ids:
        _apply_det_parent_summary(
            det_nodes, det_warnings, parent_summary_client, model, progress_callback,
            tables_by_id={t.id: t for t in doc.tables}, chunk_concurrency=chunk_concurrency,
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
        f for f in doc.figures
        if (f.source_ref.document_path, f.source_ref.start_offset) not in claimed_figure_offsets
    ]
    llm_doc = doc.model_copy(
        update={"blocks": residual_blocks, "tables": residual_tables, "figures": residual_figures},
    )

    _apply_det_parent_summary(
        det_nodes, det_warnings, parent_summary_client, model, progress_callback,
        tables_by_id={t.id: t for t in doc.tables}, chunk_concurrency=chunk_concurrency,
        user_id=user_id,
    )
    return det_nodes, det_warnings, llm_doc


def build_survey_tree(
    doc: CanonicalDoc,
    analysis_client: SectionAnalysisClient,
    scoring_client: BatchedScoringClient | None = None,
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
    # Optional smart-title fallback (300553) -- stage 1's skeleton title is
    # produced before any content exists, so it can be vague/generic (e.g.
    # "Requirement", "Item"). None (the default) is byte-identical to before
    # this capability existed: a node's stage-1 title stands as-is regardless
    # of how the description that gets authored afterward reads. See
    # _author_branch_content's own use of this for the real quality gate and
    # distill_survey_title for the actual correction call.
    title_distillation_client: TitleDistillationClient | None = None,
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
) -> WorkItemTree:
    """SURVEY-mode leveling entry point. Splits the document into top-level
    branches (_split_into_branches, the same depth-1-heading split
    BASELINE's build_baseline_tree already uses) and processes each branch
    holistically -- the model decides how many nodes a section contains,
    rather than the old per-branch infer_hierarchy +
    generate_requirements_for_document pair mechanically atomizing it (one
    input Block -> exactly one output node); see SectionAnalysisClient's
    docstring and the redesign plan's §1/§2.

    That holistic per-branch work runs as TWO calls, in three ordered stages
    across the whole document:

    1. STRUCTURE, per branch, in parallel up to `branch_concurrency`
       (_build_survey_skeleton_for_branch) -- types, nesting and titles only,
       no requirement text anywhere yet.
    2. Whole-document structural repair, once, over every branch's structure
       at once (_regroup_disconnected_roots /
       _ensure_root_features_have_epic_parent). These used to run at the very
       END of this function, reshaping a tree whose full text had already
       been written against the shape they were about to change.
    3. CONTENT, per branch, same parallelism (_author_branch_content) --
       each node's requirement text and tags, authored against the section
       AND the now-final tree, which this stage may not alter.

    2b. STAGE 2, whole-document figure/table -> EXACT node mapping, once,
        over every branch's figures/tables at once and against the now-final
        node ids (_map_figures_tables_to_nodes) -- batched per branch, with a
        whole-document escalation tier for the items a branch can't place.
        Optional (see FigureTableMappingClient); without it every node's
        figure_ids/table_ids simply stay empty.

    `model` (the per-job model override, same value threaded from main.py's
    /level route) resolves via `_resolve_caps` to this document's branch-size
    cap AND whether the model supports tool-calling (§5c): tool-capable
    models drive KB retrieval AGENTICALLY per-branch via stage 1's
    analyze_section_skeleton_agentic (a query_kb tool call during analysis),
    whose retrieved material then also grounds stage 3; other models get a
    single pre-computed, once-per-document KB context threaded into every
    branch's plain skeleton call (the ORIGINAL, pre-agentic KB design, kept
    as the fallback). Splitting the ENTIRE document into one call previously
    risked overflowing the LLM's context window in a single whole-document
    call, producing truncated/malformed JSON that aborted the whole job
    rather than a partial/degraded result.

    A document with only ONE branch (the common case: no heading structure,
    or one top-level section) behaves BYTE-IDENTICALLY to before this
    change — same single call pair, same unprefixed node_ids ("0", "1", ...)
    — chunking is invisible unless a document genuinely has multiple
    top-level branches. Only a genuinely multi-branch document gets
    per-branch node_id namespacing (see _build_survey_skeleton_for_branch); each
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

    Customer ID (WorkItemNode.customer_id) is a per-Requirement, document-
    derived attribute, never a parameter threaded through this function.
    For the deterministic path, see _detect_deterministic_subtrees'/
    id_tree_builder's own docstrings (a real document-authored identifier,
    conventions 1/2 only). For THIS function's own LLM-driven generative
    path, there are two layered mechanisms, primary then fallback, plus a
    whole-tree consistency check neither one can see on its own:
    (1) PRIMARY: stage 1's own model-reported customer_id (see
    section_skeleton_schema, _build_survey_skeleton_for_branch's
    _validated_skeleton_customer_id) -- the model reads the section's own
    rendered table/paragraph text at the same time it decides a row is its
    own separate node, and reports that row's literal identifier directly,
    verified verbatim against the branch's own source text before being
    trusted. (2) FALLBACK, for whatever (1) leaves None: see
    _author_branch_content's own customer_id extraction, which checks a
    source table folded verbatim into the node's description (via
    table_ids/skeleton.tables_by_id) with
    requirement_rows.repeated_customer_code_in_table (a column only counts
    as a real id column when it repeats a whole-cell code match at least
    twice) -- never a raw regex search over the table's rendered HTML or
    the surrounding model-authored paraphrase, either of which can just as
    easily match an unrelated cited product/protocol designator as carry
    the node's own real code.

    Neither mechanism can tell, by itself, that the SAME reported value
    got assigned to several unrelated nodes -- a real customer ID is
    unique to one requirement, so main.py's /level exit pass
    (_enforce_requirement_only_fields) runs a THIRD, whole-tree check
    after this function returns: any value shared by 2+ Requirements gets
    stripped from all of them (WarningKind.DUPLICATE_CUSTOMER_ID), since
    neither this stage nor stage 1 has enough context to know which one,
    if any, is genuinely correct. Honest on every path: never fabricated
    when no such code is present, at any stage. Live bug history for all
    three layers: docs/handoff-heading-tier-detector-and-customer-id-fixes.md.

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
    # Task 4b sub-fix (ii) regression fix: whole-document Figure.id ->
    # Figure.caption_status map, built ONCE here (same "over the FULL,
    # ORIGINAL doc" reasoning as figure_id_by_block_id directly above) and
    # threaded to _build_survey_skeleton_for_branch's own
    # figure_caption_status_by_id param at BOTH call sites below -- see that
    # param's own docstring for why this is a separate, narrow dict rather
    # than widening the multi-branch call site's `figures` argument.
    figure_caption_status_by_id: dict[str, str] = {
        f.id: f.caption_status for f in doc.figures if f.caption_status is not None
    }
    # Document's own real heading outline, built ONCE here over the FULL,
    # ORIGINAL `doc` -- same "before _detect_deterministic_subtrees ever
    # runs" reasoning as figure_id_by_block_id directly above: typing is a
    # document-wide, tree-shape-derived property (see
    # heading_outline.heading_outline_entries's own docstring), not a
    # per-branch one, and a branch that starts at a heading deeper than
    # the document's own shallowest level must not see that heading as its
    # own top tier. Every call site below filters this SAME list down to
    # just its own blocks via entries_for_blocks, rather than recomputing
    # it from a block subset.
    full_doc_heading_entries = heading_outline_entries(doc.blocks, doc.tables)

    # Deterministic hierarchy detection (table-row / ID-bearing-heading /
    # structural-heading conventions -- see _detect_deterministic_subtrees's
    # own docstring) runs BEFORE anything else in this function: every
    # claimed block/table is removed from `doc` for the remainder of this
    # function (via `llm_doc`), so the existing LLM-driven machinery below
    # is completely unaware this detection ever happened for a document
    # that doesn't use any of these conventions -- `llm_doc is doc` in that
    # case (a true no-op, not a copy).
    det_nodes, det_warnings, llm_doc = _detect_deterministic_subtrees(
        doc, title_tag_client, synthesis_client, parent_summary_client, model,
        progress_callback=progress_callback,
        figure_id_by_block_id=figure_id_by_block_id,
        chunk_concurrency=chunk_concurrency,
        user_id=user_id,
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
                query_text, raw_doc_citations, kb_relevance_client, debug_capture=debug_capture, user_id=user_id,
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
                    chunk_concurrency=chunk_concurrency, user_id=user_id,
                )
            _score_epics_and_features(
                all_nodes, scoring_client, all_warnings, progress_callback, model_name,
                len(det_nodes), 0, debug_capture=debug_capture, chunk_concurrency=chunk_concurrency,
                user_id=user_id,
            )

        _detect_conflicting_duplicates(
            all_nodes, embed_client, conflict_client, all_warnings,
            progress_callback, len(det_nodes), 0, user_id=user_id,
        )
        _regroup_disconnected_roots(
            all_nodes, "regroup_", grouping_client, all_warnings,
            progress_callback, len(det_nodes), 0, debug_capture=debug_capture, user_id=user_id,
        )
        _ensure_root_features_have_epic_parent(all_nodes, "regroup_", all_warnings)
        recompute_child_types(all_nodes)

        trace_links: list[TraceLink] = []
        if link_type_client is not None:
            trace_links = _infer_trace_links_for_nodes(
                all_nodes, link_type_client, link_type_catalog or [], all_warnings,
                progress_callback, len(det_nodes), 0, debug_capture=debug_capture, kb_context=doc_kb_context,
                user_id=user_id,
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
    # Confirmed real bug (live, Mock_PRD_Sensor.docx): a 3-column table
    # whose every row carries its own literal id ("P-SENSOR-001#") -- a
    # separate, independently-identified requirement per row -- contributed
    # NOTHING to this floor: heading_count only sees HEADING blocks, and
    # qualifying_table_groups (above) requires a strictly-2-column dotted-
    # numeric-ID table, which this convention isn't. A 19-requirement
    # document was given a floor of 5 (headings only) and the model
    # silently consolidated multiple rows into fewer nodes. Folded
    # ADDITIVELY into the same one coherent topic_count integer below,
    # exactly as doc_table_groups already is -- see
    # requirement_rows.qualifying_requirement_rows's own docstring for the
    # detection heuristic (deliberately gated so a genuinely supplementary
    # table, e.g. AirPro_BP_ICD_Revision_0.3.docx's own power-budget
    # tables, contributes zero rows here and is completely untouched).
    doc_requirement_rows = qualifying_requirement_rows(doc.tables)
    # Structural Epic/Feature naming hint (heading_outline.py) -- without
    # it, a model given several real top-tier heading sections in one
    # whole-document call can correctly type the richest section as Epic
    # but Feature-type the others directly underneath instead of promoting
    # each to its own Epic (see docs/handoff-heading-tier-detector-and-customer-id-fixes.md
    # for the confirmed live case). `full_doc_heading_entries` was already
    # computed once, over the FULL original document, above -- filtered
    # here down to just this call's own (residual) blocks via
    # entries_for_blocks, never recomputed from this subset (see that
    # function's own docstring for why). Purely a naming/typing hint -- it
    # does NOT change topic_count's arithmetic, since heading_count above
    # already counts every HEADING-kind block regardless of depth.
    doc_heading_hints = entries_for_blocks(full_doc_heading_entries, doc.blocks)

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
            query_text, raw_doc_citations, kb_relevance_client, debug_capture=debug_capture, user_id=user_id,
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
    # Every branch's own scoring-grounding text (see _BranchContentResult's
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
        # Front-matter guard on the single-call path (the multi-branch loop
        # below injects it per-branch via _combine_global_context). Without
        # this, a document short enough to fit in ONE call -- plausibly the
        # most common real input -- got no front-matter protection at all.
        # Computed from doc.blocks, exactly the blocks this call analyzes.
        # Advisory only, and NOT folded into the outer `global_context`
        # variable: that variable's None-ness is what `whole_document` below
        # is derived from, and a guard string must not flip that flag.
        single_call_front_matter_guard = _front_matter_guard_for_whole_document(doc.blocks)
        branch_skeletons = [_build_survey_skeleton_for_branch(
            doc.blocks, analysis_client,
            node_id_prefix="",
            tables=doc.tables, figures=doc.figures,
            supports_tools=supports_tools, retrieve_fn=retrieve_fn, kb_context=doc_kb_context,
            kb_context_citations=doc_kb_citations,
            list_documents_fn=list_documents_fn, read_document_fn=read_document_fn,
            global_context=single_call_front_matter_guard,
            # True precisely when the entire document was analyzed in one
            # pass with no compact outline built (global_context is None) --
            # even a "single branch" can have global_context set if
            # _merge_branches_by_budget collapsed everything back into one
            # branch on the doesn't-fit path (§4), which is NOT the
            # whole-doc-gate's "fits in one call outright" case.
            whole_document=(global_context is None),
            topic_count=heading_count + len(doc_table_groups) + len(doc_requirement_rows),
            table_groups=doc_table_groups,
            requirement_rows=doc_requirement_rows,
            heading_hints=doc_heading_hints,
            branch_index=0, branch_count=1, blocks_done_before=0, blocks_total=blocks_total,
            progress_callback=progress_callback,
            figure_id_by_block_id=figure_id_by_block_id,
            figure_caption_status_by_id=figure_caption_status_by_id,
            user_id=user_id,
        )]
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

        def _run_branch(branch_index: int, branch_blocks: list[Block]) -> _BranchSkeleton:
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
            # Per-branch requirement-row floor -- same per-branch scoping as
            # branch_table_groups directly above (a table's rows are never
            # split across branches).
            branch_requirement_rows = qualifying_requirement_rows(
                branch_tables[branch_index] if branch_tables is not None else None
            )
            # Per-branch heading-outline hint -- filtered from
            # `full_doc_heading_entries` (computed once, over the FULL
            # document, above build_survey_tree's whole-doc gate), NEVER
            # recomputed from this branch's own block subset (see
            # heading_outline.entries_for_blocks's own docstring for why:
            # classify_by_nesting's type computation is subset-invariant,
            # so recomputing wouldn't retype anything wrong on its own --
            # the real risk is the S1/S2 Title-suppression heuristic
            # wrongly firing on a branch that isolates one Epic's whole
            # subtree, since it then looks like the document's only
            # top-tier heading). Matters on this path too, not just the
            # whole-document one: _merge_branches_by_budget (this
            # function's own caller) can merge several adjacent top-tier
            # sections back into ONE physical branch/call up to the
            # model's coverage budget, reproducing the exact same
            # multi-top-tier-section-in-one-call shape the whole-document
            # path hits.
            branch_heading_hints = entries_for_blocks(full_doc_heading_entries, branch_blocks)
            return _build_survey_skeleton_for_branch(
                branch_blocks, analysis_client,
                node_id_prefix=f"br{branch_index}_",
                tables=branch_tables[branch_index] if branch_tables is not None else None,
                supports_tools=supports_tools, retrieve_fn=retrieve_fn, kb_context=doc_kb_context,
                kb_context_citations=doc_kb_citations,
                list_documents_fn=list_documents_fn, read_document_fn=read_document_fn,
                global_context=_combine_global_context(
                    global_context, branch_index, glossary_sections, primer_context, front_matter_branch_indices,
                ),
                read_other_section_fn=read_other_section_fn,
                topic_count=branch_heading_count + len(branch_table_groups) + len(branch_requirement_rows),
                table_groups=branch_table_groups,
                requirement_rows=branch_requirement_rows,
                heading_hints=branch_heading_hints,
                branch_index=branch_index, branch_count=len(branches),
                blocks_done_before=blocks_done_before_by_branch[branch_index],
                blocks_total=blocks_total, progress_callback=_fire_progress,
                figure_id_by_block_id=figure_id_by_block_id,
                figure_caption_status_by_id=figure_caption_status_by_id,
                user_id=user_id,
            )

        if branch_concurrency <= 1:
            # Byte-identical to this loop's pre-concurrency form: one
            # branch at a time, in document order. No ThreadPoolExecutor
            # involved at all -- zero new risk for every deployment that
            # hasn't opted into concurrency.
            branch_skeletons = [
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
                branch_skeletons = [future.result() for future in futures]
        blocks_done = running_total

    # Every branch's STRUCTURE now exists, document-wide, and not one word of
    # requirement text has been written yet -- which is the entire point of
    # splitting generation in two. The two whole-document structural repair
    # passes below therefore run HERE, between the stages, instead of at the
    # very end of this function where they used to: they reshape the tree
    # (regrouping disconnected roots under synthesized topical parents,
    # wrapping bare root Features under a catch-all Epic) while it is still
    # cheap, titles-only structure, so every node is authored against the
    # ancestry it will actually ship with rather than against one that was
    # about to change underneath it. Both operate purely on titles/types/
    # parent links (see root_regrouping.py) and needed no change of their own
    # to move -- they never read a description.
    #
    # Their synthesized nodes are appended to `all_nodes` only, never to any
    # branch's own node list, so stage 3 never offers one for authoring: each
    # keeps the canned "structure only, no content invented" description its
    # own pass wrote, exactly as before.
    for skeleton in branch_skeletons:
        all_nodes.extend(skeleton.nodes)
    # progress_callback is deliberately NOT threaded through here, unlike the
    # deterministic-only path's own call further up (which still runs at the
    # end of its pipeline and still narrates normally). The 'regroup_roots'
    # phase is defined FRONTEND-side as a post-scoring tail phase
    # (JobLifecycleSteps.tsx maps it to the "Score" step precisely so the
    # stepper doesn't regress backwards during the tail passes) -- firing it
    # here, mid-analysis, would advance the stepper to Score and then bounce
    # it back to Analyze as soon as the next section_complete arrives, the
    # exact user-visible regression that mapping exists to prevent. Silence
    # for one informational event beats a visibly wrong stepper; re-narrating
    # this pass needs the frontend's phase mapping revisited alongside, which
    # belongs with the rest of the orchestrator/frontend wiring for the new
    # staging, not here. This omission is scoped to these two repair passes
    # ONLY -- STAGE 2 immediately below (the actual figure/table mapping)
    # narrates via its own new 'map_scope' phase, added alongside the
    # frontend phase-mapping changes that let it do so without regroup_roots'
    # own stepper-regression problem.
    _regroup_disconnected_roots(
        all_nodes, "regroup_", grouping_client, all_warnings, debug_capture=debug_capture, user_id=user_id,
    )
    _ensure_root_features_have_epic_parent(all_nodes, "regroup_", all_warnings)

    # STAGE 2: whole-document figure/table -> EXACT node mapping, run here
    # and only here -- exact-node binding is impossible before stage 1 built
    # the nodes and the two repair passes above froze their ids, and
    # pointless after stage 3 has already written every description against a
    # figure/table set nobody decided. See _map_figures_tables_to_nodes for
    # the two-tier batching and the fail-open contract.
    #
    # Resolved by duck-typing off the analysis client (see
    # FigureTableMappingClient's own docstring): a client without the method
    # skips this stage entirely and behaves exactly as it did before stage 2
    # existed -- no attachment, and (correctly) nothing marked excluded
    # either, since nothing was ever judged. Runs at the SAME parallelism as
    # the two stages either side of it -- a serial stage in between would
    # insert one sequential LLM round-trip per branch into the middle of the
    # pipeline (and, with no narration of its own yet, a silent window
    # exactly as long).
    figure_table_ids_by_local_id: dict[str, dict[str, list[str]]] = {}
    excluded_figure_ids: list[str] = []
    excluded_table_ids: list[str] = []
    map_fn = getattr(analysis_client, "map_figures_tables", None)
    if map_fn is not None:
        (
            figure_table_ids_by_local_id, excluded_figure_ids, excluded_table_ids
        ) = _map_figures_tables_to_nodes(
            branch_skeletons, map_fn, figures_by_id(doc.figures),
            figure_id_by_block_id, all_warnings, branch_concurrency,
            progress_callback=progress_callback, blocks_total=blocks_total, user_id=user_id,
        )
        # Stage 3's hallucination guard (see _author_branch_content) checks a
        # node's assigned ids against what was OFFERED for it -- per branch
        # before this stage existed, since a branch's own call was the only
        # thing that could name an id. Mapping offers document-wide (tier 2
        # can legitimately place an appendix figure onto a chapter-3
        # requirement in another branch), so the honest guard set is now the
        # union of every branch's offered ids, not one branch's. Still a real
        # guard, not a widening to "anything": it is exactly the set of
        # captioned figures/tables this stage offered, so an uncaptioned
        # figure's id remains un-attachable and figure_ids/uncaptioned_figure_ids
        # stay provably disjoint. tables_by_id is widened for the same reason
        # -- a cross-branch table's HTML must be resolvable by whichever
        # branch's node it landed on.
        doc_valid_figure_ids = {fid for s in branch_skeletons for fid in s.valid_figure_ids}
        doc_valid_table_ids = {tid for s in branch_skeletons for tid in s.valid_table_ids}
        doc_tables_by_id = {
            tid: table for s in branch_skeletons for tid, table in s.tables_by_id.items()
        }
        branch_skeletons = [
            skeleton._replace(
                valid_figure_ids=doc_valid_figure_ids,
                valid_table_ids=doc_valid_table_ids,
                tables_by_id=doc_tables_by_id,
            )
            for skeleton in branch_skeletons
        ]

    # STAGE 3: content authoring, per branch, same parallelism model as
    # stage 1 -- each call fills in the very same WorkItemNode objects
    # already collected into `all_nodes` above, so nothing here re-adds a
    # node; only warnings/citations/grounding text come back. The whole
    # mapping dict is passed to every branch unfiltered: each branch only
    # ever looks up its OWN nodes' local_ids in it (see
    # _author_branch_content's per-node lookup), so a cross-branch verdict
    # reaches exactly the branch that owns its target node.
    if branch_concurrency <= 1 or len(branch_skeletons) <= 1:
        branch_results: list[_BranchContentResult] = [
            _author_branch_content(
                skeleton, analysis_client, figure_table_ids_by_local_id, title_distillation_client,
                user_id=user_id,
            )
            for skeleton in branch_skeletons
        ]
    else:
        with ThreadPoolExecutor(max_workers=branch_concurrency) as executor:
            content_futures = [
                executor.submit(
                    _author_branch_content, skeleton, analysis_client, figure_table_ids_by_local_id,
                    title_distillation_client, user_id=user_id,
                )
                for skeleton in branch_skeletons
            ]
            branch_results = [future.result() for future in content_futures]

    for branch_result in branch_results:
        all_warnings.extend(branch_result.warnings)
        all_kb_citations.extend(branch_result.kb_citations)
        if branch_result.scoring_kb_context:
            branch_scoring_kb_contexts.append(branch_result.scoring_kb_context)

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
    # design had -- see _BranchContentResult's docstring.
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
                chunk_concurrency=chunk_concurrency, user_id=user_id,
            )
        # Separate rubric/prompt from Requirement scoring above -- see
        # OrchestratorLlmClient.score_epics_and_features_for_document's own
        # docstring. Runs regardless of whether the document had any
        # Requirement nodes at all (an Epic/Feature-only tree still gets
        # reviewed) -- its own internal empty-list guard is a no-op when
        # there's nothing of that type either.
        _score_epics_and_features(
            all_nodes, scoring_client, all_warnings, progress_callback, model_name, blocks_total, len(branches),
            debug_capture=debug_capture, chunk_concurrency=chunk_concurrency, user_id=user_id,
        )

    _detect_conflicting_duplicates(
        all_nodes, embed_client, conflict_client, all_warnings,
        progress_callback, blocks_total, len(branches), user_id=user_id,
    )
    # _regroup_disconnected_roots/_ensure_root_features_have_epic_parent used
    # to run right here, after every branch's full text had already been
    # written against a structure they were about to change. They now run
    # BETWEEN the two generation stages instead (see their new call site
    # above); the deterministic-only guard path further up keeps its own
    # end-of-pipeline call, since it has no two-stage generation to sit
    # between. Conflict detection stays here, after content exists: it
    # embeds Requirement TITLES AND DESCRIPTIONS, so it genuinely cannot move earlier.
    recompute_child_types(all_nodes)

    trace_links: list[TraceLink] = []
    if link_type_client is not None:
        # doc_kb_context IS populated on both paths -- see its own definition
        # above. On the fallback (non-agentic, `not supports_tools`) path it
        # holds a real retrieve_context/topical-KB-search result merged with
        # always-include material. On the agentic (`supports_tools=True`)
        # path it holds ONLY already-merged always-include KB material (via
        # _merge_always_include_context, called in that branch too, by
        # design -- see its own comment there): that path grounds other
        # calls via live query_kb tool calls during branch authoring rather
        # than a static context string, and infer_trace_links has no
        # tool-calling variant of its own, so it never gets the benefit of
        # the model's own query_kb searches. Known, documented limitation:
        # trace-link type selection gets no RETRIEVED/topical KB grounding
        # on the agentic path specifically -- only always-include grounding
        # -- a real (narrower) gap, tracked as a follow-up, not closed here.
        trace_links = _infer_trace_links_for_nodes(
            all_nodes, link_type_client, link_type_catalog or [], all_warnings,
            progress_callback, blocks_total, len(branches), debug_capture=debug_capture, kb_context=doc_kb_context,
            user_id=user_id,
        )

    return WorkItemTree(
        nodes=all_nodes, warnings=finalize_warnings(all_warnings),
        kb_citations=deduped_citations, trace_links=trace_links,
        excluded_figure_ids=excluded_figure_ids, excluded_table_ids=excluded_table_ids,
    )




class _BranchContentResult(NamedTuple):
    """Internal (build_survey_tree <-> _author_branch_content) carrier -- not
    part of the module's external WorkItemTree contract. Deliberately carries
    NO node list: stage 3 fills in the SAME WorkItemNode objects stage 1
    already handed back (see _BranchSkeleton), which build_survey_tree has
    already collected into `all_nodes` by the time this runs -- returning
    them a second time would only invite double-counting.

    `scoring_kb_context` is the SAME grounding text this branch would have
    scored against under the old per-branch design (None on the fallback path
    unless doc_kb_context was set, or the real assembled query_kb hit text on
    the agentic path) -- surfaced so build_survey_tree can aggregate every
    branch's real grounding text into ONE whole-document scoring call (see
    _score_all_requirements) instead of losing per-branch agentic grounding
    entirely."""

    warnings: list[IntegrityWarning]
    kb_citations: list[KbCitation]
    scoring_kb_context: str | None


class _BranchSkeleton(NamedTuple):
    """Internal carrier between SURVEY generation's two per-branch stages
    (_build_survey_skeleton_for_branch -> _author_branch_content), with the
    whole-document structural repair passes running in between (see
    build_survey_tree).

    `nodes` are this branch's real WorkItemNodes, already fully STRUCTURED
    (type/parent/title decided, hierarchy repaired) but with an EMPTY
    `description` -- that emptiness is exactly what marks a node as still
    awaiting authoring, and is what distinguishes them from the synthesized
    bridge/grouping nodes the repair passes may have appended to this same
    list, which carry their own canned description and are never authored.
    Stage 3 fills these same objects in place, so build_survey_tree can
    safely collect them into the document-wide node list BEFORE authoring
    runs -- which is the whole point of the split: whole-document regrouping
    gets to reshape the tree while it is still cheap, titles-only structure.

    Everything else here is the branch context stage 3 needs to author
    against and to run its own content-dependent checks: the rendered
    `section_text` the model must stay grounded in, the branch's own
    candidate figure/table ids (what stage 2's whole-document mapping pass
    offers for this branch, and what stage 3 then validates its verdicts
    against), and the narration/warning bookkeeping stage 1 already
    started."""

    nodes: list[WorkItemNode]
    warnings: list[IntegrityWarning]
    kb_citations: list[KbCitation]
    scoring_kb_context: str | None
    section_text: str
    section_label: str | None
    blocks: list[Block]
    tables_by_id: dict[str, Table]
    valid_figure_ids: set[str]
    valid_table_ids: set[str]
    node_id_prefix: str
    # This branch's own progress firer, built once in stage 1 (closing over
    # branch_index/branch_count/blocks_done_before/blocks_total/section_label/
    # model) and carried across so stage 3's section_complete event reports
    # the identical branch coordinates stage 1's analyze_section event did,
    # with no second copy of that parameter list threaded through.
    fire: Callable[..., None]
    # Per-row requirement splitting (2026-08-26): table ids this branch's
    # own requirement_rows already fully decomposed into per-row
    # Requirement nodes. Kept here so _mapping_items_for_branch (stage 2)
    # can exclude them from the figure/table mapping pass entirely -- a
    # table already split into N Requirements is not an unplaced artifact
    # needing a home, and offering it anyway would let stage 3 fold the
    # WHOLE table's HTML into just one of those N nodes, re-creating
    # exactly the "one table, one description" problem this feature exists
    # to stop, on top of an otherwise-correct split. Trailing, with a
    # default, so every pre-existing direct _BranchSkeleton(...) test
    # construction that doesn't care about this stays byte-identical.
    requirement_list_table_ids: frozenset[str] = frozenset()


def _widen_branch_page_range(
    representative: SourceRef, blocks: list[Block], tables: list[Table] | None, figures: list[Figure] | None
) -> SourceRef:
    """Per-BRANCH counterpart to tree_builder.py's _widen_page_end (same
    max-page_end pattern, proven there for the deterministic path), plus a
    matching min-page widen -- `representative` (blocks[0]'s/tables[0]'s/
    figures[0]'s source_ref, see this function's only call site) otherwise
    passes its page/page_end through verbatim even though every OTHER
    node synthesized from this branch shares this same ref regardless of
    which of the branch's many blocks/tables/figures it actually came from.
    Not full per-node accuracy (out of scope -- see
    _build_survey_skeleton_for_branch's own docstring): this only widens the
    ONE representative ref's range to cover the branch's real min page /
    max page_end, turning "wrong single page for the whole branch" into
    "correct range for the whole branch". A no-op (mirrors _widen_page_end)
    when `representative` itself has no page at all."""
    if representative.page is None:
        return representative
    min_page = representative.page
    max_page_end = representative.page_end if representative.page_end is not None else representative.page
    for ref in itertools.chain(
        (b.source_ref for b in blocks),
        (t.source_ref for t in (tables or [])),
        (f.source_ref for f in (figures or [])),
    ):
        if ref.page is None:
            continue
        min_page = min(min_page, ref.page)
        max_page_end = max(max_page_end, ref.page_end if ref.page_end is not None else ref.page)
    updates: dict[str, int] = {}
    if min_page != representative.page:
        updates["page"] = min_page
    if max_page_end != (representative.page_end if representative.page_end is not None else representative.page):
        updates["page_end"] = max_page_end
    return representative.model_copy(update=updates) if updates else representative


def _build_survey_skeleton_for_branch(
    blocks: list[Block],
    analysis_client: SectionAnalysisClient,
    node_id_prefix: str,
    tables: list[Table] | None = None,
    figures: list[Figure] | None = None,
    supports_tools: bool = False,
    retrieve_fn: Callable[[str], tuple[str | None, list[dict]]] | None = None,
    list_documents_fn: Callable[[], list[str]] | None = None,
    read_document_fn: Callable[[str], str | None] | None = None,
    kb_context: str | None = None,
    # The real per-file citations `kb_context` was flattened from (see
    # build_survey_tree's doc_kb_citations) -- used only on the non-agentic
    # fallback path below to narrate the actual file(s) grounding this
    # branch instead of a fabricated single "(document-level)" citation.
    # The agentic path ignores this: it builds its own per-file citations
    # from the model's real query_kb hits (raw_hits), which is a superset
    # of always-include grounding already reflected in doc_kb_citations.
    kb_context_citations: list[KbCitation] | None = None,
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
    # Full RequirementRowInfo objects (table_id + code + label) for THIS
    # branch's own qualifying requirements-list table rows -- same two uses
    # as table_groups directly above: reduced to (code, label) pairs for
    # the client's generation-time hint, and kept in full for the post-hoc
    # coverage-check warning after nodes are built (see
    # requirement_rows.qualifying_requirement_rows's own docstring).
    requirement_rows: list[RequirementRowInfo] | None = None,
    # This section's own real heading outline, already filtered to this
    # branch's own blocks (see heading_outline.entries_for_blocks) -- each
    # entry's type is derived from the document's own relative nesting
    # shape, never an absolute heading level (see
    # heading_outline.heading_outline_entries's own docstring). Reduced to
    # (title, type) pairs for the client's generation-time hint below;
    # there is no coverage-check counterpart to table_groups/
    # requirement_rows above (a heading's
    # title is not a stable identifier the way a table_id or a literal
    # customer_id code is, so a post-hoc title-match coverage check would
    # be unreliably noisy -- this stays steer-only, same as
    # whole_document_hint/branch_topic_hint).
    heading_hints: list[HeadingOutlineEntry] | None = None,
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
    # Task 4b sub-fix (ii) regression fix: whole-document Figure.id ->
    # Figure.caption_status map, built ONCE over the full doc.figures (see
    # build_survey_tree's own call site comment) and threaded to BOTH of
    # this function's call sites -- mirrors figure_id_by_block_id's own
    # whole-document convention directly above, deliberately a NARROW
    # id->status dict rather than widening the `figures` param above to
    # always carry the whole document's figures. `figures` above already
    # feeds render_section/_derive_section_label/representative_source_ref/
    # _widen_branch_page_range for THIS branch specifically -- passing the
    # whole document's figures there on the multi-branch path would change
    # LLM prompt content and branch source-ref widening, an unrelated and
    # unintended side effect. This param exists ONLY for the insignificant-
    # figure lookup below. Confirmed real gap this fixes: the multi-branch
    # path (_run_branch, build_survey_tree) never passed `figures=` at all
    # (only `tables=`), so insignificant_figure_ids was silently never
    # populated for any multi-branch SURVEY document -- exactly the large,
    # multi-branch documents this whole task's figure-significance
    # disambiguation exists for.
    figure_caption_status_by_id: dict[str, str] | None = None,
    user_id: str | None = None,
) -> _BranchSkeleton:
    """STAGE 1 of SURVEY's two-stage per-branch generation: does the actual
    per-branch (or, for a single-branch document, whole-document) leveling
    of STRUCTURE via ONE holistic analyze_section_skeleton /
    analyze_section_skeleton_agentic call (see SectionAnalysisClient's
    docstring). The model returns the COMPLETE node set it decides this
    section contains -- not one node per input Block -- as bare
    {temp_id, type, parent_temp_id, title} entries with no requirement text
    at all. Every node this builds therefore leaves here with an EMPTY
    description; _author_branch_content (stage 3) fills it in afterwards,
    against the tree as it stands once whole-document structural repair has
    also run.

    Why the split: hierarchy decisions and requirement wording were
    previously entangled in one response, so the whole-document repair
    passes (_regroup_disconnected_roots / _ensure_root_features_have_epic_parent)
    could only ever run after every branch's full text had already been
    written against a structure that was about to change underneath it.
    Structure is now settled first, cheaply, across the whole document, and
    only then is content authored against the structure that actually
    survives.

    Title comes from the model's own 'title' field on each node (a short,
    distinct label -- see the section_skeleton prompt), clamped to 256 chars
    via extract_baseline_title. A model response that omits it (schema
    non-compliance) now has nothing left to fall back to -- 'title' is the
    ONLY human-readable content a skeleton entry carries -- so that node is
    dropped with a warning, the structural counterpart of the old single
    call's "a node with no text at all is skipped" rule.

    `node_id_prefix`: "" for a single-branch document (byte-identical
    node_ids to pre-chunking behavior); "br{N}_" for one of several
    branches in a multi-branch document. Applied to both a node's own
    local_id and its parent_local_id (never to the model-facing temp_id used
    in the skeleton call itself — the model only ever sees this branch's own
    local temp_ids).

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
    is analyzed via analyze_section_skeleton_agentic (the model pulls KB
    context itself via query_kb); otherwise via the plain skeleton call using
    the pre-computed `kb_context` (None when KB isn't configured at all).
    Either way the resulting grounding text is carried forward on the
    returned _BranchSkeleton, so stage 3 authors against the SAME real
    material for the price of one agentic loop rather than two.

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
    orchestrator_llm_client._whole_document_hint's own docstring.

    Fails hard, deliberately: the skeleton call has NO try/except around it,
    exactly like the single analyze_section call it replaces. Core
    generation failing must fail the job, not silently produce a structureless
    document; only clearly-optional enhancement passes fail open."""
    # Kept as its own local (not just folded into section_text below) so
    # the model-reported customer_id verification further down can check
    # against THIS branch's own real source text specifically -- a code
    # that appears only in another section's compact global_context outline
    # must never validate.
    rendered_section_text = render_section(blocks, tables, figures, figure_id_by_block_id)
    section_text = rendered_section_text
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

    # Scoring (_score_all_requirements, later) needs an actual kb_context
    # STRING, not just kb_citations metadata -- on the agentic path the
    # outer `kb_context` parameter stays None (only the fallback path
    # populates it upfront), so without this, scoring ran completely
    # ungrounded even when the model successfully pulled real KB content
    # during analysis. `raw_hits` already carries each hit's full retrieved
    # text (see _execute_agentic_tool_call's `citations.extend(hits)`,
    # where `hits` comes straight from retrieve_context) -- this was already
    # in hand, just never assembled into a context string and threaded to
    # scoring. Defaults to the outer `kb_context` param (fallback path, or
    # None when no query_kb calls happened / no KB deps at all). Since the
    # split, this same string is ALSO what grounds stage 3's authoring call,
    # so a branch's one agentic retrieval loop now pays for both stages.
    scoring_kb_context = kb_context
    # (label, suggested_type) pairs cross into the client -- child_count/
    # id_text are this function's own bookkeeping for the coverage-check
    # warning below, the client only needs to know what to name AND what
    # type to use for its prompt hint (see qualifying_table_groups's own
    # docstring for how suggested_type is determined).
    table_group_hints = (
        [(g.label, g.suggested_type) for g in table_groups] if table_groups else None
    )
    # (code, label) pairs cross into the client -- table_id is this
    # function's own bookkeeping for the coverage-check warning below, the
    # client only needs the literal identifier and a short label to name.
    requirement_row_hints = (
        [(r.code, r.label) for r in requirement_rows] if requirement_rows else None
    )
    # (title, type) pairs cross into the client -- see heading_hints'
    # own param comment above for why there is no coverage-check
    # counterpart to keep in full here, unlike table_groups/requirement_rows.
    heading_type_hint_pairs = (
        [(h.title, h.suggested_type) for h in heading_hints] if heading_hints else None
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
    # Both branches below steer the model identically -- the agentic/
    # fallback split is about HOW context is retrieved, never about which
    # structural hints apply -- so build the hint bundle once. (Before this
    # was one object, the two calls restated the same six keyword arguments
    # and could drift; see SWEEP.md section 2's own item on this.)
    section_analysis_options = SectionAnalysisOptions(
        whole_document=whole_document,
        topic_count=topic_count,
        table_group_hints=table_group_hints,
        expected_root_count=expected_root_count,
        requirement_row_hints=requirement_row_hints,
        heading_type_hints=heading_type_hint_pairs,
    )
    if supports_tools and retrieve_fn is not None:
        _fire("build_skeleton", kb_grounded=False, kb_citations_raw=[])
        raw_nodes, raw_hits, truncated = analysis_client.analyze_section_skeleton_agentic(
            section_text, retrieve_fn, list_documents_fn=list_documents_fn, read_document_fn=read_document_fn,
            read_other_section_fn=read_other_section_fn,
            options=section_analysis_options,
            user_id=user_id,
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
        # Real gap this closes: the in-flight _fire above hardcodes
        # kb_grounded=False (unknowable before the call -- the model
        # decides mid-call whether to invoke query_kb at all) and was never
        # re-fired with the real result, so the UI permanently showed "Not
        # grounded" for this step even when retrieval succeeded. Same
        # in-flight-then-real-result convention as main.py's own
        # describe_figure narration (two events: one before the call with
        # placeholder values, one after with the truth).
        _fire(
            "build_skeleton",
            kb_grounded=bool(kb_citations),
            kb_citations_raw=[{"source_file": c.source_file, "similarity": c.similarity} for c in kb_citations],
        )
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
        # §item-4-Critical fix: `kb_context` (the outer param, i.e. the
        # always-include text merged in by build_survey_tree) must be
        # MERGED into scoring's grounding text, not replaced by it -- the
        # model's own query_kb hits (unique_texts) are additional grounding
        # the agentic path pulled, not a substitute for the always-include
        # text that was already handed to it. Overwriting here silently
        # dropped always-include grounding from authoring/scoring on any
        # branch where the model made at least one query_kb call, even
        # though that file's citation still renders in the UI as
        # "Grounded against: <file> · 100%" (seeded into all_kb_citations
        # from doc_kb_citations at the top of build_survey_tree).
        scoring_kb_context = "\n\n".join(([kb_context] if kb_context else []) + unique_texts) or None
    else:
        # §item-4-fabricated-citation fix: previously synthesized a single
        # fake `{"source_file": "(document-level)", "similarity": 1.0}"`
        # citation whenever ANY kb_context text was present, regardless of
        # which real file(s) it actually came from -- rendered in the UI as
        # if it were a genuine per-file match. `kb_context_citations` (the
        # real doc_kb_citations list build_survey_tree already assembled
        # from retrieve_context + always-include, see this function's own
        # docstring) carries the real per-file identity, so use that
        # instead of fabricating one.
        kb_citations_raw_dicts = (
            [{"source_file": c.source_file, "similarity": c.similarity} for c in kb_context_citations]
            if kb_context_citations else []
        )
        _fire("build_skeleton", kb_grounded=bool(kb_context), kb_citations_raw=kb_citations_raw_dicts)
        raw_nodes, truncated = analysis_client.analyze_section_skeleton(
            section_text, kb_context=kb_context,
            options=section_analysis_options,
            user_id=user_id,
        )
        kb_citations = []  # doc-level citations are collected once in build_survey_tree, not per-branch

    by_temp_id = {n["temp_id"]: n for n in raw_nodes if isinstance(n, dict) and n.get("temp_id")}
    warnings: list[IntegrityWarning] = []
    if truncated:
        warnings.append(
            IntegrityWarning.make(
                WarningKind.OUTPUT_TRUNCATED,
                "Model output was truncated by the token limit while deciding this section's "
                "structure -- some work items may be missing entirely; consider raising the "
                "model's output cap.",
                detail={"branch": node_id_prefix or "(root)", "stage": "skeleton"},
            )
        )
    nodes: list[WorkItemNode] = []

    representative_source_ref = (
        blocks[0].source_ref if blocks else (tables[0].source_ref if tables else (figures[0].source_ref if figures else None))
    )
    if representative_source_ref is not None:
        # Widens page/page_end to the branch's real min/max BEFORE the
        # section_path copy below -- see _widen_branch_page_range's own
        # docstring (mirrors tree_builder.py's _widen_page_end pattern,
        # applied once per branch here rather than per fold).
        representative_source_ref = _widen_branch_page_range(representative_source_ref, blocks, tables, figures)
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
    # figure/table id injection) -- carried forward on the returned
    # _BranchSkeleton so the eventual whole-document figure/table MAPPING
    # pass's verdicts can still be validated against what this branch really
    # offered, exactly as the model's own inline figure_ids/table_ids used
    # to be. An id outside this set is a hallucination (an id that doesn't
    # exist, or belongs to a DIFFERENT branch/section) and is dropped, never
    # trusted verbatim. valid_table_ids comes straight from this branch's
    # own `tables` param; valid_figure_ids is derived from this branch's own
    # `blocks` via the whole-document figure_id_by_block_id map
    # (branch-scoped implicitly, since only this branch's own FIGURE-kind
    # blocks are in `blocks`) -- restricted to CAPTIONED figures only
    # (`_figure_line(b) is not None`): an uncaptioned figure's id is never
    # rendered into section_text at all (_render_block_line returns None for
    # it, so its id-injection branch never runs -- see that function's own
    # docstring), and is attributed separately, POSITIONALLY, into
    # uncaptioned_figure_ids below. Excluding it here keeps figure_ids and
    # uncaptioned_figure_ids provably disjoint regardless of what any later
    # mapping pass returns (e.g. a hallucinated id that happens to collide
    # with a real uncaptioned figure's id), not just in the common case
    # where the model never sees the id to begin with.
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
        raw_title = entry.get("title")
        if not raw_title or not isinstance(raw_title, str):
            # The skeleton's 'title' is the ONLY human-readable content a
            # stage-1 entry carries, and the schema marks it required -- a
            # model that omits it anyway has produced a node with no
            # identity for the authoring stage to write against and no label
            # for a reviewer to recognize. Dropped rather than kept as an
            # untitled placeholder: the structural counterpart of the old
            # single call's "a node with no text at all is skipped" rule
            # (there, a missing title could still be derived from the text;
            # here there is no text yet to derive one from).
            message = (
                f"A {entry.get('type') or 'work'} item in this section had no title from "
                "structure analysis -- it was dropped, since a skeleton node carries nothing "
                "else to identify it by."
            )
            logger.warning(message)
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.NO_MODEL_TITLE, message, node_ids=[f"{node_id_prefix}{temp_id}"]
                )
            )
            continue
        title = extract_baseline_title(raw_title)

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

        local_id = f"{node_id_prefix}{temp_id}"
        nodes.append(
            WorkItemNode(
                local_id=local_id,
                type=node_type,
                parent_local_id=f"{node_id_prefix}{parent_temp_id}" if parent_temp_id is not None else None,
                title=title,
                # Empty until _author_branch_content runs -- and that
                # emptiness is load-bearing, not a placeholder: it is
                # precisely what marks a node as still awaiting authoring,
                # distinguishing it from the synthesized bridge/grouping
                # nodes the repair passes below append with their own canned
                # description. fidelity_hash (a hash OF the description) and
                # grounding_score (measured against the description) are
                # likewise deferred to that same stage -- there is nothing
                # yet to hash or to score.
                description="",
                # Primary mechanism, since 2026-08-26: the model reports
                # this directly (see section_skeleton_schema), verified
                # against this branch's own real source text before being
                # trusted (see _validated_skeleton_customer_id). None on
                # any rejection -- an honest, never-fabricated absence, not
                # a placeholder. _author_branch_content's own regex-based
                # extraction (see its own doc comment) is a FALLBACK for
                # whatever this leaves None, not a second, independent
                # mechanism -- see build_survey_tree's own docstring for
                # the full primary/fallback story.
                customer_id=_validated_skeleton_customer_id(
                    entry.get("customer_id"), node_type, rendered_section_text, local_id, title
                ),
                source_ref=representative_source_ref,
                # Confirmed real bug (live, via golden-e2e's BASELINE re-run
                # assertion, which surfaced the same class of issue this
                # SURVEY path has too): plain _hash_identity(text, ...) hashed
                # the LLM-GENERATED `text` -- unstable run-to-run wording for
                # the SAME semantic content -- combined with
                # representative_source_ref, which every node in THIS
                # section shares (section analysis has no per-node source
                # attribution, only a whole-section one). Re-keyed on
                # local_id instead: still deterministic given the SAME
                # section producing the SAME node count/order, and no longer
                # poisoned by wording drift -- which is also why it can be
                # computed HERE, before any content exists at all. Residual,
                # known limitation: if the model's OWN node count/ordering
                # for a section varies between runs (not just wording),
                # local_id-based identity can't fully paper over that --
                # fixing it for real needs per-node source offsets from the
                # model, a bigger schema/prompt change tracked separately,
                # not this hash function.
                identity_hash=_hash_identity_for_synthesized_node(local_id, representative_source_ref),
                mode=WorkItemMode.SURVEY,
            )
        )

    # known-issues item 20 extension: an UNCAPTIONED figure's id is never
    # rendered into section_text at all (_render_block_line returns None
    # for it -- see that function's own docstring), so the model never sees
    # it and can never name it the way a captioned figure can. Unlike
    # BASELINE/the deterministic path, which walk blocks sequentially and
    # always have a real currently-"open" node to attach an uncaptioned
    # figure to, SURVEY nodes carry no individual per-node source position
    # at all (see representative_source_ref's own trade-off comment above --
    # every node in this branch shares ONE coarse, section-level
    # source_ref). With no true per-node offset to bracket against, the best
    # available deterministic proxy is `nodes`' own list order: by_temp_id
    # preserves the model's own raw_nodes response order, which in practice
    # tracks the section's top-to-bottom structure closely enough to stand
    # in for real document order. Each uncaptioned figure's own block-order
    # position (within this branch's `blocks`) is mapped proportionally onto
    # that same node ordering -- same "bucket by document-order position"
    # spirit as _partition_tables_by_branch's forward-scan bucketing and
    # _detect_deterministic_subtrees's heading-boundary bracketing, just
    # applied at node-LIST granularity instead of an offset/boundary
    # comparison, since a node-list index is all a SURVEY node actually
    # carries. Purely positional, so it belongs to this structural stage --
    # it never reads a description. A branch that produced zero nodes has
    # nowhere to attach one -- silently skipped, consistent with every other
    # content this branch would also be unable to place.
    if nodes:
        for i, block in enumerate(blocks):
            if block.kind != BlockKind.FIGURE or _figure_line(block) is not None:
                continue  # non-figure, or captioned (handled via the figure/table mapping pass)
            figure_id = (figure_id_by_block_id or {}).get(block.id)
            if figure_id is None:
                continue
            bracket_index = min(len(nodes) - 1, i * len(nodes) // len(blocks))
            nodes[bracket_index].uncaptioned_figure_ids.append(figure_id)
            # Uses the whole-document figure_caption_status_by_id param, NOT
            # the `figures` param above -- see that param's own docstring for
            # why: `figures` is scoped to THIS branch (or None on the
            # multi-branch path, see build_survey_tree's _run_branch), so a
            # lookup against it silently found nothing for every multi-branch
            # document (the real bug this fixes).
            if (figure_caption_status_by_id or {}).get(figure_id) == "insignificant":
                nodes[bracket_index].insignificant_figure_ids.append(figure_id)

    # §CMMI hierarchy repair (task confirmed real bug: the prompt alone is a
    # soft LLM instruction with no backstop -- a model still occasionally
    # emits a Requirement directly under an Epic, chained under another
    # Requirement, or orphaned with no parent at all despite Epic/Feature
    # nodes existing elsewhere in the same branch). Runs AFTER every node in
    # this branch already exists, so it can walk the real parent chain --
    # and now also strictly BEFORE any content is authored, so a node that
    # gets re-parented here is authored against the parent it actually ends
    # up with rather than the one the model first guessed. Operates purely
    # on type/parent/title, so it needs no description to do its job.
    _repair_requirement_hierarchy(nodes, node_id_prefix, warnings)

    # Correct known-wrong ATTACHMENT for a group that otherwise generated
    # correctly (right type, right children) -- see _repair_group_attachment's
    # own docstring for why this runs as a deterministic post-hoc repair
    # instead of more prompt tuning. Runs after _repair_requirement_hierarchy
    # so a node that was JUST re-parented onto a real Feature (type-repair)
    # can still be corrected to the SPECIFIC right Feature/Epic here if the
    # table's own ID hierarchy says otherwise. Title-driven, like the
    # coverage check below -- also unaffected by content not existing yet.
    _repair_group_attachment(nodes, table_groups, node_id_prefix, warnings)

    if not nodes and (blocks or tables or figures):
        # A non-empty branch contributing exactly 0 nodes was previously
        # silent (only a debug-level logger.warning inside the agentic call,
        # never surfaced to the reviewer) -- this is a real, user-visible gap
        # (confirmed real cause of a branch silently missing from the
        # proposed tree entirely, not just a dropped-block coverage note)
        # distinct from the dropped_blocks check in stage 3, which assumes at
        # least SOME nodes exist to compare source blocks against.
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

    # Table-group coverage check -- the "catch" half of this fix, pairing
    # with the generation-time floor (topic_count + _table_group_hint)
    # threaded in above, which is the "steer" half. Steering can still fail
    # even with a good hint (confirmed live: the floor alone doesn't
    # guarantee every named group gets used) -- this gives a human-visible
    # signal when it does, the same complementary relationship
    # topic_count/_whole_document_hint (steer) and the dropped_blocks check
    # (catch) already have for paragraph blocks. A missing table group
    # previously produced ZERO warning of any kind (the dropped_blocks check
    # only ever scans `blocks`, never table rows). Checked against node
    # TITLES specifically (see _group_label_became_a_node's own docstring),
    # so it belongs to this structural stage.
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

    # Requirement-row coverage check -- the "catch" half of the per-row
    # splitting fix, pairing with the generation-time floor
    # (topic_count + _requirement_row_hint) threaded in above (the
    # "steer" half), same complementary relationship missing_groups
    # directly above already has with table_group_hints. An identified
    # row's own code is checked against every node's FINAL customer_id
    # (whichever of the primary/model-reported or fallback/regex
    # mechanisms actually set it -- see _validated_skeleton_customer_id
    # and _author_branch_content) -- a row whose code claims no node at
    # all is a real, lost, explicitly-numbered customer requirement.
    claimed_codes = {n.customer_id for n in nodes if n.customer_id}
    unclaimed_rows = [r for r in (requirement_rows or []) if r.code not in claimed_codes]
    if unclaimed_rows:
        row_previews = "; ".join(f"{r.code} ({r.label})" if r.label else r.code for r in unclaimed_rows[:10])
        message = (
            f"{len(unclaimed_rows)} source table row(s) carry their own literal requirement "
            "identifier but no generated work item claims it -- those rows may have been merged "
            f"into another requirement or dropped entirely: {row_previews}"
        )
        logger.warning(message)
        warnings.append(
            IntegrityWarning.make(
                WarningKind.MISSING_REQUIREMENT_ROW_COVERAGE,
                message,
                detail={
                    "branch": node_id_prefix or "(root)",
                    "unclaimedCodes": [r.code for r in unclaimed_rows[:10]],
                    "totalIdentifiedRows": len(requirement_rows or []),
                },
            )
        )

    warnings.extend(_referenced_attachment_warnings(section_text, section_label))
    warnings.extend(_unsupported_content_warnings(blocks, section_label))
    warnings.extend(_ocr_recovered_table_warnings(tables, section_label))
    warnings.extend(_nested_table_dropped_warnings(tables, section_label))

    return _BranchSkeleton(
        nodes=nodes,
        warnings=warnings,
        kb_citations=kb_citations,
        scoring_kb_context=scoring_kb_context,
        section_text=section_text,
        section_label=section_label,
        blocks=blocks,
        tables_by_id=tables_by_id,
        valid_figure_ids=valid_figure_ids,
        valid_table_ids=valid_table_ids,
        requirement_list_table_ids=frozenset(r.table_id for r in (requirement_rows or [])),
        node_id_prefix=node_id_prefix,
        fire=_fire,
    )


# STAGE 2 (whole-document figure/table -> exact-node mapping) tuning
# constants. All three exist to keep this stage's cost a function of BRANCH
# count, never figure count -- the single hardest constraint on this stage
# (the motivating document has 918 figures; a per-figure call would double
# the already-dominant sequential vision-captioning cost).
#
# Chunk size, applied to BOTH tiers: derived the same way
# _SCORING_CHUNK_NODE_COUNT is (see its own docstring) rather than picked as a
# round number -- a mapping response entry ({'node_id', 'escalate'} plus its
# item-id key) runs ~25 tokens, so 200 items is ~5k of _MAX_OUTPUT_TOKENS'
# 20k, leaving ample room for JSON structural overhead. Deliberately smaller
# than the ~300 the candidate list would also allow: tier 2 offers the WHOLE
# document's node titles as candidates, so its INPUT is the side under
# pressure, not its output.
#
# Tier 1 is chunked by this too, not just tier 2 -- a branch is normally far
# smaller than one chunk, but _bound_branch_size can legitimately hand back an
# oversized branch (a flat, figure-dense appendix with no heading structure to
# split on: exactly the 918-figure document shape this stage exists for), and
# an over-long tier-1 response would silently escalate that WHOLE branch into
# tier 2 -- unplanned call volume against this stage's own cost constraint.
# Safe to add because a branch's candidate set is identical across every chunk
# of that same branch: chunking changes only how many items each call carries.
_MAPPING_CHUNK_ITEM_COUNT = 200
# A vision-generated figure caption can run to a full paragraph. Mapping only
# needs enough of it to recognize the SUBJECT, so each caption is previewed,
# not sent whole -- at branch-batched scale (an entire branch's figures in
# one call) the difference between a preview and a full caption is the
# difference between a comfortable prompt and an overflowing one.
_MAPPING_CAPTION_PREVIEW_CHARS = 240
_MAPPING_TABLE_COLUMN_COUNT = 8
_MAPPING_TABLE_COLUMN_PREVIEW_CHARS = 60
_MAPPING_TABLE_ROW_COUNT = 2


class FigureTableMappingClient(Protocol):
    """STAGE 2 of SURVEY's generation split: maps each figure/table to the
    EXACT node it belongs to, whole-document, between stage 1 (structure) and
    stage 3 (content). See OrchestratorLlmClient.map_figures_tables for the
    call's own contract.

    Deliberately a SEPARATE, optional Protocol rather than a fourth method on
    SectionAnalysisClient: it is resolved off the analysis client by
    duck-typing at the call site (`getattr(analysis_client,
    "map_figures_tables", None)`, the same convention _score_epics_and_features
    already uses for its own late-added method), so a client that predates
    this stage keeps working unchanged -- it simply gets no mapping, which is
    byte-identical to the state stage 2 was introduced to replace (every
    node's figure_ids/table_ids empty, nothing excluded)."""

    def map_figures_tables(
        self, candidates: dict[str, dict], items: dict[str, dict]
    ) -> dict[str, dict]: ...


def _mapping_preview(text: str | None, limit: int) -> str | None:
    """Bounded single-line preview of a caption/cell for a mapping payload --
    see _MAPPING_CAPTION_PREVIEW_CHARS. None/blank stays None (an absent
    caption is a real signal to the model; an empty string reads as one that
    exists and says nothing)."""
    if text is None:
        return None
    collapsed = " ".join(text.split())
    if not collapsed:
        return None
    return collapsed if len(collapsed) <= limit else collapsed[:limit].rstrip() + "..."


def _mapping_items_for_branch(
    skeleton: _BranchSkeleton,
    figures_by_figure_id: dict[str, Figure],
    figure_id_by_block_id: dict[str, str] | None,
) -> dict[str, dict]:
    """This branch's own figures AND tables as ONE mapping payload, keyed by
    item id -- the whole point of tier 1 being per-branch rather than
    per-item. Figures are walked via `skeleton.blocks` (document order, the
    order the model already saw them in section_text) and restricted to
    `skeleton.valid_figure_ids`, which is exactly the CAPTIONED set: an
    uncaptioned figure was never rendered into section_text, has nothing
    informational to reason about scope from, and keeps today's unchanged
    positional-bracket heuristic (uncaptioned_figure_ids) instead.

    Nothing is fetched here that the pipeline doesn't already hold -- the
    caption a figure was given by vision, a table's own caption,
    header-row labels, and first couple of data rows, and the branch's
    section label for physical where-does-this-live context."""
    items: dict[str, dict] = {}
    for block in skeleton.blocks:
        if block.kind != BlockKind.FIGURE:
            continue
        figure_id = (figure_id_by_block_id or {}).get(block.id)
        if figure_id is None or figure_id not in skeleton.valid_figure_ids or figure_id in items:
            continue
        figure = figures_by_figure_id.get(figure_id)
        items[figure_id] = {
            "kind": "figure",
            "section": skeleton.section_label,
            "caption": _mapping_preview(
                figure.caption if figure is not None else None, _MAPPING_CAPTION_PREVIEW_CHARS
            ),
        }
    for table_id, table in skeleton.tables_by_id.items():
        # Per-row requirement splitting (2026-08-26): a table already fully
        # decomposed into its own per-row Requirement nodes (see
        # requirement_list_table_ids' own doc comment on _BranchSkeleton)
        # is not an unplaced artifact needing a home -- offering it here
        # would let stage 3 fold the WHOLE table's HTML into just one of
        # those already-split nodes.
        if table_id in skeleton.requirement_list_table_ids:
            continue
        table_rows = plain_text_rows(table) if table.cells else []
        header_row = table_rows[0] if table_rows else []
        columns = [
            preview
            for cell in header_row[:_MAPPING_TABLE_COLUMN_COUNT]
            if (preview := _mapping_preview(cell, _MAPPING_TABLE_COLUMN_PREVIEW_CHARS)) is not None
        ]
        # A caption-less table with its real title embedded in a merged
        # header row (confirmed live: AirPro_BP_ICD) gives the model
        # nothing but generic column labels to judge scope from -- a
        # couple of real data rows meaningfully helps there, same preview
        # truncation as columns, no row counts/styling/spans/full HTML.
        rows = [
            [
                preview
                for cell in row[:_MAPPING_TABLE_COLUMN_COUNT]
                if (preview := _mapping_preview(cell, _MAPPING_TABLE_COLUMN_PREVIEW_CHARS)) is not None
            ]
            for row in table_rows[1 : 1 + _MAPPING_TABLE_ROW_COUNT]
        ]
        items[table_id] = {
            "kind": "table",
            "section": skeleton.section_label,
            "caption": _mapping_preview(table.caption, _MAPPING_CAPTION_PREVIEW_CHARS),
            "columns": columns,
            "rows": rows,
        }
    return items


def _mapping_candidates(nodes: list[WorkItemNode]) -> dict[str, dict]:
    """Titles only (never descriptions -- there are none yet at this point in
    the pipeline, which is precisely what makes a whole-document candidate
    list affordable), restricted to the nodes stage 3 will actually author.

    An already-described node in a branch's list is one a repair pass
    SYNTHESIZED (a bridge Feature, a topical grouping, a catch-all root
    Epic); each carries a canned "structure only, no content invented"
    description its own pass deliberately wrote, and stage 3 never touches
    it -- so a figure mapped there could never be attached, and attaching
    real document content to a purely structural placeholder would
    contradict what those passes document about themselves. Offering only
    authorable nodes keeps the candidate set exactly equal to the set of
    nodes an accepted verdict can actually reach."""
    return {
        node.local_id: {"type": node.type.value, "title": node.title}
        for node in nodes
        if not node.description
    }


class _MappingBatch(NamedTuple):
    """One mapping LLM call's complete input, plus the bookkeeping its own
    failure/incompleteness warning needs. Built up front, all of them, so the
    calls can run concurrently and be merged back in a fixed order -- see
    _map_figures_tables_to_nodes."""

    candidates: dict[str, dict]
    items: dict[str, dict]
    # False for the escalation tier: there is no third tier, so an item this
    # call leaves unplaced has nowhere further to go.
    allow_escalation: bool
    # Human phrase naming this batch in its own warning message ("the
    # \"Power\" section", "the whole document").
    scope: str
    # Structured companion to `scope` for the warning's detail payload.
    detail: dict


class _MappingBatchResult(NamedTuple):
    """One mapping call's outcome as PLAIN DATA -- deliberately not a set of
    in-place appends to shared lists. Batches run concurrently (see
    _map_figures_tables_to_nodes), and while an individual list.append is
    GIL-atomic, the ORDER appends from different threads land in is not
    deterministic. Returning each batch's own contribution and merging them in
    batch order afterwards makes the whole stage's output byte-identical
    whatever the concurrency setting or completion order."""

    # (node_id, item_id, kind) triples, in this call's own item order.
    attached: list[tuple[str, str, str]]
    # (item_id, kind) pairs -- judged irrelevant, hallucinated-target, or
    # degraded by this batch's own failure.
    excluded: list[tuple[str, str]]
    escalated: list[str]
    warnings: list[IntegrityWarning]


def _run_mapping_batch(
    batch: _MappingBatch,
    map_fn: Callable[[dict[str, dict], dict[str, dict]], dict[str, dict]],
    user_id: str | None = None,
) -> _MappingBatchResult:
    """Makes ONE mapping call and classifies its verdicts. Pure with respect to
    everything outside it (reads only its `batch`, writes only its returned
    result), which is what makes running several of these concurrently safe.

    Every returned node_id is validated against the REAL candidate set THIS
    call was offered; one outside it is a hallucination, dropped with
    WarningKind.INVALID_MAPPING_TARGET, exactly as _author_branch_content
    already treats a hallucinated figure/table id. A dropped verdict is NOT
    re-escalated: the item is excluded instead, keeping this stage's call count
    bounded and predictable (a model that hallucinates once tends to do so
    again, and one bad verdict must never be able to trigger an
    otherwise-unneeded escalation call).

    Fail-open, deliberately -- see _map_figures_tables_to_nodes' docstring for
    why this is the one stage of the three that degrades instead of raising."""
    attached: list[tuple[str, str, str]] = []
    excluded: list[tuple[str, str]] = []
    escalated: list[str] = []
    warnings: list[IntegrityWarning] = []

    def _degraded(reason: str, explanation: str, degraded_items: dict[str, dict]) -> None:
        """One warning for a whole batch's worth of items this call could not
        answer for -- either because it raised, or because it came back
        without them. Both share WarningKind.MAPPING_CALL_FAILED (told apart
        by detail['reason']): the failure is at CALL level either way, not a
        per-item judgment, and the reviewer's reading is identical -- these
        items were never judged, so seeing them among the excluded does NOT
        mean they were found decorative."""
        figure_count = sum(1 for item in degraded_items.values() if item.get("kind") == "figure")
        message = (
            f"Figure/table mapping {explanation} for {batch.scope} -- "
            f"{figure_count} figure(s)/{len(degraded_items) - figure_count} table(s) are listed "
            "as excluded rather than attached to any work item."
        )
        logger.warning(message)
        warnings.append(
            IntegrityWarning.make(
                WarningKind.MAPPING_CALL_FAILED,
                message,
                detail={
                    **batch.detail, "reason": reason, "figureCount": figure_count,
                    "tableCount": len(degraded_items) - figure_count,
                },
            )
        )
        for item_id, item in degraded_items.items():
            excluded.append((item_id, item.get("kind", "figure")))

    try:
        verdicts = map_fn(batch.candidates, batch.items, user_id=user_id)
    except Exception as exc:  # noqa: BLE001 - stage 2 is deliberately fail-open, see _map_figures_tables_to_nodes
        _degraded("call_error", f"failed ({exc})", batch.items)
        return _MappingBatchResult(attached, excluded, escalated, warnings)

    # Defensive, not decorative: this stage's fail-open promise covers a client
    # returning something unexpected just as much as one raising. The real
    # client already coerces a non-object response to {}; a different
    # implementation must not be able to turn a wrong-shaped answer into an
    # AttributeError that fails the whole job.
    verdicts = verdicts if isinstance(verdicts, dict) else {}
    unanswered: dict[str, dict] = {}
    for item_id, item in batch.items.items():
        kind = item.get("kind", "figure")
        entry = verdicts.get(item_id)
        entry = entry if isinstance(entry, dict) else {}
        node_id = entry.get("node_id")
        node_id = node_id if isinstance(node_id, str) and node_id else None
        if node_id is not None:
            if node_id in batch.candidates:
                attached.append((node_id, item_id, kind))
                continue
            message = (
                f"{kind.capitalize()} {item_id} was mapped to a work item that isn't in this "
                f"document ({node_id}) -- the mapping was dropped and the {kind} is listed as "
                "excluded instead."
            )
            logger.warning(message)
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.INVALID_MAPPING_TARGET,
                    message,
                    detail={"itemId": item_id, "itemKind": kind, "requested": node_id},
                )
            )
            excluded.append((item_id, kind))
            continue
        if not entry:
            # No verdict at all for this item -- the model declining to answer
            # (or an over-long response cut short) is not evidence the item
            # belongs anywhere. It gets the next tier's wider candidate set
            # while one is still available; once none is, it is REPORTED as an
            # unanswered item rather than quietly counted as decorative.
            if batch.allow_escalation:
                escalated.append(item_id)
            else:
                unanswered[item_id] = item
            continue
        if batch.allow_escalation and bool(entry.get("escalate")):
            escalated.append(item_id)
            continue
        excluded.append((item_id, kind))

    if unanswered:
        _degraded("incomplete_response", "returned no answer", unanswered)
    return _MappingBatchResult(attached, excluded, escalated, warnings)


def _map_figures_tables_to_nodes(
    branch_skeletons: list[_BranchSkeleton],
    map_fn: Callable[[dict[str, dict], dict[str, dict]], dict[str, dict]],
    figures_by_figure_id: dict[str, Figure],
    figure_id_by_block_id: dict[str, str] | None,
    warnings: list[IntegrityWarning],
    branch_concurrency: int = 1,
    # 'map_scope' narration -- fired once per TIER 1 branch batch and once
    # per TIER 2 escalation chunk, both BEFORE that batch's own call is
    # dispatched (never from inside a worker thread: batches can run
    # concurrently below, and firing here in the single constructing loop
    # keeps every progress_callback invocation on the calling thread, with no
    # lock needed the way build_survey_tree's own concurrent-branch
    # _fire_progress requires). None (the default) is a no-op, matching
    # every other optional narration hook in this module.
    progress_callback: ProgressCallback | None = None,
    blocks_total: int = 0,
    user_id: str | None = None,
) -> tuple[dict[str, dict[str, list[str]]], list[str], list[str]]:
    """STAGE 2 of SURVEY's generation: binds every figure/table in the
    document to ONE exact node id, run AFTER stage 1's skeleton and the
    whole-document structural repair passes have made every node id final,
    and BEFORE stage 3 authors any content against them.

    Two tiers, both BATCHED -- zero per-figure LLM calls at any point:

    - TIER 1, one call per BRANCH (chunked only if a single branch somehow
      exceeds _MAPPING_CHUNK_ITEM_COUNT items), carrying that branch's entire
      figure+table set at once, against that branch's own nodes as candidates.
      This is where the overwhelming majority of items resolve, because a
      figure overwhelmingly documents something in the section it physically
      sits in. Cost scales with branch count, not figure count.
    - TIER 2, only for items tier 1 explicitly ESCALATED (its "this is real
      but its home isn't among these candidates" verdict), chunked the same
      way, against the WHOLE document's nodes as candidates. This is what
      makes cross-branch mapping possible at all -- a figure printed in an
      appendix documenting a requirement stated in chapter 3 -- without paying
      whole-document candidate cost for every item.

    Both tiers' calls run concurrently up to `branch_concurrency`, the SAME
    parallelism stages 1 and 3 already use (a serial stage between two
    parallel ones would insert one sequential LLM round-trip per branch into
    the middle of the pipeline, with no narration during it). Determinism is
    preserved structurally, not by luck: each call's outcome comes back as
    plain data (_MappingBatchResult) and is merged in fixed batch order, so
    the attachment order and both excluded lists are byte-identical to a
    serial run. Tier 2 still runs strictly AFTER tier 1 -- it exists to
    consume tier 1's leftovers.

    This is deliberately the ONE fail-OPEN stage of the three (stages 1 and 3
    both still fail hard, matching this module's existing no-try/except
    convention around analyze_section): any batch whose call raises, or which
    comes back without an answer for an item, degrades the affected items to
    the excluded lists with a WarningKind.MAPPING_CALL_FAILED warning, and the
    job continues. A document losing figure attachment is a degraded result; a
    document losing the whole job is not a result at all. The warning is what
    keeps that degradation honest -- without it those items would be
    indistinguishable from genuinely decorative ones in the same list.

    Returns (figure_table_ids_by_local_id, excluded_figure_ids,
    excluded_table_ids): the first is _author_branch_content's own stage-2
    seam ({local_id: {'figure_ids': [...], 'table_ids': [...]}}), the other
    two are WorkItemTree's doc-wide excluded lists -- every item this stage
    sees ends up in exactly one of the two, never silently nowhere. (One
    downstream exception, unchanged by this stage and already reported on its
    own: stage 3 still drops a mapped table whose extracted grid turns out to
    have no content at all, with WarningKind.EMPTY_TABLE_CONTENT, rather than
    shipping a table_ids entry with nothing behind it.)

    `progress_callback`/`blocks_total`: optional 'map_scope' narration, fired
    once per TIER 1 branch batch and once per TIER 2 escalation chunk (see
    _fire_map_scope below) -- this stage previously narrated nothing at all.
    None (the default) is a no-op, matching every other optional narration
    hook in this module."""
    mapping: dict[str, dict[str, list[str]]] = {}
    excluded_figure_ids: list[str] = []
    excluded_table_ids: list[str] = []
    items_by_id: dict[str, dict] = {}

    def _merge(results: list[_MappingBatchResult]) -> list[str]:
        """Folds every batch's plain-data outcome into this stage's shared
        state, in BATCH ORDER -- the single place any of it is mutated."""
        escalated: list[str] = []
        for result in results:
            for node_id, item_id, kind in result.attached:
                entry = mapping.setdefault(node_id, {"figure_ids": [], "table_ids": []})
                entry["figure_ids" if kind == "figure" else "table_ids"].append(item_id)
            for item_id, kind in result.excluded:
                (excluded_figure_ids if kind == "figure" else excluded_table_ids).append(item_id)
            escalated.extend(result.escalated)
            warnings.extend(result.warnings)
        return escalated

    def _run(batches: list[_MappingBatch]) -> list[_MappingBatchResult]:
        """Same submission/collect-by-index pattern stages 1 and 3 use --
        results are gathered by INDEX, never by completion order."""
        if branch_concurrency <= 1 or len(batches) <= 1:
            return [_run_mapping_batch(batch, map_fn, user_id=user_id) for batch in batches]
        with ThreadPoolExecutor(max_workers=branch_concurrency) as executor:
            futures = [
                executor.submit(_run_mapping_batch, batch, map_fn, user_id=user_id) for batch in batches
            ]
            return [future.result() for future in futures]

    def _chunks(item_ids: list[str]) -> list[list[str]]:
        return [
            item_ids[start : start + _MAPPING_CHUNK_ITEM_COUNT]
            for start in range(0, len(item_ids), _MAPPING_CHUNK_ITEM_COUNT)
        ]

    # 'map_scope' narration -- fired here, in the single batch-CONSTRUCTING
    # loop, for every batch about to be handed to _run() (which may dispatch
    # several of them concurrently across worker threads below). Firing
    # before dispatch rather than from inside _run_mapping_batch itself keeps
    # every progress_callback call on this one calling thread, so this stage
    # needs no lock the way build_survey_tree's own concurrent-branch
    # _fire_progress does. branch_index=None (this is a whole-document-scope
    # phase, same convention detect_conflicts/infer_trace_links use) --
    # batch.scope is this batch's own human-readable "the X section"/"the
    # whole document" label, carried as section_label so a reviewer can tell
    # which batch is in flight.
    def _fire_map_scope(batch: _MappingBatch) -> None:
        if progress_callback is None:
            return
        progress_callback(
            LevelingProgress(
                phase="map_scope", branch_index=None, branch_count=len(branch_skeletons),
                # blocks_done == blocks_total, the convention EVERY other
                # whole-document phase follows (detect_conflicts,
                # regroup_roots, infer_trace_links): every branch's blocks
                # have been through stage 1 by the time mapping runs. This
                # was hardcoded to 0, which is not inert -- it renders
                # verbatim in ProgressBanner's metrics chip ("0 / 682
                # blocks") and in this phase's own narration message
                # ("-- 0 of 682 blocks") for the whole mapping window.
                blocks_done=blocks_total, blocks_total=blocks_total,
                kb_grounded=False, kb_citations=[],
                section_label=batch.scope,
            )
        )

    # TIER 1 -- one call per branch, that branch's whole figure/table set
    # against that branch's own nodes.
    tier1_batches: list[_MappingBatch] = []
    pre_escalated: list[str] = []
    for skeleton in branch_skeletons:
        branch_items = _mapping_items_for_branch(
            skeleton, figures_by_figure_id, figure_id_by_block_id,
        )
        if not branch_items:
            continue
        items_by_id.update(branch_items)
        candidates = _mapping_candidates(skeleton.nodes)
        if not candidates:
            # Nothing in this branch to attach to (a branch that produced no
            # authorable node at all -- already warned about separately by
            # stage 1's ZERO_NODES check). Straight to tier 2 rather than a
            # guaranteed-empty call.
            pre_escalated.extend(branch_items)
            continue
        scope = (
            f'the "{skeleton.section_label}" section' if skeleton.section_label else "one section"
        )
        for chunk_index, chunk_ids in enumerate(_chunks(list(branch_items))):
            batch = _MappingBatch(
                candidates=candidates,
                items={item_id: branch_items[item_id] for item_id in chunk_ids},
                allow_escalation=True,
                scope=scope,
                detail={
                    "tier": 1, "branch": skeleton.node_id_prefix or "(root)",
                    "chunkIndex": chunk_index,
                },
            )
            _fire_map_scope(batch)
            tier1_batches.append(batch)

    escalated_ids = pre_escalated + _merge(_run(tier1_batches))
    if not escalated_ids:
        return mapping, excluded_figure_ids, excluded_table_ids

    # TIER 2 -- only the genuinely-escalated leftovers, against the WHOLE
    # document's authorable nodes (titles only), chunked so one call's output
    # can't be truncated by the model's own output cap.
    doc_candidates = _mapping_candidates(
        [node for skeleton in branch_skeletons for node in skeleton.nodes]
    )
    if not doc_candidates:
        for item_id in escalated_ids:
            kind = items_by_id[item_id].get("kind", "figure")
            (excluded_figure_ids if kind == "figure" else excluded_table_ids).append(item_id)
        return mapping, excluded_figure_ids, excluded_table_ids

    # allow_escalation=False: there is no third tier -- an item still unplaced
    # after being offered every node in the document has no home, which is
    # exactly what the excluded lists mean.
    tier2_batches: list[_MappingBatch] = []
    for chunk_index, chunk_ids in enumerate(_chunks(escalated_ids)):
        batch = _MappingBatch(
            candidates=doc_candidates,
            items={item_id: items_by_id[item_id] for item_id in chunk_ids},
            allow_escalation=False,
            scope="the whole document",
            detail={"tier": 2, "chunkIndex": chunk_index},
        )
        _fire_map_scope(batch)
        tier2_batches.append(batch)
    _merge(_run(tier2_batches))
    return mapping, excluded_figure_ids, excluded_table_ids


def _author_branch_content(
    skeleton: _BranchSkeleton,
    analysis_client: SectionAnalysisClient,
    # STAGE 2 seam: the whole-document figure/table MAPPING pass's verdicts,
    # {local_id: {"figure_ids": [...], "table_ids": [...]}} -- see
    # _map_figures_tables_to_nodes. Passed WHOLE, not pre-filtered to this
    # branch: the per-node lookup below only ever reads this branch's own
    # local_ids, so a cross-branch verdict (tier 2 placing an appendix figure
    # onto a chapter-3 requirement) reaches exactly the branch owning its
    # target node. None when no mapping client was available at all, in which
    # case every node simply keeps WorkItemNode's own empty-list defaults.
    # Mapping verdicts get exactly the same hallucinated-id filtering and
    # table-HTML fold-in the model's own inline figure_ids/table_ids used to
    # get.
    figure_table_ids_by_local_id: dict[str, dict[str, list[str]]] | None = None,
    # 300553 smart-title fallback -- see build_survey_tree's own doc comment
    # for this param. None (the default): every title stands as stage 1
    # produced it, byte-identical to before this capability existed.
    title_distillation_client: TitleDistillationClient | None = None,
    user_id: str | None = None,
) -> _BranchContentResult:
    """STAGE 3 of SURVEY's two-stage per-branch generation: authors each
    node's requirement/description text and tags via ONE author_content call
    per branch, GIVEN the tree stage 1 decided and the whole-document repair
    passes then finalized. The model is told the hierarchy is FIXED -- this
    call may not add, drop, re-type, re-parent or rename a node, only fill in
    the ones already there (see the author_content prompt).

    Only nodes stage 1 left with an EMPTY description are offered for
    authoring. Everything else in `skeleton.nodes` is a node one of the
    repair passes synthesized (a bridge Feature, a topical grouping) whose
    canned "structure only, no content invented" description is deliberate
    and must survive untouched -- the same never-invent-content discipline
    those passes already document for themselves.

    A node the response omits, or answers with a blank description, keeps
    its own title as its description instead: honest, already grounded in
    the source (stage 1 derived it from this same section), and far better
    than shipping an empty work item or dropping a node the structural
    stage already committed to. Reported, never silent.

    fidelity_hash is computed here rather than in stage 1, over the FINAL
    description, since that's the content actually written to ADO and the
    idempotency map's key must match what a re-run would produce — but note
    this is a WEAKER guarantee than BASELINE's verbatim-source-span hash:
    temperature=0 is mostly-but-not-guaranteed deterministic, so a model or
    prompt change can shift this hash and produce a duplicate create on
    re-run. Embedding dedup partially backstops this; it is not a substitute.

    Fails hard, deliberately -- no try/except around the authoring call, the
    same convention stage 1 and the single analyze_section call before it
    both follow."""
    nodes = skeleton.nodes
    warnings = skeleton.warnings
    section_text = skeleton.section_text
    valid_tag_values = {t.value for t in RequirementTag}
    # 300553: local_ids whose stage-1 title got replaced below because it was
    # too generic/short AND a real description now exists to distill a
    # better one from -- collected into ONE combined info-level warning at
    # the end of this branch, same one-per-run convention as every other
    # collect-and-warn list in this module.
    distilled_title_local_ids: list[str] = []

    # 'analyze_section' is stage 3's own wire name -- its existing copy
    # ("Analyzing and synthesizing requirements") is, if anything, MORE
    # accurate now that stage 1 narrates its structure-only work as
    # 'build_skeleton' instead of reusing this label. Fired at the very top,
    # before the author_content call below, because without it stage 3 --
    # typically the longest of a branch's three calls -- narrated NOTHING
    # from the end of stage 2's mapping pass until this branch's own
    # section_complete: a full silent window during which the UI kept showing
    # the last 'map_scope' line, actively misreporting what the pipeline was
    # doing. Same closure stage 1 built (see _BranchSkeleton.fire), so this
    # reports the identical branch coordinates its build_skeleton and
    # section_complete events do.
    #
    # kb_grounded/kb_citations_raw mirror section_complete's own call below
    # (this branch's real stage-1 citations), NOT bool(kb_context) -- see the
    # comment there for why.
    skeleton.fire(
        "analyze_section",
        kb_grounded=bool(skeleton.kb_citations),
        kb_citations_raw=[{"source_file": c.source_file, "similarity": c.similarity} for c in skeleton.kb_citations],
    )

    # An empty description is exactly the "still awaiting authoring" marker
    # stage 1 leaves behind -- see _BranchSkeleton's own docstring.
    authorable = [node for node in nodes if not node.description]
    if authorable:
        skeleton_payload = {
            node.local_id: {
                "type": node.type.value,
                "title": node.title,
                # Informational context for authoring, never something this
                # call may change. May legitimately name a node OUTSIDE this
                # payload -- a synthesized grouping node, or (after
                # whole-document regrouping) a node belonging to no branch at
                # all; the prompt asks only that the tree be respected, never
                # that every parent_id resolve within the payload.
                "parent_id": node.parent_local_id,
            }
            for node in authorable
        }
        content, truncated = analysis_client.author_content(
            section_text, skeleton_payload, kb_context=skeleton.scoring_kb_context, user_id=user_id,
        )
        if truncated:
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.OUTPUT_TRUNCATED,
                    "Model output was truncated by the token limit while writing this section's "
                    "requirement text -- some items may have fallen back to their title; "
                    "consider raising the model's output cap.",
                    detail={"branch": skeleton.node_id_prefix or "(root)", "stage": "content"},
                )
            )
    else:
        content = {}

    unauthored: list[WorkItemNode] = []
    for node in authorable:
        entry = content.get(node.local_id)
        entry = entry if isinstance(entry, dict) else {}
        text = entry.get("description")
        # 300553: a node that fell back to its own title as its description
        # (below) has nothing new to distill a title FROM -- distilling
        # "text" back into a title would just regenerate roughly the same
        # short string at the cost of a wasted LLM call, so smart-title
        # correction later in this loop is skipped for these.
        used_title_as_description = not isinstance(text, str) or not text.strip()
        if used_title_as_description:
            # See this function's own docstring: degrade to the title stage 1
            # already derived from this same section rather than shipping an
            # empty work item or silently dropping a node the structural
            # stage committed to.
            unauthored.append(node)
            text = node.title
        # Requirement-only -- classification is a per-Requirement attribute
        # (see WorkItemNode.tags's own docstring); Epic/Feature never carry
        # one, even though `authorable` above is NOT type-gated (every node
        # starts with an empty description, so Epic/Feature nodes pass
        # through this same loop to get their own descriptions authored).
        # Confirmed real bug this closes: author_content's prompt used to
        # ask for `tags` on every node id including Epic/Feature, and this
        # assignment applied whatever the model returned with no type check
        # at all.
        node.tags = (
            sorted(
                {RequirementTag(tag) for tag in (entry.get("tags") or []) if tag in valid_tag_values},
                key=lambda t: t.value,
            )
            if node.type == WorkItemType.REQUIREMENT
            else []
        )

        # known-issues item 20: a figure/table id outside what stage 2
        # actually OFFERED (see build_survey_tree's own comment on why that
        # set is document-wide once mapping has run, and branch-scoped
        # otherwise) is a hallucination -- an id that doesn't exist, or one
        # belonging to an uncaptioned figure that was never a mapping
        # candidate -- and is dropped, never trusted verbatim. A no-op when
        # no mapping ran at all: both sides are then empty.
        mapping = (figure_table_ids_by_local_id or {}).get(node.local_id) or {}
        raw_figure_ids = mapping.get("figure_ids") or []
        figure_ids = sorted({fid for fid in raw_figure_ids if isinstance(fid, str) and fid in skeleton.valid_figure_ids})
        if len(figure_ids) < len(raw_figure_ids):
            dropped_figure_count = len(raw_figure_ids) - len(figure_ids)
            message = (
                f'"{node.title}" referenced {dropped_figure_count} figure(s) not offered in this section -- '
                "the invalid reference(s) were dropped."
            )
            logger.warning(message)
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.INVALID_FIGURE_IDS,
                    message,
                    node_ids=[node.local_id],
                    detail={"requested": raw_figure_ids, "kept": figure_ids},
                )
            )
        raw_table_ids = mapping.get("table_ids") or []
        # Per-row requirement splitting (2026-08-26): a requirements-list
        # table is never offered to stage 2's mapping pass at all (see
        # _mapping_items_for_branch), so a real mapping verdict can never
        # legitimately name one -- but the model still SEES that table's
        # literal id rendered inline in section_text (render_section injects
        # it unconditionally), so a hallucinated claim naming it anyway must
        # be rejected here too, same treatment as any other id outside what
        # stage 2 actually offered.
        table_ids_requested = sorted({
            tid for tid in raw_table_ids
            if isinstance(tid, str) and tid in skeleton.valid_table_ids and tid not in skeleton.requirement_list_table_ids
        })
        if len(table_ids_requested) < len(raw_table_ids):
            dropped_table_count = len(raw_table_ids) - len(table_ids_requested)
            message = (
                f'"{node.title}" referenced {dropped_table_count} table(s) not offered in this section -- '
                "the invalid reference(s) were dropped."
            )
            logger.warning(message)
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.INVALID_TABLE_IDS,
                    message,
                    node_ids=[node.local_id],
                    detail={"requested": raw_table_ids, "kept": table_ids_requested},
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
        #
        # table_id is only KEPT in table_ids when its HTML is genuinely
        # non-empty -- computed together, not separately: a valid
        # (non-hallucinated, already filtered above) reference whose
        # extracted grid has no content anywhere (_table_to_html returns ""
        # for it) is dropped here instead of ending up in table_ids with
        # nothing in description to back it. The orchestrator's own
        # dry-run.service.ts documents an invariant that a non-empty
        # table_ids entry always means that table's HTML is already
        # embedded in description -- silently keeping the id here would
        # violate that invariant and ship a UI chip pointing at zero
        # content. Reported instead of just dropped, same "under-trigger
        # silently, surface loudly" convention as every other warning in
        # this loop.
        description = text
        table_ids: list[str] = []
        for table_id in table_ids_requested:
            table = skeleton.tables_by_id.get(table_id)
            if table is None:
                continue
            table_html = _table_to_html(table)
            if table_html:
                description = assemble_description(description, table_html)
                table_ids.append(table_id)
            else:
                message = (
                    f'"{node.title}" referenced table {table_id}, but it had no extractable content -- '
                    "worth checking the source table manually."
                )
                logger.warning(message)
                warnings.append(
                    IntegrityWarning.make(
                        WarningKind.EMPTY_TABLE_CONTENT,
                        message,
                        node_ids=[node.local_id],
                        detail={"tableId": table_id},
                    )
                )
        node.figure_ids = figure_ids
        node.table_ids = table_ids
        node.description = description
        # FALLBACK ONLY: stage 1's own model-reported, source-verified
        # customer_id (see _validated_skeleton_customer_id) is the PRIMARY
        # mechanism -- the model reads the raw table cell for the row it
        # decided this node came from, so it is right regardless of the
        # table's shape, column order or numbering convention, all of
        # which this regex can only guess at. This still runs for every
        # Requirement stage 1 left without one: a table folded into
        # `description` above (table_ids != []) still carries its own
        # literal code verbatim in the raw cell text, so this can still
        # find a real one, honestly, whenever it's there.
        #
        # A raw regex search over the whole description or over just the
        # embedded <table>...</table> HTML both risk matching an unrelated
        # cited product/protocol designator that happens to be code-shaped
        # but is really a category label, not a repeating id column --
        # being inside a genuine source table doesn't by itself make a
        # code-shaped cell this node's own identifier.
        #
        # requirement_rows.repeated_customer_code_in_table is the actual
        # fix: trusts a code only when the SAME column repeats a whole-
        # cell match at least twice in the REAL Table object this node's
        # own table_ids already resolved to (skeleton.tables_by_id).
        # Deliberately NOT qualifying_requirement_rows's own full gate:
        # that function's 50%-of-rows fraction requirement is the "should
        # this whole table be pre-split into its own per-row nodes at
        # stage 1" decision (see doc_requirement_rows/Phase 6 above) -- a
        # table that met THAT gate is already excluded from ever reaching
        # this point, so re-checking the same full gate here would always
        # read empty.
        #
        # Belt-and-suspenders, not a replacement -- and honest on both
        # paths: an absent code stays a real None either way, never
        # invented, and main.py's exit pass still surfaces the gap
        # (MISSING_SOURCE_REFERENCE) regardless of which mechanism was
        # tried. Requirement-only, same gate every other per-Requirement
        # field in this codebase uses. Live bug history:
        # docs/handoff-heading-tier-detector-and-customer-id-fixes.md.
        if node.type == WorkItemType.REQUIREMENT and not node.customer_id:
            for table_id in table_ids:
                table = skeleton.tables_by_id.get(table_id)
                if table is None:
                    continue
                code = repeated_customer_code_in_table(table)
                if code:
                    node.customer_id = code
                    break
        # Hashes the FINAL description (text plus any embedded table HTML),
        # not just `text` -- fidelity_hash exists to detect drift in the
        # actual persisted field; hashing `text` alone would never notice a
        # change to the embedded table half.
        node.fidelity_hash = hashlib.sha256(description.encode()).hexdigest()

        # 300553 smart-title fallback: stage 1 named this node before any
        # content existed, so a vague/generic title (e.g. "Requirement") is
        # possible even though a perfectly good real description now exists
        # to distill a better title FROM. Skipped for a node that fell back
        # to its own title as its description above -- there's nothing new
        # to distill from in that case (see the flag's own comment).
        if (
            title_distillation_client is not None
            and not used_title_as_description
            and title_is_low_quality(node.title)
        ):
            node.title = distill_survey_title(node.description, title_distillation_client, user_id=user_id)
            distilled_title_local_ids.append(node.local_id)

        grounding_score = _grounding_score(text, section_text)
        node.grounding_score = grounding_score
        if grounding_score < _LOW_GROUNDING_THRESHOLD:
            message = (
                f'"{node.title}"\'s generated description has low grounding '
                f"({grounding_score:.0%} of its vocabulary traces back to the source section) -- "
                "worth reviewing for possible fabrication."
            )
            logger.warning(message)
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.LOW_GROUNDING,
                    message,
                    node_ids=[node.local_id],
                    detail={"groundingScore": grounding_score, "threshold": _LOW_GROUNDING_THRESHOLD},
                )
            )

    if distilled_title_local_ids:
        message = (
            f"{len(distilled_title_local_ids)} node title(s) in this section were too generic/short "
            "to be useful and were replaced with a title distilled from the node's own generated "
            "description."
        )
        logger.info(message)
        warnings.append(
            IntegrityWarning.make(
                WarningKind.SURVEY_TITLE_DISTILLED,
                message,
                node_ids=distilled_title_local_ids[:10],
                detail={"branch": skeleton.node_id_prefix or "(root)", "totalDistilled": len(distilled_title_local_ids)},
            )
        )

    if unauthored:
        previews = ", ".join(f'"{node.title}"' for node in unauthored[:10])
        message = (
            f"Content authoring returned no requirement text for {len(unauthored)} of "
            f"{len(authorable)} work item(s) in this section -- each fell back to its own title "
            f"as its description: {previews}"
        )
        logger.warning(message)
        warnings.append(
            IntegrityWarning.make(
                WarningKind.ENHANCEMENT_RESPONSE_INCOMPLETE,
                message,
                node_ids=[node.local_id for node in unauthored[:10]],
                detail={
                    "pass": "content_authoring",
                    "branch": skeleton.node_id_prefix or "(root)",
                    "missing": len(unauthored),
                    "requested": len(authorable),
                },
            )
        )

    # Coverage check: since section analysis can merge N input blocks into
    # M != N nodes, there is no 1:1 node<->block mapping left to check
    # per-block coverage against -- instead, run each INPUT block's own text
    # against the combined generated node texts as a whole (same helper the
    # old two-call design used for its own "merged, not dropped" signal).
    # Computed once, not per block -- see _block_content_appears_in_generated_output's
    # own docstring for why recomputing this inside the loop was O(blocks * chars).
    blocks = skeleton.blocks
    combined_words = _significant_words(" ".join(node.description for node in nodes))
    # resolve_block_depth(block)[1] was previously called 2x per block below
    # (once per boolean check in the comprehension) plus again for the
    # preview line -- resolved once per block here instead.
    resolved_block_texts = [resolve_block_depth(block)[1] for block in blocks]
    # A block that references an external artifact (e.g. "ReqID XXXX") gets
    # its own, far more actionable warning (see
    # _referenced_attachment_warnings, fired in stage 1) -- reporting it a
    # second time as a generic "dropped block" would double-report the same
    # root cause under two different messages for the same block.
    dropped_blocks = [
        i
        for i, block in enumerate(blocks)
        if not (block.kind == BlockKind.FIGURE and _figure_line(block) is None)
        # A loader diagnostic NOTE block gets its own, far more actionable
        # UNSUPPORTED_CONTENT_NOTE warning (see _unsupported_content_warnings)
        # -- reporting it a second time here as a generic dropped block would
        # double-report the same root cause under two different messages,
        # same reasoning as the FIGURE-none and external-reference exclusions
        # on this same line.
        and not _is_unsupported_content_note(block)
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
                detail={"branch": skeleton.node_id_prefix or "(root)", "droppedIndices": dropped_blocks[:10], "totalBlocks": len(blocks)},
            )
        )

    # Quality scoring is whole-document scope (see _score_all_requirements,
    # called once from build_survey_tree after every branch has been
    # authored) -- this branch's Requirement-type nodes are still unscored
    # (quality_score=None) at this point; scoring runs in a later pass and
    # mutates them in place. See build_survey_tree's docstring for why
    # (fewer, larger scoring calls instead of one per branch -- same
    # token-efficiency motivation as this module's other batching decisions).

    # The real "parsed and formatted response" for this section -- fired
    # once per branch, right after its content exists, rather than waiting
    # for the whole job to reach diff_ready before a reviewer can see what
    # THIS section actually produced. quality_score is always None here
    # (scoring is a later, whole-document pass -- see the comment above) --
    # the frontend patches it in once score_requirements_done fires.
    #
    # kb_grounded/kb_citations_raw use THIS branch's own `kb_citations` (built
    # in stage 1 from either the agentic path's real query_kb hits, or the
    # fallback path's precomputed doc-level context) -- NOT `bool(kb_context)`.
    # `kb_context` is only ever non-None on the fallback (non-tool-capable
    # model) path; on the agentic path it stays None even when the model DID
    # ground itself via real query_kb calls, which made every agentic-path
    # narration event report "not grounded" regardless of what the model
    # actually did. Confirmed live once a genuinely tool-capable local model
    # (gemma4:12b) started actually taking the agentic path.
    skeleton.fire(
        "section_complete",
        kb_grounded=bool(skeleton.kb_citations),
        kb_citations_raw=[{"source_file": c.source_file, "similarity": c.similarity} for c in skeleton.kb_citations],
        section_nodes=[
            {
                "type": node.type.value, "title": node.title, "text": node.description,
                "quality_score": node.quality_score,
                # Live UI visibility for the per-row splitting fix (2026-08-26):
                # a reviewer watching the run see this node's own model-
                # reported/regex-fallback customer_id as soon as it's decided,
                # not only once the whole job reaches diff_ready.
                "customer_id": node.customer_id,
            }
            for node in nodes
        ],
    )

    return _BranchContentResult(
        warnings=warnings,
        kb_citations=skeleton.kb_citations,
        scoring_kb_context=skeleton.scoring_kb_context,
    )
