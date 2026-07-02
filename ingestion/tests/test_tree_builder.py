from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef, Table
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


def test_empty_blocks_produces_empty_tree() -> None:
    doc = CanonicalDoc(
        document=Document(path="empty.xlsx", format=DocumentFormat.XLSX, sha256="h"),
        blocks=[],
        tables=[Table(id="t0", rows=[["a", "b"]], source_ref=_sr("empty.xlsx", 0, 0))],
    )
    tree = build_baseline_tree(doc)
    assert tree.nodes == []


def test_long_unbroken_title_matches_extract_baseline_title_hard_cut_behavior() -> None:
    # Same fixture as the existing test_title_is_truncated_to_256_chars, but
    # asserting the actual word-boundary-aware algorithm is now in use (not
    # just a coincidentally-identical result from naive slicing).
    from app.distillation.title import extract_baseline_title

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
    expected = extract_baseline_title("A" * 300)
    assert tree.nodes[0].title == expected


def test_long_title_with_word_boundaries_is_trimmed_not_hard_cut() -> None:
    # A long block whose text has word boundaries before char 256 — proves
    # the new algorithm's boundary-aware behavior is actually wired in (the
    # OLD naive display_text.strip()[:256] slice would hard-cut mid-word
    # here; the new extract_baseline_title must not).
    long_sentence = ("The receiver shall support " + "channel " * 40).strip()
    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 " + long_sentence, source_ref=_sr("x.txt", 0, 10)),
        ],
    )
    tree = build_baseline_tree(doc)
    assert len(tree.nodes[0].title) <= 256
    assert not tree.nodes[0].title.endswith("chann")  # not a mid-word hard cut


def test_description_assembly_is_used_for_unleveled_block_folding() -> None:
    # ICD-style fixture already proves OPEN:/[FIGURE:] text lands in the
    # description (Phase 2's test_icd_style_branch_... test) — this test
    # additionally proves the exact newline-joined shape matches
    # assemble_description's contract precisely (not just "contains").
    from app.distillation.description import assemble_description

    icd_doc = _icd_style_doc()
    tree = build_baseline_tree(icd_doc)
    requirement_node = tree.nodes[1]
    expected = assemble_description(
        assemble_description("3.3V Rail Requirements", "OPEN: confirm connector part number before release."),
        "[FIGURE: none]",
    )
    assert requirement_node.description == expected


def test_fidelity_hash_reflects_folded_description_not_just_the_initiating_block() -> None:
    # Reproduces the Phase 4 bug: fidelity_hash was frozen at node-creation
    # time using only the FIRST block's text, but description keeps growing
    # as subsequent unleveled blocks fold in via assemble_description. After
    # folding, fidelity_hash must match the FINAL, fully-folded description —
    # not the single block that created the node.
    import hashlib

    icd_doc = _icd_style_doc()
    tree = build_baseline_tree(icd_doc)
    requirement_node = tree.nodes[1]
    expected_hash = hashlib.sha256(requirement_node.description.encode()).hexdigest()
    assert requirement_node.fidelity_hash == expected_hash


def test_customer_id_is_stamped_on_every_node_when_provided() -> None:
    icd_doc = _icd_style_doc()
    tree = build_baseline_tree(icd_doc, customer_id="CUST-042")
    assert len(tree.nodes) > 0
    for node in tree.nodes:
        assert node.customer_id == "CUST-042"


def test_customer_id_defaults_to_none_when_not_provided() -> None:
    icd_doc = _icd_style_doc()
    tree = build_baseline_tree(icd_doc)
    for node in tree.nodes:
        assert node.customer_id is None
