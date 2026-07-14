# ingestion/tests/kb/test_ingest_service.py
from unittest.mock import MagicMock, patch

import pytest

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.kb.graph_client import GraphDriveItem
from app.kb.ingest_service import ingest_document_from_url
from app.kb.kb_vector_store import KbVectorStore
from app.kb.url_security import MAX_FILE_SIZE_BYTES

REF = SourceRef(document_path="doc.docx", start_offset=0, end_offset=0)

VALID_URL = "https://contoso.sharepoint.com/sites/s/doc.docx"
DOCX_CONTENT = b"PK\x03\x04" + b"0" * 20


def _fake_doc(text: str) -> CanonicalDoc:
    return CanonicalDoc(
        document=Document(path="doc.docx", format=DocumentFormat.DOCX, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.PARAGRAPH, text=text, source_ref=REF)],
    )


class FakeEmbedClient:
    def embed(self, texts: list[str]) -> list[list[float]]:
        return [[1.0, 0.0, 0.0] for _ in texts]


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingests_a_new_document_end_to_end(mock_dispatch, tmp_path) -> None:
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1", name="doc.docx", mime_type="application/vnd.openxmlformats", size=len(DOCX_CONTENT)
    )
    graph_client.fetch_content.return_value = DOCX_CONTENT

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    result = ingest_document_from_url(
        url=VALID_URL,
        area_path="Project\\Area1",
        doc_type="requirements",
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
    )

    assert result.document_name == "doc.docx"
    assert result.driveitem_id == "item-1"
    assert result.chunks_stored == 1
    assert result.skipped_unchanged is False
    assert vector_store.existing_file_hash("Project\\Area1", "doc.docx", "item-1") is not None


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_skips_a_document_whose_hash_is_unchanged(mock_dispatch, tmp_path) -> None:
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1", name="doc.docx", mime_type="application/vnd.openxmlformats", size=len(DOCX_CONTENT)
    )
    graph_client.fetch_content.return_value = DOCX_CONTENT

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    kwargs = dict(
        url=VALID_URL,
        area_path="Project\\Area1",
        doc_type="requirements",
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
    )

    ingest_document_from_url(**kwargs)  # first ingest
    result = ingest_document_from_url(**kwargs)  # second ingest: unchanged content

    assert result.skipped_unchanged is True
    assert result.chunks_stored == 0


def test_rejects_oversize_files_before_downloading_content(tmp_path) -> None:
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1", name="doc.docx", mime_type="application/vnd.openxmlformats", size=MAX_FILE_SIZE_BYTES + 1
    )

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    with pytest.raises(ValueError):
        ingest_document_from_url(
            url=VALID_URL,
            area_path="Project\\Area1",
            doc_type=None,
            graph_client=graph_client,
            embed_client=FakeEmbedClient(),
            vector_store=vector_store,
        )

    graph_client.fetch_content.assert_not_called()


def test_rejects_content_whose_magic_bytes_dont_match_the_extension(tmp_path) -> None:
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1", name="doc.docx", mime_type="application/vnd.openxmlformats", size=10
    )
    graph_client.fetch_content.return_value = b"plain text"

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    with pytest.raises(ValueError):
        ingest_document_from_url(
            url=VALID_URL,
            area_path="Project\\Area1",
            doc_type=None,
            graph_client=graph_client,
            embed_client=FakeEmbedClient(),
            vector_store=vector_store,
        )


def test_rejects_an_ssrf_url_before_calling_graph_client(tmp_path) -> None:
    graph_client = MagicMock()

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    with pytest.raises(ValueError):
        ingest_document_from_url(
            url="http://169.254.169.254/x",
            area_path="Project\\Area1",
            doc_type=None,
            graph_client=graph_client,
            embed_client=FakeEmbedClient(),
            vector_store=vector_store,
        )

    graph_client.get_drive_item.assert_not_called()
