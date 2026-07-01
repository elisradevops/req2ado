from pathlib import Path

from app.canonical.model import BlockKind
from app.loaders.pdf_loader import load_pdf, page_has_extractable_text

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
    flat = [cell for row in doc.tables[0].rows for cell in row]
    assert "3.3V" in flat


def test_load_pdf_format_is_pdf() -> None:
    doc = load_pdf(str(FIXTURES / "sample.pdf"))
    assert doc.document.format.value == "pdf"


def test_page_has_extractable_text_true_for_text_page() -> None:
    assert page_has_extractable_text(str(FIXTURES / "sample.pdf"), 0) is True
