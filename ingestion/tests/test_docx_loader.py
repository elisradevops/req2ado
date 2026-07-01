from pathlib import Path

from app.canonical.model import BlockKind
from app.loaders.docx_loader import load_docx

FIXTURES = Path(__file__).parent / "fixtures"


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
    assert doc.tables[0].rows == [
        ["Mode", "Description"],
        ["Vivid", "High saturation preset"],
    ]


def test_load_docx_format_is_docx() -> None:
    doc = load_docx(str(FIXTURES / "sample.docx"))
    assert doc.document.format.value == "docx"


def test_load_docx_detects_embedded_image_as_figure() -> None:
    doc = load_docx(str(FIXTURES / "sample.docx"))
    assert len(doc.figures) == 1
