"""With a fixed category list, every scored requirement carries exactly those categories (plus the built-in completeness check).

The prompt asks for them and the schema only checks the shape, so a model that dropped a key, renamed one by case, or
invented one produced nodes with different key-sets in one job (276 vs 152 items in a prod run). The keys are enforced in
code: names are mapped to the list's spelling, names outside it are dropped, and a missing one is reported, never invented."""
from app.leveling.scoring import _apply_quality_scores, _conform_category_scores
from app.workitem.model import WarningKind
from tests.test_scoring import _FakeScoringClient, _requirement_node

LIST = ["Clarity", "Testable"]
KEY = "completeness_as_requirement"


def test_names_are_mapped_to_the_lists_spelling_and_foreign_names_are_dropped() -> None:
    conformed, missing = _conform_category_scores({"clarity": 80, " TESTABLE ": 60, KEY: 10, "invented": 5}, LIST)
    assert conformed == {"Clarity": 80, "Testable": 60, KEY: 10}
    assert missing == []


def test_a_missing_category_is_reported_and_never_invented() -> None:
    conformed, missing = _conform_category_scores({"Clarity": 80, KEY: 10}, LIST)
    assert conformed == {"Clarity": 80, KEY: 10} and missing == ["Testable"]


def test_a_list_that_already_names_the_completeness_check_does_not_require_it_twice() -> None:
    conformed, missing = _conform_category_scores({"Clarity": 1, KEY: 2}, ["Clarity", KEY])
    assert conformed == {"Clarity": 1, KEY: 2} and missing == []


def test_nothing_scored_stays_nothing() -> None:
    assert _conform_category_scores(None, LIST) == (None, [])


def test_the_apply_step_enforces_the_list_and_warns_once_with_the_missing_categories_and_nodes() -> None:
    nodes = [_requirement_node("a", "The system shall do A."), _requirement_node("b", "The system shall do B.")]
    client = _FakeScoringClient({
        "a": {"score": 70, "issues": [], "categoryScores": {"clarity": 70, "Testable": 70, KEY: 70}},
        "b": {"score": 60, "issues": [], "categoryScores": {"Clarity": 60, "Testable": 60, "extra": 1}},
    })
    warnings: list = []
    _apply_quality_scores(nodes, client, warnings, "", category_checklist=LIST)

    assert nodes[0].quality_category_scores == {"Clarity": 70, "Testable": 70, KEY: 70}
    assert nodes[1].quality_category_scores == {"Clarity": 60, "Testable": 60}  # "extra" dropped, completeness not invented
    gaps = [w for w in warnings if w.kind == WarningKind.SCORING_INCONSISTENT_CATEGORIES]
    assert len(gaps) == 1
    assert gaps[0].node_ids == ["b"] and gaps[0].detail["missingCategories"] == [KEY]


def test_a_complete_answer_gives_no_warning() -> None:
    nodes = [_requirement_node("a", "The system shall do A.")]
    client = _FakeScoringClient({"a": {"score": 70, "issues": [], "categoryScores": {"Clarity": 1, "Testable": 2, KEY: 3}}})
    warnings: list = []
    _apply_quality_scores(nodes, client, warnings, "", category_checklist=LIST)
    assert not [w for w in warnings if w.kind == WarningKind.SCORING_INCONSISTENT_CATEGORIES]


def test_without_a_fixed_list_the_answer_is_taken_as_it_is() -> None:
    nodes = [_requirement_node("a", "The system shall do A.")]
    client = _FakeScoringClient({"a": {"score": 70, "issues": [], "categoryScores": {"whatever": 5}}})
    _apply_quality_scores(nodes, client, [], "")
    assert nodes[0].quality_category_scores == {"whatever": 5}


def test_a_job_whose_chunks_each_stay_consistent_but_differ_from_one_another_is_reported_once() -> None:
    from app.leveling import scoring
    from tests.test_scoring import _requirement_nodes

    class DriftingClient:
        """Each call is internally consistent, but a later call uses other names (live-derived categories)."""

        def __init__(self) -> None:
            self.calls = 0

        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None, user_id=None):
            self.calls += 1
            names = {"Clarity": 50} if self.calls == 1 else {"Testable": 50}
            return {node_id: {"score": 70, "issues": [], "categoryScores": dict(names)} for node_id in descriptions_by_node_id}

    nodes = _requirement_nodes(scoring._SCORING_CHUNK_NODE_COUNT + 5)  # two chunks
    warnings: list = []
    scoring._score_all_requirements(nodes, DriftingClient(), warnings, None, None, [], None, None, 0, 1)
    job_level = [w for w in warnings if w.kind == WarningKind.SCORING_INCONSISTENT_CATEGORIES]
    assert len(job_level) == 1 and job_level[0].detail["scope"] == "job" and job_level[0].detail["distinctKeySetCount"] == 2


def test_no_job_level_warning_when_the_job_is_consistent_or_a_chunk_warning_already_says_so() -> None:
    from app.leveling import scoring
    from tests.test_scoring import _requirement_nodes

    class SteadyClient:
        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None, user_id=None):
            return {node_id: {"score": 70, "issues": [], "categoryScores": {"Clarity": 50}} for node_id in descriptions_by_node_id}

    warnings: list = []
    scoring._score_all_requirements(_requirement_nodes(scoring._SCORING_CHUNK_NODE_COUNT + 5), SteadyClient(), warnings, None, None, [], None, None, 0, 1)
    assert not [w for w in warnings if w.kind == WarningKind.SCORING_INCONSISTENT_CATEGORIES]


def test_a_rescore_after_an_edit_keeps_to_the_items_own_categories() -> None:
    from app.leveling.scoring import score_single_requirement_text

    client = _FakeScoringClient({"adhoc": {"score": 80, "issues": [], "categoryScores": {"CLARITY": 80, "testable": 70, KEY: 60, "invented": 1}}})
    score, _issues, categories, _confidence = score_single_requirement_text(
        "The system shall do A.", client, None, None, ["Clarity", "Testable"],
    )
    assert score == 80 and categories == {"Clarity": 80, "Testable": 70, KEY: 60}
