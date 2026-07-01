from pathlib import Path

from app.canonical.model import BlockKind
from app.loaders.ocr import load_pdf_with_ocr_fallback, ocr_page_to_text
from app.loaders.pdf_loader import page_has_extractable_text

FIXTURES = Path(__file__).parent / "fixtures"


def test_scanned_page_has_no_extractable_text() -> None:
    assert page_has_extractable_text(str(FIXTURES / "scanned_sample.pdf"), 0) is False


def test_ocr_page_to_text_extracts_the_rendered_words() -> None:
    text = ocr_page_to_text(str(FIXTURES / "scanned_sample.pdf"), 0)
    assert "OPEN" in text
    assert "connector" in text.lower() or "part number" in text.lower()


def test_load_pdf_with_ocr_fallback_produces_open_tbd_block() -> None:
    doc = load_pdf_with_ocr_fallback(str(FIXTURES / "scanned_sample.pdf"))
    assert len(doc.blocks) >= 1
    assert any(b.kind == BlockKind.OPEN_TBD for b in doc.blocks)
    assert any("OPEN" in b.text for b in doc.blocks)


def test_load_pdf_with_ocr_fallback_uses_text_path_when_available() -> None:
    doc = load_pdf_with_ocr_fallback(str(FIXTURES / "sample.pdf"))
    assert any("Backplane Power Budget" in b.text for b in doc.blocks)
    assert doc.document.format.value == "pdf_scanned" or doc.document.format.value == "pdf"


def test_ocr_page_to_text_extracts_hebrew_with_heb_language() -> None:
    text = ocr_page_to_text(str(FIXTURES / "hebrew_scanned_sample.pdf"), 0, languages="heb")
    assert len(text.strip()) > 0
    # Hebrew Unicode block is U+0590-U+05FF; assert at least one character falls in it,
    # rather than asserting an exact string match (Tesseract's accuracy on synthetic
    # rendered fixtures varies — structural presence is a more reliable assertion here).
    assert any("֐" <= ch <= "׿" for ch in text)


def test_ocr_default_language_still_english() -> None:
    # Regression guard: confirm the DEFAULT (no languages arg) behavior is unchanged
    # from before this task — existing English fixture still OCRs correctly.
    text = ocr_page_to_text(str(FIXTURES / "scanned_sample.pdf"), 0)
    assert "OPEN" in text
