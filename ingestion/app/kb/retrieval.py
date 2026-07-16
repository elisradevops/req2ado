from __future__ import annotations

import logging
from typing import Protocol

from app.kb.kb_vector_store import KbVectorStore

logger = logging.getLogger(__name__)


class EmbedClient(Protocol):
    def embed(self, texts: list[str]) -> list[list[float]]: ...


def retrieve_context(
    area_path: str,
    query_text: str,
    embed_client: EmbedClient,
    vector_store: KbVectorStore,
    top_k: int = 5,
    max_distance: float = 0.7,
) -> tuple[str | None, list[str]]:
    """Embeds query_text, queries the KB collection for area_path, keeps
    hits with distance <= max_distance (cosine similarity >= 0.3), and
    joins their text with a blank-line separator. Returns
    (context, citations): context is None when the collection is empty, no
    hit clears the similarity bar, or the embed/query call itself raises
    (network failure, Chroma error) — KB retrieval is an enhancement, not a
    hard dependency, and must never fail or block a SURVEY job. citations is
    the deduped, first-seen-order list of surviving hits' source_file names
    (P3c source provenance) — always [] when context is None. Any exception
    is caught and logged here; this is the single seam that makes KB failure
    non-fatal for callers."""
    try:
        [embedding] = embed_client.embed([query_text])
        hits = vector_store.query(area_path, embedding, top_k)
    except Exception as exc:  # noqa: BLE001 - retrieval must never fail a SURVEY job
        logger.warning("KB retrieval failed for area_path=%s: %s", area_path, exc)
        return None, []

    survivors = [hit for hit in hits if hit["distance"] <= max_distance]
    if not survivors:
        return None, []

    context = "\n\n".join(hit["text"] for hit in survivors)
    citations: list[str] = []
    for hit in survivors:
        if hit["source_file"] not in citations:
            citations.append(hit["source_file"])
    return context, citations
