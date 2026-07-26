from app.canonical.model import Block, BlockKind, SourceRef
from app.leveling.autodetect import classify_numbering_branch, is_heading_style_branch
from app.workitem.model import WorkItemType


def _sr() -> SourceRef:
    return SourceRef(document_path="x", start_offset=0, end_offset=1)


def _p(block_id: str, text: str) -> Block:
    return Block(id=block_id, kind=BlockKind.PARAGRAPH, text=text, source_ref=_sr())


def _h(block_id: str, level: int, text: str) -> Block:
    return Block(id=block_id, kind=BlockKind.HEADING, heading_level=level, text=text, source_ref=_sr())


# --- is_heading_style_branch -------------------------------------------------


def test_numbering_label_branch_is_not_heading_style() -> None:
    branch = [_p("b0", "1 Receiver"), _p("b1", "1.1 Broadcast & Inputs")]
    assert is_heading_style_branch(branch) is False


def test_heading_styled_branch_is_heading_style() -> None:
    branch = [_h("c0", 1, "Power Distribution"), _h("c1", 2, "3.3V Rail Requirements")]
    assert is_heading_style_branch(branch) is True


def test_heading_style_detection_does_not_depend_on_depth() -> None:
    # Regression: the old detect_profile_for_branch used max_depth alone,
    # so a heading-styled branch reaching depth 4 flipped to tv_style
    # (gained an Epic tier). is_heading_style_branch only ever looks at the
    # branch's own root block -- it must classify a 4-level-deep heading
    # branch as heading-style exactly the same as a 2-level one.
    branch = [
        _h("c0", 1, "Power Distribution"),
        _h("c1", 2, "3.3V Rail Requirements"),
        _h("c2", 3, "Ripple sub-requirement"),
        _h("c3", 4, "Ripple sub-sub-requirement"),
    ]
    assert is_heading_style_branch(branch) is True


def test_heading_style_detection_uses_only_the_branch_root_not_any_block() -> None:
    # A branch whose ROOT is a real Word heading, but which happens to
    # contain one incidentally numbering-labeled paragraph deeper inside,
    # stays heading-style -- the root's own convention wins, not "any block".
    branch = [
        _h("c0", 1, "Power Distribution"),
        _p("c1", "3.3.1 an incidentally numbered paragraph, not a real heading"),
    ]
    assert is_heading_style_branch(branch) is True


# --- classify_numbering_branch: basic ladder shapes --------------------------


def test_shallow_branch_all_leaves_becomes_feature_root() -> None:
    # "2 Menu System" / "2.1 leaf" -- mirrors mock_tv_remote.docx's shallow
    # branch: a root whose only children are leaves collapses to Feature,
    # with no Epic tier at all (matches the old icd_style shallow case).
    branch = [_p("b0", "2 Menu System"), _p("b1", "2.1 The on-screen menu shall list favorites.")]
    result = classify_numbering_branch(branch)
    assert result["b0"][0] == WorkItemType.FEATURE
    assert result["b1"][0] == WorkItemType.REQUIREMENT


def test_deep_branch_collapses_epic_epic_feature_requirement() -> None:
    # mirrors mock_tv_remote.docx's deep branch and the existing
    # _tv_style_doc fixture in test_tree_builder.py.
    branch = [
        _p("b0", "1 Receiver"),
        _p("b1", "1.1 Broadcast & Inputs"),
        _p("b2", "1.1.1 Channel scan"),
        _p("b3", "1.1.1.1 The receiver shall scan all channels."),
    ]
    result = classify_numbering_branch(branch)
    assert result["b0"][0] == WorkItemType.EPIC
    assert result["b1"][0] == WorkItemType.EPIC
    assert result["b2"][0] == WorkItemType.FEATURE
    assert result["b3"][0] == WorkItemType.REQUIREMENT


# --- lettered sub-item override ----------------------------------------------


def test_lettered_suffix_is_an_override_inheriting_parent_type() -> None:
    branch = [
        _p("b0", "1.1.1.1 The receiver shall scan all channels."),
        _p("b1", "1.1.1.1.a The receiver shall support terrestrial broadcast."),
    ]
    result = classify_numbering_branch(branch)
    assert result["b0"][0] == WorkItemType.REQUIREMENT
    assert result["b1"][0] == WorkItemType.REQUIREMENT  # inherited, not a new tier


def test_lettered_child_is_excluded_from_parents_own_promotion_decision() -> None:
    # A node whose ONLY children are lettered (override) must be treated as
    # having zero non-override children -- i.e. a leaf -- not "all children
    # Requirement -> promote to Feature". Mirrors "1.1.2.2" in the golden
    # scenario (sub-Requirement pair 1.1.2.2.a/.b).
    branch = [
        _p("b0", "1.1.2 External source detection"),
        _p("b1", "1.1.2.2 Automatic switch to the active source."),
        _p("b2", "1.1.2.2.a If multiple active sources exist, show a picker."),
        _p("b3", "1.1.2.2.b If the user dismissed the prompt, do not show it again."),
    ]
    result = classify_numbering_branch(branch)
    assert result["b1"][0] == WorkItemType.REQUIREMENT
    assert result["b2"][0] == WorkItemType.REQUIREMENT
    assert result["b3"][0] == WorkItemType.REQUIREMENT
    assert result["b0"][0] == WorkItemType.FEATURE  # b1 is its only (non-override) child, Requirement -> Feature


# --- SUB- marker override -----------------------------------------------------


def test_sub_marker_is_an_override_inheriting_parent_type_and_strips_from_title() -> None:
    branch = [
        _p("b0", "1.2.1 Display"),
        _p("b1", "1.2.1.1 Output resolution selectable from a list."),
        _p("b2", "1.2.1.4 SUB- – Picture Modes"),
        _p("b3", "1.2.1.4.1 Cinema mode reduces color sharpness."),
    ]
    result = classify_numbering_branch(branch)
    assert result["b0"][0] == WorkItemType.FEATURE  # b2 excluded from b0's promotion decision
    assert result["b2"][0] == WorkItemType.FEATURE  # inherits b0's type
    assert result["b2"][2] == "Picture Modes"  # SUB- prefix (and its dash) stripped from the title text
    assert result["b3"][0] == WorkItemType.REQUIREMENT  # b2's own subtree still classifies independently


def test_sub_marker_node_with_further_nested_children_is_not_short_circuited() -> None:
    # Proves the override doesn't skip computing the SUB- node's own
    # subtree bottom-up -- only its OWN type is overridden, its children's
    # classification proceeds normally underneath the inherited type.
    branch = [
        _p("b0", "2.2 Button layout"),
        _p("b1", "2.2.1 No more than three buttons per row."),
        _p("b2", "2.2.4 SUB- – Media buttons"),
        _p("b3", "2.2.4.1 Media buttons work at least during USB playback."),
        _p("b4", "2.2.4.2 Back returns to the previous screen consistently."),
    ]
    result = classify_numbering_branch(branch)
    assert result["b0"][0] == WorkItemType.FEATURE
    assert result["b2"][0] == WorkItemType.FEATURE
    assert result["b3"][0] == WorkItemType.REQUIREMENT
    assert result["b4"][0] == WorkItemType.REQUIREMENT


# --- mixed non-override children ---------------------------------------------


def test_mixed_requirement_and_feature_children_promotes_parent_to_epic() -> None:
    # Resolved former-open-question case: a node with a mix of Requirement
    # and Feature/Epic non-override children can't itself be Feature (a
    # Feature can't have a Feature child in the normal ladder) -- it must be
    # Epic, one step above its most-advanced child.
    branch = [
        _p("b0", "1.2.1 Display"),
        _p("b1", "1.2.1.1 leaf one"),
        _p("b2", "1.2.1.2 leaf two"),
        _p("b3", "1.2.1.3 has its own children"),
        _p("b4", "1.2.1.3.1 grandchild leaf"),
    ]
    result = classify_numbering_branch(branch)
    assert result["b3"][0] == WorkItemType.FEATURE  # promotes since its own child is a leaf
    assert result["b0"][0] == WorkItemType.EPIC  # mixed children (b1, b2 = Requirement; b3 = Feature)


# --- child_type ---------------------------------------------------------------


def test_child_type_defaults_to_requirement_for_a_requirement_node() -> None:
    branch = [_p("b0", "1.1.1.1 leaf requirement")]
    result = classify_numbering_branch(branch)
    assert result["b0"][1] == WorkItemType.REQUIREMENT


def test_child_type_copies_the_uniform_type_of_existing_children() -> None:
    # An Epic-over-Epic chain's manually-added child should default to
    # Epic, matching its real siblings -- not "always one tier down".
    branch = [
        _p("b0", "1 Receiver"),
        _p("b1", "1.1 Broadcast & Inputs"),
        _p("b2", "1.1.1 Channel scan"),
        _p("b3", "1.1.1.1 leaf"),
    ]
    result = classify_numbering_branch(branch)
    assert result["b0"][1] == WorkItemType.EPIC  # b0's real child b1 is Epic
    assert result["b1"][1] == WorkItemType.FEATURE  # b1's real child b2 is Feature
    assert result["b2"][1] == WorkItemType.REQUIREMENT  # b2's real child b3 is Requirement


# --- unleveled blocks are skipped, not misclassified --------------------------


def test_unleveled_blocks_are_omitted_from_the_result() -> None:
    branch = [
        _p("b0", "1 Receiver"),
        _p("b1", "a plain paragraph with no numbering at all"),
    ]
    result = classify_numbering_branch(branch)
    assert "b0" in result
    assert "b1" not in result
