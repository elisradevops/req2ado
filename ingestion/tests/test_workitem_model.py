from app.canonical.model import SourceRef
from app.workitem.model import RequirementQualityIssue, RequirementTag, WorkItemMode, WorkItemNode, WorkItemTree, WorkItemType


def _source_ref() -> SourceRef:
    return SourceRef(document_path="x.txt", start_offset=0, end_offset=10)


def test_work_item_node_matches_schema_shape() -> None:
    node = WorkItemNode(
        local_id="n0",
        type=WorkItemType.EPIC,
        parent_local_id=None,
        title="Receiver",
        description="1 Receiver",
        source_ref=_source_ref(),
        mode=WorkItemMode.BASELINE,
    )
    dumped = node.model_dump(mode="json")
    assert dumped["type"] == "Epic"
    assert dumped["mode"] == "BASELINE"
    assert dumped["customer_id"] is None
    assert dumped["fidelity_hash"] is None
    assert dumped["tags"] == []


def test_work_item_node_title_max_length_enforced() -> None:
    import pytest
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        WorkItemNode(
            local_id="n0",
            type=WorkItemType.REQUIREMENT,
            parent_local_id=None,
            title="x" * 257,
            description="too long",
            source_ref=_source_ref(),
            mode=WorkItemMode.BASELINE,
        )


def test_work_item_node_accepts_tags() -> None:
    node = WorkItemNode(
        local_id="n1",
        type=WorkItemType.REQUIREMENT,
        parent_local_id="n0",
        title="Shall support Hebrew",
        description="The system shall support Hebrew input.",
        source_ref=_source_ref(),
        mode=WorkItemMode.SURVEY,
        tags=[RequirementTag.FUNCTIONAL, RequirementTag.INTERFACE],
    )
    assert node.tags == [RequirementTag.FUNCTIONAL, RequirementTag.INTERFACE]


def test_work_item_node_defaults_quality_fields_to_none_and_empty() -> None:
    node = WorkItemNode(
        local_id="n0",
        type=WorkItemType.EPIC,
        parent_local_id=None,
        title="Receiver",
        description="1 Receiver",
        source_ref=_source_ref(),
        mode=WorkItemMode.BASELINE,
    )
    assert node.quality_score is None
    assert node.quality_issues == []


def test_work_item_node_accepts_quality_score_and_issues() -> None:
    node = WorkItemNode(
        local_id="n1",
        type=WorkItemType.REQUIREMENT,
        parent_local_id="n0",
        title="Shall support Hebrew",
        description="The system shall support Hebrew input.",
        source_ref=_source_ref(),
        mode=WorkItemMode.SURVEY,
        quality_score=85,
        quality_issues=[RequirementQualityIssue.VAGUE_TERM],
    )
    assert node.quality_score == 85
    assert node.quality_issues == [RequirementQualityIssue.VAGUE_TERM]


def test_work_item_tree_defaults_to_empty_nodes() -> None:
    tree = WorkItemTree()
    assert tree.nodes == []
