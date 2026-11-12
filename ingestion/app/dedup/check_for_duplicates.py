from __future__ import annotations

import logging
import re
import time
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
        self,
        candidate_text: str,
        matched_text: str,
        user_id: str | None = None,
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
    # "judge_failed" means it ran but raised: the match was never confirmed,
    # so is_duplicate is False (the item is not skipped); a caller/UI should
    # treat this differently from a real "redundant"/"contradictory"/
    # "distinct" verdict.
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
    # What the proposed item is compared against: items of the same kind (Epic / Feature / Requirement; None = any kind), in the
    # area path and the ones under it ("area_path") or anywhere in the project ("project").
    type_category: str | None = None,
    scope: str = "area_path",
    # How many of the closest stored items to look at, and how many of those (all at or above the threshold) may cost a judge call.
    top_k: int = 5,
    max_judged: int = 3,
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
    failure mode); Only 'redundant' counts as a
    duplicate HERE. 'contradictory' means similar wording with DIFFERENT
    content, so skipping it would silently drop a requirement that disagrees
    with an existing one; it is kept, with the verdict and the matched item
    reported so a reviewer can compare the two (the within-job conflict
    judge, conflict_detection.py, is a separate concern).
    A judge exception means the match was never confirmed, and a skip on an
    unconfirmed match is the unsafe direction: confirm() skips 'create' for
    a dedup_skip match, so a real requirement would silently never reach
    ADO. The requirement is therefore NOT skipped (is_duplicate=False): a
    duplicate that gets created is visible and fixable, one that is never
    created is not. judge_verdict is "judge_failed" (distinct from None,
    which means the judge never ran at all) and the failure is logged, and
    the similarity and matched item are still reported."""
    started = time.monotonic()
    title_embedding, description_embedding = embed_client.embed([title, text], user_id=user_id)
    embedded = time.monotonic()
    embedding = blend_embeddings(title_embedding, description_embedding)
    matches = vector_store.query_nearest_many(embedding, area_path, scope=scope, type_category=type_category, top_k=top_k)
    if timings is not None:
        timings["embed_ms"] = round((embedded - started) * 1000)
        timings["query_ms"] = round((time.monotonic() - embedded) * 1000)
    if not matches:
        return DuplicateCheckResult(is_duplicate=False)

    # Only matches at or above the threshold are candidates, and one whose numbers differ from the proposed text is not a duplicate
    # of it. An older entry with no stored text cannot be compared, so it stays a candidate (fails open, as before).
    own_numbers = _numeric_tokens(text)
    candidates = [m for m in matches if m.similarity >= threshold and (m.document is None or _numeric_tokens(m.document) == own_numbers)]

    def result_for(match, duplicate: bool, verdict: str | None) -> DuplicateCheckResult:
        return DuplicateCheckResult(
            is_duplicate=duplicate,
            judge_verdict=verdict,
            matched_item_id=match.item_id,
            similarity=match.similarity,
            matched_text=match.document,
        )

    if not candidates:
        return result_for(matches[0], False, None)

    first_considered = candidates[0]
    first_verdict: str | None = None
    judged = 0
    for candidate in candidates:
        if judge_client is None or candidate.document is None:
            return result_for(candidate, True, None)  # nothing to confirm it with: the similarity stands
        if judged >= max_judged:
            break
        judged += 1
        judge_started = time.monotonic()
        try:
            verdict = judge_client.judge_duplicate_pair(text, candidate.document, user_id=user_id).get("verdict")
        except Exception as exc:  # noqa: BLE001 - see this function's own docstring
            logger.warning(
                "Dedup judge call failed, so the embedding match was never confirmed and the item is not skipped: %s",
                exc,
            )
            return result_for(candidate, False, "judge_failed")
        finally:
            if timings is not None:
                timings["judge_ms"] = timings.get("judge_ms", 0) + round((time.monotonic() - judge_started) * 1000)
        if candidate is first_considered:
            first_verdict = verdict
        if verdict == "redundant":
            return result_for(candidate, True, verdict)
    return result_for(first_considered, False, first_verdict)
