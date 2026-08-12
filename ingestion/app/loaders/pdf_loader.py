from __future__ import annotations

import hashlib
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Literal

import pdfplumber
from pypdf import PdfReader

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, Figure, SourceRef, Table, TableCell

# --- Phase 4 (docs/superpowers/specs/2026-08-12-table-fidelity-design.md):
# real best-effort/heuristic PDF table styling extraction. Everything below
# this point down to `_build_pdf_table_grid` supports it. This is
# EXPLICITLY the lowest-confidence format of the whole table-fidelity
# feature -- docx/xlsx/pptx read explicit source markup (a `w:shd/@w:fill`,
# a `PatternFill`, an XML cell attribute); PDF has no such markup at all,
# only page geometry (character/rect positions) to infer structure and
# style FROM. Every function below is a heuristic, documented as such, and
# every one degrades to `None`/a safe default on any failure rather than
# raising -- a styling-extraction miss must never abort ingestion of an
# otherwise-good document (see `_build_pdf_table_grid`'s own docstring for
# the field-by-field try/except shape that guarantees this).

# Naive `"bold" in fontname.lower()` (the old placeholder check this Phase
# replaces) already catches "-Bold", "BoldMT", and even "Semibold" (which
# literally contains the substring "bold") -- kept as the primary/fallback
# check below. It does NOT catch "-Black" or "-Heavy" (real font-weight
# names for bold-ish weights that don't spell "bold") or the common
# abbreviated embedded-subset-font suffix "-Bd" (e.g. a subset font named
# like "ABCDEF+Arial-BdMT" -- "bdmt" doesn't contain "bold" either). These
# three tokens widen coverage beyond the bare "bold" check; they do not
# replace it.
_BOLD_FONTNAME_EXTRA_TOKENS = ("black", "heavy", "-bd")

# Alignment heuristic tolerance (see `_cell_alignment`): the two side
# paddings must each land within this fraction of the total available
# padding around the exact 50/50 midpoint to be classified "center" --
# i.e. a left-padding ratio in [0.4, 0.6]. Chosen as a deliberately loose
# band: PDF text positioning has real sub-point jitter (kerning, font
# metrics rounding), and a tight band would misclassify genuinely-centered
# text as left/right far too often. 0.2 is not derived from any formal
# measurement -- it is a documented, reasonable guess for "roughly equal
# padding," matching the task's explicit acceptance that this heuristic
# will misclassify some real cells.
_ALIGNMENT_CENTER_BAND = 0.2

# Background-color heuristic threshold (see `_cell_background_color`): a
# filled `page.rects` rectangle must cover at least this fraction of a
# cell's own bbox area to be treated as that cell's background. Not 1.0
# (pixel-perfect) because real PDF rendering rarely produces an exact
# rect-to-cell match -- ruling-line-derived cell bboxes and fill-rect
# bboxes commonly differ by a point or two of sub-pixel/anti-aliasing
# slack. 0.8 is a deliberately generous-but-not-blind threshold: high
# enough to reject a rect that merely clips a corner of the cell (e.g. a
# decorative accent bar), low enough to tolerate realistic rendering
# slack. This is explicitly the WEAKEST signal in this whole feature (see
# `_cell_background_color`'s own docstring for why) -- the threshold
# choice cannot fix that, only bound how eagerly it guesses.
_BACKGROUND_OVERLAP_THRESHOLD = 0.8


def _fontname_is_bold(fontname: str | None) -> bool:
    """Widened bold-fontname substring match -- see `_BOLD_FONTNAME_EXTRA_TOKENS`
    above for exactly which patterns this adds over the naive `"bold" in
    fontname` check. Case-insensitive throughout; `fontname` can be `None`
    (a character with no resolvable font)."""
    if not fontname:
        return False
    lowered = fontname.lower()
    return "bold" in lowered or any(token in lowered for token in _BOLD_FONTNAME_EXTRA_TOKENS)


def _pdf_cell_chars(page_chars: list[dict], bbox: tuple[float, float, float, float]) -> list[dict]:
    """Characters whose midpoint lies inside `bbox`, using the SAME
    midpoint-containment test `pdfplumber`'s own `Table.extract()` uses
    internally (`table.py`'s nested `char_in_bbox` closure -- not a public
    function, so reimplemented here rather than imported) so bold/text-
    color/alignment analysis looks at exactly the same characters
    `extract()` already decided belong to this cell, not a
    independently-computed (and possibly disagreeing) set."""
    x0, top, x1, bottom = bbox
    return [
        ch
        for ch in page_chars
        if x0 <= (ch["x0"] + ch["x1"]) / 2 < x1 and top <= (ch["top"] + ch["bottom"]) / 2 < bottom
    ]


def _cell_is_bold(cell_chars: list[dict]) -> bool:
    """Uniform-bold rule -- a cell is bold only if EVERY non-whitespace
    character in it has a bold-matching `fontname` (see
    `TableCell.bold`'s own docstring in `app/canonical/model.py`, and the
    design spec's "Bold detection rule" section, for the cross-format
    rationale this mirrors). A "majority of characters" rule was
    considered instead -- PDF's per-CHARACTER (not per-run) granularity
    was flagged as a reason uniformity might be impractical/noisy here --
    but rejected: `TableCell.bold`'s own docstring hardcodes "every run
    containing non-whitespace text" as the model-wide contract, and a
    character is, if anything, a STRICTER/finer unit than a docx run
    (never spans multiple words of differing weight the way a run
    theoretically could), so uniformity across characters is at least as
    reliable as uniformity across runs, not less. Using "majority" here
    would silently give PDF a looser, format-specific bold definition than
    every other loader -- a real, easily-missed regression source, not a
    style choice worth making just to hedge against noise that was never
    actually observed. Whitespace-only characters are skipped entirely
    (don't count against the cell), matching `_cell_is_bold`'s docx
    precedent exactly. A cell with no non-whitespace characters is not
    bold.
    """
    saw_non_whitespace = False
    for ch in cell_chars:
        if not (ch.get("text") or "").strip():
            continue
        saw_non_whitespace = True
        if not _fontname_is_bold(ch.get("fontname")):
            return False
    return saw_non_whitespace


def _pdf_color_to_hex(color: Any) -> str | None:
    """Converts a `pdfplumber` `non_stroking_color` value (from a char OR a
    rect -- both use the same representation) to a normalized lowercase
    `#rrggbb` string, or `None` when it isn't a real, convertible color.

    CONFIRMED empirically this session (not assumed from docs alone) via a
    real reportlab-generated PDF inspected directly through pdfplumber:
    `non_stroking_color` is NOT a hex string. Its shape depends on the
    PDF's colorspace, and (confirmed by the same spike) grayscale can come
    back as a BARE float/int, not just a 1-tuple:
      - `None` -- no color resolved; returns `None`.
      - a `str` -- a pattern-fill name (tiling/shading pattern), not a
        literal color at all; returns `None` rather than guessing.
      - a bare `int`/`float` -- grayscale value in [0, 1], replicated
        across R/G/B.
      - a 1-`tuple`/`list` -- same grayscale case, just wrapped.
      - a 3-`tuple`/`list` -- RGB, each channel typically a [0, 1] float;
        multiplied by 255 and rounded, clamped to [0, 255].
      - a 4-`tuple`/`list` -- CMYK, converted via the standard formula
        `R = 255*(1-C)*(1-K)` (and the equivalent for G/B) before the same
        clamp-and-round.
      - anything else (unexpected arity, non-numeric contents, ...) --
        `None`. Never guess.

    The entire body is one `try`/`except` -- a malformed/unexpected value
    from a real-world PDF (non-numeric channel, out-of-range float, a
    library edge case) degrades this ONE color to `None` rather than
    raising and aborting the table/document, per this Phase's "never fail
    the ingest" requirement.
    """
    try:
        if color is None or isinstance(color, str):
            return None
        if isinstance(color, (int, float)):
            channels = (float(color), float(color), float(color))
        elif isinstance(color, (tuple, list)):
            if len(color) == 1:
                v = float(color[0])
                channels = (v, v, v)
            elif len(color) == 3:
                channels = tuple(float(v) for v in color)
            elif len(color) == 4:
                c, m, y, k = (float(v) for v in color)
                channels = ((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k))
            else:
                return None
        else:
            return None

        def to_byte(v: float) -> int:
            return max(0, min(255, round(v * 255)))

        r, g, b = (to_byte(v) for v in channels)
        return f"#{r:02x}{g:02x}{b:02x}"
    except Exception:  # noqa: BLE001 -- a malformed color value degrades to "unknown", never crashes the table
        return None


def _cell_text_color(cell_chars: list[dict]) -> str | None:
    """FIRST non-whitespace character's `non_stroking_color`, converted via
    `_pdf_color_to_hex` -- the same "first wins" simplification precedent
    `docx_loader.py`'s `_cell_text_color` already established for exactly
    this "no safe single answer when characters disagree" situation (see
    that function's own docstring). PDF has no run/paragraph grouping at
    all -- just a flat character stream per cell -- so "first non-whitespace
    character" is the natural finest-grained analogue of "first non-
    whitespace run"."""
    for ch in cell_chars:
        if not (ch.get("text") or "").strip():
            continue
        return _pdf_color_to_hex(ch.get("non_stroking_color"))
    return None


def _cell_background_color(page_rects: list[dict], bbox: tuple[float, float, float, float]) -> str | None:
    """Best-effort per-cell background color via `page.rects` bbox overlap
    -- EXPLICITLY the weakest signal in this whole feature. Real PDF table
    backgrounds are very often drawn as ONE big filled rect behind an
    entire table region (not per-cell), which would make every cell in
    that table report the SAME background here -- not wrong exactly (the
    visual result is the same color), but not really "per-cell" detection
    either. Some backgrounds are drawn as vector path/curve fills that
    never show up in `page.rects` at all, in which case this correctly
    finds nothing and returns `None` -- an honest absence, not a bug.

    Only rects with `fill` truthy are considered (an unfilled/stroke-only
    rect's own `non_stroking_color` is a meaningless placeholder value --
    CONFIRMED empirically this session: a stroke-only rect's
    `non_stroking_color` came back as the literal `0`, not `None` -- same
    "gate on the presence flag before trusting the color field" trap
    `xlsx_loader.py`'s `_resolve_fill_color` already documents for
    `patternType`). Among qualifying rects, the one with the HIGHEST
    overlap fraction (fraction of the cell's own area the rect covers) is
    used, provided that fraction meets `_BACKGROUND_OVERLAP_THRESHOLD` --
    see that constant's own docstring for the exact threshold and why.
    Degrades to `None` when no rect meets the threshold, the cell bbox is
    degenerate (zero area), or anything else goes wrong.
    """
    try:
        x0, top, x1, bottom = bbox
        cell_area = max(x1 - x0, 0.0) * max(bottom - top, 0.0)
        if cell_area <= 0:
            return None
        best_color: str | None = None
        best_overlap = 0.0
        for rect in page_rects:
            if not rect.get("fill"):
                continue
            rx0, rtop, rx1, rbottom = rect.get("x0", 0), rect.get("top", 0), rect.get("x1", 0), rect.get("bottom", 0)
            iw = max(min(x1, rx1) - max(x0, rx0), 0.0)
            ih = max(min(bottom, rbottom) - max(top, rtop), 0.0)
            overlap_fraction = (iw * ih) / cell_area
            if overlap_fraction >= _BACKGROUND_OVERLAP_THRESHOLD and overlap_fraction > best_overlap:
                candidate = _pdf_color_to_hex(rect.get("non_stroking_color"))
                if candidate is not None:
                    best_overlap = overlap_fraction
                    best_color = candidate
        return best_color
    except Exception:  # noqa: BLE001 -- background is the weakest signal already; any failure here just means "unknown"
        return None


def _cell_alignment(
    cell_chars: list[dict], bbox: tuple[float, float, float, float]
) -> Literal["left", "center", "right", "justify"] | None:
    """Geometric alignment heuristic: compares the cell's actual TEXT bbox
    (min/max x across its own characters) against the cell's OWN bbox.
    `None` (never a guess) when the cell has no characters at all (nothing
    to measure) or the available padding is too small to be a meaningful
    signal (`total_pad <= 1` point -- text essentially fills the cell
    width, e.g. a long value in a narrow column; forcing a left/right call
    there would be noise, not signal).

    Never classifies `"justify"` -- there is no reliable geometric signal
    for justification from a single cell's text bbox (justified text often
    looks identical to left-aligned in a single short line), so this
    heuristic simply never claims it, consistent with this Phase's
    "don't claim confidence you don't have" principle.

    Tolerance: see `_ALIGNMENT_CENTER_BAND`'s own docstring for the exact
    center-band width and reasoning. This IS an approximation that will
    misclassify some real cells (e.g. a short word left-aligned in a wide
    column can look deceptively close to centered) -- an accepted,
    documented cost of a heuristic signal, not a bug to chase away.
    """
    if not cell_chars:
        return None
    x0, _top, x1, _bottom = bbox
    text_x0 = min(ch["x0"] for ch in cell_chars)
    text_x1 = max(ch["x1"] for ch in cell_chars)
    left_pad = text_x0 - x0
    right_pad = x1 - text_x1
    total_pad = left_pad + right_pad
    if total_pad <= 1:
        return None
    left_ratio = left_pad / total_pad
    if 0.5 - _ALIGNMENT_CENTER_BAND / 2 <= left_ratio <= 0.5 + _ALIGNMENT_CENTER_BAND / 2:
        return "center"
    return "left" if left_ratio < 0.5 else "right"


def _colspan_rowspan(
    bbox: tuple[float, float, float, float], xs: list[float], ys: list[float]
) -> tuple[int, int]:
    """Real colspan/rowspan from geometry -- CONFIRMED mechanism (see this
    module's `load_pdf` docstring / the design spec's Phase 0 findings, not
    re-derived here): colspan = count of column x-start edges (`xs`)
    within `[cell.x0, cell.x1)`; rowspan = count of row-top edges (`ys`)
    within `[cell.top, cell.bottom)`. `xs`/`ys` are the SAME edge sets
    `pdfplumber`'s own `Table._get_rows_or_cols` derives internally to
    build `Table.rows`/`Table.columns` in the first place (confirmed by
    reading `table.py`'s source directly: `xs = sorted(set(map(itemgetter(0),
    self.cells)))`, `ys` is the analogous set over `itemgetter(1)`) --
    recomputed here from the same public `Table.cells` list rather than
    re-deriving from scratch, so this can never disagree with the grid
    `Table.rows` itself already produced.

    A non-spanned cell's own `x0`/`top` are themselves always members of
    `xs`/`ys` (they ARE column/row edges), so the counts are always >= 1
    for a well-formed bbox -- the `max(..., 1)` floor below is pure
    defensive floor against float-comparison edge cases on a
    pathological/degenerate fixture, not something expected to trigger in
    practice.
    """
    x0, top, x1, bottom = bbox
    colspan = sum(1 for x in xs if x0 <= x < x1)
    rowspan = sum(1 for y in ys if top <= y < bottom)
    return max(colspan, 1), max(rowspan, 1)


def _pdf_column_widths(found_table, xs: list[float]) -> list[float] | None:
    """Column widths as FRACTIONS of the table's total width, from the same
    `xs` column-start edges `_colspan_rowspan` uses -- more reliable than
    the color/alignment heuristics above (same geometry that found the
    table at all, not a separate inference). Each column's width in points
    is the gap to the NEXT column start, except the last column, whose
    right edge is the table's own overall right edge (`max` of every
    detected cell's `x1`, i.e. `Table.bbox[2]`). Never returns raw point
    values -- same "no source units past the loader" rule
    `docx_loader.py`'s `_column_widths` already documents (per the design
    spec's layout-overflow section). Returns `None` (never a fabricated
    equal-share fallback) when there are no columns, or any computed width
    is non-positive (a degenerate/zero-width column) -- an honest "don't
    know" beats guessing.
    """
    try:
        if not xs:
            return None
        table_right = max(c[2] for c in found_table.cells)
        boundaries = xs + [table_right]
        widths = [boundaries[i + 1] - boundaries[i] for i in range(len(xs))]
        if any(w <= 0 for w in widths):
            return None
        total = sum(widths)
        return [w / total for w in widths]
    except Exception:  # noqa: BLE001 -- column widths are a nice-to-have layout hint, not worth aborting a table over
        return None


def _build_pdf_table_grid(page, found_table) -> tuple[list[list[TableCell | None]], list[float] | None]:
    """Builds the real per-cell styled grid for one `pdfplumber`-detected
    table, replacing the old Phase-1 bare-`TableCell(text=cell or "")`
    compat shim (which discarded the bbox-presence signal entirely -- see
    git history/this function's predecessor for why it was explicitly
    flagged as NOT to be reused verbatim here).

    Structure (span vs. gap): walks `found_table.rows` (already the same
    grid `found_table.extract()` itself walks internally, aligned
    position-for-position) using the CONFIRMED mechanism from the design
    spec's Phase 0 spike -- a `None` bbox at `row.cells[j]` means this grid
    position is SPANNED by a preceding origin cell (leave it `None` in the
    output, no `TableCell`); a present (non-`None`) bbox means a real
    cell -- either normal content, or a genuine GAP if `extract()`'s
    corresponding text came back empty (`TableCell(text="")`, not `None`).
    `xs`/`ys` (the column/row edge sets `_colspan_rowspan` needs) are
    recomputed once, up front, straight from `found_table.cells` -- the
    exact same computation `pdfplumber`'s own `Table._get_rows_or_cols`
    does internally to build `rows`/`columns` (confirmed via source read),
    so this can never disagree with the grid shape `found_table.rows`
    already committed to.

    Style extraction (bold/text_color/background_color/align) is looked up
    PER ORIGIN CELL ONLY (never for a spanned/`None` position, which has no
    `TableCell` to attach style to at all) -- each field is computed via
    its own small helper, each wrapped in its own `try`/`except` so ONE
    field's failure on ONE cell (a malformed color tuple, an empty-chars
    edge case) degrades only that field to its safe default
    (`False`/`None`) rather than losing the whole cell, row, or table. This
    is the concrete shape of this Phase's "never fail the ingest"
    requirement -- mirrors `docx_loader.py`'s `_describe_one_figure`
    try/except precedent in spirit (one failure must not cascade), though
    the exact per-field granularity here is new (docx's precedent guards
    one whole optional feature call, not five independent per-cell style
    reads).

    `is_header` is the design spec's documented PDF heuristic: the first
    detected row only (no font-weight/other secondary signal is combined
    in -- an honest single-signal heuristic, not a claim of a stronger one
    this loader doesn't actually have).
    """
    rows = found_table.rows
    xs = sorted({c[0] for c in found_table.cells})
    ys = sorted({c[1] for c in found_table.cells})
    extracted = found_table.extract()
    page_chars = page.chars
    page_rects = page.rects

    grid: list[list[TableCell | None]] = []
    for row_index, row in enumerate(rows):
        row_out: list[TableCell | None] = []
        for col_index, bbox in enumerate(row.cells):
            if bbox is None:
                # SPANNED -- absorbed by a preceding origin cell's colspan/
                # rowspan (see this function's own docstring). No TableCell
                # here, ever -- rendering one would duplicate the origin
                # cell's content, exactly the bug this whole mechanism
                # exists to avoid.
                row_out.append(None)
                continue

            text = extracted[row_index][col_index]
            text = text if text is not None else ""

            try:
                colspan, rowspan = _colspan_rowspan(bbox, xs, ys)
            except Exception:  # noqa: BLE001
                colspan, rowspan = 1, 1

            try:
                cell_chars = _pdf_cell_chars(page_chars, bbox)
            except Exception:  # noqa: BLE001
                cell_chars = []

            try:
                bold = _cell_is_bold(cell_chars)
            except Exception:  # noqa: BLE001
                bold = False

            try:
                text_color = _cell_text_color(cell_chars)
            except Exception:  # noqa: BLE001
                text_color = None

            try:
                background_color = _cell_background_color(page_rects, bbox)
            except Exception:  # noqa: BLE001
                background_color = None

            try:
                align = _cell_alignment(cell_chars, bbox)
            except Exception:  # noqa: BLE001
                align = None

            row_out.append(
                TableCell(
                    text=text,
                    colspan=colspan,
                    rowspan=rowspan,
                    is_header=(row_index == 0),
                    bold=bold,
                    background_color=background_color,
                    text_color=text_color,
                    align=align,
                )
            )
        grid.append(row_out)

    column_widths = _pdf_column_widths(found_table, xs)
    return grid, column_widths


@lru_cache(maxsize=8)
def cached_pdf_reader(path: str) -> PdfReader:
    # load_pdf_with_ocr_fallback previously called page_has_extractable_text
    # once per page in an `any(...)` scan pass, then again in the main loop
    # -- each call constructed a brand-new PdfReader(path) (itself an O(pages)
    # parse), so a P-page document did ~2P full-document reparses, O(P^2)
    # total. Caching the reader per path (bounded small LRU, not unbounded --
    # this is a request-scoped ingestion process, not a long-lived server
    # cache that should grow forever) turns that into one real parse.
    return PdfReader(path)


def page_has_extractable_text(path: str, page_index: int) -> bool:
    reader = cached_pdf_reader(path)
    page = reader.pages[page_index]
    text = page.extract_text() or ""
    return len(text.strip()) > 0


def _inside_any_bbox(obj: dict, bboxes: list[tuple[float, float, float, float]]) -> bool:
    ox0, otop, ox1, obottom = obj.get("x0", 0), obj.get("top", 0), obj.get("x1", 0), obj.get("bottom", 0)
    return any(x0 <= ox0 and ox1 <= x1 and top <= otop and obottom <= bottom for x0, top, x1, bottom in bboxes)


def _paragraph_tops(filtered_page, paragraphs: list[str]) -> list[float]:
    """One vertical (`top`) position per paragraph, for merging with table
    bboxes into real document order (§12). `extract_words()` and
    `extract_text()` walk the SAME word stream in the SAME top-to-bottom,
    left-to-right reading order -- consuming `len(paragraph.split())` words
    per paragraph, in sequence, gives each paragraph's real top position
    without fuzzy text re-matching against the already-extracted string."""
    words = iter(filtered_page.extract_words())
    tops: list[float] = []
    for paragraph in paragraphs:
        first_word = next(words, None)
        tops.append(first_word["top"] if first_word else 0.0)
        for _ in range(max(len(paragraph.split()) - 1, 0)):
            next(words, None)
    return tops


def load_pdf(
    path: str, describe_figure: Callable[[bytes], str] | None = None, text_only: bool = False
) -> CanonicalDoc:
    """`describe_figure`, when provided, is called with each embedded
    image's raw bytes and must return a short text description -- used to
    replace the `[FIGURE: none]` placeholder with real content (see
    app/vision/orchestrator_vision_client.py). None (the default) preserves
    the original placeholder-only behavior exactly. A describe_figure
    failure for one image must not abort the whole document -- caught and
    falls back to the placeholder for that image only.

    `text_only` (default False, byte-identical to every call site that
    predates this flag): skips page.find_tables() (pdfplumber's dominant
    per-page cost) and the pypdf image-enumeration pass -- for a caller that
    only needs each page's real TEXT (see app/loaders/docx_pagination.py's
    page-alignment use, which converts a docx to PDF purely to borrow this
    function's already-correct per-page text extraction, and has no use for
    the converted PDF's own tables/figures)."""
    file_path = Path(path)
    sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
    document = Document(path=path, format=DocumentFormat.PDF, sha256=sha256)

    blocks: list[Block] = []
    tables: list[Table] = []
    figures: list[Figure] = []
    block_id = 0
    table_id = 0
    figure_id = 0

    with pdfplumber.open(path) as pdf:
        for page_number, page in enumerate(pdf.pages, start=1):
            # §12/§13: table bboxes (page.find_tables()) drive BOTH fixes at
            # once -- (a) filtering table-region chars out before
            # extract_text() stops table cell text ALSO becoming a duplicate
            # paragraph block (previously page.extract_text() and
            # page.extract_tables() both read the same page unfiltered); (b)
            # each table's bbox top, merged by position against each
            # paragraph's own top (_paragraph_tops), gives tables a real
            # document-order slot instead of the previous (0,0) placeholder.
            # text_only skips this (pdfplumber's dominant per-page cost) --
            # see load_pdf's own docstring. found_tables/table_bboxes empty
            # means filtered_page falls back to the unfiltered page below,
            # same as a page with no tables at all.
            found_tables = [] if text_only else page.find_tables()
            table_bboxes = [t.bbox for t in found_tables]
            filtered_page = page.filter(lambda obj: not _inside_any_bbox(obj, table_bboxes)) if table_bboxes else page

            text = filtered_page.extract_text() or ""
            paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
            tops = _paragraph_tops(filtered_page, paragraphs)

            page_tables: list[Table] = []
            for found_table in found_tables:
                # Phase 4 (docs/superpowers/specs/2026-08-12-table-fidelity-design.md):
                # real structural (span/gap/colspan/rowspan) + heuristic
                # styling (bold/text_color/background_color/align/column_widths)
                # extraction -- see `_build_pdf_table_grid`'s own docstring
                # for the full mechanism. This replaces the old Phase-1
                # `TableCell(text=cell or "")` compat shim, which collapsed
                # pdfplumber's `None` (ambiguous between "spanned" and "a
                # genuine gap") to plain text and discarded the
                # bbox-presence signal that disambiguates them.
                #
                # Table-level fallback: `_build_pdf_table_grid` already
                # guards every individual FIELD's extraction (bold/color/
                # align/widths) against failure internally, but the
                # STRUCTURAL walk itself (`found_table.rows`/`.cells`/
                # `.extract()`) is real pdfplumber geometry that could, in
                # principle, misbehave on a pathological/degenerate table
                # this session's fixtures don't cover. Catching at this
                # outer level too means a structural failure degrades this
                # ONE table back to the old bare-cells shape (still a valid,
                # if unstyled, table) rather than aborting the whole
                # document -- the same "never fail the ingest" guarantee,
                # one layer up.
                try:
                    cells, column_widths = _build_pdf_table_grid(page, found_table)
                except Exception:  # noqa: BLE001 -- a structural extraction failure degrades to Phase-1-shaped bare cells, never aborts the document
                    cells = [[TableCell(text=cell or "") for cell in row] for row in found_table.extract()]
                    column_widths = None
                page_tables.append(
                    Table(
                        id=f"t{table_id}",
                        cells=cells,
                        column_widths=column_widths,
                        # "grid" is not a guess here: this call site always
                        # invokes `page.find_tables()` with default settings
                        # (no `table_settings` override), and pdfplumber's
                        # own `TableSettings` defaults BOTH
                        # `vertical_strategy` and `horizontal_strategy` to
                        # `"lines"` (confirmed by reading `table.py`'s
                        # `TableSettings` dataclass source) -- meaning a
                        # table is only ever found here in the first place
                        # because real horizontal AND vertical ruling-line
                        # edges exist for `edges_to_intersections` to build
                        # cells from. If this call site ever starts passing
                        # a non-default `table_settings` (e.g. the `"text"`
                        # strategy), this constant must be revisited -- it
                        # is tied to the CURRENT call, not a property of
                        # PDF tables in general.
                        border_style="grid",
                        # Unconditional on every table this loader produces
                        # -- see `Table.style_provenance`'s own docstring in
                        # model.py. Every field above (spans included) is
                        # geometric/heuristic inference, never explicit
                        # source markup, so the review UI must always be
                        # able to render an honest "(approx. styling)"
                        # qualifier for a PDF table, with no code path that
                        # accidentally leaves this `None`.
                        style_provenance="heuristic",
                        source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0, page=page_number),
                    )
                )
                table_id += 1

            # pdfplumber's own page.images gives each image region's bbox
            # (for real-position ordering, same as tables above) but not a
            # standalone-decodable image file; pypdf's page.images gives the
            # real decodable bytes describe_figure needs but no position.
            # Best-effort correspondence: pdfplumber and pypdf both walk a
            # page's images in the same underlying content-stream order, so
            # pairing them positionally is the same kind of documented
            # approximation as a table's synthetic offset slot below -- not
            # a guaranteed identity, but the best available without a much
            # heavier cross-reference by image XObject name. If the two
            # libraries disagree on image count for this page (rare --
            # inline vs. XObject images can be counted differently), every
            # pypdf image is still captured (matching pre-fix behavior of
            # never dropping an image), just without a real position for
            # any index past what pdfplumber reported.
            # text_only skips the pypdf image-enumeration pass too -- see
            # load_pdf's own docstring. An empty page_images list here
            # degrades to the exact same code path a page with zero images
            # already takes below.
            page_images: list[tuple[float, object]] = []
            if not text_only:
                pypdf_page = cached_pdf_reader(path).pages[page_number - 1]
                plumber_tops = [im["top"] for im in page.images]
                page_images = [
                    (plumber_tops[i] if i < len(plumber_tops) else 0.0, pypdf_image)
                    for i, pypdf_image in enumerate(pypdf_page.images)
                ]

            # Merge paragraphs, tables, and images into real document order
            # by top position, then walk that merged order assigning ONE
            # shared monotonically increasing offset counter across all
            # three -- same technique docx_loader.py's body-walk uses,
            # adapted for pdf's lack of a single ordered element stream:
            # paragraph offsets are real char-length spans (unchanged from
            # before); a table or image gets a single synthetic slot in the
            # same counter (neither has a natural text length here, same as
            # before -- only their ORDER relative to paragraphs is new, not
            # a real char span). Previously every image on a page was always
            # appended after ALL of that page's paragraphs/tables regardless
            # of its real position -- interleaving them here gives each
            # figure the same real-position treatment tables already got.
            merged = sorted(
                [("paragraph", top, paragraph) for top, paragraph in zip(tops, paragraphs)]
                + [("table", bbox[1], table) for bbox, table in zip(table_bboxes, page_tables)]
                + [("image", top, pypdf_image) for top, pypdf_image in page_images],
                key=lambda entry: entry[1],
            )
            offset = 0
            for kind, _top, item in merged:
                if kind == "paragraph":
                    start = offset
                    end = start + len(item)
                    offset = end + 1
                    blocks.append(
                        Block(
                            id=f"b{block_id}",
                            kind=BlockKind.PARAGRAPH,
                            text=item,
                            source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=page_number),
                        )
                    )
                    block_id += 1
                elif kind == "table":
                    start = offset
                    end = start + 1
                    offset = end
                    table = item
                    # Re-keys the SAME table (built above with a real bbox-
                    # ordered page but a placeholder source_ref) with its
                    # real document-order offset -- carries every field
                    # forward (not just plain text), so this stays a no-op
                    # for content/styling once Phase 4 adds real PDF style
                    # extraction to the table-building pass above.
                    tables.append(
                        Table(
                            id=table.id,
                            cells=table.cells,
                            column_widths=table.column_widths,
                            border_style=table.border_style,
                            style_provenance=table.style_provenance,
                            caption=table.caption,
                            source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=page_number),
                        )
                    )
                else:
                    start = offset
                    end = start + 1
                    offset = end
                    pypdf_image = item
                    caption = None
                    if describe_figure is not None:
                        try:
                            caption = describe_figure(pypdf_image.data)
                        except Exception:  # noqa: BLE001 -- a vision failure must not abort the whole document
                            caption = None
                    figures.append(
                        Figure(
                            id=f"f{figure_id}",
                            caption=caption,
                            source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=page_number),
                        )
                    )
                    blocks.append(
                        Block(
                            id=f"b{block_id}",
                            kind=BlockKind.FIGURE,
                            text=f"[FIGURE: {caption or 'none'}]",
                            source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=page_number),
                        )
                    )
                    block_id += 1
                    figure_id += 1

    return CanonicalDoc(document=document, blocks=blocks, tables=tables, figures=figures)
