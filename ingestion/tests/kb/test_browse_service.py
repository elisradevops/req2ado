# ingestion/tests/kb/test_browse_service.py
from unittest.mock import MagicMock

import pytest

from app.kb.browse_service import browse_shared_folder, browse_subfolder
from app.kb.graph_client import GraphFolderChild

VALID_URL = "https://contoso.sharepoint.com/sites/s/Shared%20Documents"


def test_browse_shared_folder_maps_files_and_folders() -> None:
    graph_client = MagicMock()
    graph_client.list_folder_children.return_value = [
        GraphFolderChild(
            id="f1",
            name="spec.docx",
            mime_type="application/vnd.openxmlformats",
            size=100,
            is_folder=False,
            download_url="https://x",
            drive_id="drive-1",
        ),
        GraphFolderChild(
            id="d1",
            name="Subfolder",
            mime_type=None,
            size=0,
            is_folder=True,
            download_url=None,
            drive_id="drive-1",
        ),
    ]

    result = browse_shared_folder(VALID_URL, graph_client)

    assert result[0].id == "f1"
    assert result[0].is_folder is False
    assert result[0].drive_id is None  # only folders carry a drive_id -- a file's is dropped
    assert result[1].id == "d1"
    assert result[1].is_folder is True
    assert result[1].drive_id == "drive-1"
    graph_client.list_folder_children.assert_called_once_with(VALID_URL)


def test_browse_shared_folder_rejects_a_non_http_url_before_calling_graph() -> None:
    graph_client = MagicMock()
    with pytest.raises(ValueError):
        browse_shared_folder("ftp://contoso.sharepoint.com/doc", graph_client)
    graph_client.list_folder_children.assert_not_called()


def test_browse_subfolder_addresses_by_drive_and_item_id() -> None:
    graph_client = MagicMock()
    graph_client.list_children_by_id.return_value = [
        GraphFolderChild(
            id="f2",
            name="nested.pdf",
            mime_type="application/pdf",
            size=50,
            is_folder=False,
            download_url="https://x",
            drive_id="drive-1",
        ),
    ]

    result = browse_subfolder("drive-1", "item-1", graph_client)

    assert len(result) == 1
    assert result[0].name == "nested.pdf"
    assert result[0].is_folder is False
    graph_client.list_children_by_id.assert_called_once_with("drive-1", "item-1")


def _child(item_id: str, is_folder: bool, drive_id: str | None = "drive-1") -> GraphFolderChild:
    return GraphFolderChild(
        id=item_id,
        name=item_id,
        mime_type=None,
        size=1,
        is_folder=is_folder,
        download_url=None if is_folder else "https://x",
        drive_id=drive_id,
    )


def test_every_child_reports_the_drive_it_lives_in_even_a_file() -> None:
    # A file's own `drive_id` stays unset (that field means "descend into this folder with it"), but a batch ingest
    # addresses a file by drive + item id, so each child also carries the drive it lives in.
    graph_client = MagicMock()
    graph_client.list_folder_children.return_value = [_child("f1", False), _child("d1", True)]

    result = browse_shared_folder(VALID_URL, graph_client)

    assert [c.parent_drive_id for c in result] == ["drive-1", "drive-1"]
    assert result[0].drive_id is None


def test_a_subfolder_listing_reports_the_parent_drive_too() -> None:
    graph_client = MagicMock()
    graph_client.list_children_by_id.return_value = [_child("f2", False, drive_id="drive-9")]

    result = browse_subfolder("drive-9", "item-1", graph_client)

    assert result[0].parent_drive_id == "drive-9"


def test_a_child_whose_drive_graph_did_not_report_has_no_parent_drive() -> None:
    graph_client = MagicMock()
    graph_client.list_folder_children.return_value = [_child("f1", False, drive_id=None)]

    assert browse_shared_folder(VALID_URL, graph_client)[0].parent_drive_id is None
