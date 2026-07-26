from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import Callable

from docx import Document as DocxDocument
from docx.oxml.ns import qn
from docx.table import Table as DocxTable
from docx.text.paragraph import Paragraph as DocxParagraph

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, Figure, SourceRef, Table

logger = logging.getLogger(__name__)

_STYLE_HEADING_PREFIX = "Heading "
_IMAGE_RELTYPE_MARKER = "image"


def _describe_one_figure(
    rel, describe_figure: Callable[[bytes], str] | None
) -> str | None:
    """Shared per-image describe_figure call + failure handling, used by
    both the inline (real document-order) and fallback (floating/unmatched
    rel) figure paths below -- a vision failure for one image must not
    abort the whole document, same guarantee either path relies on."""
    if describe_figure is None:
        return None
    try:
        return describe_figure(rel.target_part.blob)
    except Exception:  # noqa: BLE001 -- a vision failure must not abort the whole document
        logger.warning(
            "describe_figure failed for %s (rel target %s)", rel.target_part.content_type, rel.target_ref, exc_info=True
        )
        return None


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
    figures: list[Figure] = []
    block_id = 0
    table_index = 0
    figure_index = 0
    offset = 0
    # Every image rel consumed inline (see the w:p branch below) is recorded
    # here so the fallback pass after the body walk doesn't double-emit it.
    consumed_rel_ids: set[str] = set()

    # Single body-element walk (python-docx's standard idiom for document
    # order) instead of the previous two SEPARATE extraction passes
    # (docx_doc.paragraphs, then docx_doc.tables) -- that lost any real
    # ordering relationship between the two: a table's SourceRef was always
    # the (0,0) placeholder, and render_section could only ever append ALL
    # of a branch's tables at its very end, never interleaved at their real
    # position. Sharing one monotonically increasing `offset` counter across
    # blocks, tables, AND inline figures (see below) gives every element a
    # real, comparable order position.
    for child in docx_doc.element.body.iterchildren():
        if child.tag == qn("w:p"):
            paragraph = DocxParagraph(child, docx_doc)
            content = paragraph.text.strip()
            # Inline drawings (a pasted image, or a converted EMF/WMF
            # diagram) embedded directly in this paragraph -- resolved via
            # the DrawingML <a:blip r:embed="..."> reference to the actual
            # image part. Previously EVERY image rel on the whole document
            # was collected in one pass AFTER this body walk finished, each
            # given a (0, 0) placeholder SourceRef -- so every figure folded
            # into whichever node happened to be open LAST, not its real
            # parent (see tree_builder.py's depth=None fold). Resolving
            # inline, at the paragraph's own position, gives each figure the
            # same real-position treatment tables already got.
            blip_elements = child.findall(f".//{qn('a:blip')}")
            embed_ids = [embed_id for b in blip_elements if (embed_id := b.get(qn("r:embed")))]

            if not content and not embed_ids:
                continue

            if content:
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

            for embed_id in embed_ids:
                rel = docx_doc.part.rels.get(embed_id)
                if rel is None or _IMAGE_RELTYPE_MARKER not in rel.reltype:
                    continue
                consumed_rel_ids.add(embed_id)
                caption = _describe_one_figure(rel, describe_figure)
                start = offset
                end = start + 1
                offset = end
                figures.append(
                    Figure(
                        id=f"f{figure_index}",
                        caption=caption,
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                    )
                )
                blocks.append(
                    Block(
                        id=f"b{block_id}",
                        kind=BlockKind.FIGURE,
                        text=f"[FIGURE: {caption or 'none'}]",
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                    )
                )
                block_id += 1
                figure_index += 1
        elif child.tag == qn("w:tbl"):
            docx_table = DocxTable(child, docx_doc)
            rows = [[cell.text.strip() for cell in row.cells] for row in docx_table.rows]
            start = offset
            end = start + 1
            offset = end
            tables.append(
                Table(
                    id=f"t{table_index}",
                    rows=rows,
                    source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                )
            )
            table_index += 1

    # Fallback: any image rel NOT consumed above (a floating/anchored
    # drawing rather than an inline one, a header/footer image, or any
    # other embedding this walk doesn't recognize) keeps the previous
    # append-at-end, (0, 0)-placeholder behavior -- a documented
    # approximation for the cases this walk can't place, not silent loss.
    for rel_id, rel in docx_doc.part.rels.items():
        if rel_id in consumed_rel_ids or _IMAGE_RELTYPE_MARKER not in rel.reltype:
            continue
        caption = _describe_one_figure(rel, describe_figure)
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
        figure_index += 1

    return CanonicalDoc(document=document, blocks=blocks, tables=tables, figures=figures)
