from __future__ import annotations

import hashlib
import logging
import re
from pathlib import Path
from typing import Callable, Literal

from docx import Document as DocxDocument
from docx.oxml.ns import qn
from docx.oxml.table import CT_Row, CT_Tc
from docx.table import Table as DocxTable
from docx.table import _Cell as DocxCell
from docx.text.paragraph import Paragraph as DocxParagraph

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, Figure, SourceRef, Table, TableCell

logger = logging.getLogger(__name__)

_HEADING_STYLE_PATTERN = re.compile(r"^Heading\s*(\d+)$")
_IMAGE_RELTYPE_MARKER = "image"

# w:jc/@w:val -> TableCell.align. Deliberately a plain dict, not python-docx's
# own WD_PARAGRAPH_ALIGNMENT.from_xml(): that enum has NO member at all for
# the modern `start`/`end` spellings (only the legacy left/right/center/both
# tokens), so calling it on a real `start`/`end` value raises ValueError --
# a real, if uncommon, value this loader must not choke on. `both` is
# OOXML's own name for full justification. `start`/`end` are mapped to the
# LTR reading (left/right) -- this codebase has no RTL-direction signal to
# do better than that today; if a bidi/RTL table is ever reported as
# misrendering, this mapping is the first place to revisit, not a silent
# correctness bug in the meantime.
_JC_TO_ALIGN: dict[str, Literal["left", "center", "right", "justify"]] = {
    "left": "left",
    "center": "center",
    "right": "right",
    "both": "justify",
    "start": "left",
    "end": "right",
}

# w:tblBorders/w:tcBorders share the same OOXML child-element vocabulary --
# insideH/insideV are valid on a per-cell w:tcBorders too, not just the
# table-level element (a cell can override just its own interior sides).
_BORDER_INSIDE_TAGS = ("insideH", "insideV")
_BORDER_OUTER_TAGS = ("top", "bottom", "left", "right")
# OOXML's two spellings for "explicitly no border on this side" -- both must
# be excluded, not just one, or an author who wrote w:val="nil" instead of
# "none" would be mis-read as having a real border.
_BORDER_NONE_VALS = {"none", "nil"}


def _normalize_hex_color(raw: str | None, *, treat_white_as_no_fill: bool) -> str | None:
    """Normalizes a raw OOXML color token (`w:shd/@w:fill` or `w:color/@w:val`)
    to a lowercase `#rrggbb` string, or `None` when it doesn't represent a
    real, explicit color choice.

    `None`/missing and the literal token `"auto"` (OOXML's own "theme/
    inherited default, not an explicit value" marker, used by BOTH shading
    fill and run text color) always normalize to `None` -- `"auto"` isn't
    merely coincidentally excluded by the hex-format check below (it also
    isn't valid hex), the exclusion is semantic, not a parsing accident.

    `treat_white_as_no_fill=True` (background only, per the design spec's
    Phase 2 section) additionally excludes literal `"FFFFFF"` (case-
    insensitive) -- Word's own default fill for a shaded-but-uncustomized
    cell, which would otherwise round-trip as if the author had explicitly
    chosen white. This exclusion deliberately does NOT apply to text color:
    a genuine white-text-on-dark-background choice is a legitimate explicit
    color, not a Word-default artifact, so `_cell_text_color` calls this
    with `treat_white_as_no_fill=False`.

    Anything else that isn't a well-formed 6-hex-digit string (a malformed
    or unsupported token) also normalizes to `None` rather than guessing.
    """
    if raw is None:
        return None
    if treat_white_as_no_fill and raw.upper() == "FFFFFF":
        return None
    if len(raw) == 6 and all(c in "0123456789abcdefABCDEF" for c in raw):
        return f"#{raw.lower()}"
    return None


def _row_is_header(tr: CT_Row) -> bool:
    """`w:trPr/w:tblHeader` presence (any value, or none at all -- OOXML
    treats bare presence of the element as true, same convention as
    `w:vMerge` with no `@w:val`). Documented meaning is "this row repeats
    as a header on every printed page", which is also the closest real,
    explicit signal Word itself gives for "this is a header row" -- there
    is no separate/better one. python-docx's `CT_TrPr` doesn't expose this
    as a property (only `gridBefore`/`gridAfter`/`trHeight` are declared
    fields on it), so it's read directly off the raw element via `qn()`,
    the same fallback-to-raw-OOXML convention `grid_span`/`vMerge` already
    established in this module before this rewrite.
    """
    trPr = tr.trPr
    if trPr is None:
        return False
    return trPr.find(qn("w:tblHeader")) is not None


def _cell_alignment(tc: CT_Tc) -> Literal["left", "center", "right", "justify"] | None:
    """First paragraph's `w:pPr/w:jc/@w:val`, read as a raw XML string
    (see `_JC_TO_ALIGN` above for why -- python-docx's own alignment
    properties raise on modern `start`/`end` values). A cell can hold
    multiple paragraphs with different alignment each; `TableCell` has no
    per-paragraph shape, so the FIRST paragraph's alignment is used as the
    cell's alignment -- the simplest reasonable rule for a v1 model, not a
    claim that every paragraph agrees. An unrecognized/exotic `w:val`
    (`distribute`, `mediumKashida`, ...) intentionally falls through to
    `None` via `dict.get` rather than guessing.
    """
    if not tc.p_lst:
        return None
    pPr = tc.p_lst[0].find(qn("w:pPr"))
    if pPr is None:
        return None
    jc = pPr.find(qn("w:jc"))
    if jc is None:
        return None
    return _JC_TO_ALIGN.get(jc.get(qn("w:val")))


def _cell_is_bold(cell: DocxCell) -> bool:
    """Uniform-bold rule (see `TableCell.bold`'s own docstring in
    `app/canonical/model.py` for the full rationale): a cell is bold only
    if EVERY run containing non-whitespace text, across every paragraph in
    the cell, is bold. Rejects a "first non-empty run is bold" rule, which
    mis-fires badly on a bold label prefix ("*Note:* rest of sentence") --
    that would bold the entire cell for what should read as a bold PREFIX
    only. Whitespace-only/empty runs are skipped entirely rather than
    counted against the cell, so a bold cell with trailing whitespace in a
    plain run still reads as bold. `run.bold` is python-docx's own
    tri-state read of `w:rPr/w:b` -- True, False, or None when inherited
    from the style hierarchy; None is treated the same as False here (not
    EXPLICITLY bold), a conservative approximation consistent with this
    loader not resolving style inheritance anywhere else either (see the
    table-style shading finding in the design spec's Phase 0 section). A
    cell with no non-whitespace runs at all (blank cell) is not bold.
    """
    saw_non_whitespace_run = False
    for paragraph in cell.paragraphs:
        for run in paragraph.runs:
            if not run.text.strip():
                continue
            saw_non_whitespace_run = True
            if not run.bold:
                return False
    return saw_non_whitespace_run


def _cell_background_color(tc: CT_Tc) -> str | None:
    """`w:tcPr/w:shd/@w:fill`, normalized via `_normalize_hex_color` with
    the background-specific "treat literal white as no fill" rule (see that
    function's own docstring, and the design spec's Phase 0/2 sections).

    No high-level python-docx property exposes `w:shd` at all (`CT_TcPr`'s
    own declared fields stop at `tcW`/`gridSpan`/`vMerge`/`vAlign`/`width` --
    confirmed by reading its source), so this reads the raw element
    directly via `qn()`, the same fallback-to-raw-OOXML convention
    `_row_is_header`/`_cell_alignment` already established in this module.

    A table using ONLY a table STYLE (e.g. Word's built-in "Light Grid
    Accent 1") for its header shading/row banding has ZERO `w:shd` on any
    cell despite visually showing shading in Word -- confirmed via a real
    fixture in the design spec's Phase 0 findings. That styling lives in
    `w:tblStyle`'s reference into `styles.xml`'s conditional formatting
    (`w:tblStylePr` firstRow/band1Horz/etc. variants), which this function
    deliberately does NOT resolve -- out of scope for v1, a documented
    honest gap rather than a bug (see this module's Phase 2 note above
    `_extract_table_cells`).
    """
    tcPr = tc.tcPr
    if tcPr is None:
        return None
    shd = tcPr.find(qn("w:shd"))
    if shd is None:
        return None
    return _normalize_hex_color(shd.get(qn("w:fill")), treat_white_as_no_fill=True)


def _cell_text_color(cell: DocxCell) -> str | None:
    """FIRST non-whitespace run's `w:rPr/w:color/@w:val`, across every
    paragraph in the cell, normalized via `_normalize_hex_color`.

    Unlike the uniform-bold rule (`_cell_is_bold`), text color has no safe
    "no color" default to fall back to when runs disagree: `bold=False` is
    itself a meaningful, correct value for "not bold", but there is no
    equivalent "the natural text color" sentinel to assign when, e.g., a
    colored label prefix is followed by default-colored body text in the
    same cell. This deliberately reuses the SAME "first wins" simplification
    `_cell_alignment` already established (first PARAGRAPH's `w:jc` --
    documented there as accepted, not exhaustive) rather than inventing a
    new precedent for color specifically; it is a deliberate v1
    simplification, not an oversight.

    Whitespace-only runs are skipped when looking for the "first" run (same
    non-whitespace gate `_cell_is_bold` uses), so a leading blank run
    doesn't win over the first real text. Once the first non-whitespace run
    is found, ITS color (or lack of one) is authoritative -- later runs are
    never consulted, even if that run has no `w:color` at all or an explicit
    `"auto"`. `run._r` (the underlying `CT_R` oxml element) is used because
    python-docx's own `run.font.color` raises on some theme-color shapes and
    this module already prefers raw-OOXML reads for exactly this kind of
    edge case.
    """
    for paragraph in cell.paragraphs:
        for run in paragraph.runs:
            if not run.text.strip():
                continue
            rPr = run._r.find(qn("w:rPr"))
            color = rPr.find(qn("w:color")) if rPr is not None else None
            val = color.get(qn("w:val")) if color is not None else None
            return _normalize_hex_color(val, treat_white_as_no_fill=False)
    return None


def _borders_element_has_real_border(borders_el, tags: tuple[str, ...]) -> bool:
    """True if `borders_el` (a `w:tblBorders` or `w:tcBorders` element --
    both share the same child-element vocabulary per the OOXML schema,
    including `insideH`/`insideV` on `w:tcBorders` too, not just the
    table-level element) has at least one of the given side elements
    present with a real (non-`"none"`/`"nil"`) `@w:val`. A present border
    element with no `@w:val` attribute at all is treated as real -- this
    loader doesn't second-guess malformed source XML, it simply doesn't
    special-case a missing attribute as "explicitly no border" either.
    """
    for tag in tags:
        el = borders_el.find(qn(f"w:{tag}"))
        if el is None:
            continue
        val = el.get(qn("w:val"))
        if val is None or val.lower() not in _BORDER_NONE_VALS:
            return True
    return False


# How many distinct per-cell w:tcBorders elements must be "fully boxed" (see
# _tcborders_is_fully_boxed) before that's trusted as real grid evidence
# rather than one decorative emphasis box on an otherwise plain table. A
# single fully-boxed cell proves nothing about the REST of the table; 2+
# distinct cells doing it is the same visual pattern insideH/insideV
# shorthand produces, just expressed per-cell -- confirmed against a real
# customer document where every cell used explicit top/left/bottom/right
# with no insideH/insideV anywhere in the whole table.
_FULLY_BOXED_CELL_GRID_THRESHOLD = 2


def _tcborders_is_fully_boxed(tcBorders) -> bool:
    """True if a per-cell `w:tcBorders` has a real (non-none/nil) border on
    EVERY one of the 4 outer sides -- top AND bottom AND left AND right,
    not just any one of them (that's `_borders_element_has_real_border`'s
    job: an OR-check, for classifying "outer" at all). A genuinely
    outer-only table (only the table's OUTWARD boundary bordered) only
    borders a cell's OUTWARD-facing sides -- a fully-interior cell has no
    outward side at all, so a real border on ALL FOUR of a cell's sides
    can only come from a deliberate per-cell grid pattern."""
    for tag in _BORDER_OUTER_TAGS:
        el = tcBorders.find(qn(f"w:{tag}"))
        if el is None:
            return False
        val = el.get(qn("w:val"))
        if val is not None and val.lower() in _BORDER_NONE_VALS:
            return False
    return True


# Conditional-formatting regions this resolves out of a referenced table
# STYLE's own definitions, in the OOXML vocabulary's own type names --
# deliberately NOT exhaustive. firstCol/lastCol/the 4 corner-cell types
# (neCell/nwCell/seCell/swCell) are real OOXML conditional types but rare
# in practice; the goal here is a table-level "does this style give the
# table a visual grid/outer-border look" yes/no answer, not per-region
# precision -- consistent with _table_border_style's own "deliberately
# coarse" scope. Extend this tuple if a real document is ever found relying
# on one of the omitted types.
_RESOLVED_STYLE_CONDITION_TYPES = ("wholeTable", "firstRow", "lastRow", "band1Horz", "band2Horz")


def _table_look_flags(tblPr) -> dict[str, bool]:
    """`w:tblLook` toggles which of a table style's conditional-formatting
    regions actually apply to THIS table instance -- a table can reference
    a style with firstRow/banding border definitions and still have them
    switched off for this particular table. Absent `w:tblLook`, or an
    absent specific flag on it, defaults to "off": a style's mere
    existence must never be assumed to apply formatting the table itself
    never opted into via a real `w:tblLook` attribute value of `"1"`."""
    tblLook = tblPr.find(qn("w:tblLook"))
    if tblLook is None:
        return {}

    def flag(name: str) -> bool:
        return tblLook.get(qn(f"w:{name}")) == "1"

    return {"firstRow": flag("firstRow"), "lastRow": flag("lastRow"), "noHBand": flag("noHBand")}


def _resolve_table_style_chain(styles_root, style_id: str | None, *, max_depth: int = 10) -> list:
    """Walks `styleId -> w:basedOn -> styleId -> ...`, collecting every
    `w:style` element in the chain, most-specific (the table's own directly
    referenced style) first. `max_depth` guards a malformed/cyclic
    `w:basedOn` chain -- OOXML's schema doesn't forbid one, and this loader
    must not hang on a corrupt document."""
    chain = []
    seen: set[str] = set()
    current_id = style_id
    depth = 0
    while current_id and current_id not in seen and depth < max_depth:
        seen.add(current_id)
        depth += 1
        style_el = next(
            (st for st in styles_root.findall(qn("w:style")) if st.get(qn("w:styleId")) == current_id), None
        )
        if style_el is None:
            break
        chain.append(style_el)
        basedOn = style_el.find(qn("w:basedOn"))
        current_id = basedOn.get(qn("w:val")) if basedOn is not None else None
    return chain


def _table_style_borders_elements(docx_table: DocxTable) -> list:
    """Resolves the table's referenced `w:tblStyle` (see `_table_border_style`
    for why this matters -- most real-document gridlines come from a table
    style, not explicit per-cell XML) into the `w:tcBorders` elements its
    `_RESOLVED_STYLE_CONDITION_TYPES` regions declare, filtered to only the
    regions this specific table's own `w:tblLook` actually enables (see
    `_table_look_flags`). Per condition type, the most-specific style in the
    `w:basedOn` chain that defines it wins whole -- never merged
    property-by-property across the chain, same coarse-by-design scope as
    everywhere else in this function group. Returns `[]` when the table has
    no `w:tblStyle` reference at all (nothing to resolve)."""
    tblPr = docx_table._tbl.tblPr
    tblStyle = tblPr.find(qn("w:tblStyle"))
    if tblStyle is None:
        return []
    chain = _resolve_table_style_chain(docx_table.part.styles.element, tblStyle.get(qn("w:val")))
    look = _table_look_flags(tblPr)

    elements = []
    # A style's own UNCONDITIONAL w:tblPr/w:tblBorders -- a direct sibling
    # of w:tblStylePr on w:style, never nested inside one -- is a separate
    # thing from the conditional-region resolution below and was
    # completely missed by an earlier version of this function. This is
    # exactly where Word's own built-in "Table Grid" style (arguably the
    # single most common way real documents get a gridded table at all)
    # declares its borders: no w:tblStylePr children whatsoever, just a
    # bare w:tblPr/w:tblBorders with real insideH/insideV. Confirmed live:
    # applying "Table Grid" with zero explicit per-cell/table XML previously
    # still resolved to "none". Most-specific style in the chain that
    # defines one wins (not gated by tblLook -- unconditional means exactly
    # that, it doesn't need a table to opt in the way a conditional region
    # does).
    for style_el in chain:
        base_tblPr = style_el.find(qn("w:tblPr"))
        base_tblBorders = base_tblPr.find(qn("w:tblBorders")) if base_tblPr is not None else None
        if base_tblBorders is not None:
            elements.append(base_tblBorders)
            break

    resolved_by_type: dict[str, object] = {}
    for style_el in chain:
        for pr in style_el.findall(qn("w:tblStylePr")):
            cond_type = pr.get(qn("w:type"))
            if cond_type in resolved_by_type or cond_type not in _RESOLVED_STYLE_CONDITION_TYPES:
                continue
            resolved_by_type[cond_type] = pr

    for cond_type, pr in resolved_by_type.items():
        if cond_type == "firstRow" and not look.get("firstRow", False):
            continue
        if cond_type == "lastRow" and not look.get("lastRow", False):
            continue
        if cond_type in ("band1Horz", "band2Horz") and look.get("noHBand", False):
            continue
        tcPr = pr.find(qn("w:tcPr"))
        tcBorders = tcPr.find(qn("w:tcBorders")) if tcPr is not None else None
        if tcBorders is not None:
            elements.append(tcBorders)
    return elements


def _table_border_style(docx_table: DocxTable) -> Literal["none", "grid", "outer"]:
    """Deliberately coarse, TABLE-LEVEL (not per-cell) classification of
    border presence, exactly matching `Table.border_style`'s own documented
    scope (see model.py) -- not a full per-side/per-cell border spec.

    Aggregates every border-bearing element in the table: the table-level
    `w:tblPr/w:tblBorders` (if present), every cell's own `w:tcPr/w:tcBorders`
    override (if present), AND -- per `_table_style_borders_elements` -- the
    table's referenced `w:tblStyle`'s own relevant conditional-formatting
    regions (`styles.xml`'s `w:tblStylePr`), gated on `w:tblLook`. A real
    Word table can declare its grid via any of these; this function doesn't
    need to pick a winner among them, only detect whether a real border
    exists ANYWHERE in the union -- explicit XML and style-implied borders
    are evidence for the exact same table-level yes/no question.

    Classification: `"grid"` if ANY aggregated element has a real
    (non-none/nil) `insideH` or `insideV` side -- an interior gridline
    implies a full grid look regardless of what the outer sides also say.
    Else `"outer"` if ANY aggregated element has a real `top`/`bottom`/
    `left`/`right` side with no interior line found anywhere. Else
    `"none"` -- covers both "no border elements at all" and "border
    elements present but every side is explicitly none/nil" (an author
    explicitly turning borders off produces the same visual and semantic
    outcome as never specifying them, so both collapse to the same value).

    ALSO `"grid"` if `_FULLY_BOXED_CELL_GRID_THRESHOLD` or more distinct
    per-cell `w:tcBorders` elements are fully boxed (see
    `_tcborders_is_fully_boxed`) -- confirmed real: a real customer
    document authors its grid entirely via per-cell top/left/bottom/right
    on every cell, never insideH/insideV at all, which the insideH/insideV
    check above cannot see on its own.

    Table STYLE-implied SHADING (`_cell_background_color`) is a separate,
    still-unresolved v1 boundary -- this function's own scope covers
    borders only; resolving style-implied cell shading is a distinct,
    not-yet-made scope decision.
    """
    borders_elements = []
    tcborders_elements = []
    tblBorders = docx_table._tbl.tblPr.find(qn("w:tblBorders"))
    if tblBorders is not None:
        borders_elements.append(tblBorders)
    for row in docx_table.rows:
        for tc in row._tr.tc_lst:
            tcPr = tc.tcPr
            if tcPr is None:
                continue
            tcBorders = tcPr.find(qn("w:tcBorders"))
            if tcBorders is not None:
                borders_elements.append(tcBorders)
                tcborders_elements.append(tcBorders)
    borders_elements.extend(_table_style_borders_elements(docx_table))

    if any(_borders_element_has_real_border(el, _BORDER_INSIDE_TAGS) for el in borders_elements):
        return "grid"
    fully_boxed_count = sum(1 for el in tcborders_elements if _tcborders_is_fully_boxed(el))
    if fully_boxed_count >= _FULLY_BOXED_CELL_GRID_THRESHOLD:
        return "grid"
    if any(_borders_element_has_real_border(el, _BORDER_OUTER_TAGS) for el in borders_elements):
        return "outer"
    return "none"


def _column_widths(docx_table: DocxTable) -> list[float] | None:
    """`w:tblGrid/w:gridCol/@w:w`, converted to FRACTIONS of the table's
    total declared width (each column's width divided by the sum of every
    column's width) -- never the raw twips value itself, which must never
    reach the renderer (same "no source units past the loader" rule that
    fixed the earlier figure-sizing overflow bug, per the design spec's
    layout-overflow section).

    `gridCol.w` (python-docx's own `ST_TwipsMeasure`-typed accessor)
    already resolves to a `Length` (EMU) object rather than a raw twips
    int, but since only the RATIO between columns is used here, the
    absolute unit is irrelevant -- no explicit twips/EMU conversion step is
    needed.

    Returns `None` (never a fabricated equal-width fallback) when
    `w:tblGrid` has no `w:gridCol` children at all, or when any column's
    width is missing/non-positive (a `w:gridCol` with no `@w:w` attribute,
    or a degenerate zero-width column) -- an honest "don't know" beats
    guessing equal shares from nothing, per the model's own
    `column_widths` documentation.
    """
    grid_cols = docx_table._tbl.tblGrid.gridCol_lst
    if not grid_cols:
        return None
    widths = [col.w for col in grid_cols]
    if any(w is None or w <= 0 for w in widths):
        return None
    total = sum(widths)
    return [w / total for w in widths]


def _extract_table_cells(docx_table: DocxTable) -> list[list[TableCell | None]]:
    """Builds the canonical `cells: list[list[TableCell | None]]` grid for
    a table (`app/canonical/model.py`'s `Table.cells`), expanding merged
    cells structurally instead of naively reading `row.cells` (the
    previous approach, and the reason this function originally existed --
    see git history for the "FAN configuration - 1" x3 / "GPU" x2
    duplication bug this replaced). `row.cells` has DOCUMENTED behavior in
    python-docx: for a cell with a horizontal merge (`w:tcPr/w:gridSpan`)
    or a vertical merge (`w:tcPr/w:vMerge`), it returns text resolved from
    the SAME origin `_Cell` at every grid position the merge spans -- so a
    naive per-position `.text` read duplicates the merged cell's real
    content. Relying on `.text` equality or `_Cell` object identity to
    detect this is unreliable (fresh wrapper objects are created per
    `row.cells` call, so `id()` can coincidentally collide after GC reuse)
    -- so merge state is instead read from the real OOXML via each
    physical `w:tc` element's `grid_span` / `vMerge` properties (there is
    no other public API for this in python-docx).

    Grid semantics, one real `TableCell` per ORIGIN position, `None`
    everywhere else a merge (or an omitted `gridBefore`/`gridAfter`
    position) covers:
      - `w:tcPr/w:gridSpan/@w:val` (`tc.grid_span`, defaults to 1 when
        absent) is carried straight through to `TableCell.colspan` --
        the remaining `grid_span - 1` grid positions to its right are
        left `None` (pre-filled below), never given their own `TableCell`.
      - `w:tcPr/w:vMerge` (`tc.vMerge`): `None` when absent (not merged),
        `"restart"` for the origin row of a vertical span, `"continue"`
        for every subsequent row -- including when `w:vMerge` is present
        with NO `@w:val` attribute at all, which OOXML (and python-docx's
        own `ST_Merge` default) treats as an implicit "continue". A
        `"continue"` `w:tc` is a pure continuation regardless of what
        text, if any, its own paragraph carries: it is skipped entirely
        here (never given a `TableCell`), leaving its grid position(s) at
        the pre-filled `None` -- exactly the model's "spanned" meaning.
        Its real rowspan count was already computed once, on the ORIGIN
        cell, so nothing is lost by ignoring the continuation cells' own
        content.
      - Real rowspan count: `tc.bottom - tc.top`. python-docx's own
        `CT_Tc.top`/`.bottom` already do the cross-row walk (following
        `vMerge == "continue"` down/up via `_tc_below`/`_tc_above`) AND
        already resolve each row's real grid column through
        `tc.grid_offset` / `CT_Row.tc_at_grid_offset`, which itself
        accounts for `w:trPr/w:gridBefore` (unpopulated columns at the
        START of a row) -- exactly the column-index bookkeeping this
        function would otherwise have to hand-roll to avoid landing a
        rowspan in the wrong column on a document using `gridBefore`/
        `gridAfter`. Reusing these properties instead of re-deriving grid
        columns from scratch is why no separate "current column" counter
        is threaded through this function's own loop. For a non-merged
        cell (`vMerge is None`), `.top`/`.bottom` still resolve correctly
        (`_tr_idx` and `_tr_idx + 1`), so `tc.bottom - tc.top` is always 1
        in that case -- no separate branch is needed for the common case.
      - `w:tcPr` positions never touched by any `w:tc` in the row at all
        (a `gridBefore`/`gridAfter` omission, not a merge) are also left
        `None`. Unlike a heuristically-detected PDF table, every docx grid
        position with real content has an explicit `w:tc` element -- OOXML
        simply has no notion of "detected an empty region with no
        backing element" the way pdfplumber's geometry-only extraction
        does, so a genuine `TableCell(text="")` GAP (as opposed to a
        `None` SPANNED position) is not something a docx table can
        produce; this was confirmed by reading the OOXML table model
        rather than assumed.
      - `w:trPr/w:tblHeader` presence marks every cell in that row
        `is_header=True` (see `_row_is_header`).
      - Alignment (`_cell_alignment`) and the uniform-bold rule
        (`_cell_is_bold`) are both per-origin-cell only, for the same
        reason spans are -- a `"continue"`/spanned position never gets its
        own `TableCell` to hold them.
      - `background_color` (`_cell_background_color`) and `text_color`
        (`_cell_text_color`) are likewise per-origin-cell only, same
        reason. This is Phase 2 of
        docs/superpowers/specs/2026-08-12-table-fidelity-design.md --
        EXPLICIT per-cell `w:shd`/`w:color` only. Phase 0 of that spec
        found most real Word table shading actually comes from
        `w:tblStyle`-inherited conditional formatting (`styles.xml`'s
        `w:tblStylePr` variants), which python-docx does not resolve and
        this loader deliberately does not attempt either -- a table
        relying purely on a table style for its shading correctly yields
        `background_color=None` for every cell, a documented honest v1
        gap, not a bug.

    `column_widths`/`border_style` are TABLE-level, not per-cell -- they
    are computed once by `_column_widths`/`_table_border_style` in
    `load_docx`'s own `Table(...)` construction, not here.
    """
    n_cols = len(docx_table.columns)
    grid: list[list[TableCell | None]] = []
    for row in docx_table.rows:
        tr = row._tr
        row_cells: list[TableCell | None] = [None] * n_cols
        is_header = _row_is_header(tr)
        for tc in tr.tc_lst:
            if tc.vMerge == "continue":
                continue
            cell = DocxCell(tc, docx_table)
            row_cells[tc.grid_offset] = TableCell(
                text=cell.text.strip(),
                colspan=tc.grid_span,
                rowspan=tc.bottom - tc.top,
                is_header=is_header,
                bold=_cell_is_bold(cell),
                align=_cell_alignment(tc),
                background_color=_cell_background_color(tc),
                text_color=_cell_text_color(cell),
            )
        grid.append(row_cells)
    return grid


def _describe_one_figure(
    rel, describe_figure: Callable[[bytes], str] | None
) -> str | None:
    """Shared per-image describe_figure call + failure handling, used by
    both the inline (real document-order) and fallback (floating/unmatched
    rel) figure paths below -- a vision failure for one image must not
    abort the whole document, same guarantee either path relies on."""
    if describe_figure is None:
        return None
    try:
        return describe_figure(rel.target_part.blob)
    except Exception:  # noqa: BLE001 -- a vision failure must not abort the whole document
        logger.warning(
            "describe_figure failed for %s (rel target %s)", rel.target_part.content_type, rel.target_ref, exc_info=True
        )
        return None


def _outline_level_from_ppr(ppr) -> int | None:
    """w:outlineLvl is 0-based per the OOXML spec; this file's Block.
    heading_level is 1-based, matching every existing loader/test.
    A malformed/non-numeric `@w:val` (not valid per the OOXML schema, but
    this loader must not trust source XML to be well-formed) falls through
    to `None` -- not a heading via THIS signal -- rather than raising and
    aborting the whole document load, same graceful-degradation guarantee
    as every other malformed-input case in this module. `int()` itself is
    the validity check (via try/except) rather than a pre-check like
    `str.isdigit()` -- `"--3".lstrip("-").isdigit()` is True but
    `int("--3")` still raises, and `str.isdigit()` also accepts non-decimal
    Unicode digits (e.g. superscript "²") that `int()` rejects; only
    `int()`'s own parsing is a reliable definition of "parseable as int,"
    the same reasoning `_describe_one_figure`'s `except Exception` uses for
    another input-dependent failure elsewhere in this module."""
    outline_lvl = ppr.find(qn("w:outlineLvl"))
    if outline_lvl is None:
        return None
    val = outline_lvl.get(qn("w:val"))
    if val is None:
        return None
    try:
        return int(val) + 1
    except ValueError:
        return None


def _heading_level_for_paragraph(paragraph: DocxParagraph) -> int | None:
    """Heading level via whichever signal is present, in order of
    reliability: (1) an explicit outlineLvl override on THIS paragraph's
    own pPr -- rare, but the most authoritative signal when present; (2)
    outlineLvl on the paragraph's STYLE definition -- what Word's own
    built-in Heading 1-9 styles actually carry (confirmed live: a
    "Heading 1"-styled paragraph has NO outlineLvl on its own pPr, only
    on the style's pPr), so this is what fires for the common case,
    template-independent of the style's NAME; (3) style-name regex
    fallback ("Heading" + optional space + digits, or "Title") for a
    template that defines neither outlineLvl location -- allows both the
    with-space Word convention ("Heading 1") and the no-space convention
    docgen-json-to-word emits ("Heading3"). Returns None (falls through to
    PARAGRAPH) for a style regex can't parse, e.g. a custom style like
    "Heading Body" -- never raises."""
    own_ppr = paragraph._p.pPr
    if own_ppr is not None:
        level = _outline_level_from_ppr(own_ppr)
        if level is not None:
            return level

    style = paragraph.style
    if style is not None:
        style_ppr = style.element.find(qn("w:pPr"))
        if style_ppr is not None:
            level = _outline_level_from_ppr(style_ppr)
            if level is not None:
                return level

    style_name = style.name if style else ""
    if style_name == "Title":
        return 1
    match = _HEADING_STYLE_PATTERN.match(style_name)
    if match:
        return int(match.group(1))
    return None


def load_docx(path: str, describe_figure: Callable[[bytes], str] | None = None) -> CanonicalDoc:
    """`describe_figure`, when provided, is called with each embedded
    image's raw bytes and must return a short text description -- used to
    replace the `[FIGURE: none]` placeholder with real content (see
    app/vision/orchestrator_vision_client.py). None (the default) preserves
    the original placeholder-only behavior exactly. A describe_figure
    failure for one image must not abort the whole document -- caught and
    falls back to the placeholder for that image only."""
    file_path = Path(path)
    sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
    document = Document(path=path, format=DocumentFormat.DOCX, sha256=sha256)

    docx_doc = DocxDocument(path)
    blocks: list[Block] = []
    tables: list[Table] = []
    figures: list[Figure] = []
    block_id = 0
    table_index = 0
    figure_index = 0
    offset = 0
    # Every image rel consumed inline (see the w:p branch below) is recorded
    # here so the fallback pass after the body walk doesn't double-emit it.
    consumed_rel_ids: set[str] = set()

    # Single body-element walk (python-docx's standard idiom for document
    # order) instead of the previous two SEPARATE extraction passes
    # (docx_doc.paragraphs, then docx_doc.tables) -- that lost any real
    # ordering relationship between the two: a table's SourceRef was always
    # the (0,0) placeholder, and render_section could only ever append ALL
    # of a branch's tables at its very end, never interleaved at their real
    # position. Sharing one monotonically increasing `offset` counter across
    # blocks, tables, AND inline figures (see below) gives every element a
    # real, comparable order position.

    def _walk_body_elements(elements) -> None:
        for child in elements:
            if child.tag == qn("w:p"):
                _handle_paragraph(child)
            elif child.tag == qn("w:tbl"):
                _handle_table(child)
            elif child.tag == qn("w:sdt"):
                sdt_content = child.find(qn("w:sdtContent"))
                if sdt_content is not None:
                    _walk_body_elements(sdt_content.iterchildren())

    def _handle_paragraph(child) -> None:
        nonlocal block_id, figure_index, offset
        paragraph = DocxParagraph(child, docx_doc)
        content = paragraph.text.strip()
        # Inline drawings (a pasted image, or a converted EMF/WMF
        # diagram) embedded directly in this paragraph -- resolved via
        # the DrawingML <a:blip r:embed="..."> reference to the actual
        # image part. Previously EVERY image rel on the whole document
        # was collected in one pass AFTER this body walk finished, each
        # given a (0, 0) placeholder SourceRef -- so every figure folded
        # into whichever node happened to be open LAST, not its real
        # parent (see tree_builder.py's depth=None fold). Resolving
        # inline, at the paragraph's own position, gives each figure the
        # same real-position treatment tables already got.
        blip_elements = child.findall(f".//{qn('a:blip')}")
        embed_ids = [embed_id for b in blip_elements if (embed_id := b.get(qn("r:embed")))]

        if not content and not embed_ids:
            return

        if content:
            start = offset
            end = start + len(content)
            offset = end + 1

            heading_level = _heading_level_for_paragraph(paragraph)
            if heading_level is not None:
                blocks.append(
                    Block(
                        id=f"b{block_id}",
                        kind=BlockKind.HEADING,
                        text=content,
                        heading_level=heading_level,
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                    )
                )
            else:
                own_ppr = paragraph._p.pPr
                is_list_item = own_ppr is not None and own_ppr.find(qn("w:numPr")) is not None
                blocks.append(
                    Block(
                        id=f"b{block_id}",
                        kind=BlockKind.LIST_ITEM if is_list_item else BlockKind.PARAGRAPH,
                        text=content,
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                    )
                )
            block_id += 1

        for embed_id in embed_ids:
            rel = docx_doc.part.rels.get(embed_id)
            if rel is None or _IMAGE_RELTYPE_MARKER not in rel.reltype:
                continue
            consumed_rel_ids.add(embed_id)
            caption = _describe_one_figure(rel, describe_figure)
            start = offset
            end = start + 1
            offset = end
            figures.append(
                Figure(
                    id=f"f{figure_index}",
                    caption=caption,
                    source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                )
            )
            blocks.append(
                Block(
                    id=f"b{block_id}",
                    kind=BlockKind.FIGURE,
                    text=f"[FIGURE: {caption or 'none'}]",
                    source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                )
            )
            block_id += 1
            figure_index += 1

    def _handle_table(child) -> None:
        nonlocal table_index, offset
        docx_table = DocxTable(child, docx_doc)
        cells = _extract_table_cells(docx_table)
        start = offset
        end = start + 1
        offset = end
        # Real per-cell colspan/rowspan/is_header/align/bold/
        # background_color/text_color -- see _extract_table_cells' own
        # docstring. column_widths/border_style are TABLE-level (not
        # per-cell), computed here via _column_widths/
        # _table_border_style per Phase 2 of
        # docs/superpowers/specs/2026-08-12-table-fidelity-design.md.
        tables.append(
            Table(
                id=f"t{table_index}",
                cells=cells,
                column_widths=_column_widths(docx_table),
                border_style=_table_border_style(docx_table),
                source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
            )
        )
        table_index += 1

    _walk_body_elements(docx_doc.element.body.iterchildren())

    # Fallback: any image rel NOT consumed above (a floating/anchored
    # drawing rather than an inline one, a header/footer image, or any
    # other embedding this walk doesn't recognize) keeps the previous
    # append-at-end, (0, 0)-placeholder behavior -- a documented
    # approximation for the cases this walk can't place, not silent loss.
    for rel_id, rel in docx_doc.part.rels.items():
        if rel_id in consumed_rel_ids or _IMAGE_RELTYPE_MARKER not in rel.reltype:
            continue
        caption = _describe_one_figure(rel, describe_figure)
        figures.append(
            Figure(
                id=f"f{figure_index}",
                caption=caption,
                source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0),
            )
        )
        blocks.append(
            Block(
                id=f"b{block_id}",
                kind=BlockKind.FIGURE,
                text=f"[FIGURE: {caption or 'none'}]",
                source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0),
            )
        )
        block_id += 1
        figure_index += 1

    return CanonicalDoc(document=document, blocks=blocks, tables=tables, figures=figures)
