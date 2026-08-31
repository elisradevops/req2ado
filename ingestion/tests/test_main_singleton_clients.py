from app import main as main_module


def test_dedup_judge_client_is_configured_with_survey_sampling_constants() -> None:
    assert main_module._dedup_judge_client._top_k == main_module._SURVEY_TOP_K
    assert main_module._dedup_judge_client._min_p == main_module._SURVEY_MIN_P


def test_checklist_client_is_configured_with_survey_sampling_constants() -> None:
    assert main_module._checklist_client._top_k == main_module._SURVEY_TOP_K
    assert main_module._checklist_client._min_p == main_module._SURVEY_MIN_P
