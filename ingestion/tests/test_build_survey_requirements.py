from app.survey.build_survey_requirements import build_survey_requirements
from app.workitem.model import RequirementTag


class FakeSurveyRequirementClient:
    def generate_requirements(self, block_text: str) -> list[dict]:
        return [
            {"text": "The unit shall survive a 1m drop onto concrete.", "tags": ["safety"]},
            {"text": "The unit shall resume normal operation within 5 seconds of impact.", "tags": ["performance"]},
        ]


class EmptyResponseClient:
    def generate_requirements(self, block_text: str) -> list[dict]:
        return []


def test_build_survey_requirements_returns_validated_models() -> None:
    result = build_survey_requirements("The unit must survive being dropped.", FakeSurveyRequirementClient())
    assert len(result) == 2
    assert result[0].text == "The unit shall survive a 1m drop onto concrete."
    assert result[0].tags == [RequirementTag.SAFETY]
    assert result[1].tags == [RequirementTag.PERFORMANCE]


def test_build_survey_requirements_handles_an_empty_response() -> None:
    result = build_survey_requirements("Vague, unrequirement-like text.", EmptyResponseClient())
    assert result == []


def test_each_generated_requirement_is_individually_a_well_formed_shall_statement() -> None:
    # "individually verifiable" (Phase 5 DoD) is interpreted here as: each
    # requirement stands alone as a complete shall-statement sentence, not
    # referencing sibling requirements ("the above", "also", "additionally")
    # or trailing off incomplete. This is a lightweight heuristic check, not
    # a formal-methods verifiability proof.
    result = build_survey_requirements("The unit must survive being dropped.", FakeSurveyRequirementClient())
    for req in result:
        assert " shall " in req.text
        assert not req.text.lower().startswith(("also", "additionally", "the above"))
        assert req.text.strip().endswith(".")
