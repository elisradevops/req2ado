from app.canonical.model import Block, BlockKind, SourceRef, Table, TableCell
from app.leveling.id_hierarchy import (
    _is_requirement_shaped,
    classify_by_nesting,
    qualifying_groups,
    rows_from_heading_structure,
    rows_from_id_headings,
    rows_from_table,
)
from app.workitem.model import WorkItemType


def _sr(offset: int) -> SourceRef:
    return SourceRef(document_path="x.docx", start_offset=offset, end_offset=offset + 1)


def _table(rows: list[list[str]]) -> Table:
    return Table(id="t1", cells=[[TableCell(text=cell) for cell in row] for row in rows], source_ref=_sr(0))


def _heading(block_id: str, level: int, text: str, offset: int) -> Block:
    return Block(
        id=block_id, kind=BlockKind.HEADING, heading_level=level, text=text, source_ref=_sr(offset),
    )


def _para(block_id: str, text: str, offset: int) -> Block:
    return Block(id=block_id, kind=BlockKind.PARAGRAPH, text=text, source_ref=_sr(offset))


# ---------------------------------------------------------------------------
# Convention 1: rows_from_table
# ---------------------------------------------------------------------------


def test_rows_from_table_resolves_type_and_parent_index() -> None:
    table = _table([
        ["Requirement ID", "Requirement / Section"],
        ["1.1", "External Source Detection"],
        ["1.1.1", "The system shall detect X."],
        ["1.1.2", "The system shall detect Y."],
    ])
    rows = rows_from_table(table)
    assert len(rows) == 3
    group = next(r for r in rows if r.label == "External Source Detection")
    assert group.node_type == "Feature"
    assert group.parent_index is None
    leaves = [r for r in rows if r.has_shall]
    assert len(leaves) == 2
    assert all(rows[leaf.parent_index].label == "External Source Detection" for leaf in leaves)
    assert all(r.id_disambiguator_needed for r in rows)


def test_rows_from_table_returns_empty_for_non_conforming_table() -> None:
    assert rows_from_table(_table([["a", "b", "c"]])) == []
    assert rows_from_table(_table([["1.1", "x"]])) == []  # below MIN_ID_ROWS


def test_rows_from_table_folds_a_non_qualifying_intermediate_row() -> None:
    # "1.1" has only ONE leaf child -- doesn't qualify as a group, so its
    # own row must fold (node_type=None) rather than become a node.
    table = _table([
        ["Requirement ID", "Requirement / Section"],
        ["1.1", "Lone Wrapper"],
        ["1.1.1", "The system shall do A."],
        ["2", "Other Group"],
        ["2.1", "The system shall do B."],
        ["2.2", "The system shall do C."],
    ])
    rows = rows_from_table(table)
    lone_wrapper = next(r for r in rows if r.label == "Lone Wrapper")
    assert lone_wrapper.node_type is None


# ---------------------------------------------------------------------------
# Convention 2: rows_from_id_headings
# ---------------------------------------------------------------------------


def test_rows_from_id_headings_resolves_a_real_id_bearing_outline() -> None:
    blocks = [
        _heading("b0", 1, "1  Television Receiver", 0),
        _heading("b1", 2, "1.1  Broadcast Reception", 10),
        _heading("b2", 3, "1.1.1  The system shall scan channels.", 20),
        _heading("b3", 3, "1.1.2  The system shall detect sources.", 30),
    ]
    rows, warnings, claimed = rows_from_id_headings(blocks)
    assert len(rows) == 4
    assert warnings == []
    assert set(claimed) == {"b0", "b1", "b2", "b3"}
    root = next(r for r in rows if r.label == "Television Receiver")
    assert root.parent_index is None
    assert root.node_type == "Epic"


def test_rows_from_id_headings_ignores_non_heading_blocks_with_id_shaped_text() -> None:
    # Confirmed live cross-document collision: numbered PARAGRAPHS (not
    # real Word headings) must never be claimed, even when their labels
    # are ID-shaped and would otherwise collide with a real hierarchy.
    blocks = [
        _para("b0", "1. Purpose and Scope", 0),
        _para("b1", "2. Requirement Conventions", 10),
        _para("b2", "3. Customer Requirements", 20),
        _para("b3", "4. Review and Approval", 30),
    ]
    rows, warnings, claimed = rows_from_id_headings(blocks)
    assert rows == []
    assert claimed == []


def test_rows_from_id_headings_reconciles_a_dominant_offset() -> None:
    # A template reserving Heading 1 for the document title: "1" sits at
    # Heading 2, not Heading 1 -- offset 1 throughout, not 0. Must not
    # force strict level==depth equality (see tree_builder's own
    # confirmed live bug this mirrors).
    blocks = [
        _heading("b0", 2, "1  Domain", 0),
        _heading("b1", 3, "1.1  The system shall do A.", 10),
        _heading("b2", 3, "1.2  The system shall do B.", 20),
    ]
    rows, warnings, claimed = rows_from_id_headings(blocks)
    assert len(rows) == 3
    assert warnings == []


def test_rows_from_id_headings_excludes_and_warns_on_a_deviant_offset() -> None:
    blocks = [
        _heading("b0", 1, "1  Domain", 0),
        _heading("b1", 2, "1.1  The system shall do A.", 10),
        _heading("b2", 2, "1.2  The system shall do B.", 20),
        # This one's level doesn't match the dominant offset (0) --
        # excluded and warned, not force-fit.
        _heading("b3", 5, "1.3  The system shall do C.", 30),
    ]
    rows, warnings, claimed = rows_from_id_headings(blocks)
    assert "b3" not in claimed
    assert any("dominant heading-level offset" in w.raw for w in warnings)


def test_rows_from_id_headings_returns_empty_for_a_flat_single_level_outline() -> None:
    blocks = [
        _heading("b0", 1, "1  The system shall do A.", 0),
        _heading("b1", 1, "2  The system shall do B.", 10),
    ]
    rows, warnings, claimed = rows_from_id_headings(blocks)
    assert rows == []  # only 1 distinct level -- no real hierarchy


# ---------------------------------------------------------------------------
# Convention 3: rows_from_heading_structure
# ---------------------------------------------------------------------------


def test_rows_from_heading_structure_builds_from_pure_nesting() -> None:
    blocks = [
        _heading("b0", 2, "Domain Overview", 0),
        _heading("b1", 3, "The system shall do A.", 10),
        _heading("b2", 3, "The system shall do B.", 20),
        _heading("b3", 3, "The system shall do C.", 30),
        _heading("b4", 3, "The system shall do D.", 40),
        _heading("b5", 3, "The system shall do E.", 50),
    ]
    rows, warnings, claimed = rows_from_heading_structure(blocks)
    assert len(rows) == 6
    assert set(claimed) == {b.id for b in blocks}
    root = rows[0]
    assert root.node_type == "Feature"  # all children are Requirement-typed leaves
    assert all(r.node_type == "Requirement" for r in rows[1:])


def test_rows_from_heading_structure_groups_by_child_count_even_with_shall() -> None:
    # Confirmed real gap on AirPro: a group heading's own text CAN contain
    # "shall" and still have real children -- group-vs-leaf must be child
    # count, never text content, for this convention.
    blocks = [
        _heading("b0", 2, "The Backplane shall include the following modules:", 0),
        _heading("b1", 3, "The system shall do A.", 10),
        _heading("b2", 3, "The system shall do B.", 20),
        _heading("b3", 3, "The system shall do C.", 30),
        _heading("b4", 3, "The system shall do D.", 40),
        _heading("b5", 3, "The system shall do E.", 50),
    ]
    rows, warnings, claimed = rows_from_heading_structure(blocks)
    group = rows[0]
    assert group.has_shall is True
    # every leaf's parent_index must point at index 0 (the group)
    assert all(r.parent_index == 0 for r in rows[1:])


def test_rows_from_heading_structure_rejects_a_non_requirement_headed_document() -> None:
    # Two unrelated negative controls (golden BASELINE-style fixture shape,
    # generic sample): headings with real levels but ZERO shall content --
    # must not be claimed.
    blocks = [
        _heading("b0", 1, "Introduction", 0),
        _heading("b1", 2, "Background", 10),
        _heading("b2", 2, "Scope", 20),
        _heading("b3", 3, "Conclusion", 30),
    ]
    rows, warnings, claimed = rows_from_heading_structure(blocks)
    assert rows == []


def test_rows_from_heading_structure_rejects_a_single_level_outline() -> None:
    blocks = [
        _heading("b0", 2, "The system shall do A.", 0),
        _heading("b1", 2, "The system shall do B.", 10),
    ]
    rows, warnings, claimed = rows_from_heading_structure(blocks)
    assert rows == []  # only 1 distinct level


def test_rows_from_heading_structure_handles_a_level_skip() -> None:
    # No level-4 heading exists anywhere -- a level-5 heading right after
    # a level-3 one must still nest correctly (under the nearest heading
    # with a STRICTLY shallower level, level-3 "E", not skip all the way
    # up to the level-2 root) -- same stack-walk semantics a real Word
    # outline reader would apply.
    blocks = [
        _heading("b0", 2, "Domain", 0),
        _heading("b1", 3, "The system shall do A.", 10),
        _heading("b2", 3, "The system shall do B.", 20),
        _heading("b3", 3, "The system shall do C.", 30),
        _heading("b4", 3, "The system shall do D.", 40),
        _heading("b5", 3, "The system shall do E.", 50),
        _heading("b6", 5, "The system shall do F.", 60),
    ]
    rows, warnings, claimed = rows_from_heading_structure(blocks)
    skip_row = next(r for r in rows if r.label == "The system shall do F.")
    assert rows[skip_row.parent_index].label == "The system shall do E."

    # A genuine skip UP: a level-5 heading followed by a level-3 sibling
    # of "Domain"'s children must pop back past the level-5/level-3 nodes
    # to attach at the correct shallower level.
    blocks2 = blocks + [_heading("b7", 3, "The system shall do G.", 70)]
    rows2, _w2, _c2 = rows_from_heading_structure(blocks2)
    pop_row = next(r for r in rows2 if r.label == "The system shall do G.")
    assert rows2[pop_row.parent_index].label == "Domain"


def test_rows_from_heading_structure_ignores_non_heading_blocks() -> None:
    blocks = [
        _heading("b0", 2, "Domain", 0),
        _para("p0", "The system shall be prose, not a heading.", 5),
        _heading("b1", 3, "The system shall do A.", 10),
        _heading("b2", 3, "The system shall do B.", 20),
        _heading("b3", 3, "The system shall do C.", 30),
        _heading("b4", 3, "The system shall do D.", 40),
        _heading("b5", 3, "The system shall do E.", 50),
    ]
    rows, warnings, claimed = rows_from_heading_structure(blocks)
    assert "p0" not in claimed


# ---------------------------------------------------------------------------
# _is_requirement_shaped / MIN_REQUIREMENT_SHAPED_LEAF_FRACTION (per-root-
# subtree gate, distinct from the whole-document shall-fraction gate above)
# ---------------------------------------------------------------------------


def test_is_requirement_shaped_accepts_a_real_requirement_sentence() -> None:
    assert _is_requirement_shaped(
        "The power supply shall deliver a minimum output power of 500 watts."
    )


def test_is_requirement_shaped_rejects_a_short_fragment() -> None:
    assert not _is_requirement_shaped("Over-current")
    assert not _is_requirement_shaped("ON/OFF control")
    assert not _is_requirement_shaped('Size: 3U 1"')


def test_is_requirement_shaped_rejects_a_trailing_colon_section_label() -> None:
    assert not _is_requirement_shaped("Voltage Distribution and Power Rails:")


def test_is_requirement_shaped_rejects_a_spec_cell_even_at_six_plus_words() -> None:
    # Word count alone is insufficient -- confirmed false-positive risk:
    # this is 6 words but still a bare "Label: value" spec-table cell, not
    # a requirement.
    assert not _is_requirement_shaped("Zodiac: 3.3V 494uF, 12V 352uF total")


def test_rows_from_heading_structure_flags_a_fragment_heavy_subtree_for_synthesis() -> None:
    # Confirmed real bug (AirPro): a whole-document shall-fraction average
    # can pass (e.g. 0.51) while blending a genuinely prose-heavy root
    # subtree with a genuinely fragment-heavy one -- the per-subtree gate
    # must tell them apart, flagging only the fragment-heavy subtree's
    # leaves for synthesis.
    blocks = [
        # Root A: real requirement prose throughout -- stays fast-path.
        _heading("a0", 2, "Domain A", 0),
        _heading("a1", 3, "The system shall accept an input of 28 volts DC nominal.", 10),
        _heading("a2", 3, "The system shall provide an output of 12 volts DC up to 50 amps.", 20),
        _heading("a3", 3, "The system shall deliver a minimum output power of 500 watts.", 30),
        _heading("a4", 3, "The system shall comply with VITA 62.0 and be SOSA-aligned.", 40),
        _heading("a5", 3, "The system shall conform to a 3U, 1-inch pitch form factor.", 50),
        # Root B: bare spec-table fragments -- needs synthesis.
        _heading("b0", 2, "Domain B", 60),
        _heading("b1", 3, "Over-current", 70),
        _heading("b2", 3, "Under-voltage", 80),
        _heading("b3", 3, "Short circuits", 90),
        _heading("b4", 3, "ON/OFF control", 100),
        _heading("b5", 3, "Size: 3U 1\"", 110),
    ]
    rows, warnings, claimed = rows_from_heading_structure(blocks)
    by_label = {r.label: r for r in rows}
    for label in (
        "The system shall accept an input of 28 volts DC nominal.",
        "The system shall provide an output of 12 volts DC up to 50 amps.",
    ):
        assert by_label[label].needs_synthesis is False
    fragment_labels = (
        "Over-current", "Under-voltage", "Short circuits", "ON/OFF control", 'Size: 3U 1"',
    )
    for label in fragment_labels:
        assert by_label[label].needs_synthesis is True
    # Group/root headings are never flagged -- they're already just short
    # descriptive labels, never claimed as full requirement text.
    assert by_label["Domain A"].needs_synthesis is False
    assert by_label["Domain B"].needs_synthesis is False


# ---------------------------------------------------------------------------
# classify_by_nesting (shared ladder)
# ---------------------------------------------------------------------------


def test_classify_by_nesting_basic_ladder() -> None:
    items = [
        ("root", 1, False),
        ("child_a", 2, False),
        ("child_b", 2, False),
    ]
    result = classify_by_nesting(items)
    assert result["root"][0] == WorkItemType.FEATURE
    assert result["child_a"][0] == WorkItemType.REQUIREMENT
    assert result["child_b"][0] == WorkItemType.REQUIREMENT


def test_classify_by_nesting_override_inherits_parent_type() -> None:
    items = [
        ("root", 1, False),
        ("child", 2, False),
        ("override_child", 3, True),  # repeats parent's tier, not advancing
    ]
    result = classify_by_nesting(items)
    assert result["override_child"][0] == result["child"][0]


# ---------------------------------------------------------------------------
# Equivalence: D1 <-> D2 (empirically confirmed source-agnostic core)
# ---------------------------------------------------------------------------


def test_qualifying_groups_is_identical_across_table_and_heading_sources() -> None:
    # Table-sourced parse (rows_from_table) and heading-sourced parse
    # (rows_from_id_headings) both funnel into this exact same core --
    # confirmed live this session that the two produce field-for-field
    # identical TableGroupInfo output on real document content.
    table = _table([
        ["Requirement ID", "Requirement / Section"],
        ["1", "Television Receiver"],
        ["1.1", "Broadcast Reception"],
        ["1.1.1", "The system shall scan channels."],
        ["1.1.2", "The system shall detect sources."],
    ])
    def _segments(id_text: str) -> tuple[int, ...]:
        return tuple(int(p) for p in id_text.split("."))

    table_groups = qualifying_groups(
        [(_segments(r.id_text), r.label) for r in rows_from_table(table)]
    )
    heading_blocks = [
        _heading("b0", 1, "1  Television Receiver", 0),
        _heading("b1", 2, "1.1  Broadcast Reception", 10),
        _heading("b2", 3, "1.1.1  The system shall scan channels.", 20),
        _heading("b3", 3, "1.1.2  The system shall detect sources.", 30),
    ]
    heading_rows, _warnings, _claimed = rows_from_id_headings(heading_blocks)
    heading_groups = qualifying_groups(
        [(tuple(int(p) for p in r.id_text.split(".")), r.label) for r in heading_rows]
    )
    assert {g.label for g in table_groups} == {g.label for g in heading_groups} == {
        "Television Receiver", "Broadcast Reception",
    }
    by_label_table = {g.label: g.suggested_type for g in table_groups}
    by_label_heading = {g.label: g.suggested_type for g in heading_groups}
    assert by_label_table == by_label_heading
