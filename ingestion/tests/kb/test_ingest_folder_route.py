# ingestion/tests/kb/test_ingest_folder_route.py
from fastapi.testclient import TestClient

from app.config import settings
from app.kb.graph_client import GraphApiError, GraphClient
from app.main import app

client = TestClient(app)


def test_folder_ingest_on_a_non_folder_link_returns_a_clean_400(monkeypatch) -> None:
    # Graph's /children call on a driveItem that isn't a folder returns its
    # own 400 (e.g. "resource is not a folder"). The route must pass that
    # through as a clean 400, not fold it into the generic 502 bucket.
    monkeypatch.setattr(settings, "sharepoint_token", "test-token")

    def fake_list_folder_children(self, url: str):
        raise GraphApiError(400, "requested resource is not a folder")

    monkeypatch.setattr(GraphClient, "list_folder_children", fake_list_folder_children)

    response = client.post(
        "/kb/ingest-folder-url",
        json={"url": "https://contoso.sharepoint.com/single-file-link", "user_id": "Project\\Area1"},
    )

    assert response.status_code == 400
    assert "not a folder" in response.json()["detail"]


def test_folder_ingest_forwards_the_recursive_flag_to_the_service(monkeypatch) -> None:
    monkeypatch.setattr(settings, "sharepoint_token", "test-token")
    captured = {}

    def fake_ingest_folder_from_url(url, user_id, doc_type, graph_client, embed_client, vector_store, recursive=False, describe_figure=None):
        captured["recursive"] = recursive
        from app.kb.ingest_service import FolderIngestResult

        return FolderIngestResult(files=[])

    monkeypatch.setattr("app.main.ingest_folder_from_url", fake_ingest_folder_from_url)

    response = client.post(
        "/kb/ingest-folder-url",
        json={"url": "https://contoso.sharepoint.com/folder", "user_id": "Project\\Area1", "recursive": True},
    )

    assert response.status_code == 200
    assert captured["recursive"] is True
