from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font

from app.canonical.model import plain_text_rows
from app.loaders.xlsx_loader import load_xlsx

FIXTURES = Path(__file__).parent / "fixtures"


def _build_styled_xlsx(tmp_path: Path) -> Path:
    # Real openpyxl API calls (merge_cells/freeze_panes/font/alignment)
    # produce genuine OOXML -- same "build a real fixture, don't hand-guess
    # the format" principle used for the docx merged-cell fixtures. Layout:
    #   Row 1: "Header" merged A1:B1 (colspan=2), bold, center-aligned.
    #   Row 2: "Left" | "Right" (left/right aligned respectively).
    #   Row 3: "Vert" merged A3:A4 (rowspan=2) | "R3C2"
    #   Row 4: (A4 spanned, absorbed by A3's rowspan)   | "R4C2"
    # freeze_panes = "A2" freezes row 1 only -> exactly one detected header
    # row, matching the merged, bold, centered cell above.
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Styled"

    sheet["A1"] = "Header"
    sheet.merge_cells("A1:B1")
    sheet["A1"].font = Font(bold=True)
    sheet["A1"].alignment = Alignment(horizontal="center")

    sheet["A2"] = "Left"
    sheet["A2"].alignment = Alignment(horizontal="left")
    sheet["B2"] = "Right"
    sheet["B2"].alignment = Alignment(horizontal="right")

    sheet["A3"] = "Vert"
    sheet.merge_cells("A3:A4")
    sheet["B3"] = "R3C2"
    sheet["B4"] = "R4C2"

    sheet.freeze_panes = "A2"

    out_path = tmp_path / "styled.xlsx"
    workbook.save(str(out_path))
    return out_path


def _build_unfrozen_xlsx(tmp_path: Path) -> Path:
    # No freeze_panes at all -- must yield zero header rows (never guess
    # "row 0 is probably a header" when the only available signal is absent).
    workbook = Workbook()
    sheet = workbook.active
    sheet["A1"] = "Plain"
    sheet["A2"] = "Row"
    out_path = tmp_path / "unfrozen.xlsx"
    workbook.save(str(out_path))
    return out_path


def test_load_xlsx_produces_one_table_per_sheet() -> None:
    doc = load_xlsx(str(FIXTURES / "sample.xlsx"))
    assert len(doc.tables) == 2


def test_load_xlsx_table_rows_match_sheet_contents() -> None:
    doc = load_xlsx(str(FIXTURES / "sample.xlsx"))
    power_budget = next(t for t in doc.tables if t.caption == "PowerBudget")
    assert plain_text_rows(power_budget) == [
        ["Component", "Voltage", "Current (A)"],
        ["FPGA", "3.3V", "2.5"],
        ["CPU", "5V", "4.0"],
    ]


def test_load_xlsx_second_sheet_present() -> None:
    doc = load_xlsx(str(FIXTURES / "sample.xlsx"))
    address_map = next(t for t in doc.tables if t.caption == "AddressMap")
    assert plain_text_rows(address_map)[0] == ["Address", "Register"]


def test_load_xlsx_format_is_xlsx() -> None:
    doc = load_xlsx(str(FIXTURES / "sample.xlsx"))
    assert doc.document.format.value == "xlsx"
    assert doc.blocks == []


def test_load_xlsx_each_sheet_gets_a_distinct_source_ref_offset() -> None:
    # Real bug this closes: every sheet previously got the hardcoded
    # SourceRef(start_offset=0, end_offset=0), so tree_builder._hash_identity
    # (which hashes only document_path+start_offset+end_offset, deliberately
    # NOT description) produced the IDENTICAL hash for every sheet in a
    # multi-sheet workbook -- BASELINE's idempotency lookup then silently
    # resolved sheet 2+'s "create" to sheet 1's own ADO work item, collapsing
    # the whole workbook into one item.
    doc = load_xlsx(str(FIXTURES / "sample.xlsx"))
    assert len(doc.tables) == 2
    offsets = [(t.source_ref.start_offset, t.source_ref.end_offset) for t in doc.tables]
    assert len(set(offsets)) == len(offsets), f"sheets must not share a (start, end) offset pair: {offsets}"


def test_load_xlsx_horizontal_merge_sets_colspan_and_spans_none(tmp_path: Path) -> None:
    doc = load_xlsx(str(_build_styled_xlsx(tmp_path)))
    table = doc.tables[0]
    origin = table.cells[0][0]
    assert origin is not None
    assert origin.colspan == 2
    assert origin.rowspan == 1
    # The second position of the A1:B1 merge is SPANNED (absorbed by A1's
    # colspan) -- must be None, not an empty/bare TableCell.
    assert table.cells[0][1] is None


def test_load_xlsx_vertical_merge_sets_rowspan_and_spans_none(tmp_path: Path) -> None:
    doc = load_xlsx(str(_build_styled_xlsx(tmp_path)))
    table = doc.tables[0]
    # Row index 2 (0-based) is sheet row 3 ("Vert"/A3:A4 merge origin).
    origin = table.cells[2][0]
    assert origin is not None
    assert origin.text == "Vert"
    assert origin.rowspan == 2
    assert origin.colspan == 1
    # Row index 3 (0-based) is sheet row 4 -- A4 is SPANNED by A3's rowspan.
    assert table.cells[3][0] is None
    # B4 is NOT part of any merge and must remain a real, independent cell.
    assert table.cells[3][1] is not None
    assert table.cells[3][1].text == "R4C2"


def test_load_xlsx_freeze_panes_marks_header_row(tmp_path: Path) -> None:
    doc = load_xlsx(str(_build_styled_xlsx(tmp_path)))
    table = doc.tables[0]
    # freeze_panes="A2" freezes exactly row 1 -> only row 0 is header.
    assert table.cells[0][0].is_header is True
    assert table.cells[1][0].is_header is False
    assert table.cells[1][1].is_header is False
    assert table.cells[2][0].is_header is False


def test_load_xlsx_no_freeze_panes_yields_no_header_rows(tmp_path: Path) -> None:
    doc = load_xlsx(str(_build_unfrozen_xlsx(tmp_path)))
    table = doc.tables[0]
    assert all(not cell.is_header for row in table.cells for cell in row if cell is not None)


def test_load_xlsx_bold_is_read_directly_from_font(tmp_path: Path) -> None:
    doc = load_xlsx(str(_build_styled_xlsx(tmp_path)))
    table = doc.tables[0]
    assert table.cells[0][0].bold is True
    assert table.cells[1][0].bold is False


def test_load_xlsx_alignment_mapping(tmp_path: Path) -> None:
    doc = load_xlsx(str(_build_styled_xlsx(tmp_path)))
    table = doc.tables[0]
    assert table.cells[0][0].align == "center"
    assert table.cells[1][0].align == "left"
    assert table.cells[1][1].align == "right"
    # B3/"R3C2" was never given an explicit alignment -- openpyxl reports
    # 'general' by default, which must map to None (not a fabricated value).
    assert table.cells[2][1].align is None


def test_load_xlsx_general_alignment_maps_to_none(tmp_path: Path) -> None:
    doc = load_xlsx(str(_build_unfrozen_xlsx(tmp_path)))
    table = doc.tables[0]
    assert all(cell.align is None for row in table.cells for cell in row if cell is not None)


def test_load_xlsx_no_explicit_styling_yields_honest_none_and_none_border(tmp_path: Path) -> None:
    # _build_styled_xlsx sets merges/bold/alignment/freeze_panes but never a
    # fill, font color, border, or column width -- Phase 2's real extraction
    # (_classify_border_style/_resolve_fill_color/_resolve_font_color/
    # _resolve_column_widths) correctly reports that as `border_style=
    # "none"` (scanned, found no border sides -- a real, informative
    # answer, distinct from a color/width's `None` meaning "nothing to
    # report" for a genuinely absent style dimension) and `None` for every
    # color/width field (nothing was ever set, so there is nothing to
    # normalize into a value). style_provenance stays None -- xlsx
    # extraction is always explicit-markup-derived, never heuristic.
    doc = load_xlsx(str(_build_styled_xlsx(tmp_path)))
    table = doc.tables[0]
    assert table.column_widths is None
    assert table.border_style == "none"
    assert table.style_provenance is None
    for row in table.cells:
        for cell in row:
            if cell is None:
                continue
            assert cell.background_color is None
            assert cell.text_color is None
