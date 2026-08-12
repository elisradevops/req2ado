from __future__ import annotations

import hashlib
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.utils.cell import coordinate_to_tuple
from openpyxl.worksheet.worksheet import Worksheet

from app.canonical.model import CanonicalDoc, Document, DocumentFormat, SourceRef, Table, TableCell

# openpyxl horizontal-alignment values that map onto the canonical model's
# Literal["left", "center", "right", "justify"] with no semantic loss.
_DIRECT_ALIGN_MAP = {"left": "left", "center": "center", "right": "right", "justify": "justify"}
# 'centerContinuous' (a legacy Excel feature that visually centers a value
# across several UNMERGED cells) and 'distributed' (spreads characters to
# fill the cell width, mainly used for CJK text) are both real Excel
# alignments with no exact match in the canonical model's 4-value enum.
# Mapped to the closest visual approximation, 'center', rather than dropped
# to None -- both genuinely center/spread content rather than left- or
# right-align it, so this is an honest approximation, not a fabrication.
_APPROXIMATE_ALIGN_MAP = {"centerContinuous": "center", "distributed": "center"}


def _resolve_align(horizontal: str | None) -> str | None:
    """'general' is Excel's own "no explicit alignment chosen" default --
    numbers happen to right-align and text happens to left-align on screen
    under 'general', but that's Excel's rendering default, not a value the
    author actually set. Mapping it to None (same as an absent alignment)
    matches this feature's "don't fabricate a value that wasn't really
    set" principle -- the same reasoning applied to is_header below. Any
    other value not in either map (e.g. 'fill', a character-repeat mode
    with no real "alignment" meaning) also falls through to None rather
    than guessing.
    """
    if horizontal is None or horizontal == "general":
        return None
    if horizontal in _DIRECT_ALIGN_MAP:
        return _DIRECT_ALIGN_MAP[horizontal]
    return _APPROXIMATE_ALIGN_MAP.get(horizontal)


def _resolve_frozen_header_row_count(sheet: Worksheet) -> int:
    """xlsx has no native is_header signal at all (unlike docx's explicit
    w:trPr/w:tblHeader) -- per the design spec, ws.freeze_panes is used as
    a heuristic: a user who freezes the top N rows is telling Excel (and
    us) "these rows should always stay visible/on top", which is exactly
    what a header row is for. freeze_panes is the coordinate of the FIRST
    UNFROZEN cell (e.g. "A2" freezes row 1 only; "B3" freezes rows 1-2 AND
    column A) -- so the frozen row count is just (that cell's row - 1).

    This is honestly a weak signal, weaker than every other format's:
    plenty of real header rows are never frozen, and a freeze can exist
    for reasons unrelated to headers (e.g. freezing a totals row at the
    bottom of a fixed pane layout). Per this feature's "absent means not
    detected, never half-guess" rule, an unset freeze_panes (the common
    case for a simple, unfrozen sheet) yields ZERO header rows rather than
    guessing "row 0 is probably a header".
    """
    if sheet.freeze_panes is None:
        return 0
    frozen_row, _frozen_col = coordinate_to_tuple(sheet.freeze_panes)
    return frozen_row - 1


def load_xlsx(path: str) -> CanonicalDoc:
    file_path = Path(path)
    sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
    document = Document(path=path, format=DocumentFormat.XLSX, sha256=sha256)

    # values_only=False (the default) is required to reach real Cell objects
    # for .fill/.font/.alignment -- values_only=True (the previous behavior)
    # only ever returned bare values with no style access at all. data_only
    # =True is unchanged from before: it reads cached FORMULA RESULTS rather
    # than formula strings, same value semantics the old values_only=True
    # pass already relied on.
    #
    # Bounding the sheet region: openpyxl's well-known "inflated dimension"
    # gotcha (iterating a huge, mostly-empty range because a producer wrote
    # a stale/wrong <dimension> XML tag) applies to READ-ONLY mode, where
    # openpyxl streams cells and trusts that declared tag for max_row/
    # max_column without ever building a real cell index. Confirmed
    # empirically here (non-read-only vs read_only=True against a workbook
    # with a hand-inflated <dimension ref="A1:XFD1048576"/> tag but only
    # two real cells): non-read-only sheet.max_row/max_column and the
    # default sheet.iter_rows() -- used below with no explicit bounds --
    # both correctly resolved to 2x2 by deriving the range from actually-
    # parsed <c> cell elements, completely ignoring the bogus tag; read-only
    # mode reproduced the full 1,048,576 x 16,384 blowup. Since this loader
    # already requires non-read-only mode for style access, no explicit
    # min_row/max_row/min_col/max_col bounding is needed on top of that.
    workbook = load_workbook(filename=path, data_only=True)
    tables: list[Table] = []
    for sheet_index, sheet_name in enumerate(workbook.sheetnames):
        sheet = workbook[sheet_name]
        header_row_count = _resolve_frozen_header_row_count(sheet)

        # merged_cells.ranges: style AND value live only on the TOP-LEFT
        # cell of a range (confirmed via docs) -- every other position
        # within the range is a placeholder MergedCell with no independent
        # style or value. span_by_origin carries the real cell's colspan/
        # rowspan; spanned_positions marks every other covered position so
        # it becomes None in the output grid (SPANNED, per the model's own
        # convention), never a bare/empty TableCell.
        span_by_origin: dict[tuple[int, int], tuple[int, int]] = {}
        spanned_positions: set[tuple[int, int]] = set()
        for merged_range in sheet.merged_cells.ranges:
            origin = (merged_range.min_row, merged_range.min_col)
            span_by_origin[origin] = (
                merged_range.max_row - merged_range.min_row + 1,
                merged_range.max_col - merged_range.min_col + 1,
            )
            for row_idx in range(merged_range.min_row, merged_range.max_row + 1):
                for col_idx in range(merged_range.min_col, merged_range.max_col + 1):
                    if (row_idx, col_idx) != origin:
                        spanned_positions.add((row_idx, col_idx))

        cells: list[list[TableCell | None]] = []
        for row in sheet.iter_rows():
            row_cells: list[TableCell | None] = []
            for cell in row:
                position = (cell.row, cell.column)
                if position in spanned_positions:
                    row_cells.append(None)
                    continue
                rowspan, colspan = span_by_origin.get(position, (1, 1))
                row_cells.append(
                    TableCell(
                        text=str(cell.value) if cell.value is not None else "",
                        colspan=colspan,
                        rowspan=rowspan,
                        is_header=cell.row <= header_row_count,
                        # openpyxl's Font.bold is a plain per-CELL boolean --
                        # unlike docx/pptx's per-RUN granularity, a single
                        # xlsx cell can't have mixed bold/non-bold runs, so
                        # there's no "uniform bold across runs" question to
                        # apply here (see TableCell.bold's docstring for that
                        # rule) -- just a direct boolean read. bool(...)
                        # normalizes the unset case (None, meaning "not
                        # explicitly set") to False.
                        bold=bool(cell.font.bold),
                        align=_resolve_align(cell.alignment.horizontal),
                        # background_color/text_color/column_widths/
                        # border_style are Phase 2 (real traps: ARGB alpha-
                        # byte stripping, patternType == 'solid' gating,
                        # theme/indexed color resolution) -- deliberately
                        # left at their None/default values here.
                    )
                )
            cells.append(row_cells)

        # style_provenance left at its None default: xlsx style extraction
        # is always explicit-markup (cell.fill/cell.font/cell.alignment read
        # directly), never geometric/heuristic inference -- the "heuristic"
        # value is reserved for PDF.
        tables.append(
            Table(
                id=f"t{sheet_index}",
                cells=cells,
                caption=sheet_name,
                source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0),
            )
        )

    return CanonicalDoc(document=document, tables=tables)
