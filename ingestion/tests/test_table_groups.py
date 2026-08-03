from app.canonical.model import SourceRef, Table
from app.leveling.table_groups import EPIC, FEATURE, REQUIREMENT, TableGroupInfo, qualifying_table_groups


def _sr(path: str = "x.docx") -> SourceRef:
    return SourceRef(document_path=path, start_offset=0, end_offset=10)


def _table(rows: list[list[str]]) -> Table:
    return Table(id="t1", rows=rows, source_ref=_sr())


def test_qualifying_table_groups_finds_a_group_with_two_children() -> None:
    table = _table([
        ["Requirement ID", "Requirement / Section"],
        ["1.1", "External Source Detection"],
        ["1.1.1", "The system shall detect X."],
        ["1.1.2", "The system shall detect Y."],
    ])
    result = qualifying_table_groups([table])
    assert result == [
        TableGroupInfo(label="External Source Detection", child_count=2, id_text="1.1", suggested_type=FEATURE)
    ]


def test_header_exclusion_is_shape_based_not_text_based() -> None:
    # Different header wording, same shape -- proves the header row is
    # excluded because it doesn't match the ID pattern, not because its
    # literal text is special-cased.
    table = _table([
        ["No.", "Description"],
        ["1.1", "External Source Detection"],
        ["1.1.1", "The system shall detect X."],
        ["1.1.2", "The system shall detect Y."],
    ])
    result = qualifying_table_groups([table])
    assert result == [
        TableGroupInfo(label="External Source Detection", child_count=2, id_text="1.1", suggested_type=FEATURE)
    ]


def test_qualifying_table_groups_excludes_a_group_with_only_one_child() -> None:
    table = _table([
        ["Requirement ID", "Requirement / Section"],
        ["1.1", "External Source Detection"],
        ["1.1.1", "The system shall detect X."],
    ])
    assert qualifying_table_groups([table]) == []


def test_qualifying_table_groups_ignores_a_table_with_a_third_column() -> None:
    table = Table(
        id="t1",
        rows=[
            ["Requirement ID", "Requirement / Section", "Priority"],
            ["1.1", "External Source Detection", "High"],
            ["1.1.1", "The system shall detect X.", "High"],
            ["1.1.2", "The system shall detect Y.", "Medium"],
        ],
        source_ref=_sr(),
    )
    assert qualifying_table_groups([table]) == []


def test_qualifying_table_groups_ignores_a_table_with_no_id_shaped_column() -> None:
    table = _table([
        ["Role", "Name"],
        ["Customer Representative", ""],
        ["System Engineering", ""],
    ])
    assert qualifying_table_groups([table]) == []


def test_qualifying_table_groups_treats_each_table_independently() -> None:
    table_a = _table([
        ["Requirement ID", "Requirement / Section"],
        ["1.1", "Group A"],
        ["1.1.1", "The system shall do A1."],
        ["1.1.2", "The system shall do A2."],
    ])
    table_b = _table([
        ["Requirement ID", "Requirement / Section"],
        ["1.1", "Group B"],
        ["1.1.1", "The system shall do B1."],
        ["1.1.2", "The system shall do B2."],
    ])
    result = qualifying_table_groups([table_a, table_b])
    assert len(result) == 2
    assert {g.label for g in result} == {"Group A", "Group B"}
    # Neither table's child count leaked into the other's.
    assert all(g.child_count == 2 for g in result)


def test_qualifying_table_groups_excludes_a_group_row_containing_shall_in_its_own_prose() -> None:
    # Accepted false-negative (documented in the module docstring): a group
    # label that happens to contain "shall" in ordinary prose is
    # misclassified as a leaf and excluded as a group candidate.
    table = _table([
        ["Requirement ID", "Requirement / Section"],
        ["1.1", "Features the system shall eventually support"],
        ["1.1.1", "The system shall do X."],
        ["1.1.2", "The system shall do Y."],
    ])
    assert qualifying_table_groups([table]) == []


def test_qualifying_table_groups_below_convention_threshold_is_a_no_op() -> None:
    # Only 1 of 5 rows is ID-shaped -- below both the minimum row count
    # gate implicitly and the >=50%-of-rows gate explicitly.
    table = _table([
        ["Role", "Name"],
        ["Customer Representative", ""],
        ["System Engineering", ""],
        ["1.1", "Stray ID-shaped cell"],
        ["Approver", ""],
    ])
    assert qualifying_table_groups([table]) == []


def test_qualifying_table_groups_suggests_epic_for_a_group_of_groups() -> None:
    # "Television Receiver" -> "Broadcast Reception"/"System Settings", each
    # of which is ITSELF further split -- a group-of-groups represents a
    # large functional domain and should become a nested Epic, not a
    # Feature. Confirmed live: the original hint never mentioned Epic as an
    # option at all, so the model had no signal this was possible.
    table = _table([
        ["Requirement ID", "Requirement / Section"],
        ["1", "Television Receiver"],
        ["1.1", "Broadcast Reception"],
        ["1.1.1", "The system shall do A."],
        ["1.1.2", "The system shall do B."],
        ["1.2", "System Settings"],
        ["1.2.1", "The system shall do C."],
        ["1.2.2", "The system shall do D."],
    ])
    result = qualifying_table_groups([table])
    by_label = {g.label: g for g in result}
    assert by_label["Television Receiver"].suggested_type == EPIC
    assert by_label["Broadcast Reception"].suggested_type == FEATURE
    assert by_label["System Settings"].suggested_type == FEATURE
    assert by_label["Television Receiver"].is_top_level is True
    assert by_label["Broadcast Reception"].is_top_level is False
    assert by_label["System Settings"].is_top_level is False
    # The real, deterministic parent/child fact already known from the
    # table's own ID hierarchy -- used by llm_leveling's post-hoc repair
    # pass, not threaded into the generation prompt (see parent_label's
    # own docstring for why).
    assert by_label["Television Receiver"].parent_label is None  # top-level, no parent row
    assert by_label["Broadcast Reception"].parent_label == "Television Receiver"
    assert by_label["System Settings"].parent_label == "Television Receiver"


def test_qualifying_table_groups_leaves_parent_label_none_when_the_parent_row_does_not_qualify() -> None:
    # "1.1" itself contains a "shall" statement -- excluded as a group
    # CANDIDATE entirely (see the "shall"-based discriminator), even
    # though it has its own child rows that qualify as real groups. Those
    # children's parent_label must be None, not point at a row that was
    # never itself emitted as a TableGroupInfo.
    table = _table([
        ["Requirement ID", "Requirement / Section"],
        ["1.1", "The system shall handle malformed nesting."],
        ["1.1.1", "Real Group A"],
        ["1.1.1.1", "The system shall do A."],
        ["1.1.1.2", "The system shall do B."],
        ["1.1.2", "Real Group B"],
        ["1.1.2.1", "The system shall do C."],
        ["1.1.2.2", "The system shall do D."],
    ])
    result = qualifying_table_groups([table])
    by_label = {g.label: g for g in result}
    assert by_label["Real Group A"].parent_label is None
    assert by_label["Real Group B"].parent_label is None


def test_qualifying_table_groups_marks_two_independent_single_segment_ids_as_top_level() -> None:
    # Confirmed live: a document can define MULTIPLE independent top-level
    # domains with no common ancestor (e.g. "Television Receiver" id "1"
    # and "Remote Control" id "2") -- both single-segment IDs, no dot, no
    # parent row in this table's own ID hierarchy.
    table = _table([
        ["Requirement ID", "Requirement / Section"],
        ["1", "Television Receiver"],
        ["1.1", "The system shall do A."],
        ["1.2", "The system shall do B."],
        ["2", "Remote Control"],
        ["2.1", "The system shall do C."],
        ["2.2", "The system shall do D."],
    ])
    result = qualifying_table_groups([table])
    by_label = {g.label: g for g in result}
    assert by_label["Television Receiver"].is_top_level is True
    assert by_label["Remote Control"].is_top_level is True


def test_qualifying_table_groups_qualifies_a_lone_child_when_that_child_is_itself_a_group() -> None:
    # "System Description" has only ONE direct child ("About Screen"),
    # which is itself further split -- the reference structure still
    # treats this as its own Epic-level domain despite the single child,
    # unlike a lone LEAF child, which never qualifies on its own.
    table = _table([
        ["Requirement ID", "Requirement / Section"],
        ["1", "System Description"],
        ["1.1", "About Screen"],
        ["1.1.1", "The system shall do A."],
        ["1.1.2", "The system shall do B."],
    ])
    result = qualifying_table_groups([table])
    by_label = {g.label: g for g in result}
    assert by_label["System Description"].child_count == 1
    assert by_label["System Description"].suggested_type == EPIC
    assert by_label["About Screen"].suggested_type == FEATURE


def test_qualifying_table_groups_does_not_qualify_a_lone_leaf_child() -> None:
    # A group with only ONE child that is itself a plain leaf requirement
    # (not a further-split group) does NOT qualify -- this is the
    # pre-existing "0-1 children stays flattened" rule, unaffected by the
    # new group-of-groups exception above.
    table = _table([
        ["Requirement ID", "Requirement / Section"],
        ["1.1", "Solo Group"],
        ["1.1.1", "The system shall do A."],
    ])
    assert qualifying_table_groups([table]) == []


def test_qualifying_table_groups_suggests_feature_for_a_mixed_group() -> None:
    # "Display" has both leaf children (resolution, brightness) AND one
    # group child (Picture Modes) -- mixed composition stays Feature-level
    # per the reference (Display is a Feature with Picture Modes nested
    # under it, not itself promoted to Epic just because ONE child happens
    # to be a group).
    table = _table([
        ["Requirement ID", "Requirement / Section"],
        ["1.1", "Display"],
        ["1.1.1", "The system shall do A."],
        ["1.1.2", "The system shall do B."],
        ["1.1.3", "Picture Modes"],
        ["1.1.3.1", "The system shall do C."],
        ["1.1.3.2", "The system shall do D."],
    ])
    result = qualifying_table_groups([table])
    by_label = {g.label: g for g in result}
    assert by_label["Display"].suggested_type == FEATURE
    assert by_label["Picture Modes"].suggested_type == FEATURE


def test_qualifying_table_groups_returns_empty_for_no_tables() -> None:
    assert qualifying_table_groups(None) == []
    assert qualifying_table_groups([]) == []


def test_qualifying_table_groups_handles_a_sub_lettered_leaf_id() -> None:
    # "1.2.2.4.a"-style sub-lettering (seen in the real test document) must
    # not break parsing of the surrounding numeric hierarchy.
    table = _table([
        ["Requirement ID", "Requirement / Section"],
        ["1.2.2.4", "Mute and Volume-Restore Behavior"],
        ["1.2.2.4.a", "When Mute is disabled, the system shall restore the last volume."],
        ["1.2.2.4.b", "If the user changes the volume, the system shall apply it when unmuted."],
    ])
    result = qualifying_table_groups([table])
    assert result == [
        TableGroupInfo(
            label="Mute and Volume-Restore Behavior", child_count=2, id_text="1.2.2.4",
            suggested_type=REQUIREMENT,
        )
    ]
