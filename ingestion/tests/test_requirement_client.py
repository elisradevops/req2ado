from app.survey.requirement_client import GeneratedRequirement, SurveyRequirementClient
from app.workitem.model import RequirementTag


class FakeSurveyRequirementClient:
    """Hand-written test double proving the SurveyRequirementClient
    interface/wiring works end-to-end. No real orchestrator LLM proxy call
    exists in THIS task — that's Task 7's OrchestratorLlmClient. Matches the
    established Phase 2-4 fake-client convention exactly."""

    def generate_requirements(self, block_text: str) -> list[dict]:
        return [
            {"text": "The unit shall survive a 1m drop onto concrete.", "tags": ["safety"]},
            {"text": "The unit shall resume normal operation within 5 seconds of impact.", "tags": ["performance", "operation"]},
        ]


def test_generated_requirement_model_validates_a_well_formed_dict() -> None:
    req = GeneratedRequirement(text="The unit shall survive a 1m drop.", tags=["safety"])
    assert req.text == "The unit shall survive a 1m drop."
    assert req.tags == [RequirementTag.SAFETY]


def test_generated_requirement_model_accepts_multiple_tags() -> None:
    req = GeneratedRequirement(text="The unit shall resume operation within 5 seconds.", tags=["performance", "operation"])
    assert req.tags == [RequirementTag.PERFORMANCE, RequirementTag.OPERATION]


def test_generated_requirement_model_defaults_to_no_tags() -> None:
    req = GeneratedRequirement(text="Some requirement.")
    assert req.tags == []


def test_survey_requirement_client_is_a_protocol_satisfied_by_the_fake() -> None:
    client: SurveyRequirementClient = FakeSurveyRequirementClient()
    result = client.generate_requirements("The unit must survive being dropped.")
    assert isinstance(result, list)
    assert result[0]["text"] == "The unit shall survive a 1m drop onto concrete."
