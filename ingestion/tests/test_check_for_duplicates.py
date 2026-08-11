import tempfile

from app.dedup.check_for_duplicates import check_for_duplicates
from app.dedup.vector_store import ChromaVectorStore


class FakeEmbedClient:
    """Deterministic fake embed client — maps specific input texts to fixed
    vectors so similarity can be controlled precisely in tests, matching
    Phase 6's DoD wording '0.89 keep / 0.91 skip tests' exactly."""

    def __init__(self, text_to_vector: dict[str, list[float]]) -> None:
        self._text_to_vector = text_to_vector

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._text_to_vector[text] for text in texts]


def test_similarity_0_91_is_flagged_as_duplicate() -> None:
    # cos(theta) = 0.91 needs a specific vector pair; using two 2D unit
    # vectors at the angle where cos(theta) = 0.91 (~24.5 degrees).
    import math

    theta = math.acos(0.91)
    existing_vector = [1.0, 0.0]
    candidate_vector = [math.cos(theta), math.sin(theta)]

    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", existing_vector, area_path="Project\\Area1")

        embed_client = FakeEmbedClient({"candidate text": candidate_vector})
        result = check_for_duplicates(
            text="candidate text",
            title="candidate text",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        assert result.is_duplicate is True
        assert result.matched_item_id == "existing-item"
        assert result.similarity == pytest_approx(0.91)


def test_similarity_0_89_is_not_flagged_as_duplicate() -> None:
    import math

    theta = math.acos(0.89)
    existing_vector = [1.0, 0.0]
    candidate_vector = [math.cos(theta), math.sin(theta)]

    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", existing_vector, area_path="Project\\Area1")

        embed_client = FakeEmbedClient({"candidate text": candidate_vector})
        result = check_for_duplicates(
            text="candidate text",
            title="candidate text",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        assert result.is_duplicate is False
        assert result.similarity == pytest_approx(0.89)


def test_exactly_0_90_similarity_is_flagged_as_duplicate() -> None:
    # Threshold is >= 0.90, not > 0.90 — proves the boundary is inclusive.
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", [1.0, 0.0], area_path="Project\\Area1")

        embed_client = FakeEmbedClient({"candidate text": [1.0, 0.0]})  # identical -> similarity 1.0
        result = check_for_duplicates(
            text="candidate text",
            title="candidate text",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
            threshold=1.0,  # forces the exact-boundary case: similarity == threshold
        )
        assert result.is_duplicate is True


def test_title_blend_rescues_a_match_that_description_alone_misses() -> None:
    # Mirrors the confirmed real bug (WI-647): description-alone similarity
    # was 0.755, below the fixed 0.90 threshold, even though the item was a
    # genuine duplicate. Blending in the title got it to 0.9026. Reproduced
    # here with exact math: description-only similarity is 0.65 (well
    # below 0.90); the title matches the existing item's own embedding
    # direction exactly, so the 50/50 blend lands at the angle bisector --
    # cos(theta/2) ~= 0.909, clearing 0.90 on the blend alone.
    import math

    existing_vector = [1.0, 0.0]
    theta = math.acos(0.65)
    description_vector = [math.cos(theta), math.sin(theta)]
    title_vector = [1.0, 0.0]

    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", existing_vector, area_path="Project\\Area1")

        embed_client = FakeEmbedClient(
            {"candidate title": title_vector, "candidate description": description_vector}
        )
        result = check_for_duplicates(
            text="candidate description",
            title="candidate title",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        assert result.is_duplicate is True
        assert result.matched_item_id == "existing-item"
        assert result.similarity > 0.90


def test_description_alone_would_have_missed_the_same_match() -> None:
    # Sanity check on the fixture above -- confirms description-only
    # similarity really is below threshold, so the previous test is
    # actually exercising the blend's rescue, not a coincidence.
    import math

    theta = math.acos(0.65)
    assert math.cos(theta) < 0.90


def test_empty_store_never_flags_a_duplicate() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        embed_client = FakeEmbedClient({"candidate text": [1.0, 0.0]})
        result = check_for_duplicates(
            text="candidate text",
            title="candidate text",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        assert result.is_duplicate is False
        assert result.matched_item_id is None
        assert result.similarity is None


def test_does_not_mutate_the_vector_store() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", [1.0, 0.0], area_path="Project\\Area1")
        embed_client = FakeEmbedClient({"candidate text": [1.0, 0.0]})

        check_for_duplicates(
            text="candidate text",
            title="candidate text",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        # Re-querying for the candidate's own vector must still only find
        # "existing-item" — check_for_duplicates must not have upserted
        # "candidate-item" into the store as a side effect.
        result = store.query_nearest([1.0, 0.0], area_path="Project\\Area1")
        assert result[0] == "existing-item"


def pytest_approx(value: float):
    import pytest

    return pytest.approx(value, abs=1e-3)


# --- X7: numeric-literal guard -----------------------------------------------
#
# A >90% embedding-similarity match must never be treated as a duplicate when
# the candidate and matched texts contain different numeric-literal(+unit)
# tokens -- protects the report's named cases: "at least 87%" vs "at least
# 93%" (plus a third source using "85%"), and "at least 500W" vs "at least
# 600W". The guard only fires when the matched item's original text was
# actually stored (vector_store.upsert's optional `document` param) -- an
# older/pre-migration item with no stored text fails open, same as every
# other dedup safety mechanism in this codebase.


def test_high_similarity_with_different_numeric_tokens_is_not_flagged_as_duplicate() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        # Identical embedding (similarity 1.0, far above 0.90) but the
        # numbers in the text genuinely differ -- must not be a duplicate.
        store.upsert("existing-item", [1.0, 0.0], area_path="Project\\Area1", document="at least 87%")

        embed_client = FakeEmbedClient({"at least 93%": [1.0, 0.0]})
        result = check_for_duplicates(
            text="at least 93%",
            title="at least 93%",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        assert result.is_duplicate is False
        # similarity is still reported -- the diff view can show why it was
        # close, it just must never be auto-skipped.
        assert result.similarity == pytest_approx(1.0)


def test_high_similarity_with_different_wattage_tokens_is_not_flagged_as_duplicate() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", [1.0, 0.0], area_path="Project\\Area1", document="at least 500W")

        embed_client = FakeEmbedClient({"at least 600W": [1.0, 0.0]})
        result = check_for_duplicates(
            text="at least 600W",
            title="at least 600W",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        assert result.is_duplicate is False


def test_high_similarity_with_identical_numeric_tokens_is_still_flagged_as_duplicate() -> None:
    # The guard must not veto legitimate duplicates -- same numbers, same
    # verdict as before this guard existed.
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", [1.0, 0.0], area_path="Project\\Area1", document="at least 87%")

        embed_client = FakeEmbedClient({"efficiency of at least 87%": [1.0, 0.0]})
        result = check_for_duplicates(
            text="efficiency of at least 87%",
            title="efficiency of at least 87%",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        assert result.is_duplicate is True
        assert result.matched_item_id == "existing-item"


def test_high_similarity_with_no_numbers_in_either_text_is_unaffected() -> None:
    # Nothing to veto on when neither text has a number at all -- the guard
    # is a no-op, not a regression on ordinary text-only dedup.
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", [1.0, 0.0], area_path="Project\\Area1", document="shall support terrestrial broadcast")

        embed_client = FakeEmbedClient({"shall support terrestrial broadcast input": [1.0, 0.0]})
        result = check_for_duplicates(
            text="shall support terrestrial broadcast input",
            title="shall support terrestrial broadcast input",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        assert result.is_duplicate is True


def test_high_similarity_with_no_stored_document_fails_open_ignoring_the_guard() -> None:
    # An older/pre-migration item was upserted with no document at all
    # (matched_document is None) -- the guard must not veto on missing
    # information, matching every other fail-open dedup mechanism here.
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", [1.0, 0.0], area_path="Project\\Area1")  # no document

        embed_client = FakeEmbedClient({"at least 93%": [1.0, 0.0]})
        result = check_for_duplicates(
            text="at least 93%",
            title="at least 93%",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        assert result.is_duplicate is True


# --- LLM verification pass (DuplicateJudgeClient) ----------------------------
#
# Closes a real false-positive risk: `all-minilm` (this codebase's
# configured EMBED_MODEL) is a small, general-purpose embedding -- two
# topically-adjacent but scopally distinct short phrases (e.g. "UART and
# USB Ports" vs "USB Communication") can embed above threshold with no
# numeric literal for the existing veto to catch. The judge only runs when
# the embedding+numeric-veto pipeline already says duplicate, and only
# when there's a real matched_document to judge against.


class RecordingJudgeClient:
    def __init__(self, verdict: str) -> None:
        self.verdict = verdict
        self.calls: list[tuple[str, str]] = []

    def judge_duplicate_pair(self, candidate_text: str, matched_text: str) -> dict:
        self.calls.append((candidate_text, matched_text))
        return {"verdict": self.verdict}


def test_judge_client_distinct_verdict_downgrades_an_embedding_match() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", [1.0, 0.0], area_path="Project\\Area1", document="BP_MEZ USB Communication protocol")

        embed_client = FakeEmbedClient({"BP_MEZ UART and USB Ports": [1.0, 0.0]})
        judge_client = RecordingJudgeClient("distinct")
        result = check_for_duplicates(
            text="BP_MEZ UART and USB Ports",
            title="BP_MEZ UART and USB Ports",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
            judge_client=judge_client,
        )
        assert result.is_duplicate is False
        assert result.judge_verdict == "distinct"
        assert judge_client.calls == [("BP_MEZ UART and USB Ports", "BP_MEZ USB Communication protocol")]


def test_judge_client_redundant_verdict_keeps_the_duplicate_flag() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", [1.0, 0.0], area_path="Project\\Area1", document="shall support terrestrial broadcast")

        embed_client = FakeEmbedClient({"shall support terrestrial broadcast input": [1.0, 0.0]})
        judge_client = RecordingJudgeClient("redundant")
        result = check_for_duplicates(
            text="shall support terrestrial broadcast input",
            title="shall support terrestrial broadcast input",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
            judge_client=judge_client,
        )
        assert result.is_duplicate is True
        assert result.judge_verdict == "redundant"


def test_judge_client_contradictory_verdict_also_keeps_the_duplicate_flag() -> None:
    # This call only answers "does this ADO item already exist" -- conflict
    # semantics (differing values for the same parameter) are a SEPARATE
    # concern (conflict_detection.py's within-job cluster judge), not this
    # cross-job check's job.
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", [1.0, 0.0], area_path="Project\\Area1", document="efficiency at least 87%")

        embed_client = FakeEmbedClient({"minimum efficiency at least 87%": [1.0, 0.0]})
        judge_client = RecordingJudgeClient("contradictory")
        result = check_for_duplicates(
            text="minimum efficiency at least 87%",
            title="minimum efficiency at least 87%",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
            judge_client=judge_client,
        )
        assert result.is_duplicate is True
        assert result.judge_verdict == "contradictory"


def test_judge_client_exception_falls_back_to_the_embedding_only_verdict() -> None:
    class RaisingJudgeClient:
        def judge_duplicate_pair(self, candidate_text: str, matched_text: str) -> dict:
            raise RuntimeError("LLM unreachable")

    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", [1.0, 0.0], area_path="Project\\Area1", document="shall support terrestrial broadcast")

        embed_client = FakeEmbedClient({"shall support terrestrial broadcast input": [1.0, 0.0]})
        result = check_for_duplicates(
            text="shall support terrestrial broadcast input",
            title="shall support terrestrial broadcast input",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
            judge_client=RaisingJudgeClient(),
        )
        assert result.is_duplicate is True
        assert result.judge_verdict is None


def test_judge_client_is_never_called_when_the_embedding_itself_says_not_duplicate() -> None:
    import math

    theta = math.acos(0.89)
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", [1.0, 0.0], area_path="Project\\Area1", document="unrelated text")

        embed_client = FakeEmbedClient({"candidate text": [math.cos(theta), math.sin(theta)]})
        judge_client = RecordingJudgeClient("distinct")
        result = check_for_duplicates(
            text="candidate text",
            title="candidate text",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
            judge_client=judge_client,
        )
        assert result.is_duplicate is False
        assert result.judge_verdict is None
        assert judge_client.calls == []


def test_judge_client_is_never_called_when_the_numeric_veto_already_downgraded_the_match() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", [1.0, 0.0], area_path="Project\\Area1", document="at least 87%")

        embed_client = FakeEmbedClient({"at least 93%": [1.0, 0.0]})
        judge_client = RecordingJudgeClient("redundant")
        result = check_for_duplicates(
            text="at least 93%",
            title="at least 93%",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
            judge_client=judge_client,
        )
        assert result.is_duplicate is False
        assert judge_client.calls == []
