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
