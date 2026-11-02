from __future__ import annotations

import logging
from typing import Protocol

from app.kb.kb_vector_store import KbVectorStore

logger = logging.getLogger(__name__)

# retrieve_context asks the store for this many times top_k candidates, then
# picks top_k from them round-robin across source files. Without the
# over-fetch, one file with many near-duplicate chunks fills every slot and
# the other files are never cited.
_OVERFETCH_FACTOR = 4


class EmbedClient(Protocol):
    def embed(self, texts: list[str], user_id: str | None = None) -> list[list[float]]: ...


def retrieve_context(
    user_id: str,
    query_text: str,
    embed_client: EmbedClient,
    vector_store: KbVectorStore,
    top_k: int = 5,
    max_distance: float = 0.7,
) -> tuple[str | None, list[dict]]:
    """Embeds query_text, queries the KB collection for user_id (the
    Knowledge Base is scoped by the ingesting/submitting user's identity,
    NOT any ADO area path -- see KbVectorStore's own docstring), keeps
    hits with distance <= max_distance (cosine similarity >= 0.3), and
    joins their text with a blank-line separator. Over-fetches candidates
    and picks the top_k (nearest hit first, then round-robin across source files), so a file with
    many near-duplicate chunks cannot crowd every other file out. Returns
    (context, citations): context is None when the collection is empty, no
    hit clears the similarity bar, or the embed/query call itself raises
    (network failure, Chroma error) — KB retrieval is an enhancement, not a
    hard dependency, and must never fail or block a SURVEY job. citations is
    the deduped (best/lowest-distance hit per source_file, first-seen order)
    list of surviving hits as {source_file, distance, similarity} dicts --
    the raw retrieval score, surfaced so a caller/reviewer can judge
    relevance themselves rather than trusting a hidden binary threshold --
    always [] when context is None. Any exception is caught and logged
    here; this is the single seam that makes KB failure non-fatal for
    callers."""
    try:
        [embedding] = embed_client.embed([query_text], user_id=user_id)
        hits = vector_store.query(user_id, embedding, top_k * _OVERFETCH_FACTOR)
    except Exception as exc:  # noqa: BLE001 - retrieval must never fail a SURVEY job
        logger.warning("KB retrieval failed for user_id=%s: %s", user_id, exc)
        return None, []

    close_hits = [hit for hit in hits if hit["distance"] <= max_distance]
    survivors = _round_robin_by_source(close_hits, top_k)
    if not survivors:
        return None, []

    context = "\n\n".join(hit["text"] for hit in survivors)
    best_by_file: dict[str, dict] = {}
    order: list[str] = []
    for hit in survivors:
        source_file = hit["source_file"]
        if source_file not in best_by_file:
            order.append(source_file)
            best_by_file[source_file] = hit
        elif hit["distance"] < best_by_file[source_file]["distance"]:
            best_by_file[source_file] = hit
    citations = [
        {
            "source_file": source_file,
            "distance": best_by_file[source_file]["distance"],
            "similarity": 1 - best_by_file[source_file]["distance"],
            # Kept here (not on the eventual KbCitation model sent to the
            # orchestrator/frontend) so a caller can build relevance-
            # verification snippets without a second vector-store query.
            "text": best_by_file[source_file]["text"],
        }
        for source_file in order
    ]
    return context, citations


def _round_robin_by_source(hits: list[dict], limit: int) -> list[dict]:
    """Picks up to `limit` hits: the single nearest hit overall first (so the
    best match is never displaced), then round-robin over the source files
    (ordered by their nearest remaining hit, the best file included), taking
    each file's nearest unused hit per round, so weaker files still get a
    slot instead of the strongest file filling them all.
    `hits` must be nearest-first, as KbVectorStore.query returns them."""
    if limit <= 0 or not hits:
        return []
    picked: list[dict] = [hits[0]]
    by_file: dict[str, list[dict]] = {}
    for hit in hits[1:]:
        by_file.setdefault(hit["source_file"], []).append(hit)
    queues = list(by_file.values())
    while queues and len(picked) < limit:
        for queue in queues:
            if len(picked) >= limit:
                break
            picked.append(queue.pop(0))
        queues = [queue for queue in queues if queue]
    return picked


def fetch_always_include_context(user_id: str, vector_store: KbVectorStore) -> tuple[str | None, list[dict]]:
    """Full, unconditional text of every KB file tagged retrieval_mode=
    "always_include" at upload time -- the Full-Context-mode counterpart to
    retrieve_context's similarity-gated Focused-Retrieval path, modeled
    directly on Open WebUI's own Knowledge feature (which offers exactly
    these two per-file modes). Right for small, static reference material
    (a CMMI/requirements-writing-standards doc) whose relevance is
    definitional, not topical -- a similarity score can never legitimately
    gate it, and starving it out because it happens to share little
    vocabulary with the document being processed is the exact bug this
    closes (confirmed live: a standards doc scored a weak 39% similarity
    and nearly missed grounding scoring entirely).

    Returns (None, []) when no file is tagged this way -- same empty
    convention as retrieve_context, never a hard dependency. Any exception
    (Chroma error) is caught and logged here, same "KB grounding must never
    fail a SURVEY job" convention as retrieve_context's own try/except."""
    try:
        names = vector_store.list_always_include_documents(user_id)
    except Exception as exc:  # noqa: BLE001 - KB retrieval must never fail a SURVEY job
        logger.warning("Always-include KB lookup failed for user_id=%s: %s", user_id, exc)
        return None, []
    if not names:
        return None, []

    texts: list[str] = []
    citations: list[dict] = []
    for name in names:
        try:
            text, truncated = vector_store.get_document(user_id, name)
        except Exception as exc:  # noqa: BLE001 - one file's failure must not block the others
            logger.warning("Failed to fetch always-include document %r for user_id=%s: %s", name, user_id, exc)
            continue
        if not text:
            continue
        texts.append(text)
        # similarity=1.0: this file was never scored against a query --
        # it's included unconditionally, so there is no similarity to
        # report. Fixed at the ceiling rather than omitted so downstream
        # display code (which expects a float) doesn't need a special case.
        citations.append({"source_file": name, "similarity": 1.0, "text": text, "truncated": truncated})
    if not texts:
        return None, []
    return "\n\n".join(texts), citations
