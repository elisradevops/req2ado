from __future__ import annotations

from typing import Protocol

from pydantic import BaseModel, Field

from app.workitem.model import RequirementTag


class GeneratedRequirement(BaseModel):
    """One LLM-generated formal 'shall' requirement, with taxonomy tags.
    Validates the tags against the same RequirementTag enum WorkItemNode
    uses, so a generated requirement can be attached to a node's tags field
    directly without a separate mapping step."""

    text: str
    tags: list[RequirementTag] = Field(default_factory=list)


class SurveyRequirementClient(Protocol):
    """Interface for SURVEY-mode generative requirement extraction. No real
    implementation exists in this task — see OrchestratorLlmClient (Task 7)
    for the first real implementation, which calls the orchestrator's
    /llm/chat proxy (Part A of this phase) rather than any LLM endpoint
    directly, per the 'backend proxy, redact-first' architecture boundary.
    Matches the runtime prompt contract documented in docs/architecture.md:
    'informal block -> formal shall requirement(s) + taxonomy tags... each
    individually verifiable.'"""

    def generate_requirements(self, block_text: str) -> list[dict]: ...
