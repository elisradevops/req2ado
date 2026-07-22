from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import Callable

from docx import Document as DocxDocument

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, Figure, SourceRef, Table

logger = logging.getLogger(__name__)

_STYLE_HEADING_PREFIX = "Heading "
_IMAGE_RELTYPE_MARKER = "image"


def load_docx(path: str, describe_figure: Callable[[bytes], str] | None = None) -> CanonicalDoc:
    """`describe_figure`, when provided, is called with each embedded
    image's raw bytes and must return a short text description -- used to
    replace the `[FIGURE: none]` placeholder with real content (see
    app/vision/orchestrator_vision_client.py). None (the default) preserves
    the original placeholder-only behavior exactly. A describe_figure
    failure for one image must not abort the whole document -- caught and
    falls back to the placeholder for that image only."""
    file_path = Path(path)
    sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
    document = Document(path=path, format=DocumentFormat.DOCX, sha256=sha256)

    docx_doc = DocxDocument(path)
    blocks: list[Block] = []
    tables: list[Table] = []
    block_id = 0
    offset = 0

    for paragraph in docx_doc.paragraphs:
        content = paragraph.text.strip()
        if not content:
            continue
        start = offset
        end = start + len(content)
        offset = end + 1

        style_name = paragraph.style.name if paragraph.style else ""
        if style_name.startswith(_STYLE_HEADING_PREFIX):
            level = int(style_name.removeprefix(_STYLE_HEADING_PREFIX))
            blocks.append(
                Block(
                    id=f"b{block_id}",
                    kind=BlockKind.HEADING,
                    text=content,
                    heading_level=level,
                    source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                )
            )
        else:
            blocks.append(
                Block(
                    id=f"b{block_id}",
                    kind=BlockKind.PARAGRAPH,
                    text=content,
                    source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                )
            )
        block_id += 1

    for table_index, docx_table in enumerate(docx_doc.tables):
        rows = [[cell.text.strip() for cell in row.cells] for row in docx_table.rows]
        tables.append(
            Table(
                id=f"t{table_index}",
                rows=rows,
                source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0),
            )
        )

    figures: list[Figure] = []
    for figure_index, rel in enumerate(docx_doc.part.rels.values()):
        if _IMAGE_RELTYPE_MARKER in rel.reltype:
            caption = None
            if describe_figure is not None:
                try:
                    caption = describe_figure(rel.target_part.blob)
                except Exception:  # noqa: BLE001 -- a vision failure must not abort the whole document
                    logger.warning("describe_figure failed for %s (rel target %s)", rel.target_part.content_type, rel.target_ref, exc_info=True)
                    caption = None
            figures.append(
                Figure(
                    id=f"f{figure_index}",
                    caption=caption,
                    source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0),
                )
            )
            blocks.append(
                Block(
                    id=f"b{block_id}",
                    kind=BlockKind.FIGURE,
                    text=f"[FIGURE: {caption or 'none'}]",
                    source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0),
                )
            )
            block_id += 1

    return CanonicalDoc(document=document, blocks=blocks, tables=tables, figures=figures)
