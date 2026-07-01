from __future__ import annotations

import hashlib
import re
from pathlib import Path

import pytesseract
from pdf2image import convert_from_path
from pypdf import PdfReader

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


def load_pdf_with_ocr_fallback(path: str, languages: str = "eng") -> CanonicalDoc:
    reader = PdfReader(path)
    num_pages = len(reader.pages)

    any_scanned = any(not page_has_extractable_text(path, i) for i in range(num_pages))
    if not any_scanned:
        return load_pdf(path)

    file_path = Path(path)
    sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
    document = Document(path=path, format=DocumentFormat.PDF_SCANNED, sha256=sha256)

    text_doc = load_pdf(path)
    blocks: list[Block] = list(text_doc.blocks)
    block_id = len(blocks)

    for page_index in range(num_pages):
        if page_has_extractable_text(path, page_index):
            continue
        ocr_text = ocr_page_to_text(path, page_index, languages=languages).strip()
        if not ocr_text:
            continue
        kind = BlockKind.OPEN_TBD if _OPEN_TBD_PATTERN.search(ocr_text) else BlockKind.PARAGRAPH
        blocks.append(
            Block(
                id=f"b{block_id}",
                kind=kind,
                text=ocr_text,
                source_ref=SourceRef(
                    document_path=path, start_offset=0, end_offset=len(ocr_text), page=page_index + 1
                ),
            )
        )
        block_id += 1

    return CanonicalDoc(document=document, blocks=blocks, tables=text_doc.tables)
