from __future__ import annotations

import logging
import time
import re
from typing import Protocol

from pydantic import BaseModel, Field

from app.dedup.embedding_blend import blend_embeddings
from app.dedup.vector_store import ChromaVectorStore

logger = logging.getLogger(__name__)


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

    def judge_duplicate_pair(
        self, candidate_text: str, matched_text: str, user_id: str | None = None,
    ) -> dict: ...

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
    # "judge_failed" means it ran but raised -- is_duplicate is the
    # embedding's own unverified verdict in that case, not a real judge
    # confirmation; a caller/UI should treat this differently from a real
    # "redundant"/"contradictory"/"distinct" verdict.
    judge_verdict: str | None = None
    # The matched item's own text, kept so the caller can show the two texts
    # side by side on the running-job screen (job transparency, B9b). Never part
    # of the HTTP response (exclude=True): it is internal to this process.
    matched_text: str | None = Field(default=None, exclude=True)


def check_for_duplicates(
    text: str,
    title: str,
    item_id: str,
    area_path: str,
    embed_client,
    vector_store: ChromaVectorStore,
    threshold: float = 0.90,
    judge_client: DuplicateJudgeClient | None = None,
    user_id: str | None = None,
    # Out-parameter, filled with embed_ms / query_ms / judge_ms (milliseconds; judge_ms only when the judge ran): lets the caller say
    # where the time of a slow check went. Observation only.
    timings: dict[str, int] | None = None,
) -> DuplicateCheckResult:
    """Embeds `title`+`text` (blended, see below) and checks the blend
    against the Area-Path-scoped vector store for a near-duplicate.
    Threshold is inclusive (similarity >= threshold means duplicate).
    Historically fixed at 0.90 (confirmed product requirement at the time);
    now live-editable via the orchestrator's Settings window (NEW-07) --
    `/dedup/check` passes an explicit `threshold` when the caller has one,
    otherwise this default governs, so 0.90 remains the behavior for any
    caller that never opts in. Does NOT upsert `item_id`/its embedding into
    the store — this function only answers the question, a caller decides
    separately whether to add a confirmed-non-duplicate item.

    Title/description blend (confirmed real gap, fixed here): embedding
    `text` (description) alone cannot separate "same requirement, reworded"
    from "different requirement, same topic" for this corpus -- measured
    live, a genuine duplicate scored 0.755 against its nearest false
    neighbor's 0.747, a 0.008 margin, indistinguishable at any threshold.
    Blending the title's embedding 50/50 with the description's embedding
    (`blend_embeddings`, weight_a=0.5) was the lowest title weight that got
    every measured true-duplicate pair to clear the fixed 0.90 threshold,
    with real margin (measured min 0.9416) -- distinct requirements have
    distinct titles, which pushes their embeddings apart rather than
    inflating false positives. `text` alone (unblended) is still what gets
    compared for the numeric-literal guard below and stored as `document`
    -- only the embedding VECTOR computation changes.

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
    A judge exception, or no matched_document to judge against, leaves the
    embedding's own verdict standing -- UNLIKE every other fail-open path in
    this codebase, this is the unsafe direction: leaving is_duplicate=True
    means a real requirement is silently never created in ADO (confirm()
    skips 'create' for a dedup_skip match), while the reviewer sees a
    confident "near-duplicate" badge with no indication the judge never
    actually confirmed it. judge_verdict is set to "judge_failed" (distinct
    from None, which means the judge never ran at all) so this is at least
    visible downstream, and the failure is logged -- every other optional
    client in this module already does both."""
    started = time.monotonic()
    title_embedding, description_embedding = embed_client.embed([title, text], user_id=user_id)
    embedded = time.monotonic()
    embedding = blend_embeddings(title_embedding, description_embedding)
    nearest = vector_store.query_nearest(embedding, area_path=area_path)
    if timings is not None:
        timings["embed_ms"] = round((embedded - started) * 1000)
        timings["query_ms"] = round((time.monotonic() - embedded) * 1000)
    if nearest is None:
        return DuplicateCheckResult(is_duplicate=False)

    matched_item_id, similarity, matched_document = nearest
    is_duplicate = similarity >= threshold
    if is_duplicate and matched_document is not None and _numeric_tokens(text) != _numeric_tokens(matched_document):
        is_duplicate = False

    judge_verdict: str | None = None
    if is_duplicate and judge_client is not None and matched_document is not None:
        judge_started = time.monotonic()
        try:
            result = judge_client.judge_duplicate_pair(text, matched_document, user_id=user_id)
            judge_verdict = result.get("verdict")
            if judge_verdict == "distinct":
                is_duplicate = False
        except Exception as exc:  # noqa: BLE001 - see this function's own docstring
            logger.warning("Dedup judge call failed, embedding verdict (is_duplicate=%s) stands unverified: %s", is_duplicate, exc)
            judge_verdict = "judge_failed"
        if timings is not None:
            timings["judge_ms"] = round((time.monotonic() - judge_started) * 1000)

    return DuplicateCheckResult(
        is_duplicate=is_duplicate,
        judge_verdict=judge_verdict,
        matched_item_id=matched_item_id,
        similarity=similarity,
        matched_text=matched_document,
    )
