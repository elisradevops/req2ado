from __future__ import annotations

import math


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
