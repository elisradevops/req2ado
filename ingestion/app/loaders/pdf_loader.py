from __future__ import annotations

import hashlib
from pathlib import Path

import pdfplumber
from pypdf import PdfReader

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef, Table


def page_has_extractable_text(path: str, page_index: int) -> bool:
    reader = PdfReader(path)
    page = reader.pages[page_index]
    text = page.extract_text() or ""
    return len(text.strip()) > 0


def load_pdf(path: str) -> CanonicalDoc:
    file_path = Path(path)
    sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
    document = Document(path=path, format=DocumentFormat.PDF, sha256=sha256)

    blocks: list[Block] = []
    tables: list[Table] = []
    block_id = 0
    table_id = 0

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

    return CanonicalDoc(document=document, blocks=blocks, tables=tables)
