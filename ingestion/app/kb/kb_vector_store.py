from __future__ import annotations

import hashlib
import json

import chromadb


# Bounds for get_document/list_documents -- both previously called
# collection.get() with no limit at all. Confirmed real risk, not just a
# perf nit: both results are returned to an LLM agentic tool call
# (orchestrator_llm_client._execute_agentic_tool_call's list_kb_documents/
# read_kb_document branches) -- a KB with many ingested files, or one large
# document, could produce a single tool result exceeding the model's
# context window, silently truncating (or erroring) mid-sentence during a
# SURVEY analysis loop.
_GET_PAGE_SIZE = 500
_MAX_DOCUMENT_CHUNKS = 2000
_MAX_LISTED_DOCUMENTS = 5000


def _kb_collection_name_for_user(user_id: str) -> str:
    # Separate namespace from dedup's `req2ado_<hash>` collections (see
    # dedup/vector_store.py) — KB chunks store real source text and are a
    # different concern from dedup's embeddings-only vectors. Keeping them
    # in different collections means neither can leak into the other's
    # queries.
    digest = hashlib.sha256(user_id.encode()).hexdigest()[:32]
    return f"req2ado_kb_{digest}"


class KbVectorStore:
    """User-scoped knowledge-base store: unlike ChromaVectorStore
    (dedup, embeddings-only), this stores chunk source text + metadata
    alongside each embedding — P2b's retrieval needs the actual text to
    inject into LLM prompts, not just a similarity score."""

    def __init__(
        self,
        persist_path: str,
        mode: str = "embedded",
        host: str = "localhost",
        port: int = 8000,
    ) -> None:
        # Same embedded-vs-http choice as dedup/vector_store.py's
        # ChromaVectorStore -- "http" points at the same shared Chroma
        # server (CHROMA_MODE=http), keeping KB chunks stateless/horizontally
        # scalable alongside dedup's embeddings, not a separate local-only
        # store that would break under multiple ingestion replicas.
        if mode == "http":
            self._client = chromadb.HttpClient(host=host, port=port)
        else:
            self._client = chromadb.PersistentClient(path=persist_path)
        # Perf fix ported from dedup/vector_store.py's ChromaVectorStore
        # (2026-08-01): get_or_create_collection is a Chroma round trip:
        # the collection handle itself never goes stale (a client-side
        # reference, not a snapshot of contents), so caching it per user
        # is safe with no invalidation needed at all.
        self._collection_cache: dict[str, chromadb.Collection] = {}

    def ping(self) -> bool:
        """Cheap reachability check for /ready -- ported from dedup/
        vector_store.py's ChromaVectorStore.ping(), which existed only for
        the dedup store; an outage of THIS store (the one every SURVEY
        job's KB grounding actually depends on) previously had no
        healthcheck at all, silently indistinguishable from "no KB
        attached". heartbeat() is Chroma's own lightweight liveness call."""
        try:
            self._client.heartbeat()
            return True
        except Exception:
            return False

    def _get_collection(self, user_id: str):
        cached = self._collection_cache.get(user_id)
        if cached is not None:
            return cached
        collection = self._client.get_or_create_collection(
            name=_kb_collection_name_for_user(user_id),
            metadata={"hnsw:space": "cosine"},
        )
        self._collection_cache[user_id] = collection
        return collection

    def upsert_chunk(
        self,
        chunk_id: str,
        embedding: list[float],
        text: str,
        user_id: str,
        source_file: str,
        source_id: str,
        chunk_index: int,
        file_hash: str,
        doc_type: str | None = None,
        quality_checklist: list[str] | None = None,
        quality_checklist_definitions: dict[str, str] | None = None,
        retrieval_mode: str | None = None,
    ) -> None:
        collection = self._get_collection(user_id)
        metadata = {
            "source_file": source_file,
            "source_id": source_id,
            "chunk_index": chunk_index,
            "file_hash": file_hash,
        }
        # chromadb rejects None metadata values, so only include doc_type
        # when the caller actually supplied one (existing callers that don't
        # pass doc_type keep working unchanged).
        if doc_type is not None:
            metadata["doc_type"] = doc_type
        # `retrieval_mode` mirrors Open WebUI's own Knowledge feature: a file
        # is either similarity-gated ("retrieve", the default -- not stored,
        # same optional-metadata convention as doc_type above) or always
        # injected in full ("always_include", see
        # retrieval.fetch_always_include_context) -- right for small,
        # static reference material (a CMMI/requirements-writing-standards
        # doc) whose relevance is definitional, not topical, so a
        # similarity score can never legitimately gate it.
        if retrieval_mode is not None and retrieval_mode != "retrieve":
            metadata["retrieval_mode"] = retrieval_mode
        # Confirmed real determinism gap (user-reported): asking the scoring
        # LLM to "derive" quality-checklist category names live, per scoring
        # call, is not a hard cross-run guarantee even at temperature=0 --
        # the SAME document run 4 times must yield the SAME categories.
        # Extracted ONCE at ingestion time (see checklist_extraction.py) and
        # stored here, on every chunk (cheap: a short JSON string, avoids any
        # "which chunk is chunk 0" edge case for lookup) -- every later
        # scoring call reads this stored value instead of ever re-deriving
        # it, making the category set a genuine property of the ingested
        # document, not of any one job run. `[]` (checked, not falsy-checked)
        # means "extraction ran and found no checklist", stored explicitly
        # so it's distinguishable from "extraction never ran" (None, older
        # chunks ingested before this existed).
        if quality_checklist is not None:
            metadata["quality_checklist_json"] = json.dumps(quality_checklist)
        # Companion to quality_checklist above, from the SAME ingestion-time
        # extraction pass (see OrchestratorLlmClient.
        # extract_quality_checklist_definitions's own docstring) -- name ->
        # stated-definition text for whichever of quality_checklist's
        # category names the document actually explains, not just names.
        # Stored (and looked up) separately rather than folded into
        # quality_checklist_json itself so every EXISTING reader of that
        # key (get_quality_checklist's plain list[str] contract, replayed
        # verbatim as categoryScores keys) stays byte-identical. `None`
        # (extraction skipped, failed, or found no checklist to attach
        # definitions to at all) omits the key entirely, same convention as
        # quality_checklist_json's own `is not None` check above.
        if quality_checklist_definitions is not None:
            metadata["quality_checklist_definitions_json"] = json.dumps(quality_checklist_definitions)
        collection.upsert(
            ids=[chunk_id],
            embeddings=[embedding],
            documents=[text],
            metadatas=[metadata],
        )

    def existing_file_hash(self, user_id: str, source_file: str, source_id: str) -> str | None:
        """Returns the stored file_hash for any existing chunk of this
        source_id, or None if the file has never been ingested by this
        source. Used for hash-based skip-unchanged: if this matches the
        freshly-computed hash, the caller skips re-parsing/re-embedding the
        file.

        Matches by source_id ALONE, not source_file -- source_id is the
        stable Graph drive-item identity (survives SharePoint renames/
        same-drive moves), so a pure rename must still be recognized as the
        same file. Confirmed real bug (fixed here): the previous compound
        (source_file, source_id) match required the filename to ALSO match,
        so a rename alone (same source_id, new name) looked like a
        brand-new file -- see rename_file below for how a rename's stored
        metadata gets brought current without a full re-embed. `source_file`
        is accepted but intentionally unused for filtering -- kept so this
        method's call sites don't need to change."""
        collection = self._get_collection(user_id)
        result = collection.get(where={"source_id": source_id}, limit=1)
        metadatas = result.get("metadatas") or []
        if not metadatas:
            return None
        return metadatas[0].get("file_hash")

    def delete_file_chunks(self, user_id: str, source_file: str, source_id: str) -> None:
        """Deletes all previously-stored chunks for this source_id before
        re-ingesting a changed file, so stale chunks (e.g. from a
        since-removed section) don't linger alongside the new ones.

        Matches by source_id ALONE, not source_file -- same fix as
        existing_file_hash above: a renamed file's OLD chunks are stored
        under the old source_file value, so filtering on the new name would
        miss them entirely and leave them as permanent duplicates alongside
        the freshly-ingested new-named chunks. `source_file` is accepted but
        intentionally unused for filtering -- kept so this method's call
        sites don't need to change."""
        collection = self._get_collection(user_id)
        collection.delete(where={"source_id": source_id})

    def rename_file(self, user_id: str, source_id: str, source_file: str) -> None:
        """Brings a renamed/moved file's stored source_file metadata current
        on every one of its existing chunks, without re-parsing/re-embedding
        -- the counterpart fix for the skip-unchanged path (content hash
        matches, so _store_document never reaches delete_file_chunks/
        upsert_chunk at all). Cheap no-op check first: only pays for the
        full-collection rewrite when the name has actually changed. No-op
        (not an error) if source_id was never ingested."""
        collection = self._get_collection(user_id)
        probe = collection.get(where={"source_id": source_id}, limit=1, include=["metadatas"])
        probe_metadatas = probe.get("metadatas") or []
        if not probe_metadatas:
            return  # never ingested -- nothing to rename
        if probe_metadatas[0].get("source_file") == source_file:
            return  # already current -- common case, avoid the full rewrite below

        ids: list[str] = []
        metadatas: list[dict] = []
        offset = 0
        while True:
            page = collection.get(
                where={"source_id": source_id}, limit=_GET_PAGE_SIZE, offset=offset, include=["metadatas"]
            )
            page_ids = page.get("ids") or []
            if not page_ids:
                break
            ids.extend(page_ids)
            metadatas.extend(page.get("metadatas") or [])
            if len(page_ids) < _GET_PAGE_SIZE:
                break  # real last page
            offset += _GET_PAGE_SIZE
        collection.update(ids=ids, metadatas=[{**m, "source_file": source_file} for m in metadatas])

    def purge_user(self, user_id: str) -> None:
        """Irreversibly drops this user_id's entire KB collection -- the
        admin/CLI remediation for a deleted-and-recreated ADO account whose
        new session resolves to the same descriptor-derived user_id as the
        old one (see docs/runbook.md). Never called from any ingest/query/
        delete flow -- deliberately not wired into anything automatic.
        Idempotent: purging a user_id with no collection yet is a no-op,
        matching every other method here that treats "no such user" as an
        empty result rather than an error."""
        try:
            self._client.delete_collection(name=_kb_collection_name_for_user(user_id))
        except chromadb.errors.NotFoundError:
            pass
        # The cached handle (if any) now points at a deleted collection --
        # unlike dedup's ChromaVectorStore, this store can drop a whole
        # collection, not just individual items, so the collection-handle
        # cache needs this one invalidation dedup's own cache never does.
        self._collection_cache.pop(user_id, None)

    def get_document(self, user_id: str, source_file: str) -> tuple[str | None, bool]:
        """Reassembles ONE previously-ingested document's FULL text by
        concatenating its stored chunks in chunk_index order -- for the §15
        read_kb_document agentic tool, which needs a whole document (e.g. a
        referenced ICD only mentioned by name), not just top-k similarity
        snippets (see query() above / app.kb.retrieval.retrieve_context).
        Returns (None, False) when no chunk exists for this source_file,
        mirroring query()'s empty-result convention -- an enhancement,
        never a hard dependency.

        Paginated (page size _GET_PAGE_SIZE) rather than one unbounded
        collection.get() -- stops once either the real last page is reached
        or more than _MAX_DOCUMENT_CHUNKS chunks have been seen (proof
        enough that truncation is needed, without fetching a
        possibly-much-larger remainder just to throw it away). Returns
        (text, True) when the document was too large and had to be capped
        -- the caller (llm_leveling.py's read_document_fn) surfaces this to
        the model instead of silently handing back a partial document."""
        collection = self._get_collection(user_id)
        pairs: list[tuple[dict, str]] = []
        offset = 0
        while True:
            page = collection.get(
                where={"source_file": source_file},
                limit=_GET_PAGE_SIZE,
                offset=offset,
                include=["documents", "metadatas"],
            )
            page_documents = page.get("documents") or []
            page_metadatas = page.get("metadatas") or []
            if not page_documents:
                break
            pairs.extend(zip(page_metadatas, page_documents))
            if len(page_documents) < _GET_PAGE_SIZE:
                break  # real last page
            if len(pairs) > _MAX_DOCUMENT_CHUNKS:
                break  # already proven truncated; stop paging the rest
            offset += _GET_PAGE_SIZE
        if not pairs:
            return None, False
        ordered = sorted(pairs, key=lambda pair: pair[0].get("chunk_index", 0))
        truncated = len(ordered) > _MAX_DOCUMENT_CHUNKS
        if truncated:
            ordered = ordered[:_MAX_DOCUMENT_CHUNKS]
        return "\n\n".join(text for _, text in ordered), truncated

    def get_quality_checklist(self, user_id: str, source_file: str) -> list[str] | None:
        """Returns the quality-checklist category names extracted ONCE for
        this document at ingestion time (see checklist_extraction.py),
        stored identically on every one of its chunks. `None` means
        extraction never ran for this document (ingested before this
        existed, or extraction itself failed) -- the caller's own fallback
        applies. `[]` means extraction ran and genuinely found no checklist
        in the document -- also falls back, but is a distinct, deliberate
        signal from "never ran"."""
        collection = self._get_collection(user_id)
        result = collection.get(where={"source_file": source_file}, limit=1)
        metadatas = result.get("metadatas") or []
        if not metadatas:
            return None
        raw = metadatas[0].get("quality_checklist_json")
        if raw is None:
            return None
        return json.loads(raw)

    def get_quality_checklist_definitions(self, user_id: str, source_file: str) -> dict[str, str] | None:
        """Companion to get_quality_checklist above -- name -> stated-
        definition text for whichever of THAT method's category names the
        document actually explains (see OrchestratorLlmClient.
        extract_quality_checklist_definitions's own docstring). `None`
        means this extraction pass never ran (skipped -- e.g. the first
        pass found no checklist to attach definitions to -- or failed) for
        this document; `{}` means it ran and genuinely found no stated
        definition for any category. Both are a "nothing to show" signal to
        the caller (app.leveling.scoring._match_category_checklist), kept
        distinct only for the same debuggability reason get_quality_
        checklist's own None/[] distinction is."""
        collection = self._get_collection(user_id)
        result = collection.get(where={"source_file": source_file}, limit=1)
        metadatas = result.get("metadatas") or []
        if not metadatas:
            return None
        raw = metadatas[0].get("quality_checklist_definitions_json")
        if raw is None:
            return None
        return json.loads(raw)

    def list_documents(self, user_id: str) -> list[str]:
        """Distinct source_file names ingested into this user_id's KB
        collection -- for the §15 list_kb_documents agentic tool, so the
        model can discover what full documents are available before picking
        one for read_kb_document rather than guessing a name blind.

        Paginated with an explicit metadatas-only projection (no reason to
        ship chunk TEXT across the wire just to read one metadata key per
        chunk) -- previously one unbounded collection.get() with no
        projection at all, materializing every chunk's full source text of
        the user's ENTIRE KB just to build this list. Stops once either the
        real last page is reached or _MAX_LISTED_DOCUMENTS distinct names
        have been collected."""
        collection = self._get_collection(user_id)
        if collection.count() == 0:
            return []
        names: set[str] = set()
        offset = 0
        while True:
            page = collection.get(limit=_GET_PAGE_SIZE, offset=offset, include=["metadatas"])
            page_metadatas = page.get("metadatas") or []
            if not page_metadatas:
                break
            names.update(m["source_file"] for m in page_metadatas if "source_file" in m)
            if len(page_metadatas) < _GET_PAGE_SIZE:
                break  # real last page
            if len(names) >= _MAX_LISTED_DOCUMENTS:
                break
            offset += _GET_PAGE_SIZE
        return sorted(names)[:_MAX_LISTED_DOCUMENTS]

    def list_always_include_documents(self, user_id: str) -> list[str]:
        """Distinct source_file names tagged retrieval_mode="always_include"
        at upload time -- for fetch_always_include_context (app.kb.
        retrieval), the Full-Context-mode counterpart to list_documents/
        retrieve_context's similarity-gated path. Filters server-side via
        chromadb's `where` (not a client-side scan of list_documents'
        output) since most documents are the "retrieve" default and would
        otherwise be fetched and discarded for nothing. Same pagination/cap
        convention as list_documents -- see its own docstring."""
        collection = self._get_collection(user_id)
        if collection.count() == 0:
            return []
        names: set[str] = set()
        offset = 0
        while True:
            page = collection.get(
                where={"retrieval_mode": "always_include"},
                limit=_GET_PAGE_SIZE,
                offset=offset,
                include=["metadatas"],
            )
            page_metadatas = page.get("metadatas") or []
            if not page_metadatas:
                break
            names.update(m["source_file"] for m in page_metadatas if "source_file" in m)
            if len(page_metadatas) < _GET_PAGE_SIZE:
                break  # real last page
            if len(names) >= _MAX_LISTED_DOCUMENTS:
                break
            offset += _GET_PAGE_SIZE
        return sorted(names)[:_MAX_LISTED_DOCUMENTS]

    def query(self, user_id: str, embedding: list[float], top_k: int) -> list[dict]:
        """Returns up to top_k nearest chunks for this user_id's KB
        collection, ordered nearest-first, each as {text, distance,
        source_file}. distance is chromadb's cosine distance (lower =
        closer) — callers apply their own similarity cutoff. Empty list
        if the collection has no chunks (mirrors ChromaVectorStore.
        query_nearest's empty-collection guard)."""
        collection = self._get_collection(user_id)
        if collection.count() == 0:
            return []
        result = collection.query(query_embeddings=[embedding], n_results=top_k)
        documents = result["documents"][0]
        distances = result["distances"][0]
        metadatas = result["metadatas"][0]
        return [
            {"text": documents[i], "distance": distances[i], "source_file": metadatas[i]["source_file"]}
            for i in range(len(documents))
        ]
