from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Callable

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, Figure, SourceRef

_PLACEHOLDER_TITLE_IDX = 0  # pptx.enum.shapes placeholder idx for the title placeholder


def load_pptx(path: str, describe_figure: Callable[[bytes], str] | None = None) -> CanonicalDoc:
    """One slide -> one HEADING block (its title placeholder, if present) +
    one PARAGRAPH block per other text-frame paragraph (bullets), in slide
    order, then one NOTE block for the slide's speaker notes (if any) and
    one FIGURE block per embedded picture -- same describe_figure convention
    as load_docx (see its docstring): None (the default) leaves figures as
    a bare '[FIGURE: none]' placeholder; a captioning failure for one image
    never aborts the rest of the deck."""
    file_path = Path(path)
    sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
    document = Document(path=path, format=DocumentFormat.PPTX, sha256=sha256)

    presentation = Presentation(path)
    blocks: list[Block] = []
    figures: list[Figure] = []
    block_id = 0
    figure_index = 0
    offset = 0

    # 1-based: slide numbers are conventionally 1-based (matches how a
    # human would refer to "slide 1"), and page_provenance's docstring in
    # model.py already treats a pptx slide index as a real, ground-truth
    # pagination source -- not an approximation needing a provenance tag.
    for slide_index, slide in enumerate(presentation.slides, start=1):
        title_shape = slide.shapes.title
        for shape in slide.shapes:
            if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
                caption = None
                if describe_figure is not None:
                    try:
                        caption = describe_figure(shape.image.blob)
                    except Exception:  # noqa: BLE001 -- a vision failure must not abort the whole deck
                        caption = None
                # A figure gets a real slot in the same running offset
                # counter used for text blocks below (like docx_loader's
                # table handling), instead of a hardcoded (0, 0), so it
                # orders correctly WITHIN its slide relative to surrounding
                # text -- not just at the right slide via `page`.
                start = offset
                end = start + 1
                offset = end
                figures.append(
                    Figure(
                        id=f"f{figure_index}",
                        caption=caption,
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=slide_index),
                    )
                )
                blocks.append(
                    Block(
                        id=f"b{block_id}",
                        kind=BlockKind.FIGURE,
                        text=f"[FIGURE: {caption or 'none'}]",
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=slide_index),
                    )
                )
                block_id += 1
                figure_index += 1
                continue

            if not shape.has_text_frame:
                continue
            is_title = title_shape is not None and shape.shape_id == title_shape.shape_id
            for paragraph in shape.text_frame.paragraphs:
                content = "".join(run.text for run in paragraph.runs).strip() or paragraph.text.strip()
                if not content:
                    continue
                start = offset
                end = start + len(content)
                offset = end + 1
                blocks.append(
                    Block(
                        id=f"b{block_id}",
                        kind=BlockKind.HEADING if is_title else BlockKind.PARAGRAPH,
                        text=content,
                        heading_level=1 if is_title else None,
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=slide_index),
                    )
                )
                block_id += 1

        if slide.has_notes_slide:
            notes = slide.notes_slide.notes_text_frame.text.strip()
            if notes:
                start = offset
                end = start + len(notes)
                offset = end + 1
                # Every block/figure on this slide -- title, bullets, notes,
                # figures -- must set the SAME slide_index as `page`. Mixing
                # a real page on some elements with None (-> 0 via `ref.page
                # or 0`, see tree_builder._order_key) on others would sort
                # this slide's own content inconsistently against itself and
                # against other slides', not just leave it unranked.
                blocks.append(
                    Block(
                        id=f"b{block_id}",
                        kind=BlockKind.NOTE,
                        text=notes,
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=slide_index),
                    )
                )
                block_id += 1

    return CanonicalDoc(document=document, blocks=blocks, figures=figures)
