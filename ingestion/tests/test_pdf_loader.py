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
    # This fixture's own "Panel Layout" heading (tests/fixtures/
    # build_pdf_with_figure_fixture.py styles it with reportlab's "Title"
    # style, always larger than its BodyText) is now correctly detected as
    # a real BlockKind.HEADING by Task 3's font-size-outlier classifier --
    # previously PDFs never emitted HEADING at all, so this document fell
    # through to build_baseline_tree's headingless fallback path, whose
    # own doc comment documents (as "a pre-existing, separate concern")
    # that it renders a FIGURE block's raw block.text verbatim, including
    # the literal "[FIGURE: none]" placeholder. Now that heading detection
    # correctly routes this document through the STRUCTURED branch path
    # instead, that path's _figure_line gate (already covered by
    # test_tree_builder.py's own
    # test_baseline_structured_tree_figure_fold_populates_figure_ids_and_uncaptioned_figure_ids)
    # deliberately suppresses the raw placeholder and tracks the figure via
    # uncaptioned_figure_ids instead -- the figure still survives into the
    # tree, just not as leaked placeholder text. This test now asserts that
    # (correct, already-fixed-elsewhere) behavior rather than the old
    # headingless-path artifact.
    from app.leveling.tree_builder import build_baseline_tree
    from app.workitem.fidelity import verify_fidelity

    doc = load_pdf(str(FIXTURES / "pdf_with_figure.pdf"))
    tree = build_baseline_tree(doc)
    assert not any("[FIGURE: none]" in node.description for node in tree.nodes)
    assert any("Panel Layout" in node.title for node in tree.nodes)
    assert any(node.uncaptioned_figure_ids for node in tree.nodes)
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


def _build_mixed_text_and_scanned_pdf_with_figure(tmp_path: Path) -> Path:
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas as rl_canvas
    from PIL import Image

    text_page_path = tmp_path / "text_page.pdf"
    c = rl_canvas.Canvas(str(text_page_path), pagesize=letter)
    c.drawString(72, 700, "A text-bearing page with an embedded figure.")
    image_path = tmp_path / "fig.png"
    Image.new("RGB", (10, 10), color="blue").save(image_path)
    c.drawImage(str(image_path), 72, 500, width=50, height=50)
    c.save()

    scanned_page_path = tmp_path / "scanned_page.pdf"
    scan_image_path = tmp_path / "scan.png"
    Image.new("RGB", (200, 200), color="white").save(scan_image_path)
    c2 = rl_canvas.Canvas(str(scanned_page_path), pagesize=letter)
    c2.drawImage(str(scan_image_path), 0, 0, width=letter[0], height=letter[1])
    c2.save()

    from pypdf import PdfWriter, PdfReader
    writer = PdfWriter()
    for p in (text_page_path, scanned_page_path):
        reader = PdfReader(str(p))
        writer.add_page(reader.pages[0])
    out_path = tmp_path / "mixed.pdf"
    with open(out_path, "wb") as f:
        writer.write(f)
    return out_path


# ---------------------------------------------------------------------------
# Line-level paragraph segmentation + header/footer suppression (this Phase's
# core rewrite): the old `text.split("\n\n")` never actually split anything
# (pdfplumber's extract_text() never emits a blank line), so every page
# became exactly ONE giant PARAGRAPH block. Real per-LINE segmentation
# (extract_text_lines()) merged back into paragraphs via font-size/gap
# heuristics fixes that -- but must ship together with header/footer
# suppression, or a page footer (e.g. "2 | Page") becomes a spurious
# top-level numbered-heading branch boundary on every single page.
# ---------------------------------------------------------------------------


def test_load_pdf_merges_wrapped_lines_into_one_paragraph_block() -> None:
    # Regression: text.split("\n\n") never actually split anything (pdfplumber
    # never emits a blank line), so a multi-line wrapped paragraph and every
    # OTHER paragraph/heading on the page all became ONE giant PARAGRAPH block.
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "wrapped.pdf"
        styles = getSampleStyleSheet()
        doc = SimpleDocTemplate(str(path), pagesize=letter)
        long_text = "This is a long sentence that must wrap across multiple lines when rendered at normal body width in a standard page layout. " * 3
        doc.build([
            Paragraph("Title Heading", styles["Title"]),
            Paragraph(long_text, styles["BodyText"]),
            Paragraph("A second, separate paragraph.", styles["BodyText"]),
        ])
        result = load_pdf(str(path))

    # Exactly 3 blocks: title, the wrapped long paragraph (merged back into
    # ONE block despite spanning multiple lines), and the second paragraph --
    # not 1 giant page-blob, and not one block PER LINE either. Checked over
    # ALL blocks (not just BlockKind.PARAGRAPH) since Task 3's font-size-
    # outlier heading detection now correctly classifies "Title Heading"
    # (styles["Title"], larger than styles["BodyText"]) as BlockKind.HEADING
    # -- this test's own real concern (line-merge granularity, not heading
    # classification) is unaffected by that and still holds over the full
    # block list.
    assert len(result.blocks) == 3
    assert result.blocks[1].text.startswith("This is a long sentence")
    assert result.blocks[1].text.count("This is a long sentence") == 3  # all 3 repeats intact, still one block


def test_load_pdf_suppresses_a_running_header_recurring_across_most_pages() -> None:
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas as rl_canvas
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "headered.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        for i in range(5):
            c.drawString(72, 750, "MY DOCUMENT - REV A")  # running header, every page
            c.drawString(72, 700, f"Body content unique to page {i}.")
            c.showPage()
        c.save()
        result = load_pdf(str(path))

    header_texts = [b.text for b in result.blocks if "REV A" in b.text]
    assert header_texts == []  # suppressed on every page, not surviving as a PARAGRAPH block
    body_texts = [b.text for b in result.blocks if "Body content unique" in b.text]
    assert len(body_texts) == 5  # unique body content on every page is untouched


def test_load_pdf_suppresses_a_footer_that_varies_only_by_page_number() -> None:
    # Regression: exact-string matching alone would miss this -- the real
    # footer text differs per page (embedded page number), same template.
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas as rl_canvas
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "footered.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        for i in range(5):
            c.drawString(72, 700, f"Body content unique to page {i}.")
            c.drawString(72, 40, f"{i + 1} | Page")  # footer, page number varies
            c.showPage()
        c.save()
        result = load_pdf(str(path))

    footer_texts = [b.text for b in result.blocks if "| Page" in b.text]
    assert footer_texts == []
    # Regression: the digit-normalized recurrence check alone (before the
    # 72pt margin-position gate) misclassified this page's FIRST line --
    # "Body content unique to page N." -- as a recurring HEADER template
    # (same digit-normalization collision the header-suppression test
    # already guards against for the footer role), silently reducing every
    # page to zero blocks. Undetected by this test's own assertions before
    # this line was added -- see task-2-report.md's fix-round entry.
    body_texts = [b.text for b in result.blocks if "Body content unique" in b.text]
    assert len(body_texts) == 5


# ---------------------------------------------------------------------------
# Phase 2 (Task 3, docs/superpowers/sdd/2026-08-13-pdf-ingestion-fidelity):
# heading detection via font-size outlier, numbering-parsed depth, and a
# real PDF outline as a tier-0 override. Before this, every PDF text block
# was flat PARAGRAPH -- no BlockKind.HEADING was ever emitted for a PDF.
# ---------------------------------------------------------------------------


def test_load_pdf_detects_a_heading_via_font_size_outlier() -> None:
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.pagesizes import letter
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "heading.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        c.setFont("Helvetica-Bold", 18)
        c.drawString(72, 700, "Introduction")
        c.setFont("Helvetica", 10)
        c.drawString(72, 670, "Body text at normal size.")
        c.save()
        result = load_pdf(str(path))

    heading = next(b for b in result.blocks if b.text == "Introduction")
    assert heading.kind == BlockKind.HEADING
    assert heading.heading_level == 1
    body = next(b for b in result.blocks if "Body text" in b.text)
    assert body.kind == BlockKind.PARAGRAPH


def test_load_pdf_uses_own_numbering_for_heading_depth_when_present() -> None:
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.pagesizes import letter
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "numbered_heading.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        c.setFont("Helvetica-Bold", 14)
        c.drawString(72, 700, "1.1 Scope")
        c.setFont("Helvetica", 10)
        c.drawString(72, 670, "Body text.")
        c.save()
        result = load_pdf(str(path))

    heading = next(b for b in result.blocks if "Scope" in b.text)
    assert heading.kind == BlockKind.HEADING
    assert heading.heading_level == 2  # from "1.1", not a size-rank guess
    assert heading.number_label is None  # self-numbered, text kept as-is, no synthesis


def test_load_pdf_synthesizes_a_number_for_an_unnumbered_heading() -> None:
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.pagesizes import letter
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "unnumbered_headings.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        c.setFont("Helvetica-Bold", 16)
        c.drawString(72, 750, "Introduction")
        c.setFont("Helvetica", 10)
        c.drawString(72, 720, "Body one.")
        c.setFont("Helvetica-Bold", 16)
        c.drawString(72, 690, "Scope")
        c.setFont("Helvetica", 10)
        c.drawString(72, 660, "Body two.")
        c.save()
        result = load_pdf(str(path))

    headings = [b for b in result.blocks if b.kind == BlockKind.HEADING]
    assert [h.number_label for h in headings] == ["1", "2"]


def test_load_pdf_watermark_sized_text_is_not_classified_as_heading() -> None:
    # Regression guard: a watermark can be the largest font on a page --
    # must not be promoted to HEADING just because it's an outlier.
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.pagesizes import letter
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "watermarked.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        c.setFont("Helvetica", 60)  # watermark-sized, far beyond _HEADING_SIZE_MAX_RATIO x body
        c.drawString(150, 400, "DRAFT")
        c.setFont("Helvetica", 10)
        c.drawString(72, 700, "Real body text on this page.")
        c.save()
        result = load_pdf(str(path))

    draft_block = next(b for b in result.blocks if b.text == "DRAFT")
    assert draft_block.kind == BlockKind.PARAGRAPH  # excluded from heading candidacy, not promoted


def test_load_pdf_detects_a_heading_via_real_outline_bookmark_tier_0() -> None:
    # Fix-round addition (task-3-report.md): the outline/bookmark tier-0
    # path (_outline_heading_positions) had zero test coverage -- and was
    # in fact silently dead: reader.get_page_number(dest) (the brief's own
    # literal call, passing the Destination itself) resolves to None,
    # `None + 1` raises, and the surrounding except swallowed it, so the
    # whole tier-0 path always fell back to {} without ever running.
    # Fixed to call reader.get_page_number(dest.page) -- the Destination's
    # own already-resolved PageObject, which is what get_page_number
    # actually expects (confirmed directly against the installed pypdf,
    # not assumed).
    #
    # Both lines here are drawn at the SAME size (10pt) -- deliberately NOT
    # a font-size outlier -- so this line would stay PARAGRAPH under
    # font-size classification alone. Only a working outline entry can
    # promote it to HEADING, proving the tier-0 override is real, not a
    # coincidental match with the font-size path.
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.pagesizes import letter
    from pypdf import PdfWriter
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        base_path = Path(tmp_dir) / "base.pdf"
        c = rl_canvas.Canvas(str(base_path), pagesize=letter)
        c.setFont("Helvetica", 10)
        c.drawString(72, 700, "Introduction")
        c.drawString(72, 670, "Body text at normal size.")
        c.save()

        writer = PdfWriter(clone_from=str(base_path))
        writer.add_outline_item("Introduction", 0)  # bookmarks page index 0 (0-based)
        outlined_path = Path(tmp_dir) / "outlined.pdf"
        with open(outlined_path, "wb") as f:
            writer.write(f)

        result = load_pdf(str(outlined_path))

    heading = next(b for b in result.blocks if b.text == "Introduction")
    assert heading.kind == BlockKind.HEADING
    assert heading.heading_level == 1
    body = next(b for b in result.blocks if "Body text" in b.text)
    assert body.kind == BlockKind.PARAGRAPH  # untouched -- same size, no outline entry of its own


def test_load_pdf_with_no_outline_still_classifies_headings_by_font_size() -> None:
    # Fix-round addition: confirms _outline_heading_positions' empty-dict
    # fallback (no outline present at all, the overwhelming common case for
    # a plain reportlab-generated PDF -- no add_outline_item call here)
    # doesn't break or short-circuit the font-size classification path --
    # a document with zero outline entries must still detect headings via
    # font-size outlier exactly as before this task's outline addition.
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.pagesizes import letter
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "no_outline.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        c.setFont("Helvetica-Bold", 18)
        c.drawString(72, 700, "Introduction")
        c.setFont("Helvetica", 10)
        c.drawString(72, 670, "Body text at normal size.")
        c.save()
        result = load_pdf(str(path))

    heading = next(b for b in result.blocks if b.text == "Introduction")
    assert heading.kind == BlockKind.HEADING
    assert heading.heading_level == 1
    body = next(b for b in result.blocks if "Body text" in b.text)
    assert body.kind == BlockKind.PARAGRAPH


def test_load_pdf_with_ocr_fallback_preserves_figures_from_text_pages(tmp_path: Path) -> None:
    # Regression: load_pdf_with_ocr_fallback's final CanonicalDoc construction
    # (ocr.py:103) omitted figures= entirely -- any PDF with at least one
    # non-text page silently lost every Figure object extracted from its
    # TEXT-bearing pages too, even though the FIGURE-kind Block survived.
    from app.loaders.ocr import load_pdf_with_ocr_fallback

    path = _build_mixed_text_and_scanned_pdf_with_figure(tmp_path)
    doc = load_pdf_with_ocr_fallback(str(path))

    figure_blocks = [b for b in doc.blocks if b.kind == BlockKind.FIGURE]
    assert len(figure_blocks) >= 1
    assert len(doc.figures) == len(figure_blocks)


def test_load_pdf_merges_a_table_continuing_across_a_page_break() -> None:
    from reportlab.lib.pagesizes import letter
    from reportlab.platypus import SimpleDocTemplate, Table as RLTable, TableStyle, Spacer
    from reportlab.lib import colors
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "cross_page_table.pdf"
        doc = SimpleDocTemplate(str(path), pagesize=letter)
        style = TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)])
        # Enough rows to force a real page break inside ONE reportlab Table
        # flowable -- reportlab itself splits it across pages, producing the
        # exact "same table, split by pdfplumber's own per-page find_tables()"
        # case this task fixes.
        rows = [["Code", "Meaning"]] + [[str(i), f"Reason {i}"] for i in range(60)]
        doc.build([RLTable(rows, style=style)])
        result = load_pdf(str(path))

    assert len(result.tables) == 1
    from app.canonical.model import plain_text_rows
    all_rows = plain_text_rows(result.tables[0])
    assert len(all_rows) == 61  # header + 60 rows, all in ONE table, not split
    assert all_rows[-1] == ["59", "Reason 59"]


# --- Review fix-round tests (Task 5 code review, 2026-08-13): Critical +
# Important 1/2/4 findings below all exercise `_tables_continue`/
# `_merge_continued_tables` directly with synthetic Table/TableCell/
# SourceRef objects rather than a real reportlab-generated PDF -- these
# are testing the MERGE LOGIC's own edge cases (empty structural signal,
# unrelated-but-same-shape tables, 3+ page chaining), not pdfplumber's
# geometry extraction, so a real PDF fixture would only add layout
# fragility without exercising anything the direct call doesn't already
# cover precisely.


def test_tables_continue_rejects_empty_xs_even_when_positionally_adjacent() -> None:
    """Critical fix: an empty `xs` list on either side (e.g. both tables
    hit `_build_pdf_table_grid`'s outer exception fallback, which sets
    xs=[]) must NOT vacuously pass the structural gate just because
    `len([]) == len([])` and `all(...)` over an empty `zip` is trivially
    True. Both tables sit well within the page-edge bands here (positional
    signal alone would pass) -- only the missing structural signal must
    reject the match."""
    from app.loaders.pdf_loader import _tables_continue

    page_height = 800.0
    assert _tables_continue([], 750.0, page_height, [], 50.0) is False


def test_merge_continued_tables_does_not_merge_unrelated_same_shape_tables() -> None:
    """Important 4a: two unrelated 2-column tables on consecutive pages,
    both positioned near their respective page edges (positional signal
    matches), but with clearly different column x-edges (structural signal
    does NOT match) -- must NOT merge. This is the exact risk the brief
    calls out: column COUNT alone is not a sufficient continuation
    signal."""
    from app.canonical.model import SourceRef, Table, TableCell
    from app.loaders.pdf_loader import _merge_continued_tables

    page_height = 800.0
    t0 = Table(
        id="t0",
        cells=[[TableCell(text="A"), TableCell(text="B")]],
        source_ref=SourceRef(document_path="doc.pdf", start_offset=0, end_offset=1, page=1),
    )
    t1 = Table(
        id="t1",
        cells=[[TableCell(text="X"), TableCell(text="Y")]],
        source_ref=SourceRef(document_path="doc.pdf", start_offset=0, end_offset=1, page=2),
    )
    table_xs_by_id = {"t0": [10.0, 100.0], "t1": [50.0, 140.0]}  # same count, clearly different positions
    table_bbox_by_id = {"t0": (0.0, 0.0, 200.0, 750.0), "t1": (0.0, 40.0, 200.0, 100.0)}

    merged = _merge_continued_tables([t0, t1], table_xs_by_id, table_bbox_by_id, page_height)

    assert [t.id for t in merged] == ["t0", "t1"]


def test_merge_continued_tables_chains_a_three_page_continuation_into_one_table() -> None:
    """Important 1: a table continuing across THREE pages must chain
    through two successive pairwise merges into ONE final table, not stop
    after the first merge. `Table.model_copy` never updates `source_ref`,
    so the merged table's own page stays page 1 forever -- without tracking
    the accumulating group's real tail page separately, the page-3 table's
    `this_page == prev_page + 1` check (3 == 1 + 1) would wrongly fail."""
    from app.canonical.model import SourceRef, Table, TableCell, plain_text_rows
    from app.loaders.pdf_loader import _merge_continued_tables

    page_height = 800.0
    xs = [10.0, 100.0]

    def _row(a: str, b: str, is_header: bool = False) -> list[TableCell]:
        return [TableCell(text=a, is_header=is_header), TableCell(text=b, is_header=is_header)]

    t0 = Table(
        id="t0",
        cells=[_row("h1", "h2", is_header=True), _row("r1", "r2")],
        source_ref=SourceRef(document_path="doc.pdf", start_offset=0, end_offset=1, page=1),
    )
    # Continuation tables carry `is_header=True` on their own first row too
    # -- `_build_pdf_table_grid` stamps every table's row 0 as a header
    # purely because it's row 0 of ITS OWN single-page extraction. Real
    # continuation rows, not headers -- see the Important 2 assertion below.
    t1 = Table(
        id="t1",
        cells=[_row("r3", "r4", is_header=True)],
        source_ref=SourceRef(document_path="doc.pdf", start_offset=0, end_offset=1, page=2),
    )
    t2 = Table(
        id="t2",
        cells=[_row("r5", "r6", is_header=True)],
        source_ref=SourceRef(document_path="doc.pdf", start_offset=0, end_offset=1, page=3),
    )
    table_xs_by_id = {"t0": xs, "t1": xs, "t2": xs}
    table_bbox_by_id = {
        "t0": (0.0, 0.0, 200.0, 750.0),  # bottom near page bottom
        "t1": (0.0, 40.0, 200.0, 750.0),  # top near page top AND bottom near page bottom
        "t2": (0.0, 40.0, 200.0, 200.0),  # top near page top
    }

    merged = _merge_continued_tables([t0, t1, t2], table_xs_by_id, table_bbox_by_id, page_height)

    assert len(merged) == 1
    rows = plain_text_rows(merged[0])
    assert rows == [["h1", "h2"], ["r1", "r2"], ["r3", "r4"], ["r5", "r6"]]
    # Important 2: only the FIRST table's real header row keeps
    # is_header=True -- both continuation tables' own (formerly row-0)
    # rows must be cleared, since they now sit mid-table.
    assert merged[0].cells[0][0].is_header is True
    assert all(cell.is_header is False for row in merged[0].cells[1:] for cell in row)


def test_load_pdf_survives_a_continuation_merge_failure() -> None:
    """Important 3: the `_merge_continued_tables` call site in `load_pdf`
    must be wrapped in try/except -- a malformed bbox/xs entry or any other
    unexpected error there must degrade to the unmerged per-page tables,
    never abort the whole document load (same 'never fail the ingest'
    guarantee every other risky path in this file already honors)."""
    with patch("app.loaders.pdf_loader._merge_continued_tables", side_effect=RuntimeError("boom")):
        doc = load_pdf(str(FIXTURES / "sample.pdf"))
    assert len(doc.tables) >= 1
