from pathlib import Path

from app.canonical.model import BlockKind
from app.loaders.text_loader import load_markdown, load_txt

FIXTURES = Path(__file__).parent / "fixtures"


def test_load_txt_produces_paragraph_blocks() -> None:
    doc = load_txt(str(FIXTURES / "sample.txt"))
    assert doc.document.format.value == "txt"
    assert len(doc.blocks) == 2
    assert all(b.kind == BlockKind.PARAGRAPH for b in doc.blocks)
    assert "widget subsystem" in doc.blocks[0].text


def test_load_markdown_produces_heading_depth_blocks() -> None:
    doc = load_markdown(str(FIXTURES / "sample.md"))
    headings = [b for b in doc.blocks if b.kind == BlockKind.HEADING]
    assert [h.heading_level for h in headings] == [1, 2, 3]
    assert [h.text for h in headings] == ["Receiver", "Broadcast & Inputs", "Channel scan"]

    paragraphs = [b for b in doc.blocks if b.kind == BlockKind.PARAGRAPH]
    assert any("scan all available channels" in p.text for p in paragraphs)

    list_items = [b for b in doc.blocks if b.kind == BlockKind.LIST_ITEM]
    assert len(list_items) == 2
    assert list_items[0].text == "Supports terrestrial broadcast"


def test_load_txt_sha256_is_populated() -> None:
    doc = load_txt(str(FIXTURES / "sample.txt"))
    assert len(doc.document.sha256) == 64
