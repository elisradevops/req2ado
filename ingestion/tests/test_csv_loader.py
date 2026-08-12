from pathlib import Path

from app.canonical.model import plain_text_rows
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
