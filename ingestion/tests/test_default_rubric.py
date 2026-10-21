"""Without a knowledge base the rubric is not implicit in a prompt: it is a built-in, versioned, visible rubric of the same shape as a KB
profile, grounded in how requirements are written well (ISO/IEC/IEEE 29148, INCOSE, EARS).

Before, a job without KB documents scored against five categories described only inside the scoring prompt: no definition step, no pass
conditions shown, no stored version, nothing to explain a score with."""
import pytest

from app import main
from app.kb.default_rubric import DEFAULT_RUBRIC_VERSION, DESIGN_PHILOSOPHY, default_profile
from app.kb.profile import Category, KbProfile, render_authoring_standard, scoring_inputs

NAMES = ["Necessary", "Unambiguous", "Singular", "Verifiable", "Complete", "Implementation-free", "Consistent", "Traceable"]


def test_the_default_rubric_is_eight_defined_qualities_each_with_a_pass_condition_and_guidance() -> None:
    profile = default_profile()
    assert [c.name for c in profile.categories] == NAMES
    assert len({c.name.casefold() for c in profile.categories}) == len(NAMES)
    for category in profile.categories:
        assert category.pass_condition and len(category.pass_condition) > 30, category.name
        assert category.guidance and len(category.guidance) > 30, category.name
        assert category.merged_from == [category.name] and category.sources == ["built-in"]
    assert profile.source == "default" and profile.version == DEFAULT_RUBRIC_VERSION and profile.built_with == "built-in"


def test_the_design_philosophy_explains_the_three_levels_and_what_a_good_requirement_is() -> None:
    text = DESIGN_PHILOSOPHY.lower()
    for word in ("epic", "feature", "requirement", "29148", "incose", "verifiable", "singular", "unambiguous"):
        assert word in text, word
    assert "not what the reader could guess" in text or "do not assume" in text  # judge what is written


def test_scoring_reads_the_default_rubric_like_any_profile_and_says_it_is_built_in() -> None:
    names, definitions, context = scoring_inputs(default_profile())
    assert names == NAMES and set(definitions) == set(NAMES)
    assert "built-in" in context.lower() and "knowledge base" in context.lower()  # not worded as the organization's own standard
    assert "Singular" in context


def test_a_kb_profile_keeps_its_own_wording() -> None:
    kb = KbProfile(version="v", built_with="m", categories=[Category(name="Testable", pass_condition="Can be verified", sources=["d"], merged_from=["Testable"])])
    assert kb.source == "kb"
    assert "organization's own standard" in scoring_inputs(kb)[2]


def test_the_default_rubric_does_not_change_how_items_are_written() -> None:
    # It judges and explains; it is not an authoring standard (that is the organization's, from its knowledge base).
    assert render_authoring_standard(default_profile()) is None


def test_a_profile_stored_before_source_existed_reads_as_a_kb_profile() -> None:
    data = KbProfile(version="v", built_with="m").model_dump()
    data.pop("source", None)
    assert KbProfile.model_validate(data).source == "kb"


@pytest.fixture
def jobs(monkeypatch):
    monkeypatch.setattr(main.settings, "kb_profile_scoring", True)
    monkeypatch.setattr(main, "_make_profile_client", lambda model: object())
    from app.kb.profile import InMemoryProfileStore

    monkeypatch.setattr(main, "_kb_profile_store", InMemoryProfileStore())


def test_a_job_without_a_knowledge_base_is_scored_with_the_default_rubric(monkeypatch, jobs) -> None:
    monkeypatch.setattr(main, "ensure_profile", lambda *a, **k: None)  # no KB documents
    profile = main._profile_for_job("u1", "m1")
    assert profile is not None and profile.source == "default"


def test_a_knowledge_base_that_yields_no_categories_falls_back_to_the_default_rubric(monkeypatch, jobs) -> None:
    monkeypatch.setattr(main, "ensure_profile", lambda *a, **k: KbProfile(version="v", built_with="m"))
    assert main._profile_for_job("u1", "m1").source == "default"


def test_a_failed_build_with_nothing_stored_also_falls_back_to_the_default_rubric(monkeypatch, jobs) -> None:
    broken = KbProfile(version="v", built_with="m", categories=[Category(name="Half", sources=["d"], merged_from=["Half"])], degraded=True)
    monkeypatch.setattr(main, "ensure_profile", lambda *a, **k: broken)
    assert main._profile_for_job("u1", "m1").source == "default"


def test_a_real_profile_wins_and_no_user_or_a_switched_off_feature_means_no_rubric(monkeypatch, jobs) -> None:
    real = KbProfile(version="v", built_with="m", categories=[Category(name="Testable", sources=["d"], merged_from=["Testable"])])
    monkeypatch.setattr(main, "ensure_profile", lambda *a, **k: real)
    assert main._profile_for_job("u1", "m1") == real
    assert main._profile_for_job(None, "m1") is None
    monkeypatch.setattr(main.settings, "kb_profile_scoring", False)
    assert main._profile_for_job("u1", "m1") is None


def test_chat_rescoring_and_the_cache_scope_see_the_default_rubric_when_there_is_no_stored_profile(monkeypatch) -> None:
    from app.kb.profile import InMemoryProfileStore

    monkeypatch.setattr(main, "_kb_profile_store", InMemoryProfileStore())
    assert main._stored_profile_or_none("u1").source == "default"
    assert main._stored_profile_or_none(None) is None
