"""Scoring sends a model the plain-text form of a description (tables as CSV), never the HTML the description is stored as."""
from app.leveling import scoring
from app.leveling.scoring import _apply_quality_scores, score_single_requirement_text, score_texts_together
from app.workitem.model import WorkItemType
from tests.test_scoring import _epic_nodes, _requirement_node

TABLE = "<table><tr><th>Rail</th><th>V</th></tr><tr><td>VDD</td><td>3.3</td></tr></table>"
HTML_DESCRIPTION = f"The receiver shall use:\n\n{TABLE}\n\nEnd."
AS_SENT = "The receiver shall use:\n\nTable (CSV):\nRail,V\nVDD,3.3\n\nEnd."
LIST = ["Clarity", "Testable"]
FULL = {"Clarity": 70, "Testable": 60, "completeness_as_requirement": 90}


class Recorder:
    def __init__(self, answers) -> None:  # answers: list of dict-builders, one per call
        self.sent: list[dict] = []
        self.answers = answers

    def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None, user_id=None):
        self.sent.append({k: v for k, v in descriptions_by_node_id.items() if not k.startswith("__")})
        build = self.answers[min(len(self.sent) - 1, len(self.answers) - 1)]
        return {k: build(k) for k in descriptions_by_node_id}


def full(_id):
    return {"score": 70, "issues": [], "categoryScores": dict(FULL)}


def test_requirement_scoring_sends_the_table_as_csv() -> None:
    client = Recorder([full])
    _apply_quality_scores([_requirement_node("r1", HTML_DESCRIPTION)], client, [], "", kb_context="KB", category_checklist=LIST)
    assert client.sent[0] == {"r1": AS_SENT}


def test_the_follow_up_for_a_missing_category_sends_the_same_text() -> None:
    def partial(_id):
        return {"score": 70, "issues": [], "categoryScores": {"Clarity": 70, "completeness_as_requirement": 90}}

    def follow_up(_id):
        return {"score": 1, "issues": [], "categoryScores": {"Testable": 50}}

    client = Recorder([partial, follow_up])
    _apply_quality_scores([_requirement_node("r1", HTML_DESCRIPTION)], client, [], "", kb_context="KB", category_checklist=LIST)
    assert len(client.sent) == 2 and client.sent[1] == {"r1": AS_SENT}


def test_a_rescore_and_a_before_after_comparison_send_the_text_form() -> None:
    client = Recorder([full])
    score_single_requirement_text(HTML_DESCRIPTION, client, None, "KB", LIST)
    score_texts_together({"before": HTML_DESCRIPTION, "after": "Plain."}, client, None, "KB", LIST)
    assert client.sent[0] == {"adhoc": AS_SENT}
    assert client.sent[1] == {"before": AS_SENT, "after": "Plain."}


def test_epic_and_feature_scoring_sends_the_text_form() -> None:
    seen: list[dict] = []

    class EpicClient:
        def score_epics_and_features_for_document(self, nodes_by_id, user_id=None):
            seen.append(nodes_by_id)
            return {k: {"score": 80, "issues": [], "categoryScores": {"Clarity": 80}} for k in nodes_by_id}

    node = _epic_nodes(1)[0]
    node.description = HTML_DESCRIPTION
    assert node.type == WorkItemType.EPIC
    scoring._score_epics_and_features([node], EpicClient(), [], None, None, 1, 1)
    assert seen[0]["e0"]["text"] == AS_SENT


def test_the_stored_description_is_left_as_it_was() -> None:
    node = _requirement_node("r1", HTML_DESCRIPTION)
    _apply_quality_scores([node], Recorder([full]), [], "", kb_context="KB", category_checklist=LIST)
    assert node.description == HTML_DESCRIPTION
