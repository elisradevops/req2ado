from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.kb.chunker import chunk_canonical_doc

REF = SourceRef(document_path="doc.txt", start_offset=0, end_offset=0)


def _doc(blocks: list[Block]) -> CanonicalDoc:
    return CanonicalDoc(document=Document(path="doc.txt", format=DocumentFormat.TXT, sha256="h"), blocks=blocks)


def test_groups_blocks_into_one_chunk_per_heading_section() -> None:
    blocks = [
        Block(id="b0", kind=BlockKind.HEADING, text="Section 1", heading_level=1, source_ref=REF),
        Block(id="b1", kind=BlockKind.PARAGRAPH, text="Para under section 1", source_ref=REF),
        Block(id="b2", kind=BlockKind.HEADING, text="Section 2", heading_level=1, source_ref=REF),
        Block(id="b3", kind=BlockKind.PARAGRAPH, text="Para under section 2", source_ref=REF),
    ]
    chunks = chunk_canonical_doc(_doc(blocks))
    assert len(chunks) == 2
    assert chunks[0].text == "Section 1\nPara under section 1"
    assert chunks[0].chunk_index == 0
    assert chunks[1].text == "Section 2\nPara under section 2"
    assert chunks[1].chunk_index == 1


def test_preamble_before_first_heading_becomes_its_own_chunk() -> None:
    blocks = [
        Block(id="b0", kind=BlockKind.PARAGRAPH, text="Preamble text", source_ref=REF),
        Block(id="b1", kind=BlockKind.HEADING, text="Section 1", heading_level=1, source_ref=REF),
        Block(id="b2", kind=BlockKind.PARAGRAPH, text="Para under section 1", source_ref=REF),
    ]
    chunks = chunk_canonical_doc(_doc(blocks))
    assert len(chunks) == 2
    assert chunks[0].text == "Preamble text"
    assert chunks[1].text == "Section 1\nPara under section 1"


def test_a_subheading_joins_its_parent_sections_chunk() -> None:
    blocks = [
        Block(id="b0", kind=BlockKind.HEADING, text="Section 1", heading_level=1, source_ref=REF),
        Block(id="b1", kind=BlockKind.HEADING, text="1.1 Sub", heading_level=2, source_ref=REF),
        Block(id="b2", kind=BlockKind.PARAGRAPH, text="Para under 1.1", source_ref=REF),
    ]
    chunks = chunk_canonical_doc(_doc(blocks))
    assert len(chunks) == 1
    assert chunks[0].text == "Section 1\n1.1 Sub\nPara under 1.1"


def test_documents_with_no_headings_fall_back_to_a_fixed_size_window() -> None:
    blocks = [Block(id=f"b{i}", kind=BlockKind.PARAGRAPH, text=f"Para {i}", source_ref=REF) for i in range(25)]
    chunks = chunk_canonical_doc(_doc(blocks))
    assert len(chunks) == 3  # 25 blocks / window of 10 = 3 chunks (10, 10, 5)
    assert chunks[0].text == "\n".join(f"Para {i}" for i in range(10))
    assert chunks[2].text == "\n".join(f"Para {i}" for i in range(20, 25))
