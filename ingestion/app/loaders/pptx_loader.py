from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Callable, Literal

from pptx import Presentation
from pptx.enum.dml import MSO_COLOR_TYPE, MSO_FILL_TYPE
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.enum.text import PP_ALIGN
from pptx.table import _Cell as PptxCell
from pptx.table import Table as PptxTable

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, Figure, SourceRef, Table, TableCell

_PLACEHOLDER_TITLE_IDX = 0  # pptx.enum.shapes placeholder idx for the title placeholder

# PP_ALIGN -> TableCell.align, same "only the values with an exact semantic
# match get mapped, everything else falls through to None" convention
# docx_loader.py's _JC_TO_ALIGN already established. DISTRIBUTE/JUSTIFY_LOW/
# THAI_DISTRIBUTE (spread-to-fill-width variants, mainly for CJK text) and
# MIXED (multiple paragraphs in the run-selection disagree -- not applicable
# here since this is read per-paragraph, but python-pptx exposes it as a
# real value) intentionally fall through to None via dict.get rather than
# being guessed at.
_PP_ALIGN_TO_ALIGN: dict[PP_ALIGN, Literal["left", "center", "right", "justify"]] = {
    PP_ALIGN.LEFT: "left",
    PP_ALIGN.CENTER: "center",
    PP_ALIGN.RIGHT: "right",
    PP_ALIGN.JUSTIFY: "justify",
}


def _cell_is_bold(cell: PptxCell) -> bool:
    """Uniform-bold rule -- IDENTICAL semantics to docx_loader.py's
    `_cell_is_bold` (see that function's own docstring for the full
    rationale, mirrored here rather than re-derived): a cell is bold only
    if EVERY run containing non-whitespace text, across every paragraph in
    the cell, is bold. `run.font.bold` is python-pptx's own tri-state read
    (True/False/None, where None means "not explicitly set on this run,
    inherited from the placeholder/layout/master"); None is treated the
    same as False here (not EXPLICITLY bold) via `not run.font.bold`, the
    same conservative approximation docx uses. A cell with no
    non-whitespace runs at all (blank cell) is not bold.
    """
    saw_non_whitespace_run = False
    for paragraph in cell.text_frame.paragraphs:
        for run in paragraph.runs:
            if not run.text.strip():
                continue
            saw_non_whitespace_run = True
            if not run.font.bold:
                return False
    return saw_non_whitespace_run


def _cell_alignment(cell: PptxCell) -> Literal["left", "center", "right", "justify"] | None:
    """First paragraph's `paragraph.alignment` (a `PP_ALIGN` member, or
    `None` when not explicitly set on this paragraph) -- same "first
    paragraph wins" simplification docx_loader.py's `_cell_alignment`
    already established for a cell that can hold multiple paragraphs with
    different alignment each. `dict.get` on a `None` key (unset alignment)
    or any value with no entry in `_PP_ALIGN_TO_ALIGN` both correctly
    resolve to `None` -- no separate branch needed for either case.
    """
    paragraphs = cell.text_frame.paragraphs
    if not paragraphs:
        return None
    return _PP_ALIGN_TO_ALIGN.get(paragraphs[0].alignment)


def _cell_background_color(cell: PptxCell) -> str | None:
    """`cell.fill`, gated against TWO real, confirmed-via-live-introspection
    traps before ever touching `.fore_color`/`.rgb` (see this module's git
    history / the design spec's pptx section for the confirming session):

    Trap 1 -- inherited fill: `cell.fill.type` is `None` for a cell with NO
    explicit `<a:solidFill>`/etc. of its own (`_NoneFill`, confirmed live) --
    the common case, since most real pptx tables get their header/banding
    shading from the table's APPLIED STYLE reference, not per-cell fill XML
    (the pptx analogue of docx's table-style-shading gap, see
    docx_loader.py's `_cell_background_color` docstring). Touching
    `.fore_color` on ANY non-SOLID fill type (`None`/background/gradient/
    textured/patterned/picture/group) raises `TypeError` (confirmed live:
    the base `_Fill.fore_color` property is only overridden by `_SolidFill`
    and `_PattFill`) -- so `fill.type` is checked first, and only
    `MSO_FILL_TYPE.SOLID` is accepted; anything else (including patterned,
    which WOULD have a fore_color but mixes two colors this model has no
    slot for) returns `None` without ever touching `.fore_color`.

    Trap 2 -- theme color: once `fore_color` is safely reached,
    `fore_color.type` can be `MSO_COLOR_TYPE.SCHEME` (a reference into the
    deck's theme palette, e.g. Accent 1) instead of `MSO_COLOR_TYPE.RGB` --
    resolving a theme color to a real hex value requires reading the deck's
    theme XML, explicitly out of scope per the design spec. `.rgb` on a
    SCHEME-type color raises `AttributeError` (confirmed live: `_SchemeColor`
    does not override the base `_Color.rgb` property) -- so `.type` is
    checked BEFORE `.rgb` is ever read, same "check type before touching a
    type-conditional accessor" pattern as Trap 1.

    Literal white (`#ffffff`), once safely extracted, is normalized to
    `None` -- same "no fill" convention docx's `_normalize_hex_color`
    (`treat_white_as_no_fill=True`) and xlsx's `_resolve_fill_color` both
    already apply for background specifically (never for text color, which
    treats white as a genuine, meaningful author choice -- see
    `_cell_text_color` below).
    """
    fill = cell.fill
    if fill.type != MSO_FILL_TYPE.SOLID:
        return None
    fore_color = fill.fore_color
    if fore_color.type != MSO_COLOR_TYPE.RGB:
        return None
    hex_value = f"#{str(fore_color.rgb).lower()}"
    return None if hex_value == "#ffffff" else hex_value


def _cell_text_color(cell: PptxCell) -> str | None:
    """FIRST non-whitespace run's `run.font.color`, across every paragraph
    in the cell -- the same "first wins" simplification precedent
    docx_loader.py's `_cell_text_color` already established (documented
    there as a deliberate v1 simplification, not re-derived here).

    Same theme-color trap as `_cell_background_color`'s Trap 2:
    `color.type` can be `MSO_COLOR_TYPE.SCHEME` where `.rgb` raises
    `AttributeError` -- `.type` is checked first, and only
    `MSO_COLOR_TYPE.RGB` is read further. Unlike background, white text is
    NOT normalized away here -- a genuine white-text-on-dark-background
    choice is a legitimate explicit color (same reasoning docx's
    `treat_white_as_no_fill=False` call documents for text specifically),
    not a format-default artifact the way an unstyled cell's background
    would be.
    """
    for paragraph in cell.text_frame.paragraphs:
        for run in paragraph.runs:
            if not run.text.strip():
                continue
            color = run.font.color
            if color.type != MSO_COLOR_TYPE.RGB:
                return None
            return f"#{str(color.rgb).lower()}"
    return None


def _column_widths(pptx_table: PptxTable) -> list[float] | None:
    """`table.columns[i].width` (EMU `Length` values via
    `<a:gridCol>`'s `@w` attribute), converted to FRACTIONS of the table's
    total declared width -- same "never let a source unit reach the
    renderer" rule as docx's `_column_widths` (twips) and xlsx's
    `_resolve_column_widths` (character units). Only the RATIO between
    columns is used, so no explicit EMU conversion step is needed.

    Returns `None` (never a fabricated equal-width fallback) if any
    column's width is missing/non-positive -- defensive, mirroring docx's
    same guard, even though a real `add_table`-created deck always
    populates `@w` on every `<a:gridCol>`.
    """
    widths = [column.width for column in pptx_table.columns]
    if any(w is None or w <= 0 for w in widths):
        return None
    total = sum(widths)
    return [w / total for w in widths]


def _extract_pptx_table_cells(pptx_table: PptxTable) -> list[list[TableCell | None]]:
    """Builds the canonical `cells: list[list[TableCell | None]]` grid for
    one pptx table, gating merge-span reads exactly per python-pptx's own
    documented contract (confirmed live): `cell.span_height`/`.span_width`
    are ONLY valid on a cell that tests `.is_merge_origin` True first --
    reading them on a non-origin cell "may be misleading (often 1)" per
    python-pptx's own docstring, so this never reads them without that
    gate.

    Grid semantics, matching docx/xlsx's SPANNED-vs-real-cell convention:
      - `cell.is_spanned` True means this grid position is covered by a
        merge-origin cell elsewhere (top-left or otherwise) -- left `None`,
        never given its own `TableCell`. `is_spanned` is documented to be
        `False` for the merge-origin cell itself, so this check alone
        correctly separates "covered position" from "origin position"
        without needing a separate `is_merge_origin` check first.
      - `cell.is_merge_origin` True: `colspan=cell.span_width`,
        `rowspan=cell.span_height` (only read here, under this gate).
      - Neither spanned nor origin (the common case, an unmerged cell):
        `colspan=1`, `rowspan=1`.
      - Unlike a heuristically-detected PDF table (or even xlsx's sparse
        `iter_rows`), every pptx grid position -- spanned or not -- has a
        real, addressable `table.cell(r, c)` behind it; there is no notion
        of an omitted/absent position the way docx's `gridBefore`/
        `gridAfter` or PDF's geometry-only detection can produce. So a
        genuine `TableCell(text="")` GAP (as opposed to a `None` SPANNED
        position) is not something a pptx table can produce either --
        same conclusion docx_loader.py already reached for its own format.
      - `table.first_row` marks every cell in row index 0 `is_header=True`
        when set; every other row (and row 0 itself when `first_row` is
        False) is `is_header=False` -- see `load_pptx`'s own docstring/
        this module's top-level comment for why no separate helper exists
        for this one-line check.
      - `bold`/`align`/`background_color`/`text_color` are all per-cell
        (origin or unmerged), via `_cell_is_bold`/`_cell_alignment`/
        `_cell_background_color`/`_cell_text_color` above -- a spanned
        position never gets its own `TableCell` to hold them, same as
        spans themselves.

    `column_widths`/`border_style` are TABLE-level, not per-cell -- computed
    once by `_column_widths` (border_style has no pptx signal at all, see
    `load_pptx`'s own `Table(...)` construction for that decision) in the
    caller, not here.
    """
    is_header_row = pptx_table.first_row
    grid: list[list[TableCell | None]] = []
    for row_idx, _row in enumerate(pptx_table.rows):
        row_cells: list[TableCell | None] = []
        for col_idx, _column in enumerate(pptx_table.columns):
            cell = pptx_table.cell(row_idx, col_idx)
            if cell.is_spanned:
                row_cells.append(None)
                continue
            if cell.is_merge_origin:
                colspan, rowspan = cell.span_width, cell.span_height
            else:
                colspan, rowspan = 1, 1
            row_cells.append(
                TableCell(
                    text=cell.text_frame.text.strip(),
                    colspan=colspan,
                    rowspan=rowspan,
                    is_header=is_header_row and row_idx == 0,
                    bold=_cell_is_bold(cell),
                    align=_cell_alignment(cell),
                    background_color=_cell_background_color(cell),
                    text_color=_cell_text_color(cell),
                )
            )
        grid.append(row_cells)
    return grid


def load_pptx(path: str, describe_figure: Callable[[bytes], str] | None = None) -> CanonicalDoc:
    """One slide -> one HEADING block (its title placeholder, if present) +
    one PARAGRAPH block per other text-frame paragraph (bullets), in slide
    order, then one NOTE block for the slide's speaker notes (if any), one
    FIGURE block per embedded picture, and one `Table` per table shape --
    same describe_figure convention as load_docx (see its docstring): None
    (the default) leaves figures as a bare '[FIGURE: none]' placeholder; a
    captioning failure for one image never aborts the rest of the deck.

    Table extraction is new capability, not a pre-existing behavior: a
    table lives in a `GraphicFrame` shape (`shape.has_table` True), which
    has NEITHER `has_text_frame` True NOR a `MSO_SHAPE_TYPE.PICTURE`
    `shape_type` (confirmed live: a table shape's own `shape_type` is
    `MSO_SHAPE_TYPE.TABLE`) -- so it is a clean third branch alongside the
    two below, never previously reached by either."""
    file_path = Path(path)
    sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
    document = Document(path=path, format=DocumentFormat.PPTX, sha256=sha256)

    presentation = Presentation(path)
    blocks: list[Block] = []
    tables: list[Table] = []
    figures: list[Figure] = []
    block_id = 0
    table_index = 0
    figure_index = 0
    offset = 0

    # 1-based: slide numbers are conventionally 1-based (matches how a
    # human would refer to "slide 1"), and page_provenance's docstring in
    # model.py already treats a pptx slide index as a real, ground-truth
    # pagination source -- not an approximation needing a provenance tag.
    for slide_index, slide in enumerate(presentation.slides, start=1):
        title_shape = slide.shapes.title
        for shape in slide.shapes:
            if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
                caption = None
                if describe_figure is not None:
                    try:
                        caption = describe_figure(shape.image.blob)
                    except Exception:  # noqa: BLE001 -- a vision failure must not abort the whole deck
                        caption = None
                # A figure gets a real slot in the same running offset
                # counter used for text blocks below (like docx_loader's
                # table handling), instead of a hardcoded (0, 0), so it
                # orders correctly WITHIN its slide relative to surrounding
                # text -- not just at the right slide via `page`.
                start = offset
                end = start + 1
                offset = end
                figures.append(
                    Figure(
                        id=f"f{figure_index}",
                        caption=caption,
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=slide_index),
                    )
                )
                blocks.append(
                    Block(
                        id=f"b{block_id}",
                        kind=BlockKind.FIGURE,
                        text=f"[FIGURE: {caption or 'none'}]",
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=slide_index),
                    )
                )
                block_id += 1
                figure_index += 1
                continue

            if shape.has_table:
                pptx_table = shape.table
                cells = _extract_pptx_table_cells(pptx_table)
                # Same running offset counter as figures/text blocks above
                # (and docx_loader's table handling) -- gives the table a
                # real slot ordering it correctly WITHIN its slide relative
                # to surrounding text, not a hardcoded (0, 0).
                start = offset
                end = start + 1
                offset = end
                tables.append(
                    Table(
                        id=f"t{table_index}",
                        cells=cells,
                        column_widths=_column_widths(pptx_table),
                        # pptx tables usually get their gridlines from an
                        # APPLIED TABLE STYLE reference (the table's
                        # `w:tblId`-equivalent style GUID), not explicit
                        # per-cell border XML the way docx exposes
                        # `w:tcBorders` -- there is no reliable per-cell
                        # border signal to read here at all, so asserting
                        # "grid" (or any other value) would claim
                        # confidence that doesn't exist. Left `None`
                        # (unknown) deliberately -- a documented honest
                        # gap, not an oversight (mirrors the design spec's
                        # own stated caveat almost verbatim, see
                        # docs/superpowers/specs/2026-08-12-table-fidelity-design.md's
                        # pptx section).
                        border_style=None,
                        # Always explicit-markup-derived (or a documented
                        # absence, like border above) -- never heuristic/
                        # geometric guessing, so None (matching docx/xlsx's
                        # convention) is correct; "heuristic" is reserved
                        # for PDF.
                        style_provenance=None,
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=slide_index),
                    )
                )
                table_index += 1
                continue

            if not shape.has_text_frame:
                continue
            is_title = title_shape is not None and shape.shape_id == title_shape.shape_id
            for paragraph in shape.text_frame.paragraphs:
                content = "".join(run.text for run in paragraph.runs).strip() or paragraph.text.strip()
                if not content:
                    continue
                start = offset
                end = start + len(content)
                offset = end + 1
                blocks.append(
                    Block(
                        id=f"b{block_id}",
                        kind=BlockKind.HEADING if is_title else BlockKind.PARAGRAPH,
                        text=content,
                        heading_level=1 if is_title else None,
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=slide_index),
                    )
                )
                block_id += 1

        if slide.has_notes_slide:
            notes = slide.notes_slide.notes_text_frame.text.strip()
            if notes:
                start = offset
                end = start + len(notes)
                offset = end + 1
                # Every block/figure on this slide -- title, bullets, notes,
                # figures -- must set the SAME slide_index as `page`. Mixing
                # a real page on some elements with None (-> 0 via `ref.page
                # or 0`, see tree_builder._order_key) on others would sort
                # this slide's own content inconsistently against itself and
                # against other slides', not just leave it unranked.
                blocks.append(
                    Block(
                        id=f"b{block_id}",
                        kind=BlockKind.NOTE,
                        text=notes,
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=slide_index),
                    )
                )
                block_id += 1

    return CanonicalDoc(document=document, blocks=blocks, tables=tables, figures=figures)
