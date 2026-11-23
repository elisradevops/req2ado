"""A table that states its items (an ADO tree export) is imported row for row, in BASELINE and SURVEY: no row is lost without a report, and no pass
regroups, retypes or rewrites what the file states."""

from __future__ import annotations

from collections import Counter
from pathlib import Path

from app.canonical.markup import html_to_markdown
from app.dispatch import dispatch_by_extension
from app.leveling.llm_leveling import build_survey_tree
from app.leveling.rule_builder import verify_tree_against_rules
from app.leveling.tree_builder import build_baseline_tree
from app.study.file_rules import rule_from_spec, study_tables
from app.study.rulebook import RuleSpec
from app.workitem.model import WarningKind, WorkItemTree

from .accuracy.variants import FIXTURE, ladder_items, read_rows


def _doc(tmp_path: Path, csv_text: str):
    path = tmp_path / "sheet.csv"
    path.write_text(csv_text, encoding="utf-8")
    return dispatch_by_extension("sheet.csv", str(path))


def _export():
    return dispatch_by_extension(FIXTURE.name, str(FIXTURE))


class _Analysis:
    model = "stub"


class _SimilarTitles:
    """Every title close to every other, so any root offered to the grouping is grouped."""

    def embed(self, texts, user_id=None):
        return [[1.0, 0.001 * i] for i, _ in enumerate(texts)]


class _Namer:
    def name_root_groups(self, groups, user_id=None):
        return {key: "Software Requirements" for key in groups}


class _RecordingSummary:
    def __init__(self) -> None:
        self.sent: list[str] = []

    def summarize_parent_nodes(self, payload, *args, **kwargs):
        self.sent += [str(key) for key in (payload.keys() if isinstance(payload, dict) else [])]
        raise RuntimeError("no summary in this test")


def _survey(doc, summary=None):
    return build_survey_tree(
        doc,
        _Analysis(),
        embed_client=_SimilarTitles(),
        grouping_client=_Namer(),
        parent_summary_client=summary or _RecordingSummary(),
    )


def _truth():
    return [(i.type, i.title, i.parent) for i in ladder_items()]


def _as_built(tree):
    by_id = {n.local_id: n for n in tree.nodes}
    return [
        (n.type.value, n.title, by_id[n.parent_local_id].title if n.parent_local_id else None)
        for n in tree.nodes
    ]


def test_baseline_imports_every_stated_row_as_the_file_states_it() -> None:
    tree = build_baseline_tree(_export())
    assert Counter(n.type.value for n in tree.nodes) == {"Epic": 4, "Feature": 39, "Requirement": 235}
    assert _as_built(tree) == _truth()
    assert not {"Work Item Type", "Title 1", "ID"} & {n.title for n in tree.nodes}


def test_survey_keeps_the_stated_structure_and_text() -> None:
    summary = _RecordingSummary()
    tree = _survey(_export(), summary)
    assert Counter(n.type.value for n in tree.nodes) == {"Epic": 4, "Feature": 39, "Requirement": 235}
    assert _as_built(tree) == _truth()
    assert [n.title for n in tree.nodes if n.parent_local_id is None] == [
        i.title for i in ladder_items() if i.parent is None
    ]
    kinds = {w.kind for w in tree.warnings}
    assert WarningKind.ROOTS_REGROUPED not in kinds and WarningKind.CATCHALL_EPIC_WRAP not in kinds
    assert WarningKind.RULEBOOK_MISMATCH not in kinds


def test_survey_never_sends_a_stated_item_to_the_parent_summary() -> None:
    class Counting:
        calls = 0

        def summarize_parent_nodes(self, *args, **kwargs):
            Counting.calls += 1
            raise AssertionError("a stated Epic or Feature must not be summarized over")

    _survey(_export(), Counting())
    assert Counting.calls == 0


def test_the_description_is_the_description_cell_only() -> None:
    rows = {
        (r["Title 1"] or r["Title 2"] or r["Title 3"]).strip(): r
        for r in read_rows()
        if r["Work Item Type"] != "Test Case"
    }
    for tree in (build_baseline_tree(_export()), _survey(_export())):
        for node in tree.nodes:
            row = rows[node.title]
            expected = html_to_markdown(row["Description"].strip()) or node.title
            assert node.description.startswith(expected), node.title
            assert "Impact Assessment" not in node.description


def test_skipped_rows_are_each_named() -> None:
    [warning] = [w for w in build_baseline_tree(_export()).warnings if w.kind == WarningKind.SOURCE_TYPE_SKIPPED]
    test_cases = [
        (line, (r["Title 1"] or r["Title 2"] or r["Title 3"]).strip())
        for line, r in enumerate(read_rows(), start=2)
        if r["Work Item Type"] == "Test Case"
    ]
    assert warning.detail["count"] == 68 and warning.detail["type"] == "Test Case"
    assert [(r["row"], r["title"]) for r in warning.detail["rows"]] == test_cases
    line, title = test_cases[0]
    assert f"row {line} '{title}'" in warning.raw


def test_a_named_description_column_is_the_only_description(tmp_path: Path) -> None:
    csv_text = "Work Item Type,Title,Description,Notes\nEpic,E,d1,n1\nFeature,F,d2,n2\nRequirement,R,d3,n3\n"
    doc = _doc(tmp_path, csv_text)
    for origin in ("stated", "model", "user"):
        spec = RuleSpec(header_row=0, nesting="order", type_col=0, title_col=1, description_cols=(2, 3), origin=origin)
        assert rule_from_spec(doc.tables[0], spec).description_cols == [2], origin
    without = RuleSpec(header_row=0, nesting="order", type_col=0, title_col=1, description_cols=(3,), origin="model")
    assert rule_from_spec(doc.tables[0], without).description_cols == [3]


def test_the_check_names_a_stated_root_that_was_given_a_parent() -> None:
    doc = _export()
    tree = build_baseline_tree(doc)
    roots = [n for n in tree.nodes if n.parent_local_id is None]
    roots[1].parent_local_id = roots[0].local_id
    warnings = verify_tree_against_rules(doc, WorkItemTree(nodes=tree.nodes))
    assert [w.kind for w in warnings] == [WarningKind.RULEBOOK_MISMATCH]
    assert roots[1].title[:60] in warnings[0].raw


def test_the_check_is_not_fooled_by_a_shared_title(tmp_path: Path) -> None:
    csv_text = (
        "Work Item Type,Title 1,Title 2,Title 3\n"
        "Epic,E,,\nFeature,,A,\nRequirement,,,Same\nFeature,,B,\nRequirement,,,Same\n"
    )
    doc = _doc(tmp_path, csv_text)
    tree = build_baseline_tree(doc)
    # The two "Same" rows swap parents: looked up by title, each stated row still finds a "Same" under its own parent.
    first, second = [n for n in tree.nodes if n.title == "Same"]
    first.parent_local_id, second.parent_local_id = second.parent_local_id, first.parent_local_id
    assert [w.kind for w in verify_tree_against_rules(doc, WorkItemTree(nodes=tree.nodes))] == [
        WarningKind.RULEBOOK_MISMATCH
    ]


def test_study_tables_gives_the_export_one_description_column() -> None:
    rule = study_tables(_export())["t0"]
    assert [rule.labels[c] for c in rule.description_cols] == ["Description"]


def test_every_column_with_values_that_is_not_read_is_named() -> None:
    # Nothing vanishes silently: a column the rule gives no role to is listed. An empty column (ID, Parent in this export) says nothing.
    [warning] = [w for w in build_baseline_tree(_export()).warnings if w.kind == WarningKind.COLUMNS_NOT_IMPORTED]
    expected = [
        "Assigned To",
        "State",
        "Impact Assessment HTML",
        "Node Name",
        "Area Path",
        "Tags",
        "Requirement Type",
        "Team Project",
        "Value Area",
    ]
    assert warning.detail["columns"] == expected and warning.detail["count"] == len(expected)
    assert all(name in warning.raw for name in expected)


def test_a_table_whose_columns_are_all_read_has_no_column_notice(tmp_path: Path) -> None:
    csv_text = "Work Item Type,Title,Description\nEpic,E,d1\nFeature,F,d2\nRequirement,R,d3\n"
    kinds = {w.kind for w in build_baseline_tree(_doc(tmp_path, csv_text)).warnings}
    assert WarningKind.COLUMNS_NOT_IMPORTED not in kinds


def test_the_column_notice_counts_only_imported_rows(tmp_path: Path) -> None:
    # A column filled only on rows that are not imported (here a Test Case) carries nothing into the work items.
    csv_text = "Work Item Type,Title,Steps\nEpic,E,\nFeature,F,\nRequirement,R,\nTest Case,T,step 1\n"
    kinds = {w.kind for w in build_baseline_tree(_doc(tmp_path, csv_text)).warnings}
    assert WarningKind.COLUMNS_NOT_IMPORTED not in kinds
