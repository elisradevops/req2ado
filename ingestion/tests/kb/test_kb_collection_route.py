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

    response = client.delete("/kb/collection", params={"user_id": "Project\\Area1"})
    assert response.status_code == 200
    assert response.json() == {"ok": True}
