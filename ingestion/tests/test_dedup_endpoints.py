import json

import httpx
import pytest
from fastapi.testclient import TestClient

import app.main as main
from app.dedup.vector_store import ChromaVectorStore

client = TestClient(main.app)


def _mock_embed_handler(request: httpx.Request) -> httpx.Response:
    texts = json.loads(request.content)["texts"]
    # Deterministic embedding derived from text content so identical texts
    # produce identical vectors and different texts produce different ones.
    embeddings = [[float(len(text)), 0.0, 1.0] for text in texts]
    return httpx.Response(200, json={"embeddings": embeddings})


def test_dedup_check_against_an_empty_store_returns_not_a_duplicate(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(main, "_vector_store", ChromaVectorStore(str(tmp_path)))
    main._embed_client._transport = httpx.MockTransport(_mock_embed_handler)

    response = client.post("/dedup/check", json={"text": "The unit shall survive a drop.", "area_path": "Project\\Area1"})
    assert response.status_code == 200
    body = response.json()
    assert body["is_duplicate"] is False


def test_dedup_upsert_then_check_with_the_same_text_returns_a_duplicate(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(main, "_vector_store", ChromaVectorStore(str(tmp_path)))
    main._embed_client._transport = httpx.MockTransport(_mock_embed_handler)

    upsert_response = client.post(
        "/dedup/upsert",
        json={"item_id": "item-1", "text": "The unit shall survive a drop.", "area_path": "Project\\Area1"},
    )
    assert upsert_response.status_code == 200
    assert upsert_response.json() == {"ok": True}

    check_response = client.post(
        "/dedup/check", json={"text": "The unit shall survive a drop.", "area_path": "Project\\Area1"}
    )
    assert check_response.status_code == 200
    body = check_response.json()
    assert body["is_duplicate"] is True
    assert body["matched_item_id"] == "item-1"
    assert body["similarity"] == pytest.approx(1.0, abs=1e-6)


def test_dedup_upsert_batch_upserts_all_items_in_one_embed_call(tmp_path, monkeypatch) -> None:
    # Regression: /dedup/upsert previously required one HTTP call (and one
    # embed() round-trip) per item. /dedup/upsert-batch embeds every item's
    # text in ONE call, then upserts each into the vector store.
    monkeypatch.setattr(main, "_vector_store", ChromaVectorStore(str(tmp_path)))
    embed_call_count = 0

    def _counting_embed_handler(request: httpx.Request) -> httpx.Response:
        nonlocal embed_call_count
        embed_call_count += 1
        return _mock_embed_handler(request)

    main._embed_client._transport = httpx.MockTransport(_counting_embed_handler)

    response = client.post(
        "/dedup/upsert-batch",
        json={
            "items": [
                {"item_id": "item-1", "text": "The unit shall survive a drop.", "area_path": "Project\\Area1"},
                {"item_id": "item-2", "text": "The unit shall operate at low temperature.", "area_path": "Project\\Area1"},
            ]
        },
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert embed_call_count == 1  # both items embedded in one call, not two

    check_response = client.post(
        "/dedup/check", json={"text": "The unit shall survive a drop.", "area_path": "Project\\Area1"}
    )
    assert check_response.json()["matched_item_id"] == "item-1"


def test_dedup_upsert_batch_with_an_empty_item_list_is_a_no_op(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(main, "_vector_store", ChromaVectorStore(str(tmp_path)))
    response = client.post("/dedup/upsert-batch", json={"items": []})
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_dedup_upsert_batch_issues_one_chroma_upsert_call_per_area_path(tmp_path, monkeypatch) -> None:
    # Regression: /dedup/upsert-batch already batches the embedding call
    # (test above), but previously still issued one Chroma upsert per item.
    # For a batch entirely within one area path (the common case -- one
    # confirm() call is one job, one area path), this must collapse to a
    # single Chroma round trip via upsert_many, not N.
    from unittest.mock import patch

    from app.dedup.vector_store import ChromaVectorStore as _Store

    monkeypatch.setattr(main, "_vector_store", _Store(str(tmp_path)))
    main._embed_client._transport = httpx.MockTransport(_mock_embed_handler)

    with patch.object(main._vector_store, "upsert_many", wraps=main._vector_store.upsert_many) as spy:
        response = client.post(
            "/dedup/upsert-batch",
            json={
                "items": [
                    {"item_id": "item-1", "text": "The unit shall survive a drop.", "area_path": "Project\\Area1"},
                    {"item_id": "item-2", "text": "The unit shall operate at low temperature.", "area_path": "Project\\Area1"},
                    {"item_id": "item-3", "text": "The unit shall withstand vibration.", "area_path": "Project\\Area1"},
                ]
            },
        )
    assert response.status_code == 200
    assert spy.call_count == 1
    items_arg = spy.call_args[0][0]
    assert len(items_arg) == 3


def test_dedup_upsert_batch_groups_by_area_path_without_cross_contaminating(tmp_path, monkeypatch) -> None:
    # A batch spanning two distinct area paths must still isolate each
    # area's items into its own Chroma collection -- grouping for the
    # batched upsert must not assume every item shares one area path just
    # because that's the common case.
    monkeypatch.setattr(main, "_vector_store", ChromaVectorStore(str(tmp_path)))
    main._embed_client._transport = httpx.MockTransport(_mock_embed_handler)

    response = client.post(
        "/dedup/upsert-batch",
        json={
            "items": [
                {"item_id": "item-1", "text": "The unit shall survive a drop.", "area_path": "Project\\Area1"},
                {"item_id": "item-2", "text": "The unit shall survive a drop.", "area_path": "Project\\Area2"},
            ]
        },
    )
    assert response.status_code == 200

    check_area1 = client.post(
        "/dedup/check", json={"text": "The unit shall survive a drop.", "area_path": "Project\\Area1"}
    )
    assert check_area1.json()["matched_item_id"] == "item-1"

    check_area2 = client.post(
        "/dedup/check", json={"text": "The unit shall survive a drop.", "area_path": "Project\\Area2"}
    )
    assert check_area2.json()["matched_item_id"] == "item-2"


def test_dedup_check_scopes_by_area_path_and_finds_no_match_across_area_paths(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(main, "_vector_store", ChromaVectorStore(str(tmp_path)))
    main._embed_client._transport = httpx.MockTransport(_mock_embed_handler)

    upsert_response = client.post(
        "/dedup/upsert",
        json={"item_id": "item-1", "text": "The unit shall survive a drop.", "area_path": "Project\\Area1"},
    )
    assert upsert_response.status_code == 200

    check_response = client.post(
        "/dedup/check", json={"text": "The unit shall survive a drop.", "area_path": "Project\\Area2"}
    )
    assert check_response.status_code == 200
    body = check_response.json()
    assert body["is_duplicate"] is False
