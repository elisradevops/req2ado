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
        # Perf fix (2026-08-01): a real job's dedup-check burst calls
        # query_nearest once per candidate item (~543 in a real observed
        # run), every one against the SAME area path's collection --
        # get_or_create_collection is a Chroma round trip and was being
        # paid 543 times for an identical result. The collection handle
        # itself never goes stale (it's just a client-side reference, not
        # a snapshot of its contents), so caching it per area path is safe
        # with no invalidation needed at all.
        self._collection_cache: dict[str, chromadb.Collection] = {}
        # count(), unlike the collection handle, DOES reflect live content
        # -- cached separately and invalidated on any upsert to that same
        # area path, so a dedup-check burst that never upserts mid-burst
        # (the real, only, current call pattern) pays for count() once
        # instead of once per check.
        self._count_cache: dict[str, int] = {}

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
        cached = self._collection_cache.get(area_path)
        if cached is not None:
            return cached
        collection = self._client.get_or_create_collection(
            name=_collection_name_for_area_path(area_path),
            metadata={"hnsw:space": "cosine"},
        )
        self._collection_cache[area_path] = collection
        return collection

    def upsert(self, item_id: str, embedding: list[float], area_path: str, document: str | None = None) -> None:
        # `document` (optional) stores the item's original text alongside its
        # embedding -- needed by check_for_duplicates.py's numeric-literal
        # guard (X7), which must compare the actual matched text, not just
        # its embedding, to veto a false-positive dedup match caused solely
        # by a differing number (e.g. "at least 87%" vs "at least 93%").
        # Omitted (None, the default) preserves the original embeddings-only
        # behavior exactly -- an older/pre-migration item upserted before
        # this option existed has no stored text, and query_nearest reports
        # that honestly as `matched_document=None` rather than guessing.
        collection = self._get_collection(area_path)
        collection.upsert(ids=[item_id], embeddings=[embedding], documents=[document] if document else None)
        self._count_cache.pop(area_path, None)

    def upsert_many(self, items: list[tuple[str, list[float], str | None]], area_path: str) -> None:
        """Batched upsert for N items sharing the same area_path -- one
        Chroma round trip instead of N. `items` is (item_id, embedding,
        document) triples, matching upsert()'s own optional-document
        semantics -- but (like Chroma's own API) requires the WHOLE
        documents list to be all-str or entirely omitted; there is no
        per-item mixed None/str support. The one real caller
        (/dedup/upsert-batch) always has text for every item it upserts, so
        this is not a real limitation in practice."""
        if not items:
            return
        collection = self._get_collection(area_path)
        ids = [item_id for item_id, _, _ in items]
        embeddings = [embedding for _, embedding, _ in items]
        documents = [document for _, _, document in items]
        collection.upsert(ids=ids, embeddings=embeddings, documents=documents if all(documents) else None)
        self._count_cache.pop(area_path, None)

    def query_nearest(self, embedding: list[float], area_path: str) -> tuple[str, float, str | None] | None:
        collection = self._get_collection(area_path)
        count = self._count_cache.get(area_path)
        if count is None:
            count = collection.count()
            self._count_cache[area_path] = count
        if count == 0:
            return None
        result = collection.query(query_embeddings=[embedding], n_results=1, include=["distances", "documents"])
        matched_id = result["ids"][0][0]
        distance = result["distances"][0][0]
        similarity = 1.0 - distance
        matched_document = result["documents"][0][0] if result.get("documents") else None
        return matched_id, similarity, matched_document
