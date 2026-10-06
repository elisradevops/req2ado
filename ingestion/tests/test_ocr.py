from pathlib import Path
from unittest.mock import MagicMock, patch

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.loaders.ocr import load_pdf_with_ocr_fallback
from app.loaders.pdf_loader import page_has_extractable_text

FIXTURES = Path(__file__).parent / "fixtures"


def test_scanned_page_has_no_extractable_text() -> None:
    assert page_has_extractable_text(str(FIXTURES / "scanned_sample.pdf"), 0) is False


def test_load_pdf_with_ocr_fallback_produces_open_tbd_block() -> None:
    doc = load_pdf_with_ocr_fallback(str(FIXTURES / "scanned_sample.pdf"))
    assert len(doc.blocks) >= 1
    assert any(b.kind == BlockKind.OPEN_TBD for b in doc.blocks)
    assert any("OPEN" in b.text for b in doc.blocks)


def test_load_pdf_with_ocr_fallback_uses_text_path_when_available() -> None:
    doc = load_pdf_with_ocr_fallback(str(FIXTURES / "sample.pdf"))
    assert any("Backplane Power Budget" in b.text for b in doc.blocks)
    assert doc.document.format.value == "pdf_scanned" or doc.document.format.value == "pdf"


def test_ocr_page_to_text_filtered_extracts_hebrew_with_heb_language() -> None:
    # Folded over from the deleted, test-only ocr_page_to_text: this is the
    # only real-Tesseract (non-mocked) proof that a non-default `languages`
    # value actually OCRs, as opposed to merely being forwarded as a kwarg
    # (which the mocked ..._forwards_languages_to_image_to_data test covers).
    # The filtered variant is the real production path
    # (load_pdf_with_ocr_fallback -> ocr_page_to_text_filtered).
    from app.loaders.ocr import ocr_page_to_text_filtered

    text = ocr_page_to_text_filtered(str(FIXTURES / "hebrew_scanned_sample.pdf"), 0, languages="heb")
    assert len(text.strip()) > 0
    # Hebrew Unicode block is U+0590-U+05FF; assert at least one character falls in it,
    # rather than asserting an exact string match (Tesseract's accuracy on synthetic
    # rendered fixtures varies — structural presence is a more reliable assertion here).
    assert any("֐" <= ch <= "׿" for ch in text)


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


@patch("app.loaders.pdf_loader.pytesseract.image_to_data")
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


@patch("app.loaders.ocr.PdfReader")
@patch("app.loaders.ocr.ocr_page_to_text_filtered")
@patch("app.loaders.ocr.page_has_extractable_text")
@patch("app.loaders.ocr.load_pdf")
def test_load_pdf_with_ocr_fallback_preserves_page_order_for_mixed_documents(
    mock_load_pdf: MagicMock,
    mock_page_has_extractable_text: MagicMock,
    mock_ocr_page_to_text_filtered: MagicMock,
    mock_pdf_reader: MagicMock,
) -> None:
    # Regression test for a real ordering bug: OCR blocks for scanned pages
    # used to be appended after ALL text-extracted blocks regardless of
    # actual page position, so a [text, scanned, text] document came out as
    # [page1, page3, page2-OCR] instead of [page1, page2-OCR, page3]. Fully
    # mocked (no Docker/Tesseract/poppler needed) to isolate the ordering
    # logic from real OCR/extraction behavior.
    mock_pdf_reader.return_value.pages = [MagicMock(), MagicMock(), MagicMock()]
    # Page 2 (index 1) is the only scanned page.
    mock_page_has_extractable_text.side_effect = lambda _path, i: i != 1

    path = str(FIXTURES / "sample.pdf")
    mock_load_pdf.return_value = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.PDF, sha256="fake"),
        blocks=[
            Block(
                id="b0",
                kind=BlockKind.PARAGRAPH,
                text="page one text",
                source_ref=SourceRef(document_path=path, start_offset=0, end_offset=1, page=1),
            ),
            Block(
                id="b1",
                kind=BlockKind.PARAGRAPH,
                text="page three text",
                source_ref=SourceRef(document_path=path, start_offset=0, end_offset=1, page=3),
            ),
        ],
        tables=[],
    )
    mock_ocr_page_to_text_filtered.return_value = "page two ocr text"

    doc = load_pdf_with_ocr_fallback(path)

    assert [b.text for b in doc.blocks] == ["page one text", "page two ocr text", "page three text"]
    assert [b.source_ref.page for b in doc.blocks] == [1, 2, 3]


@patch("app.loaders.pdf_loader.pytesseract.image_to_data")
@patch("app.loaders.ocr.convert_from_path")
def test_ocr_page_to_text_filtered_forwards_languages_to_image_to_data(
    mock_convert_from_path: MagicMock, mock_image_to_data: MagicMock
) -> None:
    # Closes the gap between the languages kwarg and confidence_threshold: the
    # real default production path is load_pdf_with_ocr_fallback ->
    # ocr_page_to_text_filtered, so we need direct proof that `languages`
    # forwards correctly through THIS function (the mocked case), on top of
    # the real-Tesseract Hebrew proof folded onto
    # test_ocr_page_to_text_filtered_extracts_hebrew_with_heb_language above.
    # Fully mocked here: no Docker/Tesseract needed.
    from app.loaders.ocr import ocr_page_to_text_filtered

    mock_convert_from_path.return_value = [MagicMock()]
    mock_image_to_data.return_value = {
        "text": ["", "Hello"],
        "conf": ["-1", "95"],
    }

    ocr_page_to_text_filtered("fake.pdf", 0, languages="heb", confidence_threshold=30)

    assert mock_image_to_data.call_args.kwargs["lang"] == "heb"


def test_load_pdf_with_ocr_fallback_forwards_languages_to_load_pdf_when_nothing_is_scanned() -> None:
    # any_scanned=False branch (ocr.py:64-65) -- the common case for a real
    # document that has extractable text overall but individual table cells
    # missing text (the motivating bug this whole plan exists to fix).
    from unittest.mock import patch

    from app.canonical.model import CanonicalDoc, Document, DocumentFormat

    fake_doc = CanonicalDoc(document=Document(path="x", format=DocumentFormat.PDF, sha256="h"))
    with patch("app.loaders.ocr.page_has_extractable_text", return_value=True), \
         patch("app.loaders.ocr.load_pdf") as mock_load_pdf:
        mock_load_pdf.return_value = fake_doc
        load_pdf_with_ocr_fallback(str(FIXTURES / "sample.pdf"), languages="heb+eng")
    mock_load_pdf.assert_called_once_with(str(FIXTURES / "sample.pdf"), describe_figure=None, languages="heb+eng")


def test_load_pdf_with_ocr_fallback_forwards_languages_to_load_pdf_when_a_page_is_scanned() -> None:
    # any_scanned=True branch (ocr.py:71) -- the text_doc build call, a
    # separate call site from the one above with its own independent gap.
    from unittest.mock import patch

    from app.canonical.model import CanonicalDoc, Document, DocumentFormat

    fake_doc = CanonicalDoc(document=Document(path="x", format=DocumentFormat.PDF, sha256="h"))
    with patch("app.loaders.ocr.page_has_extractable_text", return_value=False), \
         patch("app.loaders.ocr.ocr_page_to_text_filtered", return_value=""), \
         patch("app.loaders.ocr.load_pdf") as mock_load_pdf:
        mock_load_pdf.return_value = fake_doc
        load_pdf_with_ocr_fallback(str(FIXTURES / "scanned_sample.pdf"), languages="heb+eng")
    mock_load_pdf.assert_called_once_with(str(FIXTURES / "scanned_sample.pdf"), describe_figure=None, languages="heb+eng")


def _mixed_pdf_mocks(  # noqa: ANN202
    mock_load_pdf, mock_page_has_extractable_text, mock_ocr, mock_pdf_reader, scanned,  # noqa: ANN001
):
    mock_pdf_reader.return_value.pages = [MagicMock() for _ in range(5)]
    mock_page_has_extractable_text.side_effect = lambda _path, i: i not in scanned
    path = str(FIXTURES / "sample.pdf")
    mock_load_pdf.return_value = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.PDF, sha256="fake"),
        blocks=[], tables=[],
    )
    mock_ocr.side_effect = lambda _p, i, languages="eng": f"text of page {i + 1}"
    return path


@patch("app.loaders.ocr.PdfReader")
@patch("app.loaders.ocr.ocr_page_to_text_filtered")
@patch("app.loaders.ocr.page_has_extractable_text")
@patch("app.loaders.ocr.load_pdf")
def test_on_ocr_page_reports_each_scanned_page_with_counts(
    mock_load_pdf: MagicMock, mock_has_text: MagicMock, mock_ocr: MagicMock, mock_reader: MagicMock,
) -> None:
    path = _mixed_pdf_mocks(mock_load_pdf, mock_has_text, mock_ocr, mock_reader, scanned={1, 3, 4})
    calls: list[tuple] = []

    doc = load_pdf_with_ocr_fallback(path, on_ocr_page=lambda *args: calls.append(args))

    # (done, total scanned, PDF page, PDF page count, recognised text)
    assert calls == [
        (1, 3, 2, 5, "text of page 2"),
        (2, 3, 4, 5, "text of page 4"),
        (3, 3, 5, 5, "text of page 5"),
    ]
    assert [b.source_ref.page for b in doc.blocks] == [2, 4, 5]


@patch("app.loaders.ocr.PdfReader")
@patch("app.loaders.ocr.ocr_page_to_text_filtered")
@patch("app.loaders.ocr.page_has_extractable_text")
@patch("app.loaders.ocr.load_pdf")
def test_a_failing_on_ocr_page_callback_never_changes_the_result(
    mock_load_pdf: MagicMock, mock_has_text: MagicMock, mock_ocr: MagicMock, mock_reader: MagicMock,
) -> None:
    path = _mixed_pdf_mocks(mock_load_pdf, mock_has_text, mock_ocr, mock_reader, scanned={1, 3})
    calls: list[int] = []

    def boom(*args) -> None:  # noqa: ANN002
        calls.append(args[0])
        raise RuntimeError("observer exploded")

    with_callback = load_pdf_with_ocr_fallback(path, on_ocr_page=boom)
    without = load_pdf_with_ocr_fallback(path)

    assert calls == [1]  # dropped after the first failure
    assert [(b.text, b.source_ref.page) for b in with_callback.blocks] == [
        (b.text, b.source_ref.page) for b in without.blocks
    ]


@patch("app.loaders.ocr.PdfReader")
@patch("app.loaders.ocr.ocr_page_to_text_filtered")
@patch("app.loaders.ocr.page_has_extractable_text")
@patch("app.loaders.ocr.load_pdf")
def test_on_ocr_page_is_not_called_for_a_text_pdf(
    mock_load_pdf: MagicMock, mock_has_text: MagicMock, mock_ocr: MagicMock, mock_reader: MagicMock,
) -> None:
    path = _mixed_pdf_mocks(mock_load_pdf, mock_has_text, mock_ocr, mock_reader, scanned=set())
    calls: list[tuple] = []

    load_pdf_with_ocr_fallback(path, on_ocr_page=lambda *args: calls.append(args))

    assert calls == []
