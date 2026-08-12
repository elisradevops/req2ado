from pathlib import Path

from app.canonical.model import plain_text_rows
from app.loaders.xlsx_loader import load_xlsx

FIXTURES = Path(__file__).parent / "fixtures"


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
