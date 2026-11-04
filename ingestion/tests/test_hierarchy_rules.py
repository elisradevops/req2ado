from __future__ import annotations

from app.canonical.model import SourceRef
from app.leveling.hierarchy_rules import ensure_ladder, states_a_requirement, type_headings_by_shape
from app.workitem.model import WarningKind, WorkItemMode, WorkItemNode, WorkItemType

E, F, R = WorkItemType.EPIC, WorkItemType.FEATURE, WorkItemType.REQUIREMENT
_ALLOWED = {E: {E}, F: {E, F}, R: {F, R}}


def _tree(spec: list[tuple[str, str | None, str]]) -> list[WorkItemNode]:
    """(local_id, parent, title) in document order, all typed Requirement like the old depth rule did."""
    return [
        WorkItemNode(
            local_id=i, type=R, parent_local_id=p, title=t, description=f"body of {t}",
            source_ref=SourceRef(document_path="x.docx", start_offset=n, end_offset=n + 1),
            fidelity_hash="h", identity_hash=f"id{n}", tags=[], mode=WorkItemMode.BASELINE, child_type=R,
        )
        for n, (i, p, t) in enumerate(spec)
    ]


def _ladder(nodes: list[WorkItemNode]) -> list[WorkItemNode]:
    type_headings_by_shape(nodes)
    ensure_ladder(nodes, "Doc Title", [])
    return nodes


def _assert_valid(nodes: list[WorkItemNode]) -> None:
    by_id = {n.local_id: n for n in nodes}
    for n in nodes:
        parent = by_id.get(n.parent_local_id) if n.parent_local_id else None
        if parent is None:
            assert n.type == E, f"parentless {n.type.value}: {n.title}"
        else:
            assert parent.type in _ALLOWED[n.type], f"{n.type.value} under {parent.type.value}: {n.title}"


def _by_id(nodes):
    return {n.local_id: n for n in nodes}


def test_the_signal_is_an_obligation_modal_in_the_heading_itself() -> None:
    assert states_a_requirement("The remote shall increase the volume")
    assert states_a_requirement("Output MUST stay below 3.3V")
    assert not states_a_requirement("Power Distribution")
    assert not states_a_requirement("")


def test_headings_with_no_level_one_become_a_valid_ladder_and_keep_their_nesting() -> None:
    nodes = _ladder(_tree([
        ("a", None, "Interfaces"), ("b", "a", "Power"), ("c", "b", "Voltage limit"), ("d", "b", "Current limit"),
        ("e", "a", "Data"), ("f", "e", "Baud rate"),
    ]))
    t = _by_id(nodes)
    assert (t["a"].type, t["b"].type, t["c"].type) == (E, F, R)
    assert t["b"].parent_local_id == "a" and t["c"].parent_local_id == "b"  # nesting exactly as the headings give it
    _assert_valid(nodes)


def test_a_feature_may_hold_features_and_nothing_is_hoisted_or_demoted() -> None:
    nodes = _ladder(_tree([
        ("a", None, "L1"), ("b", "a", "L2"), ("c", "b", "L3"), ("d", "c", "L4"), ("e", "d", "Leaf requirement"),
    ]))
    t = _by_id(nodes)
    assert [t[i].type for i in "abcd"] == [E, F, F, F]
    assert [t[i].parent_local_id for i in "bcde"] == ["a", "b", "c", "d"]
    assert t["e"].type == R
    _assert_valid(nodes)


def test_a_requirement_statement_keeps_its_sub_requirements_nested_under_it() -> None:
    nodes = _ladder(_tree([
        ("a", None, "Control"), ("b", "a", "The unit shall switch sources"), ("c", "b", "Dismiss suggestion"),
        ("d", "b", "Multiple sources"),
    ]))
    t = _by_id(nodes)
    assert t["b"].type == R and t["c"].type == R and t["c"].parent_local_id == "b"
    assert t["a"].type == F
    _assert_valid(nodes)


def test_a_heading_with_a_modal_but_a_sub_section_is_a_section_not_a_statement() -> None:
    nodes = _ladder(_tree([
        ("a", None, "Top"), ("b", "a", "The unit must report a fault"), ("c", "b", "Detail"), ("d", "c", "Leaf"),
    ]))
    assert _by_id(nodes)["b"].type == F
    _assert_valid(nodes)


def test_an_epic_with_direct_requirements_gets_one_same_title_feature_to_hold_them() -> None:
    nodes = _tree([("a", None, "Platform"), ("b", "a", "Boot"), ("c", "b", "Boot time"), ("d", "a", "Loose requirement")])
    warnings: list = []
    type_headings_by_shape(nodes)
    ensure_ladder(nodes, "Doc Title", warnings)
    bridges = [n for n in nodes if n.local_id == "synth_feature_a"]
    assert len(bridges) == 1 and bridges[0].title == "Platform" and bridges[0].parent_local_id == "a"
    assert _by_id(nodes)["d"].parent_local_id == "synth_feature_a"
    assert WarningKind.BRIDGE_FEATURE_SYNTHESIZED in [w.kind for w in warnings]
    assert bridges[0].identity_hash not in {n.identity_hash for n in nodes if n is not bridges[0]}
    _assert_valid(nodes)


def test_a_top_level_section_with_only_leaves_goes_under_one_epic_titled_from_the_document() -> None:
    nodes = _ladder(_tree([
        ("s1", None, "Section one"), ("r1", "s1", "Req one"), ("s2", None, "Section two"), ("r2", "s2", "Req two"),
    ]))
    t = _by_id(nodes)
    doc_epic = t["synth_doc_epic"]
    assert doc_epic.type == E and doc_epic.parent_local_id is None and doc_epic.title == "Doc Title"
    assert t["s1"].type == F and t["s1"].parent_local_id == "synth_doc_epic"
    assert t["s2"].type == F and t["s2"].parent_local_id == "synth_doc_epic"
    assert len([n for n in nodes if n.type == E]) == 1
    _assert_valid(nodes)


def test_a_parentless_requirement_goes_under_a_feature_under_the_document_epic() -> None:
    nodes = _ladder(_tree([("lone", None, "A lone requirement")]))
    t = _by_id(nodes)
    feature = t[t["lone"].parent_local_id]
    assert feature.type == F and feature.title == "Doc Title"
    assert t[feature.parent_local_id].type == E and t[feature.parent_local_id].parent_local_id is None
    _assert_valid(nodes)


def test_a_feature_under_a_requirement_moves_up_and_an_existing_ladder_is_left_alone() -> None:
    nodes = _tree([("e", None, "Epic"), ("f", "e", "Feature"), ("r", "f", "Req"), ("f2", "r", "Odd feature")])
    nodes[0].type, nodes[1].type, nodes[3].type = E, F, F
    before = [(n.local_id, n.type) for n in nodes]
    ensure_ladder(nodes, "Doc Title", [])
    t = _by_id(nodes)
    assert t["f2"].parent_local_id == "f"
    assert [(n.local_id, n.type) for n in nodes] == before
    _assert_valid(nodes)


def test_only_type_and_parent_change_and_nothing_is_dropped() -> None:
    nodes = _tree([("a", None, "Interfaces"), ("b", "a", "Power"), ("c", "b", "Voltage limit"), ("z", None, "Alone")])
    keep = {n.local_id: (n.title, n.description, n.source_ref, n.fidelity_hash, n.identity_hash) for n in nodes}
    _ladder(nodes)
    for n in nodes:
        if n.local_id in keep:
            assert (n.title, n.description, n.source_ref, n.fidelity_hash, n.identity_hash) == keep[n.local_id]
    assert set(keep) <= {n.local_id for n in nodes}


def test_a_customer_id_stays_on_a_requirement_and_is_dropped_from_a_node_that_becomes_a_container() -> None:
    nodes = _tree([("a", None, "Section"), ("b", "a", "Leaf")])
    nodes[0].customer_id, nodes[1].customer_id = "1.1", "1.1.1"
    type_headings_by_shape(nodes)
    assert nodes[0].type == F and nodes[0].customer_id is None
    assert nodes[1].customer_id == "1.1.1"


def test_applying_the_ladder_twice_changes_nothing() -> None:
    nodes = _ladder(_tree([
        ("a", None, "Interfaces"), ("b", "a", "Power"), ("c", "b", "Voltage"), ("d", "a", "Loose"), ("z", None, "Alone"),
    ]))
    snapshot = [(n.local_id, n.type, n.parent_local_id) for n in nodes]
    ensure_ladder(nodes, "Doc Title", [])
    assert [(n.local_id, n.type, n.parent_local_id) for n in nodes] == snapshot


def test_an_empty_tree_is_a_no_op() -> None:
    ensure_ladder([], "Doc Title", [])
    type_headings_by_shape([])


def test_a_scoped_ladder_completes_only_the_scoped_nodes_and_leaves_the_rest_untouched() -> None:
    from app.leveling.hierarchy_rules import scope_with_ancestors

    nodes = _tree([("a", None, "Doc section"), ("b", "a", "Doc req"), ("m", None, "Model feature"), ("n", "m", "Model req")])
    nodes[0].type, nodes[2].type = F, F
    scope = scope_with_ancestors([nodes[1]], nodes)
    assert scope == {"a", "b"}
    ensure_ladder(nodes, "Doc Title", [], scope=scope)
    t = _by_id(nodes)
    assert t["a"].parent_local_id == "synth_doc_epic" and t["synth_doc_epic"].type == E
    assert t["m"].parent_local_id is None and t["m"].type == F  # model node: not touched
    assert t["m"].child_type is not None


def test_a_non_structural_child_such_as_front_matter_does_not_make_its_parent_a_section() -> None:
    nodes = _tree([("h", None, "First heading"), ("fm", "h", "Front Matter: doc")])
    type_headings_by_shape(nodes, non_structural_ids={"fm"})
    assert nodes[0].type == R and nodes[1].type == R


def test_a_parent_cycle_does_not_hang_the_rules() -> None:
    nodes = _tree([("a", "b", "A"), ("b", "a", "B")])
    type_headings_by_shape(nodes)
    ensure_ladder(nodes, "Doc Title", [])


def test_a_second_scoped_run_reuses_the_synthetic_nodes_of_the_first_even_for_a_node_restored_later() -> None:
    from app.leveling.hierarchy_rules import scope_with_ancestors

    nodes = _tree([("a", None, "Section"), ("b", "a", "Leaf")])
    nodes[0].type = F
    ensure_ladder(nodes, "Doc Title", [], scope=scope_with_ancestors(nodes[:1], nodes))
    assert [n.local_id for n in nodes].count("synth_doc_epic") == 1
    # A document node that was lost and restored afterwards, with no parent: it is not under the Epic from the first run,
    # so that Epic is not among its ancestors, yet the second run must attach it to the existing Epic and Feature.
    late = _tree([("late", None, "Restored requirement")])[0]
    nodes.append(late)
    ensure_ladder(nodes, "Doc Title", [], scope=scope_with_ancestors([late], nodes))
    ids = [n.local_id for n in nodes]
    assert len(ids) == len(set(ids)), "a synthetic id was created twice"
    assert late.parent_local_id == "synth_feature_synth_doc_epic"


def test_a_second_run_does_not_duplicate_an_epics_same_title_feature() -> None:
    nodes = _tree([("a", None, "Platform"), ("b", "a", "Boot"), ("c", "b", "Boot time"), ("d", "a", "Loose")])
    type_headings_by_shape(nodes)
    ensure_ladder(nodes, "Doc Title", [])
    late = _tree([("e", "a", "Added later")])[0]
    nodes.append(late)
    ensure_ladder(nodes, "Doc Title", [])
    ids = [n.local_id for n in nodes]
    assert len(ids) == len(set(ids)) and late.parent_local_id == "synth_feature_a"
