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
    """Area-Path-scoped vector store for dedup (Phase 6). One Chroma
    collection per area path — structurally isolates similarity matches to
    the same area path rather than relying on a post-query filter, so
    cross-area-path false positives are impossible by construction, not
    just filtered out. Uses cosine similarity (Chroma collection metadata
    hnsw:space=cosine); Chroma's cosine DISTANCE is 1 - cosine_similarity,
    so similarity is derived as 1 - distance.

    Two backing modes:
    - "embedded" (default): a local chromadb.PersistentClient at
      `persist_path`. Does NOT survive horizontal scaling -- each ingestion
      replica gets an independent, incomplete corpus copy. This was the
      ONLY mode available before this option existed.
    - "http": chromadb.HttpClient against a real, shared Chroma server
      (`host`/`port`) -- makes ingestion genuinely stateless, safe to run
      as multiple replicas (the actual point of adding this mode: closes
      the "ingestion is stateful, contradicting its own docs" gap).
    `persist_path` is ignored in "http" mode (kept as a required
    positional param so no existing "embedded"-mode call site needs to
    change)."""

    def __init__(
        self,
        persist_path: str,
        mode: str = "embedded",
        host: str = "localhost",
        port: int = 8000,
    ) -> None:
        if mode == "http":
            self._client = chromadb.HttpClient(host=host, port=port)
        else:
            self._client = chromadb.PersistentClient(path=persist_path)

    def ping(self) -> bool:
        """Cheap reachability check for /ready -- previously nothing in
        ingestion ever verified Chroma is actually usable before reporting
        healthy. heartbeat() is Chroma's own lightweight liveness call."""
        try:
            self._client.heartbeat()
            return True
        except Exception:
            return False

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
