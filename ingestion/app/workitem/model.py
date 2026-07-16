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
