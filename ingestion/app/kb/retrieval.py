from __future__ import annotations

import logging
from typing import Protocol

from app.kb.kb_vector_store import KbVectorStore

logger = logging.getLogger(__name__)


class EmbedClient(Protocol):
    def embed(self, texts: list[str]) -> list[list[float]]: ...


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
    joins their text with a blank-line separator. Returns
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
        [embedding] = embed_client.embed([query_text])
        hits = vector_store.query(user_id, embedding, top_k)
    except Exception as exc:  # noqa: BLE001 - retrieval must never fail a SURVEY job
        logger.warning("KB retrieval failed for user_id=%s: %s", user_id, exc)
        return None, []

    survivors = [hit for hit in hits if hit["distance"] <= max_distance]
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
