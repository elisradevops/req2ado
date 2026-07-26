from __future__ import annotations

import re

from pydantic import BaseModel

from app.dedup.vector_store import ChromaVectorStore

# Matches a numeric literal, optionally followed by a unit/percent symbol
# directly or with whitespace (e.g. "87%", "500W", "3.3 V") -- used to veto a
# high-similarity dedup match that differs only in a number (e.g. "at least
# 87%" vs "at least 93%"), which a general-purpose text embedding cannot be
# trusted to distinguish (two sentences differing only in a numeric literal
# are near-identical in embedding space). Percent is checked first so "87%"
# isn't instead captured as the bare-number alternative with the '%' left
# over unmatched.
_NUMERIC_TOKEN_PATTERN = re.compile(r"\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*[A-Za-zΩ]+|\d+(?:\.\d+)?")


def _numeric_tokens(text: str) -> set[str]:
    return {token.replace(" ", "").lower() for token in _NUMERIC_TOKEN_PATTERN.findall(text)}


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
    decides separately whether to add a confirmed-non-duplicate item.

    Numeric-literal guard (X7): a >=threshold embedding match is still
    downgraded to NOT a duplicate if the candidate `text` and the matched
    item's stored text contain different numeric-literal(+unit) token sets
    -- protects against a false-positive match like "at least 87%" vs "at
    least 93%" or "at least 500W" vs "at least 600W", which a
    general-purpose embedding model cannot be trusted to separate on
    numeric value alone. Only runs when the matched item's text was
    actually stored (vector_store.upsert's optional `document` param) --
    an older/pre-migration item with no stored text (`matched_document is
    None`) fails open, same as every other dedup safety mechanism here:
    similarity is still reported either way, so a reviewer can see why a
    match was close even when it's correctly not auto-flagged."""
    [embedding] = embed_client.embed([text])
    nearest = vector_store.query_nearest(embedding, area_path=area_path)
    if nearest is None:
        return DuplicateCheckResult(is_duplicate=False)

    matched_item_id, similarity, matched_document = nearest
    is_duplicate = similarity >= threshold
    if is_duplicate and matched_document is not None and _numeric_tokens(text) != _numeric_tokens(matched_document):
        is_duplicate = False
    return DuplicateCheckResult(
        is_duplicate=is_duplicate,
        matched_item_id=matched_item_id,
        similarity=similarity,
    )
