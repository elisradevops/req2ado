from app.canonical.model import Block, BlockKind, SourceRef
from app.leveling.depth import resolve_block_depth


def _sr() -> SourceRef:
    return SourceRef(document_path="x", start_offset=0, end_offset=1)


def test_heading_block_uses_heading_level_as_depth() -> None:
    block = Block(id="b0", kind=BlockKind.HEADING, heading_level=2, text="Broadcast & Inputs", source_ref=_sr())
    depth, display_text = resolve_block_depth(block)
    assert depth == 2
    assert display_text == "Broadcast & Inputs"


def test_numbered_paragraph_block_uses_numbering_depth() -> None:
    block = Block(id="b1", kind=BlockKind.PARAGRAPH, text="1.1.1 Channel scan", source_ref=_sr())
    depth, display_text = resolve_block_depth(block)
    assert depth == 3
    assert display_text == "Channel scan"


def test_unleveled_block_returns_none_depth() -> None:
    block = Block(id="b2", kind=BlockKind.PARAGRAPH, text="This is plain body text.", source_ref=_sr())
    depth, display_text = resolve_block_depth(block)
    assert depth is None
    assert display_text == "This is plain body text."


def test_heading_block_without_heading_level_falls_back_to_numbering() -> None:
    # Defensive case: a HEADING-kind block that somehow has no heading_level
    # set should fall back to the numbering-parse path rather than crashing.
    block = Block(id="b3", kind=BlockKind.HEADING, text="1.1 Broadcast & Inputs", source_ref=_sr())
    depth, display_text = resolve_block_depth(block)
    assert depth == 2
    assert display_text == "Broadcast & Inputs"
