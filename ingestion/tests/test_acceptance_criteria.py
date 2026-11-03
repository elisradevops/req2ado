import pytest

from app.canonical.model import SourceRef
from app.job_cancel import JobCancelled
from app.leveling.acceptance_criteria import (
    NEEDS_INPUT_TITLE,
    SECTION_TITLE,
    eligible_nodes,
    propose_acceptance_criteria,
    unmistakable_markers,
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
    node = _node("a", description="Latency shall not exceed TBD ms.", issues=[Issue.NOT_TESTABLE])
    other = _node("b", description="Anything with a CNC machine inside is fine.", issues=[Issue.NOT_TESTABLE])
    client = _Client()

    propose_acceptance_criteria([node, other], _study(placeholder_tokens=["TBD"]), client, [], table_text=lambda _id: None)

    assert NEEDS_INPUT_TITLE in node.description
    assert SECTION_TITLE not in node.description
    assert "TBD" in node.description.split(NEEDS_INPUT_TITLE, 1)[1]
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
    assert client.calls[0]["a"]["document_conventions"] == {"glossary": [], "verification": [], "standards": [], "unresolved_markers": []}


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
    html_node = _node("a", description="<p>Latency shall not exceed <b>TBD</b> ms.</p>", issues=[Issue.NOT_TESTABLE])
    tag_node = _node("b", description="<TD>The unit shall be rugged.</TD>", issues=[Issue.NOT_TESTABLE])
    client = _Client()

    propose_acceptance_criteria([html_node, tag_node], _study(placeholder_tokens=["TBD", "TD"]), client, [], table_text=lambda _id: None)

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

    flagged = _node("b", description="Latency shall be TBD ms.", issues=[Issue.NOT_TESTABLE])
    propose_acceptance_criteria([flagged], _study(placeholder_tokens=["TBD"]), _Client(), [], table_text=lambda _id: None)
    assert NEEDS_INPUT_TITLE in flagged.description
    assert description_for_model(flagged.description).strip() == "Latency shall be TBD ms."


def test_items_the_model_did_not_answer_are_reported_once() -> None:
    class _Silent(_Client):
        def propose_acceptance_criteria(self, items_by_id, user_id=None):
            return {}

    nodes = [_node("a", issues=[Issue.NOT_TESTABLE]), _node("b", issues=[Issue.NOT_TESTABLE])]
    warnings: list[IntegrityWarning] = []

    propose_acceptance_criteria(nodes, _study(), _Silent(), warnings, table_text=lambda _id: None)

    assert len(warnings) == 1
    assert warnings[0].node_ids == ["a", "b"]


def test_single_letter_marker_does_not_route_without_model() -> None:
    single = _node("a", description="Latency shall not exceed N ms.", issues=[Issue.NOT_TESTABLE])
    multi = _node("b", description="Latency shall not exceed TBD ms.", issues=[Issue.NOT_TESTABLE])
    client = _Client()

    propose_acceptance_criteria([single, multi], _study(placeholder_tokens=["N", "TBD"]), client, [], table_text=lambda _id: None)

    assert list(client.calls[0]) == ["a"]  # "N" alone never skips the model; "TBD" still routes deterministically
    assert client.calls[0]["a"]["document_conventions"]["unresolved_markers"] == ["N"]
    assert NEEDS_INPUT_TITLE in multi.description
    assert SECTION_TITLE in single.description


def test_unresolved_markers_in_context_are_only_those_in_the_node_text() -> None:
    has_n = _node("a", description="Rate shall be N Hz.", issues=[Issue.NOT_TESTABLE])
    none = _node("b", description="Mass shall be 5 kg.", issues=[Issue.NOT_TESTABLE])
    unit = _node("c", description="Force shall be 50 N.", issues=[Issue.NOT_TESTABLE])
    client = _Client()

    propose_acceptance_criteria([has_n, none, unit], _study(placeholder_tokens=["N", "XYZ"]), client, [], table_text=lambda _id: None)

    items = client.calls[0]
    assert items["a"]["document_conventions"]["unresolved_markers"] == ["N"]
    assert items["b"]["document_conventions"]["unresolved_markers"] == []
    assert items["c"]["document_conventions"]["unresolved_markers"] == []  # "50 N" is a unit, not the marker


def test_unresolved_markers_key_is_present_without_a_study() -> None:
    node = _node("a", issues=[Issue.NOT_TESTABLE])
    client = _Client()

    propose_acceptance_criteria([node], None, client, [], table_text=lambda _id: None)

    assert client.calls[0]["a"]["document_conventions"]["unresolved_markers"] == []


def test_the_criteria_prompt_tells_the_model_about_unresolved_markers() -> None:
    from app.prompts import load_prompt

    text = load_prompt("propose_acceptance_criteria")

    assert "unresolved_markers" in text
    assert "needs_author_input" in text
    assert "unresolved_markers" not in load_prompt("propose_acceptance_criteria", version=1)


def test_an_ordinary_word_in_the_study_tokens_never_routes_to_needs_author_input() -> None:
    plain = _node("a", description="The unit shall report the value.", issues=[Issue.NOT_TESTABLE])
    marked = _node("b", description="The unit shall report within TBD ms.", issues=[Issue.NOT_TESTABLE])
    client = _Client()

    propose_acceptance_criteria(
        [plain, marked], _study(placeholder_tokens=["shall", "value", "TBD"]), client, [], table_text=lambda _id: None,
    )

    assert list(client.calls[0]) == ["a"]  # "shall" and "value" are words: the model decides
    assert client.calls[0]["a"]["document_conventions"]["unresolved_markers"] == ["shall", "value"]
    assert NEEDS_INPUT_TITLE in marked.description and NEEDS_INPUT_TITLE not in plain.description
    assert SECTION_TITLE in plain.description


@pytest.mark.parametrize(
    "marker", ["TBD", "TBC", "TBS", "TBR", "TBA", "T.B.D.", "XXX", "XXXX", "??", "???", "___", "***"],
)
def test_unmistakable_markers_route_deterministically(marker) -> None:
    node = _node("a", description=f"The unit shall report within {marker} ms.", issues=[Issue.NOT_TESTABLE])
    client = _Client()

    propose_acceptance_criteria([node], _study(placeholder_tokens=[marker]), client, [], table_text=lambda _id: None)

    assert client.calls == [] and NEEDS_INPUT_TITLE in node.description


@pytest.mark.parametrize(
    "marker", ["DC", "RF", "ID", "OK", "NA", "SHALL", "XX", "XXxx", "X.X.X", "N/A", "Tbd", "P1", "42", "TBX", "?", "value", "i1"],
)
def test_acronyms_and_ambiguous_markers_never_skip_the_model(marker) -> None:
    node = _node("a", description=f"The unit {marker} report within 5 ms.", issues=[Issue.NOT_TESTABLE])
    client = _Client()

    propose_acceptance_criteria([node], _study(placeholder_tokens=[marker]), client, [], table_text=lambda _id: None)

    assert list(client.calls[0]) == ["a"]
    assert client.calls[0]["a"]["document_conventions"]["unresolved_markers"] == [marker]
    assert NEEDS_INPUT_TITLE not in node.description


def test_a_cancelled_job_is_not_reported_as_a_failed_proposal() -> None:
    class _Cancelled:
        def propose_acceptance_criteria(self, items_by_id, user_id=None):
            raise JobCancelled("gone")

    node = _node("a", issues=[Issue.NOT_TESTABLE])
    warnings: list = []

    with pytest.raises(JobCancelled):
        propose_acceptance_criteria([node], _study(), _Cancelled(), warnings, table_text=lambda _id: None)

    assert warnings == [] and SECTION_TITLE not in node.description


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Latency shall not exceed TBD ms.", ["TBD"]),
        ("TBC then TBS, TBR and TBA.", ["TBC", "TBS", "TBR", "TBA"]),
        ("Rate T.B.D. Hz and XXXX units, ??? and ___ and ****.", ["T.B.D.", "XXXX", "???", "___", "****"]),
        ("שיעור TBD יחידות ו-?? נוספות", ["TBD", "??"]),
        ("ערך <redacted> שלא נקבע", []),
        ("The value <redacted> shall be TBD.", ["TBD"]),
        ("TBDX and XTBD and TBDTBD", []),
        ("Force shall be 50 N.", []),
        ("What??", []),
        ("Section X.X.X applies", []),
        ("Respond within 5 TBD s", ["TBD"]),
        ("XX and X and ? and __ and ** and N/A and tbd and Tbd and TBX", []),
        ("Y/TBD and TBD+1 and aXXX", []),
        ("TBD, then ??, then TBD again, then TBC and ??", ["TBD", "??", "TBC"]),
        ("Rate ??? Hz", ["???"]),
        ("", []),
    ],
)
def test_unmistakable_markers_are_found_in_the_text_in_order_without_duplicates(text, expected) -> None:
    assert unmistakable_markers(text) == expected


def test_a_marker_that_stands_alone_later_in_the_text_still_counts() -> None:
    assert unmistakable_markers("TBDX first, then TBD alone") == ["TBD"]


@pytest.mark.parametrize("study", [None, _study(), _study(placeholder_tokens=["N", "DC"]), _study(placeholder_tokens=["TBD", "??"])])
def test_marker_routing_does_not_depend_on_what_the_study_listed(study) -> None:
    marked = _node("a", description="Latency shall not exceed TBD ms and ?? Hz.", issues=[Issue.NOT_TESTABLE])
    plain = _node("b", description="The unit shall report within 5 ms.", issues=[Issue.NOT_TESTABLE])
    client = _Client()

    propose_acceptance_criteria([marked, plain], study, client, [], table_text=lambda _id: None)

    assert list(client.calls[0]) == ["b"]
    assert NEEDS_INPUT_TITLE in marked.description and SECTION_TITLE not in marked.description
    assert "TBD, ??" in marked.description


@pytest.mark.parametrize("token", ["DC", "RF", "ID", "N/A"])
def test_a_study_listing_an_acronym_never_routes(token) -> None:
    node = _node("a", description=f"The {token} link shall report within 5 ms.", issues=[Issue.NOT_TESTABLE])
    client = _Client()

    propose_acceptance_criteria([node], _study(placeholder_tokens=[token]), client, [], table_text=lambda _id: None)

    assert list(client.calls[0]) == ["a"] and NEEDS_INPUT_TITLE not in node.description


@pytest.mark.parametrize("tokens", [[], ["TBD"], ["N", "TBD", "??"], ["shall", "XYZ"]])
def test_two_studies_with_different_token_lists_route_the_same_requirements(tokens) -> None:
    nodes = [
        _node("a", description="Latency shall not exceed TBD ms.", issues=[Issue.NOT_TESTABLE]),
        _node("b", description="Rate shall be ?? Hz.", issues=[Issue.NOT_TESTABLE]),
        _node("c", description="Force shall be 50 N.", issues=[Issue.NOT_TESTABLE]),
    ]
    client = _Client()

    propose_acceptance_criteria(nodes, _study(placeholder_tokens=tokens), client, [], table_text=lambda _id: None)

    assert list(client.calls[0]) == ["c"]
    assert [NEEDS_INPUT_TITLE in n.description for n in nodes] == [True, True, False]


def test_markers_that_routed_are_not_repeated_in_the_context_of_the_others() -> None:
    routed = _node("a", description="Latency shall not exceed TBD ms.", issues=[Issue.NOT_TESTABLE])
    asked = _node("b", description="Rate shall be N Hz.", issues=[Issue.NOT_TESTABLE])
    client = _Client()

    propose_acceptance_criteria([routed, asked], _study(placeholder_tokens=["TBD", "N"]), client, [], table_text=lambda _id: None)

    assert list(client.calls[0]) == ["b"]
    assert client.calls[0]["b"]["document_conventions"]["unresolved_markers"] == ["N"]


# -- the per-node context is computed from one plain text and shared lookups, and equals a straightforward computation --

def _reference_context(node, nodes, study, table_text):
    """The context the way it was first written: everything recomputed from scratch for the node."""
    from app.leveling.description_text import description_for_model
    from app.leveling.acceptance_criteria import contains_token
    by_id = {n.local_id: n for n in nodes}
    ancestors, parent = [], by_id.get(node.parent_local_id)
    while parent is not None and len(ancestors) < 4:
        ancestors.insert(0, parent.title)
        parent = by_id.get(parent.parent_local_id)
    roles = {r["table"]: r["role"] for r in study.table_roles}
    own = f"{node.title} {node.description}".casefold()
    return {
        "text": description_for_model(node.description),
        "tables": [
            {"id": t, "role": roles.get(t), "text": " ".join(table_text(t).split())}
            for t in node.table_ids[:3] if table_text(t)
        ],
        "ancestors": ancestors,
        "glossary": [g for g in study.glossary if g["term"].casefold() in own][:5],
        "markers": [t for t in study.placeholder_tokens if contains_token(description_for_model(node.description), t)],
    }


def _context_study():
    terms = ["Alpha", "BETA", "gamma", "Delta", "epsilon", "ZETA", "eta", "theta", "Straße", "unused"]
    return _study(
        glossary=[{"term": t, "definition": f"def {t}"} for t in terms],
        placeholder_tokens=["TBD", "XX", "P1"],
        verification_statements=["by test"], standards_cited=["STD-1"],
        table_roles=[{"table": "t1", "role": "limits"}, {"table": "t2", "role": "other"}],
    )


def test_the_context_equals_a_plain_recomputation_for_several_nodes(monkeypatch) -> None:
    from app.leveling import acceptance_criteria as module
    study = _context_study()
    root = _node("root", node_type=WorkItemType.EPIC, title="Root")
    feature = _node("feat", node_type=WorkItemType.FEATURE, parent="root", title="Feature")
    texts = {
        "many": "alpha beta GAMMA delta Epsilon zeta ETA theta strasse P1 value",  # 8 term hits: only the first 5 (in glossary order) are kept
        "few": "Only beta and STRASSE here, with P1 later: XX.",
        "none": "Nothing from the glossary at all.",
        "title": "plain body",
    }
    nodes = [root, feature]
    for name, text in texts.items():
        node = _node(name, description=f"<p>{text}</p>", parent="feat", issues=[Issue.NOT_TESTABLE], title="Alpha title" if name == "title" else name)
        node.table_ids = ["t1", "t2", "missing"] if name == "many" else ["t2"] if name == "few" else []
        nodes.append(node)
    nodes[-1].description = "<p>plain body</p>"
    tables = {"t1": "a   b\n1 2", "t2": "c d"}
    client = _Client()
    monkeypatch.setattr(module, "CHUNK_SIZE", 10)
    propose_acceptance_criteria(nodes, study, client, [], tables.get)
    items = {k: v for call in client.calls for k, v in call.items()}
    assert set(items) == {"many", "few", "none", "title"}
    for name in items:
        node = next(n for n in nodes if n.local_id == name)
        ref = _reference_context(node, nodes, study, tables.get)
        got = items[name]
        assert got["text"] == ref["text"]
        assert got["ancestors"] == ref["ancestors"] == ["Root", "Feature"]
        assert got["tables"] == ref["tables"]
        conv = got["document_conventions"]
        assert conv["glossary"] == ref["glossary"]
        assert conv["unresolved_markers"] == ref["markers"]
        assert conv["verification"] == ["by test"] and conv["standards"] == ["STD-1"]
    assert [g["term"] for g in items["many"]["document_conventions"]["glossary"]] == ["Alpha", "BETA", "gamma", "Delta", "epsilon"]
    assert [g["term"] for g in items["title"]["document_conventions"]["glossary"]] == ["Alpha"]  # a title hit counts
    assert items["many"]["tables"][0]["role"] == "limits" and items["few"]["tables"][0]["role"] == "other"


def test_the_plain_text_of_a_node_is_computed_once_per_call(monkeypatch) -> None:
    from app.leveling import acceptance_criteria as module
    calls: list[str] = []
    real = module.description_for_model

    def spy(description):
        calls.append(description)
        return real(description)

    monkeypatch.setattr(module, "description_for_model", spy)
    study = _context_study()
    nodes = [_node(f"n{i}", description=f"<p>alpha beta P1 {i}</p>", issues=[Issue.NOT_TESTABLE]) for i in range(7)]
    nodes.append(_node("marked", description="<p>The value is TBD.</p>", issues=[Issue.NOT_TESTABLE]))  # decided by code, never sent
    propose_acceptance_criteria(nodes, study, _Client(), [], lambda table_id: None)
    assert len(calls) == len(nodes)  # one per node, whichever way it was routed


def test_the_casefolded_glossary_and_table_roles_are_built_once_per_call(monkeypatch) -> None:
    class Counting(dict):
        reads = 0

        def __getitem__(self, key):
            if key == "term":
                Counting.reads += 1
            return super().__getitem__(key)

        def get(self, key, default=None):
            if key == "term":
                Counting.reads += 1
            return super().get(key, default)

    class CountingRoles(list):
        scans = 0

        def __iter__(self):
            CountingRoles.scans += 1
            return super().__iter__()

    study = _context_study()
    study.glossary = [Counting(g) for g in study.glossary]
    study.table_roles = CountingRoles(study.table_roles)
    nodes = [_node(f"n{i}", description="<p>nothing</p>", issues=[Issue.NOT_TESTABLE]) for i in range(20)]
    propose_acceptance_criteria(nodes, study, _Client(), [], lambda table_id: None)
    assert Counting.reads == len(study.glossary)  # each term read once for the whole call, not once per node
    assert CountingRoles.scans == 1  # the table-roles mapping is built once too


def test_the_glossary_keeps_at_most_five_matches_in_glossary_order() -> None:
    study = _study(glossary=[{"term": "x", "definition": f"d{i}"} for i in range(200)])
    node = _node("a", description="<p>x</p>", issues=[Issue.NOT_TESTABLE])
    client = _Client()
    propose_acceptance_criteria([node], study, client, [], lambda table_id: None)
    assert [g["definition"] for g in client.calls[0]["a"]["document_conventions"]["glossary"]] == [f"d{i}" for i in range(5)]


def test_a_malformed_glossary_entry_never_raises_and_never_matches() -> None:
    node = _node("a", description="The SRU shall do x.", issues=[Issue.NOT_TESTABLE])
    client = _Client()
    study = _study(glossary=[{"definition": "no term"}, {"term": None, "definition": "d"}, {"term": "SRU", "definition": "Shop replaceable unit"}])

    propose_acceptance_criteria([node], study, client, [], table_text=lambda _id: None)

    assert client.calls[0]["a"]["document_conventions"]["glossary"] == [{"term": "SRU", "definition": "Shop replaceable unit"}]
