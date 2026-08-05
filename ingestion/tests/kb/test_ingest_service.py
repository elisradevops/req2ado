# ingestion/tests/kb/test_ingest_service.py
from unittest.mock import MagicMock, patch

import pytest

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.kb.graph_client import GraphDriveItem, GraphFolderChild
from app.kb.ingest_service import ingest_document_from_url, ingest_folder_from_url
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
        user_id="Project\\Area1",
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
def test_ingest_document_forwards_retrieval_mode_to_the_vector_store(mock_dispatch, tmp_path) -> None:
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1", name="standards.docx", mime_type="application/vnd.openxmlformats", size=len(DOCX_CONTENT)
    )
    graph_client.fetch_content.return_value = DOCX_CONTENT

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    ingest_document_from_url(
        url=VALID_URL,
        user_id="Project\\Area1",
        doc_type=None,
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
        retrieval_mode="always_include",
    )

    assert vector_store.list_always_include_documents("Project\\Area1") == ["standards.docx"]


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingest_document_omits_retrieval_mode_by_default(mock_dispatch, tmp_path) -> None:
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1", name="doc.docx", mime_type="application/vnd.openxmlformats", size=len(DOCX_CONTENT)
    )
    graph_client.fetch_content.return_value = DOCX_CONTENT

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    ingest_document_from_url(
        url=VALID_URL,
        user_id="Project\\Area1",
        doc_type=None,
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
    )

    assert vector_store.list_always_include_documents("Project\\Area1") == []


class FakeChecklistClient:
    def __init__(self, checklist: list[str]) -> None:
        self.checklist = checklist
        self.calls: list[str] = []

    def extract_quality_checklist(self, document_text: str) -> list[str]:
        self.calls.append(document_text)
        return self.checklist


class RaisingChecklistClient:
    def extract_quality_checklist(self, document_text: str) -> list[str]:
        raise ValueError("boom")


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingest_stores_the_extracted_checklist_on_every_chunk(mock_dispatch, tmp_path) -> None:
    # Confirmed real determinism requirement (user-reported): the checklist
    # must be extracted ONCE, at ingest time, and stored -- not re-derived
    # per scoring call.
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1", name="doc.docx", mime_type="application/vnd.openxmlformats", size=len(DOCX_CONTENT)
    )
    graph_client.fetch_content.return_value = DOCX_CONTENT

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    checklist_client = FakeChecklistClient(["Necessary", "Unambiguous", "Verifiable"])
    ingest_document_from_url(
        url=VALID_URL,
        user_id="Project\\Area1",
        doc_type="requirements",
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
        checklist_client=checklist_client,
    )

    assert len(checklist_client.calls) == 1  # extracted exactly once, not per chunk
    assert vector_store.get_quality_checklist("Project\\Area1", "doc.docx") == [
        "Necessary", "Unambiguous", "Verifiable",
    ]


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingest_stores_none_when_no_checklist_client_is_supplied(mock_dispatch, tmp_path) -> None:
    # Backward-compat: omitting checklist_client entirely (existing callers
    # before this capability existed) must not attempt extraction at all.
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1", name="doc.docx", mime_type="application/vnd.openxmlformats", size=len(DOCX_CONTENT)
    )
    graph_client.fetch_content.return_value = DOCX_CONTENT

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    ingest_document_from_url(
        url=VALID_URL,
        user_id="Project\\Area1",
        doc_type="requirements",
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
    )

    assert vector_store.get_quality_checklist("Project\\Area1", "doc.docx") is None


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingest_does_not_fail_when_checklist_extraction_raises(mock_dispatch, tmp_path) -> None:
    # Checklist extraction is a best-effort enhancement -- a failure here
    # must never fail the whole ingest, same tolerant philosophy as every
    # other KB enhancement in this codebase.
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1", name="doc.docx", mime_type="application/vnd.openxmlformats", size=len(DOCX_CONTENT)
    )
    graph_client.fetch_content.return_value = DOCX_CONTENT

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    result = ingest_document_from_url(
        url=VALID_URL,
        user_id="Project\\Area1",
        doc_type="requirements",
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
        checklist_client=RaisingChecklistClient(),
    )

    assert result.chunks_stored == 1  # ingest itself still succeeded
    assert vector_store.get_quality_checklist("Project\\Area1", "doc.docx") is None


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
        user_id="Project\\Area1",
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
            user_id="Project\\Area1",
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
            user_id="Project\\Area1",
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
            user_id="Project\\Area1",
            doc_type=None,
            graph_client=graph_client,
            embed_client=FakeEmbedClient(),
            vector_store=vector_store,
        )

    graph_client.get_drive_item.assert_not_called()


TXT_CONTENT = b"hello world, this is a plain text file"


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingest_folder_stores_each_file_and_skips_subfolders(mock_dispatch, tmp_path) -> None:
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.list_folder_children.return_value = [
        GraphFolderChild(id="item-1", name="a.docx", mime_type=None, size=len(DOCX_CONTENT), is_folder=False, download_url="https://dl/a"),
        GraphFolderChild(id="item-2", name="Subfolder", mime_type=None, size=0, is_folder=True, download_url=None),
        GraphFolderChild(id="item-3", name="b.txt", mime_type=None, size=len(TXT_CONTENT), is_folder=False, download_url="https://dl/b"),
    ]
    graph_client.fetch_child_content.side_effect = [DOCX_CONTENT, TXT_CONTENT]

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    result = ingest_folder_from_url(
        url="https://contoso.sharepoint.com/sites/s/folder",
        user_id="Project\\Area1",
        doc_type="requirements",
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
    )

    assert len(result.files) == 2  # subfolder skipped, not recursed
    assert {f.file for f in result.files} == {"a.docx", "b.txt"}
    assert all(f.status == "ingested" and f.chunks_stored == 1 for f in result.files)
    graph_client.fetch_child_content.assert_called_with("https://dl/b")


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingest_folder_isolates_one_files_failure_from_the_rest(mock_dispatch, tmp_path) -> None:
    mock_dispatch.side_effect = [ValueError("corrupt"), _fake_doc("Good text")]
    graph_client = MagicMock()
    graph_client.list_folder_children.return_value = [
        GraphFolderChild(id="item-1", name="bad.docx", mime_type=None, size=len(DOCX_CONTENT), is_folder=False, download_url="https://dl/bad"),
        GraphFolderChild(id="item-2", name="good.docx", mime_type=None, size=len(DOCX_CONTENT), is_folder=False, download_url="https://dl/good"),
    ]
    graph_client.fetch_child_content.return_value = DOCX_CONTENT

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    result = ingest_folder_from_url(
        url="https://contoso.sharepoint.com/sites/s/folder",
        user_id="Project\\Area1",
        doc_type=None,
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
    )

    by_name = {f.file: f for f in result.files}
    assert by_name["bad.docx"].status == "failed"
    assert by_name["bad.docx"].reason == "corrupt"
    assert by_name["good.docx"].status == "ingested"
    assert by_name["good.docx"].chunks_stored == 1


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingest_folder_recursive_descends_into_subfolders_with_relative_path(mock_dispatch, tmp_path) -> None:
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.list_folder_children.return_value = [
        GraphFolderChild(id="item-1", name="a.docx", mime_type=None, size=len(DOCX_CONTENT), is_folder=False, download_url="https://dl/a"),
        GraphFolderChild(id="item-2", name="Subfolder", mime_type=None, size=0, is_folder=True, download_url=None, drive_id="drive-1"),
    ]
    graph_client.list_children_by_id.return_value = [
        GraphFolderChild(id="item-3", name="nested.docx", mime_type=None, size=len(DOCX_CONTENT), is_folder=False, download_url="https://dl/nested"),
    ]
    graph_client.fetch_child_content.side_effect = [DOCX_CONTENT, DOCX_CONTENT]

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    result = ingest_folder_from_url(
        url="https://contoso.sharepoint.com/sites/s/folder",
        user_id="Project\\Area1",
        doc_type="requirements",
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
        recursive=True,
    )

    graph_client.list_children_by_id.assert_called_once_with("drive-1", "item-2")
    by_name = {f.file: f for f in result.files}
    assert by_name["a.docx"].relative_path == "a.docx"
    assert by_name["nested.docx"].relative_path == "Subfolder/nested.docx"
    assert by_name["nested.docx"].status == "ingested"


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingest_folder_non_recursive_still_skips_subfolders(mock_dispatch, tmp_path) -> None:
    # Regression: recursive defaults to False, preserving today's behavior.
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.list_folder_children.return_value = [
        GraphFolderChild(id="item-2", name="Subfolder", mime_type=None, size=0, is_folder=True, download_url=None, drive_id="drive-1"),
    ]

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    result = ingest_folder_from_url(
        url="https://contoso.sharepoint.com/sites/s/folder",
        user_id="Project\\Area1",
        doc_type=None,
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
    )

    assert result.files == []
    graph_client.list_children_by_id.assert_not_called()


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingest_folder_recursive_stops_at_max_depth(mock_dispatch, tmp_path) -> None:
    # 6 levels of nested single-subfolder chains; MAX_FOLDER_DEPTH is 5, so
    # list_children_by_id must be called exactly 4 times (depths 1-4 recurse
    # into depths 2-5; the folder found at depth 5 is not descended into).
    mock_dispatch.return_value = _fake_doc("text")
    graph_client = MagicMock()

    def make_subfolder(n: int) -> GraphFolderChild:
        return GraphFolderChild(id=f"item-{n}", name=f"L{n}", mime_type=None, size=0, is_folder=True, download_url=None, drive_id="drive-1")

    graph_client.list_folder_children.return_value = [make_subfolder(1)]
    graph_client.list_children_by_id.side_effect = [
        [make_subfolder(2)],
        [make_subfolder(3)],
        [make_subfolder(4)],
        [make_subfolder(5)],
    ]

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    result = ingest_folder_from_url(
        url="https://contoso.sharepoint.com/sites/s/folder",
        user_id="Project\\Area1",
        doc_type=None,
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
        recursive=True,
    )

    assert result.files == []  # every level is a folder, no files anywhere
    assert graph_client.list_children_by_id.call_count == 4


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingest_folder_recursive_isolates_a_subfolder_listing_failure(mock_dispatch, tmp_path) -> None:
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.list_folder_children.return_value = [
        GraphFolderChild(id="item-1", name="a.docx", mime_type=None, size=len(DOCX_CONTENT), is_folder=False, download_url="https://dl/a"),
        GraphFolderChild(id="item-2", name="BrokenSubfolder", mime_type=None, size=0, is_folder=True, download_url=None, drive_id="drive-1"),
    ]
    graph_client.list_children_by_id.side_effect = RuntimeError("transient Graph error")
    graph_client.fetch_child_content.return_value = DOCX_CONTENT

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    result = ingest_folder_from_url(
        url="https://contoso.sharepoint.com/sites/s/folder",
        user_id="Project\\Area1",
        doc_type=None,
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
        recursive=True,
    )

    by_name = {f.file: f for f in result.files}
    assert by_name["a.docx"].status == "ingested"  # sibling unaffected
    assert by_name["BrokenSubfolder"].status == "failed"
    assert "transient Graph error" in by_name["BrokenSubfolder"].reason


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingest_document_forwards_describe_figure_to_dispatch(mock_dispatch, tmp_path) -> None:
    # Regression: KB ingestion previously never captioned figures at all --
    # _store_document called dispatch_by_extension with no describe_figure,
    # unlike app.main's /ingest route. Every embedded image became the bare
    # '[FIGURE: none]' placeholder regardless of vision config.
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1", name="doc.docx", mime_type="application/vnd.openxmlformats", size=len(DOCX_CONTENT)
    )
    graph_client.fetch_content.return_value = DOCX_CONTENT

    def fake_describe_figure(image_bytes: bytes) -> str:
        return "a caption"

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    ingest_document_from_url(
        url=VALID_URL,
        user_id="Project\\Area1",
        doc_type="requirements",
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
        describe_figure=fake_describe_figure,
    )

    assert mock_dispatch.call_args.kwargs["describe_figure"] is fake_describe_figure


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingest_document_omits_describe_figure_by_default(mock_dispatch, tmp_path) -> None:
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1", name="doc.docx", mime_type="application/vnd.openxmlformats", size=len(DOCX_CONTENT)
    )
    graph_client.fetch_content.return_value = DOCX_CONTENT

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    ingest_document_from_url(
        url=VALID_URL,
        user_id="Project\\Area1",
        doc_type="requirements",
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
    )

    assert mock_dispatch.call_args.kwargs["describe_figure"] is None


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingest_folder_forwards_describe_figure_to_every_file(mock_dispatch, tmp_path) -> None:
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.list_folder_children.return_value = [
        GraphFolderChild(id="item-1", name="a.docx", mime_type=None, size=len(DOCX_CONTENT), is_folder=False, download_url="https://dl/a"),
    ]
    graph_client.fetch_child_content.return_value = DOCX_CONTENT

    def fake_describe_figure(image_bytes: bytes) -> str:
        return "a caption"

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    ingest_folder_from_url(
        url="https://contoso.sharepoint.com/sites/s/folder",
        user_id="Project\\Area1",
        doc_type="requirements",
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
        describe_figure=fake_describe_figure,
    )

    assert mock_dispatch.call_args.kwargs["describe_figure"] is fake_describe_figure


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingest_folder_recursive_forwards_describe_figure_into_subfolders(mock_dispatch, tmp_path) -> None:
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.list_folder_children.return_value = [
        GraphFolderChild(id="item-2", name="Subfolder", mime_type=None, size=0, is_folder=True, download_url=None, drive_id="drive-1"),
    ]
    graph_client.list_children_by_id.return_value = [
        GraphFolderChild(id="item-3", name="nested.docx", mime_type=None, size=len(DOCX_CONTENT), is_folder=False, download_url="https://dl/nested"),
    ]
    graph_client.fetch_child_content.return_value = DOCX_CONTENT

    def fake_describe_figure(image_bytes: bytes) -> str:
        return "a caption"

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    ingest_folder_from_url(
        url="https://contoso.sharepoint.com/sites/s/folder",
        user_id="Project\\Area1",
        doc_type=None,
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
        recursive=True,
        describe_figure=fake_describe_figure,
    )

    assert mock_dispatch.call_args.kwargs["describe_figure"] is fake_describe_figure


def test_ingest_folder_rejects_ssrf_url_before_listing_children(tmp_path) -> None:
    graph_client = MagicMock()
    vector_store = KbVectorStore(persist_path=str(tmp_path))

    with pytest.raises(ValueError):
        ingest_folder_from_url(
            url="http://169.254.169.254/x",
            user_id="Project\\Area1",
            doc_type=None,
            graph_client=graph_client,
            embed_client=FakeEmbedClient(),
            vector_store=vector_store,
        )

    graph_client.list_folder_children.assert_not_called()
