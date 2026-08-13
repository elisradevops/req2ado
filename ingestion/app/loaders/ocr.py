from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Callable

import pytesseract
from pdf2image import convert_from_path
from pypdf import PdfReader
from pytesseract import Output

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.loaders.pdf_loader import load_pdf, page_has_extractable_text

_OPEN_TBD_PATTERN = re.compile(r"\b(OPEN|TBD)\b[:\s]", re.IGNORECASE)


def ocr_page_to_text(path: str, page_index: int, languages: str = "eng") -> str:
    """`languages` is passed directly to Tesseract's `lang` parameter; join
    multiple language codes with '+' for mixed-script documents, e.g.
    'heb+eng' for Hebrew narrative with embedded English part numbers.
    Requires the corresponding Tesseract language pack to be installed
    (e.g. `tesseract-ocr-heb` on Debian/Ubuntu for 'heb')."""
    images = convert_from_path(path, first_page=page_index + 1, last_page=page_index + 1)
    return pytesseract.image_to_string(images[0], lang=languages)


def ocr_page_to_text_filtered(
    path: str, page_index: int, languages: str = "eng", confidence_threshold: int = 30
) -> str:
    """Best-effort watermark mitigation: drops words below `confidence_threshold`
    (Tesseract's 0-100 confidence scale; -1 means non-text region, always
    dropped). Watermarks are OFTEN rendered fainter than body text, which
    OFTEN produces lower OCR confidence -- but this is a heuristic, not a
    guarantee. It will not detect a watermark rendered at similar contrast
    to body text, and may occasionally drop genuine low-confidence body
    text (e.g. blurry scans). Empirically (see tests/fixtures/build_
    watermarked_pdf_fixture.py), Tesseract's own binarization step often
    excludes faint text as a word candidate entirely -- rather than
    detecting it at a low-but-nonzero confidence -- so this filter cannot
    be relied on to discriminate a watermark that IS detected as text from
    body text; it only helps when a watermark IS detected but scored low.
    Full watermark detection (image-processing based) is out of scope for
    this function."""
    images = convert_from_path(path, first_page=page_index + 1, last_page=page_index + 1)
    data = pytesseract.image_to_data(images[0], lang=languages, output_type=Output.DICT)

    kept_words = [
        word
        for word, conf in zip(data["text"], data["conf"])
        if word.strip() and int(conf) >= confidence_threshold
    ]
    return " ".join(kept_words)


def load_pdf_with_ocr_fallback(
    path: str, languages: str = "eng", describe_figure: Callable[[bytes], str] | None = None
) -> CanonicalDoc:
    reader = PdfReader(path)
    num_pages = len(reader.pages)

    any_scanned = any(not page_has_extractable_text(path, i) for i in range(num_pages))
    if not any_scanned:
        return load_pdf(path, describe_figure=describe_figure)

    file_path = Path(path)
    sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
    document = Document(path=path, format=DocumentFormat.PDF_SCANNED, sha256=sha256)

    text_doc = load_pdf(path, describe_figure=describe_figure)
    blocks: list[Block] = list(text_doc.blocks)

    for page_index in range(num_pages):
        if page_has_extractable_text(path, page_index):
            continue
        ocr_text = ocr_page_to_text_filtered(path, page_index, languages=languages).strip()
        if not ocr_text:
            continue
        kind = BlockKind.OPEN_TBD if _OPEN_TBD_PATTERN.search(ocr_text) else BlockKind.PARAGRAPH
        blocks.append(
            Block(
                id="",
                kind=kind,
                text=ocr_text,
                source_ref=SourceRef(
                    document_path=path, start_offset=0, end_offset=len(ocr_text), page=page_index + 1
                ),
            )
        )

    # text_doc.blocks is page-ordered but only covers pages with extractable
    # text; OCR blocks for scanned pages were appended above in a separate
    # pass, so a document like [text, scanned, text] would otherwise end up
    # as [page1, page3, page2-OCR] instead of [page1, page2-OCR, page3].
    # Re-sort by page (stable, so same-page block order is preserved) and
    # reassign sequential ids — nothing downstream keys off a block's
    # original id value beyond uniqueness.
    blocks.sort(key=lambda b: b.source_ref.page or 0)
    for i, block in enumerate(blocks):
        block.id = f"b{i}"

    return CanonicalDoc(document=document, blocks=blocks, tables=text_doc.tables, figures=text_doc.figures)
