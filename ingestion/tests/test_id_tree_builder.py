from app.canonical.model import SourceRef
from app.leveling.id_hierarchy import HierarchyRow
from app.leveling.id_tree_builder import build_hierarchy_subtree, recompute_child_types
from app.leveling.llm_leveling import _repair_requirement_hierarchy
from app.workitem.model import WorkItemType


def _sr(offset: int = 0) -> SourceRef:
    return SourceRef(document_path="x.docx", start_offset=offset, end_offset=offset + 1)


def _row(
    label: str,
    node_type: str | None,
    parent_index: int | None,
    id_text: str,
    has_shall: bool = False,
    source_ref: SourceRef | None = None,
    id_disambiguator_needed: bool = False,
    needs_synthesis: bool = False,
) -> HierarchyRow:
    return HierarchyRow(
        label=label, has_shall=has_shall, source_ref=source_ref or _sr(), node_type=node_type,
        parent_index=parent_index, id_text=id_text, id_disambiguator_needed=id_disambiguator_needed,
        needs_synthesis=needs_synthesis,
    )


def test_build_hierarchy_subtree_basic_construction() -> None:
    rows = [
        _row("Audio Control", "Feature", None, "1.1"),
        _row("The system shall control volume.", "Requirement", 0, "1.1.1", has_shall=True),
    ]
    nodes, warnings = build_hierarchy_subtree(rows, "det0_", None)
    assert warnings == []
    assert len(nodes) == 2
    parent = next(n for n in nodes if n.title == "Audio Control")
    child = next(n for n in nodes if n.type == WorkItemType.REQUIREMENT)
    assert child.parent_local_id == parent.local_id
    assert parent.local_id == "det0_1_1"
    assert parent.grounding_score == 1.0


def test_build_hierarchy_subtree_folds_a_non_producing_row() -> None:
    rows = [
        _row("Real Group", "Feature", None, "1"),
        _row("Lone Wrapper", None, 0, "1.1"),
        _row("The system shall do A.", "Requirement", 1, "1.1.1", has_shall=True),
    ]
    nodes, warnings = build_hierarchy_subtree(rows, "det0_", None)
    assert len(nodes) == 2  # the fold row produced no node of its own
    leaf = next(n for n in nodes if n.type == WorkItemType.REQUIREMENT)
    group = next(n for n in nodes if n.title == "Real Group")
    # The fold row's text is now part of the group's own description, and
    # the leaf (whose real parent WAS the fold row) attaches to the
    # nearest node-producing ancestor instead.
    assert "Lone Wrapper" in group.description
    assert leaf.parent_local_id == group.local_id


def test_build_hierarchy_subtree_warns_when_a_fold_row_has_no_producing_ancestor() -> None:
    rows = [_row("Orphan Fold", None, None, "1")]
    nodes, warnings = build_hierarchy_subtree(rows, "det0_", None)
    assert nodes == []
    assert any("no node-producing ancestor" in w for w in warnings)


def test_build_hierarchy_subtree_leaves_epic_requirement_violation_for_caller_to_repair() -> None:
    # build_hierarchy_subtree itself does NOT fix an Epic-with-a-direct-
    # Requirement-child violation -- that's the caller's job (see the
    # module's own NOTE comment for why: fixing it here by demoting the
    # parent's TYPE was confirmed live, via a real job, to be wrong
    # whenever the same parent also has a real Epic/Feature child).
    rows = [
        _row("Mislabeled Epic", "Epic", None, "1"),
        _row("The system shall do A.", "Requirement", 0, "1.1", has_shall=True),
    ]
    nodes, warnings = build_hierarchy_subtree(rows, "det0_", None)
    epic_node = next(n for n in nodes if n.title == "Mislabeled Epic")
    assert epic_node.type == WorkItemType.EPIC  # unfixed here, deliberately


def test_repair_requirement_hierarchy_fixes_the_epic_requirement_violation_after_build() -> None:
    # The caller's actual pipeline: build, then _repair_requirement_hierarchy
    # (llm_leveling's own, already-tested-for-the-LLM-path function) fixes
    # the violation by RE-PARENTING the Requirement, not by changing the
    # Epic's own type.
    rows = [
        _row("Mislabeled Epic", "Epic", None, "1"),
        _row("The system shall do A.", "Requirement", 0, "1.1", has_shall=True),
    ]
    nodes, warnings = build_hierarchy_subtree(rows, "det0_", None)
    _repair_requirement_hierarchy(nodes, "det0_", warnings)
    recompute_child_types(nodes)
    epic_node = next(n for n in nodes if n.title == "Mislabeled Epic")
    requirement_node = next(n for n in nodes if n.type == WorkItemType.REQUIREMENT)
    assert epic_node.type == WorkItemType.EPIC  # unchanged
    assert requirement_node.parent_local_id != epic_node.local_id  # re-parented away
    assert any("re-parented" in w for w in warnings)


def test_repair_requirement_hierarchy_keeps_a_real_epic_child_intact_in_a_mixed_case() -> None:
    # Confirmed live, real job, real bug: a node with BOTH a real Epic
    # child (from a deeper sub-domain) AND a stray direct Requirement
    # child (a short leaf statement at the same level) must have ONLY the
    # Requirement repaired -- the Epic child must stay exactly where it
    # is, never left parented under a Feature as a result of the parent's
    # own type being changed to fix the OTHER child.
    rows = [
        _row("Mixed Domain", "Epic", None, "1"),
        _row("Real Sub-Domain", "Epic", 0, "1.1"),
        _row("The system shall do A.", "Requirement", 1, "1.1.1", has_shall=True),
        # A stray direct Requirement under the SAME "Mixed Domain" parent --
        # this is the one that needs repair.
        _row("The system shall do B.", "Requirement", 0, "1.2", has_shall=True),
    ]
    nodes, warnings = build_hierarchy_subtree(rows, "det0_", None)
    _repair_requirement_hierarchy(nodes, "det0_", warnings)
    recompute_child_types(nodes)
    mixed_domain = next(n for n in nodes if n.title == "Mixed Domain")
    real_sub_domain = next(n for n in nodes if n.title == "Real Sub-Domain")
    stray_requirement = next(n for n in nodes if n.title == "The system shall do B.")
    assert mixed_domain.type == WorkItemType.EPIC
    assert real_sub_domain.type == WorkItemType.EPIC
    assert real_sub_domain.parent_local_id == mixed_domain.local_id  # untouched
    assert stray_requirement.parent_local_id != mixed_domain.local_id  # repaired away


def test_repair_requirement_hierarchy_bridges_orphans_locally_per_epic_not_globally() -> None:
    # Confirmed real bug, real job (AirPro deterministic-hierarchy run):
    # the repair's old fallback was "the branch's first Feature" -- on the
    # deterministic path the WHOLE DOCUMENT is one branch, so 114 stray
    # Requirements under unrelated Epics all got dumped onto ONE unrelated
    # Feature. Two separate root Epics, each with a stray direct
    # Requirement child and no Feature of its own anywhere -- each stray
    # Requirement must get its OWN local bridge Feature under its OWN
    # Epic, never share one, and never land under an unrelated Epic's
    # Feature either.
    rows = [
        _row("Epic Alpha", "Epic", None, "1"),
        _row("The system shall do A.", "Requirement", 0, "1.1", has_shall=True),
        _row("Epic Beta", "Epic", None, "2"),
        _row("The system shall do B.", "Requirement", 2, "2.1", has_shall=True),
    ]
    nodes, warnings = build_hierarchy_subtree(rows, "det0_", None)
    _repair_requirement_hierarchy(nodes, "det0_", warnings)
    recompute_child_types(nodes)
    epic_alpha = next(n for n in nodes if n.title == "Epic Alpha")
    epic_beta = next(n for n in nodes if n.title == "Epic Beta")
    req_a = next(n for n in nodes if n.title == "The system shall do A.")
    req_b = next(n for n in nodes if n.title == "The system shall do B.")
    bridge_alpha = next(n for n in nodes if n.local_id == req_a.parent_local_id)
    bridge_beta = next(n for n in nodes if n.local_id == req_b.parent_local_id)
    assert bridge_alpha.type == WorkItemType.FEATURE
    assert bridge_beta.type == WorkItemType.FEATURE
    assert bridge_alpha.local_id != bridge_beta.local_id  # own bridge per Epic, not shared
    assert bridge_alpha.parent_local_id == epic_alpha.local_id
    assert bridge_beta.parent_local_id == epic_beta.local_id


def test_build_hierarchy_subtree_uses_disambiguated_identity_hash_for_table_rows() -> None:
    # All rows from one Table share the SAME source_ref -- two
    # byte-identical leaf texts at different requirement IDs must not
    # hash-collide.
    shared_ref = _sr(5)
    rows = [
        _row("Group", "Feature", None, "1", source_ref=shared_ref, id_disambiguator_needed=True),
        _row(
            "The system shall comply.", "Requirement", 0, "1.1", has_shall=True,
            source_ref=shared_ref, id_disambiguator_needed=True,
        ),
        _row(
            "The system shall comply.", "Requirement", 0, "1.2", has_shall=True,
            source_ref=shared_ref, id_disambiguator_needed=True,
        ),
    ]
    nodes, warnings = build_hierarchy_subtree(rows, "det0_", None)
    requirement_nodes = [n for n in nodes if n.type == WorkItemType.REQUIREMENT]
    assert len(requirement_nodes) == 2
    assert requirement_nodes[0].identity_hash != requirement_nodes[1].identity_hash
    assert requirement_nodes[0].fidelity_hash == requirement_nodes[1].fidelity_hash


def test_build_hierarchy_subtree_child_type_reflects_real_children() -> None:
    rows = [
        _row("Epic Domain", "Epic", None, "1"),
        _row("Feature Child", "Feature", 0, "1.1"),
        _row("The system shall do A.", "Requirement", 1, "1.1.1", has_shall=True),
    ]
    nodes, warnings = build_hierarchy_subtree(rows, "det0_", None)
    recompute_child_types(nodes)
    epic_node = next(n for n in nodes if n.title == "Epic Domain")
    feature_node = next(n for n in nodes if n.title == "Feature Child")
    leaf_node = next(n for n in nodes if n.type == WorkItemType.REQUIREMENT)
    assert epic_node.child_type == WorkItemType.FEATURE
    assert feature_node.child_type == WorkItemType.REQUIREMENT
    assert leaf_node.child_type == WorkItemType.REQUIREMENT


def test_build_hierarchy_subtree_title_tag_client_is_fail_open() -> None:
    class RaisingClient:
        def title_and_tags_for_rows(self, texts_by_row_id):
            raise RuntimeError("boom")

    rows = [_row("The system shall do A.", "Requirement", None, "1", has_shall=True)]
    nodes, warnings = build_hierarchy_subtree(rows, "det0_", None, RaisingClient())
    assert len(nodes) == 1
    assert nodes[0].tags == []
    assert any("failed" in w for w in warnings)


def test_build_hierarchy_subtree_synthesizes_a_flagged_fragment_leaf() -> None:
    class FakeSynthesisClient:
        def synthesize_leaf_requirements(self, items_by_id):
            return {
                node_id: {
                    "title": "COTS power supply form factor",
                    "text": "The COTS power supply shall have a 3U, 1-inch form factor.",
                    "tags": ["interface"],
                }
                for node_id in items_by_id
            }

    rows = [
        _row("Power Supply", "Feature", None, "1"),
        _row('Size: 3U 1"', "Requirement", 0, "1.1", needs_synthesis=True),
    ]
    nodes, warnings = build_hierarchy_subtree(
        rows, "det0_", None, synthesis_client=FakeSynthesisClient(),
    )
    leaf = next(n for n in nodes if n.type == WorkItemType.REQUIREMENT)
    assert leaf.description == "The COTS power supply shall have a 3U, 1-inch form factor."
    assert leaf.title == "COTS power supply form factor"
    # grounding_score now compares synthesized text against the ORIGINAL
    # verbatim row label -- no longer the self-comparison bug
    # (_grounding_score(description, description), always 1.0).
    assert leaf.grounding_score is not None and leaf.grounding_score < 1.0


def test_build_hierarchy_subtree_synthesis_is_fail_open() -> None:
    class RaisingSynthesisClient:
        def synthesize_leaf_requirements(self, items_by_id):
            raise RuntimeError("boom")

    rows = [_row('Size: 3U 1"', "Requirement", None, "1", needs_synthesis=True)]
    nodes, warnings = build_hierarchy_subtree(
        rows, "det0_", None, synthesis_client=RaisingSynthesisClient(),
    )
    assert len(nodes) == 1
    assert nodes[0].description == 'Size: 3U 1"'  # kept verbatim, exactly as constructed
    assert any("synthesis" in w.lower() and "failed" in w.lower() for w in warnings)


def test_build_hierarchy_subtree_never_synthesizes_a_non_flagged_leaf() -> None:
    # A leaf whose subtree passed the requirement-shaped gate (needs_synthesis
    # False, the default) must never be sent to the synthesis client at all --
    # only flagged fragments should incur the extra LLM call.
    class RecordingSynthesisClient:
        def __init__(self):
            self.called = False

        def synthesize_leaf_requirements(self, items_by_id):
            self.called = True
            return {}

    client = RecordingSynthesisClient()
    rows = [_row("The system shall do A.", "Requirement", None, "1", has_shall=True)]
    build_hierarchy_subtree(rows, "det0_", None, synthesis_client=client)
    assert client.called is False
