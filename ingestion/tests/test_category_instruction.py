"""The categories a scoring answer must contain are listed explicitly, including the built-in completeness check.

Before, `completeness_as_requirement` was described only in prose after the JSON list ("plus the completeness entry"), and a
model that follows the explicit list literally dropped it on 152 of 428 requirements (2 key-sets in one job). A rescore of an
item that already carried the key then said "plus completeness ... 16 entries" for 15 distinct names."""
import json
import re

from app.survey.orchestrator_llm_client import _array_category_instruction

KEY = "completeness_as_requirement"


def listed(text: str) -> list[str]:
    return json.loads(re.search(r"(\[\".*?\"\])", text).group(1))


def test_the_explicit_list_contains_the_completeness_check_once() -> None:
    text = _array_category_instruction(["Clarity", "Testable"], None)
    assert listed(text) == ["Clarity", "Testable", KEY]
    assert "3 entries in total" in text


def test_a_checklist_that_already_has_the_key_is_not_asked_for_it_twice() -> None:
    text = _array_category_instruction(["Clarity", KEY, "Testable"], None)
    assert listed(text) == ["Clarity", KEY, "Testable"]  # the item's own order is kept
    assert "3 entries in total" in text
    assert text.count('"' + KEY + '"') == 1


def test_the_key_is_matched_without_regard_to_case_when_deduplicating() -> None:
    text = _array_category_instruction(["Clarity", "Completeness_As_Requirement"], None)
    assert [c.casefold() for c in listed(text)].count(KEY) == 1


def test_the_builtin_and_derived_forms_are_unchanged() -> None:
    builtin = _array_category_instruction(None, None)
    assert "EXACTLY SIX" in builtin and KEY in builtin
    assert "derive" in _array_category_instruction(None, "some KB material")
