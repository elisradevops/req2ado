from __future__ import annotations

from pydantic import BaseModel

from app.dedup.vector_store import ChromaVectorStore


class DuplicateCheckResult(BaseModel):
    is_duplicate: bool
    matched_item_id: str | None = None
    similarity: float | None = None


def check_for_duplicates(
    text: str,
    item_id: str,
    area_path: str,
    embed_client,
    vector_store: ChromaVectorStore,
    threshold: float = 0.90,
) -> DuplicateCheckResult:
    """Embeds `text` and checks it against the Area-Path-scoped vector store
    for a near-duplicate. Threshold is inclusive (similarity >= threshold
    means duplicate), per config.yaml's dedup.threshold: 0.90 and Phase 6's
    DoD ('0.89 keep / 0.91 skip'). Does NOT upsert `item_id`/its embedding
    into the store — this function only answers the question, a caller
    decides separately whether to add a confirmed-non-duplicate item."""
    [embedding] = embed_client.embed([text])
    nearest = vector_store.query_nearest(embedding, area_path=area_path)
    if nearest is None:
        return DuplicateCheckResult(is_duplicate=False)

    matched_item_id, similarity = nearest
    return DuplicateCheckResult(
        is_duplicate=similarity >= threshold,
        matched_item_id=matched_item_id,
        similarity=similarity,
    )
