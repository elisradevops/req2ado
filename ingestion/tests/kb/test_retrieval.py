import logging

from app.kb.kb_vector_store import KbVectorStore
from app.kb.retrieval import fetch_always_include_context, retrieve_context


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
    def query(self, user_id: str, embedding: list[float], top_k: int) -> list[dict]:
        raise RuntimeError("chroma unavailable")


def test_retrieve_context_returns_none_and_empty_citations_for_empty_collection(tmp_path) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    context, citations = retrieve_context("Project\\Area1", "some outline", FakeEmbedClient(), store)
    assert context is None
    assert citations == []


def test_retrieve_context_joins_hits_within_threshold(tmp_path) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    store.upsert_chunk(
        chunk_id="s1:doc.txt:0", embedding=[1.0, 0.0, 0.0], text="close chunk text",
        user_id="Project\\Area1", source_file="doc.txt", source_id="s1", chunk_index=0, file_hash="h1",
    )
    context, citations = retrieve_context("Project\\Area1", "some outline", FakeEmbedClient(embedding=[1.0, 0.0, 0.0]), store)
    assert context == "close chunk text"
    assert [c["source_file"] for c in citations] == ["doc.txt"]
    assert citations[0]["similarity"] == 1.0


def test_retrieve_context_dedups_citations_across_multiple_hits_from_the_same_file(tmp_path) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    store.upsert_chunk(
        chunk_id="s1:doc.txt:0", embedding=[1.0, 0.0, 0.0], text="chunk one",
        user_id="Project\\Area1", source_file="doc.txt", source_id="s1", chunk_index=0, file_hash="h1",
    )
    store.upsert_chunk(
        chunk_id="s1:doc.txt:1", embedding=[1.0, 0.0, 0.0], text="chunk two",
        user_id="Project\\Area1", source_file="doc.txt", source_id="s1", chunk_index=1, file_hash="h1",
    )
    context, citations = retrieve_context("Project\\Area1", "some outline", FakeEmbedClient(embedding=[1.0, 0.0, 0.0]), store, top_k=5)
    assert [c["source_file"] for c in citations] == ["doc.txt"]
    assert context is not None and "chunk one" in context and "chunk two" in context


def test_retrieve_context_citations_span_multiple_distinct_files(tmp_path) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    store.upsert_chunk(
        chunk_id="s1:doc1.txt:0", embedding=[1.0, 0.0, 0.0], text="from doc1",
        user_id="Project\\Area1", source_file="doc1.txt", source_id="s1", chunk_index=0, file_hash="h1",
    )
    store.upsert_chunk(
        chunk_id="s2:doc2.txt:0", embedding=[1.0, 0.0, 0.0], text="from doc2",
        user_id="Project\\Area1", source_file="doc2.txt", source_id="s2", chunk_index=0, file_hash="h2",
    )
    context, citations = retrieve_context("Project\\Area1", "some outline", FakeEmbedClient(embedding=[1.0, 0.0, 0.0]), store, top_k=5)
    assert sorted(c["source_file"] for c in citations) == ["doc1.txt", "doc2.txt"]


def test_retrieve_context_dedup_keeps_the_lowest_distance_hit_per_file(tmp_path) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    # A worse (farther) hit from the same file, upserted first.
    store.upsert_chunk(
        chunk_id="s1:doc.txt:0", embedding=[0.9, 0.436, 0.0], text="farther chunk",
        user_id="Project\\Area1", source_file="doc.txt", source_id="s1", chunk_index=0, file_hash="h1",
    )
    # A better (closer) hit from the same file.
    store.upsert_chunk(
        chunk_id="s1:doc.txt:1", embedding=[1.0, 0.0, 0.0], text="closer chunk",
        user_id="Project\\Area1", source_file="doc.txt", source_id="s1", chunk_index=1, file_hash="h1",
    )
    _context, citations = retrieve_context("Project\\Area1", "some outline", FakeEmbedClient(embedding=[1.0, 0.0, 0.0]), store, top_k=5)
    assert len(citations) == 1
    assert citations[0]["text"] == "closer chunk"


def test_retrieve_context_discards_hits_below_similarity_bar(tmp_path) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    # Orthogonal embedding -> cosine distance 1.0 -> similarity 0.0, well below the 0.3 cutoff.
    store.upsert_chunk(
        chunk_id="s1:doc.txt:0", embedding=[0.0, 1.0, 0.0], text="unrelated chunk",
        user_id="Project\\Area1", source_file="doc.txt", source_id="s1", chunk_index=0, file_hash="h1",
    )
    context, citations = retrieve_context("Project\\Area1", "some outline", FakeEmbedClient(embedding=[1.0, 0.0, 0.0]), store)
    assert context is None
    assert citations == []


def test_retrieve_context_returns_none_and_logs_warning_when_embed_raises(tmp_path, caplog) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    embed_client = FakeEmbedClient(raises=RuntimeError("orchestrator unreachable"))
    with caplog.at_level(logging.WARNING):
        context, citations = retrieve_context("Project\\Area1", "some outline", embed_client, store)
    assert context is None
    assert citations == []
    assert "orchestrator unreachable" in caplog.text


def test_retrieve_context_returns_none_and_logs_warning_when_query_raises(caplog) -> None:
    with caplog.at_level(logging.WARNING):
        context, citations = retrieve_context("Project\\Area1", "some outline", FakeEmbedClient(), RaisingVectorStore())
    assert context is None
    assert citations == []
    assert "chroma unavailable" in caplog.text


def test_fetch_always_include_context_returns_none_when_no_file_is_tagged(tmp_path) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    store.upsert_chunk(
        chunk_id="s1:doc.txt:0", embedding=[1.0, 0.0, 0.0], text="chunk text",
        user_id="Project\\Area1", source_file="doc.txt", source_id="s1", chunk_index=0, file_hash="h1",
    )
    context, citations = fetch_always_include_context("Project\\Area1", store)
    assert context is None
    assert citations == []


def test_fetch_always_include_context_returns_full_text_unconditionally_regardless_of_similarity(tmp_path) -> None:
    # Real gap this closes: an "always_include" file's text must be
    # returned even though this function never computes/compares any
    # similarity score at all -- there is no query_text param, unlike
    # retrieve_context.
    store = KbVectorStore(persist_path=str(tmp_path))
    store.upsert_chunk(
        chunk_id="s1:standards.docx:0", embedding=[1.0, 0.0, 0.0], text="first part",
        user_id="Project\\Area1", source_file="standards.docx", source_id="s1", chunk_index=0,
        file_hash="h1", retrieval_mode="always_include",
    )
    store.upsert_chunk(
        chunk_id="s1:standards.docx:1", embedding=[1.0, 0.0, 0.0], text="second part",
        user_id="Project\\Area1", source_file="standards.docx", source_id="s1", chunk_index=1,
        file_hash="h1", retrieval_mode="always_include",
    )
    context, citations = fetch_always_include_context("Project\\Area1", store)
    assert context == "first part\n\nsecond part"
    assert citations == [{"source_file": "standards.docx", "similarity": 1.0, "text": context, "truncated": False}]


def test_fetch_always_include_context_concatenates_multiple_tagged_files(tmp_path) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    store.upsert_chunk(
        chunk_id="s1:cmmi.docx:0", embedding=[1.0, 0.0, 0.0], text="cmmi text",
        user_id="Project\\Area1", source_file="cmmi.docx", source_id="s1", chunk_index=0,
        file_hash="h1", retrieval_mode="always_include",
    )
    store.upsert_chunk(
        chunk_id="s2:incose.docx:0", embedding=[0.0, 1.0, 0.0], text="incose text",
        user_id="Project\\Area1", source_file="incose.docx", source_id="s2", chunk_index=0,
        file_hash="h2", retrieval_mode="always_include",
    )
    context, citations = fetch_always_include_context("Project\\Area1", store)
    assert context is not None and "cmmi text" in context and "incose text" in context
    assert sorted(c["source_file"] for c in citations) == ["cmmi.docx", "incose.docx"]


def test_fetch_always_include_context_ignores_retrieve_mode_files(tmp_path) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    store.upsert_chunk(
        chunk_id="s1:standards.docx:0", embedding=[1.0, 0.0, 0.0], text="always text",
        user_id="Project\\Area1", source_file="standards.docx", source_id="s1", chunk_index=0,
        file_hash="h1", retrieval_mode="always_include",
    )
    store.upsert_chunk(
        chunk_id="s2:spec.docx:0", embedding=[0.0, 1.0, 0.0], text="retrieve text",
        user_id="Project\\Area1", source_file="spec.docx", source_id="s2", chunk_index=0, file_hash="h2",
    )
    context, citations = fetch_always_include_context("Project\\Area1", store)
    assert context == "always text"
    assert [c["source_file"] for c in citations] == ["standards.docx"]


def test_fetch_always_include_context_returns_none_and_logs_warning_when_the_store_raises(caplog) -> None:
    class RaisingListVectorStore:
        def list_always_include_documents(self, user_id: str) -> list[str]:
            raise RuntimeError("chroma unavailable")

    with caplog.at_level(logging.WARNING):
        context, citations = fetch_always_include_context("Project\\Area1", RaisingListVectorStore())
    assert context is None
    assert citations == []
    assert "chroma unavailable" in caplog.text
