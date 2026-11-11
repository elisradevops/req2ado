# ingestion/tests/kb/test_ingest_drive_item_route.py
from fastapi.testclient import TestClient

import app.main as main
from app.config import settings
from app.kb.graph_client import GraphApiError, GraphClient
from app.kb.ingest_service import IngestResult

client = TestClient(main.app)

BODY = {
    "drive_id": "drive-1",
    "item_id": "item-1",
    "user_id": "Project\\Area1",
    "retrieval_mode": "always_include",
}


def _result() -> IngestResult:
    return IngestResult(
        document_name="guide.docx",
        driveitem_id="item-1",
        mime_type=None,
        size_bytes=10,
        chunks_stored=3,
        skipped_unchanged=False,
        chunks_in_store=3,
    )


def test_ingest_drive_item_route_forwards_the_request_to_the_service(monkeypatch) -> None:
    monkeypatch.setattr(settings, "sharepoint_token", "test-token")
    captured = {}

    def fake_ingest_drive_item(
        drive_id, item_id, user_id, doc_type, graph_client, embed_client, vector_store, **kwargs
    ):
        captured.update(
            drive_id=drive_id, item_id=item_id, user_id=user_id, doc_type=doc_type, kwargs=kwargs
        )
        return _result()

    monkeypatch.setattr("app.main.ingest_drive_item", fake_ingest_drive_item)

    response = client.post("/kb/ingest-drive-item", json={**BODY, "doc_type": "SRD"})

    assert response.status_code == 200
    assert response.json()["document_name"] == "guide.docx"
    assert captured["drive_id"] == "drive-1"
    assert captured["item_id"] == "item-1"
    assert captured["user_id"] == "Project\\Area1"
    assert captured["doc_type"] == "SRD"
    assert captured["kwargs"]["retrieval_mode"] == "always_include"


def test_ingest_drive_item_route_prefers_the_token_in_the_request(monkeypatch) -> None:
    monkeypatch.setattr(settings, "sharepoint_token", "env-token")
    seen = {}

    def fake_ingest_drive_item(drive_id, item_id, user_id, doc_type, graph_client, *args, **kwargs):
        seen["token"] = graph_client.token
        return _result()

    monkeypatch.setattr("app.main.ingest_drive_item", fake_ingest_drive_item)

    client.post("/kb/ingest-drive-item", json={**BODY, "graph_token": "vault-token"})

    assert seen["token"] == "vault-token"


def test_ingest_drive_item_route_answers_400_for_a_file_that_cannot_be_ingested(
    monkeypatch,
) -> None:
    monkeypatch.setattr(settings, "sharepoint_token", "test-token")

    def fake_ingest_drive_item(*args, **kwargs):
        raise ValueError("file exceeds 52428800-byte limit: 60000000")

    monkeypatch.setattr("app.main.ingest_drive_item", fake_ingest_drive_item)

    response = client.post("/kb/ingest-drive-item", json=BODY)

    assert response.status_code == 400
    assert "exceeds" in response.json()["detail"]


def test_ingest_drive_item_route_passes_401_403_404_through_and_folds_the_rest_into_502(
    monkeypatch,
) -> None:
    monkeypatch.setattr(settings, "sharepoint_token", "test-token")

    def raising(status):
        def fake(*args, **kwargs):
            raise GraphApiError(status, "boom")

        return fake

    for upstream, expected in [(401, 401), (403, 403), (404, 404), (429, 502), (503, 502)]:
        monkeypatch.setattr("app.main.ingest_drive_item", raising(upstream))
        assert client.post("/kb/ingest-drive-item", json=BODY).status_code == expected


def test_ingest_drive_item_route_is_400_without_any_token(monkeypatch) -> None:
    monkeypatch.setattr(settings, "sharepoint_token", "")

    response = client.post("/kb/ingest-drive-item", json=BODY)

    assert response.status_code == 400


def test_graph_client_is_the_one_the_route_builds(monkeypatch) -> None:
    monkeypatch.setattr(settings, "sharepoint_token", "test-token")
    seen = {}

    def fake_ingest_drive_item(drive_id, item_id, user_id, doc_type, graph_client, *args, **kwargs):
        seen["is_graph_client"] = isinstance(graph_client, GraphClient)
        return _result()

    monkeypatch.setattr("app.main.ingest_drive_item", fake_ingest_drive_item)

    client.post("/kb/ingest-drive-item", json=BODY)

    assert seen["is_graph_client"] is True
