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
    own expected-results CSV lists. SURVEY mode's stage-1 skeleton call was
    never told this -- its own node-count floor (heading_count +
    qualifying_table_groups) saw 0 qualifying groups here (table_groups.py
    requires a strictly-2-column dotted-numeric-ID table; these are 3
    columns with a "P-SENSOR-NNN#"-style id) and merged rows into fewer
    nodes than the document actually specifies.

    AirPro_BP_ICD_Revision_0.3.docx: SRU module | QTY | Unit Power [Watt] | Total power
                                     Power supply Efficiency | 1 | 63 | 0.87
    -- a values/power-budget table with no per-row identifier at all: 0
    qualifying rows across its own 5 tables. Correctly stays exactly as-is
    (folded into its one surrounding requirement's description) -- this
    module's whole purpose is to tell those two shapes apart, not to widen
    what counts as a "requirement".

The discriminator is deliberately the ID COLUMN, not a "shall" statement
(unlike this module's sibling `table_groups.py`, whose leaf/group split IS
"shall"-based): a row here can have an empty or non-"shall" label cell and
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
- Unlike table_groups.py, no column-count restriction and no "shall"
  requirement -- deliberately not inherited, since the ID column alone is
  this detector's discriminator (see above).
- "Code-shaped" is defined entirely by customer_id.py's own pattern
  (extract_customer_requirement_code) -- a convention that pattern can't
  read (no uppercase-letter-prefixed code at all) contributes nothing here,
  even if a human reader would recognize it as an id column."""
from __future__ import annotations

from collections.abc import Iterable
from typing import NamedTuple

from app.canonical.model import Table, plain_text_rows
from app.leveling.customer_id import extract_customer_requirement_code
from app.leveling.id_hierarchy import MIN_ID_ROW_FRACTION, MIN_ID_ROWS

_LABEL_MAX_LENGTH = 80


class RequirementRowInfo(NamedTuple):
    table_id: str
    code: str  # verbatim, exactly as the table cell prints it -- never normalized
    label: str  # longest other non-empty cell in the row, truncated -- prompt-hint use only


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
    requirements list" decision (see qualifying_requirement_rows's own
    docstring), not a lighter single-code lookup -- see
    repeated_customer_code_in_table below for that narrower case."""
    best_index, best_count = _best_matching_column(rows)
    if best_count < MIN_ID_ROWS or best_count < len(rows) * MIN_ID_ROW_FRACTION:
        return None
    return best_index


def repeated_customer_code_in_table(table: Table) -> str | None:
    """A SUPPLEMENTARY table's own first customer-assigned code, trusted
    ONLY when the same column repeats a whole-cell code match at least
    MIN_ID_ROWS (2) times -- the absolute floor `_id_column_index` also
    uses, but deliberately WITHOUT that function's MIN_ID_ROW_FRACTION
    gate (the "is this whole table a requirements list" decision --
    qualifying_requirement_rows's own call). A table that met BOTH gates
    is already excluded from ever reaching this function's caller (see
    llm_leveling.py's own Phase 6 exclusion from stage 2 figure/table
    mapping): it was pre-split into its own per-row nodes at stage 1
    instead, so re-checking the exact same full gate here would always
    read empty by construction.

    Guards against a genuinely supplementary column where only ONE cell
    happens to be code-shaped -- a category label, not a repeating id
    column -- which a plain regex search over the table's rendered HTML
    would wrongly trust as this table's own customer id. The MIN_ID_ROWS
    floor alone (no fraction needed) correctly rejects it: one match can
    never reach 2. Confirmed live case and rejected earlier approaches:
    docs/handoff-heading-tier-detector-and-customer-id-fixes.md.

    Returns the FIRST matching row's own code in document order, or None
    if no column reaches the floor. Never raises."""
    rows = [row for row in plain_text_rows(table) if any(cell.strip() for cell in row)]
    if len(rows) < MIN_ID_ROWS:
        return None
    best_index, best_count = _best_matching_column(rows)
    if best_index is None or best_count < MIN_ID_ROWS:
        return None
    for row in rows:
        if best_index >= len(row):
            continue
        cell = row[best_index].strip()
        if cell and extract_customer_requirement_code(cell) == cell:
            return cell
    return None  # unreachable given best_count >= MIN_ID_ROWS, but never trust that blindly


def _row_label(row: list[str], id_column: int) -> str:
    others = [cell.strip() for i, cell in enumerate(row) if i != id_column and cell.strip()]
    if not others:
        return ""
    longest = max(others, key=len)
    return longest if len(longest) <= _LABEL_MAX_LENGTH else longest[:_LABEL_MAX_LENGTH]


def qualifying_requirement_rows(tables: Iterable[Table] | None) -> list[RequirementRowInfo]:
    """Every row, across all given tables, that is itself a separately-
    identified requirement -- one RequirementRowInfo per such row, in
    table/row order. Each table is judged independently: one table's id
    column has no bearing on another's."""
    if not tables:
        return []
    results: list[RequirementRowInfo] = []
    for table in tables:
        rows = [row for row in plain_text_rows(table) if any(cell.strip() for cell in row)]
        if len(rows) < MIN_ID_ROWS:
            continue
        id_column = _id_column_index(rows)
        if id_column is None:
            continue
        for row in rows:
            if id_column >= len(row):
                continue
            code = row[id_column].strip()
            if code and extract_customer_requirement_code(code) == code:
                results.append(RequirementRowInfo(table_id=table.id, code=code, label=_row_label(row, id_column)))
    return results
