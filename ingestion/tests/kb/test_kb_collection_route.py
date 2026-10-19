from fastapi.testclient import TestClient

import app.main as main
from app.kb.kb_vector_store import KbVectorStore

client = TestClient(main.app)


def test_kb_purge_collection_rejects_a_blank_user_id(tmp_path, monkeypatch) -> None:
    # Regression for a confirmed real gap: this delete is irreversible, so
    # a malformed/blank user_id must 400 loudly rather than silently no-op
    # or (if it ever collided with a real descriptor) drop the wrong
    # user's KB.
    monkeypatch.setattr(main, "_kb_vector_store", KbVectorStore(str(tmp_path)))

    response = client.delete("/kb/collection", params={"user_id": "   "})
    assert response.status_code == 400


def test_kb_purge_collection_succeeds_for_a_real_user_id(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(main, "_kb_vector_store", KbVectorStore(str(tmp_path)))

    response = client.delete(
        "/kb/collection", params={"user_id": "Project\\Area1"}, headers={"X-Req2Ado-Confirm-Purge": "Project\\Area1"},
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def _store_with_a_chunk(tmp_path) -> KbVectorStore:
    store = KbVectorStore(str(tmp_path))
    store.upsert_chunk(
        chunk_id="d1:a.pptx:0", embedding=[0.1, 0.2], text="x", user_id="Project\\Area1", source_file="a.pptx", source_id="d1",
        chunk_index=0, file_hash="h",
    )
    return store


def test_a_purge_without_the_confirmation_deletes_nothing(tmp_path, monkeypatch) -> None:
    # Whatever deleted the KB between 12 and 13 Oct is unknown; the one route that drops a whole collection no longer does it
    # on a bare request.
    store = _store_with_a_chunk(tmp_path)
    monkeypatch.setattr(main, "_kb_vector_store", store)

    assert client.delete("/kb/collection", params={"user_id": "Project\\Area1"}).status_code == 400
    assert client.delete(
        "/kb/collection", params={"user_id": "Project\\Area1"}, headers={"X-Req2Ado-Confirm-Purge": "someone-else"},
    ).status_code == 400
    assert store.list_documents("Project\\Area1") == ["a.pptx"]


def test_a_confirmed_purge_is_logged_with_the_count_but_not_the_user_identity(tmp_path, monkeypatch, caplog) -> None:
    import logging

    store = _store_with_a_chunk(tmp_path)
    monkeypatch.setattr(main, "_kb_vector_store", store)
    with caplog.at_level(logging.WARNING, logger="app.main"):
        response = client.delete(
            "/kb/collection", params={"user_id": "Project\\Area1"}, headers={"X-Req2Ado-Confirm-Purge": "Project\\Area1"},
        )
    assert response.status_code == 200 and store.list_documents("Project\\Area1") == []
    lines = [r.getMessage() for r in caplog.records if "KB collection purged" in r.getMessage()]
    assert len(lines) == 1 and "chunks=1" in lines[0] and "Area1" not in lines[0]


def test_removing_a_document_is_logged(tmp_path, monkeypatch, caplog) -> None:
    import logging

    store = _store_with_a_chunk(tmp_path)
    monkeypatch.setattr(main, "_kb_vector_store", store)
    with caplog.at_level(logging.INFO, logger="app.main"):
        response = client.delete("/kb/documents", params={"user_id": "Project\\Area1", "source_file": "a.pptx", "source_id": "d1"})
    assert response.status_code == 200
    lines = [r.getMessage() for r in caplog.records if "KB document removed" in r.getMessage()]
    assert len(lines) == 1 and "a.pptx" in lines[0] and "Area1" not in lines[0]
