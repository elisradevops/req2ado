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


class RequirementQualityIssue(str, Enum):
    AMBIGUOUS = "ambiguous"
    NOT_TESTABLE = "not_testable"
    COMPOUND = "compound"
    MISSING_ACCEPTANCE_CRITERIA = "missing_acceptance_criteria"
    VAGUE_TERM = "vague_term"
    PASSIVE_VOICE = "passive_voice"
    MISSING_RATIONALE = "missing_rationale"


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
    quality_score: int | None = None
    quality_issues: list[RequirementQualityIssue] = Field(default_factory=list)
    mode: WorkItemMode
    child_type: WorkItemType | None = None


class WorkItemTree(BaseModel):
    nodes: list[WorkItemNode] = Field(default_factory=list)
    kb_citations: list[str] = Field(default_factory=list)
    trace_links: list[TraceLink] = Field(default_factory=list)
