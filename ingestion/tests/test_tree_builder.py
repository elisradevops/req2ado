from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.leveling.tree_builder import build_baseline_tree
from app.workitem.model import WorkItemType


def _sr(path: str, start: int, end: int) -> SourceRef:
    return SourceRef(document_path=path, start_offset=start, end_offset=end)


def _tv_style_doc() -> CanonicalDoc:
    path = "tv_receiver.txt"
    return CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="tvhash"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr(path, 0, 10)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="1.1 Broadcast & Inputs", source_ref=_sr(path, 11, 33)),
            Block(id="b2", kind=BlockKind.PARAGRAPH, text="1.1.1 Channel scan", source_ref=_sr(path, 34, 52)),
            Block(
                id="b3",
                kind=BlockKind.PARAGRAPH,
                text="1.1.1.1 The receiver shall scan all available channels within 10 seconds of power-on.",
                source_ref=_sr(path, 53, 140),
            ),
            Block(
                id="b4",
                kind=BlockKind.PARAGRAPH,
                text="1.1.1.1.a The receiver shall support terrestrial broadcast input.",
                source_ref=_sr(path, 141, 207),
            ),
        ],
    )


def _icd_style_doc() -> CanonicalDoc:
    path = "backplane_icd.md"
    return CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.MD, sha256="icdhash"),
        blocks=[
            Block(id="c0", kind=BlockKind.HEADING, heading_level=1, text="Power Distribution", source_ref=_sr(path, 0, 19)),
            Block(
                id="c1",
                kind=BlockKind.HEADING,
                heading_level=2,
                text="3.3V Rail Requirements",
                source_ref=_sr(path, 20, 43),
            ),
            Block(
                id="c2",
                kind=BlockKind.OPEN_TBD,
                text="OPEN: confirm connector part number before release.",
                source_ref=_sr(path, 44, 96),
            ),
            Block(id="c3", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_sr(path, 97, 111)),
        ],
    )


def test_tv_style_branch_autodetects_and_builds_epic_epic_feature_requirement() -> None:
    tree = build_baseline_tree(_tv_style_doc())
    types = [n.type for n in tree.nodes]
    assert types == [
        WorkItemType.EPIC,
        WorkItemType.EPIC,
        WorkItemType.FEATURE,
        WorkItemType.REQUIREMENT,
        WorkItemType.REQUIREMENT,
    ]
    requirement_node = tree.nodes[3]
    sub_requirement_node = tree.nodes[4]
    assert sub_requirement_node.parent_local_id == requirement_node.local_id


def test_icd_style_branch_autodetects_and_builds_feature_requirement() -> None:
    tree = build_baseline_tree(_icd_style_doc())
    types = [n.type for n in tree.nodes]
    assert types == [WorkItemType.FEATURE, WorkItemType.REQUIREMENT]
    requirement_node = tree.nodes[1]
    assert "OPEN: confirm connector part number" in requirement_node.description
    assert "[FIGURE: none]" in requirement_node.description


def test_same_depth_produces_different_types_per_branch() -> None:
    # This is the literal DoD case: "same-depth->different-type case".
    tv_doc = _tv_style_doc()
    icd_doc = _icd_style_doc()
    combined = CanonicalDoc(
        document=Document(path="combined.txt", format=DocumentFormat.TXT, sha256="combinedhash"),
        blocks=tv_doc.blocks + icd_doc.blocks,
    )
    tree = build_baseline_tree(combined)

    tv_depth2_node = tree.nodes[1]  # "1.1 Broadcast & Inputs" — depth 2 in the tv_style branch
    assert tv_depth2_node.type == WorkItemType.EPIC

    icd_depth2_node = tree.nodes[6]  # 5 tv-branch nodes (indices 0-4) then icd's 2nd node (index 6)
    assert icd_depth2_node.type == WorkItemType.REQUIREMENT

    assert tv_depth2_node.type != icd_depth2_node.type


def test_build_baseline_tree_is_deterministic() -> None:
    doc = _tv_style_doc()
    tree1 = build_baseline_tree(doc)
    tree2 = build_baseline_tree(doc)
    assert tree1.model_dump() == tree2.model_dump()


def test_fidelity_hash_is_sha256_of_display_text() -> None:
    import hashlib

    tree = build_baseline_tree(_tv_style_doc())
    epic_node = tree.nodes[0]
    assert epic_node.fidelity_hash == hashlib.sha256("Receiver".encode()).hexdigest()


def test_title_is_truncated_to_256_chars() -> None:
    long_text_doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(
                id="b0",
                kind=BlockKind.PARAGRAPH,
                text="1 " + ("A" * 300),
                source_ref=_sr("x.txt", 0, 302),
            )
        ],
    )
    tree = build_baseline_tree(long_text_doc)
    assert len(tree.nodes[0].title) == 256
