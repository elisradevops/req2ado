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
    def embed(self, texts: list[str], user_id: str | None = None) -> list[list[float]]:
        return [[1.0, 0.0, 0.0] for _ in texts]


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingests_a_new_document_end_to_end(mock_dispatch, tmp_path) -> None:
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1",
        name="doc.docx",
        mime_type="application/vnd.openxmlformats",
        size=len(DOCX_CONTENT),
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
def test_ingest_document_forwards_retrieval_mode_to_the_vector_store(
    mock_dispatch, tmp_path
) -> None:
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1",
        name="standards.docx",
        mime_type="application/vnd.openxmlformats",
        size=len(DOCX_CONTENT),
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
        id="item-1",
        name="doc.docx",
        mime_type="application/vnd.openxmlformats",
        size=len(DOCX_CONTENT),
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

    def extract_quality_checklist(
        self, document_text: str, user_id: str | None = None
    ) -> list[str]:
        self.calls.append(document_text)
        return self.checklist


class RaisingChecklistClient:
    def extract_quality_checklist(
        self, document_text: str, user_id: str | None = None
    ) -> list[str]:
        raise ValueError("boom")


class FakeChecklistClientWithDefinitions(FakeChecklistClient):
    """Also implements the optional SECOND extraction pass (see
    OrchestratorLlmClient.extract_quality_checklist_definitions) -- a
    separate test double from FakeChecklistClient rather than always adding
    the method there, so test_ingest_stores_the_extracted_checklist_on_
    every_chunk (above) keeps exercising the real duck-typed getattr(...,
    None) absence path, not a mock that happens to always implement it."""

    def __init__(self, checklist: list[str], definitions: dict[str, str]) -> None:
        super().__init__(checklist)
        self.definitions = definitions
        self.definition_calls: list[tuple[str, list[str]]] = []

    def extract_quality_checklist_definitions(
        self, document_text: str, category_names: list[str], user_id: str | None = None
    ) -> dict[str, str]:
        self.definition_calls.append((document_text, category_names))
        return self.definitions


class RaisingDefinitionsChecklistClient(FakeChecklistClient):
    def extract_quality_checklist_definitions(
        self, document_text: str, category_names: list[str], user_id: str | None = None
    ) -> dict[str, str]:
        raise ValueError("boom")


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingest_stores_the_extracted_checklist_on_every_chunk(mock_dispatch, tmp_path) -> None:
    # Confirmed real determinism requirement (user-reported): the checklist
    # must be extracted ONCE, at ingest time, and stored -- not re-derived
    # per scoring call.
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1",
        name="doc.docx",
        mime_type="application/vnd.openxmlformats",
        size=len(DOCX_CONTENT),
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
        "Necessary",
        "Unambiguous",
        "Verifiable",
    ]


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingest_stores_none_when_no_checklist_client_is_supplied(mock_dispatch, tmp_path) -> None:
    # Backward-compat: omitting checklist_client entirely (existing callers
    # before this capability existed) must not attempt extraction at all.
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1",
        name="doc.docx",
        mime_type="application/vnd.openxmlformats",
        size=len(DOCX_CONTENT),
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
        id="item-1",
        name="doc.docx",
        mime_type="application/vnd.openxmlformats",
        size=len(DOCX_CONTENT),
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
def test_ingest_stores_the_extracted_checklist_definitions_alongside_the_names(
    mock_dispatch, tmp_path
) -> None:
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1",
        name="doc.docx",
        mime_type="application/vnd.openxmlformats",
        size=len(DOCX_CONTENT),
    )
    graph_client.fetch_content.return_value = DOCX_CONTENT

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    checklist_client = FakeChecklistClientWithDefinitions(
        ["Necessary", "Unambiguous"],
        {"Necessary": "States something not already satisfied."},
    )
    ingest_document_from_url(
        url=VALID_URL,
        user_id="Project\\Area1",
        doc_type="requirements",
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
        checklist_client=checklist_client,
    )

    assert len(checklist_client.definition_calls) == 1  # extracted exactly once, not per chunk
    # The second pass is handed the FIRST pass's own output names, not a
    # second independent guess -- see extract_quality_checklist_
    # definitions's own docstring for why.
    assert checklist_client.definition_calls[0][1] == ["Necessary", "Unambiguous"]
    assert vector_store.get_quality_checklist_definitions("Project\\Area1", "doc.docx") == {
        "Necessary": "States something not already satisfied."
    }


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingest_skips_the_definitions_pass_when_the_checklist_client_does_not_implement_it(
    mock_dispatch, tmp_path
) -> None:
    # Backward-compat: a checklist_client test double (or, currently, the
    # real one too until this ships) that only implements
    # extract_quality_checklist must keep working unchanged -- the
    # definitions pass is a duck-typed optional capability.
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1",
        name="doc.docx",
        mime_type="application/vnd.openxmlformats",
        size=len(DOCX_CONTENT),
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
        checklist_client=FakeChecklistClient(["Necessary", "Unambiguous"]),
    )

    assert vector_store.get_quality_checklist_definitions("Project\\Area1", "doc.docx") is None


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingest_skips_the_definitions_pass_when_the_names_pass_found_no_checklist(
    mock_dispatch, tmp_path
) -> None:
    # No category names extracted -> nothing to ask the second pass for --
    # never called at all, not called with an empty list.
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1",
        name="doc.docx",
        mime_type="application/vnd.openxmlformats",
        size=len(DOCX_CONTENT),
    )
    graph_client.fetch_content.return_value = DOCX_CONTENT

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    checklist_client = FakeChecklistClientWithDefinitions([], {})
    ingest_document_from_url(
        url=VALID_URL,
        user_id="Project\\Area1",
        doc_type="requirements",
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
        checklist_client=checklist_client,
    )

    assert checklist_client.definition_calls == []
    assert vector_store.get_quality_checklist_definitions("Project\\Area1", "doc.docx") is None


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingest_does_not_fail_when_checklist_definitions_extraction_raises(
    mock_dispatch, tmp_path
) -> None:
    # Best-effort enhancement, same tolerant philosophy as the names pass
    # itself -- a failure here must never fail the whole ingest, and must
    # not clobber the names list that the (successful) first pass already
    # produced.
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1",
        name="doc.docx",
        mime_type="application/vnd.openxmlformats",
        size=len(DOCX_CONTENT),
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
        checklist_client=RaisingDefinitionsChecklistClient(["Necessary", "Unambiguous"]),
    )

    assert result.chunks_stored == 1  # ingest itself still succeeded
    assert vector_store.get_quality_checklist("Project\\Area1", "doc.docx") == [
        "Necessary",
        "Unambiguous",
    ]
    assert vector_store.get_quality_checklist_definitions("Project\\Area1", "doc.docx") is None


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_skips_a_document_whose_hash_is_unchanged(mock_dispatch, tmp_path) -> None:
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1",
        name="doc.docx",
        mime_type="application/vnd.openxmlformats",
        size=len(DOCX_CONTENT),
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

    first = ingest_document_from_url(**kwargs)  # first ingest
    assert first.chunks_in_store == first.chunks_stored > 0
    result = ingest_document_from_url(**kwargs)  # second ingest: unchanged content

    assert result.skipped_unchanged is True
    assert result.chunks_stored == 0
    # K8: the skip branch still reports how many chunks the store really holds
    # for the file, so the caller can record a truthful count (not 0).
    assert result.chunks_in_store == first.chunks_in_store > 0


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_pure_rename_is_skipped_unchanged_and_updates_the_stored_name(
    mock_dispatch, tmp_path
) -> None:
    # Regression for the confirmed SharePoint rename bug: same Graph
    # drive-item id (source_id), new filename, identical content -- must be
    # recognized as the same file (skip re-embed) AND leave the KB's
    # document listing reflecting the new name, not stuck on the old one.
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.fetch_content.return_value = DOCX_CONTENT

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1",
        name="old.docx",
        mime_type="application/vnd.openxmlformats",
        size=len(DOCX_CONTENT),
    )
    ingest_document_from_url(
        url=VALID_URL,
        user_id="Project\\Area1",
        doc_type="requirements",
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
    )

    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1",
        name="new.docx",
        mime_type="application/vnd.openxmlformats",
        size=len(DOCX_CONTENT),
    )
    result = ingest_document_from_url(
        url=VALID_URL,
        user_id="Project\\Area1",
        doc_type="requirements",
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
    )

    assert result.skipped_unchanged is True
    assert result.chunks_stored == 0
    assert vector_store.list_documents("Project\\Area1") == ["new.docx"]
    assert vector_store.get_document("Project\\Area1", "old.docx") == (None, False)


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_rename_file_failure_does_not_turn_skip_unchanged_into_a_failure(
    mock_dispatch, tmp_path
) -> None:
    # Regression for a confirmed real bug: skip-unchanged used to be a
    # guaranteed-success, read-only branch. rename_file()'s Chroma write
    # must be best-effort -- a failure there must not turn this safest
    # branch into a raised exception / failed ingest.
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.fetch_content.return_value = DOCX_CONTENT
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1",
        name="old.docx",
        mime_type="application/vnd.openxmlformats",
        size=len(DOCX_CONTENT),
    )

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    ingest_document_from_url(
        url=VALID_URL,
        user_id="Project\\Area1",
        doc_type="requirements",
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
    )

    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1",
        name="new.docx",
        mime_type="application/vnd.openxmlformats",
        size=len(DOCX_CONTENT),
    )
    with patch.object(vector_store, "rename_file", side_effect=RuntimeError("Chroma unreachable")):
        result = ingest_document_from_url(
            url=VALID_URL,
            user_id="Project\\Area1",
            doc_type="requirements",
            graph_client=graph_client,
            embed_client=FakeEmbedClient(),
            vector_store=vector_store,
        )

    assert result.skipped_unchanged is True
    assert result.chunks_stored == 0


def test_rejects_oversize_files_before_downloading_content(tmp_path) -> None:
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1",
        name="doc.docx",
        mime_type="application/vnd.openxmlformats",
        size=MAX_FILE_SIZE_BYTES + 1,
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
        GraphFolderChild(
            id="item-1",
            name="a.docx",
            mime_type=None,
            size=len(DOCX_CONTENT),
            is_folder=False,
            download_url="https://dl/a",
        ),
        GraphFolderChild(
            id="item-2", name="Subfolder", mime_type=None, size=0, is_folder=True, download_url=None
        ),
        GraphFolderChild(
            id="item-3",
            name="b.txt",
            mime_type=None,
            size=len(TXT_CONTENT),
            is_folder=False,
            download_url="https://dl/b",
        ),
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
        GraphFolderChild(
            id="item-1",
            name="bad.docx",
            mime_type=None,
            size=len(DOCX_CONTENT),
            is_folder=False,
            download_url="https://dl/bad",
        ),
        GraphFolderChild(
            id="item-2",
            name="good.docx",
            mime_type=None,
            size=len(DOCX_CONTENT),
            is_folder=False,
            download_url="https://dl/good",
        ),
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
def test_ingest_folder_recursive_descends_into_subfolders_with_relative_path(
    mock_dispatch, tmp_path
) -> None:
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.list_folder_children.return_value = [
        GraphFolderChild(
            id="item-1",
            name="a.docx",
            mime_type=None,
            size=len(DOCX_CONTENT),
            is_folder=False,
            download_url="https://dl/a",
        ),
        GraphFolderChild(
            id="item-2",
            name="Subfolder",
            mime_type=None,
            size=0,
            is_folder=True,
            download_url=None,
            drive_id="drive-1",
        ),
    ]
    graph_client.list_children_by_id.return_value = [
        GraphFolderChild(
            id="item-3",
            name="nested.docx",
            mime_type=None,
            size=len(DOCX_CONTENT),
            is_folder=False,
            download_url="https://dl/nested",
        ),
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
        GraphFolderChild(
            id="item-2",
            name="Subfolder",
            mime_type=None,
            size=0,
            is_folder=True,
            download_url=None,
            drive_id="drive-1",
        ),
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
        return GraphFolderChild(
            id=f"item-{n}",
            name=f"L{n}",
            mime_type=None,
            size=0,
            is_folder=True,
            download_url=None,
            drive_id="drive-1",
        )

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
def test_ingest_folder_recursive_isolates_a_subfolder_listing_failure(
    mock_dispatch, tmp_path
) -> None:
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.list_folder_children.return_value = [
        GraphFolderChild(
            id="item-1",
            name="a.docx",
            mime_type=None,
            size=len(DOCX_CONTENT),
            is_folder=False,
            download_url="https://dl/a",
        ),
        GraphFolderChild(
            id="item-2",
            name="BrokenSubfolder",
            mime_type=None,
            size=0,
            is_folder=True,
            download_url=None,
            drive_id="drive-1",
        ),
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
        id="item-1",
        name="doc.docx",
        mime_type="application/vnd.openxmlformats",
        size=len(DOCX_CONTENT),
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
        id="item-1",
        name="doc.docx",
        mime_type="application/vnd.openxmlformats",
        size=len(DOCX_CONTENT),
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
        GraphFolderChild(
            id="item-1",
            name="a.docx",
            mime_type=None,
            size=len(DOCX_CONTENT),
            is_folder=False,
            download_url="https://dl/a",
        ),
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
def test_ingest_folder_recursive_forwards_describe_figure_into_subfolders(
    mock_dispatch, tmp_path
) -> None:
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.list_folder_children.return_value = [
        GraphFolderChild(
            id="item-2",
            name="Subfolder",
            mime_type=None,
            size=0,
            is_folder=True,
            download_url=None,
            drive_id="drive-1",
        ),
    ]
    graph_client.list_children_by_id.return_value = [
        GraphFolderChild(
            id="item-3",
            name="nested.docx",
            mime_type=None,
            size=len(DOCX_CONTENT),
            is_folder=False,
            download_url="https://dl/nested",
        ),
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


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_skip_branch_reports_unknown_count_when_the_count_read_fails(
    mock_dispatch, tmp_path
) -> None:
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1",
        name="doc.docx",
        mime_type="application/vnd.openxmlformats",
        size=len(DOCX_CONTENT),
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
    ingest_document_from_url(**kwargs)

    def boom(*_args, **_kwargs):
        raise RuntimeError("chroma hiccup")

    vector_store.count_file_chunks = boom  # type: ignore[method-assign]
    result = ingest_document_from_url(**kwargs)

    assert result.skipped_unchanged is True
    assert result.chunks_in_store is None


# ---- A parser fix must reach files that were ingested before it ----


def _legacy_store(tmp_path, name: str, content: bytes) -> KbVectorStore:
    """A store holding `name` as an older ingest left it: same bytes, no parse_version."""
    import hashlib

    store = KbVectorStore(persist_path=str(tmp_path))
    store.upsert_chunk(
        chunk_id=f"item-1:{name}:0",
        embedding=[1.0, 0.0, 0.0],
        text="old text",
        user_id="Project\\Area1",
        source_file=name,
        source_id="item-1",
        chunk_index=0,
        file_hash=hashlib.sha256(content).hexdigest(),
    )
    return store


def _store(name: str, store: KbVectorStore):
    from app.kb.ingest_service import _store_document

    return _store_document(
        name, "item-1", DOCX_CONTENT, "Project\\Area1", None, FakeEmbedClient(), store
    )


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_an_unchanged_pptx_ingested_by_an_older_parser_is_parsed_again(
    mock_dispatch, tmp_path
) -> None:
    mock_dispatch.return_value = _fake_doc("Fresh text from the improved parser")
    store = _legacy_store(tmp_path, "deck.pptx", DOCX_CONTENT)

    result = _store("deck.pptx", store)

    assert result.skipped_unchanged is False
    assert mock_dispatch.call_count == 1
    assert store.get_document("Project\\Area1", "deck.pptx") == (
        "Fresh text from the improved parser",
        False,
    )
    assert store.existing_parse_version("Project\\Area1", "item-1") is not None


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_an_unchanged_pptx_already_on_the_current_parser_is_skipped(
    mock_dispatch, tmp_path
) -> None:
    mock_dispatch.return_value = _fake_doc("text")
    store = KbVectorStore(persist_path=str(tmp_path))
    _store("deck.pptx", store)
    mock_dispatch.reset_mock()

    result = _store("deck.pptx", store)

    assert result.skipped_unchanged is True
    mock_dispatch.assert_not_called()


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_an_unchanged_docx_without_a_parse_version_is_still_skipped(
    mock_dispatch, tmp_path
) -> None:
    store = _legacy_store(tmp_path, "doc.docx", DOCX_CONTENT)

    result = _store("doc.docx", store)

    assert result.skipped_unchanged is True
    mock_dispatch.assert_not_called()
    assert store.existing_parse_version("Project\\Area1", "item-1") is None


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_reingesting_a_pptx_keeps_its_retrieval_mode_when_the_caller_passes_it(
    mock_dispatch, tmp_path
) -> None:
    from app.kb.ingest_service import _store_document

    mock_dispatch.return_value = _fake_doc("Fresh text")
    store = _legacy_store(tmp_path, "deck.pptx", DOCX_CONTENT)

    _store_document(
        "deck.pptx",
        "item-1",
        DOCX_CONTENT,
        "Project\\Area1",
        None,
        FakeEmbedClient(),
        store,
        retrieval_mode="always_include",
    )

    assert store.list_always_include_documents("Project\\Area1") == ["deck.pptx"]


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_folder_ingest_keeps_an_always_include_files_mode_when_it_re_parses_it(
    mock_dispatch, tmp_path
) -> None:
    # The folder route has no per-file mode of its own. A deck ingested earlier as always-include
    # that is re-parsed here (an older parser revision) must not silently fall back to
    # similarity retrieval while the database row still says always-include.
    mock_dispatch.return_value = _fake_doc("Fresh text from the improved parser")
    store = _legacy_store(tmp_path, "deck.pptx", DOCX_CONTENT)
    store.set_retrieval_mode("Project\\Area1", "item-1", "always_include")
    graph_client = MagicMock()
    graph_client.list_folder_children.return_value = [
        GraphFolderChild(
            id="item-1",
            name="deck.pptx",
            mime_type=None,
            size=len(DOCX_CONTENT),
            is_folder=False,
            download_url="https://dl/deck",
        )
    ]
    graph_client.fetch_child_content.return_value = DOCX_CONTENT

    result = ingest_folder_from_url(
        url="https://contoso.sharepoint.com/sites/s/folder",
        user_id="Project\\Area1",
        doc_type=None,
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=store,
    )

    assert [f.status for f in result.files] == ["ingested"]
    assert store.list_always_include_documents("Project\\Area1") == ["deck.pptx"]


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_folder_ingest_of_a_new_file_stays_similarity_gated(mock_dispatch, tmp_path) -> None:
    mock_dispatch.return_value = _fake_doc("text")
    store = KbVectorStore(persist_path=str(tmp_path))
    graph_client = MagicMock()
    graph_client.list_folder_children.return_value = [
        GraphFolderChild(
            id="item-9",
            name="new.docx",
            mime_type=None,
            size=len(DOCX_CONTENT),
            is_folder=False,
            download_url="https://dl/new",
        )
    ]
    graph_client.fetch_child_content.return_value = DOCX_CONTENT

    ingest_folder_from_url(
        url="https://contoso.sharepoint.com/sites/s/folder",
        user_id="Project\\Area1",
        doc_type=None,
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=store,
    )

    assert store.list_always_include_documents("Project\\Area1") == []


# ---- Batch ingest: addressed by drive + item id, fresh download link ----


def _drive_graph(item: GraphFolderChild, content: bytes = DOCX_CONTENT) -> MagicMock:
    graph_client = MagicMock()
    graph_client.get_item_by_id.return_value = item
    graph_client.fetch_child_content.return_value = content
    return graph_client


def _drive_item(**overrides) -> GraphFolderChild:
    fields = dict(
        id="item-1",
        name="guide.docx",
        mime_type="application/vnd.openxmlformats",
        size=len(DOCX_CONTENT),
        is_folder=False,
        download_url="https://download.example/fresh",
        drive_id="drive-1",
    )
    fields.update(overrides)
    return GraphFolderChild(**fields)


def _ingest_drive_item(graph_client, store, **overrides):
    from app.kb.ingest_service import ingest_drive_item

    kwargs = dict(
        drive_id="drive-1",
        item_id="item-1",
        user_id="Project\\Area1",
        doc_type=None,
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=store,
    )
    kwargs.update(overrides)
    return ingest_drive_item(**kwargs)


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingest_drive_item_looks_the_item_up_and_downloads_it_fresh(
    mock_dispatch, tmp_path
) -> None:
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = _drive_graph(_drive_item())
    store = KbVectorStore(persist_path=str(tmp_path))

    result = _ingest_drive_item(graph_client, store)

    graph_client.get_item_by_id.assert_called_once_with("drive-1", "item-1")
    graph_client.fetch_child_content.assert_called_once_with("https://download.example/fresh")
    assert result.document_name == "guide.docx"
    assert result.driveitem_id == "item-1"
    assert result.mime_type == "application/vnd.openxmlformats"
    assert result.chunks_stored == 1
    assert store.get_document("Project\\Area1", "guide.docx") == ("Some paragraph text", False)


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_ingest_drive_item_passes_the_retrieval_mode_through(mock_dispatch, tmp_path) -> None:
    mock_dispatch.return_value = _fake_doc("text")
    store = KbVectorStore(persist_path=str(tmp_path))

    _ingest_drive_item(_drive_graph(_drive_item()), store, retrieval_mode="always_include")

    assert store.list_always_include_documents("Project\\Area1") == ["guide.docx"]


def test_ingest_drive_item_rejects_an_oversized_file_before_downloading_it(tmp_path) -> None:
    graph_client = _drive_graph(_drive_item(size=MAX_FILE_SIZE_BYTES + 1))

    with pytest.raises(ValueError, match="exceeds"):
        _ingest_drive_item(graph_client, KbVectorStore(persist_path=str(tmp_path)))

    graph_client.fetch_child_content.assert_not_called()


def test_ingest_drive_item_rejects_a_folder(tmp_path) -> None:
    graph_client = _drive_graph(_drive_item(is_folder=True, download_url=None))

    with pytest.raises(ValueError, match="folder"):
        _ingest_drive_item(graph_client, KbVectorStore(persist_path=str(tmp_path)))

    graph_client.fetch_child_content.assert_not_called()


def test_ingest_drive_item_rejects_an_item_with_no_download_url(tmp_path) -> None:
    graph_client = _drive_graph(_drive_item(download_url=None))

    with pytest.raises(ValueError, match="download"):
        _ingest_drive_item(graph_client, KbVectorStore(persist_path=str(tmp_path)))


def test_ingest_drive_item_rejects_a_download_larger_than_the_limit(tmp_path) -> None:
    graph_client = _drive_graph(_drive_item(), content=b"0" * (MAX_FILE_SIZE_BYTES + 1))

    with pytest.raises(ValueError, match="exceeds"):
        _ingest_drive_item(graph_client, KbVectorStore(persist_path=str(tmp_path)))


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_two_ingests_of_the_same_item_never_run_at_once(mock_dispatch, tmp_path) -> None:
    import threading
    import time

    running = 0
    peak = 0
    guard = threading.Lock()

    def slow_dispatch(*args, **kwargs):
        nonlocal running, peak
        with guard:
            running += 1
            peak = max(peak, running)
        time.sleep(0.15)
        with guard:
            running -= 1
        return _fake_doc("text")

    mock_dispatch.side_effect = slow_dispatch
    store = KbVectorStore(persist_path=str(tmp_path))
    results = []

    def run():
        results.append(_ingest_drive_item(_drive_graph(_drive_item()), store))

    threads = [threading.Thread(target=run) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert peak == 1
    # The second one found the first one's work already stored and skipped it.
    assert sorted(r.skipped_unchanged for r in results) == [False, True]


# ---- An unchanged file still takes the retrieval mode it is now asked for ----


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_an_unchanged_file_is_retagged_when_a_different_mode_is_requested(
    mock_dispatch, tmp_path
) -> None:
    mock_dispatch.return_value = _fake_doc("text")
    store = KbVectorStore(persist_path=str(tmp_path))
    _store("doc.docx", store)  # ingested in the default mode
    mock_dispatch.reset_mock()

    result = _store_with_mode("doc.docx", store, "always_include")

    assert result.skipped_unchanged is True
    mock_dispatch.assert_not_called()
    assert store.list_always_include_documents("Project\\Area1") == ["doc.docx"]


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_an_unchanged_always_include_file_goes_back_to_retrieval_when_asked_for_the_default(
    mock_dispatch, tmp_path
) -> None:
    mock_dispatch.return_value = _fake_doc("text")
    store = KbVectorStore(persist_path=str(tmp_path))
    _store_with_mode("doc.docx", store, "always_include")

    result = _store_with_mode("doc.docx", store, None)

    assert result.skipped_unchanged is True
    assert store.list_always_include_documents("Project\\Area1") == []


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_an_unchanged_file_asked_for_the_mode_it_already_has_is_not_touched(
    mock_dispatch, tmp_path
) -> None:
    mock_dispatch.return_value = _fake_doc("text")
    store = KbVectorStore(persist_path=str(tmp_path))
    _store_with_mode("doc.docx", store, "always_include")
    store.set_retrieval_mode = MagicMock()  # type: ignore[method-assign]

    _store_with_mode("doc.docx", store, "always_include")

    store.set_retrieval_mode.assert_not_called()


def _store_with_mode(name: str, store: KbVectorStore, mode: str | None):
    from app.kb.ingest_service import _store_document

    return _store_document(
        name,
        "item-1",
        DOCX_CONTENT,
        "Project\\Area1",
        None,
        FakeEmbedClient(),
        store,
        retrieval_mode=mode,
    )


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_a_url_ingest_reports_the_drive_the_file_is_in(mock_dispatch, tmp_path) -> None:
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.get_drive_item.return_value = GraphDriveItem(
        id="item-1", name="doc.docx", mime_type=None, size=len(DOCX_CONTENT), drive_id="drive-9"
    )
    graph_client.fetch_content.return_value = DOCX_CONTENT

    result = ingest_document_from_url(
        url=VALID_URL,
        user_id="u",
        doc_type=None,
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=KbVectorStore(persist_path=str(tmp_path)),
    )

    assert result.drive_id == "drive-9"


@patch("app.kb.ingest_service.dispatch_by_extension")
def test_a_folder_ingest_reports_the_drive_of_each_file(mock_dispatch, tmp_path) -> None:
    mock_dispatch.return_value = _fake_doc("Some paragraph text")
    graph_client = MagicMock()
    graph_client.list_folder_children.return_value = [
        GraphFolderChild(
            id="item-1", name="a.docx", mime_type=None, size=len(DOCX_CONTENT), is_folder=False, download_url="https://dl/a", drive_id="drive-9"
        ),
    ]
    graph_client.fetch_child_content.return_value = DOCX_CONTENT

    result = ingest_folder_from_url(
        url="https://contoso.sharepoint.com/sites/s/folder",
        user_id="u",
        doc_type=None,
        graph_client=graph_client,
        embed_client=FakeEmbedClient(),
        vector_store=KbVectorStore(persist_path=str(tmp_path)),
    )

    assert [f.drive_id for f in result.files] == ["drive-9"]
