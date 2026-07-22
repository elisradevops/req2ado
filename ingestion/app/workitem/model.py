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
    customer_id: str | None = None
    source_ref: SourceRef
    fidelity_hash: str | None = None
    tags: list[RequirementTag] = Field(default_factory=list)
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


class WorkItemTree(BaseModel):
    nodes: list[WorkItemNode] = Field(default_factory=list)
    # Non-fatal integrity signals surfaced to a human reviewer -- e.g.
    # SURVEY's LLM output covering noticeably fewer/more nodes than the
    # source document had blocks (see build_survey_tree's sanity check).
    # Always [] for BASELINE, which has no LLM step to produce a mismatch.
    warnings: list[str] = Field(default_factory=list)
    # Source document excerpts (SharePoint/OneDrive KB, see app/kb/) cited
    # while formalizing this tree's requirements -- whole-document, not
    # per-node, mirroring trace_links below.
    kb_citations: list[KbCitation] = Field(default_factory=list)
    trace_links: list[TraceLink] = Field(default_factory=list)
