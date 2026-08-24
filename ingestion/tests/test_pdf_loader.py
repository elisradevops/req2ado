from pathlib import Path
from unittest.mock import patch

import pytest
from pypdf import PdfReader

from app.canonical.model import BlockKind, plain_text_rows
from app.loaders.pdf_loader import (
    _cell_background_color,
    _cell_ocr_recovery,
    _fontname_is_bold,
    _is_degenerate_pdf_image,
    _pdf_color_to_hex,
    cached_pdf_reader,
    load_pdf,
    ocr_image_to_text_filtered,
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


def test_ocr_image_to_text_filtered_drops_low_confidence_words() -> None:
    from unittest.mock import patch

    fake_data = {"text": ["Real", "watermark", ""], "conf": ["90", "5", "-1"]}
    with patch("app.loaders.pdf_loader.pytesseract.image_to_data", return_value=fake_data):
        from PIL import Image

        result = ocr_image_to_text_filtered(Image.new("RGB", (10, 10)), languages="eng", confidence_threshold=30)
    assert result == "Real"


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


class _StubPypdfImage:
    """Minimal stand-in for a pypdf ImageFile -- only the `.image.size`
    attribute chain `_is_degenerate_pdf_image` reads."""

    def __init__(self, size: tuple[int, int] | None) -> None:
        self.image = None if size is None else _StubPilImage(size)


class _StubPilImage:
    def __init__(self, size: tuple[int, int]) -> None:
        self.size = size


def test_is_degenerate_pdf_image_true_for_a_2x2_pixel_image() -> None:
    # Live-confirmed real-world shape: a PDF rendering-trick color-fill/
    # gradient-mask XObject, not a real figure -- see the constant's own
    # comment for the 808/918 real-document measurement this fixes.
    assert _is_degenerate_pdf_image(_StubPypdfImage((2, 2))) is True


def test_is_degenerate_pdf_image_false_for_a_realistic_figure_size() -> None:
    # Matches this test file's own pdf_with_figure.pdf fixture (10x10) --
    # must stay on the "keep it" side of the threshold.
    assert _is_degenerate_pdf_image(_StubPypdfImage((10, 10))) is False
    assert _is_degenerate_pdf_image(_StubPypdfImage((646, 602))) is False


def test_is_degenerate_pdf_image_false_when_only_one_dimension_is_tiny() -> None:
    # Deliberately not an area check -- a real thin decorative strip is left
    # to the vision significance filter, not silently dropped here.
    assert _is_degenerate_pdf_image(_StubPypdfImage((2, 400))) is False


def test_is_degenerate_pdf_image_fails_open_when_size_cannot_be_read() -> None:
    # None `.image` (a format pypdf couldn't decode at all) and a raising
    # `.image.size` must both default to "keep it" -- this is a cheap
    # pre-filter for a KNOWN degenerate shape, not a content-integrity
    # check, and dropping a real figure over a decode hiccup would be
    # strictly worse than an occasional wasted vision call.
    assert _is_degenerate_pdf_image(_StubPypdfImage(None)) is False

    class _RaisingImage:
        @property
        def size(self) -> tuple[int, int]:
            raise RuntimeError("corrupt image data")

    class _RaisingPypdfImage:
        image = _RaisingImage()

    assert _is_degenerate_pdf_image(_RaisingPypdfImage()) is False


def test_load_pdf_skips_a_degenerate_2x2_image_without_calling_describe_figure(monkeypatch: pytest.MonkeyPatch) -> None:
    # Integration-level regression for the real bug: injects one real
    # (10x10, kept) and one synthetic degenerate (2x2, skipped) image into
    # the same page's pypdf image list, via the same "kind == 'image'"
    # merged-entry path load_pdf's own main loop consumes -- proves the
    # degenerate one contributes neither a Figure, a [FIGURE: ...] block,
    # nor a describe_figure call, while the real one is unaffected.
    import app.loaders.pdf_loader as pdf_loader_module

    real_reader = cached_pdf_reader(str(FIXTURES / "pdf_with_figure.pdf"))
    real_page = real_reader.pages[0]
    real_image = next(iter(real_page.images))

    degenerate_image = _StubPypdfImage((2, 2))
    degenerate_image.data = b"\x00" * 4  # only read if describe_figure is (wrongly) called on it

    class _PageWithExtraImage:
        def __init__(self, wrapped) -> None:
            self._wrapped = wrapped

        @property
        def images(self):
            return [real_image, degenerate_image]

        def __getattr__(self, name):
            return getattr(self._wrapped, name)

    class _ReaderWithExtraImage:
        # Forwards everything except page 0's own `.images` to the REAL
        # reader (via __getattr__) -- so any other `cached_pdf_reader(path)`
        # call site in load_pdf (outline positions, page count, etc.) keeps
        # seeing genuine data; only the one image-extraction call site this
        # test targets sees the injected degenerate entry.
        def __init__(self, wrapped) -> None:
            self._wrapped = wrapped
            self._patched_pages = [_PageWithExtraImage(wrapped.pages[0])] + list(wrapped.pages[1:])

        @property
        def pages(self):
            return self._patched_pages

        def __getattr__(self, name):
            return getattr(self._wrapped, name)

    monkeypatch.setattr(
        pdf_loader_module,
        "cached_pdf_reader",
        lambda path: _ReaderWithExtraImage(cached_pdf_reader(path)),
    )

    describe_calls: list[bytes] = []

    def spy_describe(image_bytes: bytes) -> str:
        describe_calls.append(image_bytes)
        return "A schematic diagram."

    doc = load_pdf(str(FIXTURES / "pdf_with_figure.pdf"), describe_figure=spy_describe)

    assert len(doc.figures) == 1  # the degenerate image contributed nothing
    assert doc.figures[0].caption == "A schematic diagram."
    assert len(describe_calls) == 1  # never called on the 2x2 stub
    assert describe_calls[0] != degenerate_image.data
    figure_blocks = [b for b in doc.blocks if b.kind == BlockKind.FIGURE]
    assert len(figure_blocks) == 1


def test_load_pdf_suppresses_a_running_header_image_repeated_on_every_page() -> None:
    # Real gap this closes (Gap B): direct geometry probe against a real
    # 53-page ICD (cubeadcs_icd.pdf) found byte-identical small images
    # repeating in the page margin on most pages -- a doc-id/page marker
    # rendered as a raster image, the same class of artifact
    # _detect_boilerplate_templates already handles for TEXT headers/
    # footers. See build_repeating_header_image_fixture.py's own docstring.
    describe_calls: list[bytes] = []

    def spy_describe(image_bytes: bytes) -> str:
        describe_calls.append(image_bytes)
        return "A real diagram."

    doc = load_pdf(str(FIXTURES / "repeating_header_image.pdf"), describe_figure=spy_describe)

    assert len(doc.figures) == 1
    assert len(describe_calls) == 1
    figure_blocks = [b for b in doc.blocks if b.kind == BlockKind.FIGURE]
    assert len(figure_blocks) == 1


def test_load_pdf_suppresses_the_same_recurring_image_drawn_at_different_margin_positions() -> None:
    # Real gap this closes: direct geometry probe against cubeadcs_icd.pdf
    # found a single running-header logo drawn at three slightly different
    # (x0, top) coordinates across the document. Keying recurrence
    # detection on (hash, x0, top) split it into three under-threshold
    # groups instead of one, so it survived as 13 separate "figures"
    # instead of being suppressed. Here the same emblem is drawn at
    # position A on 5/10 pages and position B on 4/10 pages -- neither
    # individually clears the 60% recurrence threshold, but the combined
    # 9/10 does. Content-hash-only keying must suppress all 9 placements.
    doc = load_pdf(str(FIXTURES / "repeating_header_image_multi_position.pdf"))

    assert len(doc.figures) == 0
    figure_blocks = [b for b in doc.blocks if b.kind == BlockKind.FIGURE]
    assert len(figure_blocks) == 0


def test_load_pdf_boilerplate_gates_stay_independent_but_survivors_dedupe_by_content() -> None:
    # Over-merge safety net (direct analogue of
    # test_load_pdf_does_not_merge_a_genuinely_narrow_real_column): proves
    # the boilerplate suppression fix's two gates -- recurrence fraction
    # and margin position -- are each independently required, and are
    # unaffected by the separate content-dedup gate (Gap C, see
    # seen_figure_hashes). An image repeated on only 2/10 pages (below the
    # recurrence fraction) AND a distinct image repeated on 8/10 pages but
    # placed in the page BODY (outside the margin band) must both survive
    # SUPPRESSION -- neither is a running header/footer artifact. But
    # within each group the repeats are byte-identical, so content dedup
    # (a separate, later gate) still collapses each group to its first
    # occurrence: 2 distinct images -> 2 figures, not 10. This narrows the
    # old guarantee (nothing suppressed -> 10 figures) to the current one
    # (nothing suppressed as boilerplate -> repeats collapse by content).
    doc = load_pdf(str(FIXTURES / "repeating_header_image_safety_net.pdf"))
    assert len(doc.figures) == 2


def test_load_pdf_dedupes_a_body_figure_reused_on_a_few_pages_by_content() -> None:
    # Gap C: neither boilerplate gate can ever catch this case -- the
    # reused diagram appears on only 3/6 pages (below
    # _BOILERPLATE_RECURRENCE_FRACTION) and is placed in the page BODY, not
    # the margin. Confirmed live on cubeadcs_icd.pdf: a 215x212 graphic
    # recurred on 10/53 pages (19%) with only 4/10 placements in the
    # margin band -- invisible to both existing gates, over-counted as 10
    # figures instead of 1. This fixture's diagram repeats on pages 0/2/4;
    # pages 1/3/5 each carry their own distinct image, so the correct
    # result is 4 figures (1 reused + 3 unique) from 6 raw placements, not
    # 6 -- proving dedup collapses true repeats without merging distinct
    # images that merely share a page role.
    doc = load_pdf(str(FIXTURES / "reused_body_diagram.pdf"))
    assert len(doc.figures) == 4


def test_load_pdf_keeps_figure_ids_contiguous_when_a_repeating_image_is_suppressed() -> None:
    doc = load_pdf(str(FIXTURES / "repeating_header_image.pdf"))
    assert [f.id for f in doc.figures] == ["f0"]
    figure_blocks = [b for b in doc.blocks if b.kind == BlockKind.FIGURE]
    assert len(figure_blocks) == 1


def test_load_pdf_flags_filled_acroform_fields_with_a_note() -> None:
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.pagesizes import letter
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "form.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        c.drawString(72, 700, "Static label text.")
        form = c.acroForm
        form.textfield(name="approver", tooltip="Approver", x=72, y=650, width=200, height=20, value="J. Smith")
        c.save()
        result = load_pdf(str(path))

    note_blocks = [b for b in result.blocks if b.kind == BlockKind.NOTE]
    assert len(note_blocks) == 1
    assert "approver" in note_blocks[0].text
    assert "J. Smith" in note_blocks[0].text


def test_load_pdf_no_note_when_document_has_no_acroform() -> None:
    # Regression guard: get_fields() returns None (not {}) on a document
    # with no AcroForm at all -- must not raise or misbehave.
    result = load_pdf(str(FIXTURES / "sample.pdf"))
    assert not any(b.kind == BlockKind.NOTE for b in result.blocks)


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
    # signal, not asserted blindly: this fixture's own table is found via
    # the lines-strategy pass (pdfplumber's own TableSettings default,
    # confirmed by reading table.py's source) because real ruling lines
    # exist -- Task 7 added an ADDITIONAL text-strategy pass on the same
    # page (see that pass's own docstring), but this fixture's table is
    # already claimed by the lines-strategy bbox, so it is never
    # double-detected or re-classified.
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


def test_load_pdf_bullet_glyph_line_is_not_classified_as_a_heading() -> None:
    # Finding 1 of this plan's whole-branch review, LIVE-REPRODUCED exactly
    # by this fixture against the pre-fix code:
    #     paragraph  The interface shall satisfy the following requirements.
    #     heading   lvl=1 lbl='1' :: n        <- the bullet glyph
    #     paragraph  provide redundant 28 VDC power to each LRU
    #     heading   lvl=1 lbl='2' :: n
    # A Word/LibreOffice-exported bulleted list renders each bullet as its
    # own symbol-font glyph at its own size (12pt ZapfDingbats "n" here vs
    # 10pt Helvetica body -- confirmed as exactly what pdfplumber extracts
    # from this fixture), which pdfplumber clusters as its OWN line. That
    # made every bullet a font-size outlier, classified HEADING, each
    # consuming a real ordinal from _advance_heading_counter that a genuine
    # heading should have received -- and (via resolve_block_depth ->
    # _split_into_branches) a bogus top-level branch boundary whose junk
    # outline entry then leaked into every branch's global_context.
    # `_can_be_heading_text`'s content gate is what rejects it: zero
    # alphanumeric characters, and not parse_numbering-parseable.
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.pagesizes import letter
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "bulleted_list.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        c.setFont("Helvetica", 10)
        c.drawString(72, 730, "The interface shall satisfy the following requirements.")
        for i, body in enumerate(
            [
                "provide redundant 28 VDC power to each LRU",
                "report a fault within 500 milliseconds",
                "survive a single-point power interruption",
            ]
        ):
            c.setFont("Symbol", 12)  # a real symbol-font bullet, larger than body text
            c.drawString(72, 700 - i * 20, "\267")
            c.setFont("Helvetica", 10)
            c.drawString(90, 700 - i * 20, body)
        c.setFont("Helvetica", 10)
        c.drawString(72, 620, "Additional body text at the normal document size here.")
        c.drawString(72, 605, "And one more body line at the normal document size.")
        c.save()
        result = load_pdf(str(path))

    # No bullet glyph line anywhere became a heading, and no ordinal was
    # fabricated for one -- the whole document has no real heading at all.
    assert not any(b.kind == BlockKind.HEADING for b in result.blocks)
    # Each bulleted item's own body text is still emitted, as a PARAGRAPH.
    for body in ("redundant 28 VDC power", "fault within 500 milliseconds", "single-point power interruption"):
        block = next(b for b in result.blocks if body in b.text)
        assert block.kind == BlockKind.PARAGRAPH


def test_load_pdf_drop_cap_line_is_not_classified_as_a_heading() -> None:
    # Same finding, second shape: a drop-cap/large-first-letter paragraph
    # (first character 11pt, the other ~54 characters of the SAME line 10pt)
    # became a HEADING under the old "first non-empty char's size wins"
    # `_line_size` rule -- the whole paragraph promoted, and an ordinal
    # fabricated for it, because of one leading glyph. `_line_size` now uses
    # the line's MODAL char size, so the 53 body characters decide the
    # line's size, not the single drop cap. (The content gate alone cannot
    # save this case -- the text has plenty of alphanumeric characters --
    # which is why both halves of the fix are needed.)
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.pagesizes import letter
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "drop_cap.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        c.setFont("Helvetica", 11)
        c.drawString(72, 700, "T")
        c.setFont("Helvetica", 10)
        c.drawString(80, 700, "he interface shall satisfy the following requirements.")
        c.drawString(72, 680, "Additional body text at the normal document size here.")
        c.drawString(72, 660, "And one more body line at the normal document size.")
        c.save()
        result = load_pdf(str(path))

    drop_cap_line = next(b for b in result.blocks if "interface shall satisfy" in b.text)
    assert drop_cap_line.kind == BlockKind.PARAGRAPH
    assert drop_cap_line.number_label is None
    assert not any(b.kind == BlockKind.HEADING for b in result.blocks)


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


def test_load_pdf_table_structural_failure_emits_unsupported_note() -> None:
    """Task 6: when `_build_pdf_table_grid`'s structural walk throws, the
    table-level fallback (same call site as
    test_load_pdf_survives_a_continuation_merge_failure's precedent, one
    layer down) still degrades to a flat bare-cells grid -- but must ALSO
    emit an "[UNSUPPORTED: ...]" NOTE block, so downstream leveling (Task 1's
    `_is_unsupported_content_note` machinery) surfaces this as a reviewable
    IntegrityWarning instead of silently losing the span/gap information."""
    with patch("app.loaders.pdf_loader._build_pdf_table_grid", side_effect=RuntimeError("boom")):
        doc = load_pdf(str(FIXTURES / "sample.pdf"))
    # The degraded-grid fallback itself must still succeed (table extraction
    # doesn't fail outright).
    assert len(doc.tables) >= 1
    note_blocks = [b for b in doc.blocks if b.kind == BlockKind.NOTE]
    assert any(
        b.text.startswith("[UNSUPPORTED: table extraction degraded structure")
        for b in note_blocks
    )


# ---------------------------------------------------------------------------
# Phase 3c (Task 7, docs/superpowers/sdd/2026-08-13-pdf-ingestion-fidelity):
# borderless (text-strategy) table detection + chopped-word-boundary
# validation. Before this task, table detection was 100% ruling-line-based
# (page.find_tables() default "lines" strategy) -- a real borderless table
# (no ruling lines drawn at all) was never detected as a table. Naive
# text-strategy detection alone is dangerous -- confirmed live this session
# against a real government ICD: it can shred ordinary wrapped prose into a
# fake table (cells split mid-word). The chopped-word-boundary check below is
# the validated rejection rule that keeps text-strategy detection safe.
# ---------------------------------------------------------------------------


def test_load_pdf_detects_a_borderless_table_via_text_strategy() -> None:
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas as rl_canvas
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "borderless_table.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        # A real, consistently-aligned borderless table -- same x-positions
        # per column across every row, no ruling lines drawn at all.
        rows = [("Code", "Meaning"), ("01", "Rejected"), ("02", "Accepted"), ("03", "Pending")]
        y = 700
        for code, meaning in rows:
            c.drawString(72, y, code)
            c.drawString(150, y, meaning)
            y -= 20
        c.save()
        result = load_pdf(str(path))

    assert len(result.tables) == 1
    from app.canonical.model import plain_text_rows
    assert plain_text_rows(result.tables[0])[0] == ["Code", "Meaning"]
    assert result.tables[0].border_style is None  # no ruling lines exist -- must not be "grid"


def test_load_pdf_rejects_a_prose_page_mistaken_for_a_borderless_table() -> None:
    # Regression guard for the confirmed false-positive shape: ordinary
    # prose must never be shredded into a fake table.
    #
    # FIX-ROUND NOTE: the brief's own literal fixture for this test (a
    # single reportlab `Paragraph` flowable, wrapped normally) was tried
    # first and found to NOT actually exercise the validation layer at
    # all -- confirmed live: pdfplumber's text-strategy find_tables()
    # returns ZERO candidates for that fixture's geometry (wrapped-paragraph
    # line starts don't recur at a second x-position across enough lines to
    # register as a second column), so `result.tables == []` held true with
    # or without `_table_has_chopped_word` even being wired up -- a vacuous
    # pass that would never have caught a regression.
    #
    # This fixture instead reproduces the REAL verified false-positive shape
    # directly (lvc_gateway_icd.pdf page 8: a word split into a short first
    # fragment at one x-position and its remainder at a second, consistent
    # x-position, across multiple lines) -- CONFIRMED live this session:
    # this produces a real (2-column, 6-row) text-strategy find_tables()
    # candidate whose first row is exactly ['F', 'or'], which DOES trip
    # `_table_has_chopped_word`. Without the chopped-word validation layer,
    # this test fails (a fake 2-column table is produced); with it wired up,
    # it correctly passes -- a genuine, not vacuous, regression guard.
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.pagesizes import letter
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "prose_only.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        c.setFont("Helvetica", 10)
        rows = [
            ("F", "or some tests or simulations will be used."),
            ("T", "he following section describes results."),
            ("N", "ote that additional information applies."),
        ]
        y = 700
        for first, rest in rows:
            c.drawString(72, y, first)
            c.drawString(90, y, rest)
            y -= 20
        c.save()
        result = load_pdf(str(path))

    assert result.tables == []


def test_load_pdf_two_ruled_tables_with_aligned_columns_do_not_produce_a_bogus_third_table() -> None:
    # Fix-round regression guard (Task 7 review finding): the text-strategy
    # double-detection guard originally rejected a candidate only when it
    # was FULLY CONTAINED inside one lines-strategy bbox (`_inside_any_bbox`,
    # a pre-existing helper built for a different purpose -- stripping
    # table-region LINES out of paragraph text, not this overlap check).
    # LIVE-REPRODUCED failure this guards against: two separate ruled tables
    # at the SAME column x-positions (routine in real ICDs -- two similarly-
    # shaped spec tables stacked with a gap between them) makes
    # find_tables(text strategy) return ONE candidate spanning BOTH real
    # tables' combined bbox -- not contained in EITHER individual
    # lines-strategy bbox alone, so the old containment check let it
    # through as a third, bogus, duplicate-content table (3 tables:
    # ["grid", None, "grid"], the middle one duplicating both real tables'
    # rows). The fix (`_bboxes_overlap`, a real intersection test) rejects
    # any text-strategy candidate that overlaps ANY lines-strategy bbox at
    # all, not just one it's fully inside.
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.platypus import SimpleDocTemplate, Spacer, Table as RLTable, TableStyle
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "two_ruled_tables.pdf"
        doc = SimpleDocTemplate(str(path), pagesize=letter)
        style = TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)])
        t1 = RLTable([["Rail", "Voltage"], ["3V3", "3.3"]], style=style, colWidths=[100, 100])
        t2 = RLTable([["Rail", "Voltage"], ["5V", "5.0"]], style=style, colWidths=[100, 100])
        doc.build([t1, Spacer(1, 20), t2])
        result = load_pdf(str(path))

    from app.canonical.model import plain_text_rows
    assert len(result.tables) == 2
    assert all(t.border_style == "grid" for t in result.tables)
    assert plain_text_rows(result.tables[0]) == [["Rail", "Voltage"], ["3V3", "3.3"]]
    assert plain_text_rows(result.tables[1]) == [["Rail", "Voltage"], ["5V", "5.0"]]


def test_load_pdf_attaches_a_table_caption_from_the_preceding_line() -> None:
    from reportlab.lib.pagesizes import letter
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Table as RLTable, TableStyle
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib import colors
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "captioned_table.pdf"
        styles = getSampleStyleSheet()
        doc = SimpleDocTemplate(str(path), pagesize=letter)
        style = TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)])
        doc.build([
            Paragraph("Table 3.4: Response Codes", styles["BodyText"]),
            RLTable([["Code", "Meaning"], ["01", "Rejected"]], style=style),
        ])
        result = load_pdf(str(path))

    assert len(result.tables) == 1
    assert result.tables[0].caption == "Response Codes"
    # The caption line is NOT also emitted as its own PARAGRAPH block.
    assert not any("Table 3.4" in b.text for b in result.blocks if b.kind == BlockKind.PARAGRAPH)


def test_load_pdf_flags_a_suspected_multi_column_page() -> None:
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas as rl_canvas
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "two_col.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        c.setFont("Helvetica", 12)
        y = 700
        for i in range(6):
            c.drawString(72, y - i * 20, f"LEFT-{i} column text line here")
            c.drawString(320, y - i * 20, f"RIGHT-{i} column text line here")
        c.save()
        result = load_pdf(str(path))

    note_blocks = [b for b in result.blocks if b.kind == BlockKind.NOTE and "multi-column" in b.text]
    assert len(note_blocks) == 1


def test_load_pdf_does_not_flag_an_asymmetric_two_column_page() -> None:
    # Pins a documented trade-off of the independent-per-side height check
    # in `_detect_suspected_column_gap` (see that function's own docstring):
    # fixing the real false positive on tests/test_pdf_survey_golden.py's
    # golden fixture (a centered heading misread as a "second column")
    # required each side of a candidate gap to independently span
    # _COLUMN_GAP_MIN_HEIGHT_FRACTION of the page's text height, not just
    # the two sides' combined span. LIVE-VERIFIED break-even: on this same
    # 6-row-equivalent layout, a right column with 4+ rows (>=64% of the
    # left column's height) IS still flagged; a right column with 3 rows
    # (~46%, below the 0.5 threshold) is NOT. This is the accepted cost of
    # that fix, not a bug -- a real 2-column page where one column happens
    # to run noticeably shorter than the other goes undetected. Deliberately
    # asserting the NEGATIVE here so a future "fix" back to a combined-span
    # check doesn't silently re-break the golden test above.
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas as rl_canvas
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "asymmetric_two_col.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        c.setFont("Helvetica", 12)
        y = 700
        for i in range(6):
            c.drawString(72, y - i * 20, f"LEFT-{i} column text line here")
            if i < 3:
                c.drawString(320, y - i * 20, f"RIGHT-{i} column text line here")
        c.save()
        result = load_pdf(str(path))

    assert not any(b.kind == BlockKind.NOTE and "multi-column" in b.text for b in result.blocks)


def test_load_pdf_does_not_flag_a_wide_table_column_as_multi_column() -> None:
    # Regression guard for a confirmed real false candidate: a wide table
    # column produces a large x-gap with no real column boundary.
    from reportlab.lib.pagesizes import letter
    from reportlab.platypus import SimpleDocTemplate, Table as RLTable, TableStyle
    from reportlab.lib import colors
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "wide_table.pdf"
        doc = SimpleDocTemplate(str(path), pagesize=letter)
        style = TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)])
        doc.build([RLTable([["Narrow", "A much wider column with more text content in it"]], style=style, colWidths=[80, 380])])
        result = load_pdf(str(path))

    assert not any(b.kind == BlockKind.NOTE and "multi-column" in b.text for b in result.blocks)


def test_load_pdf_text_only_never_flags_multi_column() -> None:
    # Finding 2 of this plan's whole-branch review: `text_only=True` skips
    # find_tables() entirely, so `table_bboxes` is always empty and the
    # multi-column detector's mandatory table carve-out can never fire in
    # that mode -- a genuine 2-column ruled table would emit a spurious
    # multi-column NOTE that then leaks into docx_pagination.py's
    # page-alignment text blob (the only caller of load_pdf(text_only=True)).
    # The detection call is therefore skipped outright under text_only. This
    # test pins BOTH halves against the exact same file: normal mode still
    # flags it, text_only mode never does -- so a future revert can't
    # silently restore the leak while still passing the positive test above.
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas as rl_canvas
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "two_col_text_only.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        c.setFont("Helvetica", 12)
        y = 700
        for i in range(6):
            c.drawString(72, y - i * 20, f"LEFT-{i} column text line here")
            c.drawString(320, y - i * 20, f"RIGHT-{i} column text line here")
        c.save()
        normal = load_pdf(str(path))
        text_only = load_pdf(str(path), text_only=True)

    assert any(b.kind == BlockKind.NOTE and "multi-column" in b.text for b in normal.blocks)
    assert not any(b.kind == BlockKind.NOTE and "multi-column" in b.text for b in text_only.blocks)


def test_load_pdf_does_not_flag_a_title_page_label_value_layout() -> None:
    # Regression guard for the SECOND confirmed real false candidate: a
    # cover-page label/value pair (e.g. "Prepared for:      ISTP Project")
    # produces a large gap on ONE line, not a real column boundary spanning
    # most of the page.
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas as rl_canvas
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "label_value.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        c.setFont("Helvetica", 12)
        c.drawString(72, 700, "Prepared for:")
        c.drawString(300, 700, "ISTP Project")
        c.drawString(72, 680, "A single normal body paragraph below the label/value line.")
        c.save()
        result = load_pdf(str(path))

    assert not any(b.kind == BlockKind.NOTE and "multi-column" in b.text for b in result.blocks)


def test_cell_ocr_recovery_skips_a_uniform_blank_crop_without_calling_ocr() -> None:
    from unittest.mock import patch

    from PIL import Image

    blank_page = Image.new("RGB", (1000, 1000), color="white")
    cache: dict[int, Image.Image] = {0: blank_page}
    with patch(
        "app.loaders.pdf_loader.pytesseract.image_to_data",
        side_effect=AssertionError("OCR must not be called for a uniform/blank crop"),
    ):
        result = _cell_ocr_recovery("unused.pdf", 0, (10.0, 10.0, 100.0, 40.0), "eng", cache)
    assert result == ""


def test_cell_ocr_recovery_reaches_ocr_with_a_correctly_scaled_and_inset_crop() -> None:
    from unittest.mock import patch

    from PIL import Image

    # Real per-pixel noise (not a hand-drawn shape) guarantees the crop is
    # non-uniform regardless of exact inset/scale rounding, so this test
    # only needs to assert the crop SIZE reaching OCR, not its content.
    page_image = Image.effect_noise((400, 400), 60).convert("RGB")
    cache: dict[int, Image.Image] = {0: page_image}
    captured: dict[str, tuple[int, int]] = {}

    def fake_ocr(image: Image.Image, languages: str) -> str:
        captured["size"] = image.size
        return "RECOVERED"

    with patch("app.loaders.pdf_loader.ocr_image_to_text_filtered", side_effect=fake_ocr):
        result = _cell_ocr_recovery("unused.pdf", 0, (10.0, 10.0, 100.0, 40.0), "eng", cache)

    assert result == "RECOVERED"
    scale = 200 / 72
    expected_width = (100.0 - 2.0 - (10.0 + 2.0)) * scale
    expected_height = (40.0 - 2.0 - (10.0 + 2.0)) * scale
    assert abs(captured["size"][0] - expected_width) <= 1
    assert abs(captured["size"][1] - expected_height) <= 1


def test_cell_ocr_recovery_returns_empty_string_when_ocr_finds_nothing() -> None:
    from unittest.mock import patch

    from PIL import Image

    page_image = Image.effect_noise((400, 400), 60).convert("RGB")
    cache: dict[int, Image.Image] = {0: page_image}
    with patch("app.loaders.pdf_loader.ocr_image_to_text_filtered", return_value=""):
        result = _cell_ocr_recovery("unused.pdf", 0, (10.0, 10.0, 100.0, 40.0), "eng", cache)
    assert result == ""


def test_cell_ocr_recovery_renders_the_page_once_and_caches_it() -> None:
    from unittest.mock import patch

    from PIL import Image

    page_image = Image.effect_noise((400, 400), 60).convert("RGB")
    cache: dict[int, Image.Image] = {}
    with patch("app.loaders.pdf_loader.convert_from_path", return_value=[page_image]) as mock_convert, \
         patch("app.loaders.pdf_loader.ocr_image_to_text_filtered", return_value="x"):
        _cell_ocr_recovery("some.pdf", 2, (10.0, 10.0, 100.0, 40.0), "eng", cache)
        _cell_ocr_recovery("some.pdf", 2, (110.0, 10.0, 200.0, 40.0), "eng", cache)
    mock_convert.assert_called_once_with("some.pdf", first_page=3, last_page=3)
    assert 2 in cache


def test_build_pdf_table_grid_calls_ocr_recovery_only_for_empty_text_cells() -> None:
    from unittest.mock import patch

    calls: list[tuple[float, float, float, float]] = []

    def fake_recovery(path, page_index, bbox, languages, cache):
        calls.append(bbox)
        return "RECOVERED" if bbox == (281.0, 78.0, 431.0, 96.0) else ""

    with patch("app.loaders.pdf_loader._cell_ocr_recovery", side_effect=fake_recovery):
        doc = load_pdf(str(FIXTURES / "table_with_blank_cell.pdf"))

    # Exactly one call: the single genuinely-empty-text grid position in
    # this fixture (row 2, col 1) -- every other cell already has real
    # pdfplumber-extracted text and must never reach OCR recovery at all.
    assert len(calls) == 1
    flat = [cell for row in doc.tables[0].cells for cell in row]
    recovered_cells = [c for c in flat if c is not None and c.text == "RECOVERED"]
    assert recovered_cells == []  # this fixture's one empty cell is genuinely blank, fake_recovery returns "" for it


def test_table_ocr_recovery_recovers_an_image_only_header_cell_end_to_end() -> None:
    # Real pytesseract call, no mocking -- proves the whole path (render,
    # inset crop, pre-check, OCR, confidence filter, write-back,
    # ocr_recovered flag) works together against a real PDF, the way
    # cubeadcs_icd.pdf's real header cells needed it to.
    doc = load_pdf(str(FIXTURES / "table_with_image_header.pdf"))
    assert len(doc.tables) == 1
    header_cell = doc.tables[0].cells[0][1]
    assert header_cell is not None
    assert "Label" in header_cell.text
    assert header_cell.ocr_recovered is True

    # The same fixture's other empty-text cell (row 2, col 1) has no image
    # behind it at all -- genuinely blank, must be left alone even though
    # it hit the identical "empty extracted text" code path as the
    # recovered cell above.
    blank_cell = doc.tables[0].cells[2][1]
    assert blank_cell is not None
    assert blank_cell.text == ""
    assert blank_cell.ocr_recovered is False


def test_table_ocr_recovery_never_calls_ocr_for_a_genuinely_blank_cell() -> None:
    from unittest.mock import patch

    # A dedicated fixture with ONLY a genuinely blank cell (no embedded
    # image anywhere) -- the mock raises if the pre-check ever lets a real
    # OCR call through for it, proving the inset+stddev pre-check (Task 5)
    # actually skips real blank cells rather than merely returning "" after
    # a wasted real OCR attempt.
    with patch(
        "app.loaders.pdf_loader.pytesseract.image_to_data",
        side_effect=AssertionError("OCR must never be called for a genuinely blank cell"),
    ):
        doc = load_pdf(str(FIXTURES / "table_with_blank_cell.pdf"))
    blank_cell = doc.tables[0].cells[2][1]
    assert blank_cell is not None
    assert blank_cell.text == ""
    assert blank_cell.ocr_recovered is False


def test_cell_ocr_recovery_failure_does_not_degrade_the_whole_table() -> None:
    # A real exception from convert_from_path (e.g. a poppler crash) must be
    # contained to the one cell attempting recovery -- _cell_ocr_recovery's
    # own docstring already claims "never raises"; this proves it, and
    # proves the containment matters: an uncaught exception here propagates
    # through _build_pdf_table_grid and degrades the ENTIRE table to the
    # bare-cells fallback (losing colspan/rowspan/styling for every cell),
    # not just the one cell whose OCR recovery failed.
    with patch(
        "app.loaders.pdf_loader.convert_from_path",
        side_effect=RuntimeError("boom"),
    ):
        doc = load_pdf(str(FIXTURES / "table_with_blank_cell.pdf"))

    assert len(doc.tables) == 1
    # column_widths is only populated by the real structured grid build --
    # the bare-cells degraded fallback always leaves it None (see
    # _build_pdf_table_grid's caller in load_pdf).
    assert doc.tables[0].column_widths is not None
    assert not any("table extraction degraded structure" in b.text for b in doc.blocks)


def test_languages_survives_end_to_end_to_the_real_tesseract_call() -> None:
    # Proves a non-default `languages` value survives the whole
    # load_pdf -> _build_pdf_table_grid -> _cell_ocr_recovery ->
    # ocr_image_to_text_filtered -> pytesseract.image_to_data chain, not
    # just the first hop (every intermediate function already threads
    # `languages` through by signature, but nothing previously asserted the
    # value actually arrives at the real Tesseract call unchanged).
    captured_kwargs: dict[str, object] = {}

    def fake_image_to_data(image, **kwargs):
        captured_kwargs.update(kwargs)
        return {"text": ["Label"], "conf": ["90"]}

    with patch(
        "app.loaders.pdf_loader.pytesseract.image_to_data",
        side_effect=fake_image_to_data,
    ):
        load_pdf(str(FIXTURES / "table_with_image_header.pdf"), languages="heb+eng")

    assert captured_kwargs.get("lang") == "heb+eng"


def test_load_pdf_snaps_away_decorative_inset_rects_producing_a_clean_grid() -> None:
    # Real, root-caused bug (confirmed against cubeadcs_icd.pdf's "Table 26:
    # Harness Details"): a PDF that draws a styled/shaded cell as TWO NESTED
    # filled rects (a real outer cell + a decorative inset a few points
    # inside it) makes pdfplumber's default snap_x_tolerance (3pt) treat the
    # inner rect's own edges as real extra column/row boundaries -- ghost
    # columns in any row using this style, and a header row split into two
    # grid rows when the decorative fill is drawn as two stacked
    # half-height rects. _DECORATIVE_RECT_SNAP_TOLERANCE fixes both by
    # snapping the decorative inner edges onto the real outer boundary.
    doc = load_pdf(str(FIXTURES / "decorative_rect_table.pdf"))
    assert len(doc.tables) == 1
    rows = plain_text_rows(doc.tables[0])
    assert rows == [
        ["ID", "Name", "Value"],
        ["1", "Alice", "100"],
        ["2", "Bob", "200"],
    ]
    # No spanned (None) or empty-text ghost cells anywhere -- a clean,
    # fully-populated 3x3 grid, not just "the right text somewhere in a
    # bloated grid."
    for row in doc.tables[0].cells:
        assert len(row) == 3
        assert all(cell is not None and cell.text.strip() for cell in row)


def test_load_pdf_does_not_merge_a_genuinely_narrow_real_column() -> None:
    # Safety net for _DECORATIVE_RECT_SNAP_TOLERANCE: proves the tolerance
    # bump doesn't blindly merge two REAL, close-together column boundaries
    # -- only the decorative-inset pattern it targets. This fixture's
    # narrow "Flag" column (18pt, plain stroked borders, no decorative
    # fill) must stay its own distinct column, not get absorbed into a
    # neighbor.
    doc = load_pdf(str(FIXTURES / "narrow_column_table.pdf"))
    assert len(doc.tables) == 1
    cells = doc.tables[0].cells
    assert len(cells[0]) == 3  # still 3 columns, not merged down to 2
    # The narrow column's own data cells ('Y'/'N') stay isolated in their
    # own cell -- proof they weren't swallowed into the "Value" column.
    assert cells[1][1] is not None and cells[1][1].text.strip() == "Y"
    assert cells[2][1] is not None and cells[2][1].text.strip() == "N"


def _build_pdf_with_image_and_line(tmp_dir: Path, image_y: float, image_height: float, line_y: float | None, line_text: str | None) -> Path:
    """Draws a single 150x150 image at (100, image_y) and, if `line_text` is
    given, one text line at (100, line_y) -- low-level canvas positioning
    (not platypus flow) so the vertical gap between image bottom and
    caption top is exact and known, the same technique
    build_repeating_header_image_fixture.py already uses for margin-band
    control. Geometry confirmed empirically: an image at y=400 height=100
    plus a line at y=375 produces pdfplumber bbox bottom=392.0 and line
    top=407.484 -- a ~15.5pt gap, comfortably inside
    _FIGURE_CAPTION_MAX_GAP_POINTS (40pt)."""
    from PIL import Image as PILImage
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas as rl_canvas

    image_path = tmp_dir / "figure.png"
    PILImage.new("RGB", (150, 150), color="blue").save(image_path)
    out_path = tmp_dir / "figure_with_line.pdf"
    c = rl_canvas.Canvas(str(out_path), pagesize=letter)
    c.drawImage(str(image_path), 100, image_y, width=150, height=image_height)
    if line_text is not None:
        c.drawString(100, line_y, line_text)
    c.showPage()
    c.save()
    return out_path


def test_load_pdf_names_a_figure_from_its_own_caption_line(tmp_path: Path) -> None:
    # Task 4: the document's own "Figure N: Title" line, sitting just below
    # the image, becomes Figure.name -- verified against real geometry
    # measured on cubeadcs_icd.pdf (image->caption gaps consistently ~16pt).
    out_path = _build_pdf_with_image_and_line(tmp_path, image_y=400, image_height=100, line_y=375, line_text="Figure 1: Panel Layout Diagram")
    doc = load_pdf(str(out_path))
    assert len(doc.figures) == 1
    assert doc.figures[0].name == "Panel Layout Diagram"
    # Linked, not duplicated -- the caption line is not ALSO its own
    # standalone paragraph block, same contract as table captions.
    paragraph_texts = [b.text for b in doc.blocks if b.kind == BlockKind.PARAGRAPH]
    assert not any("Figure 1" in t for t in paragraph_texts)


def test_load_pdf_does_not_treat_a_toc_dot_leader_line_as_a_figure_caption(tmp_path: Path) -> None:
    # Task 4: a table-of-contents entry has the same "Figure N: Title"
    # shape but trails dot leaders and a page number -- confirmed live,
    # cubeadcs_icd.pdf's own TOC page contributes 41 such lines. Must never
    # be read as this image's real name.
    out_path = _build_pdf_with_image_and_line(
        tmp_path, image_y=400, image_height=100, line_y=375,
        line_text="Figure 1: Panel Layout Diagram .................... 12",
    )
    doc = load_pdf(str(out_path))
    assert len(doc.figures) == 1
    assert doc.figures[0].name is None


def test_load_pdf_leaves_figure_name_none_when_no_caption_line_exists(tmp_path: Path) -> None:
    # Task 4: an image with nothing caption-shaped nearby keeps name=None
    # -- the document's own naming is opportunistic, not assumed present.
    out_path = _build_pdf_with_image_and_line(tmp_path, image_y=400, image_height=100, line_y=None, line_text=None)
    doc = load_pdf(str(out_path))
    assert len(doc.figures) == 1
    assert doc.figures[0].name is None
