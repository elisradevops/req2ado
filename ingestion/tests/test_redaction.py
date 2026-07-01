# ingestion/tests/test_redaction.py
from app.canonical.model import (
    Block,
    BlockKind,
    CanonicalDoc,
    Document,
    DocumentFormat,
    Figure,
    SourceRef,
    Table,
)
from app.redaction.redactor import redact_canonical_doc


def _doc_with_text(text: str) -> CanonicalDoc:
    return CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="abc"),
        blocks=[
            Block(
                id="b0",
                kind=BlockKind.PARAGRAPH,
                text=text,
                source_ref=SourceRef(document_path="x.txt", start_offset=0, end_offset=len(text)),
            )
        ],
    )


def test_redacts_email_addresses() -> None:
    doc = _doc_with_text("Contact jane.doe@example.com for details.")
    redacted = redact_canonical_doc(doc)
    assert "jane.doe@example.com" not in redacted.blocks[0].text
    assert "<redacted>" in redacted.blocks[0].text


def test_redacts_urls() -> None:
    doc = _doc_with_text("See https://internal.example.com/spec for the full spec.")
    redacted = redact_canonical_doc(doc)
    assert "https://internal.example.com/spec" not in redacted.blocks[0].text


def test_redacts_guids() -> None:
    doc = _doc_with_text("Ticket ID: 550e8400-e29b-41d4-a716-446655440000 was closed.")
    redacted = redact_canonical_doc(doc)
    assert "550e8400-e29b-41d4-a716-446655440000" not in redacted.blocks[0].text


def test_redacts_hostnames() -> None:
    doc = _doc_with_text("Deployed to build-server-42.internal.corp for testing.")
    redacted = redact_canonical_doc(doc)
    assert "build-server-42.internal.corp" not in redacted.blocks[0].text


def test_redacts_part_numbers() -> None:
    doc = _doc_with_text("Use connector PN-4471-A2 for this interface.")
    redacted = redact_canonical_doc(doc)
    assert "PN-4471-A2" not in redacted.blocks[0].text


def test_trusted_local_bypasses_redaction() -> None:
    doc = _doc_with_text("Contact jane.doe@example.com for details.")
    redacted = redact_canonical_doc(doc, trusted_local=True)
    assert redacted.blocks[0].text == doc.blocks[0].text


def test_redaction_never_mutates_the_original_doc() -> None:
    doc = _doc_with_text("Contact jane.doe@example.com for details.")
    original_text = doc.blocks[0].text
    redact_canonical_doc(doc)
    assert doc.blocks[0].text == original_text


def test_redacts_table_cell_content() -> None:
    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="abc"),
        tables=[
            Table(
                id="t0",
                rows=[["Contact", "jane.doe@example.com"]],
                source_ref=SourceRef(document_path="x.txt", start_offset=0, end_offset=0),
            )
        ],
    )
    redacted = redact_canonical_doc(doc)
    assert "jane.doe@example.com" not in redacted.tables[0].rows[0][1]
    assert "<redacted>" in redacted.tables[0].rows[0][1]


def test_redacts_figure_caption() -> None:
    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="abc"),
        figures=[
            Figure(
                id="f0",
                caption="See connector PN-4471-A2 for wiring",
                source_ref=SourceRef(document_path="x.txt", start_offset=0, end_offset=0),
            )
        ],
    )
    redacted = redact_canonical_doc(doc)
    assert "PN-4471-A2" not in (redacted.figures[0].caption or "")
