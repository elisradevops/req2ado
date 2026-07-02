from app.survey.build_survey_requirements import build_survey_requirements
from app.workitem.model import RequirementTag


class GoldenIcdSurveyClient:
    """Fixture client simulating a realistic multi-tag, multi-requirement
    LLM response for an informal ICD-style input block — this is the
    'golden survey output' fixture Phase 5's DoD names explicitly."""

    def generate_requirements(self, block_text: str) -> list[dict]:
        assert "drop" in block_text.lower()
        return [
            {
                "text": "The unit shall survive a 1-meter drop onto a concrete surface without loss of function.",
                "tags": ["safety", "performance"],
            },
            {
                "text": "The unit shall resume normal operation within 5 seconds of a drop event.",
                "tags": ["performance", "operation"],
            },
            {
                "text": "The unit's enclosure shall show no visible cracking after a certified drop test.",
                "tags": ["safety"],
            },
        ]


def test_golden_survey_output_produces_three_formal_requirements() -> None:
    informal_text = "Needs to survive being dropped about a meter onto concrete and keep working."
    result = build_survey_requirements(informal_text, GoldenIcdSurveyClient())
    assert len(result) == 3
    assert all(req.text.strip().endswith(".") for req in result)


def test_golden_survey_output_applies_taxonomy_tags_correctly() -> None:
    informal_text = "Needs to survive being dropped about a meter onto concrete and keep working."
    result = build_survey_requirements(informal_text, GoldenIcdSurveyClient())
    assert result[0].tags == [RequirementTag.SAFETY, RequirementTag.PERFORMANCE]
    assert result[1].tags == [RequirementTag.PERFORMANCE, RequirementTag.OPERATION]
    assert result[2].tags == [RequirementTag.SAFETY]


def test_golden_survey_output_every_requirement_uses_shall_language() -> None:
    informal_text = "Needs to survive being dropped about a meter onto concrete and keep working."
    result = build_survey_requirements(informal_text, GoldenIcdSurveyClient())
    for req in result:
        assert " shall " in req.text


def test_golden_survey_output_no_requirement_references_a_sibling() -> None:
    # "Individually verifiable" — no requirement's text depends on reading
    # another requirement to make sense (no "the above", "also", "same as").
    informal_text = "Needs to survive being dropped about a meter onto concrete and keep working."
    result = build_survey_requirements(informal_text, GoldenIcdSurveyClient())
    forbidden_phrases = ["the above", "also,", "same as", "additionally,"]
    for req in result:
        lowered = req.text.lower()
        assert not any(phrase in lowered for phrase in forbidden_phrases)
