import math

from app.dedup.embedding_blend import blend_embeddings


def test_blending_identical_vectors_returns_the_same_unit_vector() -> None:
    vec = [1.0, 0.0]
    assert blend_embeddings(vec, vec) == [pytest_approx(1.0), pytest_approx(0.0)]


def test_result_is_unit_length() -> None:
    result = blend_embeddings([1.0, 0.0], [0.0, 1.0])
    norm = math.sqrt(sum(x * x for x in result))
    assert norm == pytest_approx(1.0)


def test_default_weight_is_an_even_50_50_split() -> None:
    # Two orthogonal unit vectors, evenly blended, must sit exactly halfway
    # between them.
    result = blend_embeddings([1.0, 0.0], [0.0, 1.0])
    assert result == [pytest_approx(1 / math.sqrt(2)), pytest_approx(1 / math.sqrt(2))]


def test_weight_a_of_1_returns_only_vector_a() -> None:
    result = blend_embeddings([1.0, 0.0], [0.0, 1.0], weight_a=1.0)
    assert result == [pytest_approx(1.0), pytest_approx(0.0)]


def test_weight_a_of_0_returns_only_vector_b() -> None:
    result = blend_embeddings([1.0, 0.0], [0.0, 1.0], weight_a=0.0)
    assert result == [pytest_approx(0.0), pytest_approx(1.0)]


def test_zero_vector_blend_is_not_divided_by_zero() -> None:
    # Both inputs are the zero vector -- blended sum is also zero, norm is
    # zero. Must return the zero vector, not raise or produce NaN.
    result = blend_embeddings([0.0, 0.0], [0.0, 0.0])
    assert result == [0.0, 0.0]


def pytest_approx(value: float):
    import pytest

    return pytest.approx(value, abs=1e-6)


def test_an_item_without_a_description_is_embedded_by_its_title_alone() -> None:
    """An Epic or Feature with no text of its own in the file has an empty description (owner decision, 2026-11-25). The orchestrator's
    /llm/embed refuses an empty text, so every duplicate check of such an item failed (seen live, 2026-11-26). Empty descriptions are not
    sent, and such an item's vector is its title's."""
    from app.dedup.embedding_blend import blend_embeddings, embed_titles_and_texts

    sent: list[list[str]] = []

    def embed(texts: list[str]) -> list[list[float]]:
        sent.append(list(texts))
        table = {"Power": [1.0, 0.0], "Tuner": [0.0, 1.0], "Receives DVB-T2.": [0.6, 0.8]}
        return [table[t] for t in texts]

    vectors = embed_titles_and_texts(embed, [("Power", ""), ("Tuner", "Receives DVB-T2."), ("Power", "   ")])
    assert sent == [["Power", "Tuner", "Power", "Receives DVB-T2."]]  # titles, then only the non-empty texts
    assert vectors[0] == blend_embeddings([1.0, 0.0], [1.0, 0.0])
    assert vectors[1] == blend_embeddings([0.0, 1.0], [0.6, 0.8])
    assert vectors[2] == vectors[0]
