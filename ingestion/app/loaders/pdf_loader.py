from __future__ import annotations

import hashlib
from functools import lru_cache
from pathlib import Path
from typing import Callable

import pdfplumber
from pypdf import PdfReader

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, Figure, SourceRef, Table


@lru_cache(maxsize=8)
def cached_pdf_reader(path: str) -> PdfReader:
    # load_pdf_with_ocr_fallback previously called page_has_extractable_text
    # once per page in an `any(...)` scan pass, then again in the main loop
    # -- each call constructed a brand-new PdfReader(path) (itself an O(pages)
    # parse), so a P-page document did ~2P full-document reparses, O(P^2)
    # total. Caching the reader per path (bounded small LRU, not unbounded --
    # this is a request-scoped ingestion process, not a long-lived server
    # cache that should grow forever) turns that into one real parse.
    return PdfReader(path)


def page_has_extractable_text(path: str, page_index: int) -> bool:
    reader = cached_pdf_reader(path)
    page = reader.pages[page_index]
    text = page.extract_text() or ""
    return len(text.strip()) > 0


def load_pdf(path: str, describe_figure: Callable[[bytes], str] | None = None) -> CanonicalDoc:
    """`describe_figure`, when provided, is called with each embedded
    image's raw bytes and must return a short text description -- used to
    replace the `[FIGURE: none]` placeholder with real content (see
    app/vision/orchestrator_vision_client.py). None (the default) preserves
    the original placeholder-only behavior exactly. A describe_figure
    failure for one image must not abort the whole document -- caught and
    falls back to the placeholder for that image only."""
    file_path = Path(path)
    sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
    document = Document(path=path, format=DocumentFormat.PDF, sha256=sha256)

    blocks: list[Block] = []
    tables: list[Table] = []
    figures: list[Figure] = []
    block_id = 0
    table_id = 0
    figure_id = 0

    with pdfplumber.open(path) as pdf:
        for page_number, page in enumerate(pdf.pages, start=1):
            text = page.extract_text() or ""
            offset = 0
            for paragraph in (p for p in text.split("\n\n") if p.strip()):
                start = text.index(paragraph, offset)
                end = start + len(paragraph)
                offset = end
                blocks.append(
                    Block(
                        id=f"b{block_id}",
                        kind=BlockKind.PARAGRAPH,
                        text=paragraph.strip(),
                        source_ref=SourceRef(
                            document_path=path, start_offset=start, end_offset=end, page=page_number
                        ),
                    )
                )
                block_id += 1

            for extracted_table in page.extract_tables():
                rows: list[list[str]] = [[cell or "" for cell in row] for row in extracted_table]
                tables.append(
                    Table(
                        id=f"t{table_id}",
                        rows=rows,
                        source_ref=SourceRef(
                            document_path=path, start_offset=0, end_offset=0, page=page_number
                        ),
                    )
                )
                table_id += 1

            # pdfplumber has no natural text offset for an embedded image
            # region, same reasoning as tables above (placeholder 0, 0).
            # Image BYTES come from pypdf's reader (cached_pdf_reader, same
            # cache Task 6 added) rather than pdfplumber's own `page.images`
            # -- pypdf's ImageFile.data is a real decodable image file,
            # which describe_figure needs; pdfplumber's raw stream data
            # isn't guaranteed to be a standalone-decodable image.
            pypdf_page = cached_pdf_reader(path).pages[page_number - 1]
            for pypdf_image in pypdf_page.images:
                caption = None
                if describe_figure is not None:
                    try:
                        caption = describe_figure(pypdf_image.data)
                    except Exception:  # noqa: BLE001 -- a vision failure must not abort the whole document
                        caption = None
                figures.append(
                    Figure(
                        id=f"f{figure_id}",
                        caption=caption,
                        source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0, page=page_number),
                    )
                )
                blocks.append(
                    Block(
                        id=f"b{block_id}",
                        kind=BlockKind.FIGURE,
                        text=f"[FIGURE: {caption or 'none'}]",
                        source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0, page=page_number),
                    )
                )
                block_id += 1
                figure_id += 1

    return CanonicalDoc(document=document, blocks=blocks, tables=tables, figures=figures)
