# ingestion/app/leveling/sheet_study.py
"""Spreadsheets as lists of requirements, read by the model and applied by code.

A sheet of 2,000 rows used to reach the model as ONE call (SURVEY) or become ONE work item with the whole table as its description
(BASELINE): the call failed or kept a few hundred rows, and nothing said which. What a row means depends on the file (a requirements
list, a lookup table, a test matrix), so the model is asked to STUDY the sheet, once, from a bounded sample: which rows are headers, which
column holds each requirement's id, title and text, which low-cardinality columns are the sections the rows fall under. Code then applies
that plan to EVERY row, word for word, so no row is skipped and no cell value is rewritten, and the cost no longer grows with the row count.

The plan is checked against the sheet before it is used (columns in range, the chosen text columns actually filled, section columns
that really group). A plan that fails the check, a model that says the sheet is not a list of requirements, or a failed call leaves the
sheet where it was (the model-driven path as before) and says so in a warning: never a half-mapped sheet.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from app.canonical.model import Table
from app.job_cancel import JobCancelled
from app.leveling.id_hierarchy import HierarchyRow

logger = logging.getLogger(__name__)

# What the model is shown: enough rows to see the shape of the sheet, never the sheet.
SAMPLE_HEAD_ROWS = 40
SAMPLE_TAIL_ROWS = 5
SAMPLE_CELL_CHARS = 160
SAMPLE_MAX_CHARS = 14_000

# The most section levels a plan may use, and how much of the data a chosen column must fill to be believed.
MAX_GROUP_COLUMNS = 2
MIN_FILLED_FRACTION = 0.3
# A column whose values are nearly all different is an identifier or free text, not a section a row falls under.
MAX_GROUP_DISTINCT_FRACTION = 0.5
MAX_HEADER_ROWS = 5

_SHALL = re.compile(r"\bshall\b", re.IGNORECASE)


class SheetStudyClient(Protocol):
    def study_spreadsheet(self, sample: dict, user_id: str | None = None) -> dict: ...


@dataclass(frozen=True)
class SheetPlan:
    """How the model read one sheet. Column numbers count from 0, as in the sample it was shown."""

    header_rows: int
    id_column: int | None
    title_column: int | None
    text_columns: tuple[int, ...]
    group_columns: tuple[int, ...]  # outermost section first
    summary: str  # the model's one-line reading of the sheet, shown to the reviewer


@dataclass(frozen=True)
class SheetMapping:
    """What came of studying one sheet: `rows` is None when the sheet was not mapped, and `reason` then says why."""

    rows: list[HierarchyRow] | None
    plan: SheetPlan | None
    reason: str | None
    # Rows that were blank and so produced nothing (counted, never silently lost: a row with any content always produces an item).
    blank_rows: int = 0
    item_rows: int = 0


def _grid(table: Table) -> list[list[str]]:
    return [[(cell.text if cell is not None else "") for cell in row] for row in table.cells]


def _clip(text: str) -> str:
    text = " ".join(text.split())
    return text if len(text) <= SAMPLE_CELL_CHARS else text[:SAMPLE_CELL_CHARS] + "…"


def sheet_sample(table: Table) -> dict:
    """The bounded view the model studies: the first rows, the last few, and what each column looks like over the WHOLE sheet."""
    grid = _grid(table)
    width = len(grid[0]) if grid else 0
    body = grid
    columns = []
    for index in range(width):
        values = [row[index].strip() for row in body]
        filled = [v for v in values if v]
        columns.append(
            {
                "column": index,
                "filledFraction": round(len(filled) / len(values), 2) if values else 0,
                "distinctValues": len(set(filled)),
                "averageLength": round(sum(len(v) for v in filled) / len(filled)) if filled else 0,
            }
        )
    head = [{"row": i, "cells": [_clip(c) for c in grid[i]]} for i in range(min(SAMPLE_HEAD_ROWS, len(grid)))]
    tail_start = max(SAMPLE_HEAD_ROWS, len(grid) - SAMPLE_TAIL_ROWS)
    tail = [{"row": i, "cells": [_clip(c) for c in grid[i]]} for i in range(tail_start, len(grid))]
    sample = {
        "sheet": table.caption or table.id,
        "rowCount": len(grid),
        "columnCount": width,
        "columns": columns,
        "firstRows": head,
        "lastRows": tail,
    }
    # A very wide or very wordy sheet: shrink the rows shown until it fits, keeping every column's statistics.
    while len(str(sample)) > SAMPLE_MAX_CHARS and len(sample["firstRows"]) > 5:
        sample["firstRows"] = sample["firstRows"][: max(5, len(sample["firstRows"]) // 2)]
    return sample


def _int_or_none(value: object, width: int) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < width else None


def validate_sheet_plan(raw: dict, grid: list[list[str]]) -> SheetPlan | str:
    """The model's answer as a SheetPlan, or the reason it cannot be used. Checked against the sheet itself: the model can misread a
    column number, and a plan applied to the wrong column would turn every row into the wrong text."""
    if raw.get("kind") != "requirements_list":
        return "the model read this sheet as something other than a list of requirements"
    width = len(grid[0]) if grid else 0
    header_rows = raw.get("header_rows")
    if not isinstance(header_rows, int) or isinstance(header_rows, bool) or not 0 <= header_rows <= min(MAX_HEADER_ROWS, len(grid) - 1):
        return "the model gave a header row count that does not fit the sheet"
    data = grid[header_rows:]
    id_column = _int_or_none(raw.get("id_column"), width)
    title_column = _int_or_none(raw.get("title_column"), width)
    raw_text = raw.get("text_columns")
    text_columns = tuple(
        dict.fromkeys(c for c in (raw_text if isinstance(raw_text, list) else []) if _int_or_none(c, width) is not None)
    )
    if title_column is None and not text_columns:
        return "the model named no column holding the requirement text"
    used = [c for c in (title_column, *text_columns) if c is not None]

    def filled_fraction(column: int) -> float:
        return sum(1 for row in data if row[column].strip()) / len(data) if data else 0

    if not data or max(filled_fraction(c) for c in used) < MIN_FILLED_FRACTION:
        return "the columns the model chose for the requirement text are mostly empty"
    raw_groups = raw.get("group_columns")
    groups: list[int] = []
    for column in raw_groups if isinstance(raw_groups, list) else []:
        if _int_or_none(column, width) is None or column in used or column == id_column or column in groups:
            continue
        values = {row[column].strip() for row in data if row[column].strip()}
        # Spanned cells read as blank in a merged section column, so a section column is judged on the values it does state.
        if 2 <= len(values) <= max(2, int(len(data) * MAX_GROUP_DISTINCT_FRACTION)):
            groups.append(column)
    summary = raw.get("summary")
    return SheetPlan(
        header_rows=header_rows,
        id_column=id_column,
        title_column=title_column,
        text_columns=tuple(c for c in text_columns if c != title_column),
        group_columns=tuple(groups[:MAX_GROUP_COLUMNS]),
        summary=" ".join(summary.split())[:300] if isinstance(summary, str) else "",
    )


def _header_labels(grid: list[list[str]], header_rows: int, width: int) -> list[str]:
    labels = []
    for column in range(width):
        parts = [grid[r][column].strip() for r in range(header_rows) if grid[r][column].strip()]
        labels.append(" ".join(dict.fromkeys(parts)))
    return labels


def rows_from_sheet_plan(table: Table, plan: SheetPlan) -> SheetMapping:
    """Every data row of the sheet as a hierarchy row, word for word: the sheet is the root, each distinct section value a Feature under
    it (nested when there are two section columns), each data row a Requirement whose description is its title and text cells as written.
    A row with content always produces an item (its cells are used whole when the chosen columns are empty in it); only a row with no
    content at all produces nothing, and those are counted."""
    grid = _grid(table)
    width = len(grid[0]) if grid else 0
    labels = _header_labels(grid, plan.header_rows, width)
    rows: list[HierarchyRow] = []
    ref = table.source_ref
    sheet_label = table.caption or f"Table {table.id}"

    def add(label: str, node_type: str, parent: int | None, id_text: str, *, authored: bool = False, shall: bool = False) -> int:
        rows.append(
            HierarchyRow(
                label=label,
                has_shall=shall,
                source_ref=ref,
                node_type=node_type,
                parent_index=parent,
                id_text=id_text,
                id_disambiguator_needed=True,
                needs_synthesis=False,
                id_text_is_authored=authored,
            )
        )
        return len(rows) - 1

    root = add(sheet_label, "Epic", None, f"{table.id}_sheet")
    group_index: dict[tuple[str, ...], int] = {}
    last_group_values: list[str] = [""] * len(plan.group_columns)
    seen_ids: set[str] = set()
    blank_rows = 0
    items = 0

    def described(row: list[str], columns: list[int]) -> str:
        lines = []
        for column in columns:
            value = row[column].strip()
            if not value:
                continue
            lines.append(value if (column == plan.title_column or not labels[column]) else f"{labels[column]}: {value}")
        return "\n".join(lines)

    for number in range(plan.header_rows, len(grid)):
        row = grid[number]
        if not any(cell.strip() for cell in row):
            blank_rows += 1
            continue
        # A section cell left empty by a merge belongs to the section above; a section cell that is really blank ends the nesting there.
        parent = root
        path: list[str] = []
        for level, column in enumerate(plan.group_columns):
            spanned = table.cells[number][column] is None
            value = row[column].strip() or (last_group_values[level] if spanned else "")
            if not value:
                break
            if value != last_group_values[level]:
                last_group_values[level:] = [value] + [""] * (len(last_group_values) - level - 1)
            path.append(value)
            key = tuple(path)
            if key not in group_index:
                group_index[key] = add(value, "Feature", parent, f"{table.id}_g{len(group_index)}")
            parent = group_index[key]
        text_columns = ([plan.title_column] if plan.title_column is not None else []) + [
            c for c in plan.text_columns if c != plan.title_column
        ]
        description = described(row, text_columns)
        if not description:
            # Content only outside the chosen columns: still an item, never a dropped row.
            description = described(row, [c for c in range(width) if c != plan.id_column])
        id_value = row[plan.id_column].strip() if plan.id_column is not None else ""
        authored = bool(id_value) and id_value not in seen_ids
        if authored:
            seen_ids.add(id_value)
        add(
            description or id_value,
            "Requirement",
            parent,
            id_value if authored else f"{table.id}_r{number}",
            authored=authored,
            shall=bool(_SHALL.search(description)),
        )
        items += 1
    return SheetMapping(rows=rows, plan=plan, reason=None, blank_rows=blank_rows, item_rows=items)


def describe_plan(table: Table, plan: SheetPlan) -> dict:
    """The plan in the sheet's own words (column headings, falling back to the column number), for the reviewer to check."""
    grid = _grid(table)
    width = len(grid[0]) if grid else 0
    labels = _header_labels(grid, plan.header_rows, width)

    def name(column: int | None) -> str | None:
        return None if column is None else (labels[column] or f"column {column}")

    return {
        "id": name(plan.id_column),
        "title": name(plan.title_column),
        "text": [name(c) for c in plan.text_columns],
        "sections": [name(c) for c in plan.group_columns],
        "summary": plan.summary,
    }


def study_sheet(
    table: Table,
    client: SheetStudyClient,
    user_id: str | None = None,
    on_error: Callable[[Exception], None] | None = None,
) -> SheetMapping:
    """Asks the model how to read one sheet and maps every row by its answer. Never raises for a model that fails or answers badly (the
    sheet is then reported as not mapped); a cancelled run (JobCancelled, which a used-up token budget also raises) always propagates."""
    grid = _grid(table)
    if len(grid) < 2 or not grid[0]:
        return SheetMapping(rows=None, plan=None, reason="the sheet has no data rows")
    try:
        raw = client.study_spreadsheet(sheet_sample(table), user_id=user_id)
    except JobCancelled:
        raise
    except Exception as error:  # noqa: BLE001 -- a failed study leaves the sheet on the model-driven path, reported
        logger.warning("Spreadsheet study failed for %s: %s", table.id, error, exc_info=True)
        if on_error is not None:
            on_error(error)
        return SheetMapping(rows=None, plan=None, reason="the model could not be asked about this sheet")
    if not isinstance(raw, dict):
        return SheetMapping(rows=None, plan=None, reason="the model's answer about this sheet could not be read")
    plan = validate_sheet_plan(raw, grid)
    if isinstance(plan, str):
        return SheetMapping(rows=None, plan=None, reason=plan)
    return rows_from_sheet_plan(table, plan)
