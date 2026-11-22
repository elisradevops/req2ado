"""The rule a table states about its own items: type column, nesting, what is skipped, and the tree built from it."""

from __future__ import annotations

from pathlib import Path

from app.dispatch import dispatch_by_extension
from app.leveling.rule_builder import verify_tree_against_rules
from app.leveling.tree_builder import build_baseline_tree
from app.study.file_rules import study_tables
from app.workitem.model import WarningKind, WorkItemTree


def _doc(tmp_path: Path, csv_text: str):
    path = tmp_path / "sheet.csv"
    path.write_text(csv_text, encoding="utf-8")
    return dispatch_by_extension("sheet.csv", str(path))


LEVELS = (
    "Work Item Type,Title 1,Title 2,Title 3,Description\n"
    "Epic,Top,,,<div>The <b>top</b></div>\n"
    "Feature,,Feat A,,\n"
    "Requirement,,,Req 1,The unit shall start.\n"
    "Test Case,,,Case 1,steps\n"
    "Requirement,,,Req 2,The unit shall stop.\n"
    "Feature,,Feat B,,\n"
    "Requirement,,,Req 3,x\n"
)


def test_levels_rule_reads_types_titles_and_parents(tmp_path: Path) -> None:
    doc = _doc(tmp_path, LEVELS)
    rule = study_tables(doc)["t0"]
    assert rule.nesting == "levels"
    assert dict(rule.type_counts()) == {"Epic": 1, "Feature": 2, "Requirement": 3}
    assert dict(rule.skipped_counts()) == {"type:Test Case": 1}
    tree = build_baseline_tree(doc)
    by_title = {n.title: n for n in tree.nodes}
    assert by_title["Feat A"].type == "Feature"
    assert by_title["Feat A"].parent_local_id == by_title["Top"].local_id
    assert by_title["Req 2"].parent_local_id == by_title["Feat A"].local_id
    assert by_title["Req 3"].parent_local_id == by_title["Feat B"].local_id
    assert by_title["Top"].description == "The **top**"
    assert "Case 1" not in by_title
    assert [w.kind for w in tree.warnings] == [WarningKind.SOURCE_TYPE_SKIPPED]
    assert verify_tree_against_rules(doc, tree) == []


def test_a_column_named_requirement_type_is_not_the_type_column(tmp_path: Path) -> None:
    doc = _doc(tmp_path, "Requirement Type,Title\nFunctional,A\nPerformance,B\n")
    assert study_tables(doc) == {}


def test_id_and_parent_columns_give_the_nesting(tmp_path: Path) -> None:
    csv_text = (
        "ID,Work Item Type,Title,Parent,Description\n"
        "1,Epic,E,,d\n2,Feature,F,1,d\n3,Requirement,R,2,d\n4,Requirement,R2,2,d\n"
    )
    tree = build_baseline_tree(_doc(tmp_path, csv_text))
    by_title = {n.title: n for n in tree.nodes}
    assert by_title["R2"].parent_local_id == by_title["F"].local_id
    assert by_title["F"].parent_local_id == by_title["E"].local_id


def test_row_order_gives_the_nesting_when_nothing_else_does(tmp_path: Path) -> None:
    csv_text = "Type,Title\nEpic,E\nFeature,F\nRequirement,R\nFeature,F2\nRequirement,R2\n"
    tree = build_baseline_tree(_doc(tmp_path, csv_text))
    by_title = {n.title: n for n in tree.nodes}
    assert by_title["R2"].parent_local_id == by_title["F2"].local_id
    assert by_title["F2"].parent_local_id == by_title["E"].local_id


def test_a_stated_type_is_never_changed_even_when_the_item_has_no_children(tmp_path: Path) -> None:
    csv_text = "Work Item Type,Title 1,Title 2,Title 3\nEpic,E,,\nFeature,,Empty feature,\nFeature,,F2,\nRequirement,,,R\n"
    tree = build_baseline_tree(_doc(tmp_path, csv_text))
    by_title = {n.title: n for n in tree.nodes}
    assert by_title["Empty feature"].type == "Feature"
    assert by_title["F2"].type == "Feature"


def test_a_structure_the_ladder_does_not_allow_is_kept_and_reported(tmp_path: Path) -> None:
    csv_text = "Work Item Type,Title 1,Title 2,Title 3\nEpic,E,,\nRequirement,,,R directly under the epic\n"
    tree = build_baseline_tree(_doc(tmp_path, csv_text))
    assert {n.title: n.type for n in tree.nodes} == {
        "E": "Epic",
        "R directly under the epic": "Requirement",
    }
    assert WarningKind.SOURCE_STRUCTURE_VIOLATION in [w.kind for w in tree.warnings]


def test_an_untyped_row_takes_the_type_its_level_agrees_on(tmp_path: Path) -> None:
    csv_text = (
        "Work Item Type,Title 1,Title 2,Title 3\n"
        + "Epic,E,,\n"
        + "".join(f"Feature,,F{i},\n" for i in range(9))
        + ",,Untyped,\n"
    )
    rule = study_tables(_doc(tmp_path, csv_text))["t0"]
    plan = next(r for r in rule.rows if r.title == "Untyped")
    assert (plan.type, plan.type_source) == ("Feature", "learned")


def test_the_check_names_an_item_a_later_step_retyped(tmp_path: Path) -> None:
    doc = _doc(tmp_path, LEVELS)
    tree = build_baseline_tree(doc)
    next(n for n in tree.nodes if n.title == "Feat B").type = next(
        n for n in tree.nodes if n.title == "Req 1"
    ).type
    warnings = verify_tree_against_rules(doc, WorkItemTree(nodes=tree.nodes))
    assert [w.kind for w in warnings] == [WarningKind.RULEBOOK_MISMATCH]
    assert "Feat B" in warnings[0].raw


def test_a_table_that_states_no_types_is_left_to_the_other_paths(tmp_path: Path) -> None:
    doc = _doc(tmp_path, "Component,Voltage\nFPGA,3.3V\nCPU,5V\n")
    assert study_tables(doc) == {}
    assert len(build_baseline_tree(doc).nodes) == 3


def test_a_single_description_column_is_the_description_without_a_label(tmp_path: Path) -> None:
    text = "המערכת תתמוך בהפעלה מרחוק של היחידה כולל בדיקה עצמית מלאה ודיווח תקלות למפעיל ורישום כל פעולה ביומן המערכת לצורך מעקב."
    csv_text = f"Work Item Type,Title,תיאור\nEpic,E,{text}\nFeature,F,{text}\nRequirement,R,{text}\n"
    doc = _doc(tmp_path, csv_text)
    assert len(study_tables(doc)["t0"].description_cols) == 1
    by_title = {n.title: n for n in build_baseline_tree(doc).nodes}
    assert by_title["R"].description == text


def test_several_description_columns_keep_their_labels(tmp_path: Path) -> None:
    csv_text = "Work Item Type,Title,Notes,Comments\nEpic,E,n1,c1\nFeature,F,n2,c2\nRequirement,R,n3,c3\n"
    by_title = {n.title: n for n in build_baseline_tree(_doc(tmp_path, csv_text)).nodes}
    assert by_title["R"].description == "**Notes:**\n\nn3\n\n**Comments:**\n\nc3"


def test_with_several_columns_a_first_one_named_description_stays_unlabelled(tmp_path: Path) -> None:
    csv_text = "Work Item Type,Title,Description,Notes\nEpic,E,d1,n1\nFeature,F,d2,n2\nRequirement,R,d3,n3\n"
    by_title = {n.title: n for n in build_baseline_tree(_doc(tmp_path, csv_text)).nodes}
    assert by_title["R"].description == "d3\n\n**Notes:**\n\nn3"


def test_the_breakdown_of_a_large_table_stays_small(tmp_path: Path) -> None:
    import json

    from app.study.file_rules import table_details

    long_title = "Requirement title " * 20
    lines = ["Work Item Type,Title 1,Title 2,Title 3", "Epic,Top,,", "Feature,,Feat,"]
    lines += [f"Requirement,,,{long_title} {n}" if n % 4 else f"Bug,,,bug {n}" for n in range(10_000)]
    lines += ["Requirement,,,"]  # no title: shown by its first filled cell
    doc = _doc(tmp_path, "\n".join(lines) + "\n")
    rule = study_tables(doc)["t0"]
    details = table_details(doc.tables[0], rule)
    assert details["totalRows"] == 10_003 and details["typeCounts"] == {"Epic": 1, "Feature": 1, "Requirement": 7500}
    assert all(len(rows) <= 3 for rows in details["samples"].values())
    assert all(len(s["title"]) <= 120 for rows in details["samples"].values() for s in rows)
    skipped = details["skipped"]
    assert skipped["count"] == 2501 and skipped["byReason"] == {"type:Bug": 2500, "no_title": 1}
    assert len(skipped["rows"]) == 20 and skipped["more"] == 2481
    assert len(json.dumps(details)) < 8_000


def test_a_row_without_a_title_is_shown_by_its_first_filled_cell(tmp_path: Path) -> None:
    from app.study.file_rules import table_details

    doc = _doc(tmp_path, "Work Item Type,Title 1,Title 2,Title 3\nEpic,Top,,\nFeature,,,\nFeature,,Feat,\nRequirement,,,Req\n")
    rows = table_details(doc.tables[0], study_tables(doc)["t0"])["skipped"]["rows"]
    assert rows == [{"row": 3, "reason": "no_title", "text": "Feature"}]


def test_a_parent_listed_after_its_child_is_still_its_parent(tmp_path: Path) -> None:
    doc = _doc(tmp_path, "ID,Parent,Title,Type\n3,2,Req A,Requirement\n1,,Epic A,Epic\n2,1,Feat A,Feature\n4,2,Req B,Requirement\n")
    tree = build_baseline_tree(doc)
    by_title = {n.title: n for n in tree.nodes}
    assert by_title["Req A"].parent_local_id == by_title["Feat A"].local_id
    assert by_title["Feat A"].parent_local_id == by_title["Epic A"].local_id
    assert by_title["Req A"].source_ref.section_path == ["Epic A", "Feat A"]
    # Ids still follow the rows of the file, whatever order the parents come in.
    assert [n.local_id for n in tree.nodes] == ["r0_0", "r0_1", "r0_2", "r0_3"]
    assert [n.title for n in tree.nodes] == ["Req A", "Epic A", "Feat A", "Req B"]
    assert WarningKind.SOURCE_STRUCTURE_VIOLATION not in [w.kind for w in tree.warnings]
    assert verify_tree_against_rules(doc, tree) == []


def test_a_row_under_a_skipped_parent_listed_later_is_not_imported(tmp_path: Path) -> None:
    doc = _doc(tmp_path, "ID,Parent,Title,Type\n4,5,Req B,Requirement\n1,,Epic A,Epic\n5,1,Junk,Test Case\n")
    rule = study_tables(doc)["t0"]
    assert dict(rule.skipped_counts()) == {"type:Test Case": 1, "under_skipped": 1}
    assert rule.violations == []
    tree = build_baseline_tree(doc)
    assert [n.title for n in tree.nodes] == ["Epic A"]
    assert verify_tree_against_rules(doc, tree) == []


def test_rows_whose_parents_form_a_cycle_are_not_imported_and_are_reported(tmp_path: Path) -> None:
    doc = _doc(tmp_path, "ID,Parent,Title,Type\n1,2,A,Epic\n2,1,B,Feature\n3,2,C,Requirement\n9,,Root,Epic\n")
    rule = study_tables(doc)["t0"]
    assert dict(rule.skipped_counts()) == {"in_cycle": 2, "under_skipped": 1}
    tree = build_baseline_tree(doc)
    assert [n.title for n in tree.nodes] == ["Root"]
    cycle = [w for w in tree.warnings if (w.detail or {}).get("reason") == "in_cycle"]
    assert len(cycle) == 1 and "2 row(s)" in cycle[0].raw and "cycle" in cycle[0].raw


def test_a_duplicate_id_points_children_at_its_first_row(tmp_path: Path) -> None:
    doc = _doc(tmp_path, "ID,Parent,Title,Type\n1,,E1,Epic\n1,,E2,Epic\n2,1,F,Feature\n")
    by_title = {n.title: n for n in build_baseline_tree(doc).nodes}
    assert by_title["F"].parent_local_id == by_title["E1"].local_id
    assert by_title["E2"].parent_local_id is None


def test_a_deep_chain_listed_child_first_is_built_quickly(tmp_path: Path) -> None:
    import time

    depth = 1000
    lines = ["ID,Parent,Title,Type"] + [f"{i},{i - 1 if i > 1 else ''},E{i},Epic" for i in range(depth, 0, -1)]
    doc = _doc(tmp_path, "\n".join(lines) + "\n")
    started = time.perf_counter()
    rule = study_tables(doc)["t0"]
    assert len(rule.kept) == depth and rule.violations == []
    tree = build_baseline_tree(doc)
    assert time.perf_counter() - started < 10
    by_title = {n.title: n for n in tree.nodes}
    assert by_title[f"E{depth}"].parent_local_id == by_title[f"E{depth - 1}"].local_id
    assert by_title["E1"].parent_local_id is None
    assert len(by_title[f"E{depth}"].source_ref.section_path) == depth - 1


def test_survey_keeps_a_stated_requirement_under_an_epic_as_baseline_does(tmp_path: Path) -> None:
    """A file that states a Requirement directly under an Epic: kept as stated and reported once, in both modes. SURVEY's ladder repair must not
    add a bridge Feature over a stated parent and then report its own change as a rulebook mismatch."""
    from app.leveling.llm_leveling import build_survey_tree

    from .test_structure_contract import (
        SimulatedGrouper,
        StructureRefusingClient,
        TitleHashEmbedder,
    )

    csv_text = "ID,Parent,Title,Work Item Type\n1,,E,Epic\n2,1,F,Feature\n3,2,R1,Requirement\n4,1,R directly under the epic,Requirement\n"
    doc = _doc(tmp_path, csv_text)
    baseline = build_baseline_tree(doc)
    survey = build_survey_tree(
        doc,
        StructureRefusingClient(),
        grouping_client=SimulatedGrouper(1),
        embed_client=TitleHashEmbedder(),
    )

    def shape(tree) -> set:
        by_id = {n.local_id: n for n in tree.nodes}
        return {(n.type.value, n.title, by_id[n.parent_local_id].title if n.parent_local_id in by_id else None) for n in tree.nodes}

    assert shape(survey) == shape(baseline)
    assert ("Requirement", "R directly under the epic", "E") in shape(survey)
    for tree in (baseline, survey):
        kinds = [w.kind for w in tree.warnings]
        assert kinds.count(WarningKind.SOURCE_STRUCTURE_VIOLATION) == 1
        assert WarningKind.RULEBOOK_MISMATCH not in kinds
        assert WarningKind.BRIDGE_FEATURE_SYNTHESIZED not in kinds
