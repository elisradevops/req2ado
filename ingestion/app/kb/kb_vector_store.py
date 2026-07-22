from __future__ import annotations

import hashlib

import chromadb


def _kb_collection_name_for_area_path(area_path: str) -> str:
    # Separate namespace from dedup's `req2ado_<hash>` collections (see
    # dedup/vector_store.py) — KB chunks store real source text and are a
    # different concern from dedup's embeddings-only vectors. Keeping them
    # in different collections means neither can leak into the other's
    # queries.
    digest = hashlib.sha256(area_path.encode()).hexdigest()[:32]
    return f"req2ado_kb_{digest}"


class KbVectorStore:
    """Area-Path-scoped knowledge-base store: unlike ChromaVectorStore
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

    def _get_collection(self, area_path: str):
        return self._client.get_or_create_collection(
            name=_kb_collection_name_for_area_path(area_path),
            metadata={"hnsw:space": "cosine"},
        )

    def upsert_chunk(
        self,
        chunk_id: str,
        embedding: list[float],
        text: str,
        area_path: str,
        source_file: str,
        source_id: str,
        chunk_index: int,
        file_hash: str,
        doc_type: str | None = None,
    ) -> None:
        collection = self._get_collection(area_path)
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

    def existing_file_hash(self, area_path: str, source_file: str, source_id: str) -> str | None:
        """Returns the stored file_hash for any existing chunk of this
        source_file scoped to source_id, or None if the file has never been
        ingested by this source. Used for hash-based skip-unchanged: if this
        matches the freshly-computed hash, the caller skips
        re-parsing/re-embedding the file. Scoping by source_id (in addition
        to source_file) prevents two different KbSource rows that happen to
        share an area_path from clobbering each other's same-named files —
        nothing today enforces area_path uniqueness across KbSource rows."""
        collection = self._get_collection(area_path)
        result = collection.get(
            where={"$and": [{"source_file": source_file}, {"source_id": source_id}]}, limit=1
        )
        metadatas = result.get("metadatas") or []
        if not metadatas:
            return None
        return metadatas[0].get("file_hash")

    def delete_file_chunks(self, area_path: str, source_file: str, source_id: str) -> None:
        """Deletes all previously-stored chunks for this source_file (scoped
        to source_id) before re-ingesting a changed file, so stale chunks
        (e.g. from a since-removed section) don't linger alongside the new
        ones. Scoping by source_id prevents deleting another source's
        same-named file's chunks when two sources share an area_path."""
        collection = self._get_collection(area_path)
        collection.delete(where={"$and": [{"source_file": source_file}, {"source_id": source_id}]})

    def query(self, area_path: str, embedding: list[float], top_k: int) -> list[dict]:
        """Returns up to top_k nearest chunks for this area_path's KB
        collection, ordered nearest-first, each as {text, distance,
        source_file}. distance is chromadb's cosine distance (lower =
        closer) — callers apply their own similarity cutoff. Empty list
        if the collection has no chunks (mirrors ChromaVectorStore.
        query_nearest's empty-collection guard)."""
        collection = self._get_collection(area_path)
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
