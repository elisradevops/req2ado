from app.canonical.model import SourceRef
from app.leveling.acceptance_criteria import (
    NEEDS_INPUT_TITLE,
    SECTION_TITLE,
    eligible_nodes,
    propose_acceptance_criteria,
)
from app.leveling.document_study import DocumentStudy
from app.workitem.model import (
    IntegrityWarning,
    WorkItemMode,
    WorkItemNode,
    WorkItemType,
)
from app.workitem.model import (
    RequirementQualityIssue as Issue,
)


def _node(local_id, description="The system shall do x.", issues=(), parent=None, node_type=WorkItemType.REQUIREMENT, title=None):
    return WorkItemNode(
        local_id=local_id, parent_local_id=parent, type=node_type, title=title or local_id, description=description,
        source_ref=SourceRef(document_path="x.docx", start_offset=0, end_offset=1), mode=WorkItemMode.SURVEY,
        quality_issues=list(issues), fidelity_hash="fh", identity_hash="ih",
    )


def _study(**kw):
    base = dict(glossary=[], placeholder_tokens=[], verification_statements=[], standards_cited=[], table_roles=[],
                lead_in_patterns=[], windows_studied=1, windows_total=1)
    base.update(kw)
    return DocumentStudy(**base)


class _Client:
    def __init__(self, answers=None, fail=False):
        self.answers = answers or {}
        self.fail = fail
        self.calls = []

    def propose_acceptance_criteria(self, items_by_id, user_id=None):
        self.calls.append(items_by_id)
        if self.fail:
            raise RuntimeError("model down")
        return {k: self.answers.get(k, {"criteria": ["Measure it."], "assumptions": [], "needs_author_input": False}) for k in items_by_id}


def test_eligibility_needs_a_criteria_flag_and_no_structural_block() -> None:
    nodes = [
        _node("a", issues=[Issue.MISSING_ACCEPTANCE_CRITERIA]),
        _node("b", issues=[Issue.NOT_TESTABLE, Issue.VAGUE_TERM]),
        _node("c", issues=[Issue.MISSING_ACCEPTANCE_CRITERIA, Issue.PLACEHOLDER]),
        _node("d", issues=[Issue.NOT_TESTABLE, Issue.OPEN_ITEM_TBD]),
        _node("e", issues=[Issue.MISSING_ACCEPTANCE_CRITERIA, Issue.FRAGMENT]),
        _node("f", issues=[Issue.NOT_TESTABLE, Issue.NOT_A_REQUIREMENT]),
        _node("g", issues=[Issue.VAGUE_TERM]),
        _node("h", issues=[Issue.NOT_TESTABLE], node_type=WorkItemType.FEATURE),
    ]
    assert [n.local_id for n in eligible_nodes(nodes)] == ["a", "b"]


def test_proposal_is_appended_and_hashes_are_untouched() -> None:
    node = _node("a", issues=[Issue.MISSING_ACCEPTANCE_CRITERIA])
    client = _Client({"a": {"criteria": ["Verify <5 ms at 10 Hz."], "assumptions": ["10 Hz is nominal"], "needs_author_input": False}})
    warnings: list[IntegrityWarning] = []

    propose_acceptance_criteria([node], _study(), client, warnings, table_text=lambda _id: None)

    assert node.description.startswith("The system shall do x.")
    assert SECTION_TITLE in node.description
    assert "Verify &lt;5 ms at 10 Hz." in node.description
    assert "10 Hz is nominal" in node.description
    assert (node.fidelity_hash, node.identity_hash) == ("fh", "ih")
    assert warnings == []


def test_study_placeholder_token_routes_to_needs_author_input_without_a_model_call() -> None:
    node = _node("a", description="Latency shall not exceed N ms.", issues=[Issue.NOT_TESTABLE])
    other = _node("b", description="Anything with a CNC machine inside is fine.", issues=[Issue.NOT_TESTABLE])
    client = _Client()

    propose_acceptance_criteria([node, other], _study(placeholder_tokens=["N"]), client, [], table_text=lambda _id: None)

    assert NEEDS_INPUT_TITLE in node.description
    assert SECTION_TITLE not in node.description
    assert "N" in node.description.split(NEEDS_INPUT_TITLE, 1)[1]
    assert list(client.calls[0]) == ["b"]  # only the non-placeholder node reaches the model
    assert SECTION_TITLE in other.description


def test_model_can_say_a_value_is_missing() -> None:
    node = _node("a", issues=[Issue.MISSING_ACCEPTANCE_CRITERIA])
    client = _Client({"a": {"criteria": ["invented"], "assumptions": [], "needs_author_input": True}})

    propose_acceptance_criteria([node], _study(), client, [], table_text=lambda _id: None)

    assert NEEDS_INPUT_TITLE in node.description
    assert "invented" not in node.description


def test_context_carries_hierarchy_children_table_and_study_hits() -> None:
    feature = _node("f", node_type=WorkItemType.FEATURE, title="Power", description="")
    lead_in = _node("a", description="Backplane shall include the following modules:", issues=[Issue.MISSING_ACCEPTANCE_CRITERIA], parent="f")
    child = _node("c", description="SBC Tiger SRU", parent="a", title="SBC Tiger SRU")
    lead_in.table_ids = ["t1"]
    study = _study(glossary=[{"term": "SRU", "definition": "Shop replaceable unit"}, {"term": "LRU", "definition": "x"}],
                   verification_statements=["measured over 0 to 20 MHz"], table_roles=[{"table": "t1", "role": "fan values"}])
    client = _Client()

    propose_acceptance_criteria([feature, lead_in, child], study, client, [], table_text=lambda tid: "| fan | 12V |" if tid == "t1" else None)

    item = client.calls[0]["a"]
    assert item["text"] == "Backplane shall include the following modules:"
    assert item["ancestors"] == ["Power"]
    assert item["children"] == ["SBC Tiger SRU"]
    assert item["tables"] == [{"id": "t1", "role": "fan values", "text": "| fan | 12V |"}]
    assert item["document_conventions"]["verification"] == ["measured over 0 to 20 MHz"]
    assert item["document_conventions"]["glossary"] == []  # SRU is not in this node's own text


def test_study_missing_still_works_with_hierarchy_only() -> None:
    node = _node("a", issues=[Issue.NOT_TESTABLE])
    client = _Client()

    propose_acceptance_criteria([node], None, client, [], table_text=lambda _id: None)

    assert SECTION_TITLE in node.description
    assert client.calls[0]["a"]["document_conventions"] == {"glossary": [], "verification": [], "standards": []}


def test_model_failure_warns_and_leaves_descriptions_alone() -> None:
    node = _node("a", issues=[Issue.NOT_TESTABLE])
    warnings: list[IntegrityWarning] = []

    propose_acceptance_criteria([node], _study(), _Client(fail=True), warnings, table_text=lambda _id: None)

    assert node.description == "The system shall do x."
    assert len(warnings) == 1
    assert warnings[0].node_ids == ["a"]


def test_second_run_does_not_append_twice() -> None:
    node = _node("a", issues=[Issue.NOT_TESTABLE])
    client = _Client()

    propose_acceptance_criteria([node], _study(), client, [], table_text=lambda _id: None)
    first = node.description
    propose_acceptance_criteria([node], _study(), client, [], table_text=lambda _id: None)

    assert node.description == first
    assert len(client.calls) == 1


def test_empty_or_malformed_answers_change_nothing() -> None:
    nodes = [_node("a", issues=[Issue.NOT_TESTABLE]), _node("b", issues=[Issue.NOT_TESTABLE])]
    client = _Client({"a": {"criteria": [], "assumptions": [], "needs_author_input": False}, "b": {"criteria": "nope"}})

    propose_acceptance_criteria(nodes, _study(), client, [], table_text=lambda _id: None)

    assert [n.description for n in nodes] == ["The system shall do x.", "The system shall do x."]


def test_html_descriptions_are_read_as_plain_text_for_context_and_placeholder_matching() -> None:
    html_node = _node("a", description="<p>Latency shall not exceed <b>N</b> ms.</p>", issues=[Issue.NOT_TESTABLE])
    tag_node = _node("b", description="<TD>The unit shall be rugged.</TD>", issues=[Issue.NOT_TESTABLE])
    client = _Client()

    propose_acceptance_criteria([html_node, tag_node], _study(placeholder_tokens=["N", "TD"]), client, [], table_text=lambda _id: None)

    assert NEEDS_INPUT_TITLE in html_node.description
    assert list(client.calls[0]) == ["b"]  # "TD" is markup, not the author's text
    assert "<" not in client.calls[0]["b"]["text"]


def test_a_failing_context_build_warns_instead_of_raising() -> None:
    node = _node("a", issues=[Issue.NOT_TESTABLE])
    node.table_ids = ["t1"]
    warnings: list[IntegrityWarning] = []

    def broken(_table_id):
        raise RuntimeError("table renderer broke")

    propose_acceptance_criteria([node], _study(), _Client(), warnings, table_text=broken)

    assert node.description == "The system shall do x."
    assert [w.node_ids for w in warnings] == [["a"]]


def test_source_text_that_mentions_the_section_titles_is_still_processed() -> None:
    node = _node("a", description="Author notes: Proposed acceptance criteria are Needs author input.", issues=[Issue.NOT_TESTABLE])

    propose_acceptance_criteria([node], _study(), _Client(), [], table_text=lambda _id: None)

    assert node.description.count('data-r2a="criteria"') == 1


def test_generated_sections_are_invisible_to_what_a_model_reads() -> None:
    from app.leveling.description_text import description_for_model

    node = _node("a", description="<p>The unit shall be rugged.</p>", issues=[Issue.NOT_TESTABLE])
    propose_acceptance_criteria([node], _study(), _Client(), [], table_text=lambda _id: None)
    assert SECTION_TITLE in node.description

    assert description_for_model(node.description).strip() == "The unit shall be rugged."

    flagged = _node("b", description="Latency shall be N ms.", issues=[Issue.NOT_TESTABLE])
    propose_acceptance_criteria([flagged], _study(placeholder_tokens=["N"]), _Client(), [], table_text=lambda _id: None)
    assert NEEDS_INPUT_TITLE in flagged.description
    assert description_for_model(flagged.description).strip() == "Latency shall be N ms."


def test_items_the_model_did_not_answer_are_reported_once() -> None:
    class _Silent(_Client):
        def propose_acceptance_criteria(self, items_by_id, user_id=None):
            return {}

    nodes = [_node("a", issues=[Issue.NOT_TESTABLE]), _node("b", issues=[Issue.NOT_TESTABLE])]
    warnings: list[IntegrityWarning] = []

    propose_acceptance_criteria(nodes, _study(), _Silent(), warnings, table_text=lambda _id: None)

    assert len(warnings) == 1
    assert warnings[0].node_ids == ["a", "b"]
