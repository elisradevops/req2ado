# ingestion/app/loaders/xls_loader.py
"""Excel 97-2003 (.xls) read through the .xlsx loader.

xlrd reads the old BIFF format; the sheets are written into a temporary .xlsx (values, merged cells and the frozen header, which is what
xlsx_loader reads for a table's header rows) and that file goes through load_xlsx, so there is one place that turns a spreadsheet into
tables. Cell styling (fills, fonts) is not carried over: it is not text, and nothing downstream needs it for a sheet of requirements.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import xlrd
from openpyxl import Workbook
from openpyxl.utils.exceptions import IllegalCharacterError

from app.canonical.model import CanonicalDoc
from app.loaders.xlsx_loader import load_xlsx


class XlsReadError(Exception):
    """The .xls could not be read (damaged, password-protected, or not an Excel file)."""


def _value(book: xlrd.Book, cell: xlrd.sheet.Cell) -> object:
    kind = cell.ctype
    if kind in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
        return None
    if kind == xlrd.XL_CELL_DATE:
        try:
            return xlrd.xldate_as_datetime(cell.value, book.datemode)
        except (xlrd.XLDateError, OverflowError):
            return cell.value
    if kind == xlrd.XL_CELL_BOOLEAN:
        return bool(cell.value)
    if kind == xlrd.XL_CELL_ERROR:
        return xlrd.error_text_from_code.get(cell.value, "#ERROR")
    if kind == xlrd.XL_CELL_NUMBER and isinstance(cell.value, float) and cell.value.is_integer():
        return int(cell.value)  # 3.0 would read back as "3.0"
    return cell.value


def _read_workbook(path: str) -> Workbook:
    book = xlrd.open_workbook(path, formatting_info=True)
    workbook = Workbook()
    workbook.remove(workbook.active)
    for sheet in book.sheets():
        target = workbook.create_sheet(title=sheet.name[:31] or "Sheet")
        for row_index in range(sheet.nrows):
            for column_index in range(sheet.ncols):
                value = _value(book, sheet.cell(row_index, column_index))
                if value is None:
                    continue
                try:
                    target.cell(row=row_index + 1, column=column_index + 1, value=value)
                except (IllegalCharacterError, ValueError):
                    target.cell(row=row_index + 1, column=column_index + 1, value=str(value).encode("unicode_escape").decode())
        for row_low, row_high, column_low, column_high in sheet.merged_cells:
            target.merge_cells(start_row=row_low + 1, end_row=row_high, start_column=column_low + 1, end_column=column_high)
        if sheet.panes_are_frozen and sheet.horz_split_pos:
            target.freeze_panes = f"A{sheet.horz_split_pos + 1}"
    if not workbook.sheetnames:
        raise XlsReadError("the workbook has no sheets")
    return workbook


def load_xls(path: str) -> CanonicalDoc:
    try:
        workbook = _read_workbook(path)
    except XlsReadError:
        raise
    except Exception as error:  # noqa: BLE001 -- xlrd raises struct.error, KeyError, IndexError and more on a truncated or corrupted file
        raise XlsReadError(f"{type(error).__name__}: {error}") from error
    with tempfile.TemporaryDirectory() as work_dir:
        converted = Path(work_dir) / f"{Path(path).stem}.xlsx"
        workbook.save(converted)
        return load_xlsx(str(converted))
