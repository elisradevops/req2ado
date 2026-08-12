from app.leveling.scoring import _match_category_checklist, score_single_requirement_text


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


class TestMatchCategoryChecklist:
    """_match_category_checklist builds quality_category_checklist -- see
    its own docstring for the exact-match-only heuristic and its known
    limitations (model key drift, categories with no stated definition)."""

    def test_matches_keys_present_in_both(self) -> None:
        result = _match_category_checklist(
            {"Necessary": 80, "Unambiguous": 60},
            {"Necessary": "States something not already satisfied.", "Verifiable": "Can be objectively checked."},
        )
        assert result == {"Necessary": "States something not already satisfied."}

    def test_matches_case_insensitively_and_whitespace_normalized(self) -> None:
        # The scoring model is instructed to use category_checklist's names
        # VERBATIM, but this stays tolerant of minor case/whitespace drift
        # rather than losing a real match over it.
        result = _match_category_checklist(
            {"  necessary  ": 80}, {"Necessary": "Real definition."},
        )
        assert result == {"  necessary  ": "Real definition."}

    def test_no_match_for_a_key_with_no_stated_definition(self) -> None:
        # A category the org's document lists only by bare name (no
        # separate explanation) is a real, expected case -- correctly
        # produces no entry for it, not an error.
        result = _match_category_checklist(
            {"Necessary": 80, "Ranked": 70}, {"Necessary": "Real definition."},
        )
        assert result == {"Necessary": "Real definition."}
        assert "Ranked" not in result

    def test_returns_none_when_nothing_matches_at_all(self) -> None:
        result = _match_category_checklist(
            {"clarity": 80}, {"Necessary": "Real definition."},
        )
        assert result is None

    def test_returns_none_when_category_scores_is_none(self) -> None:
        assert _match_category_checklist(None, {"Necessary": "Real definition."}) is None

    def test_returns_none_when_no_definitions_were_supplied(self) -> None:
        assert _match_category_checklist({"Necessary": 80}, None) is None
        assert _match_category_checklist({"Necessary": 80}, {}) is None

    def test_always_injected_completeness_key_never_matches(self) -> None:
        # completeness_as_requirement is req2ado's own structural check,
        # added regardless of checklist source -- never part of any org's
        # document, so it correctly never has a checklist definition.
        result = _match_category_checklist(
            {"Necessary": 80, "completeness_as_requirement": 90},
            {"Necessary": "Real definition."},
        )
        assert result == {"Necessary": "Real definition."}
        assert "completeness_as_requirement" not in result
