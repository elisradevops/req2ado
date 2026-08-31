from app.canonical.model import SourceRef, Table, TableCell
from app.distillation.description import assemble_description
from app.leveling.id_hierarchy import HierarchyRow
from app.leveling.id_tree_builder import (
    _PARENT_SUMMARY_TOKEN_BUDGET,
    _apply_parent_summary_pass,
    build_hierarchy_subtree,
    recompute_child_types,
)
from app.leveling.llm_leveling import _repair_requirement_hierarchy
from app.leveling.narration_publisher import LevelingProgress
from app.leveling.tree_builder import _table_to_html
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
    id_text_is_authored: bool = False,
) -> HierarchyRow:
    return HierarchyRow(
        label=label, has_shall=has_shall, source_ref=source_ref or _sr(), node_type=node_type,
        parent_index=parent_index, id_text=id_text, id_disambiguator_needed=id_disambiguator_needed,
        needs_synthesis=needs_synthesis, id_text_is_authored=id_text_is_authored,
    )


def test_build_hierarchy_subtree_basic_construction() -> None:
    rows = [
        _row("Audio Control", "Feature", None, "1.1"),
        _row("The system shall control volume.", "Requirement", 0, "1.1.1", has_shall=True),
    ]
    nodes, warnings = build_hierarchy_subtree(rows, "det0_")
    assert warnings == []
    assert len(nodes) == 2
    parent = next(n for n in nodes if n.title == "Audio Control")
    child = next(n for n in nodes if n.type == WorkItemType.REQUIREMENT)
    assert child.parent_local_id == parent.local_id
    assert parent.local_id == "det0_1_1"
    assert parent.grounding_score == 1.0


def test_build_hierarchy_subtree_never_extracts_a_customer_id_for_a_convention_with_no_real_id_text() -> None:
    # Confirmed real bug, live (AirPro_BP_ICD_Revision_0.3.docx, convention
    # 3 -- id_text_is_authored defaults False, matching _row's own
    # default): convention 3 has NO id concept at all (see
    # rows_from_heading_structure's own docstring), so scanning a leaf's
    # own free-flowing requirement text for anything code-shaped matched
    # an unrelated industry-standard citation or a cited component part
    # number as if it were the row's own customer-assigned code -- 47 of
    # 428 real Requirements on that document, none of them real customer
    # IDs. This exact shape (a "shall" sentence citing "VITA62.0-2022")
    # must now stay None.
    rows = [
        _row(
            "PS_SYSRESET shall comply to SOSA 2.0/Para 13.2.6.5 & VITA62.0-2022[12V-only Profile]/para 4.6.3.3.",
            "Requirement", None, "h1", has_shall=True,
        ),
    ]
    nodes, _warnings = build_hierarchy_subtree(rows, "det0_")
    assert nodes[0].customer_id is None


def test_build_hierarchy_subtree_still_extracts_a_customer_id_when_the_convention_has_a_real_id_text() -> None:
    # Conventions 1/2 (id_text_is_authored=True) are unaffected -- a
    # genuine customer-assigned code embedded in the row's own text still
    # wins, exactly as before this fix.
    rows = [
        _row(
            "REQ-AV-014: The system shall control cabin lighting.",
            "Requirement", None, "1.1", has_shall=True, id_text_is_authored=True,
        ),
    ]
    nodes, _warnings = build_hierarchy_subtree(rows, "det0_")
    assert nodes[0].customer_id == "REQ-AV-014"


def test_build_hierarchy_subtree_falls_back_to_the_authored_numeric_id_only_for_conventions_1_and_2() -> None:
    # The numeric id_text fallback was already gated on id_text_is_authored
    # before this fix -- confirms that gate is preserved, not just the new
    # alphanumeric-extraction gate.
    rows = [
        _row("The system shall control volume.", "Requirement", None, "1.1.1", has_shall=True, id_text_is_authored=True),
        _row("The system shall control brightness.", "Requirement", None, "h1", has_shall=True),
    ]
    nodes, _warnings = build_hierarchy_subtree(rows, "det0_")
    by_desc = {n.description: n for n in nodes}
    assert by_desc["The system shall control volume."].customer_id == "1.1.1"
    assert by_desc["The system shall control brightness."].customer_id is None


def test_build_hierarchy_subtree_folds_a_non_producing_row() -> None:
    rows = [
        _row("Real Group", "Feature", None, "1"),
        _row("Lone Wrapper", None, 0, "1.1"),
        _row("The system shall do A.", "Requirement", 1, "1.1.1", has_shall=True),
    ]
    nodes, warnings = build_hierarchy_subtree(rows, "det0_")
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
    nodes, warnings = build_hierarchy_subtree(rows, "det0_")
    assert nodes == []
    assert any("no node-producing ancestor" in w.raw for w in warnings)


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
    nodes, warnings = build_hierarchy_subtree(rows, "det0_")
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
    nodes, warnings = build_hierarchy_subtree(rows, "det0_")
    _repair_requirement_hierarchy(nodes, "det0_", warnings)
    recompute_child_types(nodes)
    epic_node = next(n for n in nodes if n.title == "Mislabeled Epic")
    requirement_node = next(n for n in nodes if n.type == WorkItemType.REQUIREMENT)
    assert epic_node.type == WorkItemType.EPIC  # unchanged
    assert requirement_node.parent_local_id != epic_node.local_id  # re-parented away
    assert any("re-parented" in w.raw for w in warnings)


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
    nodes, warnings = build_hierarchy_subtree(rows, "det0_")
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
    nodes, warnings = build_hierarchy_subtree(rows, "det0_")
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
    nodes, warnings = build_hierarchy_subtree(rows, "det0_")
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
    nodes, warnings = build_hierarchy_subtree(rows, "det0_")
    recompute_child_types(nodes)
    epic_node = next(n for n in nodes if n.title == "Epic Domain")
    feature_node = next(n for n in nodes if n.title == "Feature Child")
    leaf_node = next(n for n in nodes if n.type == WorkItemType.REQUIREMENT)
    assert epic_node.child_type == WorkItemType.FEATURE
    assert feature_node.child_type == WorkItemType.REQUIREMENT
    assert leaf_node.child_type == WorkItemType.REQUIREMENT


def _epic_feature_requirement_nodes():
    rows = [
        _row("Controls:", "Epic", None, "1"),
        _row("Over 28V VDC input", "Feature", 0, "1.1"),
        _row("The system shall clamp input over 28V.", "Requirement", 1, "1.1.1", has_shall=True),
    ]
    nodes, _ = build_hierarchy_subtree(rows, "det0_")
    recompute_child_types(nodes)
    return nodes


def test_apply_parent_summary_pass_replaces_verbatim_title_and_gives_a_distinct_description() -> None:
    class FakeParentSummaryClient:
        def summarize_parent_nodes(self, nodes_by_id):
            return {
                node_id: {"title": f"Synthesized: {entry['title']}", "description": "A synthesized capability summary."}
                for node_id, entry in nodes_by_id.items()
            }

    nodes = _epic_feature_requirement_nodes()
    warnings: list[str] = []
    feature = next(n for n in nodes if n.type == WorkItemType.FEATURE)
    epic = next(n for n in nodes if n.type == WorkItemType.EPIC)

    _apply_parent_summary_pass(nodes, [feature.local_id], FakeParentSummaryClient(), warnings)
    _apply_parent_summary_pass(nodes, [epic.local_id], FakeParentSummaryClient(), warnings)

    assert warnings == []
    assert feature.title == "Synthesized: Over 28V VDC input"
    assert feature.description == "A synthesized capability summary."
    assert feature.title != feature.description
    assert epic.title == "Synthesized: Controls:"
    assert epic.description == "A synthesized capability summary."
    assert epic.title != epic.description


def test_apply_parent_summary_pass_recomputes_grounding_score_against_descendant_text_not_a_self_comparison() -> None:
    # Descendant requirement text shares almost no vocabulary with the
    # synthesized summary the FakeParentSummaryClient returns -- if
    # grounding_score were still a frozen self-comparison (the pre-fix
    # bug, mirroring the same one already fixed in _apply_synthesis_pass),
    # it would stay at 1.0 regardless of this mismatch.
    class FakeParentSummaryClient:
        def summarize_parent_nodes(self, nodes_by_id):
            return {
                node_id: {"title": f"Synthesized: {entry['title']}", "description": "A synthesized capability summary."}
                for node_id, entry in nodes_by_id.items()
            }

    nodes = _epic_feature_requirement_nodes()
    warnings: list[str] = []
    feature = next(n for n in nodes if n.type == WorkItemType.FEATURE)

    _apply_parent_summary_pass(nodes, [feature.local_id], FakeParentSummaryClient(), warnings)

    assert warnings == []
    assert feature.grounding_score < 1.0


def test_apply_parent_summary_pass_preserves_already_embedded_table_content_but_not_figure_captions() -> None:
    # Real, root-caused bug (confirmed live against a real SURVEY job): the
    # heading-span-claiming loop in _detect_deterministic_subtrees folds a
    # table's HTML into a node's description via assemble_description,
    # pairing that with node.table_ids in the same breath -- BEFORE this
    # pass runs. This pass replaces the whole description with a fresh
    # summary; without preserving the already-embedded content,
    # node.table_ids would keep pointing at content no longer anywhere in
    # the description (a "Table tN" chip with zero content, the exact
    # invariant violation Task 5 already fixed once for the LLM-authored
    # path).
    #
    # Figures get no equivalent re-embed: a figure caption is never folded
    # into description text at all (removed per explicit user request --
    # the Figures UI section already renders thumbnail + caption
    # independently of this text, via node.figure_ids alone), so there is
    # nothing here for this pass to preserve.
    class FakeParentSummaryClient:
        def summarize_parent_nodes(self, nodes_by_id):
            return {
                node_id: {"title": entry["title"], "description": "A synthesized capability summary."}
                for node_id, entry in nodes_by_id.items()
            }

    nodes = _epic_feature_requirement_nodes()
    warnings: list[str] = []
    feature = next(n for n in nodes if n.type == WorkItemType.FEATURE)

    table = Table(
        id="t1",
        cells=[[TableCell(text="Rail"), TableCell(text="Voltage")]],
        source_ref=_sr(),
    )
    table_html = _table_to_html(table)
    assert table_html  # sanity: this fixture table really does produce real HTML
    feature.description = assemble_description(feature.description, table_html)
    feature.table_ids = [table.id]
    feature.figure_ids = ["f1"]

    _apply_parent_summary_pass(
        nodes, [feature.local_id], FakeParentSummaryClient(), warnings,
        tables_by_id={table.id: table},
    )

    assert warnings == []
    assert "A synthesized capability summary." in feature.description
    assert table_html in feature.description
    assert "Figure" not in feature.description


def test_apply_parent_summary_pass_grounding_score_is_not_deflated_by_reembedded_table_html() -> None:
    # M1: grounding_score must be computed against the summary text captured
    # BEFORE the table-HTML re-embed loop runs, not the final post-embed
    # description -- a re-embedded table's cell content was folded into
    # THIS node's own span (never any descendant leaf's), so by
    # construction it cannot overlap with descendant requirement text; if
    # scoring ran after the embed, that irrelevant table vocabulary would
    # dilute the ratio and systematically deflate the score for every
    # table-bearing parent. The summary text below shares real vocabulary
    # with the descendant requirement's own text ("clamp input over 28V"),
    # so the score should be identical whether or not an unrelated table
    # gets folded in afterward.
    summary_text = "The system shall clamp input over 28V."

    class FakeParentSummaryClient:
        def summarize_parent_nodes(self, nodes_by_id):
            return {node_id: {"title": entry["title"], "description": summary_text} for node_id, entry in nodes_by_id.items()}

    nodes_without_table = _epic_feature_requirement_nodes()
    warnings: list[str] = []
    feature_without_table = next(n for n in nodes_without_table if n.type == WorkItemType.FEATURE)
    _apply_parent_summary_pass(nodes_without_table, [feature_without_table.local_id], FakeParentSummaryClient(), warnings)

    nodes_with_table = _epic_feature_requirement_nodes()
    feature_with_table = next(n for n in nodes_with_table if n.type == WorkItemType.FEATURE)
    table = Table(
        id="t1",
        cells=[[TableCell(text="Zebra"), TableCell(text="Nebula Quasar Combobulator")]],
        source_ref=_sr(),
    )
    table_html = _table_to_html(table)
    assert table_html  # sanity: this fixture table really does produce real HTML
    feature_with_table.table_ids = [table.id]
    _apply_parent_summary_pass(
        nodes_with_table, [feature_with_table.local_id], FakeParentSummaryClient(), warnings,
        tables_by_id={table.id: table},
    )

    assert warnings == []
    assert table_html in feature_with_table.description  # sanity: table really got embedded
    assert feature_with_table.grounding_score == feature_without_table.grounding_score
    assert feature_with_table.grounding_score > 0.0


def test_apply_parent_summary_pass_sees_a_nested_sub_requirement_not_just_the_direct_child() -> None:
    # Real hierarchy rule (id_hierarchy.classify_by_nesting's own
    # docstring): "a Requirement MAY be a child of a Requirement
    # (sub-Req)". An Epic whose direct child is a Requirement that ITSELF
    # has a nested sub-Requirement must see BOTH -- not just the direct
    # child's own text, which is what a direct-children-only payload
    # would have missed.
    rows = [
        _row("Controls:", "Epic", None, "1"),
        _row("The system shall support mode A.", "Requirement", 0, "1.1", has_shall=True),
        _row("The system shall also support mode A fallback.", "Requirement", 1, "1.1.a", has_shall=True),
    ]
    nodes, _ = build_hierarchy_subtree(rows, "det0_")
    recompute_child_types(nodes)
    epic = next(n for n in nodes if n.type == WorkItemType.EPIC)
    requirements = [n for n in nodes if n.type == WorkItemType.REQUIREMENT]
    assert len(requirements) == 2  # confirms the fixture actually nests one Requirement under another

    seen_payloads: list[dict] = []

    class RecordingClient:
        def summarize_parent_nodes(self, nodes_by_id):
            seen_payloads.append(nodes_by_id[epic.local_id])
            return {node_id: {"title": "Synthesized Epic", "description": "Covers mode A."} for node_id in nodes_by_id}

    _apply_parent_summary_pass(nodes, [epic.local_id], RecordingClient(), [])

    seen_titles = seen_payloads[0]["requirement_titles"]
    assert len(seen_titles) == 2
    assert all(r.title in seen_titles for r in requirements)


def test_apply_parent_summary_pass_gives_each_nested_epic_its_own_full_rollup_in_one_unordered_call() -> None:
    # Real hierarchy rule: "an Epic child of an Epic (sub-Epic)". A single
    # combined call over BOTH epics (any order -- this is exactly how
    # _apply_det_parent_summary now invokes this function, no more
    # Feature-before-Epic rounds) must give the grandparent Epic its own
    # full descendant rollup independently -- it must not depend on the
    # child Epic having already been summarized first.
    rows = [
        _row("Grandparent Domain", "Epic", None, "1"),
        _row("Child Domain", "Epic", 0, "1.1"),
        _row("The system shall do X.", "Requirement", 1, "1.1.1", has_shall=True),
    ]
    nodes, _ = build_hierarchy_subtree(rows, "det0_")
    recompute_child_types(nodes)
    epics = [n for n in nodes if n.type == WorkItemType.EPIC]
    assert len(epics) == 2  # confirms the fixture actually nests one Epic under another
    grandparent = next(n for n in epics if n.parent_local_id is None)
    child_epic = next(n for n in epics if n.parent_local_id == grandparent.local_id)

    seen_payloads: dict[str, dict] = {}

    class RecordingClient:
        def summarize_parent_nodes(self, nodes_by_id):
            seen_payloads.update(nodes_by_id)
            return {node_id: {"title": f"Synthesized {node_id}", "description": "A rollup summary."} for node_id in nodes_by_id}

    # Both epics in ONE call, together -- proves no ordering is required.
    _apply_parent_summary_pass(nodes, [grandparent.local_id, child_epic.local_id], RecordingClient(), [])

    # The grandparent's own payload already contains the requirement text
    # nested two levels down (through the child Epic), independent of
    # whether the child Epic's own entry in the SAME call was processed
    # first, last, or not requested at all.
    assert seen_payloads[grandparent.local_id]["requirement_titles"] == ["The system shall do X."]
    assert grandparent.title == f"Synthesized {grandparent.local_id}"
    assert child_epic.title == f"Synthesized {child_epic.local_id}"


def test_apply_parent_summary_pass_splits_by_token_budget_without_dropping_any_parent() -> None:
    # Real gap this closes (confirmed on a real 554-node AirPro job): a
    # parent's rollup payload grows with its subtree size, not a fixed
    # per-item size -- a plain node-count chunk size does nothing to bound
    # that. Each of these 20 Features has a long enough description that
    # they collectively blow past _PARENT_SUMMARY_TOKEN_BUDGET well before
    # 150 items (the node-count ceiling) -- must still all go out, just
    # split across more than one call.
    long_text = "shall support mode A " * 400  # ~2200 chars, comfortably over budget/20
    rows = []
    for i in range(20):
        rows.append(_row(f"Feature {i}", "Feature", None, str(i + 1)))
        rows.append(_row(long_text, "Requirement", len(rows) - 1, f"{i + 1}.1", has_shall=True))
    nodes, _ = build_hierarchy_subtree(rows, "det0_")
    recompute_child_types(nodes)
    features = [n for n in nodes if n.type == WorkItemType.FEATURE]
    assert len(features) == 20

    call_count = 0

    class RecordingClient:
        def summarize_parent_nodes(self, nodes_by_id):
            nonlocal call_count
            call_count += 1
            return {node_id: {"title": f"Synthesized {node_id}", "description": "A rollup summary."} for node_id in nodes_by_id}

    warnings: list[str] = []
    _apply_parent_summary_pass(nodes, [f.local_id for f in features], RecordingClient(), warnings)

    assert call_count > 1  # proves the budget actually forced a split
    assert warnings == []
    # Completeness: every single Feature was still summarized, none
    # dropped or left at its verbatim heading because it landed in a
    # "later" chunk.
    assert all(f.title == f"Synthesized {f.local_id}" for f in features)


def test_apply_parent_summary_pass_never_splits_a_single_oversized_parent_it_just_sends_it_alone() -> None:
    # Completeness over cost: even a parent whose OWN rollup alone exceeds
    # the token budget must still go out whole in one call (alone), never
    # truncated and never dropped.
    huge_text = "shall support mode A " * 2000  # comfortably over the whole budget by itself
    rows = [
        _row("Huge Feature", "Feature", None, "1"),
        _row(huge_text, "Requirement", 0, "1.1", has_shall=True),
    ]
    nodes, _ = build_hierarchy_subtree(rows, "det0_")
    recompute_child_types(nodes)
    feature = next(n for n in nodes if n.type == WorkItemType.FEATURE)

    seen: list[dict] = []

    class RecordingClient:
        def summarize_parent_nodes(self, nodes_by_id):
            seen.append(nodes_by_id)
            return {node_id: {"title": "Synthesized", "description": "A rollup summary."} for node_id in nodes_by_id}

    _apply_parent_summary_pass(nodes, [feature.local_id], RecordingClient(), [])

    assert len(seen) == 1
    assert feature.title == "Synthesized"
    assert len("".join(seen[0][feature.local_id]["requirement_descriptions"])) // 4 > _PARENT_SUMMARY_TOKEN_BUDGET


def test_apply_parent_summary_pass_is_fail_open() -> None:
    class RaisingClient:
        def summarize_parent_nodes(self, nodes_by_id):
            raise RuntimeError("boom")

    nodes = _epic_feature_requirement_nodes()
    warnings: list[str] = []
    feature = next(n for n in nodes if n.type == WorkItemType.FEATURE)
    original_title = feature.title
    original_description = feature.description

    _apply_parent_summary_pass(nodes, [feature.local_id], RaisingClient(), warnings)

    assert feature.title == original_title
    assert feature.description == original_description
    assert any("failed" in w.raw for w in warnings)


def test_apply_parent_summary_pass_fires_chunk_warning_alongside_the_appended_warning() -> None:
    # docs/ui-progress-review.md item #3: a chunk failure must be visible
    # LIVE (via progress_callback), not just in the final post-completion
    # warnings list -- both must carry the SAME message.
    class RaisingClient:
        def summarize_parent_nodes(self, nodes_by_id):
            raise RuntimeError("boom")

    nodes = _epic_feature_requirement_nodes()
    warnings: list[str] = []
    feature = next(n for n in nodes if n.type == WorkItemType.FEATURE)
    fired: list[LevelingProgress] = []

    _apply_parent_summary_pass(nodes, [feature.local_id], RaisingClient(), warnings, progress_callback=fired.append)

    assert len(fired) == 1
    assert fired[0].phase == "chunk_warning"
    assert fired[0].warning_message == warnings[0].raw


def test_apply_parent_summary_pass_no_op_when_no_parent_ids() -> None:
    class RaisingIfCalledClient:
        def summarize_parent_nodes(self, nodes_by_id):
            raise AssertionError("must not be called when parent_node_ids is empty")

    nodes = _epic_feature_requirement_nodes()
    warnings: list[str] = []
    _apply_parent_summary_pass(nodes, [], RaisingIfCalledClient(), warnings)
    assert warnings == []


def test_build_hierarchy_subtree_title_tag_client_is_fail_open() -> None:
    class RaisingClient:
        def title_and_tags_for_rows(self, texts_by_row_id):
            raise RuntimeError("boom")

    rows = [_row("The system shall do A.", "Requirement", None, "1", has_shall=True)]
    nodes, warnings = build_hierarchy_subtree(rows, "det0_", RaisingClient())
    assert len(nodes) == 1
    assert nodes[0].tags == []
    assert any("failed" in w.raw for w in warnings)


def test_build_hierarchy_subtree_title_tag_failure_fires_chunk_warning() -> None:
    class RaisingClient:
        def title_and_tags_for_rows(self, texts_by_row_id):
            raise RuntimeError("boom")

    rows = [_row("The system shall do A.", "Requirement", None, "1", has_shall=True)]
    fired: list[LevelingProgress] = []
    nodes, warnings = build_hierarchy_subtree(rows, "det0_", RaisingClient(), progress_callback=fired.append)

    chunk_warnings = [p for p in fired if p.phase == "chunk_warning"]
    assert len(chunk_warnings) == 1
    assert chunk_warnings[0].warning_message == warnings[0].raw


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


def test_build_hierarchy_subtree_grounding_score_is_not_trivially_1_for_unrelated_hebrew_text() -> None:
    # NEW-04/Phase 6 regression guard: before extracting to grounding.py,
    # this module had its own ASCII-only word pattern, which silently
    # emptied significant_words() for Hebrew and made grounding_score
    # trivially 1.0 ("nothing significant to judge") regardless of whether
    # the synthesized text was actually related to the source. This is the
    # one test in this file that actually fails on the pre-fix ASCII-only
    # implementation and passes after it -- not just exercising the pass in
    # general.
    class FakeSynthesisClient:
        def synthesize_leaf_requirements(self, items_by_id):
            return {
                node_id: {
                    "title": "לוח זמנים",
                    "text": "לוח הזמנים של הרכבת השתנה",  # unrelated to the row's own Hebrew label below
                    "tags": [],
                }
                for node_id in items_by_id
            }

    rows = [
        _row("מקלט", "Feature", None, "1"),
        _row("המערכת תציג התרעה על תקלה בחיישן", "Requirement", 0, "1.1", needs_synthesis=True),
    ]
    nodes, warnings = build_hierarchy_subtree(
        rows, "det0_", None, synthesis_client=FakeSynthesisClient(),
    )
    leaf = next(n for n in nodes if n.type == WorkItemType.REQUIREMENT)
    assert leaf.grounding_score is not None and leaf.grounding_score < 1.0


def test_build_hierarchy_subtree_never_tags_a_non_requirement_synthesized_leaf() -> None:
    # Confirmed real bug this guards against: this pass used to gate tag
    # assignment on needs_synthesis alone, not on the node's own type --
    # and _repair_requirement_hierarchy (elsewhere in the pipeline) can
    # re-type a synthesized leaf to Feature. A defensive, type-checked-at-
    # assignment-time gate is what actually has to hold regardless of
    # calling order, so this constructs the case directly rather than
    # relying on a specific upstream sequence to produce it.
    class FakeSynthesisClient:
        def synthesize_leaf_requirements(self, items_by_id):
            return {
                node_id: {
                    "title": "Power Supply",
                    "text": "The COTS power supply shall have a 3U, 1-inch form factor.",
                    "tags": ["interface"],
                }
                for node_id in items_by_id
            }

    rows = [_row('Size: 3U 1"', "Feature", None, "1", needs_synthesis=True)]
    nodes, warnings = build_hierarchy_subtree(
        rows, "det0_", None, synthesis_client=FakeSynthesisClient(),
    )
    assert len(nodes) == 1
    assert nodes[0].type == WorkItemType.FEATURE
    assert nodes[0].tags == []
    # The rest of the synthesis result still applies -- only tags are gated.
    assert nodes[0].description == "The COTS power supply shall have a 3U, 1-inch form factor."


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
    assert any("synthesis" in w.raw.lower() and "failed" in w.raw.lower() for w in warnings)


def test_build_hierarchy_subtree_synthesis_failure_fires_chunk_warning() -> None:
    class RaisingSynthesisClient:
        def synthesize_leaf_requirements(self, items_by_id):
            raise RuntimeError("boom")

    rows = [_row('Size: 3U 1"', "Requirement", None, "1", needs_synthesis=True)]
    fired: list[LevelingProgress] = []
    nodes, warnings = build_hierarchy_subtree(
        rows, "det0_", None, synthesis_client=RaisingSynthesisClient(), progress_callback=fired.append,
    )

    chunk_warnings = [p for p in fired if p.phase == "chunk_warning"]
    assert len(chunk_warnings) == 1
    assert chunk_warnings[0].warning_message == warnings[0].raw


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
    build_hierarchy_subtree(rows, "det0_", synthesis_client=client)
    assert client.called is False


def test_build_hierarchy_subtree_fires_progress_before_the_title_tag_chunk() -> None:
    # Real gap this closes (confirmed live, AirPro document): the caller's
    # own deterministic_subtree kickoff event fires once per SUBTREE, before
    # this function is even called, and previously stayed frozen for
    # however long the title-tag/synthesis LLM calls inside took -- a real
    # job sat on "Extracting a deterministic hierarchy subtree (1 of 1 --
    # Heading hierarchy)" for 5+ minutes with zero further signal. Firing
    # per CHUNK here, using the subtree label as a prefix, closes that.
    class FakeTitleTagClient:
        def title_and_tags_for_rows(self, texts_by_row_id):
            return {}

    rows = [_row("The system shall do A.", "Requirement", None, "1", has_shall=True)]
    events: list[LevelingProgress] = []
    build_hierarchy_subtree(
        rows, "det0_", title_tag_client=FakeTitleTagClient(),
        progress_callback=lambda p: events.append(p),
        subtree_index=0, subtree_count=2, subtree_label="Table t0",
    )

    subtree_events = [e for e in events if e.phase == "deterministic_subtree"]
    assert len(subtree_events) == 1
    assert subtree_events[0].subtree_index == 0
    assert subtree_events[0].subtree_count == 2
    assert subtree_events[0].subtree_label == "Table t0 -- enhancing titles/tags for 1 node(s) (chunk 1 of 1)"


def test_build_hierarchy_subtree_fires_progress_before_the_synthesis_chunk() -> None:
    class FakeSynthesisClient:
        def synthesize_leaf_requirements(self, items_by_id):
            return {}

    rows = [_row('Size: 3U 1"', "Requirement", None, "1", needs_synthesis=True)]
    events: list[LevelingProgress] = []
    build_hierarchy_subtree(
        rows, "det0_", None, synthesis_client=FakeSynthesisClient(),
        progress_callback=lambda p: events.append(p),
        subtree_index=1, subtree_count=2, subtree_label="Heading hierarchy",
    )

    subtree_events = [e for e in events if e.phase == "deterministic_subtree"]
    assert len(subtree_events) == 1
    assert subtree_events[0].subtree_index == 1
    assert subtree_events[0].subtree_count == 2
    assert subtree_events[0].subtree_label == "Heading hierarchy -- synthesizing requirement text for 1 node(s) (chunk 1 of 1)"
    # Same blocks_done/blocks_total fix as the title-tag pass above.
    assert subtree_events[0].blocks_done == 0
    assert subtree_events[0].blocks_total == 1


def test_build_hierarchy_subtree_fires_one_progress_event_per_chunk_not_per_subtree() -> None:
    # The real fix: more than _TITLE_TAG_CHUNK_SIZE (150) leaves must fire
    # more than one event, proving progress is reported per LLM call, not
    # just once for the whole subtree regardless of how many chunks it
    # actually takes.
    class FakeTitleTagClient:
        def title_and_tags_for_rows(self, texts_by_row_id):
            return {}

    rows = [
        _row(f"The system shall do {i}.", "Requirement", None, str(i), has_shall=True)
        for i in range(151)
    ]
    events: list[LevelingProgress] = []
    build_hierarchy_subtree(
        rows, "det0_", title_tag_client=FakeTitleTagClient(),
        progress_callback=lambda p: events.append(p),
        subtree_index=0, subtree_count=1, subtree_label="Heading hierarchy",
    )

    subtree_events = [e for e in events if e.phase == "deterministic_subtree"]
    assert len(subtree_events) == 2
    assert "chunk 1 of 2" in subtree_events[0].subtree_label
    assert "chunk 2 of 2" in subtree_events[1].subtree_label
    # Regression (UI progress review, 2026-08-05): these two fields were
    # hardcoded to 0/0 despite chunk_num/total_chunks already being known
    # here -- the frontend's percentage calc requires blocks_total > 0, so
    # "no progress estimate for this step yet" showed for the ENTIRE
    # multi-chunk pass regardless of how far through it actually was.
    assert subtree_events[0].blocks_done == 0
    assert subtree_events[0].blocks_total == 151
    assert subtree_events[1].blocks_done == 150
    assert subtree_events[1].blocks_total == 151


# --- section_path (Phase 2) ---


def test_build_hierarchy_subtree_section_path_is_the_root_first_ancestor_label_chain() -> None:
    # Root row: no ancestors -> []. A producing row's OWN label is never
    # part of its own section_path (only its ancestors' labels are).
    rows = [
        _row("Audio Control", "Feature", None, "1"),
        _row("Volume", "Feature", 0, "1.1"),
        _row("The system shall control volume.", "Requirement", 1, "1.1.1", has_shall=True),
    ]
    nodes, _ = build_hierarchy_subtree(rows, "det0_")
    root = next(n for n in nodes if n.title == "Audio Control")
    middle = next(n for n in nodes if n.title == "Volume")
    leaf = next(n for n in nodes if n.type == WorkItemType.REQUIREMENT)

    assert root.source_ref.section_path == []
    assert middle.source_ref.section_path == ["Audio Control"]
    assert leaf.source_ref.section_path == ["Audio Control", "Volume"]


def test_build_hierarchy_subtree_section_path_includes_a_fold_rows_own_label() -> None:
    # A fold row (node_type=None) never becomes its own node, but its own
    # label IS real, human-authored section text -- it belongs in a
    # descendant's section_path exactly like a real heading would, even
    # though it never appears as a node anywhere in the returned list.
    rows = [
        _row("Real Group", "Feature", None, "1"),
        _row("Lone Wrapper", None, 0, "1.1"),
        _row("The system shall do A.", "Requirement", 1, "1.1.1", has_shall=True),
    ]
    nodes, _ = build_hierarchy_subtree(rows, "det0_")
    leaf = next(n for n in nodes if n.type == WorkItemType.REQUIREMENT)
    assert leaf.source_ref.section_path == ["Real Group", "Lone Wrapper"]


def test_build_hierarchy_subtree_section_path_root_seeds_a_table_subtrees_own_identity() -> None:
    # The table-row convention's caller (llm_leveling._detect_deterministic_subtrees)
    # seeds section_path_root with the table's own identity, since a
    # table-row subtree's rows have no heading ancestor of their own.
    rows = [
        _row("Power Requirements", "Feature", None, "1"),
        _row("The rail shall regulate within 2%.", "Requirement", 0, "1.1", has_shall=True),
    ]
    nodes, _ = build_hierarchy_subtree(rows, "det0_", section_path_root="Table t7")
    root = next(n for n in nodes if n.title == "Power Requirements")
    leaf = next(n for n in nodes if n.type == WorkItemType.REQUIREMENT)
    assert root.source_ref.section_path == ["Table t7"]
    assert leaf.source_ref.section_path == ["Table t7", "Power Requirements"]


def test_build_hierarchy_subtree_identity_and_fidelity_hashes_are_unaffected_by_section_path() -> None:
    # Same invariant as tree_builder.py's own identical test: section_path
    # is additive provenance, deliberately excluded from _hash_identity's
    # input -- widening it must never change identity_hash/fidelity_hash.
    import hashlib

    from app.leveling.id_tree_builder import _hash_identity

    rows = [
        _row("Audio Control", "Feature", None, "1"),
        _row("The system shall control volume.", "Requirement", 0, "1.1", has_shall=True),
    ]
    nodes, _ = build_hierarchy_subtree(rows, "det0_", section_path_root="Table t7")
    for node in nodes:
        bare_ref = node.source_ref.model_copy(update={"section_path": []})
        assert node.identity_hash == _hash_identity(node.description, bare_ref)
        assert node.fidelity_hash == hashlib.sha256(node.description.encode()).hexdigest()


def _many_requirement_rows(count: int) -> list:
    # _TITLE_TAG_CHUNK_SIZE / _SYNTHESIS_CHUNK_SIZE are both 150, so a
    # multi-chunk pass needs >150 leaves. 320 gives 3 chunks (150/150/20) --
    # enough that a bounded pool of 2 must genuinely overlap.
    return [
        _row(f"The system shall do thing {i}.", "Requirement", None, str(i + 1), has_shall=True)
        for i in range(count)
    ]


def test_apply_title_tag_pass_runs_chunks_concurrently() -> None:
    import threading
    import time

    from app.leveling.id_tree_builder import _apply_title_tag_pass, build_hierarchy_subtree

    seen: set[str] = set()
    lock = threading.Lock()

    class ThreadRecordingClient:
        def title_and_tags_for_rows(self, texts_by_row_id):
            with lock:
                seen.add(threading.current_thread().name)
            time.sleep(0.05)  # long enough that a serial run could only use one thread
            return {node_id: {"title": "T", "tags": []} for node_id in texts_by_row_id}

    nodes, _ = build_hierarchy_subtree(_many_requirement_rows(320), "det0_")
    leaf_ids = [n.local_id for n in nodes]

    _apply_title_tag_pass(nodes, leaf_ids, ThreadRecordingClient(), [], chunk_concurrency=3)

    assert len(seen) > 1  # chunks genuinely overlapped


def test_apply_title_tag_pass_output_is_identical_serial_vs_concurrent() -> None:
    import time

    from app.leveling.id_tree_builder import _apply_title_tag_pass, build_hierarchy_subtree

    class OrderSensitiveClient:
        """Chunk 0 is deliberately slowed so a later chunk genuinely
        completes first -- output must not notice."""

        def title_and_tags_for_rows(self, texts_by_row_id):
            if "det0_1" in texts_by_row_id:
                time.sleep(0.2)
            return {
                node_id: {"title": f"Enhanced {node_id}", "tags": ["Functional"]}
                for node_id in texts_by_row_id
            }

    def run(concurrency: int):
        nodes, _ = build_hierarchy_subtree(_many_requirement_rows(320), "det0_")
        warnings: list = []
        _apply_title_tag_pass(
            nodes, [n.local_id for n in nodes], OrderSensitiveClient(), warnings,
            chunk_concurrency=concurrency,
        )
        return [(n.local_id, n.title, [t.value for t in n.tags]) for n in nodes], [w.raw for w in warnings]

    assert run(1) == run(4)


def test_apply_title_tag_pass_narrates_chunks_in_document_order_under_concurrency() -> None:
    import time

    from app.leveling.id_tree_builder import _apply_title_tag_pass, build_hierarchy_subtree

    class SlowFirstChunkClient:
        def title_and_tags_for_rows(self, texts_by_row_id):
            if "det0_1" in texts_by_row_id:
                time.sleep(0.2)
            return {node_id: {"title": "T", "tags": []} for node_id in texts_by_row_id}

    fired: list = []
    nodes, _ = build_hierarchy_subtree(_many_requirement_rows(320), "det0_")

    _apply_title_tag_pass(
        nodes, [n.local_id for n in nodes], SlowFirstChunkClient(), [],
        progress_callback=fired.append, chunk_concurrency=4,
    )

    labels = [e.subtree_label for e in fired if e.phase == "deterministic_subtree"]
    # The frontend regex-parses "(chunk N of M)" straight out of this label
    # (frontend/src/utils/deterministicSubtreeChunk.ts) and derives its pip
    # strip and percentage from the LAST event received -- so these must
    # arrive in ascending chunk order regardless of completion order.
    assert [label.split("(chunk ")[1] for label in labels] == ["1 of 3)", "2 of 3)", "3 of 3)"]
    # blocks_done must also be monotonic -- ProgressBanner's percentage
    # comes straight off it.
    assert [e.blocks_done for e in fired if e.phase == "deterministic_subtree"] == [0, 150, 300]


def test_apply_title_tag_pass_one_failing_chunk_still_applies_the_others_under_concurrency() -> None:
    from app.leveling.id_tree_builder import _apply_title_tag_pass, build_hierarchy_subtree

    class SecondChunkRaisesClient:
        def title_and_tags_for_rows(self, texts_by_row_id):
            if "det0_151" in texts_by_row_id:
                raise RuntimeError("boom")
            return {node_id: {"title": "Enhanced", "tags": []} for node_id in texts_by_row_id}

    nodes, _ = build_hierarchy_subtree(_many_requirement_rows(320), "det0_")
    warnings: list = []
    fired: list = []

    _apply_title_tag_pass(
        nodes, [n.local_id for n in nodes], SecondChunkRaisesClient(), warnings,
        progress_callback=fired.append, chunk_concurrency=4,
    )

    # Fail-soft per chunk, exactly as before: chunk 1's failure never stops
    # chunks 0 and 2 from being applied.
    assert nodes[0].title == "Enhanced"
    assert nodes[319].title == "Enhanced"
    assert nodes[151].title != "Enhanced"
    assert len(warnings) == 1
    assert any(e.phase == "chunk_warning" for e in fired)


def test_apply_synthesis_pass_runs_chunks_concurrently() -> None:
    import threading
    import time

    from app.leveling.id_tree_builder import _apply_synthesis_pass, build_hierarchy_subtree

    seen: set[str] = set()
    lock = threading.Lock()

    class ThreadRecordingClient:
        def synthesize_leaf_requirements(self, items_by_id):
            with lock:
                seen.add(threading.current_thread().name)
            time.sleep(0.05)
            return {node_id: {"text": "The system shall X."} for node_id in items_by_id}

    nodes, _ = build_hierarchy_subtree(_many_requirement_rows(320), "det0_")

    _apply_synthesis_pass(
        nodes, [n.local_id for n in nodes], ThreadRecordingClient(), [], chunk_concurrency=3,
    )

    assert len(seen) > 1


def test_apply_synthesis_pass_output_is_identical_serial_vs_concurrent() -> None:
    import time

    from app.leveling.id_tree_builder import _apply_synthesis_pass, build_hierarchy_subtree

    class OrderSensitiveClient:
        def synthesize_leaf_requirements(self, items_by_id):
            if "det0_1" in items_by_id:
                time.sleep(0.2)
            return {
                node_id: {"text": f"The system shall handle {node_id}.", "title": f"T {node_id}", "tags": []}
                for node_id in items_by_id
            }

    def run(concurrency: int):
        nodes, _ = build_hierarchy_subtree(_many_requirement_rows(320), "det0_")
        warnings: list = []
        _apply_synthesis_pass(
            nodes, [n.local_id for n in nodes], OrderSensitiveClient(), warnings,
            chunk_concurrency=concurrency,
        )
        return (
            [(n.local_id, n.title, n.description, n.grounding_score, n.fidelity_hash) for n in nodes],
            [w.raw for w in warnings],
        )

    assert run(1) == run(4)


def test_apply_synthesis_pass_narrates_chunks_in_document_order_under_concurrency() -> None:
    import time

    from app.leveling.id_tree_builder import _apply_synthesis_pass, build_hierarchy_subtree

    class SlowFirstChunkClient:
        def synthesize_leaf_requirements(self, items_by_id):
            if "det0_1" in items_by_id:
                time.sleep(0.2)
            return {node_id: {"text": "The system shall X."} for node_id in items_by_id}

    fired: list = []
    nodes, _ = build_hierarchy_subtree(_many_requirement_rows(320), "det0_")

    _apply_synthesis_pass(
        nodes, [n.local_id for n in nodes], SlowFirstChunkClient(), [],
        progress_callback=fired.append, chunk_concurrency=4,
    )

    labels = [e.subtree_label for e in fired if e.phase == "deterministic_subtree"]
    assert [label.split("(chunk ")[1] for label in labels] == ["1 of 3)", "2 of 3)", "3 of 3)"]
    assert [e.blocks_done for e in fired if e.phase == "deterministic_subtree"] == [0, 150, 300]


def test_apply_synthesis_pass_context_is_built_from_pre_pass_titles_not_a_prior_chunks_output() -> None:
    # Deliberate, documented behavior change (see this plan's design
    # decisions): payload construction is hoisted above the chunk loop, so a
    # node's `context` string is always built from titles as they were
    # BEFORE this pass ran -- never from an ancestor's freshly-synthesized
    # title, which previously depended on which chunk that ancestor landed
    # in. Single code path: this holds at chunk_concurrency=1 too.
    from app.leveling.id_tree_builder import _apply_synthesis_pass, build_hierarchy_subtree

    captured: list[dict] = []

    class RecordingClient:
        def synthesize_leaf_requirements(self, items_by_id):
            captured.append(dict(items_by_id))
            return {node_id: {"text": "The system shall X.", "title": "REWRITTEN"} for node_id in items_by_id}

    # An ancestor Requirement with a nested child Requirement -- both flagged
    # for synthesis, and forced into different chunks by padding between them.
    rows = [_row("Power stuff", "Requirement", None, "1", has_shall=True)]
    rows += [
        _row(f"Filler {i}", "Requirement", 0, f"1.{i + 1}", has_shall=True)
        for i in range(200)
    ]
    nodes, _ = build_hierarchy_subtree(rows, "det0_")
    ancestor_id = nodes[0].local_id
    descendant_id = nodes[-1].local_id

    _apply_synthesis_pass(
        nodes, [n.local_id for n in nodes], RecordingClient(), [], chunk_concurrency=1,
    )

    # The descendant is in chunk 1; the ancestor was rewritten to "REWRITTEN"
    # by chunk 0. Its context must still carry the ORIGINAL ancestor title.
    descendant_payload = next(c[descendant_id] for c in captured if descendant_id in c)
    assert "REWRITTEN" not in descendant_payload["context"]
    assert nodes[0].title == "REWRITTEN"  # the mutation itself still happened
    assert ancestor_id  # referenced so the id is asserted to exist


def test_apply_synthesis_pass_one_failing_chunk_still_applies_the_others_under_concurrency() -> None:
    from app.leveling.id_tree_builder import _apply_synthesis_pass, build_hierarchy_subtree

    class SecondChunkRaisesClient:
        def synthesize_leaf_requirements(self, items_by_id):
            if "det0_151" in items_by_id:
                raise RuntimeError("boom")
            return {node_id: {"text": "The system shall X."} for node_id in items_by_id}

    nodes, _ = build_hierarchy_subtree(_many_requirement_rows(320), "det0_")
    warnings: list = []
    fired: list = []

    _apply_synthesis_pass(
        nodes, [n.local_id for n in nodes], SecondChunkRaisesClient(), warnings,
        progress_callback=fired.append, chunk_concurrency=4,
    )

    assert nodes[0].description == "The system shall X."
    assert nodes[319].description == "The system shall X."
    assert nodes[151].description != "The system shall X."
    assert len(warnings) == 1
    assert any(e.phase == "chunk_warning" for e in fired)
