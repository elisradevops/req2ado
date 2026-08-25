from app.distillation.survey_title import TitleDistillationClient, distill_survey_title


class FakeTitleDistillationClient:
    """Hand-written test double proving the TitleDistillationClient
    interface/wiring works end-to-end, without a real /llm/chat round-trip.
    OrchestratorLlmClient.distill_title (300553) is the real implementation
    used in production -- see test_llm_leveling.py for the smart-title
    fallback's own gate/wiring tests."""

    def distill_title(self, text: str, max_length: int) -> str:
        assert max_length == 256
        return "Physical robustness"


class MisbehavingTitleDistillationClient:
    """Simulates an LLM that ignores the max_length instruction — proves
    distill_survey_title's defensive re-truncation actually protects the
    schema's title max_length=256 constraint regardless of client behavior."""

    def distill_title(self, text: str, max_length: int) -> str:
        return "A" * 500


def test_distill_survey_title_uses_the_injected_client() -> None:
    result = distill_survey_title("The unit shall survive a 1m drop onto concrete.", FakeTitleDistillationClient())
    assert result == "Physical robustness"


def test_distill_survey_title_enforces_max_length_even_if_client_ignores_it() -> None:
    result = distill_survey_title("some text", MisbehavingTitleDistillationClient())
    assert len(result) <= 256


def test_distill_survey_title_respects_a_custom_max_length() -> None:
    class ShortClient:
        def distill_title(self, text: str, max_length: int) -> str:
            assert max_length == 50
            return "A" * 100

    result = distill_survey_title("some text", ShortClient(), max_length=50)
    assert len(result) <= 50


def test_title_distillation_client_is_a_protocol_satisfied_by_the_fake() -> None:
    client: TitleDistillationClient = FakeTitleDistillationClient()
    result = client.distill_title("some text", 256)
    assert isinstance(result, str)
