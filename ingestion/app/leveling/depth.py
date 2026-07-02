from __future__ import annotations

from app.canonical.model import Block, BlockKind
from app.leveling.numbering import numbering_depth, parse_numbering


def resolve_block_depth(block: Block) -> tuple[int | None, str]:
    """Resolves a block's effective hierarchy depth from whichever signal is
    present: an explicit heading_level (from md/docx heading markup), or a
    parsed numbering label (from plain numbered-text specs like '1.1.1.1').
    Returns (None, block.text) for unleveled body content (plain paragraphs,
    list items, notes, OPEN/TBD markers, inline figure placeholders)."""
    if block.kind == BlockKind.HEADING and block.heading_level is not None:
        return block.heading_level, block.text

    label, remainder = parse_numbering(block.text)
    if label is not None:
        return numbering_depth(label), remainder

    return None, block.text
