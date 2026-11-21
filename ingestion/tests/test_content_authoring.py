"""author_fixed_tree: the code-built prose items' text is rewritten on the fixed tree, and code keeps a rewrite only when it adds no value
and (for a Requirement) drops none."""

from pathlib import Path

import pytest

from app.canonical.model import CanonicalDoc
from app.dispatch import dispatch_by_extension
from app.job_cancel import JobCancelled
from app.leveling.baseline_structure import adopt_baseline_structure
from app.leveling.content_authoring import author_fixed_tree, value_problems
from app.leveling.llm_leveling import build_survey_tree
from app.workitem.model import WarningKind, WorkItemNode

FIXTURE = Path(__file__).parent / "prompt_evals" / "baselines" / "prompt-eval-fixture.docx"

# The fixture's authorable items: the table's requirement rows, the Hebrew and the General section with their split statements. Not
# offered: "1 Power interface" (a lead-in of its own), "2 Connector J1" (carries its pin table) and the grouping items the ladder added.
_AUTHORABLE = [
    "bl_n1",
    "bl_n2",
    "bl_n3",
    "bl_n4",
    "bl_n5",
    "bl_n7",
    "bl_n7_s1",
    "bl_n7_s2",
    "bl_n7_s3",
    "bl_n8",
    "bl_n8_s1",
    "bl_n8_s2",
]


def _fixture_doc() -> CanonicalDoc:
    return dispatch_by_extension(FIXTURE.name, str(FIXTURE))


def _fixture_nodes() -> list[WorkItemNode]:
    nodes, _ = adopt_baseline_structure(_fixture_doc(), None)
    return nodes


class ScriptedAuthor:
    """Answers each offered node with `answers[node_id]` (a description), or "Rewritten: <title>"; None leaves the node out."""

    def __init__(
        self, answers: dict[str, str | None] | None = None, truncated: bool = False
    ) -> None:
        self.answers = answers or {}
        self.truncated = truncated
        self.calls: list[tuple[str, dict[str, dict]]] = []

    def author_content(self, section_text, skeleton_nodes, kb_context=None, user_id=None):
        self.calls.append((section_text, skeleton_nodes))
        content = {}
        for node_id, node in skeleton_nodes.items():
            text = self.answers.get(node_id, f"Rewritten: {node['title']}")
            if text is not None:
                content[node_id] = {"description": text, "tags": ["functional"]}
        return content, self.truncated


def _by_id(nodes: list[WorkItemNode]) -> dict[str, WorkItemNode]:
    return {node.local_id: node for node in nodes}


def test_only_items_with_wording_of_their_own_are_offered_one_call_per_branch() -> None:
    nodes = _fixture_nodes()
    client = ScriptedAuthor()
    author_fixed_tree(nodes, client, [])
    offered = [node_id for _, payload in client.calls for node_id in payload]
    assert offered == _AUTHORABLE
    assert [list(payload) for _, payload in client.calls] == [
        _AUTHORABLE[:5],
        _AUTHORABLE[5:9],
        _AUTHORABLE[9:],
    ]
    # A parent's call sees the text of the items under it, and the payload names the fixed type, title and parent.
    section, payload = client.calls[1]
    assert "5 ואט" in section and "2 שניות" in section
    assert payload["bl_n7_s2"]["parent_id"] == "bl_n7"
    assert payload["bl_n7"]["type"] == "Feature"


def test_an_accepted_rewrite_replaces_the_text_and_keeps_the_tree() -> None:
    nodes = _fixture_nodes()
    before = {
        n.local_id: (n.type, n.parent_local_id, n.title, n.identity_hash, n.description)
        for n in nodes
    }
    answers = {"bl_n2": "The unit shall withstand input transients of up to 50 V lasting 100 ms."}
    warnings: list = []
    author_fixed_tree(nodes, ScriptedAuthor(answers), warnings)
    by_id = _by_id(nodes)
    node = by_id["bl_n2"]
    assert node.description == answers["bl_n2"]
    assert node.fidelity_hash != before["bl_n2"][3]
    assert node.tags and node.tags[0].value == "functional"
    assert by_id["bl_n7"].tags == []  # tags are a Requirement's only
    for node_id, (type_, parent, title, identity, _) in before.items():
        assert (
            by_id[node_id].type,
            by_id[node_id].parent_local_id,
            by_id[node_id].title,
            by_id[node_id].identity_hash,
        ) == (
            type_,
            parent,
            title,
            identity,
        )
    for node_id in ("bl_n0", "bl_n6", "bl_synth_doc_epic"):
        assert by_id[node_id].description == before[node_id][4]
    assert warnings == []


@pytest.mark.parametrize(
    ("node_id", "rewrite", "problem"),
    [
        (
            "bl_n2",
            "The unit shall tolerate input transients up to 60 V for 100 ms.",
            "added number:60",
        ),
        ("bl_n2", "The unit shall tolerate input transients up to 50 V for 100 s.", "added unit:s"),
        (
            "bl_n2",
            "The unit shall tolerate short input transients up to 50 V.",
            "dropped number:100",
        ),
        ("bl_n7_s2", "במצב חיסכון צריכת ההספק לא תעלה על 5 אמפר.", "added unit:a"),
        ("bl_n7", "ניהול צריכת הספק, כולל כניסה למצב חיסכון לאחר 15 דקות.", "added number:15"),
    ],
)
def test_a_rewrite_that_adds_or_drops_a_value_keeps_the_source_wording(
    node_id: str, rewrite: str, problem: str
) -> None:
    nodes = _fixture_nodes()
    source = _by_id(nodes)[node_id].description
    warnings: list = []
    author_fixed_tree(nodes, ScriptedAuthor({node_id: rewrite}), warnings)
    assert _by_id(nodes)[node_id].description == source
    [warning] = warnings
    assert warning.kind == WarningKind.ENHANCEMENT_RESPONSE_INCOMPLETE
    assert warning.node_ids == [node_id]
    assert warning.detail["pass"] == "authoring" and warning.detail["reason"] == "value_check"
    assert problem in warning.detail["values"][node_id]


def test_a_hebrew_unit_word_grounds_the_unit_it_names() -> None:
    nodes = _fixture_nodes()
    warnings: list = []
    rewrite = "צריכת ההספק של היחידה במצב חיסכון לא תעלה על 5 W."
    author_fixed_tree(nodes, ScriptedAuthor({"bl_n7_s2": rewrite}), warnings)
    assert _by_id(nodes)["bl_n7_s2"].description == rewrite
    assert warnings == []


def test_a_parent_summary_may_use_the_values_of_the_items_under_it() -> None:
    nodes = _fixture_nodes()
    rewrite = "מעבר למצב חיסכון לאחר 10 דקות, צריכה של עד 5 ואט וחזרה לפעולה תוך 2 שניות."
    author_fixed_tree(nodes, ScriptedAuthor({"bl_n7": rewrite}), [])
    assert _by_id(nodes)["bl_n7"].description == rewrite


def test_an_item_the_answer_leaves_out_keeps_its_source_wording() -> None:
    nodes = _fixture_nodes()
    source = _by_id(nodes)["bl_n8_s2"].description
    warnings: list = []
    author_fixed_tree(nodes, ScriptedAuthor({"bl_n8_s2": None, "bl_n8_s1": "  "}), warnings)
    assert _by_id(nodes)["bl_n8_s2"].description == source
    [warning] = warnings
    assert warning.kind == WarningKind.ENHANCEMENT_RESPONSE_INCOMPLETE
    assert warning.node_ids == ["bl_n8_s1", "bl_n8_s2"]
    assert warning.detail == {"pass": "authoring", "reason": "omitted"}


def test_a_failed_call_keeps_its_items_and_the_other_calls_apply() -> None:
    class FailsOnHebrew(ScriptedAuthor):
        def author_content(self, section_text, skeleton_nodes, kb_context=None, user_id=None):
            if "bl_n7" in skeleton_nodes:
                raise RuntimeError("proxy down")
            return super().author_content(section_text, skeleton_nodes, kb_context, user_id)

    nodes = _fixture_nodes()
    warnings: list = []
    author_fixed_tree(nodes, FailsOnHebrew(), warnings)
    by_id = _by_id(nodes)
    assert by_id["bl_n7_s1"].description.startswith("היחידה")
    assert by_id["bl_n8"].description == "Rewritten: 4 General"
    [warning] = warnings
    assert warning.kind == WarningKind.ENHANCEMENT_CALL_FAILED
    assert warning.node_ids == _AUTHORABLE[5:9]


def test_a_cancelled_job_is_not_swallowed() -> None:
    class Cancelled(ScriptedAuthor):
        def author_content(self, *args, **kwargs):
            raise JobCancelled("cancelled")

    with pytest.raises(JobCancelled):
        author_fixed_tree(_fixture_nodes(), Cancelled(), [])


def test_a_truncated_answer_is_reported() -> None:
    warnings: list = []
    author_fixed_tree(_fixture_nodes(), ScriptedAuthor(truncated=True), warnings)
    assert [w.kind for w in warnings] == [WarningKind.OUTPUT_TRUNCATED]


def test_value_problems_reads_both_directions() -> None:
    assert value_problems("Within 5 ms.", "within 5 ms", ["within 5 ms"], keep=True) == []
    assert value_problems("Quickly.", "within 5 ms", ["within 5 ms"], keep=True) == [
        "dropped number:5",
        "dropped unit:ms",
    ]
    assert value_problems("Quickly.", "within 5 ms", ["within 5 ms"], keep=False) == []


class _RecordingScorer:
    def __init__(self) -> None:
        self.texts: dict[str, str] = {}

    def score_requirements_for_document(self, descriptions_by_node_id, *_args, **_kwargs):
        self.texts.update(descriptions_by_node_id)
        return {node_id: {"score": 90, "issues": []} for node_id in descriptions_by_node_id}


class _SurveyClient:
    model = None


def test_survey_scores_the_rewritten_text_and_without_a_client_keeps_the_source() -> None:
    rewrite = "The unit shall operate from a supply voltage that is still TBD V."
    scorer = _RecordingScorer()
    tree = build_survey_tree(
        _fixture_doc(),
        _SurveyClient(),
        scoring_client=scorer,
        content_client=ScriptedAuthor({"bl_n8_s2": rewrite}),
    )
    authored = {n.local_id: n.description for n in tree.nodes}
    assert authored["bl_n8_s2"] == rewrite
    assert scorer.texts["bl_n8_s2"] == rewrite

    plain = build_survey_tree(_fixture_doc(), _SurveyClient())
    assert {n.local_id: n.description for n in plain.nodes}["bl_n8_s2"] == (
        "The unit shall operate from a supply voltage of TBD V."
    )
