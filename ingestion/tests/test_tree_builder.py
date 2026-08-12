from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, Figure, SourceRef, Table, TableCell, plain_text_rows
from app.leveling.tree_builder import (
    _bound_branch_size,
    _build_flat_list_tree,
    _hash_identity,
    _split_into_branches,
    _table_to_html,
    _widen_page_end,
    build_baseline_tree,
)
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
    # A placeholder-only figure (no real caption) must be omitted, not leak
    # the literal "[FIGURE: none]" wire-format string into the work item
    # description -- see _figure_line in tree_builder.py.
    assert "[FIGURE:" not in requirement_node.description


def test_baseline_fold_renders_a_real_figure_caption_as_a_blockquote() -> None:
    # BASELINE mode never calls a vision model, but a caption CAN still be
    # present (e.g. a caption embedded in the source doc's own alt-text).
    # This must render the same clearly-labeled way SURVEY mode does, not
    # leak the raw "[FIGURE: ...]" wire-format text.
    path = "backplane_icd.md"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.MD, sha256="icdhash2"),
        blocks=[
            Block(id="d0", kind=BlockKind.HEADING, heading_level=1, text="Power Distribution", source_ref=_sr(path, 0, 19)),
            Block(
                id="d1",
                kind=BlockKind.HEADING,
                heading_level=2,
                text="3.3V Rail Requirements",
                source_ref=_sr(path, 20, 43),
            ),
            Block(id="d2", kind=BlockKind.FIGURE, text="[FIGURE: Rail topology diagram]", source_ref=_sr(path, 44, 76)),
        ],
    )
    tree = build_baseline_tree(doc)
    requirement_node = tree.nodes[-1]
    assert "> Figure: Rail topology diagram" in requirement_node.description
    assert "[FIGURE:" not in requirement_node.description


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


def test_a_branch_starting_with_no_recognized_heading_folds_its_orphan_block_into_front_matter() -> None:
    # A depth=None block reached before any node is open in its branch (its
    # first line has no heading/numbering the parser recognized) is no
    # longer dropped -- it is buffered and folded into a synthetic
    # front-matter node once the document's first real node is created (see
    # tree_builder.py's orphan_entries buffer). A warning still fires so a
    # human reviewer can see it happened, distinct from a normal fold.
    path = "orphan.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="orphanhash"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="a stray line with no numbering at all", source_ref=_sr(path, 0, 38)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr(path, 39, 49)),
            Block(id="b2", kind=BlockKind.PARAGRAPH, text="1.1 Broadcast & Inputs", source_ref=_sr(path, 50, 72)),
        ],
    )
    tree = build_baseline_tree(doc)
    front_matter_node = next(n for n in tree.nodes if "stray line" in n.description)
    assert front_matter_node.title.startswith("Front Matter:")
    assert len(tree.warnings) == 1
    assert "stray line" in tree.warnings[0].raw


def test_a_document_with_a_recognized_heading_first_produces_no_warnings() -> None:
    # Companion to the test above -- proves the warning is specifically
    # about an orphaned depth=None block, not a general "always warn" change
    # in behavior for BASELINE.
    tree = build_baseline_tree(_tv_style_doc())
    assert tree.warnings == []


def test_fidelity_hash_is_sha256_of_display_text() -> None:
    import hashlib

    tree = build_baseline_tree(_tv_style_doc())
    epic_node = tree.nodes[0]
    assert epic_node.fidelity_hash == hashlib.sha256("Receiver".encode()).hexdigest()


def test_two_byte_identical_requirement_lines_get_distinct_identity_hashes() -> None:
    # Regression: two genuinely distinct source lines with byte-identical
    # text (e.g. the AirPro ICD's "GA2 shall be replaced to signal
    # PS_INPUT_FAIL_L." appearing twice, at two different requirement IDs)
    # previously shared the same fidelity_hash = sha256(description) -- the
    # orchestrator's idempotency lookup reused THAT hash as its key, so the
    # second line resolved to 'reuse' against the first's ADO id instead of
    # becoming its own distinct work item, even on a FIRST ingest with no
    # follow-up/dedup involved at all. identity_hash folds in each node's
    # own source position, so two identical-text nodes now hash distinctly
    # while their fidelity_hash (drift detection, unrelated to identity)
    # stays equal, as it must -- verify_fidelity only ever compares a node's
    # description against ITS OWN fidelity_hash.
    path = "repeats.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="repeatshash"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Power Sequencing", source_ref=_sr(path, 0, 18)),
            Block(
                id="b1", kind=BlockKind.PARAGRAPH,
                text="1.1 GA2 shall be replaced to signal PS_INPUT_FAIL_L.",
                source_ref=_sr(path, 19, 72),
            ),
            Block(
                id="b2", kind=BlockKind.PARAGRAPH,
                text="1.2 GA2 shall be replaced to signal PS_INPUT_FAIL_L.",
                source_ref=_sr(path, 73, 126),
            ),
        ],
    )
    tree = build_baseline_tree(doc)
    repeated = [n for n in tree.nodes if "GA2 shall be replaced" in n.description]
    assert len(repeated) == 2
    assert repeated[0].fidelity_hash == repeated[1].fidelity_hash  # same text, drift-detection hash is equal
    assert repeated[0].identity_hash != repeated[1].identity_hash  # different position, distinct identity


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
        tables=[Table(id="t0", cells=[[TableCell(text=c) for c in row] for row in [["a", "b"]]], caption="Sheet1", source_ref=_sr("empty.xlsx", 0, 0))],
    )
    tree = build_baseline_tree(doc)
    assert len(tree.nodes) == 3  # synthetic Epic + Feature + one Requirement for the table
    epic, feature, requirement = tree.nodes
    assert epic.type == WorkItemType.EPIC
    assert feature.type == WorkItemType.FEATURE
    assert requirement.type == WorkItemType.REQUIREMENT
    assert requirement.parent_local_id == feature.local_id
    # Real semantic HTML now: caption rendered, non-header row grouped
    # into <tbody> (no leading header row here, so no <thead> at all).
    assert requirement.description == "<table><caption>Sheet1</caption><tbody><tr><td>a</td><td>b</td></tr></tbody></table>"


def test_table_only_document_folds_multiple_tables_into_separate_requirements() -> None:
    doc = CanonicalDoc(
        document=Document(path="multi.xlsx", format=DocumentFormat.XLSX, sha256="h"),
        blocks=[],
        tables=[
            Table(id="t0", cells=[[TableCell(text=c) for c in row] for row in [["a"]]], caption="Sheet1", source_ref=_sr("multi.xlsx", 0, 0)),
            Table(id="t1", cells=[[TableCell(text=c) for c in row] for row in [["b"]]], caption="Sheet2", source_ref=_sr("multi.xlsx", 0, 0)),
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
        tables=[Table(id="t0", cells=[[TableCell(text=c) for c in row] for row in [["", ""], ["", ""]]], caption="Sheet1", source_ref=_sr("blank.xlsx", 0, 0))],
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
    # ICD-style fixture already proves OPEN: text lands in the description
    # (Phase 2's test_icd_style_branch_... test) — this test additionally
    # proves the exact newline-joined shape matches assemble_description's
    # contract precisely (not just "contains"). The fixture's trailing
    # placeholder-only FIGURE block folds in nothing (see _figure_line) --
    # it never reaches assemble_description at all.
    from app.distillation.description import assemble_description

    icd_doc = _icd_style_doc()
    tree = build_baseline_tree(icd_doc)
    requirement_node = tree.nodes[1]
    expected = assemble_description("3.3V Rail Requirements", "OPEN: confirm connector part number before release.")
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
    # it takes the original structured path. Under the bottom-up classifier
    # (autodetect.classify_numbering_branch), a lone item with zero children
    # is a leaf, and a leaf is a Requirement -- not the old depth-threshold
    # heuristic's Feature default (a single flat item with no substructure
    # at all has no "one level above a leaf" position to be Feature at).
    tree = build_baseline_tree(_flat_numbered_list_doc(1))

    assert len(tree.nodes) == 1
    assert tree.nodes[0].type == WorkItemType.REQUIREMENT
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
        cells=[[TableCell(text=c) for c in row] for row in [["Header A", "Header B"], ["", ""], ["value 1", "value 2"]]],
        source_ref=_sr(path, 0, 1),
    )
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.XLSX, sha256="tablehash"),
        blocks=[],
        tables=[table],
    )
    tree = build_baseline_tree(doc)

    requirement = next(n for n in tree.nodes if n.type == WorkItemType.REQUIREMENT)
    # No caption on this table, and no cell is is_header=True, so "Header A"/
    # "Header B" is plain text here -- everything lands in one <tbody>, no
    # <thead>. The blank middle row contributes nothing at all.
    assert requirement.description == (
        "<table><tbody><tr><td>Header A</td><td>Header B</td></tr>"
        "<tr><td>value 1</td><td>value 2</td></tr></tbody></table>"
    )


def test_document_with_both_headings_and_tables_folds_the_table_into_its_parent_description() -> None:
    # A table belongs INSIDE its parent item's Description, never as its own
    # separate work item (non-goal: "turning embedded tables into separate
    # work items" -- see the AirPro ICD's own 294208/294209/294210/294248/
    # 294611, all living inside their parent's Description). Previously every
    # table was emitted as its OWN Requirement, appended after all
    # block-leveling regardless of the table's real position -- this proves
    # the corrected behavior: the table's HTML lands inside the Description
    # of whichever node was open at its real document-order position
    # (here, the last block before it -- "3.3V Rail Requirements"), and no
    # extra node is created for it at all.
    path = "mixed.docx"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.DOCX, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Power Distribution", source_ref=_sr(path, 0, 19)),
            Block(id="b1", kind=BlockKind.HEADING, heading_level=2, text="3.3V Rail Requirements", source_ref=_sr(path, 20, 43)),
        ],
        tables=[Table(id="t0", cells=[[TableCell(text=c) for c in row] for row in [["Rail", "Voltage"], ["3.3V", "3.3"]]], caption="Rail Table", source_ref=_sr(path, 44, 45))],
    )
    tree = build_baseline_tree(doc)

    assert len(tree.nodes) == 2  # no extra node was created for the table
    parent = next(n for n in tree.nodes if n.title == "3.3V Rail Requirements")
    assert parent.description == (
        "3.3V Rail Requirements"
        "\n<table><caption>Rail Table</caption><tbody><tr><td>Rail</td><td>Voltage</td></tr>"
        "<tr><td>3.3V</td><td>3.3</td></tr></tbody></table>"
    )
    assert tree.warnings == []


def test_a_table_before_any_heading_in_its_branch_is_folded_into_front_matter() -> None:
    # Companion to the front-matter fold test for blocks: a table can be
    # orphaned exactly the same way a block can (no node open yet to fold
    # into) -- it is folded into the same synthetic front-matter node, not
    # dropped.
    path = "table_orphan.docx"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.DOCX, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Power Distribution", source_ref=_sr(path, 20, 39))],
        tables=[Table(id="t0", cells=[[TableCell(text=c) for c in row] for row in [["Rail", "Voltage"]]], caption="Rail Table", source_ref=_sr(path, 0, 1))],
    )
    tree = build_baseline_tree(doc)

    assert len(tree.nodes) == 2
    front_matter_node = next(n for n in tree.nodes if "Rail" in n.description)
    assert front_matter_node.parent_local_id == tree.nodes[0].local_id
    assert len(tree.warnings) == 1
    assert "Rail Table" in tree.warnings[0].raw


def test_leading_table_and_prose_both_fold_into_one_shared_front_matter_node() -> None:
    # A document's real preamble is rarely a single orphan -- a cover table
    # AND intro prose can both precede the first heading. Both must land in
    # the SAME synthetic front-matter node (joined via assemble_description,
    # in document order), not one dropped for only one buffered.
    path = "mixed_front_matter.docx"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.DOCX, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="Scope: this document covers the power subsystem.", source_ref=_sr(path, 0, 10)),
            Block(id="b1", kind=BlockKind.HEADING, heading_level=1, text="Power Distribution", source_ref=_sr(path, 40, 59)),
            # A second, nested heading -- without it this branch would be a
            # single lone block, and _split_into_branches/build_baseline_tree
            # would route the WHOLE document through _build_flat_list_tree
            # instead of the structured per-branch path this test targets.
            Block(id="b2", kind=BlockKind.HEADING, heading_level=2, text="3.3V Rail", source_ref=_sr(path, 60, 69)),
        ],
        tables=[Table(id="t0", cells=[[TableCell(text=c) for c in row] for row in [["Rev", "Date"], ["A", "2026-01-01"]]], caption="Revision History", source_ref=_sr(path, 20, 21))],
    )
    tree = build_baseline_tree(doc)

    assert len(tree.nodes) == 3
    front_matter_node = next(n for n in tree.nodes if n.title.startswith("Front Matter:"))
    assert front_matter_node.parent_local_id == tree.nodes[0].local_id
    assert "Scope: this document covers the power subsystem." in front_matter_node.description
    assert "Rev" in front_matter_node.description and "2026-01-01" in front_matter_node.description
    # Document order preserved: the table (offset 20) sits between the
    # prose (offset 0) and the heading (offset 40) -- it must appear AFTER
    # the prose in the joined description, not before.
    assert front_matter_node.description.index("Scope:") < front_matter_node.description.index("Rev")
    # Both front-matter folds (the table AND the prose block) are the same
    # IntegrityWarning kind with no natural sub-key, so finalize_warnings
    # merges them into ONE summary record instead of two near-identical lines.
    assert len(tree.warnings) == 1
    assert tree.warnings[0].detail["mergedCount"] == 2


def test_document_with_both_headings_and_tables_skips_a_fully_blank_table() -> None:
    path = "mixed_blank.docx"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.DOCX, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Power Distribution", source_ref=_sr(path, 0, 19))],
        tables=[Table(id="t0", cells=[[TableCell(text=c) for c in row] for row in [["", ""]]], caption="Blank", source_ref=_sr(path, 20, 21))],
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
        tables=[Table(id="t0", cells=[[TableCell(text=c) for c in row] for row in [["<script>alert(1)</script>", "A & B"]]], caption="Sheet1", source_ref=_sr(path, 0, 0))],
    )
    tree = build_baseline_tree(doc)

    requirement = next(n for n in tree.nodes if n.type == WorkItemType.REQUIREMENT)
    assert "<script>" not in requirement.description
    assert "&lt;script&gt;" in requirement.description
    assert "A &amp; B" in requirement.description


def test_table_to_html_wraps_a_fully_header_row_in_thead_with_th_cells() -> None:
    # Direct unit test of the Phase 1 rewrite's thead/th emission: a row
    # where EVERY real cell is is_header=True becomes a <thead> row of
    # <th> cells; the following ordinary row is plain <td> in <tbody>.
    table = Table(
        id="t0",
        cells=[
            [TableCell(text="Col A", is_header=True), TableCell(text="Col B", is_header=True)],
            [TableCell(text="1"), TableCell(text="2")],
        ],
        source_ref=_sr("x.xlsx", 0, 0),
    )
    assert _table_to_html(table) == (
        "<table><thead><tr><th>Col A</th><th>Col B</th></tr></thead>"
        "<tbody><tr><td>1</td><td>2</td></tr></tbody></table>"
    )


def test_table_to_html_only_groups_the_leading_run_of_header_rows_into_thead() -> None:
    # A header row that is NOT at the very top (the "odd position" case the
    # rewrite's docstring documents as a deliberate v1 limitation) still
    # renders its cells as <th>, but stays inside <tbody> -- standard HTML
    # supports only one <thead>/<tbody> pair per table, so a second,
    # out-of-order header run cannot get its own <thead>.
    table = Table(
        id="t0",
        cells=[
            [TableCell(text="1"), TableCell(text="2")],
            [TableCell(text="H1", is_header=True), TableCell(text="H2", is_header=True)],
        ],
        source_ref=_sr("x.xlsx", 0, 0),
    )
    assert _table_to_html(table) == (
        "<table><tbody><tr><td>1</td><td>2</td></tr><tr><th>H1</th><th>H2</th></tr></tbody></table>"
    )


def test_table_to_html_emits_colspan_and_rowspan_attributes_only_when_greater_than_one() -> None:
    # colspan="1"/rowspan="1" (the default, ordinary case) must NOT appear
    # in the output -- only real spans (>1) get an attribute, matching a
    # hand-authored table's own convention.
    table = Table(
        id="t0",
        cells=[
            [TableCell(text="Wide", colspan=2), None],
            [TableCell(text="a"), TableCell(text="b")],
        ],
        source_ref=_sr("x.xlsx", 0, 0),
    )
    html_out = _table_to_html(table)
    assert html_out == (
        '<table><tbody><tr><td colspan="2">Wide</td></tr>'
        "<tr><td>a</td><td>b</td></tr></tbody></table>"
    )
    assert 'colspan="1"' not in html_out
    assert 'rowspan="1"' not in html_out


def test_table_to_html_distinguishes_a_spanned_none_position_from_a_genuine_empty_gap() -> None:
    # The single most important structural rule in this rewrite: a None
    # grid position (absorbed by the preceding cell's colspan) must
    # contribute NO <td> at all, while a real TableCell(text="") (a
    # genuine gap) DOES get its own empty <td></td>. Both appear in the
    # SAME row here to prove they render differently, not just that each
    # works in isolation.
    table = Table(
        id="t0",
        cells=[[TableCell(text="a", colspan=2), None, TableCell(text="")]],
        source_ref=_sr("x.xlsx", 0, 0),
    )
    # Exactly two <td> elements: the colspan=2 origin cell, then the
    # genuine gap's empty <td></td> -- the None position in between adds
    # nothing, so the row does NOT have three <td>s despite three grid
    # positions.
    assert _table_to_html(table) == (
        '<table><tbody><tr><td colspan="2">a</td><td></td></tr></tbody></table>'
    )


def test_table_to_html_renders_and_escapes_the_caption_as_the_first_child() -> None:
    table = Table(
        id="t0",
        cells=[[TableCell(text="a")]],
        caption="Rev & <History>",
        source_ref=_sr("x.xlsx", 0, 0),
    )
    html_out = _table_to_html(table)
    # <caption> must be untrusted-content-escaped exactly like cell text
    # (it was never rendered at all before this rewrite, so it never got
    # this treatment previously).
    assert html_out.startswith("<table><caption>Rev &amp; &lt;History&gt;</caption>")
    assert "<History>" not in html_out


def test_table_to_html_emits_text_align_style_only_when_align_is_set() -> None:
    table = Table(
        id="t0",
        cells=[[TableCell(text="left default"), TableCell(text="centered", align="center")]],
        source_ref=_sr("x.xlsx", 0, 0),
    )
    html_out = _table_to_html(table)
    assert html_out == (
        "<table><tbody><tr><td>left default</td>"
        '<td style="text-align:center">centered</td></tr></tbody></table>'
    )


def test_table_to_html_output_never_contains_an_embedded_newline() -> None:
    # description-html.ts's TABLE_BLOCK_PATTERN and the frontend's
    # TrustedTable matcher both assume/require a single-line <table> block
    # -- a newline anywhere inside it would break their matching.
    table = Table(
        id="t0",
        cells=[
            [TableCell(text="Col A", is_header=True), TableCell(text="Col B", is_header=True)],
            [TableCell(text="1", align="right"), TableCell(text="2")],
        ],
        caption="A caption",
        source_ref=_sr("x.xlsx", 0, 0),
    )
    assert "\n" not in _table_to_html(table)


def test_table_to_html_keeps_a_fully_absorbed_row_as_an_empty_tr_not_skipped() -> None:
    # A row entirely covered by rowspans from an earlier row (every column
    # is None) is NOT "blank" in the content sense -- it must still emit
    # an empty <tr></tr> to preserve physical row-count alignment for
    # rowspan math (see _table_to_html's own docstring for why skipping it
    # would corrupt a LATER row's alignment instead). Distinct from
    # test_table_with_a_fully_blank_row_skips_only_that_row_not_the_whole_table,
    # which covers the OTHER case (real cells, all empty text) that IS
    # still skipped exactly as before.
    table = Table(
        id="t0",
        cells=[
            [TableCell(text="A", rowspan=2), TableCell(text="B", rowspan=2)],
            [None, None],
            [TableCell(text="C"), TableCell(text="D")],
        ],
        source_ref=_sr("x.xlsx", 0, 0),
    )
    assert _table_to_html(table) == (
        '<table><tbody><tr><td rowspan="2">A</td><td rowspan="2">B</td></tr>'
        "<tr></tr><tr><td>C</td><td>D</td></tr></tbody></table>"
    )


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


# --- Golden TV-Receiver + Remote-Control scenario (bottom-up level-mapping) --
#
# Reproduces both top-level branches of the golden flat-numbered-list
# scenario used to validate G1-G9 in the investigation report, translated to
# English for readability (same structure/shape as the Hebrew source). Every
# node's type is asserted against the golden oracle table -- this is the
# single most load-bearing test for the bottom-up classification algorithm
# (autodetect.py's classify_numbering_branch), since it exercises both
# branches' full shape (including both SUB- sub-Features and both lettered
# sub-Requirement pairs) in one real build_baseline_tree run, not just the
# classifier in isolation.


def _golden_scenario_doc() -> CanonicalDoc:
    path = "golden.txt"
    lines = [
        "1 Receiver",
        "1.1 Broadcast and Inputs",
        "1.1.1 Channel scan and auto search",
        "1.1.1.1 The system scans channels automatically. It then shows the results in order.",
        "1.1.1.2 The system supports manual scan by frequency or channel.",
        "1.1.1.3 Scan results are saved. They remain available on the next power-on.",
        "1.1.2 External source detection",
        "1.1.2.1 The system detects a new HDMI connection and shows a message.",
        "1.1.2.2 Automatic switch to the active source.",
        "1.1.2.2.a If multiple active sources exist, a picker is shown instead of switching automatically.",
        "1.1.2.2.b If the user dismissed the prompt, it is not shown again for 10 minutes.",
        "1.1.3 USB playback",
        "1.1.3.1 The system shows a basic file browser when a USB drive is connected.",
        "1.1.3.2 The system supports playing a selected video file.",
        "1.2 Settings and User Experience",
        "1.2.1 Display",
        "1.2.1.1 Output resolution selectable from a list.",
        "1.2.1.2 Screen brightness adjustable on a clear scale.",
        "1.2.1.3 Refresh rate shown and selectable when the source allows it.",
        "1.2.1.4 SUB- – Picture Modes",
        "1.2.1.4.1 Cinema mode reduces color sharpness for movie viewing.",
        "1.2.1.4.2 Game mode prioritizes low latency over heavy image processing.",
        "1.2.1.4.3 Picture mode is saved separately per source.",
        "1.2.2 Audio Control",
        "1.2.2.1 Volume adjustable in clear steps with on-screen indication.",
        "1.2.2.2 Active audio output selectable among available outputs.",
        "1.2.2.3 Audio mode selectable with a short description of each mode.",
        "1.2.2.4 Mute and revert behavior",
        "1.2.2.4.a Exiting mute restores the last volume set before muting.",
        "1.2.2.4.b If the user changed volume while muted, that becomes the new last volume on unmute.",
        "1.2.3 Language, Region and Clock",
        "1.2.3.1 Menu language selectable from a list, updating all menus.",
        "1.2.3.2 Time zone selectable, showing the correct time on system screens.",
        "1.2.3.3 Subtitles can be turned on or off when content supports it.",
        "1.3 System Info",
        "1.3.1 About and Software Version",
        "1.3.1.1 The about screen shows software version, hardware model and serial number.",
        "1.3.1.2 The system supports checking for a software update on demand.",
        "2 Remote Control",
        "2.1 Ergonomics and Physical Structure",
        "2.1.1 The remote can be operated with one hand.",
        "2.1.2 The remote is light enough for extended use and does not slip easily.",
        "2.1.3 The remote keeps working after a typical drop from table height.",
        "2.2 Button Layout and Indication",
        "2.2.1 No more than three buttons per row to avoid confusion.",
        "2.2.2 The Power button is a distinct color to stand out from the rest.",
        "2.2.3 A brief indicator lights up on press to confirm the command was sent.",
        "2.2.4 SUB- – Media Buttons",
        "2.2.4.1 Media buttons work at least during USB playback.",
        "2.2.4.2 Back consistently returns to the previous screen.",
        "2.3 Pairing and TV Communication",
        "2.3.1 The remote works over infrared by default.",
        "2.3.2 A simple pairing flow with on-screen guidance is available for BT/RF remotes.",
        "2.3.3 Recovery from lost communication",
        "2.3.3.a If the link is lost, the remote automatically tries to reconnect.",
        "2.3.3.b If reconnection fails, a message with a recommended action is shown.",
        "2.4 Audio Functions from the Remote",
        "2.4.1 The remote has at least Volume+, Volume- and Mute.",
        "2.4.2 Exiting mute on the remote restores the last volume set before muting.",
    ]
    blocks = []
    offset = 0
    for index, text in enumerate(lines):
        start = offset
        end = start + len(text)
        offset = end + 1
        blocks.append(Block(id=f"n{index}", kind=BlockKind.PARAGRAPH, text=text, source_ref=_sr(path, start, end)))
    return CanonicalDoc(document=Document(path=path, format=DocumentFormat.TXT, sha256="goldenhash"), blocks=blocks)


def test_golden_scenario_branch_1_epic_subepic_feature_requirement_ladder() -> None:
    tree = build_baseline_tree(_golden_scenario_doc())
    by_title = {n.title: n for n in tree.nodes}

    assert by_title["Receiver"].type == WorkItemType.EPIC
    assert by_title["Receiver"].parent_local_id is None
    assert by_title["Broadcast and Inputs"].type == WorkItemType.EPIC  # sub-Epic
    assert by_title["Channel scan and auto search"].type == WorkItemType.FEATURE
    assert by_title["The system scans channels automatically."].type == WorkItemType.REQUIREMENT
    assert by_title["External source detection"].type == WorkItemType.FEATURE
    assert by_title["Automatic switch to the active source."].type == WorkItemType.REQUIREMENT
    assert by_title["If multiple active sources exist, a picker is shown instead of switching automatically."].type == WorkItemType.REQUIREMENT
    assert by_title["If the user dismissed the prompt, it is not shown again for 10 minutes."].type == WorkItemType.REQUIREMENT
    assert by_title["USB playback"].type == WorkItemType.FEATURE
    assert by_title["Settings and User Experience"].type == WorkItemType.EPIC  # sub-Epic
    assert by_title["Display"].type == WorkItemType.FEATURE
    # SUB- sub-Feature: "Picture Modes" must be Feature, parented under Display,
    # and its own SUB- prefix must be stripped from the title.
    picture_modes = by_title["Picture Modes"]
    assert picture_modes.type == WorkItemType.FEATURE
    assert picture_modes.parent_local_id == by_title["Display"].local_id
    assert "SUB-" not in picture_modes.title
    assert by_title["Cinema mode reduces color sharpness for movie viewing."].type == WorkItemType.REQUIREMENT
    assert by_title["Audio Control"].type == WorkItemType.FEATURE
    mute = by_title["Mute and revert behavior"]
    assert mute.type == WorkItemType.REQUIREMENT
    assert by_title["Exiting mute restores the last volume set before muting."].parent_local_id == mute.local_id
    assert by_title["Language, Region and Clock"].type == WorkItemType.FEATURE
    assert by_title["System Info"].type == WorkItemType.EPIC
    assert by_title["About and Software Version"].type == WorkItemType.FEATURE


def test_golden_scenario_branch_2_epic_directly_over_feature_no_sub_epic() -> None:
    # The golden table's "Title 2 acts as Feature, not sub-Epic" case: this
    # branch only reaches depth 3 (unlike branch 1's depth 5), so its root's
    # children all collapse to Feature, and the root itself stays a plain
    # Epic with NO sub-Epic tier -- derived purely from tree shape, with zero
    # threshold or named profile.
    tree = build_baseline_tree(_golden_scenario_doc())
    by_title = {n.title: n for n in tree.nodes}

    remote = by_title["Remote Control"]
    assert remote.type == WorkItemType.EPIC
    assert remote.parent_local_id is None

    ergonomics = by_title["Ergonomics and Physical Structure"]
    assert ergonomics.type == WorkItemType.FEATURE  # NOT sub-Epic
    assert ergonomics.parent_local_id == remote.local_id

    button_layout = by_title["Button Layout and Indication"]
    assert button_layout.type == WorkItemType.FEATURE

    # SUB- sub-Feature under a Feature (not under an Epic, unlike branch 1's
    # Picture Modes) -- proves the mechanism generalizes across branches.
    media_buttons = by_title["Media Buttons"]
    assert media_buttons.type == WorkItemType.FEATURE
    assert media_buttons.parent_local_id == button_layout.local_id
    assert "SUB-" not in media_buttons.title

    pairing = by_title["Pairing and TV Communication"]
    assert pairing.type == WorkItemType.FEATURE

    # This is the corrected G7 case from the report: "Recovery from lost
    # communication" is a header-only Requirement (its only children are
    # lettered sub-Requirements, excluded from its own promotion decision),
    # NOT a Feature as the old depth-threshold heuristic produced.
    recovery = by_title["Recovery from lost communication"]
    assert recovery.type == WorkItemType.REQUIREMENT
    assert recovery.parent_local_id == pairing.local_id
    reconnect = by_title["If the link is lost, the remote automatically tries to reconnect."]
    assert reconnect.type == WorkItemType.REQUIREMENT
    assert reconnect.parent_local_id == recovery.local_id

    audio_functions = by_title["Audio Functions from the Remote"]
    assert audio_functions.type == WorkItemType.FEATURE


def test_a_heading_styled_block_with_non_numeric_text_inside_a_numbering_label_branch_does_not_crash() -> None:
    # Regression: build_baseline_tree crashed with an unhandled KeyError.
    # is_heading_style_branch classifies a branch by its ROOT block only
    # (correct, by design -- see its own docstring), so a branch whose root
    # is a plain numbered paragraph is a numbering-label branch overall. But
    # a NESTED block inside it can still carry a real Word Heading style
    # with non-numeric text (e.g. a "Notes" sub-heading) -- resolve_block_depth
    # resolves such a block's depth via the heading path (non-None), while
    # classify_numbering_branch only ever populates entries for blocks whose
    # OWN numbering label parses (parse_numbering succeeds). The unguarded
    # `classification[block.id]` index previously raised KeyError for this
    # block, aborting the whole /level BASELINE call and losing the job.
    path = "mixed_convention.docx"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.DOCX, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Power Distribution", source_ref=_sr(path, 0, 20)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="1.1 Rail Requirements", source_ref=_sr(path, 21, 42)),
            Block(id="b2", kind=BlockKind.HEADING, heading_level=3, text="Notes", source_ref=_sr(path, 43, 48)),
        ],
    )

    tree = build_baseline_tree(doc)  # must not raise

    by_id = {n.local_id: n for n in tree.nodes}
    notes_node = next(n for n in tree.nodes if n.title == "Notes")
    # Fell back to the flat heading rule for this one block: depth >=2 (its
    # OWN heading_level) -> Requirement, matching heading_style_type_for_depth.
    assert notes_node.type == WorkItemType.REQUIREMENT
    assert by_id[notes_node.parent_local_id].title == "Rail Requirements"


# --- section_path / figure_ids / table_ids / uncaptioned_figure_ids (Phase 2) ---


def test_baseline_structured_tree_section_path_is_the_root_first_ancestor_title_chain() -> None:
    # The SAME `stack` build_baseline_tree already maintains to assign
    # parent_local_id is reused here as section_path -- root-first, and NOT
    # including the node's own title (only its ancestors).
    path = "nested.md"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.MD, sha256="h"),
        blocks=[
            Block(id="c0", kind=BlockKind.HEADING, heading_level=1, text="Power Distribution", source_ref=_sr(path, 0, 19)),
            Block(id="c1", kind=BlockKind.HEADING, heading_level=2, text="3.3V Rail Requirements", source_ref=_sr(path, 20, 43)),
            Block(
                id="c2",
                kind=BlockKind.PARAGRAPH,
                text="1.1.1 The rail shall regulate within 2% tolerance.",
                source_ref=_sr(path, 44, 96),
            ),
        ],
    )
    tree = build_baseline_tree(doc)
    # Looked up by title, not by type -- both "3.3V Rail Requirements" (the
    # depth-2 heading) and the leaf below it resolve to WorkItemType.REQUIREMENT
    # in this fixture's own depth-based classification (heading_style_type_for_depth),
    # so a type-only lookup would ambiguously match the wrong one.
    root = next(n for n in tree.nodes if n.title == "Power Distribution")
    middle = next(n for n in tree.nodes if n.title == "3.3V Rail Requirements")
    leaf = next(n for n in tree.nodes if "shall regulate" in n.description)

    assert root.source_ref.section_path == []
    assert middle.source_ref.section_path == ["Power Distribution"]
    assert leaf.source_ref.section_path == ["Power Distribution", "3.3V Rail Requirements"]


def test_baseline_structured_tree_figure_fold_populates_figure_ids_and_uncaptioned_figure_ids() -> None:
    path = "figures.docx"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.DOCX, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Power Distribution", source_ref=_sr(path, 0, 19)),
            Block(id="b1", kind=BlockKind.FIGURE, text="[FIGURE: Rail topology diagram]", source_ref=_sr(path, 20, 40)),
            Block(id="b2", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_sr(path, 41, 55)),
        ],
        figures=[
            Figure(id="f0", caption="Rail topology diagram", source_ref=_sr(path, 20, 40)),
            Figure(id="f1", caption=None, source_ref=_sr(path, 41, 55)),
        ],
    )
    tree = build_baseline_tree(doc)
    parent = next(n for n in tree.nodes if n.title == "Power Distribution")
    assert parent.figure_ids == ["f0"]
    assert parent.uncaptioned_figure_ids == ["f1"]
    # Disjoint: a given figure id appears in exactly one of the two lists.
    assert set(parent.figure_ids).isdisjoint(parent.uncaptioned_figure_ids)


def test_baseline_structured_tree_table_fold_populates_table_ids() -> None:
    path = "mixed.docx"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.DOCX, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Power Distribution", source_ref=_sr(path, 0, 19)),
            Block(id="b1", kind=BlockKind.HEADING, heading_level=2, text="3.3V Rail Requirements", source_ref=_sr(path, 20, 43)),
        ],
        tables=[Table(id="t0", cells=[[TableCell(text=c) for c in row] for row in [["Rail", "Voltage"], ["3.3V", "3.3"]]], caption="Rail Table", source_ref=_sr(path, 44, 45))],
    )
    tree = build_baseline_tree(doc)
    parent = next(n for n in tree.nodes if n.title == "3.3V Rail Requirements")
    assert parent.table_ids == ["t0"]


def test_baseline_identity_and_fidelity_hashes_are_unaffected_by_section_path() -> None:
    # Critical invariant (Phase 2): section_path/page_end/page_provenance
    # are ADDITIVE provenance fields, deliberately excluded from
    # _hash_identity's own input (document_path/start_offset/end_offset
    # only) -- widening them must never change identity_hash/fidelity_hash,
    # or a re-run would look like a new item and duplicate-create in ADO.
    # This proves it two ways: (1) _hash_identity itself is insensitive to
    # section_path directly, and (2) a real build_baseline_tree run's nodes
    # match hashes computed from a section_path-free copy of their own
    # source_ref.
    ref_no_path = _sr("doc.md", 10, 20)
    ref_with_path = ref_no_path.model_copy(update={"section_path": ["A", "B"]})
    assert _hash_identity("same description", ref_no_path) == _hash_identity("same description", ref_with_path)

    icd_doc = _icd_style_doc()
    tree = build_baseline_tree(icd_doc)
    for node in tree.nodes:
        bare_ref = node.source_ref.model_copy(update={"section_path": []})
        assert node.identity_hash == _hash_identity(node.description, bare_ref)
        # fidelity_hash never depends on source_ref at all (see
        # _hash_description), but asserted here too for completeness -- a
        # widened source_ref must never touch it either.
        import hashlib

        assert node.fidelity_hash == hashlib.sha256(node.description.encode()).hexdigest()


def test_headingless_tree_populates_figure_and_table_ids_with_section_path_empty() -> None:
    path = "flat_with_figure.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(
                id="f0",
                kind=BlockKind.PARAGRAPH,
                text="The system shall support at least four simultaneous audio channels.",
                source_ref=_sr(path, 0, 68),
            ),
            Block(id="f1", kind=BlockKind.FIGURE, text="[FIGURE: Audio routing diagram]", source_ref=_sr(path, 69, 90)),
            Block(id="f2", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_sr(path, 91, 105)),
        ],
        figures=[
            Figure(id="fig0", caption="Audio routing diagram", source_ref=_sr(path, 69, 90)),
            Figure(id="fig1", caption=None, source_ref=_sr(path, 91, 105)),
        ],
    )
    tree = build_baseline_tree(doc)
    figure_node = next(n for n in tree.nodes if n.local_id == "n3")  # f1 -> index 1 -> n{1+2}
    uncaptioned_node = next(n for n in tree.nodes if n.local_id == "n4")  # f2 -> index 2 -> n{2+2}
    assert figure_node.figure_ids == ["fig0"]
    assert figure_node.uncaptioned_figure_ids == []
    assert uncaptioned_node.figure_ids == []
    assert uncaptioned_node.uncaptioned_figure_ids == ["fig1"]
    # section_path stays [] for every node -- no heading structure exists
    # in a headingless document.
    assert all(n.source_ref.section_path == [] for n in tree.nodes)


def test_headingless_table_only_tree_sets_table_ids_to_its_own_table() -> None:
    doc = CanonicalDoc(
        document=Document(path="sheet.xlsx", format=DocumentFormat.XLSX, sha256="h"),
        tables=[Table(id="t0", cells=[[TableCell(text=c) for c in row] for row in [["a", "b"]]], caption="Sheet1", source_ref=_sr("sheet.xlsx", 0, 0))],
    )
    tree = build_baseline_tree(doc)
    requirement_node = next(n for n in tree.nodes if n.type == WorkItemType.REQUIREMENT)
    assert requirement_node.table_ids == ["t0"]


def test_flat_list_tree_direct_call_populates_figure_ids_when_a_branch_root_is_a_figure() -> None:
    # Unreachable via build_baseline_tree's own routing today (a FIGURE-kind
    # block never resolves a depth, so it can never be a lone-block branch
    # root that triggers this path -- see this function's own comment) --
    # exercised here via direct invocation so this function's own fold
    # logic doesn't silently diverge from _build_headingless_tree's if that
    # invariant ever changes.
    path = "flat_list.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.FIGURE, text="[FIGURE: Wiring diagram]", source_ref=_sr(path, 0, 20)),
        ],
        figures=[Figure(id="fig0", caption="Wiring diagram", source_ref=_sr(path, 0, 20))],
    )
    tree = _build_flat_list_tree(doc, [[doc.blocks[0]]], customer_id=None)
    requirement_node = next(n for n in tree.nodes if n.type == WorkItemType.REQUIREMENT)
    assert requirement_node.figure_ids == ["fig0"]
    assert requirement_node.uncaptioned_figure_ids == []


# --- _widen_page_end (Phase 6 -- real docx page numbers, see
# app/loaders/docx_pagination.py) ---


def _paged_sr(path: str, start: int, end: int, page: int | None, page_end: int | None = None) -> SourceRef:
    return SourceRef(document_path=path, start_offset=start, end_offset=end, page=page, page_end=page_end)


def test_widen_page_end_is_a_no_op_when_the_open_node_has_no_page_at_all() -> None:
    # True for every docx document before docx_pagination.py's alignment
    # ever runs (or when it failed) -- must never set page_end without page
    # also being set (SourceRef's own docstring invariant).
    open_ref = _paged_sr("x.docx", 0, 10, page=None)
    folded_ref = _paged_sr("x.docx", 11, 20, page=3, page_end=5)
    assert _widen_page_end(open_ref, folded_ref) is open_ref


def test_widen_page_end_is_a_no_op_when_the_folded_ref_has_no_page_either() -> None:
    open_ref = _paged_sr("x.docx", 0, 10, page=1, page_end=1)
    folded_ref = _paged_sr("x.docx", 11, 20, page=None)
    assert _widen_page_end(open_ref, folded_ref) is open_ref


def test_widen_page_end_widens_using_the_folded_refs_own_page_when_it_has_no_page_end() -> None:
    open_ref = _paged_sr("x.docx", 0, 10, page=1, page_end=1)
    folded_ref = _paged_sr("x.docx", 11, 20, page=2)  # page_end None -> falls back to page=2
    widened = _widen_page_end(open_ref, folded_ref)
    assert widened.page == 1  # the open node's own page never changes
    assert widened.page_end == 2


def test_widen_page_end_widens_using_the_folded_refs_page_end() -> None:
    open_ref = _paged_sr("x.docx", 0, 10, page=1, page_end=1)
    folded_ref = _paged_sr("x.docx", 11, 20, page=2, page_end=4)
    widened = _widen_page_end(open_ref, folded_ref)
    assert widened.page_end == 4


def test_widen_page_end_never_lowers_an_already_wider_page_end() -> None:
    # Folds always proceed in document order, so this should never actually
    # occur live -- asserted directly anyway as the guard's own contract.
    open_ref = _paged_sr("x.docx", 0, 10, page=1, page_end=5)
    folded_ref = _paged_sr("x.docx", 11, 20, page=2, page_end=2)
    widened = _widen_page_end(open_ref, folded_ref)
    assert widened.page_end == 5
    assert widened is open_ref  # no-op copy avoided when nothing actually changes


def test_build_baseline_tree_widens_page_end_when_a_block_folds_into_an_open_node() -> None:
    path = "paged.docx"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.DOCX, sha256="h"),
        blocks=[
            Block(
                id="b0", kind=BlockKind.HEADING, heading_level=1, text="Power Distribution",
                source_ref=_paged_sr(path, 0, 19, page=1, page_end=1),
            ),
            Block(
                id="b1", kind=BlockKind.PARAGRAPH,
                text="Additional detail spilling onto a later page in the same section.",
                source_ref=_paged_sr(path, 20, 88, page=3, page_end=3),
            ),
        ],
    )
    tree = build_baseline_tree(doc)
    node = next(n for n in tree.nodes if "Power Distribution" in n.title)
    assert node.source_ref.page == 1
    assert node.source_ref.page_end == 3


def test_build_baseline_tree_widens_page_end_when_a_table_folds_into_an_open_node() -> None:
    path = "paged_table.docx"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.DOCX, sha256="h"),
        blocks=[
            Block(
                id="b0", kind=BlockKind.HEADING, heading_level=1, text="Power Distribution",
                source_ref=_paged_sr(path, 0, 19, page=1, page_end=1),
            ),
        ],
        tables=[
            Table(
                id="t0", cells=[[TableCell(text=c) for c in row] for row in [["Rail", "Voltage"], ["3.3V", "3.3"]]],
                source_ref=_paged_sr(path, 20, 21, page=2, page_end=4),
            ),
        ],
    )
    tree = build_baseline_tree(doc)
    node = next(n for n in tree.nodes if "Power Distribution" in n.title)
    assert node.source_ref.page == 1
    assert node.source_ref.page_end == 4
