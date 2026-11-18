"""A spreadsheet read by the model once (from a sample) and mapped to items by code, row by row."""

import pytest
from openpyxl import Workbook

from app.job_cancel import JobCancelled, LlmBudgetExceeded
from app.leveling.sheet_study import (
    SAMPLE_HEAD_ROWS,
    SAMPLE_MAX_CHARS,
    SheetPlan,
    rows_from_sheet_plan,
    sheet_sample,
    study_sheet,
    validate_sheet_plan,
)
from app.loaders.xlsx_loader import load_xlsx


def table_from(tmp_path, rows, merges=(), title="Requirements"):
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = title
    for row in rows:
        sheet.append(row)
    for merged in merges:
        sheet.merge_cells(merged)
    path = tmp_path / "book.xlsx"
    workbook.save(path)
    return load_xlsx(str(path)).tables[0]


HEADER = ["ID", "Section", "Requirement", "Priority"]


def req_rows(n):
    return [[f"REQ-{i:04d}", f"Section {i % 4}", f"The system shall do thing {i}.", "High"] for i in range(n)]


def good_answer(**over):
    answer = {
        "kind": "requirements_list",
        "summary": "A requirements list with one requirement per row.",
        "header_rows": 1,
        "id_column": 0,
        "title_column": 2,
        "text_columns": [3],
        "group_columns": [1],
    }
    answer.update(over)
    return answer


class FakeClient:
    def __init__(self, answer=None, error=None):
        self.answer, self.error, self.samples = answer, error, []

    def study_spreadsheet(self, sample, user_id=None):
        self.samples.append(sample)
        if self.error:
            raise self.error
        return self.answer


def grid_of(table):
    return [[c.text if c else "" for c in row] for row in table.cells]


def test_the_model_is_shown_a_bounded_sample_however_long_the_sheet_is(tmp_path) -> None:
    table = table_from(tmp_path, [HEADER] + req_rows(2000))

    sample = sheet_sample(table)

    assert sample["rowCount"] == 2001 and sample["columnCount"] == 4
    assert len(sample["firstRows"]) == SAMPLE_HEAD_ROWS and len(sample["lastRows"]) == 5
    assert sample["lastRows"][-1]["cells"][0] == "REQ-1999"
    assert len(str(sample)) <= SAMPLE_MAX_CHARS
    # What each column looks like over the whole sheet (the header cell included), so the model need not see every row to judge a column.
    assert {c["column"]: c["distinctValues"] for c in sample["columns"]}[0] == 2001


def test_a_wordy_sheet_is_shown_fewer_rows_rather_than_overflowing_the_prompt(tmp_path) -> None:
    long = "word " * 200
    table = table_from(tmp_path, [HEADER] + [[f"R{i}", "S", long, long] for i in range(100)])
    sample = sheet_sample(table)
    assert len(str(sample)) <= SAMPLE_MAX_CHARS
    assert len(sample["firstRows"]) >= 5


def test_a_good_answer_becomes_a_plan(tmp_path) -> None:
    grid = grid_of(table_from(tmp_path, [HEADER] + req_rows(20)))
    plan = validate_sheet_plan(good_answer(), grid)
    assert plan == SheetPlan(1, 0, 2, (3,), (1,), "A requirements list with one requirement per row.")


@pytest.mark.parametrize(
    "change, reason",
    [
        ({"kind": "other"}, "something other than a list"),
        ({"header_rows": 99}, "header row count"),
        ({"header_rows": "one"}, "header row count"),
        ({"title_column": 9, "text_columns": [9]}, "no column holding"),
        ({"title_column": None, "text_columns": []}, "no column holding"),
    ],
)
def test_an_answer_that_does_not_fit_the_sheet_is_refused_with_a_reason(tmp_path, change, reason) -> None:
    grid = grid_of(table_from(tmp_path, [HEADER] + req_rows(20)))
    assert reason in validate_sheet_plan(good_answer(**change), grid)


def test_columns_the_model_chose_that_are_mostly_empty_are_not_believed(tmp_path) -> None:
    rows = [[f"R{i}", "S", "", "" if i % 10 else "x"] for i in range(50)]
    grid = grid_of(table_from(tmp_path, [HEADER] + rows))
    assert "mostly empty" in validate_sheet_plan(good_answer(), grid)


def test_a_section_column_must_really_group_rows(tmp_path) -> None:
    grid = grid_of(table_from(tmp_path, [HEADER] + req_rows(20)))
    # Column 0 holds a different value per row (an identifier), column 2 is the text itself: neither is a section.
    plan = validate_sheet_plan(good_answer(group_columns=[0, 2, 1, 1]), grid)
    assert plan.group_columns == (1,)
    # One shared value does not group anything either.
    flat = grid_of(table_from(tmp_path, [HEADER] + [[f"R{i}", "Same", "text", "p"] for i in range(10)]))
    assert validate_sheet_plan(good_answer(), flat).group_columns == ()


def test_every_row_becomes_one_requirement_word_for_word(tmp_path) -> None:
    table = table_from(tmp_path, [HEADER] + req_rows(2000))
    plan = validate_sheet_plan(good_answer(), grid_of(table))

    mapping = rows_from_sheet_plan(table, plan)

    requirements = [r for r in mapping.rows if r.node_type == "Requirement"]
    assert mapping.item_rows == len(requirements) == 2000
    assert requirements[0].label == "The system shall do thing 0.\nPriority: High"
    assert requirements[1999].label == "The system shall do thing 1999.\nPriority: High"
    assert all(r.id_disambiguator_needed and not r.needs_synthesis for r in requirements)
    assert requirements[0].has_shall


def test_sections_become_features_under_the_sheet_and_rows_hang_under_their_section(tmp_path) -> None:
    table = table_from(tmp_path, [HEADER] + req_rows(8))
    mapping = rows_from_sheet_plan(table, validate_sheet_plan(good_answer(), grid_of(table)))
    rows = mapping.rows

    assert (rows[0].label, rows[0].node_type, rows[0].parent_index) == ("Requirements", "Epic", None)
    features = [(i, r) for i, r in enumerate(rows) if r.node_type == "Feature"]
    assert [r.label for _, r in features] == ["Section 0", "Section 1", "Section 2", "Section 3"]
    assert all(r.parent_index == 0 for _, r in features)
    by_section = {r.label: i for i, r in features}
    first = next(r for r in rows if r.node_type == "Requirement")
    assert first.parent_index == by_section["Section 0"]


def test_a_section_cell_left_empty_by_a_merge_belongs_to_the_section_above(tmp_path) -> None:
    rows = [HEADER, ["R1", "Power", "The unit shall start.", "H"], ["R2", None, "The unit shall stop.", "H"], ["R3", "Thermal", "The unit shall cool.", "H"]]
    table = table_from(tmp_path, rows, merges=["B2:B3"])
    mapping = rows_from_sheet_plan(table, SheetPlan(1, 0, 2, (3,), (1,), ""))

    sections = {r.label: i for i, r in enumerate(mapping.rows) if r.node_type == "Feature"}
    parents = {r.id_text: r.parent_index for r in mapping.rows if r.node_type == "Requirement"}
    assert parents["R1"] == parents["R2"] == sections["Power"]
    assert parents["R3"] == sections["Thermal"]


def test_a_real_blank_section_cell_is_not_filled_from_the_row_above(tmp_path) -> None:
    rows = [HEADER, ["R1", "Power", "The unit shall start.", "H"], ["R2", "", "The unit shall stop.", "H"]]
    table = table_from(tmp_path, rows)
    mapping = rows_from_sheet_plan(table, SheetPlan(1, 0, 2, (3,), (1,), ""))

    parents = {r.id_text: r.parent_index for r in mapping.rows if r.node_type == "Requirement"}
    assert parents["R2"] == 0  # under the sheet itself, not under "Power"


def test_ids_are_used_when_unique_and_never_twice(tmp_path) -> None:
    rows = [HEADER, ["R1", "S", "first", "H"], ["R1", "S", "second", "H"], ["", "S", "third", "H"]]
    table = table_from(tmp_path, rows)
    mapping = rows_from_sheet_plan(table, SheetPlan(1, 0, 2, (3,), (), ""))

    requirements = [r for r in mapping.rows if r.node_type == "Requirement"]
    assert [(r.id_text, r.id_text_is_authored) for r in requirements] == [("R1", True), ("t0_r2", False), ("t0_r3", False)]


def test_blank_rows_are_counted_and_a_row_with_any_content_is_never_dropped(tmp_path) -> None:
    rows = [HEADER, ["R1", "S", "first", "H"], [None, None, None, None], ["", "", "", "only a priority"]]
    table = table_from(tmp_path, rows)
    mapping = rows_from_sheet_plan(table, SheetPlan(1, 0, 2, (), (), ""))

    requirements = [r for r in mapping.rows if r.node_type == "Requirement"]
    assert mapping.blank_rows == 1 and mapping.item_rows == 2
    assert requirements[1].label == "Priority: only a priority"  # the chosen column was empty: the row's own cells are used whole


def test_study_sheet_maps_the_sheet_from_the_models_answer(tmp_path) -> None:
    table = table_from(tmp_path, [HEADER] + req_rows(30))
    client = FakeClient(good_answer())

    mapping = study_sheet(table, client, user_id="u1")

    assert mapping.reason is None and mapping.item_rows == 30
    assert len(client.samples) == 1  # one call for the whole sheet


@pytest.mark.parametrize(
    "client, reason",
    [
        (FakeClient(error=RuntimeError("boom")), "could not be asked"),
        (FakeClient(answer=["not", "a", "dict"]), "could not be read"),
        (FakeClient(answer=good_answer(kind="other")), "something other than a list"),
    ],
)
def test_a_sheet_the_model_cannot_or_will_not_map_is_reported_not_half_mapped(tmp_path, client, reason) -> None:
    table = table_from(tmp_path, [HEADER] + req_rows(30))
    mapping = study_sheet(table, client)
    assert mapping.rows is None and reason in mapping.reason


def test_a_sheet_with_no_data_rows_is_not_sent_to_the_model(tmp_path) -> None:
    table = table_from(tmp_path, [HEADER])
    client = FakeClient(good_answer())
    assert "no data rows" in study_sheet(table, client).reason
    assert client.samples == []


@pytest.mark.parametrize("error", [JobCancelled("cancelled"), LlmBudgetExceeded("LLM_BUDGET_EXCEEDED: used up")])
def test_a_cancelled_run_or_a_used_up_budget_is_never_swallowed(tmp_path, error) -> None:
    table = table_from(tmp_path, [HEADER] + req_rows(30))
    with pytest.raises(JobCancelled):
        study_sheet(table, FakeClient(error=error))
