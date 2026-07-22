from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef, Table
from app.leveling.tree_builder import _bound_branch_size, _split_into_branches, build_baseline_tree
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


def test_table_only_document_folds_each_table_into_a_requirement_instead_of_an_empty_tree() -> None:
    # Regression: a table-only document (e.g. xlsx, whose loader never
    # produces doc.blocks at all) previously fell through the structured
    # path with zero blocks to level -> empty tree, silently producing no
    # work items at all for a real spreadsheet's content.
    doc = CanonicalDoc(
        document=Document(path="empty.xlsx", format=DocumentFormat.XLSX, sha256="h"),
        blocks=[],
        tables=[Table(id="t0", rows=[["a", "b"]], caption="Sheet1", source_ref=_sr("empty.xlsx", 0, 0))],
    )
    tree = build_baseline_tree(doc)
    assert len(tree.nodes) == 3  # synthetic Epic + Feature + one Requirement for the table
    epic, feature, requirement = tree.nodes
    assert epic.type == WorkItemType.EPIC
    assert feature.type == WorkItemType.FEATURE
    assert requirement.type == WorkItemType.REQUIREMENT
    assert requirement.parent_local_id == feature.local_id
    assert requirement.description == "<table><tr><td>a</td><td>b</td></tr></table>"


def test_table_only_document_folds_multiple_tables_into_separate_requirements() -> None:
    doc = CanonicalDoc(
        document=Document(path="multi.xlsx", format=DocumentFormat.XLSX, sha256="h"),
        blocks=[],
        tables=[
            Table(id="t0", rows=[["a"]], caption="Sheet1", source_ref=_sr("multi.xlsx", 0, 0)),
            Table(id="t1", rows=[["b"]], caption="Sheet2", source_ref=_sr("multi.xlsx", 0, 0)),
        ],
    )
    tree = build_baseline_tree(doc)
    requirements = [n for n in tree.nodes if n.type == WorkItemType.REQUIREMENT]
    assert len(requirements) == 2
    assert {r.title for r in requirements} == {"Sheet1", "Sheet2"}


def test_table_only_document_skips_a_fully_blank_table_rather_than_creating_an_empty_node() -> None:
    doc = CanonicalDoc(
        document=Document(path="blank.xlsx", format=DocumentFormat.XLSX, sha256="h"),
        blocks=[],
        tables=[Table(id="t0", rows=[["", ""], ["", ""]], caption="Sheet1", source_ref=_sr("blank.xlsx", 0, 0))],
    )
    tree = build_baseline_tree(doc)
    requirements = [n for n in tree.nodes if n.type == WorkItemType.REQUIREMENT]
    assert requirements == []


def test_a_document_with_neither_blocks_nor_tables_still_produces_an_empty_tree() -> None:
    doc = CanonicalDoc(
        document=Document(path="empty.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[],
        tables=[],
    )
    tree = build_baseline_tree(doc)
    assert tree.nodes == []


def test_child_type_is_computed_one_level_deeper_per_node_tv_style() -> None:
    tree = build_baseline_tree(_tv_style_doc())
    child_types = [n.child_type for n in tree.nodes]
    assert child_types == [
        WorkItemType.EPIC,        # depth1 Epic -> depth2 is still Epic in tv_style
        WorkItemType.FEATURE,     # depth2 Epic -> depth3 is Feature
        WorkItemType.REQUIREMENT, # depth3 Feature -> depth4 is Requirement
        WorkItemType.REQUIREMENT, # depth4 Requirement -> depth5 stays Requirement
        WorkItemType.REQUIREMENT, # depth5 Requirement -> depth6 stays Requirement
    ]


def test_child_type_is_computed_one_level_deeper_per_node_icd_style() -> None:
    tree = build_baseline_tree(_icd_style_doc())
    child_types = [n.child_type for n in tree.nodes]
    assert child_types == [WorkItemType.REQUIREMENT, WorkItemType.REQUIREMENT]


def test_headingless_document_child_types_follow_the_synthetic_epic_feature_requirement_shape() -> None:
    tree = build_baseline_tree(_headingless_doc())
    epic, feature = tree.nodes[0], tree.nodes[1]
    requirements = tree.nodes[2:]
    assert epic.child_type == WorkItemType.FEATURE
    assert feature.child_type == WorkItemType.REQUIREMENT
    assert all(r.child_type == WorkItemType.REQUIREMENT for r in requirements)


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


def _headingless_doc() -> CanonicalDoc:
    path = "flat_notes.txt"
    return CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="flathash"),
        blocks=[
            Block(
                id="f0",
                kind=BlockKind.PARAGRAPH,
                text="The system shall support at least four simultaneous audio channels.",
                source_ref=_sr(path, 0, 68),
            ),
            Block(
                id="f1",
                kind=BlockKind.PARAGRAPH,
                text="Startup power draw should stay under two watts.",
                source_ref=_sr(path, 69, 118),
            ),
            Block(
                id="f2",
                kind=BlockKind.PARAGRAPH,
                text="The unit shall survive a one-meter drop onto a hard surface.",
                source_ref=_sr(path, 119, 181),
            ),
        ],
    )


def test_headingless_document_synthesizes_epic_feature_and_requirements() -> None:
    # Grouping-without-headings rule: a document with NO heading/numbering
    # structure at all must NOT produce zero nodes (the pre-fix behavior —
    # every block resolved depth=None and the stack never opened). It must
    # synthesize one Epic -> one Feature, with every paragraph folded in as
    # its own Requirement child.
    tree = build_baseline_tree(_headingless_doc())

    assert len(tree.nodes) == 5  # 1 Epic + 1 Feature + 3 Requirements
    epic, feature = tree.nodes[0], tree.nodes[1]
    assert epic.type == WorkItemType.EPIC
    assert epic.parent_local_id is None
    assert feature.type == WorkItemType.FEATURE
    assert feature.parent_local_id == epic.local_id

    requirements = tree.nodes[2:]
    assert all(r.type == WorkItemType.REQUIREMENT for r in requirements)
    assert all(r.parent_local_id == feature.local_id for r in requirements)
    # Requirement descriptions are verbatim — untouched by the synthetic
    # grouping, unlike the two synthetic parent nodes above them.
    assert requirements[0].description == "The system shall support at least four simultaneous audio channels."
    assert requirements[1].description == "Startup power draw should stay under two watts."
    assert requirements[2].description == "The unit shall survive a one-meter drop onto a hard surface."


def test_headingless_document_title_is_derived_from_filename() -> None:
    tree = build_baseline_tree(_headingless_doc())
    epic, feature = tree.nodes[0], tree.nodes[1]
    assert epic.title == "flat notes"
    assert feature.title == "flat notes"


def test_headingless_document_nodes_pass_fidelity_verification() -> None:
    from app.workitem.fidelity import verify_fidelity

    tree = build_baseline_tree(_headingless_doc())
    for node in tree.nodes:
        assert verify_fidelity(node)


def test_structured_document_is_unaffected_by_the_headingless_fallback() -> None:
    # Regression guard: any document with at least one resolvable depth
    # (heading or numbering) must take the ORIGINAL structured path, not
    # the synthetic Epic/Feature fallback.
    tv_tree = build_baseline_tree(_tv_style_doc())
    icd_tree = build_baseline_tree(_icd_style_doc())
    assert tv_tree.nodes[0].type == WorkItemType.EPIC
    assert icd_tree.nodes[0].type == WorkItemType.FEATURE


def test_mock_flat_docx_end_to_end_through_the_headingless_fallback() -> None:
    # End-to-end golden case (see tests/fixtures/build_mock_flat_docx.py):
    # a REAL parsed .docx with no heading styles and no numbering anywhere,
    # not just a hand-built in-memory Block list.
    from pathlib import Path

    from app.loaders.docx_loader import load_docx

    fixture_path = Path(__file__).parent / "fixtures" / "mock_flat.docx"
    doc = load_docx(str(fixture_path))
    tree = build_baseline_tree(doc)

    assert len(tree.nodes) == 5  # 1 Epic + 1 Feature + 3 Requirements
    assert tree.nodes[0].type == WorkItemType.EPIC
    assert tree.nodes[1].type == WorkItemType.FEATURE


def _flat_numbered_list_doc(n: int) -> CanonicalDoc:
    path = "flat_list.txt"
    return CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="flathash"),
        blocks=[
            Block(
                id=f"b{i}",
                kind=BlockKind.PARAGRAPH,
                text=f"{i + 1} System shall satisfy requirement number {i + 1}.",
                source_ref=_sr(path, i * 10, i * 10 + 9),
            )
            for i in range(n)
        ],
    )


def test_flat_numbered_list_synthesizes_epic_feature_and_requirements() -> None:
    # Flat single-column list rule: every top-level branch is a single lone
    # block (numbering resolves depth=1 for each, but nothing ever nests
    # under any of them) -- previously each became its own orphan top-level
    # Feature with no parent at all. Must now group under one synthesized
    # Epic/Feature, same shape as the headingless case.
    tree = build_baseline_tree(_flat_numbered_list_doc(3))

    assert len(tree.nodes) == 5  # 1 Epic + 1 Feature + 3 Requirements
    epic, feature = tree.nodes[0], tree.nodes[1]
    assert epic.type == WorkItemType.EPIC
    assert epic.parent_local_id is None
    assert feature.type == WorkItemType.FEATURE
    assert feature.parent_local_id == epic.local_id

    requirements = tree.nodes[2:]
    assert all(r.type == WorkItemType.REQUIREMENT for r in requirements)
    assert all(r.parent_local_id == feature.local_id for r in requirements)
    # The numbering label itself is stripped from title/description, same as
    # the structured path's display_text -- only the remainder is verbatim.
    assert requirements[0].description == "System shall satisfy requirement number 1."


def test_flat_numbered_list_handles_a_deep_list_without_losing_any_item() -> None:
    # A larger flat list (well past a handful of items) must still produce
    # exactly one Requirement per item, all under the same synthesized
    # Feature -- no item silently dropped or misgrouped as N grows.
    n = 50
    tree = build_baseline_tree(_flat_numbered_list_doc(n))

    assert len(tree.nodes) == n + 2
    requirements = tree.nodes[2:]
    assert len(requirements) == n
    assert all(r.parent_local_id == tree.nodes[1].local_id for r in requirements)
    assert requirements[-1].description == f"System shall satisfy requirement number {n}."


def test_single_flat_item_is_left_to_the_structured_path_not_regrouped() -> None:
    # A document with exactly one flat numbered item is too ambiguous to
    # confidently regroup (len(branches) > 1 guard in build_baseline_tree) --
    # it takes the original structured path, producing one ungrouped Feature.
    tree = build_baseline_tree(_flat_numbered_list_doc(1))

    assert len(tree.nodes) == 1
    assert tree.nodes[0].type == WorkItemType.FEATURE
    assert tree.nodes[0].parent_local_id is None


def test_mixed_numbering_styles_in_one_branch_still_resolve_depth_correctly() -> None:
    # A branch mixing hierarchical dotted numbering ("1", "1.1") with a
    # trailing-letter sub-item ("1.1.a") in the same branch -- proves depth
    # resolution and parent/child assignment both hold across the mix, not
    # just for a uniformly-dotted branch.
    path = "mixed.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="mixedhash"),
        blocks=[
            Block(id="m0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr(path, 0, 10)),
            Block(id="m1", kind=BlockKind.PARAGRAPH, text="1.1 Broadcast & Inputs", source_ref=_sr(path, 11, 33)),
            Block(id="m2", kind=BlockKind.PARAGRAPH, text="1.1.1 Channel scan", source_ref=_sr(path, 34, 52)),
            Block(
                id="m3",
                kind=BlockKind.PARAGRAPH,
                text="1.1.1.a The receiver shall support terrestrial broadcast input.",
                source_ref=_sr(path, 53, 120),
            ),
        ],
    )
    tree = build_baseline_tree(doc)
    by_title = {n.title: n for n in tree.nodes}

    receiver = by_title["Receiver"]
    broadcast = by_title["Broadcast & Inputs"]
    channel_scan = by_title["Channel scan"]
    sub_item = next(n for n in tree.nodes if n.parent_local_id == channel_scan.local_id)

    assert broadcast.parent_local_id == receiver.local_id
    assert channel_scan.parent_local_id == broadcast.local_id
    assert sub_item.description == "The receiver shall support terrestrial broadcast input."


def test_table_with_a_fully_blank_row_skips_only_that_row_not_the_whole_table() -> None:
    # Distinct from test_table_only_document_skips_a_fully_blank_table_...
    # above (every row blank -> whole table skipped): here only ONE row of a
    # table with real content elsewhere is blank -- that row must contribute
    # no line at all to the folded description, while the real rows survive.
    path = "table.xlsx"
    table = Table(
        id="t0",
        rows=[["Header A", "Header B"], ["", ""], ["value 1", "value 2"]],
        source_ref=_sr(path, 0, 1),
    )
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.XLSX, sha256="tablehash"),
        blocks=[],
        tables=[table],
    )
    tree = build_baseline_tree(doc)

    requirement = next(n for n in tree.nodes if n.type == WorkItemType.REQUIREMENT)
    assert requirement.description == (
        "<table><tr><td>Header A</td><td>Header B</td></tr><tr><td>value 1</td><td>value 2</td></tr></table>"
    )


def test_document_with_both_headings_and_tables_no_longer_drops_the_table() -> None:
    # Regression: a document with real heading blocks took the structured
    # path and doc.tables was never even looked at -- silently dropping
    # every table's content with no warning at all. Tables are now folded
    # in after the structured pass, each as a Requirement child of the last
    # block-derived node (see build_baseline_tree's docstring for why "last"
    # is a documented approximation, not a precise position).
    path = "mixed.docx"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.DOCX, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Power Distribution", source_ref=_sr(path, 0, 19)),
            Block(id="b1", kind=BlockKind.HEADING, heading_level=2, text="3.3V Rail Requirements", source_ref=_sr(path, 20, 43)),
        ],
        tables=[Table(id="t0", rows=[["Rail", "Voltage"], ["3.3V", "3.3"]], caption="Rail Table", source_ref=_sr(path, 44, 45))],
    )
    tree = build_baseline_tree(doc)

    requirements = [n for n in tree.nodes if n.type == WorkItemType.REQUIREMENT]
    table_node = next(n for n in requirements if n.title == "Rail Table")
    assert table_node.description == "<table><tr><td>Rail</td><td>Voltage</td></tr><tr><td>3.3V</td><td>3.3</td></tr></table>"
    # Attached under the last node the block-leveling pass produced.
    assert table_node.parent_local_id == tree.nodes[1].local_id


def test_document_with_both_headings_and_tables_skips_a_fully_blank_table() -> None:
    path = "mixed_blank.docx"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.DOCX, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Power Distribution", source_ref=_sr(path, 0, 19))],
        tables=[Table(id="t0", rows=[["", ""]], caption="Blank", source_ref=_sr(path, 20, 21))],
    )
    tree = build_baseline_tree(doc)

    assert all(n.type != WorkItemType.REQUIREMENT for n in tree.nodes)


def test_table_html_escapes_cell_content() -> None:
    # Cell text is untrusted source-document content about to be embedded in
    # an HTML rich-text field -- it must be escaped, not injected raw.
    path = "escape.xlsx"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.XLSX, sha256="h"),
        blocks=[],
        tables=[Table(id="t0", rows=[["<script>alert(1)</script>", "A & B"]], caption="Sheet1", source_ref=_sr(path, 0, 0))],
    )
    tree = build_baseline_tree(doc)

    requirement = next(n for n in tree.nodes if n.type == WorkItemType.REQUIREMENT)
    assert "<script>" not in requirement.description
    assert "&lt;script&gt;" in requirement.description
    assert "A &amp; B" in requirement.description


def test_split_into_branches_uses_the_documents_own_shallowest_depth_not_hardcoded_1() -> None:
    # Reproduces a real failure observed running SURVEY mode against a real
    # 800-paragraph ICD document: its template reserves Heading 1 for the
    # document title only, so every body section starts at Heading 2 (depth
    # 2) -- _split_into_branches previously only ever split on depth==1,
    # so the ENTIRE document collapsed into one branch (500+ nodes),
    # blowing every per-branch LLM-call timeout in SURVEY mode. It must
    # split on whichever depth is actually the document's shallowest.
    path = "starts_at_depth_2.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="2.1 Section One", source_ref=_sr(path, 0, 10)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="2.1.1 The system shall do A.", source_ref=_sr(path, 11, 20)),
            Block(id="b2", kind=BlockKind.PARAGRAPH, text="2.2 Section Two", source_ref=_sr(path, 21, 30)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="2.2.1 The system shall do B.", source_ref=_sr(path, 31, 40)),
        ],
    )

    branches = _split_into_branches(doc)

    assert len(branches) == 2
    assert [b.id for b in branches[0]] == ["b0", "b1"]
    assert [b.id for b in branches[1]] == ["b2", "b3"]


def test_split_into_branches_still_splits_on_depth_1_when_the_document_has_it() -> None:
    # No regression for the common case (document's shallowest heading IS
    # depth 1) -- must behave exactly as before.
    path = "starts_at_depth_1.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Section One", source_ref=_sr(path, 0, 10)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="1.1 The system shall do A.", source_ref=_sr(path, 11, 20)),
            Block(id="b2", kind=BlockKind.PARAGRAPH, text="2 Section Two", source_ref=_sr(path, 21, 30)),
        ],
    )

    branches = _split_into_branches(doc)

    assert len(branches) == 2
    assert [b.id for b in branches[0]] == ["b0", "b1"]
    assert [b.id for b in branches[1]] == ["b2"]


def _numbered_block(path: str, index: int, label: str) -> Block:
    return Block(id=f"b{index}", kind=BlockKind.PARAGRAPH, text=f"{label} text", source_ref=_sr(path, index, index + 1))


def test_bound_branch_size_leaves_a_small_branch_untouched() -> None:
    path = "small.txt"
    branch = [_numbered_block(path, 0, "2.1"), _numbered_block(path, 1, "2.1.1")]

    result = _bound_branch_size(branch, max_block_count=10)

    assert result == [branch]


def test_bound_branch_size_splits_an_oversized_branch_at_its_own_next_depth_level() -> None:
    # Reproduces a real failure: a document can have very few top-level
    # sections that are themselves still far too large for a single
    # per-branch LLM call -- _split_into_branches alone cannot fix this,
    # since it only ever splits at the document's shallowest depth. Must
    # re-split at the NEXT depth level found within the oversized branch.
    path = "oversized.txt"
    branch = [
        _numbered_block(path, 0, "2"),  # boundary depth (1 segment) -- the branch's own heading
        _numbered_block(path, 1, "2.1"),  # 1st sub-branch starts (2 segments)
        _numbered_block(path, 2, "2.1.1"),
        _numbered_block(path, 3, "2.2"),  # 2nd sub-branch starts
        _numbered_block(path, 4, "2.2.1"),
        _numbered_block(path, 5, "2.3"),  # 3rd sub-branch starts
    ]

    result = _bound_branch_size(branch, max_block_count=3)

    # The structural split alone would yield 4 small pieces ([b0], [b1,b2],
    # [b3,b4], [b5]); adjacent pieces are then greedily re-merged in
    # document order back up toward max_block_count, so this becomes 2
    # pieces instead of 4 -- fewer, larger branches means fewer LLM calls.
    assert [b.id for b in result[0]] == ["b0", "b1", "b2"]
    assert [b.id for b in result[1]] == ["b3", "b4", "b5"]
    assert all(len(b) <= 3 for b in result)
    # No block lost or duplicated across the split.
    assert sum(len(b) for b in result) == len(branch)


def test_bound_branch_size_recurses_when_one_sub_split_is_still_too_big() -> None:
    path = "deep.txt"
    branch = [
        _numbered_block(path, 0, "2"),
        _numbered_block(path, 1, "2.1"),
        _numbered_block(path, 2, "2.1.1"),  # 3rd level -- lets sub-branch 2.1 split further
        _numbered_block(path, 3, "2.1.2"),
        _numbered_block(path, 4, "2.2"),
    ]

    result = _bound_branch_size(branch, max_block_count=2)

    assert all(len(b) <= 2 for b in result)
    assert sum(len(b) for b in result) == len(branch)


def test_bound_branch_size_merges_many_small_sibling_sections_to_cut_llm_call_count() -> None:
    # Reproduces the real optimization target: a document with many small,
    # fine-grained sibling sections (e.g. a clause per sub-heading) would,
    # without merging, produce one LLM call per tiny section -- far more
    # round trips than the branch-size cap actually requires. Six small
    # sections (1-2 blocks each) under a cap of 5 should collapse into far
    # fewer branches, each close to but not exceeding the cap.
    path = "many_small_sections.txt"
    branch = [
        _numbered_block(path, 0, "2.1"),
        _numbered_block(path, 1, "2.2"),
        _numbered_block(path, 2, "2.2.1"),
        _numbered_block(path, 3, "2.3"),
        _numbered_block(path, 4, "2.4"),
        _numbered_block(path, 5, "2.4.1"),
        _numbered_block(path, 6, "2.5"),
        _numbered_block(path, 7, "2.6"),
    ]

    result = _bound_branch_size(branch, max_block_count=5)

    assert len(result) < len(branch)
    assert all(len(b) <= 5 for b in result)
    assert sum(len(b) for b in result) == len(branch)
    # Document order is preserved across the merged groups.
    assert [b.id for group in result for b in group] == [f"b{i}" for i in range(8)]


def test_bound_branch_size_leaves_a_flat_oversized_branch_unsplit_when_no_finer_structure_exists() -> None:
    # A branch that genuinely has no sub-heading structure at all (every
    # block at the same depth, or unleveled body text) cannot be split
    # smaller without an arbitrary cut -- must be returned as-is rather than
    # looping or silently dropping content.
    path = "flat.txt"
    branch = [_numbered_block(path, i, "2.1") for i in range(5)]

    result = _bound_branch_size(branch, max_block_count=2)

    assert result == [branch]
