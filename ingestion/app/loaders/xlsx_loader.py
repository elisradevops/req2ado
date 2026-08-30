from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Literal

from openpyxl import load_workbook
from openpyxl.styles.borders import Side
from openpyxl.styles.colors import Color
from openpyxl.styles.fills import PatternFill
from openpyxl.utils.cell import coordinate_to_tuple
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.worksheet import Worksheet

from app.canonical.model import CanonicalDoc, Document, DocumentFormat, SourceRef, Table, TableCell

# Excel's own built-in default column width in character units, applied by
# Excel itself to any column the user never explicitly resized. openpyxl
# reports `None` (not this value) for such a column -- there is no "the
# default width" property to read, only the absence of an explicit one. This
# constant exists ONLY to give unresized columns a stand-in character-width
# so that fraction math against explicitly-sized siblings stays meaningful
# (see _resolve_column_widths) -- it is never surfaced as a value the author
# actually chose.
_EXCEL_DEFAULT_COLUMN_WIDTH_CHARS = 8.43

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


def _normalize_argb_to_rgb_hex(argb: str | None) -> str | None:
    """openpyxl surfaces a resolved RGB-type color as an 8-hex-char ARGB
    string (2-char alpha + 6-char RGB), e.g. 'FFFFFF00' for opaque yellow.
    The canonical model's '#rrggbb' shape has no alpha channel, so the
    leading 2 chars are stripped, never preserved or interpreted.

    Defensive, not load-bearing: callers only ever pass this a `.rgb` value
    they've ALREADY gated on `color.type == 'rgb'`, so a well-formed 8-char
    string is the expected input. The length check exists purely so a
    malformed/short value (or None, which flows through untouched call sites
    like an unset Color()) degrades to "unknown color" the same honest way
    as a theme/indexed color, rather than raising or slicing garbage.
    """
    if argb is None or len(argb) != 8:
        return None
    return f"#{argb[2:].lower()}"


def _resolve_fill_color(fill: PatternFill | None) -> str | None:
    """background_color extraction.

    Trap 1 -- patternType gate: `fill.fgColor.rgb` is only meaningful when
    `fill.patternType == 'solid'`. For an UNPATTERNED cell (patternType is
    None, by far the most common case -- most cells have no fill at all),
    `fgColor.rgb` still reads back a plausible-looking 8-hex-char string,
    '00000000', for literally every such cell (confirmed empirically against
    a real openpyxl-created cell) -- reading it without this gate would
    silently report every plain, unstyled cell as having a real (black)
    background. Checked first, before fgColor is touched at all.

    Trap 2 -- theme/indexed colors: even when patternType == 'solid',
    `fgColor.type` can be 'theme' (an index into the workbook's theme
    palette, e.g. "Accent 1") or 'indexed' (a legacy index into a fixed
    56-color table) instead of 'rgb'. Resolving either requires reading
    theme1.xml or the legacy indexed-color table -- both explicitly out of
    scope for v1 per the design spec. `.rgb` under those types is not a
    usable color at all (confirmed empirically: it returns a validator
    placeholder string, not a real value) -- so type is checked BEFORE rgb
    is ever read, and anything other than 'rgb' falls through to None, an
    honest "don't know" rather than a wrong guess.

    Trap 3 -- white-as-no-fill: a genuinely-white solid fill ('#ffffff'
    after alpha-stripping) is normalized to None, same convention as docx's
    'auto'/'FFFFFF' -> no-fill handling. A real white fill and a truly empty
    fill are visually indistinguishable in practice, and Excel's own UI
    treats plain white as its default/no-fill state in the vast majority of
    real spreadsheets -- collapsing them here is an honest simplification.
    """
    if fill is None or fill.patternType != "solid":
        return None
    fg_color = fill.fgColor
    if fg_color is None or fg_color.type != "rgb":
        return None
    rgb_hex = _normalize_argb_to_rgb_hex(fg_color.rgb)
    if rgb_hex is None or rgb_hex == "#ffffff":
        return None
    return rgb_hex


def _resolve_font_color(color: Color | None) -> str | None:
    """text_color extraction -- the same ARGB-alpha-stripping and
    theme/indexed trap as background color, but with no patternType gate:
    a font's color is always potentially meaningful when set (there's no
    "unpatterned" equivalent for text).

    Unlike background, a genuinely-white TEXT color is NOT collapsed to
    None here -- white text is a real, meaningful, intentional author
    choice (e.g. white text on a dark solid fill), not an absence-of-
    styling default the way an unfilled cell's ARGB placeholder is.

    openpyxl's Font is a whole-CELL property with no per-run color
    granularity on a normal cell (mirrors how Phase 1 already treated
    `bold` as a direct per-cell boolean, see the field's own comment above)
    -- so this is a plain, direct property read, no "first run" ambiguity.
    """
    if color is None or color.type != "rgb":
        return None
    return _normalize_argb_to_rgb_hex(color.rgb)


def _has_border_side(side: Side | None) -> bool:
    """A `Side` of None (never constructed for this edge at all) or a real
    `Side` whose `.style` is None (constructed, but with no style chosen)
    both mean "no border drawn on this edge" -- an openpyxl cell that was
    never touched still carries real `Side` objects with `style=None` on
    every edge (confirmed empirically), while a `Border(...)` built by only
    naming SOME sides leaves the rest as bare `None`, not `Side` objects --
    both shapes occur in real workbooks/fixtures, so both are guarded here.
    Any non-None `.style` ('thin', 'medium', 'thick', 'dashed', ...) means a
    real, visible border was explicitly drawn -- which specific style/weight
    was chosen is deliberately not modeled, only presence, per the design
    spec's "deliberately coarse" border_style classification.
    """
    return side is not None and side.style is not None


def _classify_border_style(
    border_flags: dict[tuple[int, int], tuple[bool, bool, bool, bool]],
    min_row: int,
    max_row: int,
    min_col: int,
    max_col: int,
) -> Literal["none", "grid", "outer"]:
    """Table-level border classification, scanned once across the whole
    used cell range (`border_flags` maps every (row, col) position in that
    range to its own (has_top, has_bottom, has_left, has_right) flags,
    already collected during the main cell loop -- no second workbook scan).

    xlsx has no single `w:tblBorders`-equivalent flag the way docx does (see
    design spec) -- classification here is a deliberately coarse, best-
    effort heuristic over per-cell border sides, not a real "the table has
    a border" source of truth. The exact rule:

    1. "Interior" cells are every position strictly inside the outer ring
       (not on the first/last row AND not on the first/last column). If at
       least half of them have a border on ANY of their four sides, this is
       classified "grid" -- real borders drawn on INTERIOR cells only make
       sense if the author drew gridlines across the table's shared
       internal edges, not merely around its outside.
    2. Otherwise, check the boundary ring itself, but only the OUTWARD-
       facing side at each boundary position (a boundary cell's INWARD-
       facing side says nothing about the table's outer edge, and grid-style
       tables already got handled by step 1): top-row cells' `top`,
       bottom-row cells' `bottom`, left-column cells' `left`, right-column
       cells' `right` (a corner cell contributes two outward sides). If at
       least half of these outward-facing edges are set, classify "outer".
    3. A degenerate table with no interior at all (a single row or single
       column, where step 1 has zero cells to evaluate) falls straight
       through to step 2 -- a fully-bordered single-row table reads as
       "outer", never a spurious "grid" with no interior evidence to
       support it.
    4. Anything meeting neither threshold is "none".

    The >=50% thresholds are intentionally coarse: "any single cell" would
    be too trigger-happy on one stray manual border, and "literally every
    cell" would be too strict against ordinary real-world sparseness (e.g.
    a table's last row missing its bottom border by human oversight while
    every other edge is drawn). Cells covered by a merged range are scanned
    like any other position (their border sides still exist on the
    underlying sheet grid) -- not special-cased, keeping this heuristic
    simple per the design spec's explicit "keep it simple and explainable
    over clever" guidance.
    """
    interior_total = 0
    interior_with_border = 0
    boundary_total = 0
    boundary_with_border = 0

    for row_idx in range(min_row, max_row + 1):
        for col_idx in range(min_col, max_col + 1):
            has_top, has_bottom, has_left, has_right = border_flags[(row_idx, col_idx)]
            is_top, is_bottom = row_idx == min_row, row_idx == max_row
            is_left, is_right = col_idx == min_col, col_idx == max_col

            if is_top or is_bottom or is_left or is_right:
                outward_flags = []
                if is_top:
                    outward_flags.append(has_top)
                if is_bottom:
                    outward_flags.append(has_bottom)
                if is_left:
                    outward_flags.append(has_left)
                if is_right:
                    outward_flags.append(has_right)
                boundary_total += len(outward_flags)
                boundary_with_border += sum(outward_flags)
            else:
                interior_total += 1
                if has_top or has_bottom or has_left or has_right:
                    interior_with_border += 1

    if interior_total > 0 and interior_with_border / interior_total >= 0.5:
        return "grid"
    if boundary_total > 0 and boundary_with_border / boundary_total >= 0.5:
        return "outer"
    return "none"


def _resolve_column_widths(sheet: Worksheet, min_col: int, max_col: int) -> list[float] | None:
    """Converts openpyxl's character-unit column widths into FRACTIONS of
    the table's total width, per the design spec's "never let the renderer
    see a source unit" rule (twips/EMU/chars/points must never reach
    layout -- same bug class as the earlier figure-sizing overflow fix).

    `sheet.column_dimensions[letter].width` is `None` for any column the
    user never explicitly resized (Excel applies its own default width, but
    openpyxl reports no value at all for it -- there's no "the default" to
    read back). Unlike docx, where a wholly-absent `w:tblGrid` means truly
    no width information exists anywhere, xlsx ALWAYS has an effective width
    per column, explicit or default -- so a table with SOME columns resized
    and others left at default still has real, meaningful relative widths;
    it must not bail to None just because not every column was resized.
    Columns with no explicit width are given a stand-in of 8.43 character
    units (`_EXCEL_DEFAULT_COLUMN_WIDTH_CHARS`, Excel's own built-in default)
    purely so the fractions stay meaningful relative to explicitly-sized
    siblings, not because 8.43 is itself a real authored value.

    Only when LITERALLY ZERO columns in the table have an explicit width is
    the whole result None -- with nothing to differentiate, a uniform
    equal-fraction array would imply a precision that was never actually
    authored, and None ("no width information") is the honest answer
    (mirrors this loader's existing "absent means not detected, never
    half-guess" convention used for alignment and header detection above).

    `sheet.column_dimensions` is a dict-like `DimensionHolder` -- accessed
    here via `.get(letter)`, NOT `[letter]`, because `[letter]` auto-
    vivifies a brand-new `ColumnDimension` for any letter not already
    present (confirmed empirically) -- indexing would silently mutate the
    workbook's column dimensions as a side effect of merely reading them.
    """
    raw_widths: list[float | None] = []
    for col_idx in range(min_col, max_col + 1):
        dimension = sheet.column_dimensions.get(get_column_letter(col_idx))
        raw_widths.append(dimension.width if dimension is not None else None)

    if all(width is None for width in raw_widths):
        return None

    effective_widths = [
        width if width is not None else _EXCEL_DEFAULT_COLUMN_WIDTH_CHARS for width in raw_widths
    ]
    total = sum(effective_widths)
    return [width / total for width in effective_widths]


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

        # Table-level border classification (_classify_border_style) needs to
        # know the used range's min/max row/col BEFORE it can tell a boundary
        # position from an interior one -- but that range isn't known until
        # this same iteration finishes. Rather than re-scanning the workbook
        # a second time, border sides are captured into border_flags here (a
        # cheap tuple-of-bools per position, using data already touched for
        # this cell) and classified once, after the loop, against the now-
        # known bounds -- one pass over the sheet, not two.
        border_flags: dict[tuple[int, int], tuple[bool, bool, bool, bool]] = {}
        min_row: int | None = None
        max_row: int | None = None
        min_col: int | None = None
        max_col: int | None = None

        cells: list[list[TableCell | None]] = []
        for row in sheet.iter_rows():
            row_cells: list[TableCell | None] = []
            for cell in row:
                position = (cell.row, cell.column)
                min_row = cell.row if min_row is None else min(min_row, cell.row)
                max_row = cell.row if max_row is None else max(max_row, cell.row)
                min_col = cell.column if min_col is None else min(min_col, cell.column)
                max_col = cell.column if max_col is None else max(max_col, cell.column)

                border = cell.border
                border_flags[position] = (
                    _has_border_side(border.top),
                    _has_border_side(border.bottom),
                    _has_border_side(border.left),
                    _has_border_side(border.right),
                )

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
                        background_color=_resolve_fill_color(cell.fill),
                        text_color=_resolve_font_color(cell.font.color),
                    )
                )
            cells.append(row_cells)

        # A sheet with literally zero cells (never happens for a real sheet
        # openpyxl enumerates, since iter_rows() only yields sheets that have
        # at least one row -- guarded anyway, defensively, so this loader
        # never crashes on a pathological empty sheet) has no range to
        # classify borders or widths against -- both stay at their None
        # defaults, an honest "nothing to measure" rather than a fabricated
        # "none"/"no widths" that implies a real (empty) table was measured.
        if min_row is None or min_col is None:
            border_style = None
            column_widths = None
        else:
            border_style = _classify_border_style(border_flags, min_row, max_row, min_col, max_col)
            column_widths = _resolve_column_widths(sheet, min_col, max_col)

        # style_provenance left at its None default: xlsx style extraction
        # is always explicit-markup (cell.fill/cell.font/cell.alignment read
        # directly), never geometric/heuristic inference -- the "heuristic"
        # value is reserved for PDF.
        tables.append(
            Table(
                id=f"t{sheet_index}",
                cells=cells,
                caption=sheet_name,
                column_widths=column_widths,
                border_style=border_style,
                # start/end_offset=sheet_index -- NOT a hardcoded (0, 0).
                # Real bug this closes: tree_builder._hash_identity hashes
                # only document_path+start_offset+end_offset (description is
                # deliberately excluded, see its own docstring), so every
                # sheet in a multi-sheet workbook previously hashed
                # IDENTICALLY -- BASELINE's idempotency lookup (keyed on
                # this hash) then resolved sheets 2..N to sheet 1's own ADO
                # work item, silently collapsing an entire workbook into one
                # item. Same running-offset-per-table convention
                # pptx_loader.py already uses for the identical reason.
                source_ref=SourceRef(document_path=path, start_offset=sheet_index, end_offset=sheet_index + 1),
            )
        )

    return CanonicalDoc(document=document, tables=tables)
