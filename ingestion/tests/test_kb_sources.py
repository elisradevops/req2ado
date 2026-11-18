"""Finding (and removing) KB content the orchestrator's own list of KB documents has no record of."""

import pytest

from app.kb.kb_vector_store import KbVectorStore

EMBEDDING = [0.1, 0.2, 0.3]


@pytest.fixture
def store(tmp_path) -> KbVectorStore:
    return KbVectorStore(str(tmp_path / "chroma"))


def put(store: KbVectorStore, source_id: str, name: str, index: int, file_hash: str = "h1") -> None:
    store.upsert_chunk(
        chunk_id=f"{source_id}:{name}:{index}",
        embedding=EMBEDDING,
        text=f"{name} chunk {index}",
        user_id="u1",
        source_file=name,
        source_id=source_id,
        chunk_index=index,
        file_hash=file_hash,
    )


def put_without_source_id(store: KbVectorStore, name: str, index: int) -> None:
    # What a version that stored no source_id left behind: a chunk whose metadata has no such key.
    store._get_collection("u1").add(
        ids=[f"legacy:{name}:{index}"],
        embeddings=[EMBEDDING],
        documents=[f"{name} chunk {index}"],
        metadatas=[{"source_file": name, "chunk_index": index, "file_hash": "old"}],
    )


def test_a_user_with_no_kb_has_no_sources(store) -> None:
    assert store.list_sources("nobody") == []
    assert store.delete_unattributed_chunks("nobody") == 0


def test_each_source_is_listed_once_with_its_names_hashes_and_chunk_count(store) -> None:
    put(store, "item-a", "spec.docx", 0)
    put(store, "item-a", "spec.docx", 1)
    put(store, "item-b", "spec.docx", 0, file_hash="h2")  # same name under another item: the case that merges two copies into one

    assert store.list_sources("u1") == [
        {"source_id": "item-a", "source_files": ["spec.docx"], "file_hashes": ["h1"], "chunks": 2},
        {"source_id": "item-b", "source_files": ["spec.docx"], "file_hashes": ["h2"], "chunks": 1},
    ]


def test_a_chunk_without_a_source_id_is_listed_as_its_own_entry_last(store) -> None:
    put(store, "item-a", "spec.docx", 0)
    put_without_source_id(store, "old.docx", 0)

    sources = store.list_sources("u1")

    assert [s["source_id"] for s in sources] == ["item-a", None]
    assert sources[1]["source_files"] == ["old.docx"]


def test_listing_reads_every_page(store, monkeypatch) -> None:
    monkeypatch.setattr("app.kb.kb_vector_store._GET_PAGE_SIZE", 2)
    for index in range(5):
        put(store, "item-a", "spec.docx", index)
    put(store, "item-b", "other.docx", 0)

    assert {s["source_id"]: s["chunks"] for s in store.list_sources("u1")} == {"item-a": 5, "item-b": 1}


def test_unattributed_chunks_can_be_deleted_and_nothing_else_is(store, monkeypatch) -> None:
    monkeypatch.setattr("app.kb.kb_vector_store._GET_PAGE_SIZE", 2)
    put(store, "item-a", "spec.docx", 0)
    put(store, "item-a", "spec.docx", 1)
    for index in range(3):
        put_without_source_id(store, "old.docx", index)

    assert store.delete_unattributed_chunks("u1") == 3

    assert [(s["source_id"], s["chunks"]) for s in store.list_sources("u1")] == [("item-a", 2)]


def test_deleting_a_source_by_id_removes_every_chunk_of_it_including_under_another_name(store) -> None:
    put(store, "item-a", "old-name.docx", 0)
    put(store, "item-a", "new-name.docx", 1)  # a rename that left chunks under both names
    put(store, "item-b", "other.docx", 0)

    store.delete_file_chunks("u1", "new-name.docx", "item-a")

    assert [s["source_id"] for s in store.list_sources("u1")] == ["item-b"]
