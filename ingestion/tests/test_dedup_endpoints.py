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

    response = client.post("/dedup/check", json={"text": "The unit shall survive a drop.", "title": "The unit shall survive a drop.", "area_path": "Project\\Area1"})
    assert response.status_code == 200
    body = response.json()
    assert body["is_duplicate"] is False


def test_dedup_upsert_then_check_with_the_same_text_returns_a_duplicate(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(main, "_vector_store", ChromaVectorStore(str(tmp_path)))
    main._embed_client._transport = httpx.MockTransport(_mock_embed_handler)

    upsert_response = client.post(
        "/dedup/upsert",
        json={"item_id": "item-1", "text": "The unit shall survive a drop.", "title": "The unit shall survive a drop.", "area_path": "Project\\Area1"},
    )
    assert upsert_response.status_code == 200
    assert upsert_response.json() == {"ok": True}

    check_response = client.post(
        "/dedup/check", json={"text": "The unit shall survive a drop.", "title": "The unit shall survive a drop.", "area_path": "Project\\Area1"}
    )
    assert check_response.status_code == 200
    body = check_response.json()
    assert body["is_duplicate"] is True
    assert body["matched_item_id"] == "item-1"
    assert body["similarity"] == pytest.approx(1.0, abs=1e-6)


def test_dedup_delete_removes_a_stale_match_so_it_no_longer_matches(tmp_path, monkeypatch) -> None:
    # Counterpart to /dedup/upsert -- closes the gap where a dedup_skip
    # match downgraded by verifyExistingAdoIdsStillExist (its ADO item was
    # deleted) kept its stale Chroma entry forever, resurfacing as a match
    # on every future job against the same area path.
    monkeypatch.setattr(main, "_vector_store", ChromaVectorStore(str(tmp_path)))
    main._embed_client._transport = httpx.MockTransport(_mock_embed_handler)

    client.post(
        "/dedup/upsert",
        json={"item_id": "item-1", "text": "The unit shall survive a drop.", "title": "The unit shall survive a drop.", "area_path": "Project\\Area1"},
    )

    delete_response = client.post("/dedup/delete", json={"item_id": "item-1", "area_path": "Project\\Area1"})
    assert delete_response.status_code == 200
    assert delete_response.json() == {"ok": True}

    check_response = client.post(
        "/dedup/check", json={"text": "The unit shall survive a drop.", "title": "The unit shall survive a drop.", "area_path": "Project\\Area1"}
    )
    assert check_response.json()["is_duplicate"] is False


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
                {"item_id": "item-1", "text": "The unit shall survive a drop.", "title": "The unit shall survive a drop.", "area_path": "Project\\Area1"},
                {"item_id": "item-2", "text": "The unit shall operate at low temperature.", "title": "The unit shall operate at low temperature.", "area_path": "Project\\Area1"},
            ]
        },
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert embed_call_count == 1  # both items embedded in one call, not two

    check_response = client.post(
        "/dedup/check", json={"text": "The unit shall survive a drop.", "title": "The unit shall survive a drop.", "area_path": "Project\\Area1"}
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
                    {"item_id": "item-1", "text": "The unit shall survive a drop.", "title": "The unit shall survive a drop.", "area_path": "Project\\Area1"},
                    {"item_id": "item-2", "text": "The unit shall operate at low temperature.", "title": "The unit shall operate at low temperature.", "area_path": "Project\\Area1"},
                    {"item_id": "item-3", "text": "The unit shall withstand vibration.", "title": "The unit shall withstand vibration.", "area_path": "Project\\Area1"},
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
                {"item_id": "item-1", "text": "The unit shall survive a drop.", "title": "The unit shall survive a drop.", "area_path": "Project\\Area1"},
                {"item_id": "item-2", "text": "The unit shall survive a drop.", "title": "The unit shall survive a drop.", "area_path": "Project\\Area2"},
            ]
        },
    )
    assert response.status_code == 200

    check_area1 = client.post(
        "/dedup/check", json={"text": "The unit shall survive a drop.", "title": "The unit shall survive a drop.", "area_path": "Project\\Area1"}
    )
    assert check_area1.json()["matched_item_id"] == "item-1"

    check_area2 = client.post(
        "/dedup/check", json={"text": "The unit shall survive a drop.", "title": "The unit shall survive a drop.", "area_path": "Project\\Area2"}
    )
    assert check_area2.json()["matched_item_id"] == "item-2"


def test_dedup_upsert_and_check_blend_title_and_text_into_one_embedding(tmp_path, monkeypatch) -> None:
    # Regression for the confirmed real bug: embedding description alone
    # let a genuine duplicate (title differs slightly in wording from the
    # matched item, description differs more) score below the fixed 0.90
    # threshold. /dedup/upsert and /dedup/check must both embed title AND
    # text (2 embed calls' worth of texts, blended into 1 vector) -- not
    # just text alone. A mock that returns a FIXED vector per exact input
    # string (not a length-derived one) proves the route actually sends
    # both title and text to embed(), in the right per-item order, and
    # blends them -- a route that silently dropped the title would embed
    # only "matched description" (KeyError'ing here) or produce a
    # different, non-blended vector.
    import math

    # Description-only similarity is cos(theta) = 0.65 (well below 0.90).
    # Both titles point in the SAME direction as the matched item's own
    # vector, so the 50/50 blend lands at the angle bisector -- cos(theta/2)
    # ~= 0.909, clearing 0.90 on the blend alone (mirrors the confirmed real
    # case: WI-647 went 0.755 -> 0.9026 once its title was blended in).
    monkeypatch.setattr(main, "_vector_store", ChromaVectorStore(str(tmp_path)))
    theta = math.acos(0.65)
    off_axis_vector = [math.cos(theta), math.sin(theta)]
    vectors = {
        "matched title": [1.0, 0.0],
        "matched description": [1.0, 0.0],
        "candidate title": [1.0, 0.0],
        "candidate description": off_axis_vector,
    }

    def _fixed_vector_handler(request: httpx.Request) -> httpx.Response:
        texts = json.loads(request.content)["texts"]
        return httpx.Response(200, json={"embeddings": [vectors[text] for text in texts]})

    main._embed_client._transport = httpx.MockTransport(_fixed_vector_handler)

    upsert_response = client.post(
        "/dedup/upsert",
        json={"item_id": "item-1", "text": "matched description", "title": "matched title", "area_path": "Project\\Area1"},
    )
    assert upsert_response.status_code == 200

    check_response = client.post(
        "/dedup/check",
        json={"text": "candidate description", "title": "candidate title", "area_path": "Project\\Area1"},
    )
    assert check_response.status_code == 200
    body = check_response.json()
    assert body["matched_item_id"] == "item-1"
    assert body["similarity"] > 0.90
    assert body["is_duplicate"] is True


def test_dedup_check_scopes_by_area_path_and_finds_no_match_across_area_paths(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(main, "_vector_store", ChromaVectorStore(str(tmp_path)))
    main._embed_client._transport = httpx.MockTransport(_mock_embed_handler)

    upsert_response = client.post(
        "/dedup/upsert",
        json={"item_id": "item-1", "text": "The unit shall survive a drop.", "title": "The unit shall survive a drop.", "area_path": "Project\\Area1"},
    )
    assert upsert_response.status_code == 200

    check_response = client.post(
        "/dedup/check", json={"text": "The unit shall survive a drop.", "title": "The unit shall survive a drop.", "area_path": "Project\\Area2"}
    )
    assert check_response.status_code == 200
    body = check_response.json()
    assert body["is_duplicate"] is False
