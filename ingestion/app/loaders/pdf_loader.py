from __future__ import annotations

import hashlib
import logging
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Literal

import pdfplumber
import pytesseract
from pdf2image import convert_from_path
from PIL import Image, ImageStat
from pypdf import PdfReader
from pytesseract import Output

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef, Table, TableCell
from app.loaders.figure_utils import append_figure
from app.leveling.numbering import parse_numbering, numbering_depth

logger = logging.getLogger(__name__)

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

# pdfplumber's default snap_x_tolerance (3pt) treats every filled rect's own
# border as a candidate ruling line -- including a common PDF-authoring
# convention where a styled/shaded table cell is drawn as TWO NESTED filled
# rects (an outer cell rect + a decorative inset "rounded box" rect a few
# points inside it), which leaks the inner rect's edges in as spurious extra
# column/row boundaries. Confirmed empirically across 30+ real tables in 2
# unrelated real ICD PDFs: this decorative inset consistently measures
# 5.16-6.43pt. Raising snap_x_tolerance above that range snaps the
# decorative inner edges onto the real outer boundary and discards them as
# duplicates -- fixing ghost columns in shaded rows AND (confirmed,
# non-obvious) a header-row vertical mis-split this same pattern causes,
# since the mid-header spurious line loses the vertical edges it needs to
# close a cell against once the column edges snap away. Zero diff measured
# against this repo's own table fixtures, and no regression found across
# 30+ real tables sampled from 2 unrelated real ICD PDFs.
_DECORATIVE_RECT_SNAP_TOLERANCE = 5.5

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

# Added near the top of pdf_loader.py, alongside the other tuned-threshold
# constants (_ALIGNMENT_CENTER_BAND, _BACKGROUND_OVERLAP_THRESHOLD).
#
# Real, measured gap data (LVC Gateway ICD, an 11.04pt-body real government
# ICD): within-paragraph wrapped-line gaps are ~3.4-3.6pt; a paragraph or
# section break is 19pt+ or accompanied by a font-size change. 0.5x the
# line's own font size comfortably covers the observed within-paragraph
# band (5.5pt at 11pt) while rejecting every observed break (19pt+) with
# wide margin -- not derived from a formal study, a defensible threshold
# from real measurement, same convention as this file's other heuristic
# constants.
_PARAGRAPH_LINE_GAP_RATIO = 0.5

# Two lines' font sizes are "the same" within this many points -- guards
# against pdfplumber's own float sub-pixel noise (confirmed live: the same
# nominal 11.04pt size can come back as 11.039999999999964 vs
# 11.03999999999996 across different chars/lines of the same document).
_PARAGRAPH_LINE_SIZE_TOLERANCE = 0.1

# Real measured pattern (LVC Gateway ICD): a footer's literal text varies
# ONLY in an embedded page number ("2 | P a ge", "4 | P a ge", same
# template) -- exact-string matching alone misses every footer. Digits are
# normalized to a placeholder before the recurrence check.
_DIGIT_RUN_PATTERN = re.compile(r"\d+")

# A header/footer must recur on at least this fraction of pages to be
# suppressed -- verified real case (LVC Gateway ICD) recurs on 33/35
# (~94%); a fraction well below that (2/3, ~67%) still safely excludes a
# genuinely one-off repeated title appearing on just a couple of pages by
# coincidence, while catching the real running-header/footer case with
# comfortable margin.
_BOILERPLATE_RECURRENCE_FRACTION = 0.6

# A header/footer candidate must ALSO sit within this many points of its
# own page's respective edge to actually be suppressed -- pure digit-
# normalized text recurrence (above) cannot, on its own, distinguish a
# genuine running header/footer from unique body content that happens to
# differ only by an embedded page-correlated digit across pages (e.g. "Body
# content unique to page 3." digit-normalizes and recurs exactly like a
# real "3 | Page" footer would). A real header/footer is by definition
# positioned in the page's own margin; unique body content is not. 72pt (1
# inch) is the de facto standard PDF/document page margin -- reportlab's
# own SimpleDocTemplate (used throughout this file's own test fixtures)
# defaults to it -- not a value tuned to any single fixture.
_HEADER_FOOTER_MARGIN_POINTS = 72.0

# A heading candidate's line size must exceed the document's own dominant
# body-text size by at least this many points to be classified a heading
# -- guards against pdfplumber's float noise re-triggering on lines that
# are only trivially, insignificantly larger than body text.
_HEADING_SIZE_MARGIN = 0.5

# A heading candidate whose size exceeds the body size by more than this
# multiple is more likely a watermark/decorative element than a real
# heading -- real document headings in this design's sampled corpus never
# exceeded ~2.2x body size (24pt/11pt on the LVC Gateway ICD's title
# page); a watermark rendered to dominate a page visually often goes
# several times larger than that.
_HEADING_SIZE_MAX_RATIO = 3.0

# A font-size-outlier line must carry at least this many alphanumeric
# characters to be eligible for HEADING classification at all (a line whose
# own text parses as a real number label via parse_numbering is eligible
# regardless -- see `_can_be_heading_text`). LIVE-REPRODUCED bug this
# closes: a Word/LibreOffice-exported bulleted list renders each bullet as
# its own Symbol-font glyph, frequently at a different size than the body
# text it introduces, which pdfplumber clusters as its OWN line -- so a
# bare bullet glyph ("n" from Symbol, a literal "•", ...) became a
# size outlier, was classified HEADING, and consumed a real ordinal from
# `_advance_heading_counter` (observed: `heading lvl=1 lbl='1' :: n`
# between two halves of one bulleted requirement). Two characters is the
# floor because no real heading is a single letter/symbol, while every real
# short heading ("Scope", "1.2 Power") clears it easily.
_HEADING_MIN_ALNUM_CHARS = 2

# Phase 3b (Task 6): a caption line's own text must match this shape to be
# attached to the immediately-following table -- deliberately narrow
# (starts with "Table" + a number) rather than "any short line before a
# table," to avoid misattributing an unrelated short paragraph as a
# caption.
_TABLE_CAPTION_PATTERN = re.compile(r"^Table\s+[\w.]+[:.]?\s*(.*)$", re.IGNORECASE)

# Same shape as _TABLE_CAPTION_PATTERN, for figures -- but a figure's own
# caption line conventionally follows the image (below it), the opposite
# order from a table caption (which precedes its table). See the figure
# branch below for how this asymmetry is handled.
_FIGURE_CAPTION_PATTERN = re.compile(r"^Figure\s+[\w.]+[:.]?\s*(.*)$", re.IGNORECASE)

# A candidate caption line containing 4+ consecutive dots is a table-of-
# contents dot-leader entry ("Figure 12: Some Title ..............12"),
# not a real in-body caption -- confirmed live: cubeadcs_icd.pdf's TOC page
# alone contributes 41 lines matching _FIGURE_CAPTION_PATTERN's shape.
# Without this exclusion, a figure would get named from the WRONG page's
# TOC entry instead of its own real caption (or worse, a TOC entry with no
# nearby image at all would still just get IGNORED by the gap check, but a
# real figure sitting near a TOC-adjacent page could misfire).
_TOC_DOT_LEADER_PATTERN = re.compile(r"\.{4,}")

# Maximum vertical gap (in PDF points) between a figure's own bottom edge
# and a candidate caption line's top, for that line to be treated as this
# figure's name. Measured on cubeadcs_icd.pdf: real figure->caption gaps
# are consistently ~16pt (examples: 515.0->531.1, 342.5->358.9,
# 444.0->460.4, 620.2->636.4) -- 40pt is generous headroom without risking
# a match against the START of the next unrelated block.
_FIGURE_CAPTION_MAX_GAP_POINTS = 40.0


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


def ocr_image_to_text_filtered(
    image: Image.Image, languages: str = "eng", confidence_threshold: int = 30
) -> str:
    """Confidence-filtered OCR over an already-in-memory PIL image -- the
    shared body both app/loaders/ocr.py's ocr_page_to_text_filtered
    (whole-page: renders then delegates here) and _cell_ocr_recovery below
    (crops a rendered page then delegates here) use, so the confidence-
    filtering rule (drop any word below confidence_threshold on
    Tesseract's 0-100 scale; -1, a non-text region, always dropped) exists
    in exactly one place. Lives here rather than in ocr.py because ocr.py
    already imports load_pdf/page_has_extractable_text FROM this module --
    defining this helper in ocr.py and importing it back here (needed for
    _cell_ocr_recovery) would be a circular import.
    """
    data = pytesseract.image_to_data(image, lang=languages, output_type=Output.DICT)
    kept_words = [
        word
        for word, conf in zip(data["text"], data["conf"])
        if word.strip() and int(conf) >= confidence_threshold
    ]
    return " ".join(kept_words)


# Matches pdf2image.convert_from_path's own default DPI (200) -- not a new,
# independently-tuned value (confirmed: convert_from_path(dpi: int = 200) is
# the library's own default, and every existing call site in this codebase,
# including ocr.py's whole-page fallback, already relies on it implicitly by
# never passing a dpi kwarg). Needed as a concrete number here because
# converting a cell's bbox from PDF points to this rendered image's pixel
# coordinates requires it explicitly (pixels = points * dpi / 72).
_TABLE_OCR_RENDER_DPI = 200

# Points inset from each raw cell-bbox edge before computing the pre-check
# stddev (and before the OCR crop itself -- same crop, reused). Empirically
# required, not a stylistic choice: pdfplumber's own cell bbox extends to
# the ruled grid border line itself (confirmed directly against a real
# bordered table -- an intentionally BLANK cell's un-inset crop measured
# grayscale stddev ~50, extrema 0-255, purely from the border pixels sitting
# on the bbox edge, comfortably clearing any reasonable "blank" threshold;
# the same cell inset by this many points measured stddev 0.0, pure white).
# Without this inset, the pre-check below would misfire into a wasted (if
# still fail-open) OCR attempt on every genuinely blank cell in every
# bordered table. 2.0pt comfortably clears a typical ~1pt ruling line with
# margin, confirmed against both the blank-cell case above and a real
# recovered-text cell (see _BLANK_CELL_STDDEV_THRESHOLD).
_CELL_CROP_INSET_POINTS = 2.0

# A crop's grayscale (0-255 scale) standard deviation below this is treated
# as visually blank -- skip the real OCR call entirely. First-pass
# conservative default (a real blank cell measures 0.0 once inset past its
# border, per _CELL_CROP_INSET_POINTS's own comment; a real recovered-text
# header cell from this feature's motivating fixture measures ~13-46 in
# spot checks). Pure cost optimization, never a correctness dependency: a
# threshold too conservative here only costs one wasted OCR attempt on a
# truly blank cell, never a missed or wrong recovery (see
# docs/superpowers/specs/2026-08-16-pdf-table-header-ocr-recovery-design.md).
_BLANK_CELL_STDDEV_THRESHOLD = 5.0


def _cell_ocr_recovery(
    path: str,
    page_index: int,
    bbox: tuple[float, float, float, float],
    languages: str,
    page_image_cache: dict[int, Image.Image],
) -> str:
    """Attempts to recover text for one table grid position whose
    pdfplumber extraction came back empty, by rendering the page to pixels
    (cached in page_image_cache -- a dict the CALLER creates fresh per
    load_pdf call and owns; this function only reads/populates it. Pages
    are walked strictly in order and never revisited, so this function
    retains only the current page's render, clearing any prior entry
    before inserting -- its lifetime is exactly one load_pdf call, not
    global, and its retained size is exactly one rendered page, not every
    page seen so far -- see this function's own Interfaces note in the
    plan that introduced it)
    and OCR-ing just this cell's bbox crop, inset past the ruled border
    (see _CELL_CROP_INSET_POINTS). Returns "" (fail-open, never raises)
    both when the cheap pre-check judges the crop visually blank (no OCR
    call made at all) and when a real OCR call returns nothing after
    stripping -- a miss here must never turn into fabricated cell content
    or abort the document.
    """
    try:
        if page_index not in page_image_cache:
            rendered = convert_from_path(path, first_page=page_index + 1, last_page=page_index + 1)
            # load_pdf walks pages strictly in order and never revisits one, so
            # keeping only the current page preserves the one-render-per-page hit
            # rate without retaining every page's ~11 MB render for the whole call
            # (a large multi-page document would otherwise project to gigabytes).
            page_image_cache.clear()
            page_image_cache[page_index] = rendered[0]
        page_image = page_image_cache[page_index]

        scale = _TABLE_OCR_RENDER_DPI / 72
        x0, top, x1, bottom = bbox
        inset = _CELL_CROP_INSET_POINTS
        x0i, topi, x1i, bottomi = x0 + inset, top + inset, x1 - inset, bottom - inset
        if x1i <= x0i or bottomi <= topi:
            # Cell too small for the inset on at least one axis -- fall back to
            # the raw bbox rather than pass PIL an inverted crop box (which
            # raises). Rare in practice; the pre-check may over-trigger on a
            # tiny cell's own border pixels in this fallback, which only costs
            # one wasted OCR attempt (see _BLANK_CELL_STDDEV_THRESHOLD).
            x0i, topi, x1i, bottomi = x0, top, x1, bottom

        crop = page_image.crop((x0i * scale, topi * scale, x1i * scale, bottomi * scale))
        if ImageStat.Stat(crop.convert("L")).stddev[0] < _BLANK_CELL_STDDEV_THRESHOLD:
            return ""

        return ocr_image_to_text_filtered(crop, languages=languages).strip()
    except Exception:  # noqa: BLE001 -- fail-open: an OCR miss must never degrade the table it lives in
        return ""


def _build_pdf_table_grid(
    page, found_table, path: str, page_index: int, languages: str, page_image_cache: dict[int, Image.Image]
) -> tuple[list[list[TableCell | None]], list[float] | None, list[float]]:
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

    `path`/`page_index`/`languages`/`page_image_cache` exist solely to
    support table-cell OCR recovery (_cell_ocr_recovery) for a grid
    position whose extracted text comes back empty -- see that function's
    own docstring. This never changes this function's return SHAPE (still
    the same 3-tuple as before this parameter existed); a recovered cell's
    text simply lands in the same TableCell.text field a real pdfplumber
    extraction would have, with TableCell.ocr_recovered=True marking it as
    such.
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

            ocr_recovered = False
            if not text.strip():
                recovered_text = _cell_ocr_recovery(path, page_index, bbox, languages, page_image_cache)
                if recovered_text:
                    text = recovered_text
                    ocr_recovered = True

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
                    ocr_recovered=ocr_recovered,
                )
            )
        grid.append(row_out)

    column_widths = _pdf_column_widths(found_table, xs)
    # `xs` (the column x-edges just used for colspan/width derivation) is
    # ALSO returned here -- Task 5's cross-page continuation merge needs it
    # per-table to check column-x-edge alignment across a page break (see
    # `_tables_continue`), and `Table`/`TableCell` (the canonical model)
    # doesn't itself retain this raw geometry, so the caller must carry it
    # forward via a side dict rather than recovering it after the fact.
    return grid, column_widths, xs


# A table's bottom/top edge must fall within this fraction of the page
# height from the respective page edge to be a continuation candidate --
# a table that ends/starts well away from a page boundary is unlikely to
# be a real continuation regardless of column alignment.
_TABLE_CONTINUATION_EDGE_BAND_FRACTION = 0.15

# Column x-edges must align within this many points to be considered the
# "same" columns across a page break -- pdfplumber's own geometry can
# differ by a point or two between pages due to sub-pixel rendering, same
# tolerance class as this file's other geometric comparisons.
_TABLE_CONTINUATION_X_TOLERANCE = 2.0


def _tables_continue(
    prev_table_xs: list[float], prev_bottom: float, prev_page_height: float,
    next_table_xs: list[float], next_top: float,
) -> bool:
    """True when a table ending near the bottom of one page and a table
    starting near the top of the next page are plausibly the SAME table,
    continued -- requires both a positional signal (near the respective
    page edge) AND a structural signal (aligned column x-edges), not
    column COUNT alone (verified: two unrelated same-column-count tables
    on consecutive pages would otherwise merge incorrectly)."""
    near_bottom = prev_bottom >= prev_page_height * (1 - _TABLE_CONTINUATION_EDGE_BAND_FRACTION)
    near_top = next_top <= prev_page_height * _TABLE_CONTINUATION_EDGE_BAND_FRACTION
    if not (near_bottom and near_top):
        return False
    # An empty xs list (e.g. `_build_pdf_table_grid` hit its outer
    # exception fallback for that table, which sets xs=[] -- see its call
    # site) carries NO structural signal at all. Without this guard,
    # `len([]) == len([])` is True and `all(...)` over an empty `zip` is
    # vacuously True, so two unrelated degraded-extraction tables would
    # pass the structural gate on positional signal alone -- exactly the
    # weaker "column count only" rule this function's own docstring
    # rejects. Reject explicitly rather than let an absent signal count as
    # a match.
    if not prev_table_xs or not next_table_xs:
        return False
    if len(prev_table_xs) != len(next_table_xs):
        return False
    return all(abs(a - b) <= _TABLE_CONTINUATION_X_TOLERANCE for a, b in zip(prev_table_xs, next_table_xs))


def _merge_continued_tables(
    tables: list[Table], table_xs_by_id: dict[str, list[float]],
    table_bbox_by_id: dict[str, tuple[float, float, float, float]], page_height: float,
) -> list[Table]:
    """Post-pass merging cross-page table continuations -- must run AFTER
    every table on every page has been built (needs real page numbers to
    know which tables are on ADJACENT pages at all). Merges row-wise: the
    continuation's cells become additional rows appended to the prior
    table; the continuation's own Table entry is dropped from the result.
    Only ever merges a table into the ONE immediately preceding it in
    document order -- a three-page continuation chains through two
    successive merges, not a single three-way merge, which keeps this
    function's own logic to a single pairwise rule applied repeatedly.

    `tail_page`/`table_bbox_by_id`/`table_xs_by_id` are updated to the just-
    absorbed continuation's own page/bbox/xs after every merge -- `Table.
    model_copy` does NOT touch `source_ref` (the merged table keeps the
    FIRST page's own `source_ref.page` forever), so a 3+ page continuation
    that re-read `prev.source_ref.page` directly would only ever match
    `page N + 1` once and silently stop chaining on page N+2. Tracking the
    accumulating group's own tail separately (keyed by the stable merged-
    table id, which `model_copy` also never changes) is what lets each
    successive pairwise merge see the REAL immediately-preceding page.
    """
    if len(tables) < 2:
        return tables
    merged: list[Table] = [tables[0]]
    tail_page: dict[str, int | None] = {t.id: t.source_ref.page for t in tables}
    for table in tables[1:]:
        prev = merged[-1]
        prev_page = tail_page.get(prev.id)
        this_page = table.source_ref.page
        prev_bottom = table_bbox_by_id.get(prev.id, (0, 0, 0, 0))[3]
        this_top = table_bbox_by_id.get(table.id, (0, 0, 0, 0))[1]
        if (
            prev_page is not None and this_page is not None and this_page == prev_page + 1
            and _tables_continue(table_xs_by_id.get(prev.id, []), prev_bottom, page_height, table_xs_by_id.get(table.id, []), this_top)
        ):
            # The continuation's own first row sits mid-table after the
            # merge -- `_build_pdf_table_grid` stamped it `is_header=True`
            # purely because it was row 0 of ITS OWN (single-page) table,
            # which is no longer true once it's appended here. Only the
            # very first table's real header row should ever carry
            # `is_header=True`.
            continuation_cells = [
                [cell.model_copy(update={"is_header": False}) if cell is not None else None for cell in row]
                for row in table.cells
            ]
            merged[-1] = prev.model_copy(update={"cells": prev.cells + continuation_cells})
            tail_page[prev.id] = this_page
            table_bbox_by_id[prev.id] = table_bbox_by_id.get(table.id, table_bbox_by_id.get(prev.id, (0, 0, 0, 0)))
            table_xs_by_id[prev.id] = table_xs_by_id.get(table.id, table_xs_by_id.get(prev.id, []))
        else:
            merged.append(table)
    return merged


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


def _bboxes_overlap(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    """Standard axis-aligned bbox overlap test (ANY intersection at all --
    partial or full), as opposed to `_inside_any_bbox`'s FULL-containment
    test above. Fix-round addition (Task 7 review): the text-strategy
    double-detection guard originally reused `_inside_any_bbox` (built for
    a genuinely different purpose -- "is this LINE fully inside a table's
    bbox," used to strip table-region lines out of paragraph text), which
    only rejects a text-strategy candidate when it's fully CONTAINED inside
    one lines-strategy table's bbox. LIVE-REPRODUCED failure this confirmed:
    a page with two separate ruled tables at aligned column x-positions
    (routine in real ICDs -- e.g. two similarly-shaped spec tables stacked
    with a gap) produces a text-strategy candidate spanning BOTH real
    tables' combined bbox -- not fully contained in EITHER individual
    lines-strategy bbox, so it passed the old check and was added as a
    third, bogus, duplicate-content table. Any real overlap at all (not
    just containment) with an already-found lines-strategy table is reason
    enough to reject a text-strategy candidate outright -- the conservative
    direction: a candidate that merely straddles a ruled table is dropped
    entirely rather than risking a duplicate."""
    ax0, atop, ax1, abottom = a
    bx0, btop, bx1, bbottom = b
    return ax0 < bx1 and bx0 < ax1 and atop < bbottom and btop < abottom


def _is_chopped_word_boundary(prev_text: str, cur_text: str) -> bool:
    """True if concatenating prev_text+cur_text with no separator falls
    mid-word -- a strong, checkable signal that a 'column boundary' is
    actually just where a text-strategy false-positive happened to split
    a real word, not a genuine table column edge. VERIFIED live against a
    real false positive (lvc_gateway_icd.pdf's page-8 prose-as-table,
    cells like 'F' / 'or some tests...') and a real table (this file's
    own sample.pdf fixture): 37.5% of the false positive's rows trip this
    rule, 0% of the real table's rows do -- no tuning needed, the
    separation is clean."""
    prev_stripped = prev_text.rstrip()
    cur_stripped = cur_text.lstrip()
    if not prev_stripped or not cur_stripped:
        return False
    return prev_stripped[-1].isalnum() and cur_stripped[0].islower()


def _table_has_chopped_word(rows: list[list[str]]) -> bool:
    """True if ANY row has a chopped-word boundary between adjacent
    cells -- one confirmed instance is enough to reject the whole
    candidate table (a real table never trips this at all; the false
    positive trips it on over a third of its rows, so a single hit is
    already a strong, not a borderline, signal)."""
    for row in rows:
        for i in range(1, len(row)):
            if _is_chopped_word_boundary(row[i - 1] or "", row[i] or ""):
                return True
    return False


def _line_size(line: dict) -> float:
    """A line's representative font size -- the MODAL (most common)
    non-whitespace char size on that line.

    Deliberately NOT "the first non-whitespace char's size" (the original
    convention here): a line's true size must not be decided by whichever
    glyph happens to render first. Confirmed live on real
    Word/LibreOffice-exported PDFs, where the first glyph is routinely NOT
    representative -- a Symbol-font bullet at a different size than the
    body text it introduces, a drop-cap set a point or two larger than the
    rest of its own line, a leading superscript footnote marker. Under the
    first-char rule each of those made its whole line a font-size outlier,
    and Task 3's heading classification then promoted it to a HEADING with
    a fabricated ordinal (consuming a number a real heading should have
    got). The mode is the correct summary here for the same reason
    `_dominant_body_size` already uses one document-wide: the size the most
    characters actually share IS the line's size.

    Ties are broken toward the SMALLER size, same rationale (and same
    safe direction) as `_dominant_body_size`'s own tie-break: a smaller
    representative size can only ever fail the "is an outlier" heading
    test, never wrongly pass it.

    A line with no chars at all (shouldn't happen for a real
    extract_text_lines() result, but degrade rather than raise) returns
    0.0 -- a heading/body comparison against 0.0 always fails the "is an
    outlier" test, which is the safe direction (falls through to
    PARAGRAPH, never wrongly promoted)."""
    from collections import Counter

    counts = Counter(ch["size"] for ch in line.get("chars", []) if (ch.get("text") or "").strip())
    if not counts:
        return 0.0
    max_count = max(counts.values())
    return min(size for size, count in counts.items() if count == max_count)


def _line_is_bold(line: dict) -> bool:
    """First non-whitespace char wins -- unlike `_line_size` (which moved to
    a modal/most-common convention, see its own docstring for why), this
    function was never given the equivalent fix. Currently harmless: its
    result is computed but not read by any caller today. Reusing this
    file's existing `_fontname_is_bold`."""
    for ch in line.get("chars", []):
        if (ch.get("text") or "").strip():
            return _fontname_is_bold(ch.get("fontname"))
    return False


def _can_be_heading_text(text: str) -> bool:
    """Content gate on the font-size heading path: a size-outlier line must
    have real textual substance before it can be called a heading. Either
    its own text parses as a real number label (`parse_numbering` -- a
    genuinely numbered heading is a heading whatever its length), or it
    carries at least `_HEADING_MIN_ALNUM_CHARS` alphanumeric characters.
    Punctuation/symbol-only lines (a bullet glyph, a rule of dashes, a
    stray dingbat) therefore never qualify -- see
    `_HEADING_MIN_ALNUM_CHARS`'s own comment for the live-reproduced
    bulleted-list bug this exists for. Applies ONLY to the font-size tier;
    a real outline/bookmark entry (tier 0) is authoritative and is not
    second-guessed here."""
    if parse_numbering(text)[0] is not None:
        return True
    return sum(1 for ch in text if ch.isalnum()) >= _HEADING_MIN_ALNUM_CHARS


def _dominant_body_size(all_pages_lines: list[list[dict]]) -> float:
    """Mode of every line's own font size across the WHOLE document --
    body text dominates by sheer line count in any real document (verified
    live: 6041 tokens at 10.0pt vs 41 at 12.0pt/25 at 14.0pt on a real
    82-page ICD), so the single most common line-size IS the body size,
    no separate body-vs-heading classifier needed. Document-level, not
    per-page -- a page that's mostly a table or figure would otherwise
    skew a per-page-only histogram; body text is consistent across a real
    document's OWN pages (confirmed: 11.04pt/10.0pt each held steady
    across dozens of sampled pages in this design's research)."""
    from collections import Counter

    sizes = [_line_size(line) for lines in all_pages_lines for line in lines if line.get("chars")]
    if not sizes:
        return 0.0
    counts = Counter(sizes)
    # Tie-break toward the SMALLER size when two+ sizes share the max count
    # -- `Counter.most_common` alone breaks ties by first-insertion order,
    # which on a real document never matters (body text dominates by sheer
    # count, per this function's own docstring), but on a small/minimal
    # document a heading line and a body line can tie 1-for-1, and the
    # heading -- drawn/positioned first on the page -- would otherwise win
    # the tie and become "body_size" itself, silently defeating the entire
    # outlier check. Body text is, by this whole feature's own layered-
    # signal design, the SMALLER of the two, so the smaller candidate is
    # the correct tie-break in either case.
    max_count = max(counts.values())
    return min(size for size, count in counts.items() if count == max_count)


def _heading_level_from_size_rank(size: float, body_size: float, size_ranks: dict[float, int]) -> int:
    """Font-size-cluster rank as the heading DEPTH fallback -- used only
    when a heading candidate's own text has no parseable number (see the
    layered-signal design: font size decides IF a line is a heading;
    parse_numbering decides WHAT depth when it parses; this function is
    the depth fallback when it doesn't). `size_ranks` maps every distinct
    heading-candidate size seen so far to a 1-based depth rank, LARGEST
    size = rank 1 (shallowest) -- built incrementally as new sizes are
    encountered, so a document's actual heading sizes (whatever they are)
    define their own depth ordering rather than assuming a fixed set of
    sizes up front.

    Confirmed real bug, fixed here: a new size's rank was previously
    computed only from sizes ALREADY seen (`1 + count of already-ranked
    sizes larger than it`), never revisiting an EXISTING size's own rank
    once a genuinely larger size arrived later in document order. A
    smaller heading size encountered BEFORE a larger one (e.g. a level-3
    heading's size seen on page 1, its document's real level-1 size not
    seen until page 4) kept its earlier, now-wrong rank -- both sizes
    collided onto rank 1, silently merging two real, distinct heading
    tiers into one. Every EXISTING size smaller than a newly-seen size
    must have its own rank pushed one level deeper first, so the final
    ranking always matches sorted size order (largest = rank 1) regardless
    of the order sizes were first encountered in."""
    if size not in size_ranks:
        for other_size, other_rank in size_ranks.items():
            if other_size < size:
                size_ranks[other_size] = other_rank + 1
        # This new size's own rank is 1 + however many EXISTING sizes are
        # still larger than it -- computed AFTER the bump above, but that
        # bump only ever touches sizes smaller than this one, so it can
        # never change this count.
        deeper_than = sum(1 for s in size_ranks if s > size)
        size_ranks[size] = deeper_than + 1
    return size_ranks[size]


def _advance_heading_counter(heading_counters: list[int], heading_level: int, existing_label: str | None) -> str | None:
    """Same validated algorithm as docx_loader.py's heading-number
    synthesis (commit history: fc16a9e, 6c07360) -- reimplemented here
    per this task's own non-goal (no shared-module refactor of
    docx_loader.py). Always extends/truncates `heading_counters` for
    EVERY heading regardless of self-numbering (the mixed-numbering fix);
    adopts an already-numbered heading's own label into the counter state
    when it parses AND its depth matches `heading_level`, so later
    unnumbered siblings continue from the real numbers rather than
    colliding with them. Mutates `heading_counters` in place. Returns the
    synthesized label, or None when the heading is self-numbered (its own
    text already carries the number -- text is left as-is, matching
    docx's own convention of never stripping an existing number out of
    a heading's text into a separate field)."""
    while len(heading_counters) < heading_level:
        heading_counters.append(0)
    del heading_counters[heading_level:]
    if existing_label is not None:
        parts = existing_label.split(".")
        if len(parts) == heading_level and all(p.isdigit() for p in parts):
            heading_counters[:] = [int(p) for p in parts]
        return None
    heading_counters[heading_level - 1] += 1
    return ".".join(str(n) for n in heading_counters)


def _outline_heading_positions(path: str) -> dict[tuple[int, str], int]:
    """(page_number, title) -> outline depth (1-based), for every REAL
    outline/bookmark entry in the document -- confirmed real API:
    pypdf.PdfReader.outline is a nested list of Destination objects
    (Destination.title/.page/.top/.left), deeper nesting = deeper list.
    `PdfReader.get_page_number` resolves a real 0-based page index, but
    (CONFIRMED empirically -- a live add_outline_item()-built PDF read
    back and inspected directly, not assumed from the docstring alone)
    it takes a `PageObject`, not a `Destination` -- passing the
    `Destination` itself silently resolves to `None` (caught below same
    as any other malformed entry, so it degrades safely, but every entry
    would otherwise be silently dropped). `Destination.page` is the
    already-resolved `PageObject` a `Destination` carries, and that IS
    what `get_page_number` expects. Degrades to an empty dict (never
    raises) on ANY failure -- a malformed/absent outline must fall
    through to font-size/numbering classification, never abort the load
    or mis-anchor a heading."""
    positions: dict[tuple[int, str], int] = {}

    def _walk(items, depth: int, reader) -> None:
        for item in items:
            if isinstance(item, list):
                _walk(item, depth + 1, reader)
                continue
            try:
                page_number = reader.get_page_number(item.page) + 1
                positions[(page_number, item.title)] = depth
            except Exception:  # noqa: BLE001 -- one malformed entry must not lose the rest of the outline
                continue

    try:
        reader = cached_pdf_reader(path)
        _walk(reader.outline, 1, reader)
    except Exception:  # noqa: BLE001 -- an absent/malformed outline degrades to "no tier-0 signal", never raises
        return {}
    return positions


def _lines_to_paragraphs(lines: list[dict]) -> list[tuple[str, float, float, bool]]:
    """Merges pdfplumber's per-LINE extract_text_lines() output back into
    real paragraphs -- replaces the old, dead `text.split("\\n\\n")` (see
    this module's own load_pdf docstring for why that never actually
    split anything: extract_text() never emits a blank line, so every page
    became exactly one PARAGRAPH block). Adjacent lines merge into ONE
    paragraph when their font size matches (within
    _PARAGRAPH_LINE_SIZE_TOLERANCE) and the vertical gap between them is
    small relative to that size (_PARAGRAPH_LINE_GAP_RATIO) -- see this
    file's own constants for the real measured data behind these
    thresholds. Returns (paragraph_text, top, size, is_bold) tuples --
    `top`/`size`/`is_bold` are the FIRST line's own values (a merged
    multi-line paragraph is, by the merge rule itself, uniform in size --
    see _PARAGRAPH_LINE_SIZE_TOLERANCE -- so the first line's size IS the
    paragraph's size), for the same real-document-order merge load_pdf's
    main loop already does for tables/images, plus the font-size/boldness
    signal Task 3's heading classification needs."""
    if not lines:
        return []
    paragraphs: list[tuple[str, float, float, bool]] = []
    current_texts = [lines[0]["text"]]
    current_top = lines[0]["top"]
    current_size = _line_size(lines[0])
    current_bold = _line_is_bold(lines[0])
    prev_bottom = lines[0]["bottom"]
    prev_size = current_size
    for line in lines[1:]:
        size = _line_size(line)
        gap = line["top"] - prev_bottom
        same_size = abs(size - prev_size) <= _PARAGRAPH_LINE_SIZE_TOLERANCE
        small_gap = gap <= max(size, prev_size) * _PARAGRAPH_LINE_GAP_RATIO
        if same_size and small_gap:
            current_texts.append(line["text"])
        else:
            paragraphs.append((" ".join(current_texts), current_top, current_size, current_bold))
            current_texts = [line["text"]]
            current_top = line["top"]
            current_size = size
            current_bold = _line_is_bold(line)
        prev_bottom = line["bottom"]
        prev_size = size
    paragraphs.append((" ".join(current_texts), current_top, current_size, current_bold))
    return paragraphs


# Phase 5 (Task 9): flag-only multi-column detection. Real-document
# research this design ran found ZERO of 9 sampled documents genuinely
# multi-column, and a false-positive SPLIT (interleaving unrelated content
# into one block) is worse than today's plain reading-order garbling on a
# rare real multi-column page -- so this deliberately never splits, only
# flags. A candidate column gap must span at least this fraction of the
# page's own text height (top of the first line to the bottom of the last)
# to be considered a real column boundary, not an isolated coincidental gap
# on one or two lines (a title page's label/value layout, or a wide table
# column, both confirmed as real false candidates during this design's
# research).
_COLUMN_GAP_MIN_HEIGHT_FRACTION = 0.5

# The gap band itself must be at least this many points wide -- guards
# against a normal word-spacing gap being mistaken for a column gutter.
_COLUMN_GAP_MIN_WIDTH = 30.0


def _line_segments(line: dict) -> list[dict]:
    """Splits ONE `extract_text_lines()` line record into contiguous
    horizontal character runs, broken wherever the gap between two
    adjacent characters is itself >= _COLUMN_GAP_MIN_WIDTH.

    CONFIRMED empirically this session: pdfplumber's `extract_text_lines()`
    clusters purely by vertical (`top`) position -- it merges ALL same-row
    text into ONE line record regardless of horizontal separation, so a
    real two-column layout with both columns' text landing on the same row
    (the common case -- most real multi-column documents use a consistent
    line-height grid across columns) produces a SINGLE line dict whose own
    x0/x1 spans the ENTIRE row, left column through right column. That
    line-level x0/x1 span is therefore useless on its own as a "does any
    word cross this candidate gap" signal -- it would cross every
    candidate gap between the two columns, and `_detect_suspected_column_gap`
    would never find a qualifying gap on any such page. Each line's own
    per-CHARACTER positions (`chars`, present because `extract_text_lines()`
    is always called with its default `return_chars=True`) are the finest-
    grained real signal available, so every line is re-split into same-row
    runs from them before the gap search runs. A run boundary is exactly a
    real horizontal gap wide enough to itself qualify as a candidate column
    gap -- reuses `_COLUMN_GAP_MIN_WIDTH` rather than a second,
    independently-tuned threshold. A line with no chars (shouldn't happen
    for a real extract_text_lines() result, but degrade rather than raise)
    is returned as a single one-item list unchanged."""
    chars = sorted((line.get("chars") or []), key=lambda ch: ch["x0"])
    if not chars:
        return [line]
    segments: list[dict] = []
    run = [chars[0]]
    for ch in chars[1:]:
        if ch["x0"] - max(c["x1"] for c in run) >= _COLUMN_GAP_MIN_WIDTH:
            segments.append(
                {"x0": min(c["x0"] for c in run), "x1": max(c["x1"] for c in run), "top": line["top"], "bottom": line["bottom"]}
            )
            run = [ch]
        else:
            run.append(ch)
    segments.append(
        {"x0": min(c["x0"] for c in run), "x1": max(c["x1"] for c in run), "top": line["top"], "bottom": line["bottom"]}
    )
    return segments


def _detect_suspected_column_gap(
    lines: list[dict], page_width: float, table_bboxes: list[tuple[float, float, float, float]],
) -> tuple[float, float] | None:
    """Flags (never splits) a page as SUSPECTED multi-column: a vertical
    band with NO word crossing it, spanning at least
    _COLUMN_GAP_MIN_HEIGHT_FRACTION of the page's own text height, at
    least _COLUMN_GAP_MIN_WIDTH points wide, that does not fall inside any
    table's own bbox (a table's internal column gaps must never trigger
    this -- a table is not a multi-column PAGE layout). Returns None (no
    action, no marker) when no such band exists, which is the ordinary
    case for the overwhelming majority of real single-column documents
    (confirmed: 0 of 9 real sampled documents in this design's own
    research were genuinely multi-column).

    `lines` is re-split into per-row character runs via `_line_segments`
    before anything else -- see that function's own docstring for why the
    raw `extract_text_lines()` records themselves cannot be used directly
    for the "no word crosses this gap" check below.

    Known trade-off (independent per-side height check, see the "Height
    coverage" comment inline below for why this replaced the brief's
    original combined-span check): a genuinely 2-column page where one
    column is a small minority of the page's content -- LIVE-VERIFIED
    break-even on a real 6-row-equivalent page: the minority side drops
    below being flagged once it falls under ~46% of the page's own text
    height (e.g. 3 short rows on one side against 6 on the other) -- will
    NOT be flagged. This is an accepted, deliberate cost of fixing the
    real false positive on `tests/test_pdf_survey_golden.py`'s golden
    fixture (see that comment); reverting to a combined-span check would
    re-widen detection but silently re-break that golden test. See
    `test_load_pdf_does_not_flag_an_asymmetric_two_column_page` for the
    pinned boundary.

    Known limitation inherited from this task's own design (not introduced
    by either deviation above, not fixed here -- a real fix needs a
    minimum-distinct-rows-per-side requirement, out of this task's minimal-
    diff scope): a realistic MULTI-ROW title-page label/value cover page
    (e.g. "Prepared for: / Prepared by: / Date: / Revision: / Classification:"
    label column, 5 rows, each row's value at a slightly IRREGULAR x
    position so the page's own pre-existing text-strategy table detector
    does NOT absorb it into a `Table` first -- LIVE-REPRODUCED: values at
    the SAME x across rows get rescued as a table candidate and never reach
    this function at all, but values at irregular per-row x positions do
    not) DOES produce a genuine false-positive flag here, unlike the single-
    row label/value case `test_load_pdf_does_not_flag_a_title_page_label_value_layout`
    covers (which is saved by the crossing check, not the height check, once
    a body paragraph line is present -- a multi-row cover page with no such
    crossing body line has nothing to save it)."""
    if not lines:
        return None
    lines = [segment for line in lines for segment in _line_segments(line)]
    if not lines:
        return None
    text_top = min(line["top"] for line in lines)
    text_bottom = max(line["bottom"] for line in lines)
    text_height = text_bottom - text_top
    if text_height <= 0:
        return None

    # Candidate gap boundaries: every line's own x0/x1 are potential gap
    # edges (a real column gutter's edges are defined by where TEXT stops
    # and starts, not an arbitrary grid).
    xs = sorted({line["x0"] for line in lines} | {line["x1"] for line in lines})
    for i in range(len(xs) - 1):
        gap_start, gap_end = xs[i], xs[i + 1]
        gap_width = gap_end - gap_start
        if gap_width < _COLUMN_GAP_MIN_WIDTH:
            continue
        # Any table overlapping this x-range invalidates it as a page-level
        # column gap -- it's the table's own internal structure instead.
        if any(bbox[0] < gap_end and gap_start < bbox[2] for bbox in table_bboxes):
            continue
        crossing_lines = [line for line in lines if line["x0"] < gap_end and gap_start < line["x1"]]
        if crossing_lines:
            continue
        # Height coverage: EACH side of the gap must, ON ITS OWN, have real
        # column content spanning most of the page's own text height -- not
        # just the two sides' COMBINED span. LIVE-REPRODUCED false positive
        # this guards against (tests/test_pdf_survey_golden.py's own golden
        # fixture): a suppressed-boilerplate header line (top-left), a
        # single CENTERED heading (positioned well to the right by its own
        # style, not a second column), and one left-aligned body line below
        # it -- the header+body pair alone already spans the page's full
        # text height on the LEFT, and the lone centered heading sits to
        # its right, so the OLD "combined flanking span" check (any lines on
        # either side, measured together) saw full height coverage even
        # though the right "side" was really just one unrelated heading, not
        # a second running column. Requiring the left-of-gap lines AND the
        # right-of-gap lines to EACH independently cover
        # _COLUMN_GAP_MIN_HEIGHT_FRACTION rejects that (the lone heading's
        # own height is far short of the page's text height) while still
        # accepting a real two-column page, where both columns independently
        # run the full height.
        left_lines = [line for line in lines if line["x1"] <= gap_start]
        right_lines = [line for line in lines if line["x0"] >= gap_end]
        if not left_lines or not right_lines:
            continue

        def _side_spans_min_height(side_lines: list[dict]) -> bool:
            side_top = min(line["top"] for line in side_lines)
            side_bottom = max(line["bottom"] for line in side_lines)
            return (side_bottom - side_top) >= text_height * _COLUMN_GAP_MIN_HEIGHT_FRACTION

        if _side_spans_min_height(left_lines) and _side_spans_min_height(right_lines):
            return (gap_start, gap_end)
    return None


def _normalize_digits(text: str) -> str:
    return _DIGIT_RUN_PATTERN.sub("#", text)


def _detect_boilerplate_templates(pages_first_lines: list[str], pages_last_lines: list[str]) -> tuple[set[str], set[str]]:
    """Returns (header_templates, footer_templates) -- the set of
    digit-normalized line templates that recur on at least
    _BOILERPLATE_RECURRENCE_FRACTION of pages, checked separately for the
    FIRST line (header candidate) and LAST line (footer candidate) of
    each page. Empty strings (a page with no lines at all) are never
    counted as boilerplate.

    `count >= 2` is a required guard, not just the fraction threshold: with
    a single-page document, `threshold = 1 * _BOILERPLATE_RECURRENCE_FRACTION`
    is < 1, so a line that appears exactly once (trivially true for every
    single-page doc) would satisfy `count >= threshold` on its own --
    "recurs across pages" is meaningless with only one page to recur across.
    Requiring at least 2 real occurrences before the fraction is even
    considered closes that gap without changing behavior for any document
    that actually has multiple pages (a real recurring header/footer's count
    is always far above 2 in practice -- see _BOILERPLATE_RECURRENCE_FRACTION's
    own docstring for the measured 33/35-page real case)."""
    from collections import Counter

    def _templates(lines: list[str]) -> set[str]:
        normalized = [_normalize_digits(t) for t in lines if t]
        if not normalized:
            return set()
        counts = Counter(normalized)
        threshold = len(lines) * _BOILERPLATE_RECURRENCE_FRACTION
        return {template for template, count in counts.items() if count >= 2 and count >= threshold}

    return _templates(pages_first_lines), _templates(pages_last_lines)


def _detect_boilerplate_images(
    all_pages_images: list[list[tuple[dict, object]]],
) -> set[str]:
    """Image analogue of `_detect_boilerplate_templates`: returns the set of
    byte-hashes identifying an image that recurs on at least
    `_BOILERPLATE_RECURRENCE_FRACTION` of pages -- same recurrence
    discipline used for header/footer TEXT lines, applied to images
    instead. `count >= 2` is a required guard for the same reason
    documented on `_detect_boilerplate_templates`.

    Keyed on content hash ALONE -- deliberately not on placement position.
    Recurrence is a property of the IMAGE (the same bytes keep appearing);
    position is a property of each individual PLACEMENT, and that is
    already checked independently at the suppression call site via
    `_HEADER_FOOTER_MARGIN_POINTS`. Confirmed live (cubeadcs_icd.pdf, 53
    pages): a single running-header logo is drawn at three slightly
    different (x0, top) coordinates across pages (40/12/1 placements) --
    keying on position as well as hash split one recurring image into
    three key-groups, so only the largest cleared the recurrence
    threshold and the other two survived as if they were 13 separate
    figures. Hash-only keying reunites all placements of one image under
    one key, however many positions it is drawn at.

    Deliberately does NOT check `_HEADER_FOOTER_MARGIN_POINTS` here -- that
    gate is applied separately at the suppression call site, mirroring how
    the margin check for text boilerplate is independent of the recurrence
    check above (see the load loop's own header/footer suppression, which
    checks the margin position AND template membership as two separate
    conditions). A real figure that happens to repeat a few times but sits
    in the page body must survive; only a recurring image ANCHORED in the
    margin is a running header/footer artifact.

    Confirmed live (cubeadcs_icd.pdf, 53 pages): 3 distinct byte-identical
    image classes recur across many pages, all placed in the margin band --
    a running page marker/doc-id stamp rendered as a raster image, the same
    class of artifact `_detect_boilerplate_templates` already handles for
    text."""
    from collections import Counter

    page_count = len(all_pages_images)
    keys_per_page: list[set[str]] = []
    for page_images in all_pages_images:
        page_keys: set[str] = set()
        for _bbox, pypdf_image in page_images:
            try:
                image_hash = hashlib.sha256(pypdf_image.data).hexdigest()
            except Exception:  # noqa: BLE001 -- an undecodable image is simply never a boilerplate candidate
                continue
            page_keys.add(image_hash)
        keys_per_page.append(page_keys)
    counts = Counter(key for page_keys in keys_per_page for key in page_keys)
    threshold = page_count * _BOILERPLATE_RECURRENCE_FRACTION
    return {key for key, count in counts.items() if count >= 2 and count >= threshold}


# A real content figure in this tool's fixtures/documents is never smaller
# than ~50px in either dimension (a small badge/icon at worst); the existing
# test fixture pdf_with_figure.pdf's own figure is 10x10, so 8 leaves it a
# 2px margin. Confirmed live: on a real 918-figure ICD (cubeadcs_icd.pdf),
# 808 of the 918 (88%) were EXACTLY 2x2 pixels -- not real figures at all,
# but PDF rendering-trick color-fill/gradient-mask XObjects (pypdf's own
# "image and mask size not matching" warning fires on every one). A 2x2
# pixel image cannot encode any distinguishable visual content -- it is
# mathematically indistinguishable from a solid color swatch -- so asking
# the vision-significance model to judge one is both wasted cost (a real
# API round-trip per instance) and produces an inherently unreliable verdict
# (an upscaled 2x2 render looks like a "black square" to a human reviewer
# and confuses the model too, matching the exact live-review complaint this
# constant fixes: decorative squares/logos being inconsistently judged
# "significant" and cluttering the figure count). Filtering these out HERE,
# before a Figure/vision-call is ever created, is strictly more reliable
# than relying on the vision model's own judgment for genuinely degenerate
# input -- the vision significance filter (main.py's _describe_figure)
# still runs, unchanged, for every image that passes this size floor (e.g.
# a real logo at realistic pixel dimensions, which IS meaningful input for
# that judgment).
_DEGENERATE_IMAGE_MAX_DIMENSION_PX = 8


def _is_degenerate_pdf_image(pypdf_image: object) -> bool:
    """True only when BOTH dimensions are tiny -- deliberately not an area
    check, so a real thin-but-tall/wide decorative strip (which at least
    carries a visible color/shape on the page) is left to the vision
    significance filter rather than silently dropped here. Fails open
    (returns False, i.e. "keep it") on any error decoding the image's own
    dimensions -- this is a cheap pre-filter for a KNOWN degenerate case,
    not a load-bearing content-integrity check, and dropping a real figure
    because pypdf couldn't report its size would be strictly worse than an
    occasional wasted vision call."""
    try:
        image = pypdf_image.image  # type: ignore[attr-defined]
        if image is None:
            return False
        width, height = image.size
    except Exception:  # noqa: BLE001 -- see docstring: fail open, never drop a real figure over a decode hiccup
        return False
    return width <= _DEGENERATE_IMAGE_MAX_DIMENSION_PX and height <= _DEGENERATE_IMAGE_MAX_DIMENSION_PX


def count_image_xobjects(path: str) -> int:
    """Cheap, approximate figure-count denominator for the describe_figure
    progress narration (main.py) -- unlike docx/pptx's own structural
    pre-pass (a full second dispatch, negligible cost since neither format
    has an OCR step), re-running load_pdf's real walk just to learn a count
    would double real OCR/text-extraction work, which is NOT free. This
    instead just opens the PDF and counts image XObjects across all pages
    via pypdf's own `page.images` -- no OCR, no pdfplumber, no rendering.

    Approximate, not exact, on purpose: the real walk's dedup-hash and
    boilerplate-header/footer suppression (see _detect_boilerplate_images)
    can drop some of these before they ever reach `describe_figure`, so the
    real total captioned may end up lower than this count. A denominator
    that's occasionally an overestimate (progress reads "figure 3 of 8" but
    only 5 ever get described) is a much smaller UX gap than PDF having no
    denominator at all, which is the gap this closes."""
    reader = PdfReader(path)
    return sum(len(page.images) for page in reader.pages)


def load_pdf(
    path: str,
    describe_figure: Callable[[bytes], str | None] | None = None,
    text_only: bool = False,
    languages: str = "eng",
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
    the converted PDF's own tables/figures).

    `languages` is passed to Tesseract's `lang` parameter wherever this
    document's page-level OCR fallback or table-cell OCR recovery runs
    (see app/loaders/ocr.py and _cell_ocr_recovery below) -- has no effect
    on a document with no OCR-eligible content at all. Default "eng"
    matches every existing call site that predates this parameter."""
    file_path = Path(path)
    sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
    document = Document(path=path, format=DocumentFormat.PDF, sha256=sha256)

    blocks: list[Block] = []
    tables: list[Table] = []
    figures: list[Figure] = []
    block_id = 0
    table_id = 0
    figure_id = 0
    # Side dicts feeding Task 5's post-loop `_merge_continued_tables` pass
    # (see that function's own docstring) -- populated per-table alongside
    # `table_id += 1` in the main loop below, keyed by each table's own id.
    table_xs_by_id: dict[str, list[float]] = {}
    table_bbox_by_id: dict[str, tuple[float, float, float, float]] = {}
    # Rendered-page cache for table-cell OCR recovery (_cell_ocr_recovery)
    # -- lives only for this one load_pdf call (a fresh local here, never
    # reused across calls) and retains at most a single entry: pages are
    # walked strictly in order and never revisited, so _cell_ocr_recovery
    # clears this dict before caching each new page's render, bounding its
    # size to one rendered page instead of every page seen so far, keyed
    # by page_index (path is fixed for the whole call).
    # Deliberately separate from cached_pdf_reader's own @lru_cache (keyed
    # by path, storing a pypdf.PdfReader, reused ACROSS calls) -- this
    # stores a pdf2image-rendered PIL.Image per page and must never share
    # storage or eviction with that cache (see this plan's Global
    # Constraints / the design spec's Regression Safety section).
    page_image_cache: dict[int, Image.Image] = {}

    with pdfplumber.open(path) as pdf:
        # Document-level page height, NOT per-page -- `_merge_continued_tables`
        # runs ONCE after every page has been walked, checking pairs of
        # tables that may span ANY two adjacent pages, so it needs a single
        # shared value rather than per-page state. Every real document's
        # pages share one page size in practice (confirmed: this is the
        # common case, and this task's real fixtures always share it);
        # captured from the first page once, up front.
        page_height = pdf.pages[0].height if pdf.pages else 0.0
        # First pass: every page's own lines (cheap -- no table/image work
        # yet), collected once so header/footer recurrence can be checked
        # across the WHOLE document before the real per-page build below
        # decides what to keep. See _detect_boilerplate_templates' own
        # docstring for why this must be a first pass, not decided
        # page-by-page (a header/footer's own defining property is that it
        # recurs ACROSS pages -- no single page's content can prove that).
        all_pages_lines: list[list[dict]] = [page.extract_text_lines() for page in pdf.pages]
        pages_first_lines = [lines[0]["text"] if lines else "" for lines in all_pages_lines]
        pages_last_lines = [lines[-1]["text"] if lines else "" for lines in all_pages_lines]
        header_templates, footer_templates = _detect_boilerplate_templates(pages_first_lines, pages_last_lines)

        # First pass (Gap B): every page's own images (full pdfplumber bbox
        # paired with each pypdf image, same best-effort positional pairing
        # documented at the per-page build below), collected once so
        # cross-page image recurrence can be checked across the WHOLE
        # document before the real per-page build decides what to keep --
        # same "recurrence is a whole-document property" discipline as the
        # header/footer TEXT first pass above. Skipped under `text_only`
        # (that mode never enumerates images at all -- see load_pdf's own
        # docstring).
        all_pages_images: list[list[tuple[dict, object]]] = [[] for _ in pdf.pages]
        if not text_only:
            pdf_reader = cached_pdf_reader(path)
            for page_index, plumber_page in enumerate(pdf.pages):
                pypdf_page = pdf_reader.pages[page_index]
                plumber_images = plumber_page.images
                all_pages_images[page_index] = [
                    (
                        plumber_images[i] if i < len(plumber_images) else {"x0": 0.0, "top": 0.0, "x1": 0.0, "bottom": 0.0},
                        pypdf_image,
                    )
                    for i, pypdf_image in enumerate(pypdf_page.images)
                ]
        boilerplate_image_keys = _detect_boilerplate_images(all_pages_images)
        suppressed_boilerplate_image_count = 0
        # Gap C: the same image bytes appearing more than once in the
        # document is one figure, not N -- e.g. a diagram reused across
        # sections, or a decorative graphic that recurs too rarely/too far
        # from the margin to be caught by the boilerplate gate above (that
        # gate needs recurrence on >= _BOILERPLATE_RECURRENCE_FRACTION of
        # pages AND a margin-anchored position; a graphic repeated on a
        # handful of pages in the page body clears neither). Tracks only
        # hashes that were actually EMITTED as a Figure by this loop (not
        # every image seen), so an image already dropped by an earlier gate
        # never blocks a later, still-eligible occurrence of itself.
        seen_figure_hashes: set[str] = set()

        heading_counters: list[int] = []
        size_ranks: dict[float, int] = {}
        body_size = _dominant_body_size(all_pages_lines)
        outline_positions = _outline_heading_positions(path)

        for page_number, page in enumerate(pdf.pages, start=1):
            # §12/§13: table bboxes (page.find_tables()) drive BOTH fixes at
            # once -- (a) filtering table-region lines out before merging
            # back into paragraphs stops table cell text ALSO becoming a
            # duplicate paragraph block (previously page.extract_text() and
            # page.extract_tables() both read the same page unfiltered); (b)
            # each table's bbox top, merged by position against each
            # paragraph's own top (from _lines_to_paragraphs), gives tables a
            # real document-order slot instead of the previous (0,0)
            # placeholder. text_only skips this (pdfplumber's dominant
            # per-page cost) -- see load_pdf's own docstring. found_tables/
            # table_bboxes empty means every line on the page is kept, same
            # as a page with no tables at all.
            found_tables = (
                []
                if text_only
                else page.find_tables(table_settings={"snap_x_tolerance": _DECORATIVE_RECT_SNAP_TOLERANCE})
            )
            # Phase 3c (Task 7): borderless (text-strategy) table detection,
            # additive to the lines-strategy pass above -- real government
            # ICDs have many more tables findable via pdfplumber's
            # vertical_strategy='text' option than ruling-line detection
            # alone ever finds. Naive text-strategy detection is dangerous
            # on its own (CONFIRMED live this session against a real
            # document: it can shred ordinary wrapped prose into a fake
            # table, cells split mid-word), so a candidate is only kept if
            # it (a) doesn't overlap a bbox `found_tables` (lines-strategy)
            # already found -- avoids double-detecting the same real table
            # under two strategies -- and (b) passes `_table_has_chopped_word`'s
            # negative check (see that function's own docstring for the
            # validated rejection rule). `text_strategy_tables` is kept as
            # the FULL (unfiltered) result below -- the per-table loop's
            # `found_table in text_strategy_tables` membership check (object
            # identity, since pdfplumber.table.Table defines no `__eq__`)
            # is what decides `border_style` per table, and only needs to
            # know "did the text strategy ever produce this exact object,"
            # not whether it passed the filter here.
            text_strategy_tables: list = []
            if not text_only:
                lines_bboxes = [t.bbox for t in found_tables]
                text_strategy_tables = page.find_tables(
                    table_settings={"vertical_strategy": "text", "horizontal_strategy": "text"}
                )
                for candidate in text_strategy_tables:
                    # Fix-round (Task 7 review): real overlap, not
                    # containment -- see `_bboxes_overlap`'s own docstring
                    # for the live-reproduced bogus-third-table failure this
                    # replaces (`_inside_any_bbox` only rejected a candidate
                    # fully contained inside ONE lines-strategy bbox; a
                    # candidate spanning two separate ruled tables was
                    # contained in neither and slipped through).
                    if any(_bboxes_overlap(candidate.bbox, b) for b in lines_bboxes):
                        continue
                    # A single-column "table" is not tabular data at all --
                    # it's exactly what a plain stack of left-aligned lines
                    # (ordinary headings/paragraphs sharing one left margin,
                    # no columns whatsoever) looks like to the text
                    # strategy. CONFIRMED live this session: a page of two
                    # bold headings + two body lines, all starting at the
                    # same x, is detected as a real (1-column, 7-row)
                    # find_tables() candidate that trips no chopped-word
                    # boundary at all (no adjacent-cell pair ever exists in
                    # a 1-column row) -- the chopped-word check alone cannot
                    # catch this shape, so the column count is checked
                    # first, before it.
                    if len(candidate.columns) < 2:
                        continue
                    if _table_has_chopped_word(candidate.extract()):
                        continue
                    found_tables.append(candidate)
            table_bboxes = [t.bbox for t in found_tables]

            page_lines = all_pages_lines[page_number - 1]
            if table_bboxes:
                page_lines = [
                    line
                    for line in page_lines
                    if not _inside_any_bbox(
                        {"x0": line["x0"], "top": line["top"], "x1": line["x1"], "bottom": line["bottom"]}, table_bboxes
                    )
                ]

            # Drop a line that's a confirmed recurring header (first line
            # of the page) or footer (last line) template -- checked by
            # POSITION (first/last of THIS page's own line list, matching
            # how the recurrence pass above characterized candidates), not
            # by re-scanning every line against both template sets. Without
            # this, real per-line segmentation alone would make branching
            # WORSE than before: a footer like "2 | Page" parses as a
            # numbered heading via parse_numbering, becoming a spurious
            # top-level branch boundary on every page (see this module's
            # own header/footer suppression design notes).
            #
            # The margin check (_HEADER_FOOTER_MARGIN_POINTS) is a required
            # second gate, not a redundant one: digit-normalized text
            # recurrence alone cannot tell a genuine running header/footer
            # apart from unique body content that happens to differ only by
            # an embedded page-correlated digit (see that constant's own
            # docstring). A real header/footer is by definition anchored in
            # the page's own margin; real body content is not.
            filtered_lines = list(page_lines)
            if (
                filtered_lines
                and filtered_lines[0]["top"] <= _HEADER_FOOTER_MARGIN_POINTS
                and _normalize_digits(filtered_lines[0]["text"]) in header_templates
            ):
                filtered_lines = filtered_lines[1:]
            if (
                filtered_lines
                and filtered_lines[-1]["bottom"] >= page.height - _HEADER_FOOTER_MARGIN_POINTS
                and _normalize_digits(filtered_lines[-1]["text"]) in footer_templates
            ):
                filtered_lines = filtered_lines[:-1]

            paragraphs_with_meta = _lines_to_paragraphs(filtered_lines)
            paragraphs = [p for p, _, _, _ in paragraphs_with_meta]
            tops = [t for _, t, _, _ in paragraphs_with_meta]

            page_tables: list[Table] = []
            for found_table in found_tables:
                # Phase 3c (Task 7): which strategy found THIS table decides
                # `border_style` below -- object-identity membership check
                # (verified: pdfplumber.table.Table defines no custom
                # `__eq__`, so `in` correctly falls back to identity, exactly
                # what's needed since `found_table` IS one of the same
                # objects `text_strategy_tables` was built from).
                is_text_strategy = found_table in text_strategy_tables if not text_only else False
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
                    cells, column_widths, xs = _build_pdf_table_grid(
                        page,
                        found_table,
                        path=path,
                        page_index=page_number - 1,
                        languages=languages,
                        page_image_cache=page_image_cache,
                    )
                except Exception:  # noqa: BLE001 -- a structural extraction failure degrades to Phase-1-shaped bare cells, never aborts the document
                    cells = [[TableCell(text=cell or "") for cell in row] for row in found_table.extract()]
                    column_widths = None
                    xs = []
                    # Task 6: surface this degradation as an UNSUPPORTED NOTE
                    # (Task 1's machinery converts any such NOTE into an
                    # IntegrityWarning rather than letting it leak into
                    # section labels/descriptions) -- same convention as the
                    # multi-column-gap and AcroForm NOTE blocks in this file.
                    blocks.append(
                        Block(
                            id=f"b{block_id}", kind=BlockKind.NOTE,
                            text=f"[UNSUPPORTED: table extraction degraded structure (span/gap information lost) for a table on page {page_number}]",
                            source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0, page=page_number),
                        )
                    )
                    block_id += 1
                page_tables.append(
                    Table(
                        id=f"t{table_id}",
                        cells=cells,
                        column_widths=column_widths,
                        # Phase 3c (Task 7): "grid" is only a valid claim for
                        # a LINES-strategy table -- it was found because real
                        # horizontal AND vertical ruling-line edges exist for
                        # `edges_to_intersections` to build cells from
                        # (pdfplumber's own `TableSettings` defaults BOTH
                        # strategies to `"lines"`, confirmed by reading
                        # `table.py`'s source). A text-strategy table (see
                        # `is_text_strategy` above) has NO ruling lines by
                        # construction -- it was found from text alignment
                        # alone -- so asserting "grid" for it would be a lie
                        # the review UI would render as a fabricated border
                        # that was never actually drawn in the source PDF.
                        border_style=None if is_text_strategy else "grid",
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
                # Side dicts for Task 5's post-loop cross-page continuation
                # merge (`_merge_continued_tables`) -- `Table`/`TableCell`
                # (the canonical model) doesn't retain the raw column-x-edge
                # list or the table's real bbox, so both are captured here,
                # keyed by this table's own id, for that pass to consume
                # after every page has been walked.
                table_xs_by_id[f"t{table_id}"] = xs
                table_bbox_by_id[f"t{table_id}"] = found_table.bbox
                table_id += 1

            # pdfplumber's own page.images gives each image region's full
            # bbox (for real-position ordering, same as tables above, and
            # for the boilerplate-image recurrence check below) but not a
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
            # any index past what pdfplumber reported. Pairing itself was
            # already done once in the first pass above (`all_pages_images`)
            # -- reused here rather than recomputed.
            # text_only skips the pypdf image-enumeration pass too -- see
            # load_pdf's own docstring. An empty page_images list here
            # degrades to the exact same code path a page with zero images
            # already takes below.
            page_images: list[tuple[float, dict, object]] = [
                (bbox["top"], bbox, pypdf_image) for bbox, pypdf_image in all_pages_images[page_number - 1]
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
                [("paragraph", top, (text, size, is_bold, top)) for text, top, size, is_bold in paragraphs_with_meta]
                + [("table", bbox[1], table) for bbox, table in zip(table_bboxes, page_tables)]
                + [("image", top, (bbox, pypdf_image)) for top, bbox, pypdf_image in page_images],
                key=lambda entry: entry[1],
            )
            offset = 0
            # Phase 5 (Task 9): flag-only multi-column detection -- checked
            # against `page_lines` (the table-region-filtered line list from
            # Task 2, before header/footer stripping; see
            # `_detect_suspected_column_gap`'s own docstring for the
            # conservative gates). Appended directly to `blocks`, not folded
            # into `merged`, because this marker has no natural document-
            # order position tied to a specific paragraph/table/image -- it
            # must appear exactly once per flagged page regardless of the
            # rest of that page's content ordering.
            #
            # Skipped entirely under `text_only` (Finding 2 of this plan's
            # whole-branch review): that mode never calls `find_tables()`,
            # so `table_bboxes` is ALWAYS empty and the detector's
            # mandatory table carve-out (a table's own internal column gaps
            # must never flag a page -- see
            # `_detect_suspected_column_gap`'s docstring) cannot fire at
            # all. LIVE-REPRODUCED: a page with a genuine 2-column ruled
            # table emitted a spurious multi-column NOTE under
            # `text_only=True`, which then leaked into
            # `docx_pagination.py`'s page-alignment text blob (the only
            # caller of `load_pdf(text_only=True)`) for any docx with a wide
            # table. A flag whose own safety gate is inoperative is worse
            # than no flag, and `text_only`'s consumer wants plain page text
            # anyway, never layout markers.
            suspected_gap = (
                None if text_only else _detect_suspected_column_gap(page_lines, page.width, table_bboxes)
            )
            if suspected_gap is not None:
                start = offset
                end = start + 1
                offset = end
                blocks.append(
                    Block(
                        id=f"b{block_id}", kind=BlockKind.NOTE,
                        text=f"[UNSUPPORTED: page {page_number} appears multi-column (gap at x={suspected_gap[0]:.0f}-{suspected_gap[1]:.0f}) -- reading order below may be incorrect]",
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=page_number),
                    )
                )
                block_id += 1
            # Phase 3b (Task 6): read-and-reset by the "table" branch below --
            # a caption-shaped paragraph (see `_TABLE_CAPTION_PATTERN`) that is
            # immediately followed by a table in `merged` order defers its own
            # emission and stashes its text here instead, so the table branch
            # can attach it as `Table.caption` rather than the paragraph also
            # being emitted as its own standalone block (link, don't
            # duplicate -- same precedent as docx_loader.py's own
            # Caption-paragraph-to-figure linking).
            pending_table_caption: str | None = None
            # Figure naming (Task 4): the inverse shape of the table-caption
            # lookup above -- a figure's own caption line conventionally
            # FOLLOWS the image, not precedes it, so this can't reuse the
            # single-variable "pending" pattern (which only looks one step
            # forward from a caption to the thing it precedes). Instead,
            # precomputed in one pass over `merged` BEFORE the main loop:
            # for each image entry, look at the very next merged entry, and
            # if it is a figure-caption-shaped paragraph within
            # `_FIGURE_CAPTION_MAX_GAP_POINTS` of the image's own bottom
            # edge, record its title text and mark that paragraph's index as
            # consumed. The main loop below then (a) uses
            # `figure_name_by_merged_index` when building each Figure, and
            # (b) skips emitting a consumed caption paragraph as its own
            # block -- same "link, don't duplicate" contract as the table
            # caption above.
            figure_name_by_merged_index: dict[int, str] = {}
            consumed_figure_caption_indices: set[int] = set()
            for i, (kind, _top, item) in enumerate(merged):
                if kind != "image" or i + 1 >= len(merged):
                    continue
                next_kind, next_top, next_item = merged[i + 1]
                if next_kind != "paragraph":
                    continue
                next_text, _next_size, _next_is_bold, _next_para_top = next_item
                stripped_next_text = next_text.strip()
                if _TOC_DOT_LEADER_PATTERN.search(stripped_next_text):
                    continue
                caption_match = _FIGURE_CAPTION_PATTERN.match(stripped_next_text)
                if caption_match is None:
                    continue
                image_bbox, _pypdf_image = item
                gap = next_top - image_bbox["bottom"]
                # Small negative tolerance for baseline/rounding quirks (a
                # caption line's reported `top` can sit fractionally above
                # the image's own reported `bottom`) -- real measured gaps
                # were all comfortably positive (see the constant's own
                # comment), so this is slack, not the expected case.
                if not (-5.0 <= gap <= _FIGURE_CAPTION_MAX_GAP_POINTS):
                    continue
                figure_name_by_merged_index[i] = caption_match.group(1).strip() or stripped_next_text
                consumed_figure_caption_indices.add(i + 1)

            for i, (kind, _top, item) in enumerate(merged):
                if kind == "paragraph":
                    if i in consumed_figure_caption_indices:
                        # Already used as the preceding figure's name (see
                        # figure_name_by_merged_index's own comment above) --
                        # link, don't duplicate.
                        continue
                    text, size, is_bold, para_top = item
                    caption_match = _TABLE_CAPTION_PATTERN.match(text.strip())
                    # Only treat as a pending caption if the VERY NEXT merged
                    # entry is a table -- checked by peeking ahead, not simply
                    # "any Table-shaped line ever seen" (which could wrongly
                    # attach to a table several paragraphs later).
                    next_is_table = i + 1 < len(merged) and merged[i + 1][0] == "table"
                    if caption_match is not None and next_is_table:
                        pending_table_caption = caption_match.group(1).strip() or text.strip()
                        continue
                    start = offset
                    end = start + len(text)
                    offset = end + 1
                    outline_depth = outline_positions.get((page_number, text.strip()))
                    heading_level: int | None = None
                    number_label: str | None = None
                    if outline_depth is not None:
                        heading_level = outline_depth
                    elif (
                        body_size + _HEADING_SIZE_MARGIN < size <= body_size * _HEADING_SIZE_MAX_RATIO
                        # Content gate -- a size outlier with no real
                        # textual substance (a bulleted list's own bullet
                        # glyph, most commonly) must never become a heading
                        # and must never consume an ordinal. See
                        # `_can_be_heading_text`.
                        and _can_be_heading_text(text)
                    ):
                        existing_label, _ = parse_numbering(text)
                        if existing_label is not None:
                            heading_level = numbering_depth(existing_label)
                        else:
                            heading_level = _heading_level_from_size_rank(size, body_size, size_ranks)
                    if heading_level is not None:
                        existing_label, _ = parse_numbering(text)
                        number_label = _advance_heading_counter(heading_counters, heading_level, existing_label)
                        blocks.append(
                            Block(
                                id=f"b{block_id}",
                                kind=BlockKind.HEADING,
                                text=text,
                                heading_level=heading_level,
                                number_label=number_label,
                                source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=page_number),
                            )
                        )
                    else:
                        blocks.append(
                            Block(
                                id=f"b{block_id}",
                                kind=BlockKind.PARAGRAPH,
                                text=text,
                                source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=page_number),
                            )
                        )
                    block_id += 1
                elif kind == "table":
                    start = offset
                    end = start + 1
                    offset = end
                    table = item
                    # Phase 3b (Task 6): a "Table N: <title>" line the
                    # paragraph branch above deferred (because THIS table was
                    # its immediate next `merged` entry) is attached here and
                    # reset -- never leaked forward to a later, unrelated
                    # table.
                    caption = pending_table_caption
                    pending_table_caption = None
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
                            caption=caption,
                            source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=page_number),
                        )
                    )
                else:
                    bbox, pypdf_image = item
                    if _is_degenerate_pdf_image(pypdf_image):
                        # Not a real figure -- see _is_degenerate_pdf_image's
                        # own docstring/constant comment. Skipped before
                        # touching `offset`/`block_id`/`figure_id` (as if
                        # this merged entry never existed), so no vision
                        # call, no Figure, no [FIGURE: ...] placeholder
                        # block, and no gap in the remaining figure ids.
                        continue
                    # Gap B: a recurring image (see _detect_boilerplate_images)
                    # ANCHORED in the page margin is a running header/footer
                    # artifact (a doc-id/page-number stamp rendered as a
                    # raster image), not a real figure -- same two-gate
                    # discipline (recurrence + margin position) as the text
                    # header/footer suppression above, each independently
                    # required: a real figure that merely repeats a few
                    # times in the page BODY must still survive. Skipped
                    # before touching `offset`/`block_id`/`figure_id`, same
                    # shape as the degenerate-image check just above. The
                    # recurrence key is content-hash only (see
                    # _detect_boilerplate_images); the margin check right
                    # below is what evaluates THIS placement's position.
                    try:
                        image_key: str | None = hashlib.sha256(pypdf_image.data).hexdigest()
                    except Exception:  # noqa: BLE001 -- an undecodable image can never match a boilerplate key
                        image_key = None
                    if (
                        image_key is not None
                        and image_key in boilerplate_image_keys
                        and (bbox["top"] <= _HEADER_FOOTER_MARGIN_POINTS or bbox["bottom"] >= page.height - _HEADER_FOOTER_MARGIN_POINTS)
                    ):
                        suppressed_boilerplate_image_count += 1
                        continue
                    # Gap C (see seen_figure_hashes' own comment above): the
                    # same image bytes already emitted as a Figure earlier
                    # in this document is a reuse, not a new figure. Only
                    # reached for images that survived both gates above, so
                    # this never blocks a genuinely new image that merely
                    # shares a hash with something already suppressed.
                    # `image_key is None` (undecodable image) is never
                    # treated as a duplicate -- same fail-open stance as the
                    # boilerplate check just above.
                    if image_key is not None and image_key in seen_figure_hashes:
                        continue
                    start = offset
                    end = start + 1
                    offset = end
                    caption = None
                    if describe_figure is not None:
                        try:
                            caption = describe_figure(pypdf_image.data)
                        except Exception:  # noqa: BLE001 -- a vision failure must not abort the whole document
                            caption = None
                    append_figure(
                        figures,
                        blocks,
                        figure_id=f"f{figure_id}",
                        block_id=f"b{block_id}",
                        caption=caption,
                        document_path=path,
                        start_offset=start,
                        end_offset=end,
                        page=page_number,
                        name=figure_name_by_merged_index.get(i),
                    )
                    block_id += 1
                    figure_id += 1
                    if image_key is not None:
                        seen_figure_hashes.add(image_key)

    if suppressed_boilerplate_image_count > 0:
        logger.warning(
            "Suppressed %d recurring margin-band image(s) as running header/footer artifacts",
            suppressed_boilerplate_image_count,
        )

    # Phase 3a (Task 5): cross-page table continuation merge -- must run
    # AFTER the full per-page loop above finishes (needs every table's real
    # page number to know which tables are on ADJACENT pages at all). See
    # `_merge_continued_tables`'s own docstring for the merge rule. Wrapped
    # like every other risky path in this file (per-field try/except in
    # `_build_pdf_table_grid`, the table-grid-level fallback in the main
    # loop) -- a malformed bbox/xs entry or any unexpected error here must
    # degrade to the unmerged per-page tables, never abort the whole
    # document load.
    try:
        tables = _merge_continued_tables(tables, table_xs_by_id, table_bbox_by_id, page_height)
    except Exception:  # noqa: BLE001 -- a continuation-merge failure degrades to unmerged per-page tables, never aborts the document
        pass

    # Phase 4 (Task 8): AcroForm fields, fail-loud NOTE marker
    # A filled AcroForm field's value never appears in pdfplumber's text extraction
    # at all -- pypdf's get_fields() sees it, but we flag it for later processing
    # rather than silently dropping it. One NOTE block per document listing every
    # filled field's name/value, matching the docx-loader precedent.
    reader = cached_pdf_reader(path)
    try:
        fields = reader.get_fields()
    except Exception:  # noqa: BLE001 -- a malformed AcroForm must not abort the whole document load
        fields = None
    if fields:
        filled = {name: field.get("/V") for name, field in fields.items() if field.get("/V")}
        if filled:
            note_text = "[UNSUPPORTED: AcroForm fields with values -- not extracted into body content: " + \
                ", ".join(f"{name}: {value}" for name, value in filled.items()) + "]"
            blocks.append(
                Block(
                    id=f"b{block_id}", kind=BlockKind.NOTE, text=note_text,
                    source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0),
                )
            )
            block_id += 1

    return CanonicalDoc(document=document, blocks=blocks, tables=tables, figures=figures)
