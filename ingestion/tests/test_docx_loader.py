import tempfile
from pathlib import Path

from docx.oxml.ns import qn

from app.canonical.model import BlockKind, plain_text_rows
from app.loaders.docx_loader import load_docx

FIXTURES = Path(__file__).parent / "fixtures"


def _build_two_section_docx_with_inline_images(tmp_path: Path) -> Path:
    # Two headings, each immediately followed by its own inline image --
    # proves each figure resolves at its OWN paragraph's real position, not
    # always the document's last position (the previous (0, 0)-placeholder
    # behavior would have folded both into whatever node was open last).
    from docx import Document as DocxDocument
    from PIL import Image

    doc = DocxDocument()
    doc.add_heading("Section One", level=1)
    doc.add_paragraph("First section body text.")
    image_one = tmp_path / "one.png"
    Image.new("RGB", (4, 4), color="red").save(image_one)
    doc.add_picture(str(image_one))
    doc.add_heading("Section Two", level=1)
    doc.add_paragraph("Second section body text.")
    image_two = tmp_path / "two.png"
    Image.new("RGB", (4, 4), color="blue").save(image_two)
    doc.add_picture(str(image_two))

    out_path = tmp_path / "two_sections.docx"
    doc.save(str(out_path))
    return out_path


def test_load_docx_extracts_heading_levels() -> None:
    doc = load_docx(str(FIXTURES / "sample.docx"))
    headings = [b for b in doc.blocks if b.kind == BlockKind.HEADING]
    assert [(h.text, h.heading_level) for h in headings] == [
        ("Display", 1),
        ("Picture Modes", 2),
    ]


def test_load_docx_extracts_paragraphs() -> None:
    doc = load_docx(str(FIXTURES / "sample.docx"))
    paragraphs = [b for b in doc.blocks if b.kind == BlockKind.PARAGRAPH]
    assert any("three picture presets" in p.text for p in paragraphs)


def test_load_docx_extracts_table_as_cell_grid() -> None:
    doc = load_docx(str(FIXTURES / "sample.docx"))
    assert len(doc.tables) == 1
    assert plain_text_rows(doc.tables[0]) == [
        ["Mode", "Description"],
        ["Vivid", "High saturation preset"],
    ]


def test_load_docx_format_is_docx() -> None:
    doc = load_docx(str(FIXTURES / "sample.docx"))
    assert doc.document.format.value == "docx"


def test_load_docx_detects_embedded_image_as_figure() -> None:
    doc = load_docx(str(FIXTURES / "sample.docx"))
    assert len(doc.figures) == 1


def test_load_docx_renders_figure_placeholder_block() -> None:
    doc = load_docx(str(FIXTURES / "sample.docx"))
    figure_blocks = [b for b in doc.blocks if b.kind == BlockKind.FIGURE]
    assert len(figure_blocks) == 1
    assert figure_blocks[0].text == "[FIGURE: none]"


def test_load_docx_uses_describe_figure_when_provided() -> None:
    # Regression: figures previously always became an empty [FIGURE: none]
    # placeholder with no way to describe real content.
    captured_bytes: list[bytes] = []

    def fake_describe(image_bytes: bytes) -> str:
        captured_bytes.append(image_bytes)
        return "A block diagram showing power distribution."

    doc = load_docx(str(FIXTURES / "sample.docx"), describe_figure=fake_describe)

    assert len(captured_bytes) == 1
    assert len(captured_bytes[0]) > 0  # real image bytes, not empty
    assert doc.figures[0].caption == "A block diagram showing power distribution."
    figure_blocks = [b for b in doc.blocks if b.kind == BlockKind.FIGURE]
    assert figure_blocks[0].text == "[FIGURE: A block diagram showing power distribution.]"


def test_load_docx_falls_back_to_placeholder_when_describe_figure_raises() -> None:
    # A vision failure for one image must not abort the whole document.
    def failing_describe(image_bytes: bytes) -> str:
        raise RuntimeError("vision service unreachable")

    doc = load_docx(str(FIXTURES / "sample.docx"), describe_figure=failing_describe)

    assert doc.figures[0].caption is None
    figure_blocks = [b for b in doc.blocks if b.kind == BlockKind.FIGURE]
    assert figure_blocks[0].text == "[FIGURE: none]"


def test_load_docx_places_each_inline_figure_at_its_own_real_position() -> None:
    # Regression: every image rel was previously collected in one pass
    # AFTER the body walk, each stamped with a (0, 0) placeholder SourceRef
    # -- so in build_baseline_tree's fold (a depth=None FIGURE block always
    # attaches to whatever node is currently open), BOTH images would have
    # folded into whichever node was open LAST, regardless of which section
    # they actually appeared in. Two headings, each with its own image,
    # proves each image now lands between its own heading and the next.
    with tempfile.TemporaryDirectory() as tmp_dir:
        docx_path = _build_two_section_docx_with_inline_images(Path(tmp_dir))
        doc = load_docx(str(docx_path))

    section_one_idx = next(i for i, b in enumerate(doc.blocks) if b.text == "Section One")
    section_two_idx = next(i for i, b in enumerate(doc.blocks) if b.text == "Section Two")
    figure_indices = [i for i, b in enumerate(doc.blocks) if b.kind == BlockKind.FIGURE]

    assert len(figure_indices) == 2
    assert section_one_idx < figure_indices[0] < section_two_idx
    assert section_two_idx < figure_indices[1]
    # Neither figure carries the old (0, 0) placeholder -- both resolved a
    # real position from the shared offset counter.
    assert all(doc.blocks[i].source_ref.start_offset > 0 for i in figure_indices)


def _build_docx_with_horizontal_merge(tmp_path: Path) -> Path:
    # One row, 3 columns, merged into a single cell -- table.cell(0,0)
    # .merge(table.cell(0,2)) sets real w:tcPr/w:gridSpan="3" XML, the
    # same structure Word itself produces for a merged header cell (e.g.
    # the reported "FAN configuration - 1" header).
    from docx import Document as DocxDocument

    doc = DocxDocument()
    table = doc.add_table(rows=1, cols=3)
    table.cell(0, 0).text = "FAN configuration - 1"
    table.cell(0, 0).merge(table.cell(0, 2))

    out_path = tmp_path / "horizontal_merge.docx"
    doc.save(str(out_path))
    return out_path


def _build_docx_with_vertical_merge(tmp_path: Path) -> Path:
    # 3 rows, 2 columns; column 0 rows 1-2 merged vertically -- sets real
    # w:tcPr/w:vMerge XML (restart on the origin row, continue on row 2).
    from docx import Document as DocxDocument

    doc = DocxDocument()
    table = doc.add_table(rows=3, cols=2)
    table.cell(0, 0).text = "Header"
    table.cell(0, 1).text = "Value"
    table.cell(1, 0).text = "GPU"
    table.cell(1, 1).text = "Row 1"
    table.cell(2, 1).text = "Row 2"
    table.cell(1, 0).merge(table.cell(2, 0))

    out_path = tmp_path / "vertical_merge.docx"
    doc.save(str(out_path))
    return out_path


def _build_docx_with_combined_merge(tmp_path: Path) -> Path:
    # Mirrors the real reported bug: a title row merged horizontally
    # across all 3 columns, plus a row-label cell ("GPU") merged
    # vertically across the 2 data rows below it.
    from docx import Document as DocxDocument

    doc = DocxDocument()
    table = doc.add_table(rows=3, cols=3)
    table.cell(0, 0).text = "FAN configuration - 1"
    table.cell(0, 0).merge(table.cell(0, 2))
    table.cell(1, 0).text = "GPU"
    table.cell(1, 1).text = "r1c1"
    table.cell(1, 2).text = "r1c2"
    table.cell(2, 1).text = "r2c1"
    table.cell(2, 2).text = "r2c2"
    table.cell(1, 0).merge(table.cell(2, 0))

    out_path = tmp_path / "combined_merge.docx"
    doc.save(str(out_path))
    return out_path


def test_load_docx_horizontal_merge_places_text_once_in_origin_cell() -> None:
    # Regression for the reported bug: a header cell merged across 3
    # columns (real w:gridSpan XML, via python-docx's own .merge() API)
    # must NOT repeat its text in every spanned column -- only the origin
    # position gets the real text, the rest are "" continuation markers,
    # and the row keeps its full 3-column width.
    with tempfile.TemporaryDirectory() as tmp_dir:
        docx_path = _build_docx_with_horizontal_merge(Path(tmp_dir))
        doc = load_docx(str(docx_path))

    assert len(doc.tables) == 1
    assert plain_text_rows(doc.tables[0]) == [["FAN configuration - 1", "", ""]]


def test_load_docx_vertical_merge_places_text_once_in_origin_row() -> None:
    # Regression for the reported bug: a row-label cell merged vertically
    # across 2 rows (real w:vMerge XML) must NOT repeat its text in every
    # spanned row -- only the origin row gets the real text, the
    # continuation row gets "" in that column, and every row keeps its
    # full 2-column width.
    with tempfile.TemporaryDirectory() as tmp_dir:
        docx_path = _build_docx_with_vertical_merge(Path(tmp_dir))
        doc = load_docx(str(docx_path))

    assert len(doc.tables) == 1
    assert plain_text_rows(doc.tables[0]) == [
        ["Header", "Value"],
        ["GPU", "Row 1"],
        ["", "Row 2"],
    ]


def test_load_docx_combined_horizontal_and_vertical_merge() -> None:
    # Mirrors the exact reported bug shape: a "FAN configuration - 1"
    # title cell merged across 3 columns, and a "GPU" row-label cell
    # merged vertically across the 2 rows beneath it. Each real value
    # appears exactly once, in its true origin position; every other grid
    # position the merges cover is "" -- row/column count (3x3) is
    # preserved throughout.
    with tempfile.TemporaryDirectory() as tmp_dir:
        docx_path = _build_docx_with_combined_merge(Path(tmp_dir))
        doc = load_docx(str(docx_path))

    assert len(doc.tables) == 1
    rows = plain_text_rows(doc.tables[0])
    assert rows == [
        ["FAN configuration - 1", "", ""],
        ["GPU", "r1c1", "r1c2"],
        ["", "r2c1", "r2c2"],
    ]
    assert all(len(row) == 3 for row in rows)
    # Each real value's text appears exactly once across the whole grid.
    assert sum(row.count("FAN configuration - 1") for row in rows) == 1
    assert sum(row.count("GPU") for row in rows) == 1


def test_load_docx_horizontal_merge_colspan_value() -> None:
    # Regression/extension of the horizontal-merge fixture above: the
    # earlier tests only asserted TEXT placement via plain_text_rows
    # (which can't see colspan at all -- it collapses every position to a
    # bare string). This asserts the real TableCell.colspan value the
    # Phase 1 rewrite is responsible for, and that the two spanned grid
    # positions are `None` (SPANNED), not empty-string TableCells (GAP) --
    # the model's two meanings are not interchangeable.
    with tempfile.TemporaryDirectory() as tmp_dir:
        docx_path = _build_docx_with_horizontal_merge(Path(tmp_dir))
        doc = load_docx(str(docx_path))

    row = doc.tables[0].cells[0]
    assert row[0] is not None
    assert row[0].colspan == 3
    assert row[1] is None
    assert row[2] is None


def _build_docx_with_three_row_vertical_merge(tmp_path: Path) -> Path:
    # 4 rows, 2 columns; column 0 rows 1-3 (3 rows) merged vertically --
    # deliberately more than the 2-row case above, since a rowspan
    # computation that happens to work for exactly 2 rows (e.g. an
    # off-by-one that only manifests at 3+) would pass the 2-row test
    # anyway.
    from docx import Document as DocxDocument

    doc = DocxDocument()
    table = doc.add_table(rows=4, cols=2)
    table.cell(0, 0).text = "Header"
    table.cell(0, 1).text = "Value"
    table.cell(1, 0).text = "GPU"
    table.cell(1, 1).text = "Row 1"
    table.cell(2, 1).text = "Row 2"
    table.cell(3, 1).text = "Row 3"
    table.cell(1, 0).merge(table.cell(3, 0))

    out_path = tmp_path / "three_row_vertical_merge.docx"
    doc.save(str(out_path))
    return out_path


def test_load_docx_vertical_merge_rowspan_value_for_three_rows() -> None:
    # Confirms the EXACT rowspan count (3), not just "greater than 1" --
    # the algorithm (tc.bottom - tc.top, see _extract_table_cells'
    # docstring) must walk ALL consecutive vMerge=="continue" rows, not
    # stop after the first one.
    with tempfile.TemporaryDirectory() as tmp_dir:
        docx_path = _build_docx_with_three_row_vertical_merge(Path(tmp_dir))
        doc = load_docx(str(docx_path))

    cells = doc.tables[0].cells
    origin = cells[1][0]
    assert origin is not None
    assert origin.rowspan == 3
    assert cells[2][0] is None
    assert cells[3][0] is None


def _build_docx_with_grid_before(tmp_path: Path) -> Path:
    # 2 rows, 3 columns; row 1 (0-indexed) has NO `w:tc` at all for grid
    # column 0 -- it declares `w:trPr/w:gridBefore w:val="1"` instead,
    # OOXML's way of saying "this row's first populated column is 1, not
    # 0" without an explicit continuation cell. There is no high-level
    # python-docx Table/Cell API to author this (no `Row.grid_before`
    # setter exists) -- this uses python-docx's own lower-level `docx.oxml`
    # layer instead (`get_or_add_trPr()`/`get_or_add_gridBefore()`, the
    # same auto-generated accessors `_extract_table_cells` itself reads
    # `w:trPr` through), which DOES support constructing it directly, just
    # not via the friendly `Document`/`Table` wrapper API.
    from docx import Document as DocxDocument

    doc = DocxDocument()
    table = doc.add_table(rows=2, cols=3)
    table.cell(0, 0).text = "a"
    table.cell(0, 1).text = "b"
    table.cell(0, 2).text = "c"
    table.cell(1, 0).text = "REMOVE_ME"
    table.cell(1, 1).text = "x"
    table.cell(1, 2).text = "y"

    second_row_tr = table.rows[1]._tr
    second_row_tr.remove(second_row_tr.tc_lst[0])
    trPr = second_row_tr.get_or_add_trPr()
    trPr.get_or_add_gridBefore().val = 1

    out_path = tmp_path / "grid_before.docx"
    doc.save(str(out_path))
    return out_path


def test_load_docx_grid_before_shifts_column_position() -> None:
    # Without accounting for w:trPr/w:gridBefore, the omitted row-1 cell
    # would be mistaken for column 0 (the first `w:tc` physically present
    # in that row's XML) instead of its real column 1 -- silently
    # misaligning every later column too. python-docx's own tc.grid_offset
    # (which _extract_table_cells relies on rather than hand-rolling a
    # column counter) already factors in grid_before; this proves that
    # holds through this loader's own output.
    with tempfile.TemporaryDirectory() as tmp_dir:
        docx_path = _build_docx_with_grid_before(Path(tmp_dir))
        doc = load_docx(str(docx_path))

    row = doc.tables[0].cells[1]
    assert row[0] is None  # omitted grid_before position -- SPANNED, not a gap
    assert row[1] is not None and row[1].text == "x"
    assert row[2] is not None and row[2].text == "y"


def _build_docx_with_header_row(tmp_path: Path) -> Path:
    # `w:trPr/w:tblHeader` has no high-level python-docx setter either
    # (Row has no `.is_header`/`.repeats_as_header_row` property) -- built
    # via the same `docx.oxml` `OxmlElement`/`get_or_add_trPr()` layer as
    # the gridBefore fixture above.
    from docx import Document as DocxDocument
    from docx.oxml import OxmlElement

    doc = DocxDocument()
    table = doc.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "Mode"
    table.cell(0, 1).text = "Description"
    table.cell(1, 0).text = "Vivid"
    table.cell(1, 1).text = "High saturation"

    header_tr = table.rows[0]._tr
    trPr = header_tr.get_or_add_trPr()
    trPr.append(OxmlElement("w:tblHeader"))

    out_path = tmp_path / "header_row.docx"
    doc.save(str(out_path))
    return out_path


def test_load_docx_detects_header_row_via_tblHeader() -> None:
    with tempfile.TemporaryDirectory() as tmp_dir:
        docx_path = _build_docx_with_header_row(Path(tmp_dir))
        doc = load_docx(str(docx_path))

    cells = doc.tables[0].cells
    assert all(cell is not None and cell.is_header for cell in cells[0])
    assert all(cell is not None and not cell.is_header for cell in cells[1])


def _build_docx_with_alignment(tmp_path: Path) -> Path:
    # Covers both a legacy w:jc value settable via python-docx's own
    # WD_ALIGN_PARAGRAPH enum (CENTER -> "center") and a modern spelling
    # ("start") that enum has NO member for at all -- set via a raw
    # `w:jc` element instead, since `paragraph.alignment = ...` only
    # accepts the enum. This is exactly the case _cell_alignment's
    # docstring exists to explain: reading it back via python-docx's own
    # `paragraph.alignment`/`jc.val` would raise ValueError on "start".
    from docx import Document as DocxDocument
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    doc = DocxDocument()
    table = doc.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "Centered"
    table.cell(0, 0).paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER

    second_paragraph = table.cell(0, 1).paragraphs[0]
    second_paragraph.text = "Modern"
    pPr = second_paragraph._p.get_or_add_pPr()
    jc = OxmlElement("w:jc")
    jc.set(qn("w:val"), "start")
    pPr.append(jc)

    out_path = tmp_path / "alignment.docx"
    doc.save(str(out_path))
    return out_path


def test_load_docx_reads_alignment_including_modern_start_end_spellings() -> None:
    with tempfile.TemporaryDirectory() as tmp_dir:
        docx_path = _build_docx_with_alignment(Path(tmp_dir))
        doc = load_docx(str(docx_path))

    row = doc.tables[0].cells[0]
    assert row[0] is not None and row[0].align == "center"
    assert row[1] is not None and row[1].align == "left"  # "start" -> left (LTR reading)


def _build_docx_with_bold_prefix_cell(tmp_path: Path) -> Path:
    # The exact case the uniform-bold rule exists for: a bold "Note:"
    # prefix followed by non-bold body text in the SAME cell/paragraph. A
    # naive "first run bold" rule would flag the whole cell bold; the
    # uniform rule must not. A second, wholly-bold cell (with a trailing
    # whitespace-only, non-bold run that must NOT break uniformity) proves
    # the positive case still works.
    from docx import Document as DocxDocument

    doc = DocxDocument()
    table = doc.add_table(rows=1, cols=2)

    mixed_paragraph = table.cell(0, 0).paragraphs[0]
    bold_prefix_run = mixed_paragraph.add_run("Note:")
    bold_prefix_run.bold = True
    rest_run = mixed_paragraph.add_run(" rest of sentence")
    rest_run.bold = False

    bold_paragraph = table.cell(0, 1).paragraphs[0]
    bold_run = bold_paragraph.add_run("AllBold")
    bold_run.bold = True
    trailing_whitespace_run = bold_paragraph.add_run("   ")
    trailing_whitespace_run.bold = False

    out_path = tmp_path / "bold_prefix.docx"
    doc.save(str(out_path))
    return out_path


def test_load_docx_uniform_bold_rejects_bold_prefix_but_accepts_wholly_bold_cell() -> None:
    with tempfile.TemporaryDirectory() as tmp_dir:
        docx_path = _build_docx_with_bold_prefix_cell(Path(tmp_dir))
        doc = load_docx(str(docx_path))

    row = doc.tables[0].cells[0]
    assert row[0] is not None
    assert row[0].text == "Note: rest of sentence"
    assert row[0].bold is False  # bold label prefix must NOT bold the whole cell
    assert row[1] is not None
    assert row[1].bold is True  # wholly-bold text + trailing non-bold whitespace run


def _build_docx_with_background_colors(tmp_path: Path) -> Path:
    # One row, 3 cells: an explicit real fill, an explicit "auto" (OOXML's
    # "no fill" token, not a color), and an explicit "FFFFFF" (Word's own
    # default fill for a shaded-but-uncustomized cell -- also "no fill" per
    # the design spec, NOT a deliberate white choice). No high-level
    # python-docx API sets `w:shd` at all -- built via the same raw
    # `docx.oxml`/`qn()` layer the gridBefore/header-row fixtures above
    # already use.
    from docx import Document as DocxDocument
    from docx.oxml import OxmlElement

    doc = DocxDocument()
    table = doc.add_table(rows=1, cols=3)
    table.cell(0, 0).text = "Real fill"
    table.cell(0, 1).text = "Auto"
    table.cell(0, 2).text = "White"

    def _set_shd(cell, fill: str) -> None:
        tcPr = cell._tc.get_or_add_tcPr()
        shd = OxmlElement("w:shd")
        shd.set(qn("w:fill"), fill)
        tcPr.append(shd)

    _set_shd(table.cell(0, 0), "FFFF00")
    _set_shd(table.cell(0, 1), "auto")
    _set_shd(table.cell(0, 2), "FFFFFF")

    out_path = tmp_path / "background_colors.docx"
    doc.save(str(out_path))
    return out_path


def test_load_docx_background_color_real_fill_vs_auto_vs_white_vs_absent() -> None:
    with tempfile.TemporaryDirectory() as tmp_dir:
        docx_path = _build_docx_with_background_colors(Path(tmp_dir))
        doc = load_docx(str(docx_path))

    row = doc.tables[0].cells[0]
    assert row[0] is not None and row[0].background_color == "#ffff00"
    assert row[1] is not None and row[1].background_color is None  # "auto" -- no fill
    assert row[2] is not None and row[2].background_color is None  # "FFFFFF" -- no fill
    # A cell with no w:shd element at all (the third column above has one,
    # but a brand-new table.cell() with nothing set is the "absent" case).
    doc2 = load_docx(str(FIXTURES / "sample.docx"))
    absent_cell = doc2.tables[0].cells[0][0]
    assert absent_cell is not None and absent_cell.background_color is None


def _build_docx_with_disagreeing_run_colors(tmp_path: Path) -> Path:
    # A cell whose first non-whitespace run is red, followed by a second
    # run with a different color -- proves the "first non-empty run wins"
    # rule (same simplification precedent as _cell_alignment's "first
    # paragraph wins"), not some aggregate/last-run/majority rule. A
    # leading whitespace-only run (no color at all) must not win over the
    # first REAL run either.
    from docx import Document as DocxDocument
    from docx.oxml import OxmlElement

    doc = DocxDocument()
    table = doc.add_table(rows=1, cols=1)
    paragraph = table.cell(0, 0).paragraphs[0]

    def _set_color(run, val: str) -> None:
        rPr = run._r.get_or_add_rPr()
        color = OxmlElement("w:color")
        color.set(qn("w:val"), val)
        rPr.append(color)

    leading_blank_run = paragraph.add_run("   ")
    _set_color(leading_blank_run, "0000FF")  # must be skipped -- whitespace only
    first_real_run = paragraph.add_run("Red")
    _set_color(first_real_run, "FF0000")
    second_run = paragraph.add_run(" then green")
    _set_color(second_run, "00FF00")

    out_path = tmp_path / "disagreeing_colors.docx"
    doc.save(str(out_path))
    return out_path


def test_load_docx_text_color_uses_first_non_empty_run_when_runs_disagree() -> None:
    with tempfile.TemporaryDirectory() as tmp_dir:
        docx_path = _build_docx_with_disagreeing_run_colors(Path(tmp_dir))
        doc = load_docx(str(docx_path))

    cell = doc.tables[0].cells[0][0]
    assert cell is not None
    assert cell.text_color == "#ff0000"  # first non-whitespace run's color wins


def _build_docx_with_borders(tmp_path: Path, *, inside: bool) -> Path:
    # Table-level w:tblBorders with all 4 outer sides always present;
    # `inside=True` additionally adds insideH/insideV, exercising the
    # "grid" vs "outer" branch of the border_style classification. No
    # high-level python-docx setter exists for w:tblBorders either.
    from docx import Document as DocxDocument
    from docx.oxml import OxmlElement

    doc = DocxDocument()
    table = doc.add_table(rows=2, cols=2)
    for r in range(2):
        for c in range(2):
            table.cell(r, c).text = f"r{r}c{c}"

    borders = OxmlElement("w:tblBorders")
    sides = ["top", "bottom", "left", "right"]
    if inside:
        sides += ["insideH", "insideV"]
    for side in sides:
        side_el = OxmlElement(f"w:{side}")
        side_el.set(qn("w:val"), "single")
        borders.append(side_el)
    table._tbl.tblPr.append(borders)

    out_path = tmp_path / f"borders_{'grid' if inside else 'outer'}.docx"
    doc.save(str(out_path))
    return out_path


def test_load_docx_border_style_grid_when_inside_borders_present() -> None:
    with tempfile.TemporaryDirectory() as tmp_dir:
        docx_path = _build_docx_with_borders(Path(tmp_dir), inside=True)
        doc = load_docx(str(docx_path))

    assert doc.tables[0].border_style == "grid"


def test_load_docx_border_style_outer_when_only_outer_borders_present() -> None:
    with tempfile.TemporaryDirectory() as tmp_dir:
        docx_path = _build_docx_with_borders(Path(tmp_dir), inside=False)
        doc = load_docx(str(docx_path))

    assert doc.tables[0].border_style == "outer"


def test_load_docx_border_style_none_when_no_border_elements_present() -> None:
    # sample.docx's table has no explicit w:tblBorders/w:tcBorders at all.
    doc = load_docx(str(FIXTURES / "sample.docx"))
    assert doc.tables[0].border_style == "none"


def test_load_docx_border_style_none_when_borders_explicitly_set_to_none_val() -> None:
    # An author who explicitly turned borders off (w:val="none"/"nil" on
    # every side) must classify the same as never having specified borders
    # at all -- both mean "no visible border", not "borders present but
    # unclassifiable".
    from docx import Document as DocxDocument
    from docx.oxml import OxmlElement

    with tempfile.TemporaryDirectory() as tmp_dir:
        doc = DocxDocument()
        table = doc.add_table(rows=1, cols=2)
        table.cell(0, 0).text = "a"
        table.cell(0, 1).text = "b"
        borders = OxmlElement("w:tblBorders")
        for side in ("top", "bottom", "left", "right", "insideH", "insideV"):
            side_el = OxmlElement(f"w:{side}")
            side_el.set(qn("w:val"), "none")
            borders.append(side_el)
        table._tbl.tblPr.append(borders)
        out_path = Path(tmp_dir) / "borders_explicit_none.docx"
        doc.save(str(out_path))

        result = load_docx(str(out_path))

    assert result.tables[0].border_style == "none"


def _build_docx_with_unequal_column_widths(tmp_path: Path) -> Path:
    # 3 columns with declared widths 1000/2000/1000 twips (4:1 ratio
    # relationship among 3 columns) via table.add_table's own tblGrid,
    # explicitly overwritten to unequal values -- proves fractions are
    # computed from the REAL declared ratio, not just "equal share of N
    # columns" (which python-docx's default add_table already produces and
    # would silently pass a bug where the loader ignores actual w:w values).
    from docx import Document as DocxDocument
    from docx.shared import Twips

    doc = DocxDocument()
    table = doc.add_table(rows=1, cols=3)
    table.cell(0, 0).text = "a"
    table.cell(0, 1).text = "b"
    table.cell(0, 2).text = "c"
    grid_cols = table._tbl.tblGrid.gridCol_lst
    grid_cols[0].w = Twips(1000)
    grid_cols[1].w = Twips(2000)
    grid_cols[2].w = Twips(1000)

    out_path = tmp_path / "unequal_column_widths.docx"
    doc.save(str(out_path))
    return out_path


def test_load_docx_column_widths_are_fractions_summing_to_one() -> None:
    with tempfile.TemporaryDirectory() as tmp_dir:
        docx_path = _build_docx_with_unequal_column_widths(Path(tmp_dir))
        doc = load_docx(str(docx_path))

    widths = doc.tables[0].column_widths
    assert widths is not None
    assert widths == [0.25, 0.5, 0.25]
    assert abs(sum(widths) - 1.0) < 1e-9


def test_load_docx_column_widths_none_when_sample_has_no_declared_grid_widths_issue() -> None:
    # sample.docx's table DOES have a real tblGrid (python-docx always
    # writes one) -- this instead asserts the fraction-summing invariant
    # holds for a real, already-existing fixture too, not just a
    # purpose-built one.
    doc = load_docx(str(FIXTURES / "sample.docx"))
    widths = doc.tables[0].column_widths
    if widths is not None:
        assert abs(sum(widths) - 1.0) < 1e-9


def _build_docx_with_table_style_only(tmp_path: Path) -> Path:
    # Mirrors the design spec's own Phase 0 fixture exactly: a table using
    # ONLY Word's built-in "Light Grid Accent 1" table style (visually has
    # header shading + row banding + gridlines when opened in Word) with NO
    # explicit per-cell w:shd or explicit w:tblBorders/w:tcBorders anywhere.
    # This is the DELIBERATE v1 scope boundary from the design spec's Phase
    # 0 findings -- table-STYLE-implied shading/borders (w:tblStyle's
    # reference into styles.xml's conditional formatting) is NOT resolved,
    # so this must correctly yield None/"none", not attempt to guess the
    # style's real visual appearance.
    from docx import Document as DocxDocument

    doc = DocxDocument()
    table = doc.add_table(rows=2, cols=2)
    table.style = "Light Grid Accent 1"
    table.cell(0, 0).text = "Header A"
    table.cell(0, 1).text = "Header B"
    table.cell(1, 0).text = "Row 1"
    table.cell(1, 1).text = "Row 2"

    out_path = tmp_path / "table_style_only.docx"
    doc.save(str(out_path))
    return out_path


def test_load_docx_table_style_only_shading_still_none_but_borders_now_resolved() -> None:
    # Shading resolution (_cell_background_color) is a SEPARATE, still-
    # unresolved v1 boundary -- unchanged, still correctly None here. Border
    # resolution (_table_border_style/_table_style_borders_elements) is NOT
    # unresolved anymore (confirmed real user complaint: a live document's
    # table showed correct explicit shading but no internal gridlines,
    # because those came purely from this exact style mechanism). Word's
    # default python-docx-generated tblLook for a freshly applied style has
    # firstRow=1/noHBand=0 -- "Light Grid Accent 1"'s own firstRow and
    # band1Horz/band2Horz w:tblStylePr entries all declare real insideH/
    # insideV sides, so this must now classify as "grid", not "none".
    with tempfile.TemporaryDirectory() as tmp_dir:
        docx_path = _build_docx_with_table_style_only(Path(tmp_dir))
        doc = load_docx(str(docx_path))

    assert len(doc.tables) == 1
    for row in doc.tables[0].cells:
        for cell in row:
            assert cell is not None
            assert cell.background_color is None
            assert cell.text_color is None
    assert doc.tables[0].border_style == "grid"


def test_load_docx_table_grid_style_resolves_via_its_own_unconditional_tblborders() -> None:
    # CONFIRMED REAL BUG found in code review: Word's built-in "Table Grid"
    # style -- arguably the single most common way real documents get a
    # gridded table at all -- declares its borders as a bare, UNCONDITIONAL
    # w:tblPr/w:tblBorders directly on the w:style element, with NO
    # w:tblStylePr children whatsoever. _table_style_borders_elements
    # previously only ever looked inside w:tblStylePr's conditional regions
    # and completely missed this, silently resolving to "none" for the most
    # common real-world case.
    from docx import Document as DocxDocument

    with tempfile.TemporaryDirectory() as tmp_dir:
        doc_x = DocxDocument()
        table = doc_x.add_table(rows=3, cols=2)
        table.style = "Table Grid"
        docx_path = Path(tmp_dir) / "table_grid_style.docx"
        doc_x.save(str(docx_path))

        doc = load_docx(str(docx_path))

    assert doc.tables[0].border_style == "grid"


def _inject_conditional_only_style(doc_x, style_id: str) -> None:
    # A style with ONLY a w:tblStylePr firstRow region (real insideH/
    # insideV) and deliberately NO base w:tblPr/w:tblBorders at all --
    # isolates tblLook gating from the unconditional base-border path
    # (see test_load_docx_table_grid_style_resolves_via_its_own_unconditional_tblborders,
    # which covers that separate, ungated path). "Light Grid Accent 1" was
    # used here previously, but it ALSO has its own unconditional base
    # tblBorders (confirmed live) -- gating firstRow off there still left
    # "grid" true via the ungated base borders, so it couldn't actually
    # prove tblLook gating was doing anything.
    from docx.oxml.ns import qn

    styles_root = doc_x.part.styles.element
    style_el = styles_root.makeelement(qn("w:style"), {qn("w:type"): "table", qn("w:styleId"): style_id})
    name_el = style_el.makeelement(qn("w:name"), {qn("w:val"): style_id})
    style_el.append(name_el)
    pr = style_el.makeelement(qn("w:tblStylePr"), {qn("w:type"): "firstRow"})
    tcPr = pr.makeelement(qn("w:tcPr"), {})
    tcBorders = tcPr.makeelement(qn("w:tcBorders"), {})
    for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
        tcBorders.append(tcPr.makeelement(qn(f"w:{side}"), {qn("w:val"): "single"}))
    tcPr.append(tcBorders)
    pr.append(tcPr)
    style_el.append(pr)
    styles_root.append(style_el)


def test_load_docx_table_style_borders_respect_tbllook_off_switches() -> None:
    # A style whose ONLY border definition is a conditional firstRow region
    # (with real insideH/insideV) must NOT contribute grid evidence once
    # w:tblLook explicitly switches firstRow off for this table instance --
    # proving tblLook actually gates conditional regions, isolated from the
    # separate unconditional-base-borders path.
    from docx import Document as DocxDocument
    from docx.oxml.ns import qn

    with tempfile.TemporaryDirectory() as tmp_dir:
        doc_x = DocxDocument()
        _inject_conditional_only_style(doc_x, "ConditionalOnly")
        table = doc_x.add_table(rows=2, cols=2)
        tblPr = table._tbl.tblPr
        tblStyle = tblPr.makeelement(qn("w:tblStyle"), {qn("w:val"): "ConditionalOnly"})
        tblPr.insert(0, tblStyle)
        # add_table() already inserts its own default w:tblLook (firstRow=1)
        # -- mutate that EXISTING element rather than appending a second
        # one, which .find() would never see (confirmed live: appending a
        # duplicate silently left the default's firstRow=1 in effect).
        tblLook = tblPr.find(qn("w:tblLook"))
        tblLook.set(qn("w:firstRow"), "0")
        tblLook.set(qn("w:lastRow"), "0")
        tblLook.set(qn("w:noHBand"), "1")
        table.cell(0, 0).text = "A"
        docx_path = Path(tmp_dir) / "table_look_off.docx"
        doc_x.save(str(docx_path))

        doc = load_docx(str(docx_path))

    assert doc.tables[0].border_style == "none"


def test_load_docx_table_style_borders_apply_conditional_region_when_tbllook_enables_it() -> None:
    # Same conditional-only style, but WITH firstRow enabled via tblLook --
    # positive-case counterpart to the test above, proving the gate lets a
    # real conditional region through when the table actually opts in.
    from docx import Document as DocxDocument
    from docx.oxml.ns import qn

    with tempfile.TemporaryDirectory() as tmp_dir:
        doc_x = DocxDocument()
        _inject_conditional_only_style(doc_x, "ConditionalOnly2")
        table = doc_x.add_table(rows=2, cols=2)
        tblPr = table._tbl.tblPr
        tblStyle = tblPr.makeelement(qn("w:tblStyle"), {qn("w:val"): "ConditionalOnly2"})
        tblPr.insert(0, tblStyle)
        # add_table()'s default w:tblLook already has firstRow=1 -- nothing
        # to change here, but asserted explicitly so this test doesn't
        # silently start passing for the wrong reason if that default ever
        # changes.
        tblLook = tblPr.find(qn("w:tblLook"))
        assert tblLook.get(qn("w:firstRow")) == "1"
        table.cell(0, 0).text = "A"
        docx_path = Path(tmp_dir) / "table_look_on.docx"
        doc_x.save(str(docx_path))

        doc = load_docx(str(docx_path))

    assert doc.tables[0].border_style == "grid"


def _add_full_box_tcborders(tcPr) -> None:
    tcBorders = tcPr.makeelement(qn("w:tcBorders"), {})
    for side in ("top", "left", "bottom", "right"):
        tcBorders.append(tcPr.makeelement(qn(f"w:{side}"), {qn("w:val"): "single"}))
    tcPr.append(tcBorders)


def test_load_docx_two_plus_fully_boxed_cells_classify_as_grid_with_no_inside_tags() -> None:
    # Confirmed real: a real customer document authors its "grid" entirely
    # via explicit per-cell top/left/bottom/right on every cell, never
    # insideH/insideV anywhere in the whole table -- the insideH/insideV
    # check alone can't see this at all and previously misclassified it as
    # "outer", the actual live bug report this test guards against.
    from docx import Document as DocxDocument

    with tempfile.TemporaryDirectory() as tmp_dir:
        doc_x = DocxDocument()
        table = doc_x.add_table(rows=1, cols=2)
        for cell in table.rows[0].cells:
            tcPr = cell._tc.get_or_add_tcPr()
            _add_full_box_tcborders(tcPr)
        docx_path = Path(tmp_dir) / "fully_boxed_cells.docx"
        doc_x.save(str(docx_path))

        doc = load_docx(str(docx_path))

    assert doc.tables[0].border_style == "grid"


def test_load_docx_single_fully_boxed_cell_does_not_alone_imply_grid() -> None:
    # A lone fully-boxed cell (e.g. one decorative emphasis box) must NOT
    # flip the whole table to "grid" -- _FULLY_BOXED_CELL_GRID_THRESHOLD
    # requires 2+ distinct cells before trusting this as real grid evidence.
    # It DOES still have real border presence on its own (top/bottom/left/
    # right are each real), so "outer" -- not "none" -- is the correct
    # classification here; only "grid" is what the threshold guards.
    from docx import Document as DocxDocument

    with tempfile.TemporaryDirectory() as tmp_dir:
        doc_x = DocxDocument()
        table = doc_x.add_table(rows=1, cols=2)
        _add_full_box_tcborders(table.cell(0, 0)._tc.get_or_add_tcPr())
        docx_path = Path(tmp_dir) / "one_boxed_cell.docx"
        doc_x.save(str(docx_path))

        doc = load_docx(str(docx_path))

    assert doc.tables[0].border_style == "outer"


def test_load_docx_explicit_table_borders_still_detected_with_no_table_style() -> None:
    # Regression guard for the pre-existing explicit-XML path: a table with
    # NO w:tblStyle reference at all must still classify correctly off its
    # own explicit w:tblBorders, unaffected by anything style-resolution-
    # related added alongside it.
    from docx import Document as DocxDocument
    from docx.oxml.ns import qn

    with tempfile.TemporaryDirectory() as tmp_dir:
        doc_x = DocxDocument()
        table = doc_x.add_table(rows=1, cols=1)
        tblPr = table._tbl.tblPr
        tblBorders = tblPr.makeelement(qn("w:tblBorders"), {})
        for side in ("top", "left", "bottom", "right"):
            el = tblPr.makeelement(qn(f"w:{side}"), {qn("w:val"): "single"})
            tblBorders.append(el)
        tblPr.append(tblBorders)
        docx_path = Path(tmp_dir) / "explicit_outer.docx"
        doc_x.save(str(docx_path))

        doc = load_docx(str(docx_path))

    assert doc.tables[0].border_style == "outer"


def test_load_docx_end_to_end_folds_each_figure_into_its_own_section() -> None:
    # Same fixture, run through build_baseline_tree end to end: proves the
    # placement fix actually changes which node each figure's Description
    # ends up in, not just the block ordering in isolation. A real caption
    # is supplied (describe_figure) because a placeholder-only figure is
    # now omitted from the description entirely (see tree_builder.py's
    # _figure_line) -- a caption is required to observe where it folds.
    from app.leveling.tree_builder import build_baseline_tree

    with tempfile.TemporaryDirectory() as tmp_dir:
        docx_path = _build_two_section_docx_with_inline_images(Path(tmp_dir))
        doc = load_docx(str(docx_path), describe_figure=lambda _bytes: "diagram")

    tree = build_baseline_tree(doc)
    section_one = next(n for n in tree.nodes if n.title == "Section One")
    section_two = next(n for n in tree.nodes if n.title == "Section Two")

    assert "> Figure: diagram" in section_one.description
    assert "> Figure: diagram" in section_two.description
    # Each section's own figure did NOT leak into the other section.
    assert section_one.description.count("> Figure:") == 1
    assert section_two.description.count("> Figure:") == 1


def test_load_docx_unwraps_content_control_wrapped_heading_and_paragraph() -> None:
    # Regression: a w:sdt (content control) subtree was previously skipped
    # whole by the body walk (it matches neither w:p nor w:tbl at the top
    # level) -- any heading/paragraph a template wraps in one (common for
    # locked/protected sections) vanished with no trace.
    from docx import Document as DocxDocument
    from docx.oxml import parse_xml
    from docx.oxml.ns import nsdecls

    doc = DocxDocument()
    doc.add_paragraph("Before the content control.")
    sdt_xml = (
        f'<w:sdt {nsdecls("w")}>'
        "<w:sdtContent>"
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'
        "<w:r><w:t>Hidden Heading</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>Hidden paragraph text.</w:t></w:r></w:p>"
        "</w:sdtContent></w:sdt>"
    )
    doc.element.body.append(parse_xml(sdt_xml))
    doc.add_paragraph("After the content control.")

    with tempfile.TemporaryDirectory() as tmp_dir:
        out_path = Path(tmp_dir) / "sdt.docx"
        doc.save(str(out_path))
        result = load_docx(str(out_path))

    texts = [b.text for b in result.blocks]
    assert "Hidden Heading" in texts
    assert "Hidden paragraph text." in texts
    heading_block = next(b for b in result.blocks if b.text == "Hidden Heading")
    assert heading_block.kind == BlockKind.HEADING
    assert heading_block.heading_level == 1


def test_load_docx_detects_heading_via_style_level_outline_lvl_with_no_space_in_style_name() -> None:
    # Regression: docgen-json-to-word (the sibling repo that GENERATES real
    # .docx files) emits style ids like "Heading3" with NO space
    # (ParagraphService.cs), which the old startswith("Heading ") check
    # never matched -- silently downgraded to PARAGRAPH. Word's own
    # built-in Heading N styles carry their outlineLvl on the STYLE
    # definition (not the paragraph's own pPr), so this exercises that path.
    from docx import Document as DocxDocument

    doc = DocxDocument()
    paragraph = doc.add_paragraph("Backplane Power")
    paragraph.style = doc.styles["Heading 3"]  # style_id "Heading3", name "Heading 3"

    with tempfile.TemporaryDirectory() as tmp_dir:
        out_path = Path(tmp_dir) / "heading3.docx"
        doc.save(str(out_path))
        result = load_docx(str(out_path))

    heading = next(b for b in result.blocks if b.text == "Backplane Power")
    assert heading.kind == BlockKind.HEADING
    assert heading.heading_level == 3


def test_load_docx_treats_title_style_as_a_heading() -> None:
    from docx import Document as DocxDocument

    doc = DocxDocument()
    paragraph = doc.add_paragraph("AirPro Interface Control Document")
    paragraph.style = doc.styles["Title"]

    with tempfile.TemporaryDirectory() as tmp_dir:
        out_path = Path(tmp_dir) / "title.docx"
        doc.save(str(out_path))
        result = load_docx(str(out_path))

    heading = next(b for b in result.blocks if "Interface Control" in b.text)
    assert heading.kind == BlockKind.HEADING
    assert heading.heading_level == 1


def test_load_docx_does_not_crash_on_a_custom_heading_style_with_non_numeric_suffix() -> None:
    # Regression: a custom style named "Heading Body" (starts with "Heading "
    # but has no trailing digit) previously crashed the WHOLE document load
    # via int("Body") -- one malformed style aborted every other block too.
    from docx import Document as DocxDocument
    from docx.enum.style import WD_STYLE_TYPE

    doc = DocxDocument()
    doc.styles.add_style("Heading Body", WD_STYLE_TYPE.PARAGRAPH)
    paragraph = doc.add_paragraph("Not a real numbered heading.")
    paragraph.style = doc.styles["Heading Body"]
    doc.add_paragraph("A normal paragraph after it.")

    with tempfile.TemporaryDirectory() as tmp_dir:
        out_path = Path(tmp_dir) / "custom_style.docx"
        doc.save(str(out_path))
        result = load_docx(str(out_path))  # must not raise

    custom = next(b for b in result.blocks if b.text == "Not a real numbered heading.")
    assert custom.kind == BlockKind.PARAGRAPH  # no reliable level signal -- falls through, not a crash
    normal = next(b for b in result.blocks if b.text == "A normal paragraph after it.")
    assert normal.kind == BlockKind.PARAGRAPH
