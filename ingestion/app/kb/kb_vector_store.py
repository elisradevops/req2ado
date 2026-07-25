from __future__ import annotations

import hashlib

import chromadb


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

    def _get_collection(self, user_id: str):
        return self._client.get_or_create_collection(
            name=_kb_collection_name_for_user(user_id),
            metadata={"hnsw:space": "cosine"},
        )

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
        collection.upsert(
            ids=[chunk_id],
            embeddings=[embedding],
            documents=[text],
            metadatas=[metadata],
        )

    def existing_file_hash(self, user_id: str, source_file: str, source_id: str) -> str | None:
        """Returns the stored file_hash for any existing chunk of this
        source_file scoped to source_id, or None if the file has never been
        ingested by this source. Used for hash-based skip-unchanged: if this
        matches the freshly-computed hash, the caller skips
        re-parsing/re-embedding the file. Scoping by source_id (in addition
        to source_file) prevents two different KbSource rows that happen to
        share a user_id from clobbering each other's same-named files —
        nothing today enforces user_id uniqueness across KbSource rows."""
        collection = self._get_collection(user_id)
        result = collection.get(
            where={"$and": [{"source_file": source_file}, {"source_id": source_id}]}, limit=1
        )
        metadatas = result.get("metadatas") or []
        if not metadatas:
            return None
        return metadatas[0].get("file_hash")

    def delete_file_chunks(self, user_id: str, source_file: str, source_id: str) -> None:
        """Deletes all previously-stored chunks for this source_file (scoped
        to source_id) before re-ingesting a changed file, so stale chunks
        (e.g. from a since-removed section) don't linger alongside the new
        ones. Scoping by source_id prevents deleting another source's
        same-named file's chunks when two sources share a user_id."""
        collection = self._get_collection(user_id)
        collection.delete(where={"$and": [{"source_file": source_file}, {"source_id": source_id}]})

    def get_document(self, user_id: str, source_file: str) -> str | None:
        """Reassembles ONE previously-ingested document's FULL text by
        concatenating its stored chunks in chunk_index order -- for the §15
        read_kb_document agentic tool, which needs a whole document (e.g. a
        referenced ICD only mentioned by name), not just top-k similarity
        snippets (see query() above / app.kb.retrieval.retrieve_context).
        Returns None when no chunk exists for this source_file, mirroring
        query()'s empty-result convention -- an enhancement, never a hard
        dependency."""
        collection = self._get_collection(user_id)
        result = collection.get(where={"source_file": source_file})
        documents = result.get("documents") or []
        if not documents:
            return None
        metadatas = result.get("metadatas") or []
        ordered = sorted(zip(metadatas, documents), key=lambda pair: pair[0].get("chunk_index", 0))
        return "\n\n".join(text for _, text in ordered)

    def list_documents(self, user_id: str) -> list[str]:
        """Distinct source_file names ingested into this user_id's KB
        collection -- for the §15 list_kb_documents agentic tool, so the
        model can discover what full documents are available before picking
        one for read_kb_document rather than guessing a name blind."""
        collection = self._get_collection(user_id)
        if collection.count() == 0:
            return []
        result = collection.get()
        metadatas = result.get("metadatas") or []
        return sorted({m["source_file"] for m in metadatas if "source_file" in m})

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
