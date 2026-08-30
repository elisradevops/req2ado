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


def test_load_txt_degrades_instead_of_raising_on_non_utf8_bytes(tmp_path: Path) -> None:
    # Real regression: a Hebrew CP1255 .txt file previously raised
    # UnicodeDecodeError (read_text(encoding="utf-8") has no errors=) and
    # aborted ingestion entirely -- against this codebase's own
    # degrade-don't-raise discipline.
    path = tmp_path / "hebrew.txt"
    path.write_bytes("שלום עולם".encode("cp1255"))
    doc = load_txt(str(path))  # must not raise
    note_blocks = [b for b in doc.blocks if b.kind == BlockKind.NOTE]
    assert len(note_blocks) == 1
    assert note_blocks[0].text.startswith("[UNSUPPORTED:")


def test_load_markdown_degrades_instead_of_raising_on_non_utf8_bytes(tmp_path: Path) -> None:
    path = tmp_path / "hebrew.md"
    path.write_bytes("# שלום עולם".encode("cp1255"))
    doc = load_markdown(str(path))  # must not raise
    note_blocks = [b for b in doc.blocks if b.kind == BlockKind.NOTE]
    assert len(note_blocks) == 1
    assert note_blocks[0].text.startswith("[UNSUPPORTED:")


def test_load_markdown_duplicated_heading_gets_distinct_offsets(tmp_path: Path) -> None:
    # Regression test: load_markdown previously used `text.index(content)`
    # (always searching from position 0), so a heading/paragraph repeated
    # later in the document resolved to the FIRST occurrence's offset.
    md_path = tmp_path / "duplicate.md"
    md_path.write_text(
        "# Overview\n\nSome text.\n\n# Overview\n\nMore text.\n",
        encoding="utf-8",
    )
    doc = load_markdown(str(md_path))
    headings = [b for b in doc.blocks if b.kind == BlockKind.HEADING]
    assert len(headings) == 2
    assert headings[0].text == headings[1].text == "Overview"
    assert headings[1].source_ref.start_offset > headings[0].source_ref.start_offset
