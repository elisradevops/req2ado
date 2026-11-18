"""Excel 97-2003 (.xls), Word 97-2003 (.doc) and delimiter-separated CSV, through the same dispatcher as every other upload."""

import hashlib
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.canonical.model import DocumentFormat
from app.dispatch import dispatch_by_extension
from app.loaders import office_convert
from app.loaders.csv_loader import _delimiter_of, load_csv
from app.loaders.office_convert import convert_legacy_office
from app.loaders.xls_loader import XlsReadError, load_xls

FIXTURES = Path(__file__).parent / "fixtures"


def grid(table) -> list[list[str]]:
    return [[c.text if c else "" for c in row] for row in table.cells]


# ---- .xls ----------------------------------------------------------------------------------------------------------------------------


def test_an_xls_is_read_into_one_table_per_sheet_with_the_sheet_names() -> None:
    doc = load_xls(str(FIXTURES / "sample.xls"))

    assert doc.document.format == DocumentFormat.XLSX
    assert [t.caption for t in doc.tables] == ["Requirements", "Notes"]
    assert doc.blocks == []


def test_xls_values_read_back_as_the_text_a_person_sees() -> None:
    rows = grid(load_xls(str(FIXTURES / "sample.xls")).tables[0])

    assert rows[0] == ["ID", "Section", "Requirement", "Due", "Qty", "Done"]
    assert rows[1][0] == "REQ-001" and rows[1][2] == "The unit shall start within 2 seconds."
    assert rows[1][4] == "3"  # a whole number is not "3.0"
    assert rows[2][4] == "2.5"
    assert rows[1][3].startswith("2026-11-18")  # a date, not a serial number
    assert rows[1][5] == "True"
    assert rows[2][2] == "היחידה תפעל בטווח טמפרטורות של -40 עד 70 מעלות."  # Hebrew survives


def test_xls_merged_cells_and_the_frozen_header_are_kept() -> None:
    table = load_xls(str(FIXTURES / "sample.xls")).tables[0]

    section = table.cells[1][1]
    assert section.text == "Power" and section.rowspan == 2
    assert table.cells[2][1] is None  # the cell the merge covers
    assert all(cell is not None and cell.is_header for cell in table.cells[0])


@pytest.mark.parametrize("content", [b"", b"this is not an excel file", b"\xd0\xcf\x11\xe0" + b"\x00" * 64])
def test_a_damaged_or_foreign_xls_is_refused_with_a_clear_error(tmp_path, content) -> None:
    broken = tmp_path / "broken.xls"
    broken.write_bytes(content)
    with pytest.raises(XlsReadError):
        load_xls(str(broken))


def test_a_truncated_xls_is_always_the_clear_error_never_a_raw_parser_exception(tmp_path) -> None:
    # xlrd raises struct.error, KeyError and others on a cut-off file; every one of them must reach the user as the same readable refusal.
    original = (FIXTURES / "sample.xls").read_bytes()
    for cut in range(256, len(original), 211):
        broken = tmp_path / "cut.xls"
        broken.write_bytes(original[:cut])
        try:
            load_xls(str(broken))
        except XlsReadError:
            pass


def test_dispatch_reads_an_xls_under_the_uploaded_name_and_the_uploads_own_hash(tmp_path) -> None:
    upload = tmp_path / "tmpabc123.xls"
    shutil.copy(FIXTURES / "sample.xls", upload)

    doc = dispatch_by_extension("Customer Spec.xls", str(upload))

    assert doc.document.path == "Customer Spec.xls"
    assert doc.document.sha256 == hashlib.sha256(upload.read_bytes()).hexdigest()
    assert all(t.source_ref.document_path == "Customer Spec.xls" for t in doc.tables)


def test_dispatch_refuses_a_broken_xls_with_a_422_that_says_what_to_do(tmp_path) -> None:
    upload = tmp_path / "tmpabc123.xls"
    upload.write_bytes(b"not excel")

    with pytest.raises(HTTPException) as raised:
        dispatch_by_extension("broken.xls", str(upload))

    assert raised.value.status_code == 422
    assert "saving it as .xlsx" in raised.value.detail


# ---- .doc ----------------------------------------------------------------------------------------------------------------------------


def test_the_converter_asks_libreoffice_for_a_docx_with_its_own_profile_and_returns_the_output(tmp_path, monkeypatch) -> None:
    calls = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        (tmp_path / "out" / "spec.docx").write_bytes(b"x" * 2048)

    (tmp_path / "out").mkdir()
    monkeypatch.setattr(office_convert.subprocess, "run", fake_run)

    result = convert_legacy_office(str(tmp_path / "spec.doc"), ".doc", str(tmp_path / "out"))

    assert result == str(tmp_path / "out" / "spec.docx")
    command, kwargs = calls[0]
    assert command[0] == "soffice" and "--headless" in command
    assert command[command.index("--convert-to") + 1] == "docx:MS Word 2007 XML"
    assert any(part.startswith("-env:UserInstallation=file://") for part in command)
    assert kwargs["check"] is True and kwargs["timeout"] > 0


@pytest.mark.parametrize(
    "behaviour",
    [
        lambda *a, **k: (_ for _ in ()).throw(subprocess.CalledProcessError(1, "soffice")),
        lambda *a, **k: (_ for _ in ()).throw(subprocess.TimeoutExpired("soffice", 1)),
        lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError("soffice")),
        lambda *a, **k: None,  # exit 0 but no file written
    ],
)
def test_a_conversion_that_fails_in_any_way_returns_none_and_never_raises(tmp_path, monkeypatch, behaviour) -> None:
    monkeypatch.setattr(office_convert.subprocess, "run", behaviour)
    assert convert_legacy_office(str(tmp_path / "spec.doc"), ".doc", str(tmp_path)) is None


def test_an_output_that_is_too_small_is_not_trusted(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(office_convert.subprocess, "run", lambda *a, **k: (tmp_path / "spec.docx").write_bytes(b"tiny"))
    assert convert_legacy_office(str(tmp_path / "spec.doc"), ".doc", str(tmp_path)) is None


def test_dispatch_reads_a_doc_through_its_converted_docx(tmp_path, monkeypatch) -> None:
    docx_source = next(p for p in FIXTURES.glob("*.docx"))

    def fake_convert(src, extension, out_dir):
        target = Path(out_dir) / f"{Path(src).stem}.docx"
        shutil.copy(docx_source, target)
        return str(target)

    monkeypatch.setattr("app.dispatch.convert_legacy_office", fake_convert)
    upload = tmp_path / "tmpdoc.doc"
    upload.write_bytes(b"\xd0\xcf\x11\xe0legacy word bytes")

    doc = dispatch_by_extension("Old Spec.doc", str(upload))

    assert doc.document.format == DocumentFormat.DOCX and doc.blocks
    assert doc.document.path == "Old Spec.doc"
    assert doc.document.sha256 == hashlib.sha256(upload.read_bytes()).hexdigest()


def test_dispatch_refuses_a_doc_that_cannot_be_converted_with_a_422(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("app.dispatch.convert_legacy_office", lambda *a, **k: None)
    upload = tmp_path / "tmpdoc.doc"
    upload.write_bytes(b"\xd0\xcf\x11\xe0legacy")

    with pytest.raises(HTTPException) as raised:
        dispatch_by_extension("Old Spec.doc", str(upload))

    assert raised.value.status_code == 422 and "saving it as .docx" in raised.value.detail


# ---- .csv ----------------------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text, delimiter",
    [
        ("ID,Text,Priority\nR1,The unit shall start.,High\nR2,The unit shall stop.,Low\n", ","),
        ("ID;Text;Priority\nR1;The unit shall start.;High\nR2;The unit shall stop.;Low\n", ";"),
        ("ID\tText\tPriority\nR1\tThe unit shall start.\tHigh\nR2\tThe unit shall stop.\tLow\n", "\t"),
        ("just one column\nof words\nand more words\n", ","),
        ("", ","),
    ],
)
def test_the_delimiter_is_read_from_the_file_and_defaults_to_a_comma(text, delimiter) -> None:
    assert _delimiter_of(text) == delimiter


def test_a_semicolon_separated_csv_loads_as_columns_not_one_wide_cell(tmp_path) -> None:
    path = tmp_path / "req.csv"
    path.write_text("ID;Text\nR1;The unit shall start.\nR2;The unit shall stop.\n", encoding="utf-8")

    rows = grid(load_csv(str(path)).tables[0])

    assert rows == [["ID", "Text"], ["R1", "The unit shall start."], ["R2", "The unit shall stop."]]


def test_a_comma_inside_quotes_is_not_a_delimiter(tmp_path) -> None:
    path = tmp_path / "req.csv"
    path.write_text('ID,Text\nR1,"The unit shall start, then run."\nR2,"The unit shall stop, safely."\n', encoding="utf-8")
    assert grid(load_csv(str(path)).tables[0])[1] == ["R1", "The unit shall start, then run."]


def test_dispatch_names_a_csv_sheet_after_the_upload_not_the_temporary_file(tmp_path) -> None:
    upload = tmp_path / "tmpq1w2e3.csv"
    upload.write_text("ID,Text\nR1,The unit shall start.\n", encoding="utf-8")

    doc = dispatch_by_extension("Customer Requirements.csv", str(upload))

    assert [t.caption for t in doc.tables] == ["Customer Requirements"]
