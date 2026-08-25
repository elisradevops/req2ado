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


def authored_numbering_label(block: Block) -> str | None:
    """The real, document-authored numbering label for a BASELINE-mode
    Requirement node's per-node Customer ID / source-requirement-number
    field (see WorkItemNode.customer_id's own docstring) -- e.g. "1.1.2.2"
    for a block whose text literally starts with that number.

    Deliberately narrower than resolve_block_depth: only ever returns a
    label for the plain-numbered-paragraph signal (the SAME branch
    resolve_block_depth's own `parse_numbering(block.text)` call already
    uses), never for a heading_level signal. A heading's `block.text` can
    be an ordinary sentence that merely STARTS with what looks like a
    number (id_hierarchy.py's own module docstring records a confirmed
    live false-positive on the real reference document: "3.3 V_AUX shall
    ..." -- a shall-adjacent digit inside heading prose, not the
    document's own printed requirement number) -- returning a label for
    heading blocks would risk exactly that fabrication. Returns None,
    honestly, for every heading-kind block and for any block with no
    literal numbering text at all -- never invented."""
    if block.kind == BlockKind.HEADING and block.heading_level is not None:
        return None
    label, _remainder = parse_numbering(block.text)
    return label
