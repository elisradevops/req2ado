# ingestion/tests/kb/test_sync_service.py
from unittest.mock import MagicMock, patch

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.kb.kb_vector_store import KbVectorStore
from app.kb.sharepoint_client import SharePointFile
from app.kb.sync_service import sync_kb_source

REF = SourceRef(document_path="doc.txt", start_offset=0, end_offset=0)


def _fake_doc(text: str) -> CanonicalDoc:
    return CanonicalDoc(
        document=Document(path="doc.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.PARAGRAPH, text=text, source_ref=REF)],
    )


class FakeEmbedClient:
    def embed(self, texts: list[str]) -> list[list[float]]:
        return [[1.0, 0.0, 0.0] for _ in texts]


class FailingOnSecondEmbedClient:
    """Succeeds on the first embed call, then fails — simulates an embed
    service outage partway through a multi-chunk file."""

    def __init__(self) -> None:
        self.calls = 0

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls += 1
        if self.calls == 2:
            raise RuntimeError("embed service unavailable")
        return [[1.0, 0.0, 0.0] for _ in texts]


def _multi_chunk_doc(text_a: str, text_b: str) -> CanonicalDoc:
    return CanonicalDoc(
        document=Document(path="doc.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, text=text_a, heading_level=1, source_ref=REF),
            Block(id="b1", kind=BlockKind.HEADING, text=text_b, heading_level=1, source_ref=REF),
        ],
    )


@patch("app.kb.sync_service.dispatch_by_extension")
@patch("app.kb.sync_service.SharePointClient")
def test_syncs_a_new_file_end_to_end(mock_sharepoint_cls, mock_dispatch, tmp_path) -> None:
    mock_sharepoint = MagicMock()
    mock_sharepoint.list_files.return_value = [SharePointFile(name="doc.txt", server_relative_url="/s/Lib/Folder/doc.txt")]
    mock_sharepoint.fetch_file_bytes.return_value = b"file content"
    mock_sharepoint_cls.return_value = mock_sharepoint
    mock_dispatch.return_value = _fake_doc("Some paragraph text")

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    result = sync_kb_source(
        site_url="https://contoso.sharepoint.com/sites/s",
        library="Lib",
        folder="Folder",
        area_path="Project\\Area1",
        source_id="source-1",
        bearer_token="tok-1",
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
    )

    assert result.files_processed == 1
    assert result.files_skipped == 0
    assert result.files_failed == []
    assert result.chunks_stored == 1
    assert vector_store.existing_file_hash("Project\\Area1", "doc.txt", "source-1") is not None


@patch("app.kb.sync_service.dispatch_by_extension")
@patch("app.kb.sync_service.SharePointClient")
def test_skips_a_file_whose_hash_is_unchanged(mock_sharepoint_cls, mock_dispatch, tmp_path) -> None:
    mock_sharepoint = MagicMock()
    mock_sharepoint.list_files.return_value = [SharePointFile(name="doc.txt", server_relative_url="/s/Lib/Folder/doc.txt")]
    mock_sharepoint.fetch_file_bytes.return_value = b"same content"
    mock_sharepoint_cls.return_value = mock_sharepoint
    mock_dispatch.return_value = _fake_doc("Some paragraph text")

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    kwargs = dict(
        site_url="https://contoso.sharepoint.com/sites/s", library="Lib", folder="Folder",
        area_path="Project\\Area1", source_id="source-1", bearer_token="tok-1",
        embed_client=FakeEmbedClient(), vector_store=vector_store,
    )
    sync_kb_source(**kwargs)  # first sync: ingests
    result = sync_kb_source(**kwargs)  # second sync: same content, should skip

    assert result.files_processed == 0
    assert result.files_skipped == 1
    assert result.chunks_stored == 0


@patch("app.kb.sync_service.dispatch_by_extension")
@patch("app.kb.sync_service.SharePointClient")
def test_a_single_file_failure_is_reported_and_does_not_abort_the_sync(mock_sharepoint_cls, mock_dispatch, tmp_path) -> None:
    mock_sharepoint = MagicMock()
    mock_sharepoint.list_files.return_value = [
        SharePointFile(name="bad.txt", server_relative_url="/s/Lib/Folder/bad.txt"),
        SharePointFile(name="good.txt", server_relative_url="/s/Lib/Folder/good.txt"),
    ]
    mock_sharepoint.fetch_file_bytes.return_value = b"content"
    mock_sharepoint_cls.return_value = mock_sharepoint
    mock_dispatch.side_effect = [ValueError("corrupt file"), _fake_doc("Good text")]

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    result = sync_kb_source(
        site_url="https://contoso.sharepoint.com/sites/s", library="Lib", folder="Folder",
        area_path="Project\\Area1", source_id="source-1", bearer_token="tok-1",
        embed_client=FakeEmbedClient(), vector_store=vector_store,
    )

    assert result.files_processed == 1
    assert len(result.files_failed) == 1
    assert result.files_failed[0].file == "bad.txt"
    assert result.chunks_stored == 1


@patch("app.kb.sync_service.dispatch_by_extension")
@patch("app.kb.sync_service.SharePointClient")
def test_a_partial_embed_failure_leaves_old_chunks_and_hash_intact(mock_sharepoint_cls, mock_dispatch, tmp_path) -> None:
    mock_sharepoint = MagicMock()
    mock_sharepoint.list_files.return_value = [SharePointFile(name="doc.txt", server_relative_url="/s/Lib/Folder/doc.txt")]
    mock_sharepoint_cls.return_value = mock_sharepoint

    vector_store = KbVectorStore(persist_path=str(tmp_path))

    # First sync: succeeds fully, 2 chunks stored under the original hash.
    mock_sharepoint.fetch_file_bytes.return_value = b"original content"
    mock_dispatch.return_value = _multi_chunk_doc("Section A", "Section B")
    first_result = sync_kb_source(
        site_url="https://contoso.sharepoint.com/sites/s", library="Lib", folder="Folder",
        area_path="Project\\Area1", source_id="source-1", bearer_token="tok-1",
        embed_client=FakeEmbedClient(), vector_store=vector_store,
    )
    assert first_result.chunks_stored == 2
    original_hash = vector_store.existing_file_hash("Project\\Area1", "doc.txt", "source-1")
    assert original_hash is not None

    # Second sync: file content CHANGED (new hash), but embedding the
    # second chunk fails. The file must be reported as failed, and the
    # OLD chunks/hash must remain untouched — not partially replaced.
    mock_sharepoint.fetch_file_bytes.return_value = b"changed content"
    mock_dispatch.return_value = _multi_chunk_doc("Section A changed", "Section B changed")
    second_result = sync_kb_source(
        site_url="https://contoso.sharepoint.com/sites/s", library="Lib", folder="Folder",
        area_path="Project\\Area1", source_id="source-1", bearer_token="tok-1",
        embed_client=FailingOnSecondEmbedClient(), vector_store=vector_store,
    )

    assert len(second_result.files_failed) == 1
    assert second_result.files_failed[0].file == "doc.txt"
    assert second_result.chunks_stored == 0
    # The stored hash must still be the ORIGINAL one — proves old chunks
    # were not deleted before the new ones were confirmed fully embedded.
    assert vector_store.existing_file_hash("Project\\Area1", "doc.txt", "source-1") == original_hash
