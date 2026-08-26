from app.canonical.model import SourceRef
from app.main import _enforce_requirement_only_fields
from app.workitem.model import WarningKind, WorkItemMode, WorkItemNode, WorkItemTree


def _sr(offset: int = 0) -> SourceRef:
    return SourceRef(document_path="x.docx", start_offset=offset, end_offset=offset + 1)


def _node(local_id: str, node_type, title: str, customer_id: str | None = None) -> WorkItemNode:
    return WorkItemNode(
        local_id=local_id, type=node_type, parent_local_id=None, title=title, description=title,
        source_ref=_sr(), mode=WorkItemMode.SURVEY, customer_id=customer_id,
    )


def test_a_customer_id_reported_on_only_one_requirement_is_kept() -> None:
    from app.workitem.model import WorkItemType

    tree = WorkItemTree(nodes=[_node("n0", WorkItemType.REQUIREMENT, "First", "REQ-001")])
    result = _enforce_requirement_only_fields(tree)
    assert result.nodes[0].customer_id == "REQ-001"
    assert result.warnings == []


def test_a_customer_id_reported_on_two_requirements_is_stripped_from_both() -> None:
    # Confirmed real bug, live (cubeadcs_icd.pdf): the model reported the
    # SAME "PC104" on five different, unrelated Requirements -- a
    # recurring PRODUCT/VARIANT name it mistook for a per-row id. A real
    # customer ID is unique to one requirement; this can never be trusted
    # for either node, so both get stripped rather than guessing.
    from app.workitem.model import WorkItemType

    tree = WorkItemTree(nodes=[
        _node("n0", WorkItemType.REQUIREMENT, "PC104 Variant A", "PC104"),
        _node("n1", WorkItemType.REQUIREMENT, "PC104 Variant B", "PC104"),
        _node("n2", WorkItemType.REQUIREMENT, "Unrelated", "REQ-042"),
    ])
    result = _enforce_requirement_only_fields(tree)
    by_id = {n.local_id: n for n in result.nodes}
    assert by_id["n0"].customer_id is None
    assert by_id["n1"].customer_id is None
    assert by_id["n2"].customer_id == "REQ-042"  # unaffected -- unique value

    dup_warnings = [w for w in result.warnings if w.kind == WarningKind.DUPLICATE_CUSTOMER_ID]
    assert len(dup_warnings) == 1
    assert set(dup_warnings[0].node_ids) == {"n0", "n1"}
    assert dup_warnings[0].detail["duplicateValue"] == "PC104"

    # A duplicate-stripped node is reported ONLY via DUPLICATE_CUSTOMER_ID,
    # never also double-counted in MISSING_SOURCE_REFERENCE.
    missing_warnings = [w for w in result.warnings if w.kind == WarningKind.MISSING_SOURCE_REFERENCE]
    assert missing_warnings == []


def test_two_independent_duplicate_groups_each_get_their_own_warning() -> None:
    from app.workitem.model import WorkItemType

    tree = WorkItemTree(nodes=[
        _node("n0", WorkItemType.REQUIREMENT, "A", "PC104"),
        _node("n1", WorkItemType.REQUIREMENT, "B", "PC104"),
        _node("n2", WorkItemType.REQUIREMENT, "C", "RS485"),
        _node("n3", WorkItemType.REQUIREMENT, "D", "RS485"),
    ])
    result = _enforce_requirement_only_fields(tree)
    dup_warnings = {w.detail["duplicateValue"]: set(w.node_ids) for w in result.warnings if w.kind == WarningKind.DUPLICATE_CUSTOMER_ID}
    assert dup_warnings == {"PC104": {"n0", "n1"}, "RS485": {"n2", "n3"}}


def test_a_duplicate_customer_id_on_a_non_requirement_is_not_flagged_as_duplicate() -> None:
    # Non-Requirement customer_id is already unconditionally stripped by
    # the pre-existing Epic/Feature rule -- this must not ALSO fire the
    # new duplicate-detection warning for what's just an ordinary strip.
    from app.workitem.model import WorkItemType

    tree = WorkItemTree(nodes=[
        _node("n0", WorkItemType.FEATURE, "Feature", "PC104"),
        _node("n1", WorkItemType.REQUIREMENT, "Requirement", "PC104"),
    ])
    result = _enforce_requirement_only_fields(tree)
    by_id = {n.local_id: n for n in result.nodes}
    assert by_id["n0"].customer_id is None
    assert by_id["n1"].customer_id == "PC104"  # the lone Requirement occurrence -- not a duplicate
    assert all(w.kind != WarningKind.DUPLICATE_CUSTOMER_ID for w in result.warnings)
