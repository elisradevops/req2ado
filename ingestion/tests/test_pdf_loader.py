from pathlib import Path
from unittest.mock import patch

import pytest
from pypdf import PdfReader

from app.canonical.model import BlockKind, plain_text_rows
from app.loaders.pdf_loader import (
    _cell_background_color,
    _fontname_is_bold,
    _pdf_color_to_hex,
    cached_pdf_reader,
    load_pdf,
    page_has_extractable_text,
)

FIXTURES = Path(__file__).parent / "fixtures"


def test_load_pdf_extracts_text_blocks_with_page_number() -> None:
    doc = load_pdf(str(FIXTURES / "sample.pdf"))
    assert len(doc.blocks) >= 1
    assert all(b.source_ref.page == 1 for b in doc.blocks)
    assert any("Backplane Power Budget" in b.text for b in doc.blocks)
    assert any(b.kind == BlockKind.PARAGRAPH for b in doc.blocks)


def test_load_pdf_extracts_at_least_one_table() -> None:
    doc = load_pdf(str(FIXTURES / "sample.pdf"))
    assert len(doc.tables) >= 1
    flat = [cell for row in plain_text_rows(doc.tables[0]) for cell in row]
    assert "3.3V" in flat


def test_load_pdf_format_is_pdf() -> None:
    doc = load_pdf(str(FIXTURES / "sample.pdf"))
    assert doc.document.format.value == "pdf"


def test_page_has_extractable_text_true_for_text_page() -> None:
    assert page_has_extractable_text(str(FIXTURES / "sample.pdf"), 0) is True


def test_page_has_extractable_text_reuses_one_cached_reader_across_repeated_calls() -> None:
    # Regression: load_pdf_with_ocr_fallback previously called
    # page_has_extractable_text once per page in an initial scan pass, then
    # again in its main loop -- each call constructed a brand-new
    # PdfReader(path) (itself an O(pages) parse), so an N-page document did
    # ~2N full-document reparses, O(N^2) total. cached_pdf_reader.cache_clear()
    # first so this test isn't polluted by another test's cache entry.
    cached_pdf_reader.cache_clear()
    path = str(FIXTURES / "sample.pdf")
    with patch("app.loaders.pdf_loader.PdfReader", wraps=PdfReader) as spy:
        page_has_extractable_text(path, 0)
        page_has_extractable_text(path, 0)
        page_has_extractable_text(path, 0)
    assert spy.call_count == 1


def test_load_pdf_extracts_a_figure_placeholder_block() -> None:
    # See CR5 of the corrected work plan: PDF figure/drawing extraction was
    # previously docx-only (docx_loader.py); this mirrors that behavior for
    # PDFs — detection + verbatim placeholder, no OCR of the image content.
    doc = load_pdf(str(FIXTURES / "pdf_with_figure.pdf"))
    assert len(doc.figures) == 1
    assert doc.figures[0].caption is None
    figure_blocks = [b for b in doc.blocks if b.kind == BlockKind.FIGURE]
    assert len(figure_blocks) == 1
    assert figure_blocks[0].text == "[FIGURE: none]"


def test_load_pdf_uses_describe_figure_when_provided() -> None:
    # Regression: figures previously always became an empty [FIGURE: none]
    # placeholder with no way to describe real content.
    captured_bytes: list[bytes] = []

    def fake_describe(image_bytes: bytes) -> str:
        captured_bytes.append(image_bytes)
        return "A schematic diagram."

    doc = load_pdf(str(FIXTURES / "pdf_with_figure.pdf"), describe_figure=fake_describe)

    assert len(captured_bytes) == 1
    assert len(captured_bytes[0]) > 0  # real image bytes, not empty
    assert doc.figures[0].caption == "A schematic diagram."
    figure_blocks = [b for b in doc.blocks if b.kind == BlockKind.FIGURE]
    assert figure_blocks[0].text == "[FIGURE: A schematic diagram.]"


def test_load_pdf_falls_back_to_placeholder_when_describe_figure_raises() -> None:
    def failing_describe(image_bytes: bytes) -> str:
        raise RuntimeError("vision service unreachable")

    doc = load_pdf(str(FIXTURES / "pdf_with_figure.pdf"), describe_figure=failing_describe)

    assert doc.figures[0].caption is None
    figure_blocks = [b for b in doc.blocks if b.kind == BlockKind.FIGURE]
    assert figure_blocks[0].text == "[FIGURE: none]"


def test_load_pdf_figure_gets_a_real_position_not_the_old_zero_placeholder() -> None:
    # Regression: an image's SourceRef was previously always (0, 0),
    # regardless of where on the page it actually appeared -- best-effort
    # positional correspondence between pdfplumber's page.images (has a
    # bbox) and pypdf's page.images (has real decodable bytes) now gives it
    # a real offset, same as tables already got.
    doc = load_pdf(str(FIXTURES / "pdf_with_figure.pdf"))
    figure_blocks = [b for b in doc.blocks if b.kind == BlockKind.FIGURE]
    assert figure_blocks[0].source_ref.start_offset > 0


def test_load_pdf_figure_placeholder_survives_into_baseline_tree_verbatim() -> None:
    from app.leveling.tree_builder import build_baseline_tree
    from app.workitem.fidelity import verify_fidelity

    doc = load_pdf(str(FIXTURES / "pdf_with_figure.pdf"))
    tree = build_baseline_tree(doc)
    assert any("[FIGURE: none]" in node.description for node in tree.nodes)
    for node in tree.nodes:
        assert verify_fidelity(node)


# ---------------------------------------------------------------------------
# Phase 4 (docs/superpowers/specs/2026-08-12-table-fidelity-design.md):
# real best-effort structural + styling PDF table extraction.
#
# Fixture-building follows the same real-loader-integration pattern this
# session's Phase 0 spike already used and `tests/fixtures/build_pdf_fixture.py`
# / `test_docx_pagination.py`'s `_build_matching_docx_and_hand_paginated_pdf`
# already established: build a real PDF via reportlab's `Table`/`TableStyle`
# into `tmp_path` (never committed as a binary fixture -- these are cheap
# and deterministic to regenerate per test run), then feed it through the
# real `load_pdf` loader end-to-end. This proves the real pdfplumber
# geometry wiring, not a mocked approximation of it.
# ---------------------------------------------------------------------------


def _build_span_and_gap_pdf(tmp_path: Path) -> Path:
    """A 3x3 table with a real horizontal SPAN (row 0, cols 0-1), a real
    VERTICAL span (col 2, rows 1-2), and a separate, genuinely empty cell
    (row 1, col 1) that is NOT covered by any span -- exactly the Phase 0
    spike's confirmed span-vs-gap setup, extended with a vertical span so
    both colspan AND rowspan get real fixture coverage, not just colspan."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.platypus import SimpleDocTemplate
    from reportlab.platypus import Table as RLTable
    from reportlab.platypus import TableStyle

    pdf_path = tmp_path / "span_and_gap.pdf"
    data = [
        ["Config", "", "R0C2"],
        ["R1C0", "", "Tall"],
        ["R2C0", "R2C1", ""],
    ]
    style = TableStyle(
        [
            ("GRID", (0, 0), (-1, -1), 0.5, colors.black),
            ("SPAN", (0, 0), (1, 0)),  # horizontal: row 0, cols 0-1
            ("SPAN", (2, 1), (2, 2)),  # vertical: col 2, rows 1-2
        ]
    )
    doc = SimpleDocTemplate(str(pdf_path), pagesize=letter)
    doc.build([RLTable(data, style=style, colWidths=[100, 100, 100])])
    return pdf_path


def test_load_pdf_span_colspan_and_rowspan_from_geometry(tmp_path: Path) -> None:
    doc = load_pdf(str(_build_span_and_gap_pdf(tmp_path)))
    t = doc.tables[0]

    origin = t.cells[0][0]
    assert origin is not None
    assert origin.text == "Config"
    assert origin.colspan == 2
    assert origin.rowspan == 1

    tall_origin = t.cells[1][2]
    assert tall_origin is not None
    assert tall_origin.text == "Tall"
    assert tall_origin.colspan == 1
    assert tall_origin.rowspan == 2


def test_load_pdf_spanned_positions_are_none_not_gap_cells(tmp_path: Path) -> None:
    # The position absorbed by the horizontal span (row 0, col 1) and the
    # position absorbed by the vertical span (row 2, col 2) must both be
    # `None` -- no TableCell at all, never an empty-string TableCell, which
    # would render a spurious extra <td> and break the grid's real shape.
    doc = load_pdf(str(_build_span_and_gap_pdf(tmp_path)))
    t = doc.tables[0]
    assert t.cells[0][1] is None
    assert t.cells[2][2] is None


def test_load_pdf_genuine_gap_is_a_real_empty_cell_not_none(tmp_path: Path) -> None:
    # Row 1, col 1 is empty text but NOT covered by any span -- a genuine
    # gap. It must be a real TableCell(text="") (renders an empty <td>),
    # distinguishable in code from the spanned `None` positions above.
    doc = load_pdf(str(_build_span_and_gap_pdf(tmp_path)))
    t = doc.tables[0]
    gap_cell = t.cells[1][1]
    assert gap_cell is not None
    assert gap_cell.text == ""
    assert gap_cell.colspan == 1
    assert gap_cell.rowspan == 1


def test_load_pdf_first_row_is_marked_header_heuristically(tmp_path: Path) -> None:
    doc = load_pdf(str(_build_span_and_gap_pdf(tmp_path)))
    t = doc.tables[0]
    assert t.cells[0][0].is_header is True
    assert t.cells[0][2].is_header is True
    assert t.cells[1][0].is_header is False


def test_load_pdf_column_widths_are_fractions_summing_to_one(tmp_path: Path) -> None:
    doc = load_pdf(str(_build_span_and_gap_pdf(tmp_path)))
    t = doc.tables[0]
    assert t.column_widths is not None
    assert len(t.column_widths) == 3
    assert sum(t.column_widths) == pytest.approx(1.0, abs=1e-6)
    # Equal 100pt columns -> equal (1/3) fractions, never the raw 100pt value.
    for w in t.column_widths:
        assert w == pytest.approx(1 / 3, abs=1e-6)


def test_load_pdf_column_widths_reflect_real_ratio_for_unequal_columns(tmp_path: Path) -> None:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.platypus import SimpleDocTemplate
    from reportlab.platypus import Table as RLTable
    from reportlab.platypus import TableStyle

    pdf_path = tmp_path / "unequal_columns.pdf"
    style = TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)])
    doc_builder = SimpleDocTemplate(str(pdf_path), pagesize=letter)
    doc_builder.build([RLTable([["A", "B", "C"]], style=style, colWidths=[100, 200, 100])])

    doc = load_pdf(str(pdf_path))
    t = doc.tables[0]
    assert t.column_widths == pytest.approx([0.25, 0.5, 0.25], abs=1e-6)


def test_load_pdf_border_style_is_grid_and_provenance_is_heuristic_unconditionally(tmp_path: Path) -> None:
    # style_provenance="heuristic" must be present on EVERY table this
    # loader produces, unconditionally -- it's the field's entire purpose
    # (see Table.style_provenance's docstring / SourceRef.page_provenance's
    # precedent it mirrors). border_style="grid" here is backed by a real
    # signal, not asserted blindly: this call site never overrides
    # table_settings, so pdfplumber's own TableSettings defaults both
    # strategies to "lines" -- a table is only found at all because real
    # ruling lines exist.
    doc = load_pdf(str(_build_span_and_gap_pdf(tmp_path)))
    assert len(doc.tables) >= 1
    for table in doc.tables:
        assert table.style_provenance == "heuristic"
        assert table.border_style == "grid"


def _build_alignment_and_style_pdf(tmp_path: Path) -> Path:
    """One row of left/center/right-aligned text (via reportlab's own ALIGN
    style command, which really does move plain-string cell content within
    the column, not just a cosmetic hint), plus a second row exercising
    bold (FONTNAME) and text color (TEXTCOLOR) per cell."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.platypus import SimpleDocTemplate
    from reportlab.platypus import Table as RLTable
    from reportlab.platypus import TableStyle

    pdf_path = tmp_path / "alignment_and_style.pdf"
    data = [["L", "C", "R"], ["Bold", "Blue", "Plain"]]
    style = TableStyle(
        [
            ("GRID", (0, 0), (-1, -1), 0.5, colors.black),
            ("ALIGN", (0, 0), (0, 0), "LEFT"),
            ("ALIGN", (1, 0), (1, 0), "CENTER"),
            ("ALIGN", (2, 0), (2, 0), "RIGHT"),
            ("FONTNAME", (0, 1), (0, 1), "Helvetica-Bold"),
            ("TEXTCOLOR", (1, 1), (1, 1), colors.blue),
        ]
    )
    doc = SimpleDocTemplate(str(pdf_path), pagesize=letter)
    doc.build([RLTable(data, style=style, colWidths=[150, 150, 150])])
    return pdf_path


def test_load_pdf_alignment_heuristic_detects_left_center_right(tmp_path: Path) -> None:
    doc = load_pdf(str(_build_alignment_and_style_pdf(tmp_path)))
    t = doc.tables[0]
    assert t.cells[0][0].align == "left"
    assert t.cells[0][1].align == "center"
    assert t.cells[0][2].align == "right"


def test_load_pdf_bold_detection_via_widened_fontname_tokens(tmp_path: Path) -> None:
    doc = load_pdf(str(_build_alignment_and_style_pdf(tmp_path)))
    t = doc.tables[0]
    assert t.cells[1][0].text == "Bold"
    assert t.cells[1][0].bold is True
    # Plain text in the same row must NOT be reported bold.
    assert t.cells[1][2].bold is False


def test_load_pdf_text_color_extracted_from_first_non_whitespace_char(tmp_path: Path) -> None:
    doc = load_pdf(str(_build_alignment_and_style_pdf(tmp_path)))
    t = doc.tables[0]
    assert t.cells[1][1].text == "Blue"
    assert t.cells[1][1].text_color == "#0000ff"
    # Default (unset) text color renders as PDF's own default black --
    # a real, if uninteresting, explicit value, not None.
    assert t.cells[1][2].text_color == "#000000"


def test_load_pdf_background_color_from_filled_rect_overlapping_cell(tmp_path: Path) -> None:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.platypus import SimpleDocTemplate
    from reportlab.platypus import Table as RLTable
    from reportlab.platypus import TableStyle

    pdf_path = tmp_path / "background.pdf"
    style = TableStyle(
        [
            ("GRID", (0, 0), (-1, -1), 0.5, colors.black),
            ("BACKGROUND", (0, 0), (0, 0), colors.red),
        ]
    )
    doc_builder = SimpleDocTemplate(str(pdf_path), pagesize=letter)
    doc_builder.build([RLTable([["A", "B"], ["C", "D"]], style=style, colWidths=[100, 100])])

    doc = load_pdf(str(pdf_path))
    t = doc.tables[0]
    assert t.cells[0][0].background_color == "#ff0000"
    # A cell with no filled rect behind it must degrade to None, never a
    # guessed color -- background is explicitly the weakest signal here.
    assert t.cells[0][1].background_color is None
    assert t.cells[1][0].background_color is None
    assert t.cells[1][1].background_color is None


# --- Unit tests of the pure color-conversion helper (no PDF needed for
# every colorspace arity -- see this module's own docstring on
# `_pdf_color_to_hex` for the exact conversion rules being verified). ---


def test_pdf_color_to_hex_grayscale_bare_float_and_1_tuple() -> None:
    # CONFIRMED via a real pdfplumber spike this session: a grayscale
    # non_stroking_color on an UNFILLED-but-stroked shape came back as a
    # bare float/int (not wrapped in a tuple) -- both shapes must convert
    # identically.
    assert _pdf_color_to_hex(0.5) == "#808080"
    assert _pdf_color_to_hex((0.5,)) == "#808080"
    assert _pdf_color_to_hex(0.0) == "#000000"
    assert _pdf_color_to_hex(1.0) == "#ffffff"


def test_pdf_color_to_hex_rgb() -> None:
    assert _pdf_color_to_hex((1.0, 0.0, 0.0)) == "#ff0000"
    assert _pdf_color_to_hex((0.0, 1.0, 0.0)) == "#00ff00"
    assert _pdf_color_to_hex((0.0, 0.0, 0.0)) == "#000000"


def test_pdf_color_to_hex_cmyk() -> None:
    # Pure black in CMYK (K=1) -> #000000; pure cyan (C=1, K=0) -> #00ffff.
    assert _pdf_color_to_hex((0.0, 0.0, 0.0, 1.0)) == "#000000"
    assert _pdf_color_to_hex((1.0, 0.0, 0.0, 0.0)) == "#00ffff"


def test_pdf_color_to_hex_degrades_to_none_on_unknown_or_malformed_input() -> None:
    # None, a pattern-fill name string, and an unexpected arity must all
    # degrade to None -- never guess, never raise.
    assert _pdf_color_to_hex(None) is None
    assert _pdf_color_to_hex("P0") is None  # a pattern name, not a color
    assert _pdf_color_to_hex((0.1, 0.2)) is None  # unsupported 2-tuple arity
    assert _pdf_color_to_hex((0.1, 0.2, 0.3, 0.4, 0.5)) is None  # unsupported 5-tuple arity


def test_pdf_color_to_hex_degrades_to_none_rather_than_raising_on_garbage() -> None:
    # Defensive: a genuinely malformed value (non-numeric channel content)
    # must degrade to None, not propagate an exception up through the
    # table-building loop and abort the whole document.
    assert _pdf_color_to_hex((object(), object(), object())) is None
    assert _pdf_color_to_hex({"not": "a color"}) is None


def test_fontname_is_bold_widened_token_list() -> None:
    # Naive "bold" in fontname already catches these:
    assert _fontname_is_bold("Arial-Bold") is True
    assert _fontname_is_bold("Arial-BoldMT") is True
    assert _fontname_is_bold("Calibri-Semibold") is True
    # Widened tokens this Phase adds, which a bare "bold" substring check
    # would miss entirely:
    assert _fontname_is_bold("Arial-Black") is True
    assert _fontname_is_bold("Helvetica-Heavy") is True
    assert _fontname_is_bold("ABCDEF+Arial-BdMT") is True
    # Plain/regular weights, and no fontname at all, must not match.
    assert _fontname_is_bold("Arial") is False
    assert _fontname_is_bold("Helvetica-Oblique") is False
    assert _fontname_is_bold(None) is False
    assert _fontname_is_bold("") is False


def test_cell_background_color_defensive_degrades_to_none_on_malformed_rect() -> None:
    # A rect dict missing expected keys, or with a garbage color, must not
    # raise -- the whole function is one try/except by design (background
    # is explicitly the weakest signal in this feature).
    malformed_rects = [{"fill": True, "non_stroking_color": {"not": "a color"}}]
    assert _cell_background_color(malformed_rects, (0.0, 0.0, 10.0, 10.0)) is None
    # An unfilled rect (fill=False) must never be considered, even with a
    # real-looking color and perfect overlap.
    unfilled_rects = [
        {"fill": False, "non_stroking_color": (1.0, 0.0, 0.0), "x0": 0.0, "x1": 10.0, "top": 0.0, "bottom": 10.0}
    ]
    assert _cell_background_color(unfilled_rects, (0.0, 0.0, 10.0, 10.0)) is None
