"""A scoring answer that left a required category out for some items is completed by ONE small follow-up call asking only for the
missing categories, instead of leaving those items with a smaller breakdown.

In a prod run one answer left `Implementable` out for 21 of 428 requirements: a second key-set, flagged by the warning and not fixed."""
from app.leveling.scoring import _apply_quality_scores
from app.workitem.model import WarningKind
from tests.test_scoring import _requirement_node

LIST = ["Clarity", "Testable", "Implementable"]
KEY = "completeness_as_requirement"
FULL = {"Clarity": 70, "Testable": 60, "Implementable": 50, KEY: 90}


class Scripted:
    """The first call is the real scoring answer; later calls are follow-ups and are answered by `follow_up(descriptions, checklist)`."""

    def __init__(self, first: dict, follow_up=None) -> None:
        self.first, self.follow_up, self.calls = first, follow_up, []

    def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None, user_id=None):
        self.calls.append({"ids": sorted(k for k in descriptions_by_node_id if not k.startswith("__")), "checklist": category_checklist, "kb": kb_context})
        if len(self.calls) == 1:
            return self.first
        if self.follow_up is None:
            raise RuntimeError("model down")
        return self.follow_up(descriptions_by_node_id, category_checklist)


def entry(score: int, cats: dict) -> dict:
    return {"score": score, "issues": [], "categoryScores": cats}


def nodes(*ids: str):
    return [_requirement_node(i, f"The system shall do {i}.") for i in ids]


def apply(client, node_list, kb="KB CONTEXT"):
    warnings: list = []
    _apply_quality_scores(node_list, client, warnings, "", kb_context=kb, category_checklist=LIST)
    return [w for w in warnings if w.kind == WarningKind.SCORING_INCONSISTENT_CATEGORIES]


def without(cats: dict, *names: str) -> dict:
    return {k: v for k, v in cats.items() if k not in names}


def test_a_missing_category_is_asked_for_in_one_follow_up_and_completes_the_breakdown() -> None:
    items = nodes("a", "b", "c")
    first = {"a": entry(70, without(FULL, "Implementable")), "b": entry(60, without(FULL, "Implementable")), "c": entry(80, FULL)}
    client = Scripted(first, lambda d, c: {i: entry(1, {"Implementable": 40 + n}) for n, i in enumerate(sorted(d))})

    warnings = apply(client, items)

    assert warnings == []
    assert len(client.calls) == 2 and client.calls[1]["ids"] == ["a", "b"]  # only the items that lack it
    assert client.calls[1]["checklist"] == ["Implementable"]  # only what is missing
    assert client.calls[1]["kb"] == "KB CONTEXT"  # the same frame
    assert items[0].quality_category_scores == {"Clarity": 70, "Testable": 60, "Implementable": 40, KEY: 90}  # in the list's order
    assert items[1].quality_category_scores["Implementable"] == 41
    assert items[2].quality_category_scores == FULL


def test_the_follow_up_never_changes_the_items_score_issues_or_existing_categories() -> None:
    items = nodes("a")
    first = {"a": {"score": 70, "issues": ["vague_term"], "categoryScores": without(FULL, "Implementable")}}
    client = Scripted(first, lambda d, c: {"a": {"score": 5, "issues": ["ambiguous"], "categoryScores": {"Implementable": 33, "Clarity": 1, KEY: 2}}})
    apply(client, items)
    assert items[0].quality_score == 70 and [i.value for i in items[0].quality_issues] == ["vague_term"]
    assert items[0].quality_category_scores == {"Clarity": 70, "Testable": 60, "Implementable": 33, KEY: 90}  # Clarity and completeness untouched


def test_the_completeness_check_can_be_the_missing_one() -> None:
    items = nodes("a")
    client = Scripted({"a": entry(70, without(FULL, KEY))}, lambda d, c: {"a": entry(1, {KEY: 55})})
    assert apply(client, items) == [] and items[0].quality_category_scores[KEY] == 55


def test_items_missing_different_categories_get_one_call_per_distinct_set() -> None:
    items = nodes("a", "b")
    first = {"a": entry(70, without(FULL, "Implementable")), "b": entry(70, without(FULL, "Testable"))}
    client = Scripted(first, lambda d, c: {i: entry(1, {name: 20 for name in c}) for i in d})
    assert apply(client, items) == []
    assert len(client.calls) == 3 and sorted(c["checklist"][0] for c in client.calls[1:]) == ["Implementable", "Testable"]


def test_a_follow_up_that_fails_leaves_the_gap_and_the_warning_names_only_what_is_still_missing() -> None:
    items = nodes("a", "b")
    first = {"a": entry(70, without(FULL, "Implementable")), "b": entry(70, FULL)}
    warnings = apply(Scripted(first, follow_up=None), items)  # the follow-up raises
    assert len(warnings) == 1 and warnings[0].node_ids == ["a"] and warnings[0].detail["missingCategories"] == ["Implementable"]
    assert "Implementable" not in items[0].quality_category_scores and items[1].quality_category_scores == FULL


def test_garbage_in_the_follow_up_is_ignored_and_only_the_still_missing_is_reported() -> None:
    items = nodes("a", "b", "c")
    first = {i: entry(70, without(FULL, "Implementable")) for i in "abc"}
    follow = lambda d, c: {"a": entry(1, {"Implementable": 101}), "b": entry(1, {"Implementable": "high"}), "c": entry(1, {"Implementable": 44})}  # noqa: E731
    warnings = apply(Scripted(first, follow), items)
    assert items[2].quality_category_scores["Implementable"] == 44
    assert "Implementable" not in items[0].quality_category_scores and "Implementable" not in items[1].quality_category_scores
    assert len(warnings) == 1 and warnings[0].node_ids == ["a", "b"]


def test_nothing_is_asked_when_nothing_is_missing_or_there_is_no_fixed_list() -> None:
    client = Scripted({"a": entry(70, FULL)})
    apply(client, nodes("a"))
    assert len(client.calls) == 1

    free = Scripted({"a": entry(70, {"whatever": 5})})
    _apply_quality_scores(nodes("a"), free, [], "")  # no fixed list: nothing to enforce, nothing to repair
    assert len(free.calls) == 1


def test_the_number_of_follow_up_calls_is_bounded() -> None:
    # Five items, each missing a different single category from a list of five names: five distinct sets, at most three are repaired.
    big = ["Clarity", "Testable", "Implementable", "Essential", "Consistent"]
    items = [_requirement_node(f"n{i}", f"The system shall do {i}.") for i in range(5)]
    first = {f"n{i}": entry(70, {name: 50 for name in [*big, KEY] if name != big[i]}) for i in range(5)}
    client = Scripted(first, lambda d, c: {i: entry(1, {name: 9 for name in c}) for i in d})
    warnings: list = []
    _apply_quality_scores(items, client, warnings, "", kb_context="KB", category_checklist=big)
    assert len(client.calls) == 1 + 3
    still = [w for w in warnings if w.kind == WarningKind.SCORING_INCONSISTENT_CATEGORIES]
    assert len(still) == 1 and len(still[0].node_ids) == 2  # the two sets beyond the bound keep the warning
