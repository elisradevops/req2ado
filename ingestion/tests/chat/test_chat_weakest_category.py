from app.chat.chat_service import _build_system_prompt, weakest_category_note
from app.kb.profile import build_profile
from tests.test_kb_profile import DOCS, FakeProfileClient

PROFILE = build_profile(DOCS, FakeProfileClient(), model="m1")
ITEM = {"type": "Requirement", "title": "Lock", "description": "The receiver shall lock quickly.", "qualityIssues": []}


def test_the_weakest_category_is_named_with_its_score_and_the_organizations_pass_condition() -> None:
    note = weakest_category_note({"Clear and unambiguous": 42, "Testable": 88, "Implementable": 61}, PROFILE)
    assert note is not None
    assert "Clear and unambiguous (42)" in note and "One reading only" in note
    assert "Implementable (61)" in note  # the two lowest below the bar are listed, weakest first
    assert note.index("Clear and unambiguous") < note.index("Implementable")
    assert "Testable" not in note  # 88 is above the bar
    assert "say which category" in note


def test_a_category_without_a_stored_pass_condition_is_still_named() -> None:
    note = weakest_category_note({"rationale": 30, "style": 90}, None)
    assert note is not None and "rationale (30)" in note and "pass condition" not in note


def test_nothing_is_added_when_every_category_is_good_or_there_are_no_scores() -> None:
    assert weakest_category_note({"a": 90, "b": 85}, PROFILE) is None
    assert weakest_category_note({}, PROFILE) is None
    assert weakest_category_note(None, PROFILE) is None
    assert weakest_category_note({"a": "bad", "b": None}, PROFILE) is None  # malformed scores are ignored


def test_the_system_prompt_carries_the_note_and_is_unchanged_without_one() -> None:
    base = _build_system_prompt(ITEM, None)
    assert _build_system_prompt(ITEM, None, None) == base
    with_note = _build_system_prompt(ITEM, None, "WEAKEST NOTE.")
    assert "WEAKEST NOTE." in with_note and with_note.startswith(base.split("Reply conversationally")[0])
