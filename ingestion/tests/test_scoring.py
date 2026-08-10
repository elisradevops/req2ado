from app.leveling.scoring import score_single_requirement_text


class _FakeScoringClient:
    def __init__(self, response: dict) -> None:
        self._response = response
        self.calls: list[tuple] = []

    def score_requirements_for_document(
        self, descriptions_by_node_id, criteria_context=None, kb_context=None,
        category_checklist=None,
    ):
        self.calls.append(
            (descriptions_by_node_id, criteria_context, kb_context, category_checklist)
        )
        return self._response


def test_returns_parsed_score_issues_and_category_scores() -> None:
    client = _FakeScoringClient(
        {
            "adhoc": {
                "score": 72,
                "issues": ["vague_term", "not_a_real_issue"],
                "categoryScores": {"clarity": 60},
            },
        },
    )

    score, issues, category_scores = score_single_requirement_text(
        "The system shall do x.", client, None, None, None,
    )

    assert score == 72
    # "not_a_real_issue" is outside the closed vocabulary and silently
    # dropped, same tolerant philosophy as _apply_quality_scores.
    assert issues == ["vague_term"]
    assert category_scores == {"clarity": 60}


def test_sends_the_single_description_under_an_adhoc_key() -> None:
    client = _FakeScoringClient({"adhoc": {"score": 50, "issues": [], "categoryScores": None}})

    score_single_requirement_text(
        "The system shall do x.", client, None, "kb ctx", ["clarity", "rationale"],
    )

    descriptions_by_node_id, criteria_context, kb_context, category_checklist = client.calls[0]
    assert descriptions_by_node_id == {"adhoc": "The system shall do x."}
    assert criteria_context is None  # no retriever supplied
    assert kb_context == "kb ctx"
    # The exact rubric this rescore must be judged against, forced through
    # unchanged -- this is the whole determinism guarantee the feature
    # depends on.
    assert category_checklist == ["clarity", "rationale"]


def test_missing_score_entry_returns_none_score_and_empty_issues() -> None:
    client = _FakeScoringClient({})  # the LLM returned no entry for "adhoc" at all

    score, issues, category_scores = score_single_requirement_text(
        "The system shall do x.", client, None, None, None,
    )

    assert score is None
    assert issues == []
    assert category_scores is None


def test_malformed_score_out_of_range_falls_back_to_none() -> None:
    client = _FakeScoringClient({"adhoc": {"score": 150, "issues": [], "categoryScores": None}})

    score, _issues, _category_scores = score_single_requirement_text(
        "The system shall do x.", client, None, None, None,
    )

    assert score is None


def test_boolean_score_is_rejected_same_as_batched_scoring() -> None:
    # bool is a subclass of int in Python -- isinstance(True, int) is True --
    # so this must be excluded explicitly, same guard _apply_quality_scores
    # already has for the batched path.
    client = _FakeScoringClient({"adhoc": {"score": True, "issues": [], "categoryScores": None}})

    score, _issues, _category_scores = score_single_requirement_text(
        "The system shall do x.", client, None, None, None,
    )

    assert score is None


class _RecordingCriteriaRetriever:
    def __init__(self) -> None:
        self.queries: list[str] = []

    def retrieve(self, text: str, top_k: int = 3):
        self.queries.append(text)
        from app.quality.criteria_corpus import QualityCriterion
        from app.workitem.model import RequirementQualityIssue

        return [
            QualityCriterion(issue=RequirementQualityIssue.VAGUE_TERM, text="Avoid vague terms."),
        ]


def test_builds_criteria_context_from_the_retriever_when_supplied() -> None:
    retriever = _RecordingCriteriaRetriever()
    client = _FakeScoringClient({"adhoc": {"score": 40, "issues": [], "categoryScores": None}})

    score_single_requirement_text("The system shall be fast.", client, retriever, None, None)

    assert retriever.queries == ["The system shall be fast."]
    _descriptions, criteria_context, _kb_context, _checklist = client.calls[0]
    assert criteria_context == "- vague_term: Avoid vague terms."


def test_blank_description_skips_criteria_retrieval() -> None:
    retriever = _RecordingCriteriaRetriever()
    client = _FakeScoringClient({"adhoc": {"score": 0, "issues": [], "categoryScores": None}})

    score_single_requirement_text("   ", client, retriever, None, None)

    assert retriever.queries == []
