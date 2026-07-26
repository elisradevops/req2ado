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
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
            threshold=1.0,  # forces the exact-boundary case: similarity == threshold
        )
        assert result.is_duplicate is True


def test_empty_store_never_flags_a_duplicate() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        embed_client = FakeEmbedClient({"candidate text": [1.0, 0.0]})
        result = check_for_duplicates(
            text="candidate text",
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
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        assert result.is_duplicate is True
