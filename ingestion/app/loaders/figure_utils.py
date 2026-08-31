from __future__ import annotations

import re

from app.canonical.model import Block, BlockKind, Figure, SourceRef

_FIGURE_CAPTION_PATTERN = re.compile(r"^Figure\s+[\w.]+[:.]?\s*(.*)$", re.IGNORECASE)


def extract_figure_title(text: str) -> str | None:
    """Parses an author-written "Figure N: Title" (or "Figure N." with no
    title) line into just the title text. Returns None when `text` doesn't
    look like a figure-label line at all -- callers with an independent
    signal that the text IS a caption regardless (e.g. docx's own "Caption"
    paragraph style) should fall back to the raw stripped text themselves;
    callers relying on this pattern as their ONLY signal (e.g. pdf's
    geometric-proximity heuristic) should treat None as "not a caption"."""
    stripped = text.strip()
    match = _FIGURE_CAPTION_PATTERN.match(stripped)
    if match is None:
        return None
    return match.group(1).strip() or stripped


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
