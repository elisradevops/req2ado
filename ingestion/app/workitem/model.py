from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field

from app.canonical.model import SourceRef


class WorkItemType(str, Enum):
    EPIC = "Epic"
    FEATURE = "Feature"
    REQUIREMENT = "Requirement"


class WorkItemMode(str, Enum):
    BASELINE = "BASELINE"
    SURVEY = "SURVEY"


class KbCitationRelevance(str, Enum):
    """Verdict from an LLM relevance-verification call (see
    app.survey.orchestrator_llm_client.OrchestratorLlmClient.judge_kb_relevance)
    judging whether a retrieved KB snippet was actually relevant to the
    branch it was offered to, not just above the retrieval similarity
    cutoff. `unknown` means verification wasn't run (e.g. the call failed --
    KB grounding itself must never fail a SURVEY job, so a failed
    verification degrades to `unknown`, not to blocking the job)."""

    RELEVANT = "relevant"
    NOT_RELEVANT = "not_relevant"
    UNKNOWN = "unknown"


class KbCitation(BaseModel):
    source_file: str
    similarity: float
    relevance: KbCitationRelevance = KbCitationRelevance.UNKNOWN


# Per-dimension 0-100 breakdown backing the single overall quality_score
# below -- added because a lone number (e.g. 40) with only a closed-
# vocabulary issue TAG list (e.g. ['ambiguous', 'vague_term']) told a
# reviewer THAT something was wrong but not HOW WRONG, nor what was
# actually fine. Each dimension is its own independent judgment call from
# the same scoring prompt (see
# orchestrator_llm_client.score_requirements_for_document), not derived
# mechanically from the issue tags.
#
# A dynamic key->0-100-score dict, NOT a fixed 5-field model -- confirmed
# real gap (user-reported): when an org has ingested its own quality-
# checklist standard into the Knowledge Base (e.g. a 10-item Necessary/
# Correct level/Unambiguous/.../Modifiable checklist), the model derives
# categoryScores keys FROM that document's own checklist instead of being
# locked to a fixed clarity/testability/atomicity/style/rationale vocabulary
# that ignores it. The 5-dimension scheme (mapping onto
# RequirementQualityIssue's 7 tags: clarity=ambiguous/vague_term,
# testability=not_testable/missing_acceptance_criteria, atomicity=compound,
# style=passive_voice, rationale=missing_rationale) is used ONLY as the
# fallback when no KB standard is available -- see
# score_requirements_for_document's own docstring.
QualityCategoryScores = dict[str, int]


class RequirementQualityIssue(str, Enum):
    """Closed vocabulary of quality issues a SURVEY requirement's final
    formalized description can be flagged with, judged against
    EARS/INCOSE/ISO/IEC/IEEE-29148 criteria baked into the scoring prompt,
    optionally grounded against retrieved reference criteria (see
    app.quality.criteria_retrieval.CriteriaRetriever) and/or KB citations
    (see app.kb.retrieval). An issue string from the LLM outside this set is
    silently dropped, same tolerant philosophy as RequirementTag."""

    AMBIGUOUS = "ambiguous"
    NOT_TESTABLE = "not_testable"
    COMPOUND = "compound"
    MISSING_ACCEPTANCE_CRITERIA = "missing_acceptance_criteria"
    VAGUE_TERM = "vague_term"
    PASSIVE_VOICE = "passive_voice"
    MISSING_RATIONALE = "missing_rationale"
    # Confirmed real gap (deterministic-hierarchy quality investigation):
    # every tag above presupposes the input IS a requirement statement --
    # none of them can express "this candidate isn't a requirement at all,"
    # so a bare table-cell fragment or heading (e.g. "Size: 3U 1\"") scored
    # as if it were a well-formed, fully atomic requirement (atomicity=100)
    # with no tag available to say why that's wrong.
    NOT_A_REQUIREMENT = "not_a_requirement"
    FRAGMENT = "fragment"
    PLACEHOLDER = "placeholder"
    OPEN_ITEM_TBD = "open_item_tbd"
    RATIONALE_AS_REQUIREMENT = "rationale_as_requirement"
    CONFLICTING_VALUE = "conflicting_value"


class RequirementTag(str, Enum):
    FUNCTIONAL = "functional"
    NON_FUNCTIONAL = "non_functional"
    INTERFACE = "interface"
    PERFORMANCE = "performance"
    REGULATORY = "regulatory"
    SAFETY = "safety"
    SECURITY = "security"
    OPERATION = "operation"
    MAINTENANCE = "maintenance"
    FEATURE = "feature"
    BEHAVIOR = "behavior"


class TraceLinkTargetKind(str, Enum):
    INTRA_JOB = "intraJob"
    CROSS_JOB = "crossJob"


class TraceLinkResolutionStatus(str, Enum):
    RESOLVED = "resolved"
    UNRESOLVED = "unresolved"
    PENDING = "pending"


class TraceLink(BaseModel):
    """One trace/coverage link inferred by SURVEY's infer_trace_links call
    (see llm_leveling.py). Lives on WorkItemTree, not per-node — mirrors
    kb_citations — since most nodes carry zero links and a per-node field
    would churn every node's schema for a feature most won't use."""

    source_local_id: str
    reference_name: str
    display_name: str
    target_kind: TraceLinkTargetKind
    target_local_id: str | None = None
    target_customer_id: str | None = None
    resolution_status: TraceLinkResolutionStatus


class WorkItemNode(BaseModel):
    local_id: str
    type: WorkItemType
    parent_local_id: str | None
    title: str = Field(max_length=256)
    description: str
    # Per-Requirement, document-derived attribute -- the requirement's own
    # source reference number (e.g. "1.1.2.2"), populated ONLY for a
    # Requirement-type node and ONLY from a real document-authored
    # identifier (never fabricated). Every Epic/Feature, and every
    # Requirement with no real identifier to extract, is None -- see
    # main.py's /level exit enforcement pass, which flags a None here for
    # human review rather than inventing a value. NOT a job/document-level
    # concept: unrelated to the orchestrator's own idempotency key
    # (sourceHash, areaPath), which this field is never part of.
    customer_id: str | None = None
    # Per-Requirement, like customer_id -- but NEVER auto-populated from the
    # document by ingestion, under any circumstance. A manually-entered
    # forward reference to a Systems Engineering requirements-layer
    # artifact this Requirement is a basis for coverage of (the customer
    # spec's own "a basis for coverage by the Systems-Engineering
    # requirements layer" language) -- deliberately just a hook to hold a
    # future reference, not a resolved relation: no matching logic, no new
    # work-item type, no ADO relation exist for this field. Always None out
    # of ingestion; a reviewer fills it in via editDiffEntry before confirm
    # (orchestrator-side), exactly like a Customer ID ingestion couldn't
    # auto-detect.
    se_coverage_ref: str | None = None
    source_ref: SourceRef
    fidelity_hash: str | None = None
    # Distinct from fidelity_hash, which exists purely for drift detection
    # (verify_fidelity: does this node's CURRENT description still match its
    # recorded hash). identity_hash exists for the orchestrator's idempotency
    # lookup (source_hash, area_path) -> System.Id -- it must
    # distinguish two nodes whose description happens to be byte-identical
    # but come from different places in the source document (e.g. a genuine
    # verbatim repeat like "GA2 shall be replaced to signal
    # PS_INPUT_FAIL_L." appearing twice in the AirPro ICD, at two different
    # requirement IDs -- both must ingest as distinct work items on first
    # ingest, not collapse into one via a shared fidelity_hash). Folds
    # description + this node's OWN, never-changing source position
    # (document_path + start_offset) into the hash -- recomputed alongside
    # fidelity_hash on every description fold (see tree_builder.py), using
    # the position of the block/table that ORIGINALLY created this node
    # (source_ref itself never changes across folds, only description
    # does). None for a node shape that predates this field (e.g. an older
    # fixture) -- optional so this is purely additive.
    identity_hash: str | None = None
    tags: list[RequirementTag] = Field(default_factory=list)
    # Populated by ALL FOUR node-building paths (BASELINE, the deterministic
    # heading/ID-tree path, the deterministic span-fold, and SURVEY's LLM
    # branch) -- not SURVEY-only, despite this field's original SURVEY-only
    # history. For SURVEY, these are which of a section's candidate
    # figures/tables the LLM judged relevant to this specific node (see
    # llm_leveling.render_section's figure/table id injection and
    # _author_branch_content's figure_ids/table_ids validation against the
    # section's real candidate ids, which _build_survey_skeleton_for_branch
    # collected -- a model-hallucinated id that doesn't match any real
    # Figure/Table in scope is dropped, never trusted verbatim; both stay
    # empty until the whole-document mapping pass that decides them lands).
    # For the deterministic paths, these are simply every
    # figure/table whose block/span folded into this node -- no LLM
    # judgment involved. []/[] for a node with no associated figures/tables.
    # table_ids additionally drives embedding that table's HTML into
    # description (see _table_to_html) -- figure_ids does not yet drive an
    # attachment (no ADO upload capability exists; see known-issues item 20
    # piece (d)), it is currently link-only.
    figure_ids: list[str] = Field(default_factory=list)
    table_ids: list[str] = Field(default_factory=list)
    # Figures that folded into this node's span but produced NO caption --
    # vision disabled, the vision call failed/errored, or the model itself
    # judged the figure insignificant (_figure_line returns None
    # in all three cases, so nothing about the figure reaches `description`
    # and it would otherwise be invisible to a reviewer). Disjoint from
    # figure_ids: a figure id appears in exactly one of the two lists, never
    # both. The review UI renders this as a distinct "figure present but
    # undescribed" signal rather than folding it into a plain figure count,
    # since a silently-dropped figure is exactly the kind of pipeline
    # correctness issue a reviewer needs to catch.
    uncaptioned_figure_ids: list[str] = Field(default_factory=list)
    # SUBSET of uncaptioned_figure_ids (never disjoint from it, every id here
    # also appears there) -- the figures among that list whose Figure.
    # caption_status == "insignificant" (the vision model judged them
    # decorative/non-technical, not a failed vision call). Only meaningful
    # when vision was actually active for this run; deliberately NOT
    # populated to distinguish "vision disabled" from a genuine failure --
    # that whole-run case is covered once, at the tree level, by
    # WarningKind.VISION_CAPTIONING_DISABLED instead. An uncaptioned figure
    # id absent from this list (but present in uncaptioned_figure_ids) is a
    # genuine vision_failed case (or vision was off for the whole run).
    # Populated at every one of uncaptioned_figure_ids' own append/assignment
    # sites (tree_builder.py x3, llm_leveling.py x2) -- see that field's own
    # docstring for the disjoint-from-figure_ids guarantee this list doesn't
    # change.
    insignificant_figure_ids: list[str] = Field(default_factory=list)
    mode: WorkItemMode
    # The work-item type a NEW manual child entry added under this node
    # should default to (see orchestrator's JobsService.addDiffEntry) —
    # None when this node isn't eligible to receive a manual child (e.g. a
    # leaf Requirement) or the type couldn't be inferred.
    child_type: WorkItemType | None = None
    # SURVEY-only: how much of the LLM-generated description's vocabulary
    # actually appears in the source block's own text (see
    # llm_leveling._grounding_score) -- a cheap, deterministic signal for
    # "did the model paraphrase the source, or invent unrelated content",
    # since the LLM's output was previously trusted verbatim with zero
    # comparison against its source span. None for BASELINE (verbatim
    # source-span extraction, trivially fully grounded by construction --
    # this field simply doesn't apply).
    grounding_score: float | None = None
    # SURVEY-only: 0-100 quality judgment of the FINAL formalized
    # description against EARS/INCOSE/ISO/IEC/IEEE-29148 criteria, plus zero
    # or more specific issues (see RequirementQualityIssue). None/[] for
    # BASELINE and for any SURVEY node when no scoring_client was supplied
    # (fully optional/additive capability) -- see
    # llm_leveling.score_requirements_for_document.
    quality_score: int | None = None
    quality_issues: list[RequirementQualityIssue] = Field(default_factory=list)
    # Per-dimension breakdown backing quality_score -- see
    # QualityCategoryScores' own docstring. None whenever quality_score is
    # None (no scoring_client supplied, or this node's scoring entry was
    # missing/malformed) -- same all-or-nothing tolerance as quality_score
    # itself, never partially populated.
    quality_category_scores: QualityCategoryScores | None = None
    # Per-category CITATION text backing quality_category_scores' keys --
    # maps a subset of those SAME keys to the org's own ingested checklist
    # document's stated definition for that category, when one exists (see
    # KbVectorStore.get_quality_checklist_definitions and
    # app.leveling.scoring._match_category_checklist for how this is built
    # and its known matching limitations). Deliberately NOT all-or-nothing
    # like quality_category_scores/quality_category_checklist above --
    # a category with no entry here is a real, common, EXPECTED case (no KB
    # standard behind it at all, or the org's own document states no
    # separate definition for that one category), not a parse failure, so
    # the frontend (QualityGauge.categoryDescription) falls back to a
    # generic sentence PER CATEGORY rather than discarding the whole map.
    # None whenever no category in quality_category_scores had a matched
    # definition (including every SURVEY node when no scoring_client was
    # supplied at all, or the grounding document defined no checklist).
    quality_category_checklist: dict[str, str] | None = None
    # Internal-only, never serialized (exclude=True) -- deterministic-
    # hierarchy path only (see id_hierarchy.HierarchyRow.needs_synthesis's
    # own docstring for the per-root-subtree gate that sets this). Signals
    # id_tree_builder's own synthesis pass that this node's `description`
    # is real, source-derived text but reads as a fragment/label, not
    # finished requirement prose -- consumed and cleared within the same
    # request, never meant to reach the API response or the frontend.
    needs_synthesis: bool = Field(default=False, exclude=True)


class WarningSeverity(str, Enum):
    """How a reviewer should treat an IntegrityWarning. auto_fixed:
    deterministic code already resolved it, no action needed. needs_review:
    an AI/heuristic judgment call a human should verify. pipeline_issue:
    something broke or was incomplete for this run -- re-running (optionally
    with a different model) is the general fix."""

    AUTO_FIXED = "auto_fixed"
    NEEDS_REVIEW = "needs_review"
    PIPELINE_ISSUE = "pipeline_issue"


class WarningKind(str, Enum):
    """Closed vocabulary of integrity-warning kinds a WorkItemTree can carry.
    Severity is a pure function of kind (see WARNING_SEVERITY below) --
    never set ad hoc at an emission site, so the mapping stays auditable in
    one place. ADO_VERIFICATION_FAILED is never emitted here -- it's the
    orchestrator's own (TypeScript-side) kind, listed for parity with its
    mirrored WarningRecord type."""

    REPARENTED_TO_FEATURE = "reparented_to_feature"
    GROUP_REPARENTED = "group_reparented"
    BRIDGE_FEATURE_SYNTHESIZED = "bridge_feature_synthesized"
    ROOTS_REGROUPED = "roots_regrouped"
    CATCHALL_EPIC_WRAP = "catchall_epic_wrap"
    NEAR_DUPLICATE_CONFLICT = "near_duplicate_conflict"
    OUTPUT_TRUNCATED = "output_truncated"
    NO_MODEL_TITLE = "no_model_title"
    INVALID_FIGURE_IDS = "invalid_figure_ids"
    INVALID_TABLE_IDS = "invalid_table_ids"
    INVALID_NODE_TYPE = "invalid_node_type"
    DANGLING_PARENT = "dangling_parent"
    LOW_GROUNDING = "low_grounding"
    ZERO_NODES = "zero_nodes"
    DROPPED_BLOCKS = "dropped_blocks"
    MISSING_TABLE_GROUP_COVERAGE = "missing_table_group_coverage"
    EXTERNAL_REFERENCE = "external_reference"
    SCORING_FAILED = "scoring_failed"
    SCORING_MISSING = "scoring_missing"
    SCORING_INCONSISTENT_CATEGORIES = "scoring_inconsistent_categories"
    ADO_VERIFICATION_FAILED = "ado_verification_failed"
    # Deterministic-hierarchy path (id_tree_builder.py) title/tag,
    # parent-summary, and requirement-synthesis enhancement passes -- all
    # three share these two kinds (see `detail["pass"]` for which one),
    # rather than one kind per pass, since the failure mode and reviewer
    # action are identical across all three.
    ENHANCEMENT_CALL_FAILED = "enhancement_call_failed"
    ENHANCEMENT_RESPONSE_INCOMPLETE = "enhancement_response_incomplete"
    DROPPED_ROW = "dropped_row"
    FRONT_MATTER_FOLDED = "front_matter_folded"
    TRACE_LINK_INFERENCE_FAILED = "trace_link_inference_failed"
    HEADING_ID_OFFSET_MISMATCH = "heading_id_offset_mismatch"
    UNSUPPORTED_CONTENT_NOTE = "unsupported_content_note"
    EMPTY_TABLE_CONTENT = "empty_table_content"
    # SURVEY stage 2 (whole-document figure/table -> exact-node mapping, see
    # llm_leveling._map_figures_tables_to_nodes). INVALID_MAPPING_TARGET is
    # the direct counterpart of INVALID_FIGURE_IDS/INVALID_TABLE_IDS above,
    # one level up: those catch a hallucinated FIGURE/TABLE id, this catches
    # a hallucinated NODE id -- a mapping call naming a work item that was
    # never in the candidate set that same call was offered. Dropped, never
    # trusted verbatim, exactly as those two do. MAPPING_CALL_FAILED is a
    # genuine CALL failure (error/timeout), not a validation failure: stage 2
    # is deliberately the one fail-OPEN stage of SURVEY's three (stages 1 and
    # 3 both still fail hard), so a failed batch degrades its items to
    # WorkItemTree.excluded_figure_ids/excluded_table_ids instead of failing
    # the whole job.
    INVALID_MAPPING_TARGET = "invalid_mapping_target"
    MAPPING_CALL_FAILED = "mapping_call_failed"
    # Tree-level (never per-figure) warning: vision was off for this WHOLE
    # run (doc.vision_active is False) while the document has at least one
    # figure -- explains every one of that document's uncaptioned_figure_ids
    # at once, disambiguating "vision was never even attempted" from a
    # genuine per-figure vision_failed/insignificant verdict (see Figure.
    # caption_status and WorkItemNode.insignificant_figure_ids). Emitted by
    # main.py's /level route, not build_survey_tree/build_baseline_tree
    # themselves, so it fires exactly once regardless of BASELINE/SURVEY mode.
    VISION_CAPTIONING_DISABLED = "vision_captioning_disabled"
    # PDF-only (docs/superpowers/specs/2026-08-16-pdf-table-header-ocr-recovery-design.md):
    # a table had 1+ grid position whose text could not be extracted
    # directly and was instead reconstructed via OCR on a rendered crop
    # (see TableCell.ocr_recovered, pdf_loader.py's _cell_ocr_recovery).
    # One warning per TABLE with any such cell, not per cell -- matches
    # this codebase's established table/section-level dedup convention.
    OCR_RECOVERED_TABLE_TEXT = "ocr_recovered_table_text"
    # DOCX-only: a table had 1+ cell whose own markup contained a nested
    # table, whose content could not be represented in the canonical model
    # and was therefore dropped entirely (see TableCell.nested_table_dropped,
    # docx_loader.py's _extract_table_cells). One warning per TABLE with any
    # such cell, not per cell -- same dedup convention as
    # OCR_RECOVERED_TABLE_TEXT just above.
    NESTED_TABLE_DROPPED = "nested_table_dropped"
    # Tree-level (never per-node): one or more Requirement nodes have no
    # real, document-authored Customer ID / source-requirement-number (see
    # WorkItemNode.customer_id's own docstring) -- e.g. the document's
    # numbering is Word-auto-numbered with no literal text anywhere, or the
    # node came from an informal-narrative Generation-mode section with no
    # formal numbering at all. Never fabricated: this flag exists precisely
    # so the gap is surfaced for human review instead of invented. One
    # warning per tree, `detail["nodeIds"]` listing every affected
    # Requirement -- same one-per-tree convention as DROPPED_BLOCKS/
    # ZERO_NODES, not one warning per node. Emitted by main.py's /level
    # route exit, same VISION_CAPTIONING_DISABLED precedent, so it fires
    # exactly once regardless of BASELINE/SURVEY mode.
    MISSING_SOURCE_REFERENCE = "missing_source_reference"
    # 300553 smart-title fallback: a SURVEY-mode node's stage-1 title (see
    # llm_leveling._author_branch_content) was too generic/short
    # (title_is_low_quality) and got replaced by a real distillation call
    # once its actual description text existed to distill FROM. One warning
    # per branch, `detail["nodeIds"]` listing every affected node -- same
    # one-per-branch dedup convention as DROPPED_BLOCKS immediately above it
    # in this same function's caller.
    SURVEY_TITLE_DISTILLED = "survey_title_distilled"
    # Per-row requirement splitting (2026-08-26): a source table row that
    # carries its own literal requirement identifier (see
    # requirement_rows.qualifying_requirement_rows) but that no generated
    # node's customer_id claimed -- the row may have been merged into
    # another requirement, or dropped entirely. An identified row going
    # unclaimed is a lost, explicitly-numbered customer requirement, the
    # worst failure mode this feature can have, so it gets its own kind
    # rather than reusing DROPPED_ROW (whose grouped message text is
    # hardcoded to the deterministic path's own mechanism) or
    # MISSING_TABLE_GROUP_COVERAGE (a lost GROUPING, not a lost
    # requirement). One warning per branch, same one-per-branch dedup
    # convention as MISSING_TABLE_GROUP_COVERAGE immediately above.
    MISSING_REQUIREMENT_ROW_COVERAGE = "missing_requirement_row_coverage"
    # A genuine customer ID is, by definition, unique to ONE requirement;
    # the model can report the same value on 2+ distinct Requirement
    # nodes when it mistakes a recurring product/variant name mentioned
    # in the source text for a per-row customer-assigned identifier (see
    # docs/handoff-heading-tier-detector-and-customer-id-fixes.md for the
    # confirmed live case). There is no way to tell which report (if any)
    # is genuinely correct -- so main.py's /level exit pass
    # (_enforce_requirement_only_fields) strips the value from EVERY node
    # that shares it rather than guessing, same "never fabricate, prefer
    # honest None" rule as MISSING_SOURCE_REFERENCE. One warning per tree,
    # `node_ids` listing every affected node and `detail["duplicateValue"]`
    # the shared value -- separate from MISSING_SOURCE_REFERENCE (that
    # kind means "no id was ever offered"; this one means "an id WAS
    # offered but couldn't be trusted").
    DUPLICATE_CUSTOMER_ID = "duplicate_customer_id"


WARNING_SEVERITY: dict[WarningKind, WarningSeverity] = {
    WarningKind.REPARENTED_TO_FEATURE: WarningSeverity.AUTO_FIXED,
    WarningKind.GROUP_REPARENTED: WarningSeverity.AUTO_FIXED,
    WarningKind.BRIDGE_FEATURE_SYNTHESIZED: WarningSeverity.AUTO_FIXED,
    WarningKind.ROOTS_REGROUPED: WarningSeverity.AUTO_FIXED,
    WarningKind.CATCHALL_EPIC_WRAP: WarningSeverity.AUTO_FIXED,
    WarningKind.NEAR_DUPLICATE_CONFLICT: WarningSeverity.NEEDS_REVIEW,
    WarningKind.OUTPUT_TRUNCATED: WarningSeverity.PIPELINE_ISSUE,
    WarningKind.NO_MODEL_TITLE: WarningSeverity.AUTO_FIXED,
    WarningKind.INVALID_FIGURE_IDS: WarningSeverity.NEEDS_REVIEW,
    WarningKind.INVALID_TABLE_IDS: WarningSeverity.NEEDS_REVIEW,
    WarningKind.INVALID_NODE_TYPE: WarningSeverity.NEEDS_REVIEW,
    WarningKind.DANGLING_PARENT: WarningSeverity.NEEDS_REVIEW,
    WarningKind.LOW_GROUNDING: WarningSeverity.NEEDS_REVIEW,
    WarningKind.ZERO_NODES: WarningSeverity.PIPELINE_ISSUE,
    WarningKind.DROPPED_BLOCKS: WarningSeverity.NEEDS_REVIEW,
    WarningKind.MISSING_TABLE_GROUP_COVERAGE: WarningSeverity.NEEDS_REVIEW,
    WarningKind.MISSING_REQUIREMENT_ROW_COVERAGE: WarningSeverity.NEEDS_REVIEW,
    WarningKind.EXTERNAL_REFERENCE: WarningSeverity.NEEDS_REVIEW,
    WarningKind.SCORING_FAILED: WarningSeverity.PIPELINE_ISSUE,
    WarningKind.SCORING_MISSING: WarningSeverity.PIPELINE_ISSUE,
    WarningKind.SCORING_INCONSISTENT_CATEGORIES: WarningSeverity.PIPELINE_ISSUE,
    WarningKind.ADO_VERIFICATION_FAILED: WarningSeverity.PIPELINE_ISSUE,
    WarningKind.ENHANCEMENT_CALL_FAILED: WarningSeverity.PIPELINE_ISSUE,
    WarningKind.ENHANCEMENT_RESPONSE_INCOMPLETE: WarningSeverity.AUTO_FIXED,
    WarningKind.DROPPED_ROW: WarningSeverity.NEEDS_REVIEW,
    WarningKind.FRONT_MATTER_FOLDED: WarningSeverity.AUTO_FIXED,
    WarningKind.TRACE_LINK_INFERENCE_FAILED: WarningSeverity.PIPELINE_ISSUE,
    WarningKind.HEADING_ID_OFFSET_MISMATCH: WarningSeverity.NEEDS_REVIEW,
    WarningKind.UNSUPPORTED_CONTENT_NOTE: WarningSeverity.NEEDS_REVIEW,
    WarningKind.EMPTY_TABLE_CONTENT: WarningSeverity.NEEDS_REVIEW,
    WarningKind.VISION_CAPTIONING_DISABLED: WarningSeverity.NEEDS_REVIEW,
    WarningKind.INVALID_MAPPING_TARGET: WarningSeverity.NEEDS_REVIEW,
    WarningKind.MAPPING_CALL_FAILED: WarningSeverity.PIPELINE_ISSUE,
    WarningKind.OCR_RECOVERED_TABLE_TEXT: WarningSeverity.NEEDS_REVIEW,
    WarningKind.NESTED_TABLE_DROPPED: WarningSeverity.NEEDS_REVIEW,
    WarningKind.MISSING_SOURCE_REFERENCE: WarningSeverity.NEEDS_REVIEW,
    WarningKind.SURVEY_TITLE_DISTILLED: WarningSeverity.AUTO_FIXED,
    WarningKind.DUPLICATE_CUSTOMER_ID: WarningSeverity.NEEDS_REVIEW,
}


class IntegrityWarning(BaseModel):
    """A single structured integrity signal surfaced to a human reviewer.
    Named IntegrityWarning (not `Warning`) to avoid shadowing the builtin.
    `raw` is the fully-formed human sentence -- always populated, so a
    client that doesn't recognize `kind` yet (or a legacy plain-string
    warning normalized on read by the frontend) can still show something
    sane. Construct via `make()`, never set `severity` directly, so
    WARNING_SEVERITY stays the single source of truth for the mapping."""

    kind: WarningKind
    severity: WarningSeverity
    node_ids: list[str] = Field(default_factory=list)
    detail: dict = Field(default_factory=dict)
    raw: str

    @classmethod
    def make(
        cls,
        kind: WarningKind,
        raw: str,
        node_ids: list[str] | None = None,
        detail: dict | None = None,
    ) -> "IntegrityWarning":
        return cls(
            kind=kind,
            severity=WARNING_SEVERITY[kind],
            node_ids=node_ids or [],
            detail=detail or {},
            raw=raw,
        )


class WorkItemTree(BaseModel):
    nodes: list[WorkItemNode] = Field(default_factory=list)
    # Non-fatal integrity signals surfaced to a human reviewer -- e.g.
    # SURVEY's LLM output covering noticeably fewer/more nodes than the
    # source document had blocks (see build_survey_tree's sanity check).
    # Always [] for BASELINE, which has no LLM step to produce a mismatch.
    warnings: list[IntegrityWarning] = Field(default_factory=list)
    # Source document excerpts (SharePoint/OneDrive KB, see app/kb/) cited
    # while formalizing this tree's requirements -- whole-document, not
    # per-node, mirroring trace_links below.
    kb_citations: list[KbCitation] = Field(default_factory=list)
    trace_links: list[TraceLink] = Field(default_factory=list)
    # Figures/tables SURVEY's whole-document mapping stage judged structurally
    # irrelevant to every work item (a decorative logo, a divider, a page
    # ornament), or could not place at all because the mapping call itself
    # failed (see WarningKind.MAPPING_CALL_FAILED's fail-open contract).
    # Doc-wide, deliberately NOT per-node: an excluded item belongs to no
    # node by definition, so it appears in exactly one place -- here -- and
    # never in any node's figure_ids/table_ids. Populated only by
    # build_survey_tree's stage 2; always [] for BASELINE (no LLM stage, no
    # scope-judgment concept) and for a SURVEY run whose analysis client
    # doesn't implement map_figures_tables at all. Existing to be COUNTED and
    # shown ("N figure(s) excluded as decorative"), so a filtered-out item is
    # visible to a reviewer rather than silently dropped.
    excluded_figure_ids: list[str] = Field(default_factory=list)
    excluded_table_ids: list[str] = Field(default_factory=list)
