"""The hierarchy check of a table that states its items: code finds every item the ladder does not allow and the fixes that would make it valid;
the model only picks one of those fixes, and nothing is applied."""

from __future__ import annotations

from pathlib import Path

from app.dispatch import dispatch_by_extension
from app.leveling.hierarchy_check import fix_options, suggest_hierarchy_fixes
from app.leveling.llm_leveling import build_survey_tree
from app.leveling.tree_builder import build_baseline_tree
from app.workitem.model import WarningKind

from .accuracy.variants import FIXTURE

# One item of each kind the ladder does not allow (Epic > Feature > Requirement, each may nest under its own type, only Epics are roots).
SEEDED = (
    "Work Item Type,Title 1,Title 2,Title 3,Title 4,Description\n"
    "Epic,Power,,,,Power management\n"
    "Requirement,,Boot time,,,The unit shall boot within 2 s.\n"  # a Requirement directly under an Epic
    "Feature,,Sleep mode,,,Low power states\n"
    "Requirement,,,Sleep entry,,The unit shall sleep after 10 min.\n"
    "Feature,,,,Wake sources,Sources that wake the unit\n"  # a Feature under a Requirement
    "Feature,,Display,,,Screen behaviour\n"
    "Epic,,,Brightness,,Brightness control\n"  # an Epic under a Feature
    "Requirement,,,,Auto dim,The screen shall dim after 30 s.\n"  # so a Requirement directly under that Epic too
    "Feature,Logging,,,,Event logging\n"  # a root that is not an Epic
    "Requirement,,Log rotation,,,Logs shall rotate daily.\n"
)
_VIOLATORS = {"Boot time", "Wake sources", "Brightness", "Auto dim", "Logging"}
_VALID = {"Epic": {"Epic"}, "Feature": {"Epic", "Feature"}, "Requirement": {"Feature", "Requirement"}}


def _doc(tmp_path: Path, csv_text: str):
    path = tmp_path / "sheet.csv"
    path.write_text(csv_text, encoding="utf-8")
    return dispatch_by_extension("sheet.csv", str(path))


def _violation(tree):
    return next(w for w in tree.warnings if w.kind == WarningKind.SOURCE_STRUCTURE_VIOLATION)


def _shape(tree):
    return [(n.local_id, n.type.value, n.parent_local_id, n.title, n.description) for n in tree.nodes]


class _Analysis:
    model = "stub"


class _Picker:
    """Answers every item with the option `pick` names (an option id, or a callable from the item to one)."""

    def __init__(self, pick="o1") -> None:
        self.pick = pick
        self.calls: list[dict] = []

    def suggest_hierarchy_fixes(self, items_by_id, user_id=None):
        self.calls.append(items_by_id)
        return {
            item_id: {"option": self.pick(item) if callable(self.pick) else self.pick, "reason": "fits there"}
            for item_id, item in items_by_id.items()
        }


def test_every_item_the_ladder_does_not_allow_is_reported_with_its_node(tmp_path: Path) -> None:
    tree = build_baseline_tree(_doc(tmp_path, SEEDED))
    by_id = {n.local_id: n for n in tree.nodes}
    warning = _violation(tree)
    assert {by_id[i].title for i in warning.node_ids} == _VIOLATORS
    items = warning.detail["items"]
    assert [i["id"] for i in items] == warning.node_ids
    assert all(i["suggestion"] is None for i in items)
    assert {i["problem"] for i in items} == {
        "Requirement under Epic",
        "Feature under Requirement",
        "Epic under Feature",
        "Feature with no parent",
    }


def _valid_after(nodes, node_id: str, option: dict) -> bool:
    by_id = {n.local_id: n for n in nodes}
    node = by_id[node_id]
    new_type = option.get("type", node.type.value) if option["action"] == "retype" else node.type.value
    new_parent = {"move_under": option.get("parent_id"), "move_to_top": None}.get(option["action"], node.parent_local_id)
    parent_ok = new_type == "Epic" if new_parent is None else by_id[new_parent].type.value in _VALID[new_type]
    # A move keeps the item's type, so its children are as valid as before (a child the ladder does not allow is its own item).
    children_ok = option["action"] != "retype" or all(new_type in _VALID[c.type.value] for c in nodes if c.parent_local_id == node_id)
    return parent_ok and children_ok


def test_every_fix_offered_makes_the_item_valid(tmp_path: Path) -> None:
    tree = build_baseline_tree(_doc(tmp_path, SEEDED))
    misplaced = frozenset(_violation(tree).node_ids)
    for node_id in misplaced:
        options = fix_options(tree.nodes, node_id, misplaced)
        assert options, node_id
        for option in options.values():
            assert _valid_after(tree.nodes, node_id, option), (node_id, option)
            assert option.get("parent_id") not in misplaced  # never onto another misplaced item


def test_survey_writes_the_picked_fix_into_the_warning_and_changes_nothing(tmp_path: Path) -> None:
    doc = _doc(tmp_path, SEEDED)
    before = _shape(build_baseline_tree(doc))
    picker = _Picker()
    tree = build_survey_tree(doc, _Analysis(), hierarchy_client=picker)
    assert _shape(tree) == before  # the suggestion is only written into the warning
    assert len(picker.calls) == 1 and set(picker.calls[0]) == set(_violation(tree).node_ids)
    for item in _violation(tree).detail["items"]:
        assert item["suggestion"] is not None and item["reason"] == "fits there"
    assert "suggested:" in _violation(tree).raw


def test_an_answer_naming_no_offered_fix_leaves_the_decision_to_the_user(tmp_path: Path) -> None:
    tree = build_baseline_tree(_doc(tmp_path, SEEDED))
    warnings = list(tree.warnings)
    suggest_hierarchy_fixes(tree.nodes, warnings, _Picker("o99"))
    items = next(w for w in warnings if w.kind == WarningKind.SOURCE_STRUCTURE_VIOLATION).detail["items"]
    assert all(i["suggestion"] is None for i in items)
    assert "needs your decision" in next(w for w in warnings if w.kind == WarningKind.SOURCE_STRUCTURE_VIOLATION).raw


def test_a_file_the_ladder_allows_asks_the_model_nothing() -> None:
    picker = _Picker()
    build_survey_tree(dispatch_by_extension(FIXTURE.name, str(FIXTURE)), _Analysis(), hierarchy_client=picker)
    assert picker.calls == []


def test_a_failed_call_leaves_the_report_as_code_found_it(tmp_path: Path) -> None:
    class Down:
        def suggest_hierarchy_fixes(self, items_by_id, user_id=None):
            raise RuntimeError("model down")

    tree = build_baseline_tree(_doc(tmp_path, SEEDED))
    warnings = list(tree.warnings)
    suggest_hierarchy_fixes(tree.nodes, warnings, Down())
    items = next(w for w in warnings if w.kind == WarningKind.SOURCE_STRUCTURE_VIOLATION).detail["items"]
    assert len(items) == len(_VIOLATORS) and all(i["suggestion"] is None for i in items)
