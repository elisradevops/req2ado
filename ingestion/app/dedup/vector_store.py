from __future__ import annotations

import hashlib

import chromadb


def _collection_name_for_area_path(area_path: str) -> str:
    # Chroma collection names have character-set/length restrictions; area
    # paths can contain backslashes and arbitrary length, so this hashes to
    # a safe, fixed-length, collision-resistant identifier rather than
    # attempting to sanitize the raw area path string.
    digest = hashlib.sha256(area_path.encode()).hexdigest()[:32]
    return f"req2ado_{digest}"


class ChromaVectorStore:
    """Local, persistent, Area-Path-scoped vector store for dedup (Phase 6).
    One Chroma collection per area path — structurally isolates similarity
    matches to the same area path rather than relying on a post-query
    filter, so cross-area-path false positives are impossible by
    construction, not just filtered out. Uses cosine similarity (Chroma
    collection metadata hnsw:space=cosine); Chroma's cosine DISTANCE is
    1 - cosine_similarity, so similarity is derived as 1 - distance."""

    def __init__(self, persist_path: str) -> None:
        self._client = chromadb.PersistentClient(path=persist_path)

    def _get_collection(self, area_path: str):
        return self._client.get_or_create_collection(
            name=_collection_name_for_area_path(area_path),
            metadata={"hnsw:space": "cosine"},
        )

    def upsert(self, item_id: str, embedding: list[float], area_path: str) -> None:
        collection = self._get_collection(area_path)
        collection.upsert(ids=[item_id], embeddings=[embedding])

    def query_nearest(self, embedding: list[float], area_path: str) -> tuple[str, float] | None:
        collection = self._get_collection(area_path)
        if collection.count() == 0:
            return None
        result = collection.query(query_embeddings=[embedding], n_results=1)
        matched_id = result["ids"][0][0]
        distance = result["distances"][0][0]
        similarity = 1.0 - distance
        return matched_id, similarity
