from pathlib import Path
from unittest.mock import MagicMock, patch

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


def test_ocr_page_to_text_filtered_keeps_body_text() -> None:
    from app.loaders.ocr import ocr_page_to_text_filtered

    text = ocr_page_to_text_filtered(str(FIXTURES / "watermarked_sample.pdf"), 0)
    assert "receiver" in text.lower() or "channels" in text.lower()


def test_ocr_page_to_text_filtered_drops_low_confidence_words() -> None:
    # Empirical finding (Step 2 of the task brief): at the fixture's watermark
    # gray value (210,210,210), Tesseract's own binarization/layout analysis
    # does not surface "DRAFT" as a text candidate at all -- it never appears
    # in image_to_data's output, with any confidence. Sweeping gray values
    # from 130-210 showed a hard cutoff (~gray 160-170): below it, "DRAFT" is
    # detected at confidence ~96, statistically indistinguishable from body
    # text (95-96); above it, "DRAFT" is not detected as a word at all. There
    # is no gray value where Tesseract detects "DRAFT" AND scores it
    # meaningfully lower than body text -- so confidence_threshold=30 cannot
    # be credited with removing it here. This test therefore asserts the
    # true, observed outcome (the word is absent from filtered output)
    # without claiming the confidence heuristic is what discriminated it.
    from app.loaders.ocr import ocr_page_to_text_filtered

    text = ocr_page_to_text_filtered(str(FIXTURES / "watermarked_sample.pdf"), 0)
    assert "DRAFT" not in text


@patch("app.loaders.ocr.pytesseract.image_to_data")
@patch("app.loaders.ocr.convert_from_path")
def test_ocr_page_to_text_filtered_excludes_low_confidence_words(
    mock_convert_from_path: MagicMock, mock_image_to_data: MagicMock
) -> None:
    # Isolates the `conf >= confidence_threshold` comparison itself, independent of
    # whether any real fixture/Tesseract combination happens to exercise it (see the
    # note on test_ocr_page_to_text_filtered_drops_low_confidence_words above -- the
    # committed watermark fixture does not). Fully mocked: no Docker/Tesseract needed.
    from app.loaders.ocr import ocr_page_to_text_filtered

    mock_convert_from_path.return_value = [MagicMock()]
    mock_image_to_data.return_value = {
        "text": ["", "Hello", "world", "faintword"],
        "conf": ["-1", "95", "92", "12"],
    }

    result = ocr_page_to_text_filtered("fake_path.pdf", 0, confidence_threshold=30)

    assert "Hello" in result
    assert "world" in result
    assert "faintword" not in result
