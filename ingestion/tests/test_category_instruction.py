"""The categories a scoring answer must contain are listed explicitly, including the built-in completeness check.

Before, `completeness_as_requirement` was described only in prose after the JSON list ("plus the completeness entry"), and a
model that follows the explicit list literally dropped it on 152 of 428 requirements (2 key-sets in one job). A rescore of an
item that already carried the key then said "plus completeness ... 16 entries" for 15 distinct names."""

from app.prompts.assembly import render_fragment
from app.survey.orchestrator_llm_client import _scoring_category_fragment, _scoring_category_names


def _array_category_instruction(checklist, kb_context) -> str:  # noqa: ANN001
    """The `categories` paragraph as the model reads it (a fragment prompt file)."""
    return render_fragment(_scoring_category_fragment(checklist, kb_context))


KEY = "completeness_as_requirement"


def listed(checklist: list[str]) -> list[str]:
    """The names the scoring call's <category_names> block lists (the instruction points to that block)."""
    return _scoring_category_names(checklist)


def test_the_explicit_list_contains_the_completeness_check_once() -> None:
    text = _array_category_instruction(["Clarity", "Testable"], None)
    assert listed(["Clarity", "Testable"]) == ["Clarity", "Testable", KEY]
    assert (
        "<category_names>" in text and "Clarity" not in text
    )  # the names are data, never in the instruction
    assert "EXACTLY 3 integers" in text


def test_a_checklist_that_already_has_the_key_is_not_asked_for_it_twice() -> None:
    text = _array_category_instruction(["Clarity", KEY, "Testable"], None)
    assert listed(["Clarity", KEY, "Testable"]) == [
        "Clarity",
        KEY,
        "Testable",
    ]  # the item's own order is kept
    assert "EXACTLY 3 integers" in text


def test_the_key_is_matched_without_regard_to_case_when_deduplicating() -> None:
    names = listed(["Clarity", "Completeness_As_Requirement"])
    assert [c.casefold() for c in names].count(KEY) == 1
    assert "EXACTLY 2 integers" in _array_category_instruction(
        ["Clarity", "Completeness_As_Requirement"], None
    )


def test_the_builtin_and_derived_forms_ask_only_what_the_standard_requires() -> None:
    builtin = _array_category_instruction(None, None)  # no standard: neither active voice nor a rationale is required
    assert "EXACTLY 4" in builtin and f"clarity, testability, atomicity and {KEY}" in builtin
    assert "- style" not in builtin and "- rationale" not in builtin
    both = render_fragment(_scoring_category_fragment(None, None, frozenset({"active_voice", "rationale"})))
    assert "EXACTLY 6" in both and f"clarity, testability, atomicity, style, rationale and {KEY}" in both
    assert "standard requires the active voice" in both and "standard requires a stated rationale" in both
    derived = _array_category_instruction(None, "some KB material")
    assert "Decide the names ONCE" in derived and KEY in derived
    assert "use clarity, testability and atomicity instead" in derived
