# ingestion/tests/test_source_excerpt.py
from pathlib import Path

from fastapi.testclient import TestClient

from app import source_excerpt as source_excerpt_module
from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.dispatch import dispatch_by_extension
from app.leveling.tree_builder import build_baseline_tree
from app.main import app
from app.source_excerpt import MAX_EXCERPT_CHARS, excerpt_for_span

client = TestClient(app)
FIXTURES = Path(__file__).parent / "fixtures"


def _excerpt(filename: str, start: int, end: int, **params: object) -> dict:
    with open(FIXTURES / filename, "rb") as f:
        response = client.post(
            "/source-excerpt",
            params={"start_offset": start, "end_offset": end, **params},
            files={"file": (filename, f, "application/octet-stream")},
        )
    assert response.status_code == 200, response.text
    return response.json()


def test_a_baseline_items_excerpt_is_its_source_sentence_in_a_real_docx() -> None:
    # The whole chain a reviewer relies on: the item the pipeline built, its stored offsets, and the words they point at.
    doc = dispatch_by_extension("mock_airpro_shape.docx", str(FIXTURES / "mock_airpro_shape.docx"))
    node = next(
        n
        for n in build_baseline_tree(doc).nodes
        if n.title == "The unit must report an undervoltage fault."
    )

    body = _excerpt(
        "mock_airpro_shape.docx", node.source_ref.start_offset, node.source_ref.end_offset
    )

    assert body == {
        "text": "The unit must report an undervoltage fault.",
        "truncated": False,
        "kind": "text",
    }


def test_a_markdown_paragraph_excerpt_is_verbatim() -> None:
    doc = dispatch_by_extension("sample.md", str(FIXTURES / "sample.md"))
    block = next(b for b in doc.blocks if b.kind == BlockKind.PARAGRAPH)

    body = _excerpt("sample.md", block.source_ref.start_offset, block.source_ref.end_offset)

    assert body["kind"] == "text"
    assert (
        body["text"]
        == "The receiver shall scan all available channels within 10 seconds of power-on."
    )


def test_a_span_over_two_txt_paragraphs_keeps_the_paragraph_break() -> None:
    body = _excerpt("sample.txt", 0, 119)

    assert body["text"] == (
        "This is a plain requirement statement about the widget subsystem.\n\n"
        "It has two paragraphs describing expected behavior."
    )


def test_a_docx_table_ref_returns_the_tables_own_cells() -> None:
    doc = dispatch_by_extension("sample.docx", str(FIXTURES / "sample.docx"))
    table = doc.tables[0]

    body = _excerpt("sample.docx", table.source_ref.start_offset, table.source_ref.end_offset)

    assert body["kind"] == "table"
    assert body["text"].splitlines()[0] == "Mode | Description"
    assert "Vivid | High saturation preset" in body["text"]


def test_a_row_hint_narrows_a_table_to_its_header_and_that_row() -> None:
    doc = dispatch_by_extension("sample.docx", str(FIXTURES / "sample.docx"))
    table = doc.tables[0]

    body = _excerpt(
        "sample.docx", table.source_ref.start_offset, table.source_ref.end_offset, row_hint="Vivid"
    )

    assert body["kind"] == "table"
    assert body["text"] == "Mode | Description\nVivid | High saturation preset"


def test_a_row_hint_that_matches_no_row_keeps_the_whole_table() -> None:
    doc = dispatch_by_extension("sample.docx", str(FIXTURES / "sample.docx"))
    table = doc.tables[0]

    whole = _excerpt("sample.docx", table.source_ref.start_offset, table.source_ref.end_offset)
    hinted = _excerpt(
        "sample.docx", table.source_ref.start_offset, table.source_ref.end_offset, row_hint="NOPE-1"
    )

    assert hinted == whole


def test_a_pdf_table_is_matched_on_its_own_page_only() -> None:
    doc = dispatch_by_extension("sample.pdf", str(FIXTURES / "sample.pdf"))
    table = doc.tables[0]
    ref = table.source_ref

    on_page = _excerpt("sample.pdf", ref.start_offset, ref.end_offset, page=ref.page)
    other_page = _excerpt("sample.pdf", ref.start_offset, ref.end_offset, page=(ref.page or 0) + 1)

    assert on_page["kind"] == "table"
    assert other_page == {"text": "", "truncated": False, "kind": "unavailable"}


def test_an_empty_span_is_unavailable_never_invented() -> None:
    # (0, 0) is the placeholder some loaders give a table (csv, image, a degraded pdf table): it points at nothing.
    assert _excerpt("sample.docx", 0, 0) == {"text": "", "truncated": False, "kind": "unavailable"}


def test_a_span_past_the_end_of_the_document_is_unavailable() -> None:
    assert _excerpt("sample.txt", 5000, 5100) == {
        "text": "",
        "truncated": False,
        "kind": "unavailable",
    }


def test_a_figure_span_is_unavailable_because_its_text_is_not_source_wording() -> None:
    doc = dispatch_by_extension("sample.docx", str(FIXTURES / "sample.docx"))
    figure_block = next(b for b in doc.blocks if b.kind == BlockKind.FIGURE)

    body = _excerpt(
        "sample.docx", figure_block.source_ref.start_offset, figure_block.source_ref.end_offset
    )

    assert body["kind"] == "unavailable"


def test_section_extent_reads_from_the_heading_to_the_next_heading_at_its_level() -> None:
    # SURVEY items in one section share the section's first block as their ref: the honest excerpt is the section, not that heading.
    body = _excerpt("mock_airpro_shape.docx", 16, 29, extent="section")

    assert body["kind"] == "section"
    assert body["text"] == (
        "Input Voltage\n\n"
        "The unit shall accept 24V DC input.\n\n"
        "The unit shall tolerate reverse polarity."
    )


def test_an_unsupported_file_is_refused() -> None:
    response = client.post(
        "/source-excerpt",
        params={"start_offset": 0, "end_offset": 5},
        files={"file": ("notes.exe", b"MZ", "application/octet-stream")},
    )
    assert response.status_code == 400


def test_a_second_excerpt_of_the_same_file_does_not_parse_it_again(monkeypatch) -> None:
    source_excerpt_module.clear_parsed_cache()
    calls: list[str] = []
    real_dispatch = source_excerpt_module.dispatch_by_extension

    def counting_dispatch(filename: str, tmp_path: str, **kwargs: object) -> CanonicalDoc:
        calls.append(filename)
        return real_dispatch(filename, tmp_path, **kwargs)

    monkeypatch.setattr(source_excerpt_module, "dispatch_by_extension", counting_dispatch)

    first = _excerpt("sample.txt", 0, 65)
    second = _excerpt("sample.txt", 67, 119)

    assert first["text"].startswith("This is a plain requirement")
    assert second["text"] == "It has two paragraphs describing expected behavior."
    assert calls == ["sample.txt"]


def _doc_with(text: str) -> CanonicalDoc:
    return CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="x"),
        blocks=[
            Block(
                id="b0",
                kind=BlockKind.PARAGRAPH,
                text=text,
                source_ref=SourceRef(document_path="x.txt", start_offset=0, end_offset=len(text)),
            )
        ],
    )


def test_a_long_excerpt_is_cut_at_a_word_boundary_and_says_so() -> None:
    words = ["requirement"] * 400
    text = " ".join(words)

    result = excerpt_for_span(_doc_with(text), 0, len(text))

    assert result.truncated is True
    assert result.kind == "text"
    assert len(result.text) <= MAX_EXCERPT_CHARS
    assert text.startswith(result.text)
    assert result.text.endswith("requirement")


def test_a_short_excerpt_is_not_marked_truncated() -> None:
    result = excerpt_for_span(_doc_with("The unit shall start."), 0, 21)

    assert (result.text, result.truncated, result.kind) == ("The unit shall start.", False, "text")
