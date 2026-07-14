import logging

from app.kb.kb_vector_store import KbVectorStore
from app.kb.retrieval import retrieve_context


class FakeEmbedClient:
    def __init__(self, embedding: list[float] | None = None, raises: Exception | None = None) -> None:
        self._embedding = embedding or [1.0, 0.0, 0.0]
        self._raises = raises
        self.calls: list[list[str]] = []

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(texts)
        if self._raises:
            raise self._raises
        return [self._embedding]


class RaisingVectorStore:
    def query(self, area_path: str, embedding: list[float], top_k: int) -> list[dict]:
        raise RuntimeError("chroma unavailable")


def test_retrieve_context_returns_none_for_empty_collection(tmp_path) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    result = retrieve_context("Project\\Area1", "some outline", FakeEmbedClient(), store)
    assert result is None


def test_retrieve_context_joins_hits_within_threshold(tmp_path) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    store.upsert_chunk(
        chunk_id="s1:doc.txt:0", embedding=[1.0, 0.0, 0.0], text="close chunk text",
        area_path="Project\\Area1", source_file="doc.txt", source_id="s1", chunk_index=0, file_hash="h1",
    )
    result = retrieve_context("Project\\Area1", "some outline", FakeEmbedClient(embedding=[1.0, 0.0, 0.0]), store)
    assert result == "close chunk text"


def test_retrieve_context_discards_hits_below_similarity_bar(tmp_path) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    # Orthogonal embedding -> cosine distance 1.0 -> similarity 0.0, well below the 0.3 cutoff.
    store.upsert_chunk(
        chunk_id="s1:doc.txt:0", embedding=[0.0, 1.0, 0.0], text="unrelated chunk",
        area_path="Project\\Area1", source_file="doc.txt", source_id="s1", chunk_index=0, file_hash="h1",
    )
    result = retrieve_context("Project\\Area1", "some outline", FakeEmbedClient(embedding=[1.0, 0.0, 0.0]), store)
    assert result is None


def test_retrieve_context_returns_none_and_logs_warning_when_embed_raises(tmp_path, caplog) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    embed_client = FakeEmbedClient(raises=RuntimeError("orchestrator unreachable"))
    with caplog.at_level(logging.WARNING):
        result = retrieve_context("Project\\Area1", "some outline", embed_client, store)
    assert result is None
    assert "orchestrator unreachable" in caplog.text


def test_retrieve_context_returns_none_and_logs_warning_when_query_raises(caplog) -> None:
    with caplog.at_level(logging.WARNING):
        result = retrieve_context("Project\\Area1", "some outline", FakeEmbedClient(), RaisingVectorStore())
    assert result is None
    assert "chroma unavailable" in caplog.text
