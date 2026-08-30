from __future__ import annotations

from app.canonical.model import Block, BlockKind, Figure, SourceRef


def append_figure(
    figures: list[Figure],
    blocks: list[Block],
    *,
    figure_id: str,
    block_id: str,
    caption: str | None,
    document_path: str,
    start_offset: int,
    end_offset: int,
    page: int | None = None,
    name: str | None = None,
) -> None:
    """Emits the matching Figure+Block pair every visual loader (pdf/docx/
    pptx) produces for one detected image -- same id scheme, same
    source_ref shape, same `[FIGURE: ...]` block-text convention. Was
    hand-repeated at each of the 4 call sites across those 3 loaders.
    Callers still own their own id/offset counters and increment them
    after calling this."""
    source_ref = SourceRef(document_path=document_path, start_offset=start_offset, end_offset=end_offset, page=page)
    figures.append(Figure(id=figure_id, caption=caption, name=name, source_ref=source_ref))
    blocks.append(Block(id=block_id, kind=BlockKind.FIGURE, text=f"[FIGURE: {caption or 'none'}]", source_ref=source_ref))
