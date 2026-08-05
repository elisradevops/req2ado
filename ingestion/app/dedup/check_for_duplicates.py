from __future__ import annotations

import re
from typing import Protocol

from pydantic import BaseModel

from app.dedup.vector_store import ChromaVectorStore


class DuplicateJudgeClient(Protocol):
    """Optional, narrow LLM capability: verify a >=threshold embedding
    match before trusting it. Real gap closed here: `all-minilm` (this
    codebase's configured EMBED_MODEL) is a small, general-purpose
    sentence embedding -- confirmed real false-positive risk for two
    topically-adjacent but SCOPALLY DISTINCT short phrases (e.g. "UART and
    USB Ports" vs "USB Communication", both about "USB" but different
    requirement scope), which the existing numeric-literal veto
    (_numeric_tokens) does nothing to catch (neither phrase has a number).
    Entirely optional (default None, same opt-in-capability convention as
    every other client in this codebase) -- when omitted, the embedding's
    own is_duplicate verdict (after the numeric veto) is trusted as-is,
    matching pre-existing behavior exactly."""

    def judge_duplicate_pair(self, candidate_text: str, matched_text: str) -> dict: ...

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
    # Set only when judge_client actually ran (a >=threshold embedding
    # match, numeric veto not already triggered) -- lets a caller/reviewer
    # see WHY a match was kept or downgraded, not just the raw boolean.
    # None means the judge never ran (no client supplied, or the embedding
    # itself said not-duplicate) -- distinct from an empty/absent verdict.
    judge_verdict: str | None = None


def check_for_duplicates(
    text: str,
    item_id: str,
    area_path: str,
    embed_client,
    vector_store: ChromaVectorStore,
    threshold: float = 0.90,
    judge_client: DuplicateJudgeClient | None = None,
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
    match was close even when it's correctly not auto-flagged.

    LLM verification (judge_client, optional): only invoked when the
    embedding+numeric-veto pipeline above ALREADY says `is_duplicate` --
    bounds the added LLM cost to the (small) subset of genuinely close
    matches, not every dedup check. A 'distinct' verdict downgrades
    is_duplicate to False (genuinely different requirements that only
    happened to embed as similar -- the "USB Ports" vs "USB Communication"
    failure mode); 'redundant'/'contradictory' both count as a real
    duplicate HERE (this call only answers "does this ADO item already
    exist," not conflict semantics -- see conflict_detection.py for that).
    Same fail-open convention as every other optional client in this
    codebase: a judge exception, or no matched_document to judge against,
    leaves the embedding's own verdict standing."""
    [embedding] = embed_client.embed([text])
    nearest = vector_store.query_nearest(embedding, area_path=area_path)
    if nearest is None:
        return DuplicateCheckResult(is_duplicate=False)

    matched_item_id, similarity, matched_document = nearest
    is_duplicate = similarity >= threshold
    if is_duplicate and matched_document is not None and _numeric_tokens(text) != _numeric_tokens(matched_document):
        is_duplicate = False

    judge_verdict: str | None = None
    if is_duplicate and judge_client is not None and matched_document is not None:
        try:
            result = judge_client.judge_duplicate_pair(text, matched_document)
            judge_verdict = result.get("verdict")
            if judge_verdict == "distinct":
                is_duplicate = False
        except Exception:
            judge_verdict = None

    return DuplicateCheckResult(
        is_duplicate=is_duplicate,
        judge_verdict=judge_verdict,
        matched_item_id=matched_item_id,
        similarity=similarity,
    )
