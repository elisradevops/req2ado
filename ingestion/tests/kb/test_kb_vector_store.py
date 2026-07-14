import tempfile

from app.kb.kb_vector_store import KbVectorStore


def test_existing_file_hash_returns_none_for_a_never_ingested_file() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        assert store.existing_file_hash("Project\\Area1", "doc.txt", "source-1") is None


def test_upsert_chunk_then_existing_file_hash_returns_the_stored_hash() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.upsert_chunk(
            chunk_id="source-1:doc.txt:0",
            embedding=[1.0, 0.0, 0.0],
            text="chunk text",
            area_path="Project\\Area1",
            source_file="doc.txt",
            source_id="source-1",
            chunk_index=0,
            file_hash="hash-1",
        )
        assert store.existing_file_hash("Project\\Area1", "doc.txt", "source-1") == "hash-1"


def test_kb_collections_are_isolated_from_dedup_collections_for_the_same_area_path() -> None:
    from app.dedup.vector_store import ChromaVectorStore

    with tempfile.TemporaryDirectory() as tmp:
        kb_store = KbVectorStore(persist_path=tmp)
        dedup_store = ChromaVectorStore(persist_path=tmp)
        kb_store.upsert_chunk(
            chunk_id="source-1:doc.txt:0", embedding=[1.0, 0.0, 0.0], text="t", area_path="Project\\Area1",
            source_file="doc.txt", source_id="source-1", chunk_index=0, file_hash="hash-1",
        )
        # Dedup's store must see nothing from the KB collection — separate namespace.
        assert dedup_store.query_nearest([1.0, 0.0, 0.0], area_path="Project\\Area1") is None


def test_delete_file_chunks_removes_all_chunks_for_that_file_only() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.upsert_chunk(
            chunk_id="source-1:doc.txt:0", embedding=[1.0, 0.0, 0.0], text="t0", area_path="Project\\Area1",
            source_file="doc.txt", source_id="source-1", chunk_index=0, file_hash="hash-1",
        )
        store.upsert_chunk(
            chunk_id="source-1:other.txt:0", embedding=[0.0, 1.0, 0.0], text="t1", area_path="Project\\Area1",
            source_file="other.txt", source_id="source-1", chunk_index=0, file_hash="hash-2",
        )
        store.delete_file_chunks("Project\\Area1", "doc.txt", "source-1")
        assert store.existing_file_hash("Project\\Area1", "doc.txt", "source-1") is None
        assert store.existing_file_hash("Project\\Area1", "other.txt", "source-1") == "hash-2"


def test_two_sources_sharing_an_area_path_do_not_clobber_same_named_files() -> None:
    """Regression test for the file-identity collision: nothing enforces
    area_path uniqueness across KbSource rows, so two different sources can
    target the same area_path. Before source_id was part of chunk identity,
    source B syncing its own "spec.docx" would delete/overwrite source A's
    chunks for a file of the same name. source_id scoping must keep them
    fully independent."""
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)

        # Source A ingests spec.docx into area path "Shared\\Area".
        store.upsert_chunk(
            chunk_id="source-A:spec.docx:0",
            embedding=[1.0, 0.0, 0.0],
            text="Source A's content",
            area_path="Shared\\Area",
            source_file="spec.docx",
            source_id="source-A",
            chunk_index=0,
            file_hash="hash-A",
        )

        # Source B, a DIFFERENT KbSource pointed at the SAME area path,
        # syncs its own same-named spec.docx — this mimics sync_kb_source's
        # delete-then-upsert cycle for source B only.
        store.delete_file_chunks("Shared\\Area", "spec.docx", "source-B")
        store.upsert_chunk(
            chunk_id="source-B:spec.docx:0",
            embedding=[0.0, 1.0, 0.0],
            text="Source B's content",
            area_path="Shared\\Area",
            source_file="spec.docx",
            source_id="source-B",
            chunk_index=0,
            file_hash="hash-B",
        )

        # Source A's original hash/chunks must be untouched.
        assert store.existing_file_hash("Shared\\Area", "spec.docx", "source-A") == "hash-A"
        assert store.existing_file_hash("Shared\\Area", "spec.docx", "source-B") == "hash-B"


def test_query_returns_empty_list_for_a_never_ingested_area_path() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        assert store.query("Project\\Area1", embedding=[1.0, 0.0, 0.0], top_k=5) == []


def test_query_returns_nearest_chunks_ordered_by_distance() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.upsert_chunk(
            chunk_id="source-1:doc.txt:0", embedding=[1.0, 0.0, 0.0], text="near chunk",
            area_path="Project\\Area1", source_file="doc.txt", source_id="source-1",
            chunk_index=0, file_hash="hash-1",
        )
        store.upsert_chunk(
            chunk_id="source-1:doc.txt:1", embedding=[0.0, 1.0, 0.0], text="far chunk",
            area_path="Project\\Area1", source_file="doc.txt", source_id="source-1",
            chunk_index=1, file_hash="hash-1",
        )
        results = store.query("Project\\Area1", embedding=[1.0, 0.0, 0.0], top_k=5)
        assert len(results) == 2
        assert results[0]["text"] == "near chunk"
        assert results[0]["source_file"] == "doc.txt"
        assert results[0]["distance"] < results[1]["distance"]


def test_query_respects_top_k() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        for i in range(3):
            store.upsert_chunk(
                chunk_id=f"source-1:doc.txt:{i}", embedding=[1.0, float(i), 0.0], text=f"chunk {i}",
                area_path="Project\\Area1", source_file="doc.txt", source_id="source-1",
                chunk_index=i, file_hash="hash-1",
            )
        results = store.query("Project\\Area1", embedding=[1.0, 0.0, 0.0], top_k=2)
        assert len(results) == 2
