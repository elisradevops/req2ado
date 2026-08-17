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


def _epic_feature_requirement_nodes():
    rows = [
        _row("Controls:", "Epic", None, "1"),
        _row("Over 28V VDC input", "Feature", 0, "1.1"),
        _row("The system shall clamp input over 28V.", "Requirement", 1, "1.1.1", has_shall=True),
    ]
    nodes, _ = build_hierarchy_subtree(rows, "det0_", None)
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
    nodes, _ = build_hierarchy_subtree(rows, "det0_", None)
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
    nodes, _ = build_hierarchy_subtree(rows, "det0_", None)
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
    nodes, _ = build_hierarchy_subtree(rows, "det0_", None)
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
    nodes, _ = build_hierarchy_subtree(rows, "det0_", None)
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
    nodes, warnings = build_hierarchy_subtree(rows, "det0_", None, RaisingClient())
    assert len(nodes) == 1
    assert nodes[0].tags == []
    assert any("failed" in w.raw for w in warnings)


def test_build_hierarchy_subtree_title_tag_failure_fires_chunk_warning() -> None:
    class RaisingClient:
        def title_and_tags_for_rows(self, texts_by_row_id):
            raise RuntimeError("boom")

    rows = [_row("The system shall do A.", "Requirement", None, "1", has_shall=True)]
    fired: list[LevelingProgress] = []
    nodes, warnings = build_hierarchy_subtree(rows, "det0_", None, RaisingClient(), progress_callback=fired.append)

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
    build_hierarchy_subtree(rows, "det0_", None, synthesis_client=client)
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
        rows, "det0_", None, title_tag_client=FakeTitleTagClient(),
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
        rows, "det0_", None, title_tag_client=FakeTitleTagClient(),
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
    nodes, _ = build_hierarchy_subtree(rows, "det0_", None)
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
    nodes, _ = build_hierarchy_subtree(rows, "det0_", None)
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
    nodes, _ = build_hierarchy_subtree(rows, "det0_", None, section_path_root="Table t7")
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
    nodes, _ = build_hierarchy_subtree(rows, "det0_", None, section_path_root="Table t7")
    for node in nodes:
        bare_ref = node.source_ref.model_copy(update={"section_path": []})
        assert node.identity_hash == _hash_identity(node.description, bare_ref)
        assert node.fidelity_hash == hashlib.sha256(node.description.encode()).hexdigest()
