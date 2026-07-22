from __future__ import annotations

import math
from typing import Protocol

from app.quality.criteria_corpus import CRITERIA_CORPUS, QualityCriterion


class EmbeddingClient(Protocol):
    """Same shape as app.dedup.orchestrator_embed_client.OrchestratorEmbedClient
    -- one batched call embedding every text at once, not one call per text."""

    def embed(self, texts: list[str]) -> list[list[float]]: ...


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


class CriteriaRetriever:
    """Retrieval-grounded lookup over CRITERIA_CORPUS (see
    criteria_corpus.py's own docstring for why this corpus is req2ado's own
    authored checklist, not the licensed standard text). Embeds the corpus
    ONCE at construction (it's small and static -- no Chroma collection or
    persistence needed for ~7 documents, unlike dedup's much larger,
    per-area-path-growing corpus), then retrieves the top-k criteria most
    semantically relevant to a batch of requirement text via cosine
    similarity, computed in plain Python (same math dedup's ChromaVectorStore
    delegates to Chroma internally, just inlined here since there's no
    persistent store to delegate to).

    Retrieval is done ONCE per branch, on the branch's own concatenated
    descriptions -- not once per node -- keeping this to one extra embed()
    call per branch (matching this codebase's existing batching philosophy:
    one call per branch, not one per node) rather than N per-node calls."""

    def __init__(self, embedding_client: EmbeddingClient, corpus: list[QualityCriterion] = CRITERIA_CORPUS) -> None:
        self._corpus = corpus
        self._embedding_client = embedding_client
        self._corpus_embeddings = embedding_client.embed([c.text for c in corpus]) if corpus else []

    def retrieve(self, query_text: str, top_k: int = 3) -> list[QualityCriterion]:
        if not self._corpus:
            return []
        [query_embedding] = self._embedding_client.embed([query_text])
        scored = sorted(
            zip(self._corpus, self._corpus_embeddings),
            key=lambda pair: _cosine_similarity(query_embedding, pair[1]),
            reverse=True,
        )
        return [criterion for criterion, _ in scored[:top_k]]
