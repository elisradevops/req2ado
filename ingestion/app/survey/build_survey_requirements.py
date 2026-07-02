from __future__ import annotations

from app.survey.requirement_client import GeneratedRequirement, SurveyRequirementClient


def build_survey_requirements(block_text: str, client: SurveyRequirementClient) -> list[GeneratedRequirement]:
    """Generates formal 'shall' requirements + taxonomy tags for one
    informal block, via the injected client (see requirement_client.py's
    docstring for why this is Protocol-based). Each raw dict from the client
    is validated through GeneratedRequirement, so a malformed tag value (not
    in RequirementTag) raises a pydantic ValidationError rather than
    silently passing through."""
    raw_requirements = client.generate_requirements(block_text)
    return [GeneratedRequirement(**raw) for raw in raw_requirements]
