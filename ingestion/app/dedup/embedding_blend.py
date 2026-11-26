from __future__ import annotations

import math
from collections.abc import Callable, Sequence


def blend_embeddings(vec_a: list[float], vec_b: list[float], weight_a: float = 0.5) -> list[float]:
    """Weighted sum of two embedding vectors, renormalized to unit length.

    Used to combine a title embedding and a description embedding into one
    vector for dedup similarity -- description-only embeddings collapse
    same-topic-different-requirement pairs into the same similarity band as
    genuine paraphrases (confirmed: a true duplicate scored 0.755, its
    nearest false neighbor 0.747 -- a 0.008 margin, indistinguishable).
    weight_a=0.5 (title/description evenly split) was the lowest weight that
    got every measured true-duplicate pair to clear the fixed 0.90
    threshold, with real margin (min 0.9416) -- see the dedup threshold
    investigation for the full measurement.
    """
    weight_b = 1.0 - weight_a
    blended = [weight_a * a + weight_b * b for a, b in zip(vec_a, vec_b)]
    norm = math.sqrt(sum(x * x for x in blended))
    if norm == 0:
        return blended
    return [x / norm for x in blended]


def embed_titles_and_texts(
    embed: Callable[[list[str]], list[list[float]]], items: Sequence[tuple[str, str]]
) -> list[list[float]]:
    """One duplicate-check vector per (title, text): the blend of the two embeddings, in one embed call (titles first, then texts).

    An item with no text (an Epic or Feature the file gives no text of its own, owner decision 2026-11-25) is the blend of its title with
    itself, which is the title's direction at unit length: its empty text is never sent, because /llm/embed refuses an empty string and the
    whole check then failed (seen live, 2026-11-26)."""
    texts = [text for _, text in items if text.strip()]
    vectors = embed([title for title, _ in items] + texts)
    title_vectors, text_vectors = vectors[: len(items)], iter(vectors[len(items) :])
    return [
        blend_embeddings(title_vector, next(text_vectors) if text.strip() else title_vector)
        for title_vector, (_, text) in zip(title_vectors, items)
    ]
