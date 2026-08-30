from pathlib import Path

from app.canonical.model import BlockKind, plain_text_rows
from app.loaders.csv_loader import load_csv


def _write_csv(tmp_path: Path, content: str) -> str:
    path = tmp_path / "sample.csv"
    path.write_text(content, encoding="utf-8")
    return str(path)


def test_load_csv_produces_one_table_with_all_rows(tmp_path: Path) -> None:
    path = _write_csv(tmp_path, "Component,Voltage,Current\r\nFPGA,3.3V,2.5\r\nCPU,5V,4.0\r\n")
    doc = load_csv(path)
    assert doc.blocks == []
    assert len(doc.tables) == 1
    assert plain_text_rows(doc.tables[0]) == [
        ["Component", "Voltage", "Current"],
        ["FPGA", "3.3V", "2.5"],
        ["CPU", "5V", "4.0"],
    ]


def test_load_csv_caption_is_filename_stem(tmp_path: Path) -> None:
    path = _write_csv(tmp_path, "a,b\r\n1,2\r\n")
    doc = load_csv(path)
    assert doc.tables[0].caption == "sample"


def test_load_csv_format_is_csv(tmp_path: Path) -> None:
    path = _write_csv(tmp_path, "a,b\r\n1,2\r\n")
    doc = load_csv(path)
    assert doc.document.format.value == "csv"


def test_load_csv_strips_utf8_bom(tmp_path: Path) -> None:
    path = tmp_path / "bom.csv"
    path.write_bytes("﻿a,b\r\n1,2\r\n".encode("utf-8"))
    doc = load_csv(str(path))
    assert plain_text_rows(doc.tables[0])[0] == ["a", "b"]


def test_load_csv_degrades_instead_of_raising_on_non_utf8_bytes(tmp_path: Path) -> None:
    # Real regression: a Hebrew CP1255 file uploaded as .csv previously
    # raised UnicodeDecodeError (no errors= on the file open) and aborted
    # ingestion entirely -- against this codebase's own degrade-don't-raise
    # discipline. Component,Voltage header, encoded as CP1255 (not UTF-8).
    path = tmp_path / "hebrew.csv"
    path.write_bytes("שם,מתח\r\nFPGA,3.3V\r\n".encode("cp1255"))
    doc = load_csv(str(path))  # must not raise
    note_blocks = [b for b in doc.blocks if b.kind == BlockKind.NOTE]
    assert len(note_blocks) == 1
    assert note_blocks[0].text.startswith("[UNSUPPORTED:")
    assert len(doc.tables) == 1  # still produces a real table, not an empty document
