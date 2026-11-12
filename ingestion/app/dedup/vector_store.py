from __future__ import annotations

import hashlib
import time
from typing import NamedTuple

import chromadb

from app.config import settings

# Read once at import, same convention as
# app/survey/orchestrator_llm_client.py's own
# `_LLM_REQUEST_TIMEOUT_SECONDS = settings.llm_request_timeout_seconds` --
# main.py does not thread this one through, because unlike chroma_mode/host/
# port there is no non-settings default worth expressing at the call site.
_DEFAULT_EMBED_MODEL = settings.embed_model


def _collection_name_for_area_path(area_path: str, embed_model: str) -> str:
    # Chroma collection names have character-set/length restrictions; area
    # paths can contain backslashes and arbitrary length, so this hashes to
    # a safe, fixed-length, collision-resistant identifier rather than
    # attempting to sanitize the raw area path string.
    #
    # `embed_model` is folded into the SAME digest, for the same reason, and
    # deliberately not appended as a readable suffix: real model names carry
    # Chroma-illegal characters (qwen3:4b's colon) and have no length bound.
    # Its presence here is the model-version pin -- vectors produced by a
    # different embed model land in a structurally different collection, so
    # swapping EMBED_MODEL can never silently compare a new query vector
    # against vectors some OTHER model produced (there is no per-vector
    # model tag, and /llm/embed's response carries no model identifier, so
    # nothing else in the system could detect that). The trade-off, accepted
    # explicitly: collections written before this pin existed are orphaned,
    # not migrated -- a wrong-model collection is unsafe to keep using
    # anyway, and the miss degrades to "behave like a first ingestion", not
    # to a wrong match. See docs/runbook.md for the re-backfill procedure.
    #
    # The NUL separator keeps the two fields unambiguous, so no
    # (model, area_path) pair can collide with a different pair purely by
    # concatenation.
    digest = hashlib.sha256(f"{embed_model}\x00{area_path}".encode()).hexdigest()[:32]
    return f"req2ado_{digest}"


def _registry_collection_name(embed_model: str) -> str:
    return f"req2ado_areapaths_{hashlib.sha256(embed_model.encode()).hexdigest()[:32]}"


def _normalized(area_path: str) -> str:
    # Azure DevOps area paths are not case sensitive, and a path may be typed with trailing separators.
    return area_path.strip().strip("\\").lower()


def _project_of(area_path: str) -> str:
    return _normalized(area_path).split("\\")[0]


# Stored with an item whose kind is not known (older entries): never equal to a real kind, so a check that matches by kind cannot
# skip on it, while a check that does not match by kind still sees it.
UNKNOWN_TYPE = "unknown"

# How long this process trusts its copy of "which area paths exist" before reading it again: another replica may have added one.
_REGISTRY_TTL_SECONDS = 30.0


class Match(NamedTuple):
    item_id: str
    similarity: float
    document: str | None
    # The area path the item is filed under (the original spelling).
    area_path: str


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
        embed_model: str = _DEFAULT_EMBED_MODEL,
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
        # Part of every collection name this store touches (see
        # _collection_name_for_area_path) -- the embed model-version pin.
        self._embed_model = embed_model
        # Which area paths hold items, so a search can cover an area path and the ones under it (or the whole project) without
        # guessing collection names. normalized path -> the path as it was written.
        self._area_paths: dict[str, str] = {}
        self._area_paths_loaded_at: float | None = None

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
            name=_collection_name_for_area_path(area_path, self._embed_model),
            metadata={"hnsw:space": "cosine"},
        )
        self._collection_cache[area_path] = collection
        return collection

    def upsert(
        self,
        item_id: str,
        embedding: list[float],
        area_path: str,
        document: str | None = None,
        type_category: str | None = None,
    ) -> None:
        # `document` (optional) stores the item's original text alongside its
        # embedding -- needed by check_for_duplicates.py's numeric-literal
        # guard (X7), which must compare the actual matched text, not just
        # its embedding, to veto a false-positive dedup match caused solely
        # by a differing number (e.g. "at least 87%" vs "at least 93%").
        # Omitted (None, the default) preserves the original embeddings-only
        # behavior exactly -- an older/pre-migration item upserted before
        # this option existed has no stored text, and query_nearest reports
        # that honestly as `matched_document=None` rather than guessing.
        # `type_category` (Epic / Feature / Requirement) is stored with the item so a check can compare like with like.
        collection = self._get_collection(area_path)
        collection.upsert(
            ids=[item_id],
            embeddings=[embedding],
            documents=[document] if document else None,
            metadatas=[{"type_category": type_category or UNKNOWN_TYPE}],
        )
        self._register_area_path(area_path)
        self._count_cache.pop(area_path, None)

    def upsert_many(
        self,
        items: list[tuple[str, list[float], str | None]],
        area_path: str,
        type_categories: list[str | None] | None = None,
    ) -> None:
        """Batched upsert for N items sharing the same area_path -- one
        Chroma round trip instead of N. `items` is (item_id, embedding,
        document) triples, matching upsert()'s own optional-document
        semantics -- but (like Chroma's own API) requires the WHOLE
        documents list to be all-str or entirely omitted; there is no
        per-item mixed None/str support. The one real caller
        (/dedup/upsert-batch) always has text for every item it upserts, so
        this is not a real limitation in practice. `type_categories`, when
        given, has one entry per item (None = not known)."""
        if not items:
            return
        collection = self._get_collection(area_path)
        ids = [item_id for item_id, _, _ in items]
        embeddings = [embedding for _, embedding, _ in items]
        documents = [document for _, _, document in items]
        kinds = type_categories if type_categories is not None else [None] * len(items)
        collection.upsert(
            ids=ids,
            embeddings=embeddings,
            documents=documents if all(documents) else None,
            metadatas=[{"type_category": kind or UNKNOWN_TYPE} for kind in kinds],
        )
        self._register_area_path(area_path)
        self._count_cache.pop(area_path, None)

    def delete(self, item_id: str, area_path: str) -> None:
        """Removes one item from an area path's dedup corpus. Real gap
        this closes: a 'reuse' (exact-hash) stale match already got
        cleaned up on downgrade via IdempotencyMapping deletion, but a
        'dedup_skip' (similarity) match had no equivalent -- the stale
        Chroma entry stayed forever, so a since-deleted-in-ADO item kept
        surfacing as a dedup match on every future job against the same
        area path. Idempotent: deleting an id Chroma doesn't have is a
        no-op, not an error."""
        collection = self._get_collection(area_path)
        collection.delete(ids=[item_id])
        self._count_cache.pop(area_path, None)

    def query_nearest(
        self, embedding: list[float], area_path: str
    ) -> tuple[str, float, str | None] | None:
        collection = self._get_collection(area_path)
        count = self._count_cache.get(area_path)
        if count is None:
            count = collection.count()
            self._count_cache[area_path] = count
        if count == 0:
            return None
        result = collection.query(
            query_embeddings=[embedding], n_results=1, include=["distances", "documents"]
        )
        matched_id = result["ids"][0][0]
        distance = result["distances"][0][0]
        similarity = 1.0 - distance
        matched_document = result["documents"][0][0] if result.get("documents") else None
        return matched_id, similarity, matched_document

    # --- which area paths hold items ---------------------------------------------------------------------------------------------

    def _registry(self):
        return self._client.get_or_create_collection(name=_registry_collection_name(self._embed_model))

    def _register_area_path(self, area_path: str) -> None:
        key = _normalized(area_path)
        self._load_area_paths_if_stale()
        if key in self._area_paths:
            return
        self._registry().upsert(ids=[key], embeddings=[[1.0]], documents=[area_path.strip()])
        self._area_paths[key] = area_path.strip()

    def _load_area_paths_if_stale(self) -> None:
        now = time.monotonic()
        if self._area_paths_loaded_at is not None and now - self._area_paths_loaded_at < _REGISTRY_TTL_SECONDS:
            return
        stored = self._registry().get(include=["documents"])
        for key, original in zip(stored.get("ids") or [], stored.get("documents") or []):
            self._area_paths[key] = original or key
        self._area_paths_loaded_at = now

    def _area_paths_in_scope(self, area_path: str, scope: str) -> list[str]:
        """The area paths (as written) a search from `area_path` covers: that path and everything under it, or the whole project."""
        self._load_area_paths_if_stale()
        wanted = _normalized(area_path)
        project = _project_of(area_path)
        found: dict[str, str] = {wanted: area_path.strip()}  # the path itself is always searched, even if nothing was registered for it
        for key, original in self._area_paths.items():
            if scope == "project":
                if key.split("\\")[0] == project:
                    found[key] = original
            elif key == wanted or key.startswith(wanted + "\\"):
                found[key] = original
        return list(found.values())

    def _existing_collection(self, area_path: str):
        """The collection for an area path if there is one; never creates it (asking must not leave empty collections behind)."""
        cached = self._collection_cache.get(area_path)
        if cached is not None:
            return cached
        try:
            collection = self._client.get_collection(name=_collection_name_for_area_path(area_path, self._embed_model))
        except (chromadb.errors.NotFoundError, chromadb.errors.InvalidCollectionException):
            return None
        except (ValueError, chromadb.errors.InvalidArgumentError) as exc:
            # chromadb 0.6.x signals a missing collection with a bare ValueError (embedded) or InvalidArgumentError (http).
            if "does not exist" not in str(exc):
                raise
            return None
        self._collection_cache[area_path] = collection
        return collection

    def query_nearest_many(
        self,
        embedding: list[float],
        area_path: str,
        scope: str = "area_path",
        type_category: str | None = None,
        top_k: int = 5,
    ) -> list[Match]:
        """The `top_k` stored items most like `embedding`, best first, across every area path in scope.

        `scope` is "area_path" (the path and the areas under it) or "project" (every area of the same project). `type_category`,
        when given, limits the search to items of that kind: an entry with no recorded kind is never matched by kind."""
        where = {"type_category": type_category} if type_category else None
        matches: list[Match] = []
        for path in self._area_paths_in_scope(area_path, scope):
            collection = self._existing_collection(path)
            if collection is None:
                continue
            count = self._count_cache.get(path)
            if count is None:
                count = collection.count()
                self._count_cache[path] = count
            if count == 0:
                continue
            result = collection.query(
                query_embeddings=[embedding],
                n_results=min(top_k, count),
                where=where,
                include=["distances", "documents"],
            )
            ids = (result.get("ids") or [[]])[0]
            distances = (result.get("distances") or [[]])[0]
            documents = (result.get("documents") or [[]])[0] if result.get("documents") else [None] * len(ids)
            for item_id, distance, document in zip(ids, distances, documents):
                matches.append(Match(item_id, 1.0 - distance, document, path))
        matches.sort(key=lambda match: match.similarity, reverse=True)
        return matches[:top_k]
