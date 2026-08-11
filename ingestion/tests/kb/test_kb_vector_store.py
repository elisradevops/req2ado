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
            user_id="Project\\Area1",
            source_file="doc.txt",
            source_id="source-1",
            chunk_index=0,
            file_hash="hash-1",
        )
        assert store.existing_file_hash("Project\\Area1", "doc.txt", "source-1") == "hash-1"


def test_get_quality_checklist_returns_none_when_extraction_never_ran() -> None:
    # None (extraction never ran, e.g. ingested before this existed) is a
    # distinct signal from [] (extraction ran, found genuinely nothing) --
    # the caller's own live-derive/fixed-5-dimension fallback applies to
    # both, but they mean different things for observability.
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.upsert_chunk(
            chunk_id="source-1:doc.txt:0", embedding=[1.0, 0.0, 0.0], text="chunk text", user_id="Project\\Area1",
            source_file="doc.txt", source_id="source-1", chunk_index=0, file_hash="hash-1",
        )
        assert store.get_quality_checklist("Project\\Area1", "doc.txt") is None


def test_upsert_chunk_then_get_quality_checklist_round_trips_the_stored_list() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.upsert_chunk(
            chunk_id="source-1:doc.txt:0", embedding=[1.0, 0.0, 0.0], text="chunk text", user_id="Project\\Area1",
            source_file="doc.txt", source_id="source-1", chunk_index=0, file_hash="hash-1",
            quality_checklist=["Necessary", "Unambiguous", "Verifiable"],
        )
        assert store.get_quality_checklist("Project\\Area1", "doc.txt") == ["Necessary", "Unambiguous", "Verifiable"]


def test_get_quality_checklist_round_trips_a_genuinely_empty_list() -> None:
    # [] (extraction ran, found no checklist) must survive the round trip
    # distinct from None -- not silently coerced to "never ran".
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.upsert_chunk(
            chunk_id="source-1:doc.txt:0", embedding=[1.0, 0.0, 0.0], text="chunk text", user_id="Project\\Area1",
            source_file="doc.txt", source_id="source-1", chunk_index=0, file_hash="hash-1",
            quality_checklist=[],
        )
        assert store.get_quality_checklist("Project\\Area1", "doc.txt") == []


def test_kb_collections_are_isolated_from_dedup_collections_for_the_same_area_path() -> None:
    from app.dedup.vector_store import ChromaVectorStore

    with tempfile.TemporaryDirectory() as tmp:
        kb_store = KbVectorStore(persist_path=tmp)
        dedup_store = ChromaVectorStore(persist_path=tmp)
        kb_store.upsert_chunk(
            chunk_id="source-1:doc.txt:0", embedding=[1.0, 0.0, 0.0], text="t", user_id="Project\\Area1",
            source_file="doc.txt", source_id="source-1", chunk_index=0, file_hash="hash-1",
        )
        # Dedup's store must see nothing from the KB collection — separate namespace.
        assert dedup_store.query_nearest([1.0, 0.0, 0.0], area_path="Project\\Area1") is None


def test_delete_file_chunks_removes_all_chunks_for_that_source_id_only() -> None:
    # source_id is the Graph drive-item identity -- unique per real file
    # (see ingest_service.py's call sites). Two genuinely distinct files use
    # distinct source_ids, so deleting one's chunks must not touch the other.
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.upsert_chunk(
            chunk_id="source-1:doc.txt:0", embedding=[1.0, 0.0, 0.0], text="t0", user_id="Project\\Area1",
            source_file="doc.txt", source_id="source-1", chunk_index=0, file_hash="hash-1",
        )
        store.upsert_chunk(
            chunk_id="source-2:other.txt:0", embedding=[0.0, 1.0, 0.0], text="t1", user_id="Project\\Area1",
            source_file="other.txt", source_id="source-2", chunk_index=0, file_hash="hash-2",
        )
        store.delete_file_chunks("Project\\Area1", "doc.txt", "source-1")
        assert store.existing_file_hash("Project\\Area1", "doc.txt", "source-1") is None
        assert store.existing_file_hash("Project\\Area1", "other.txt", "source-2") == "hash-2"


def test_existing_file_hash_matches_by_source_id_even_when_source_file_differs() -> None:
    # Regression for the confirmed SharePoint rename bug: source_id (the
    # stable Graph drive-item id) is what identifies "the same file" --
    # matching also on source_file caused a pure rename to look brand-new.
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.upsert_chunk(
            chunk_id="source-1:old.docx:0", embedding=[1.0, 0.0, 0.0], text="t", user_id="Project\\Area1",
            source_file="old.docx", source_id="source-1", chunk_index=0, file_hash="hash-1",
        )
        assert store.existing_file_hash("Project\\Area1", "new.docx", "source-1") == "hash-1"


def test_delete_file_chunks_removes_the_old_named_chunks_on_a_rename() -> None:
    # Regression: previously filtering delete_file_chunks by
    # (source_file, source_id) meant a renamed file's re-ingest deleted
    # nothing (old chunks are stored under the old name), leaving both
    # old-named and new-named chunks as permanent duplicates.
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.upsert_chunk(
            chunk_id="source-1:old.docx:0", embedding=[1.0, 0.0, 0.0], text="t", user_id="Project\\Area1",
            source_file="old.docx", source_id="source-1", chunk_index=0, file_hash="hash-1",
        )
        store.delete_file_chunks("Project\\Area1", "new.docx", "source-1")
        assert store.existing_file_hash("Project\\Area1", "old.docx", "source-1") is None
        assert store.list_documents("Project\\Area1") == []


def test_rename_file_updates_stored_source_file_for_every_chunk() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.upsert_chunk(
            chunk_id="source-1:old.docx:0", embedding=[1.0, 0.0, 0.0], text="first", user_id="Project\\Area1",
            source_file="old.docx", source_id="source-1", chunk_index=0, file_hash="hash-1",
        )
        store.upsert_chunk(
            chunk_id="source-1:old.docx:1", embedding=[0.0, 1.0, 0.0], text="second", user_id="Project\\Area1",
            source_file="old.docx", source_id="source-1", chunk_index=1, file_hash="hash-1",
        )
        store.rename_file("Project\\Area1", "source-1", "new.docx")
        assert store.list_documents("Project\\Area1") == ["new.docx"]
        assert store.get_document("Project\\Area1", "old.docx") == (None, False)
        assert store.get_document("Project\\Area1", "new.docx") == ("first\n\nsecond", False)


def test_rename_file_is_a_noop_when_the_name_is_already_current() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.upsert_chunk(
            chunk_id="source-1:doc.docx:0", embedding=[1.0, 0.0, 0.0], text="t", user_id="Project\\Area1",
            source_file="doc.docx", source_id="source-1", chunk_index=0, file_hash="hash-1",
        )
        store.rename_file("Project\\Area1", "source-1", "doc.docx")  # must not raise or corrupt
        assert store.list_documents("Project\\Area1") == ["doc.docx"]


def test_rename_file_is_a_noop_when_never_ingested() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.rename_file("Project\\Area1", "never-ingested-source", "doc.docx")  # must not raise
        assert store.list_documents("Project\\Area1") == []


def test_two_sources_sharing_an_area_path_do_not_clobber_same_named_files() -> None:
    """Regression test for the file-identity collision: nothing enforces
    user_id uniqueness across KbSource rows, so two different sources can
    target the same user_id. Before source_id was part of chunk identity,
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
            user_id="Shared\\Area",
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
            user_id="Shared\\Area",
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
            user_id="Project\\Area1", source_file="doc.txt", source_id="source-1",
            chunk_index=0, file_hash="hash-1",
        )
        store.upsert_chunk(
            chunk_id="source-1:doc.txt:1", embedding=[0.0, 1.0, 0.0], text="far chunk",
            user_id="Project\\Area1", source_file="doc.txt", source_id="source-1",
            chunk_index=1, file_hash="hash-1",
        )
        results = store.query("Project\\Area1", embedding=[1.0, 0.0, 0.0], top_k=5)
        assert len(results) == 2
        assert results[0]["text"] == "near chunk"
        assert results[0]["source_file"] == "doc.txt"
        assert results[0]["distance"] < results[1]["distance"]


def test_get_document_returns_none_for_a_never_ingested_file() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        assert store.get_document("Project\\Area1", "doc.txt") == (None, False)


def test_get_document_reassembles_chunks_in_chunk_index_order() -> None:
    # §15: read_kb_document needs the FULL document, not top-k snippets --
    # upsert chunks out of order to prove reassembly sorts by chunk_index,
    # not insertion order.
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.upsert_chunk(
            chunk_id="source-1:spec.docx:1", embedding=[0.0, 1.0, 0.0], text="second part",
            user_id="Project\\Area1", source_file="spec.docx", source_id="source-1",
            chunk_index=1, file_hash="hash-1",
        )
        store.upsert_chunk(
            chunk_id="source-1:spec.docx:0", embedding=[1.0, 0.0, 0.0], text="first part",
            user_id="Project\\Area1", source_file="spec.docx", source_id="source-1",
            chunk_index=0, file_hash="hash-1",
        )
        assert store.get_document("Project\\Area1", "spec.docx") == ("first part\n\nsecond part", False)


def test_get_document_only_returns_chunks_for_the_requested_source_file() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.upsert_chunk(
            chunk_id="source-1:spec.docx:0", embedding=[1.0, 0.0, 0.0], text="spec content",
            user_id="Project\\Area1", source_file="spec.docx", source_id="source-1",
            chunk_index=0, file_hash="hash-1",
        )
        store.upsert_chunk(
            chunk_id="source-1:other.docx:0", embedding=[0.0, 1.0, 0.0], text="other content",
            user_id="Project\\Area1", source_file="other.docx", source_id="source-1",
            chunk_index=0, file_hash="hash-2",
        )
        assert store.get_document("Project\\Area1", "spec.docx") == ("spec content", False)


def test_list_documents_returns_empty_list_for_a_never_ingested_area_path() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        assert store.list_documents("Project\\Area1") == []


def test_list_documents_returns_distinct_sorted_source_files() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.upsert_chunk(
            chunk_id="source-1:b.docx:0", embedding=[1.0, 0.0, 0.0], text="t", user_id="Project\\Area1",
            source_file="b.docx", source_id="source-1", chunk_index=0, file_hash="hash-1",
        )
        store.upsert_chunk(
            chunk_id="source-1:a.docx:0", embedding=[0.0, 1.0, 0.0], text="t", user_id="Project\\Area1",
            source_file="a.docx", source_id="source-1", chunk_index=0, file_hash="hash-2",
        )
        store.upsert_chunk(
            chunk_id="source-1:a.docx:1", embedding=[0.0, 0.0, 1.0], text="t2", user_id="Project\\Area1",
            source_file="a.docx", source_id="source-1", chunk_index=1, file_hash="hash-2",
        )
        assert store.list_documents("Project\\Area1") == ["a.docx", "b.docx"]


def test_query_respects_top_k() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        for i in range(3):
            store.upsert_chunk(
                chunk_id=f"source-1:doc.txt:{i}", embedding=[1.0, float(i), 0.0], text=f"chunk {i}",
                user_id="Project\\Area1", source_file="doc.txt", source_id="source-1",
                chunk_index=i, file_hash="hash-1",
            )
        results = store.query("Project\\Area1", embedding=[1.0, 0.0, 0.0], top_k=2)
        assert len(results) == 2


def test_get_document_pages_past_a_single_get_page(monkeypatch) -> None:
    # Constants patched small so the test doesn't need thousands of real
    # upserts to exercise the paging loop.
    import app.kb.kb_vector_store as kb_vector_store_module

    monkeypatch.setattr(kb_vector_store_module, "_GET_PAGE_SIZE", 3)
    monkeypatch.setattr(kb_vector_store_module, "_MAX_DOCUMENT_CHUNKS", 100)
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        chunk_count = 7  # more than one page (3) but under the cap (100)
        for i in reversed(range(chunk_count)):
            store.upsert_chunk(
                chunk_id=f"source-1:doc.txt:{i}", embedding=[float(i), 0.0, 0.0],
                text=f"chunk {i}", user_id="Project\\Area1", source_file="doc.txt",
                source_id="source-1", chunk_index=i, file_hash="hash-1",
            )
        text, truncated = store.get_document("Project\\Area1", "doc.txt")
        assert text == "\n\n".join(f"chunk {i}" for i in range(chunk_count))
        assert truncated is False


def test_get_document_stops_at_the_chunk_ceiling_and_reports_truncation(monkeypatch) -> None:
    import app.kb.kb_vector_store as kb_vector_store_module

    monkeypatch.setattr(kb_vector_store_module, "_GET_PAGE_SIZE", 3)
    monkeypatch.setattr(kb_vector_store_module, "_MAX_DOCUMENT_CHUNKS", 5)
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        chunk_count = 8  # more than the cap (5)
        for i in range(chunk_count):
            store.upsert_chunk(
                chunk_id=f"source-1:doc.txt:{i}", embedding=[float(i), 0.0, 0.0],
                text=f"chunk {i}", user_id="Project\\Area1", source_file="doc.txt",
                source_id="source-1", chunk_index=i, file_hash="hash-1",
            )
        text, truncated = store.get_document("Project\\Area1", "doc.txt")
        assert truncated is True
        # First 5 chunks by chunk_index, not an arbitrary subset.
        assert text == "\n\n".join(f"chunk {i}" for i in range(5))


def test_list_documents_pages_past_a_single_get_page(monkeypatch) -> None:
    import app.kb.kb_vector_store as kb_vector_store_module

    monkeypatch.setattr(kb_vector_store_module, "_GET_PAGE_SIZE", 2)
    monkeypatch.setattr(kb_vector_store_module, "_MAX_LISTED_DOCUMENTS", 100)
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        filenames = [f"doc{i}.txt" for i in range(5)]  # more than one page (2)
        for i, name in enumerate(filenames):
            store.upsert_chunk(
                chunk_id=f"source-1:{name}:0", embedding=[float(i), 0.0, 0.0],
                text="content", user_id="Project\\Area1", source_file=name,
                source_id="source-1", chunk_index=0, file_hash="hash-1",
            )
        assert store.list_documents("Project\\Area1") == sorted(filenames)


def test_list_always_include_documents_returns_empty_list_when_none_are_tagged() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.upsert_chunk(
            chunk_id="source-1:doc.txt:0", embedding=[1.0, 0.0, 0.0], text="t", user_id="Project\\Area1",
            source_file="doc.txt", source_id="source-1", chunk_index=0, file_hash="hash-1",
        )
        assert store.list_always_include_documents("Project\\Area1") == []


def test_list_always_include_documents_returns_only_tagged_files() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.upsert_chunk(
            chunk_id="source-1:standards.docx:0", embedding=[1.0, 0.0, 0.0], text="t", user_id="Project\\Area1",
            source_file="standards.docx", source_id="source-1", chunk_index=0, file_hash="hash-1",
            retrieval_mode="always_include",
        )
        store.upsert_chunk(
            chunk_id="source-1:spec.docx:0", embedding=[0.0, 1.0, 0.0], text="t", user_id="Project\\Area1",
            source_file="spec.docx", source_id="source-1", chunk_index=0, file_hash="hash-2",
        )
        assert store.list_always_include_documents("Project\\Area1") == ["standards.docx"]


def test_upsert_chunk_default_retrieval_mode_is_not_stored_as_always_include() -> None:
    # retrieval_mode omitted (the common case) must behave byte-identically
    # to before this field existed -- never accidentally tagged.
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.upsert_chunk(
            chunk_id="source-1:doc.txt:0", embedding=[1.0, 0.0, 0.0], text="t", user_id="Project\\Area1",
            source_file="doc.txt", source_id="source-1", chunk_index=0, file_hash="hash-1",
            retrieval_mode="retrieve",
        )
        assert store.list_always_include_documents("Project\\Area1") == []


def test_purge_user_drops_the_collection() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.upsert_chunk(
            chunk_id="source-1:doc.txt:0", embedding=[1.0, 0.0, 0.0], text="t", user_id="user-old",
            source_file="doc.txt", source_id="source-1", chunk_index=0, file_hash="hash-1",
        )
        store.purge_user("user-old")
        assert store.list_documents("user-old") == []
        assert store.query("user-old", embedding=[1.0, 0.0, 0.0], top_k=5) == []


def test_purge_user_is_idempotent_when_never_ingested() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.purge_user("never-ingested-user")  # must not raise


def test_purge_user_does_not_affect_other_users() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.upsert_chunk(
            chunk_id="source-1:doc.txt:0", embedding=[1.0, 0.0, 0.0], text="t", user_id="user-a",
            source_file="doc.txt", source_id="source-1", chunk_index=0, file_hash="hash-1",
        )
        store.upsert_chunk(
            chunk_id="source-1:doc.txt:0", embedding=[1.0, 0.0, 0.0], text="t", user_id="user-b",
            source_file="doc.txt", source_id="source-1", chunk_index=0, file_hash="hash-1",
        )
        store.purge_user("user-a")
        assert store.list_documents("user-a") == []
        assert store.list_documents("user-b") == ["doc.txt"]


def test_list_documents_stops_at_the_document_ceiling(monkeypatch) -> None:
    import app.kb.kb_vector_store as kb_vector_store_module

    monkeypatch.setattr(kb_vector_store_module, "_GET_PAGE_SIZE", 2)
    monkeypatch.setattr(kb_vector_store_module, "_MAX_LISTED_DOCUMENTS", 3)
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        filenames = [f"doc{i}.txt" for i in range(5)]  # more than the cap (3)
        for i, name in enumerate(filenames):
            store.upsert_chunk(
                chunk_id=f"source-1:{name}:0", embedding=[float(i), 0.0, 0.0],
                text="content", user_id="Project\\Area1", source_file=name,
                source_id="source-1", chunk_index=0, file_hash="hash-1",
            )
        result = store.list_documents("Project\\Area1")
        assert len(result) == 3
