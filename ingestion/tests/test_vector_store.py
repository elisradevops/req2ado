from unittest.mock import patch

import pytest

from app.dedup.vector_store import ChromaVectorStore


def test_default_mode_uses_a_local_persistent_client(tmp_path) -> None:
    with patch("app.dedup.vector_store.chromadb.PersistentClient") as mock_persistent:
        ChromaVectorStore(persist_path=str(tmp_path))
        mock_persistent.assert_called_once_with(path=str(tmp_path))


def test_http_mode_connects_to_a_shared_chroma_server_instead() -> None:
    # Regression: previously the ONLY mode was a local PersistentClient --
    # each ingestion replica held an independent, incomplete dedup corpus.
    # mode="http" makes ingestion genuinely stateless/horizontally-scalable.
    with patch("app.dedup.vector_store.chromadb.HttpClient") as mock_http:
        ChromaVectorStore("unused-in-http-mode", mode="http", host="chroma", port=8000)
        mock_http.assert_called_once_with(host="chroma", port=8000)


def test_query_nearest_returns_none_on_an_empty_collection(tmp_path) -> None:
    store = ChromaVectorStore(persist_path=str(tmp_path))
    result = store.query_nearest([0.1, 0.2, 0.3], area_path="Project\\Area1")
    assert result is None


def test_ping_returns_true_for_a_real_reachable_client(tmp_path) -> None:
    store = ChromaVectorStore(persist_path=str(tmp_path))
    assert store.ping() is True


def test_ping_returns_false_when_the_underlying_client_raises() -> None:
    store = ChromaVectorStore(persist_path="/tmp/unused-for-this-test")
    store._client.heartbeat = lambda: (_ for _ in ()).throw(RuntimeError("chroma down"))
    assert store.ping() is False


def test_upsert_then_query_nearest_finds_an_exact_match() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("item-1", [1.0, 0.0, 0.0], area_path="Project\\Area1")
        result = store.query_nearest([1.0, 0.0, 0.0], area_path="Project\\Area1")
        assert result is not None
        matched_id, similarity = result
        assert matched_id == "item-1"
        assert similarity == pytest.approx(1.0, abs=1e-6)


def test_query_nearest_reflects_cosine_similarity_for_a_near_but_not_exact_match() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("item-1", [1.0, 0.0, 0.0], area_path="Project\\Area1")
        # A vector at 45 degrees from [1,0,0] has cosine similarity ~0.707
        result = store.query_nearest([1.0, 1.0, 0.0], area_path="Project\\Area1")
        assert result is not None
        matched_id, similarity = result
        assert matched_id == "item-1"
        assert similarity == pytest.approx(0.7071, abs=1e-3)


def test_area_paths_are_isolated_from_each_other() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("item-1", [1.0, 0.0, 0.0], area_path="Project\\Area1")
        # Same exact vector, but queried under a DIFFERENT area path — must
        # not match item-1, since area paths are structurally isolated
        # (separate Chroma collections), not just filtered.
        result = store.query_nearest([1.0, 0.0, 0.0], area_path="Project\\Area2")
        assert result is None


def test_upsert_is_idempotent_for_the_same_item_id() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("item-1", [1.0, 0.0, 0.0], area_path="Project\\Area1")
        store.upsert("item-1", [0.0, 1.0, 0.0], area_path="Project\\Area1")  # re-upsert, different vector
        result = store.query_nearest([0.0, 1.0, 0.0], area_path="Project\\Area1")
        matched_id, similarity = result
        assert matched_id == "item-1"
        assert similarity == pytest.approx(1.0, abs=1e-6)  # matches the UPDATED vector, not the original
