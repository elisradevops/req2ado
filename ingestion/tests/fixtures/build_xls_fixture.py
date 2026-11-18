"""Builds tests/fixtures/sample.xls (Excel 97-2003): a requirements sheet with a frozen header row, a merged section cell, a date, an
integral number, a boolean and Hebrew text, and a second sheet. xlwt is only needed to write it, so it is not a project dependency:

    uv run --with xlwt python tests/fixtures/build_xls_fixture.py
"""

import datetime
from pathlib import Path

import xlwt

OUT = Path(__file__).parent / "sample.xls"


def build() -> None:
    book = xlwt.Workbook()
    date_style = xlwt.easyxf(num_format_str="YYYY-MM-DD")

    sheet = book.add_sheet("Requirements")
    for column, heading in enumerate(["ID", "Section", "Requirement", "Due", "Qty", "Done"]):
        sheet.write(0, column, heading)
    sheet.set_panes_frozen(True)
    sheet.set_horz_split_pos(1)
    sheet.write_merge(1, 2, 1, 1, "Power")  # B2:B3
    sheet.write(1, 0, "REQ-001")
    sheet.write(1, 2, "The unit shall start within 2 seconds.")
    sheet.write(1, 3, datetime.datetime(2026, 11, 18), date_style)
    sheet.write(1, 4, 3.0)
    sheet.write(1, 5, True)
    sheet.write(2, 0, "REQ-002")
    sheet.write(2, 2, "היחידה תפעל בטווח טמפרטורות של -40 עד 70 מעלות.")
    sheet.write(2, 4, 2.5)
    sheet.write(3, 0, "REQ-003")
    sheet.write(3, 1, "Thermal")
    sheet.write(3, 2, "The unit shall shut down above 85 C.")

    notes = book.add_sheet("Notes")
    notes.write(0, 0, "Revision")
    notes.write(1, 0, "A")

    book.save(str(OUT))


if __name__ == "__main__":
    build()
