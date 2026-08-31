from app.quality.criteria_corpus import CRITERIA_CORPUS, QualityCriterion
from app.quality.criteria_retrieval import CriteriaRetriever
from app.workitem.model import RequirementQualityIssue


class FakeEmbeddingClient:
    """Deterministic stand-in for OrchestratorEmbedClient -- maps each known
    text to a hand-picked embedding vector so cosine similarity ordering is
    predictable in tests, rather than depending on a real embedding model."""

    def __init__(self, vectors_by_text: dict[str, list[float]]) -> None:
        self._vectors_by_text = vectors_by_text
        self.calls: list[list[str]] = []

    def embed(self, texts: list[str], user_id: str | None = None) -> list[list[float]]:
        self.calls.append(texts)
        return [self._vectors_by_text[text] for text in texts]


def _corpus_of_two() -> list[QualityCriterion]:
    return [
        QualityCriterion(RequirementQualityIssue.VAGUE_TERM, "vague terms like fast or robust"),
        QualityCriterion(RequirementQualityIssue.PASSIVE_VOICE, "prefer active voice over passive voice"),
    ]


def test_retrieve_returns_the_most_similar_criteria_first() -> None:
    corpus = _corpus_of_two()
    embedding_client = FakeEmbeddingClient(
        {
            "vague terms like fast or robust": [1.0, 0.0],
            "prefer active voice over passive voice": [0.0, 1.0],
            "the system shall be fast": [1.0, 0.0],
        }
    )
    retriever = CriteriaRetriever(embedding_client, corpus=corpus)

    result = retriever.retrieve("the system shall be fast", top_k=1)

    assert result == [corpus[0]]


def test_retrieve_respects_top_k() -> None:
    corpus = _corpus_of_two()
    embedding_client = FakeEmbeddingClient(
        {
            "vague terms like fast or robust": [1.0, 0.0],
            "prefer active voice over passive voice": [0.0, 1.0],
            "query": [0.7, 0.7],
        }
    )
    retriever = CriteriaRetriever(embedding_client, corpus=corpus)

    result = retriever.retrieve("query", top_k=2)
    assert len(result) == 2


def test_embeds_the_corpus_exactly_once_at_construction() -> None:
    corpus = _corpus_of_two()
    embedding_client = FakeEmbeddingClient(
        {
            "vague terms like fast or robust": [1.0, 0.0],
            "prefer active voice over passive voice": [0.0, 1.0],
            "query": [1.0, 0.0],
        }
    )
    CriteriaRetriever(embedding_client, corpus=corpus).retrieve("query")

    # One call for the corpus at construction, one call per retrieve().
    assert len(embedding_client.calls) == 2
    assert embedding_client.calls[0] == [c.text for c in corpus]


def test_retrieve_returns_empty_list_for_an_empty_corpus() -> None:
    embedding_client = FakeEmbeddingClient({})
    retriever = CriteriaRetriever(embedding_client, corpus=[])

    assert retriever.retrieve("anything") == []
    # No embed() call at all -- nothing to embed for an empty corpus, and no
    # query embedding is needed either since there's nothing to compare against.
    assert embedding_client.calls == []


def test_threads_user_id_to_both_the_constructors_corpus_embed_and_every_retrieve_call() -> None:
    # user_id is bound at construction (see CriteriaRetriever's own doc
    # comment for why storing it on self is safe here, unlike
    # OrchestratorLlmClient/OrchestratorVisionClient's true shared
    # singletons) -- both the one-time corpus embed AND every retrieve()
    # call must resolve the SAME user's Open WebUI connection.
    class _RecordingEmbeddingClient:
        def __init__(self, vectors_by_text: dict[str, list[float]]) -> None:
            self._vectors_by_text = vectors_by_text
            self.user_ids_by_call: list[str | None] = []

        def embed(self, texts: list[str], user_id: str | None = None) -> list[list[float]]:
            self.user_ids_by_call.append(user_id)
            return [self._vectors_by_text[text] for text in texts]

    corpus = _corpus_of_two()
    embedding_client = _RecordingEmbeddingClient(
        {
            "vague terms like fast or robust": [1.0, 0.0],
            "prefer active voice over passive voice": [0.0, 1.0],
            "query": [1.0, 0.0],
        }
    )

    retriever = CriteriaRetriever(embedding_client, corpus=corpus, user_id="user-1")
    retriever.retrieve("query")

    assert embedding_client.user_ids_by_call == ["user-1", "user-1"]


def test_default_corpus_covers_every_requirement_quality_issue() -> None:
    # The corpus is meant to be a retrievable reference for every issue
    # RequirementQualityIssue can flag -- a gap here would mean some issue
    # types have no grounding material at all.
    covered_issues = {c.issue for c in CRITERIA_CORPUS}
    assert covered_issues == set(RequirementQualityIssue)
