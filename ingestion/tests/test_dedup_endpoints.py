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


def _fixed_angle_embed_handler(request: httpx.Request) -> httpx.Response:
    # Deterministic, known-angle vectors (cosine similarity = 0.5 between
    # the two texts below) -- independent of _mock_embed_handler's
    # length-derived scheme, which turned out to keep any two same-shaped
    # short sentences well above 0.90 regardless of length, making it
    # unsuitable for testing a threshold strictly between 0.01 and 0.90.
    texts = json.loads(request.content)["texts"]
    vectors = {
        "Short.": [1.0, 0.0],
        "A completely different and much longer requirement about something else entirely.": [0.5, 0.8660254],
    }
    return httpx.Response(200, json={"embeddings": [vectors[text] for text in texts]})


def test_dedup_check_uses_the_default_threshold_when_none_is_provided(tmp_path, monkeypatch) -> None:
    # A moderately-similar pair (cosine similarity 0.5, well under the real
    # 0.90 default) should NOT be flagged as a duplicate when the request
    # omits `threshold` entirely -- same behavior as before the
    # Settings-window override existed.
    monkeypatch.setattr(main, "_vector_store", ChromaVectorStore(str(tmp_path)))
    main._embed_client._transport = httpx.MockTransport(_fixed_angle_embed_handler)

    client.post(
        "/dedup/upsert",
        json={"item_id": "item-1", "text": "Short.", "title": "Short.", "area_path": "Project\\Area1"},
    )
    response = client.post(
        "/dedup/check",
        json={
            "text": "A completely different and much longer requirement about something else entirely.",
            "title": "A completely different and much longer requirement about something else entirely.",
            "area_path": "Project\\Area1",
        },
    )
    assert response.json()["is_duplicate"] is False


def test_dedup_check_respects_an_explicit_threshold_override(tmp_path, monkeypatch) -> None:
    # Same pair as above (cosine similarity 0.5) -- but an explicit, low
    # threshold (Settings-window override) should now flag it as a
    # duplicate, proving the request-body threshold actually reaches
    # check_for_duplicates.
    monkeypatch.setattr(main, "_vector_store", ChromaVectorStore(str(tmp_path)))
    main._embed_client._transport = httpx.MockTransport(_fixed_angle_embed_handler)

    client.post(
        "/dedup/upsert",
        json={"item_id": "item-1", "text": "Short.", "title": "Short.", "area_path": "Project\\Area1"},
    )
    response = client.post(
        "/dedup/check",
        json={
            "text": "A completely different and much longer requirement about something else entirely.",
            "title": "A completely different and much longer requirement about something else entirely.",
            "area_path": "Project\\Area1",
            "threshold": 0.4,
        },
    )
    body = response.json()
    assert body["is_duplicate"] is True
    assert body["matched_item_id"] == "item-1"


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


class _RecordingEmitter:
    def __init__(self) -> None:
        self.compares: list[dict] = []

    def compare(self, **kwargs) -> None:  # noqa: ANN003
        self.compares.append(kwargs)


def _seed_duplicate(tmp_path, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(main, "_vector_store", ChromaVectorStore(str(tmp_path)))
    main._embed_client._transport = httpx.MockTransport(_mock_embed_handler)
    client.post(
        "/dedup/upsert",
        json={"item_id": "item-1", "text": "The unit shall survive a drop.",
              "title": "The unit shall survive a drop.", "area_path": "Project\\Area1"},
    )


def _check(job_id: str | None) -> dict:
    payload = {"text": "The unit shall survive a drop.", "title": "The unit shall survive a drop.",
               "area_path": "Project\\Area1"}
    if job_id is not None:
        payload["job_id"] = job_id
    response = client.post("/dedup/check", json=payload)
    assert response.status_code == 200
    return response.json()


def _patch_scope(monkeypatch, emitter: _RecordingEmitter | None) -> list[str]:  # noqa: ANN001
    from contextlib import contextmanager

    seen: list[str] = []

    @contextmanager
    def fake_scope(job_id, redis):  # noqa: ANN001, ANN202
        seen.append(job_id)
        yield emitter

    monkeypatch.setattr(main, "live_emitter_scope", fake_scope)
    return seen


def test_dedup_check_emits_a_duplicate_comparison_for_a_job(tmp_path, monkeypatch) -> None:
    _seed_duplicate(tmp_path, monkeypatch)
    emitter = _RecordingEmitter()
    _patch_scope(monkeypatch, emitter)

    body = _check("job-9")

    assert body["is_duplicate"] is True
    assert len(emitter.compares) == 1
    frame = emitter.compares[0]
    assert frame["kind"] == "duplicate"
    assert frame["a_ref"] == "proposed" and frame["b_ref"] == "item-1"
    assert frame["a_text"] == frame["b_text"] == "The unit shall survive a drop."


def test_dedup_check_response_never_carries_the_matched_text(tmp_path, monkeypatch) -> None:
    _seed_duplicate(tmp_path, monkeypatch)
    _patch_scope(monkeypatch, _RecordingEmitter())

    body = _check("job-9")

    assert "matched_text" not in body
    assert set(body) == {"is_duplicate", "matched_item_id", "similarity", "judge_verdict"}


def test_dedup_check_emits_nothing_without_a_job_id(tmp_path, monkeypatch) -> None:
    _seed_duplicate(tmp_path, monkeypatch)
    emitter = _RecordingEmitter()
    seen = _patch_scope(monkeypatch, emitter)

    assert _check(None)["is_duplicate"] is True
    assert emitter.compares == [] and seen == []


def test_dedup_check_emits_nothing_when_it_is_not_a_duplicate(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(main, "_vector_store", ChromaVectorStore(str(tmp_path)))
    main._embed_client._transport = httpx.MockTransport(_mock_embed_handler)
    emitter = _RecordingEmitter()
    _patch_scope(monkeypatch, emitter)

    assert _check("job-9")["is_duplicate"] is False
    assert emitter.compares == []


def test_dedup_check_with_live_progress_off_is_unchanged(tmp_path, monkeypatch) -> None:
    # Real scope, flag off: no emitter exists, the call just returns the result.
    _seed_duplicate(tmp_path, monkeypatch)
    monkeypatch.setattr(main.settings, "live_progress", False)

    assert _check("job-9")["is_duplicate"] is True


class _CapturingRedis:
    def __init__(self) -> None:
        self.published: list[tuple[str, str]] = []

    def incr(self, name):  # noqa: ANN001, ANN201
        return len(self.published) + 1

    def expire(self, name, time):  # noqa: ANN001, ANN201
        return True

    def hset(self, name, key, value):  # noqa: ANN001, ANN201
        return 1

    def publish(self, channel, message):  # noqa: ANN001, ANN201
        self.published.append((channel, message))


def test_dedup_check_publishes_a_real_comparison_frame_through_the_real_emitter(
    tmp_path, monkeypatch,  # noqa: ANN001
) -> None:
    # No fake scope: the real live_emitter_scope and LiveEmitter, so a lookup that
    # only works when a job context is set (the dedup route sets none) would fail here.
    _seed_duplicate(tmp_path, monkeypatch)
    redis = _CapturingRedis()
    monkeypatch.setattr(main, "_narration_redis", redis)
    monkeypatch.setattr(main.settings, "live_progress", True)

    assert _check("job-real")["is_duplicate"] is True

    frames = [json.loads(m) for c, m in redis.published if c == "job-events:job-real:live"]
    assert len(frames) == 1
    compare = frames[0]["compare"]
    assert frames[0]["kind"] == "compare" and compare["kind"] == "duplicate"
    assert compare["a"]["ref"] == "proposed" and compare["b"]["ref"] == "item-1"
    assert compare["a"]["text"] == compare["b"]["text"] == "The unit shall survive a drop."


_UPSERT_BODY = {"items": [{"item_id": "item-1", "text": "The unit shall survive a drop.", "title": "Drop", "area_path": "Project\\Area1"}]}


def test_an_embedding_refusal_reaches_the_caller_as_a_502_with_the_upstream_status_not_a_bare_500(tmp_path, monkeypatch) -> None:
    # A 401 here means the user has no usable model connection (or the call carried no user): the caller must be able to
    # tell that from a crash, and retrying it cannot help.
    monkeypatch.setattr(main, "_vector_store", ChromaVectorStore(str(tmp_path)))
    calls = []

    def refuse(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(401, json={"message": "No Open WebUI connection configured"})

    main._embed_client._transport = httpx.MockTransport(refuse)
    response = client.post("/dedup/upsert-batch", json=_UPSERT_BODY)
    assert response.status_code == 502
    assert "401" in response.json()["detail"]
    assert len(calls) == 1  # an authorization failure is never retried


def test_a_transient_embedding_failure_is_retried_once(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(main, "_vector_store", ChromaVectorStore(str(tmp_path)))
    calls = []

    def flaky(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(503, json={"message": "busy"})
        return _mock_embed_handler(request)

    main._embed_client._transport = httpx.MockTransport(flaky)
    response = client.post("/dedup/upsert-batch", json=_UPSERT_BODY)
    assert response.status_code == 200 and len(calls) == 2


def test_a_persistent_embedding_server_failure_is_a_502_after_one_retry(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(main, "_vector_store", ChromaVectorStore(str(tmp_path)))
    calls = []

    def down(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(503, json={"message": "busy"})

    main._embed_client._transport = httpx.MockTransport(down)
    response = client.post("/dedup/upsert-batch", json=_UPSERT_BODY)
    assert response.status_code == 502 and "503" in response.json()["detail"] and len(calls) == 2
