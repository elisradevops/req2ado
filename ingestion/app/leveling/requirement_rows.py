# ingestion/app/leveling/requirement_rows.py
"""Detects a "requirements list" table -- one whose rows are each a
SEPARATE, independently-identified requirement, not one table's worth of
supplementary data for a single surrounding requirement. Confirmed live,
two real documents, opposite shapes:

    Mock_PRD_Sensor.docx: # | Parameter | Requirement / Value
                          P-SENSOR-001# | Time sync source | The system shall...
                          P-SENSOR-002# | Sync accuracy | Timing accuracy shall...
    -- every row has its own literal id AND its own "shall" statement: 19
    such rows across 5 tables, exactly the 19 Requirements the customer's
    own expected-results CSV lists. The dotted-numeric table convention
    (id_hierarchy.rows_from_table, strictly 2 columns) does not recognise
    them (3 columns, a "P-SENSOR-NNN#"-style id), so without this module
    the rows were merged into fewer items than the document specifies.

    AirPro_BP_ICD_Revision_0.3.docx: SRU module | QTY | Unit Power [Watt] | Total power
                                     Power supply Efficiency | 1 | 63 | 0.87
    -- a values/power-budget table with no per-row identifier at all: 0
    qualifying rows across its own 5 tables. Correctly stays exactly as-is
    (folded into its one surrounding requirement's description) -- this
    module's whole purpose is to tell those two shapes apart, not to widen
    what counts as a "requirement".

The discriminator is deliberately the ID COLUMN, not a "shall" statement
(unlike id_hierarchy's dotted-numeric table convention, whose leaf/group
split IS "shall"-based): a row here can have an empty or non-"shall" label cell and
still be a real, separately-numbered requirement (Mock_PRD's own
"P-SENSOR-009#" row has a blank Parameter cell) -- the source document's
own decision to give it a distinct literal id is the real signal, not
whether the requirement text happens to use the word "shall".

Reuses `id_hierarchy`'s MIN_ID_ROWS/MIN_ID_ROW_FRACTION gates (2 confirmed
rows, and at least half of a table's non-blank rows) so a single stray
code-shaped cell in an otherwise ordinary values table can never reclassify
that whole table -- same "a table either uses this convention or it
doesn't; there is no half-parsed state" rule `id_hierarchy`'s own
`_parse_id_hierarchy_table_rows` already documents for the dotted-ID case.

Every function here is a graceful no-op ([]) for a table that doesn't
match this convention, and never raises for a malformed/unexpected shape.

Known, deliberate limitations (accepted, not silently papered over):
- ID-column-driven: a requirements-list table whose rows have NO per-row
  identifier at all is indistinguishable from a supplementary table by any
  deterministic means, and gets none of this module's benefit (still
  readable by the LLM itself, at stage 1, which is not gated on this
  detector -- see llm_leveling.py's own model-reported customer_id path).
  Under-triggering is the accepted failure direction, matching every other
  heuristic in this file's sibling modules.
- Unlike id_hierarchy's table convention, no column-count restriction and no "shall"
  requirement -- deliberately not inherited, since the ID column alone is
  this detector's discriminator (see above).
- "Code-shaped" is defined entirely by customer_id.py's own pattern
  (extract_customer_requirement_code) -- a convention that pattern can't
  read (no uppercase-letter-prefixed code at all) contributes nothing here,
  even if a human reader would recognize it as an id column."""

from __future__ import annotations

import re
from typing import NamedTuple

from app.canonical.model import Table, plain_text_rows
from app.distillation.title import extract_baseline_title
from app.leveling.customer_id import extract_customer_requirement_code
from app.leveling.id_hierarchy import MIN_ID_ROW_FRACTION, MIN_ID_ROWS


def _best_matching_column(rows: list[list[str]]) -> tuple[int | None, int]:
    """Column index whose cells most often whole-cell-match a customer
    code, and how many rows matched -- UNGATED (no MIN_ID_ROWS/
    MIN_ID_ROW_FRACTION check here; each caller applies its own). Whole-
    cell, not substring -- a prose cell mentioning "per MIL-STD-1553" is
    never mistaken for an id, and a header cell ("#", "Req ID") never
    whole-cell-matches the pattern either, so the header row is excluded
    by SHAPE, never by wording."""
    num_cols = max((len(row) for row in rows), default=0)
    if num_cols < 2:
        return None, 0
    best_index: int | None = None
    best_count = 0
    for col in range(num_cols):
        count = 0
        for row in rows:
            if col >= len(row):
                continue
            cell = row[col].strip()
            if cell and extract_customer_requirement_code(cell) == cell:
                count += 1
        if count > best_count:
            best_count = count
            best_index = col
    return best_index, best_count


def _id_column_index(rows: list[list[str]]) -> int | None:
    """Column index whose cells most often whole-cell-match a customer
    code, or None if no column qualifies -- gated on BOTH MIN_ID_ROWS and
    MIN_ID_ROW_FRACTION: this is the "is this table AS A WHOLE a
    requirements list" decision (see the module docstring), not a lighter
    single-code lookup."""
    best_index, best_count = _best_matching_column(rows)
    if best_count < MIN_ID_ROWS or best_count < len(rows) * MIN_ID_ROW_FRACTION:
        return None
    return best_index


def _gated_id_rows(table: Table) -> tuple[list[list[str]], int] | None:
    """The table's non-blank rows and its id column, or None when the table
    as a whole is not a requirements list -- the gate behind
    `atomizable_requirement_rows`."""
    rows = [row for row in plain_text_rows(table) if any(cell.strip() for cell in row)]
    if len(rows) < MIN_ID_ROWS:
        return None
    id_column = _id_column_index(rows)
    if id_column is None:
        return None
    return rows, id_column


class AtomicRow(NamedTuple):
    code: str  # verbatim id-cell text, same as RequirementRowInfo.code
    cells: tuple[str, ...]  # every other non-empty cell, trimmed, in column order


_NAME_CELL_MAX_WORDS = 8
_STATEMENT_MODAL = re.compile(r"\b(?:shall|must|should|will)\b", re.IGNORECASE)


def _is_statement(cell: str) -> bool:
    return bool(_STATEMENT_MODAL.search(cell)) or len(cell.split()) > _NAME_CELL_MAX_WORDS


def row_title_and_description(code: str, cells: tuple[str, ...]) -> tuple[str, str]:
    """Source text for the title and the description of one atomized row.
    When the first non-id cell is clearly a name (short, not a statement)
    and the longest cell is the statement, the name is the title and the
    remaining cells are the description. Otherwise the longest cell is the
    title and every cell stays in the description, as before. Never drops a cell."""
    if not cells:
        return code, code
    longest = max(cells, key=len)
    first = cells[0]
    if (
        len(cells) >= 2
        and first is not longest
        and not _is_statement(first)
        and _is_statement(longest)
        # A name the title extractor would cut ("Max. voltage" -> "Max.") must stay whole.
        and extract_baseline_title(first) == first
    ):
        return first, "\n".join(cells[1:])
    return longest, "\n".join(cells)


_HEADER_CELL_MAX_LENGTH = 40


def _looks_like_header_row(row: list[str]) -> bool:
    """Column labels, not content: at least two non-empty cells, each short
    and not sentence-like. A lone spanning title row or a data row with a
    missing id fails this, so the table stays folded and its text is kept."""
    cells = [cell.strip() for cell in row if cell.strip()]
    return len(cells) >= 2 and all(
        len(c) <= _HEADER_CELL_MAX_LENGTH and not c.endswith(".") for c in cells
    )


def atomizable_requirement_rows(table: Table | None) -> list[AtomicRow] | None:
    """The rows of `table` as separate requirements, or None when the table
    must stay folded into its parent's description.

    The table-level decision is `_gated_id_rows` (an id column clearing
    MIN_ID_ROWS/MIN_ID_ROW_FRACTION), plus one extra rule so
    splitting never loses row text: the only non-blank row allowed WITHOUT a
    code is a single leading header-shaped row (column labels). A coded table with any other
    uncoded row (a trailing note, a continuation row) returns None and keeps
    its previous whole-table fold. Column labels of the header row are the one
    accepted loss (they name columns, not requirements). Never raises."""
    if table is None:
        return None
    gated = _gated_id_rows(table)
    if gated is None:
        return None
    rows, id_column = gated
    atoms: list[AtomicRow] = []
    for position, row in enumerate(rows):
        code = row[id_column].strip() if id_column < len(row) else ""
        if code and extract_customer_requirement_code(code) == code:
            cells = tuple(
                cell.strip() for i, cell in enumerate(row) if i != id_column and cell.strip()
            )
            atoms.append(AtomicRow(code=code, cells=cells))
        elif position != 0 or not _looks_like_header_row(row):
            return None
    return atoms
