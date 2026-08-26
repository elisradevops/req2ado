from app.canonical.model import Block, BlockKind, SourceRef, Table, TableCell
from app.leveling.heading_outline import HeadingOutlineEntry, entries_for_blocks, heading_outline_entries

_NON_REQ_TEXT = "Some descriptive text about this topic here."  # 7 words, no modal verb
_SHALL_TEXT = "The system shall handle this case correctly."  # 7 words, has "shall"


def _sr(start: int, end: int, path: str = "x.docx") -> SourceRef:
    return SourceRef(document_path=path, start_offset=start, end_offset=end)


def _heading(text: str, level: int, offset: int, block_id: str = "b") -> Block:
    return Block(id=block_id, kind=BlockKind.HEADING, text=text, heading_level=level, source_ref=_sr(offset, offset + 1))


def _para(offset: int, text: str = _NON_REQ_TEXT, block_id: str = "p") -> Block:
    return Block(id=block_id, kind=BlockKind.PARAGRAPH, text=text, source_ref=_sr(offset, offset + 1))


def _shall_para(offset: int, block_id: str = "p") -> Block:
    return _para(offset, _SHALL_TEXT, block_id)


def _id_table(offset: int, n_rows: int, table_id: str = "t0") -> Table:
    """A requirements-list table with its own literal id column (see
    requirement_rows.py) -- n_rows qualifying rows."""
    rows = [["#", "Parameter", "Requirement / Value"]]
    for i in range(n_rows):
        rows.append([f"P-SENSOR-{i:03d}#", f"Param {i}", f"The system shall do thing {i}."])
    return Table(id=table_id, cells=[[TableCell(text=c) for c in row] for row in rows], source_ref=_sr(offset, offset + 1))


def _values_table(offset: int, table_id: str = "t0") -> Table:
    """A supplementary values table with no id column and no requirement-
    shaped cell content (AirPro's own convention)."""
    rows = [["Wire", "Gauge"], ["W1", "24 AWG"], ["W2", "26 AWG"]]
    return Table(id=table_id, cells=[[TableCell(text=c) for c in row] for row in rows], source_ref=_sr(offset, offset + 1))


def _titles_types(entries: list[HeadingOutlineEntry]) -> list[tuple[str, str]]:
    return [(e.title, e.suggested_type) for e in entries]


# --- Real document shapes -------------------------------------------------


def test_mock_prd_shape_names_every_real_section_and_excludes_the_title() -> None:
    # Real reference document shape (Mock_PRD_Sensor (1).docx): a Title
    # paragraph (heading_level=1, indistinguishable from a real top-tier
    # heading at the Block level) followed by short metadata prose (no
    # table, no deeper heading) before the document's real first section,
    # itself immediately followed by its own sub-section whose real
    # content is a requirements-list TABLE, not a paragraph.
    blocks = [
        _heading("Product Requirements Document", 1, 0, "b0"),
        _para(1, block_id="b0b"),
        _heading("Functional and Performance", 1, 2, "b1"),
        _heading("Synchronization", 2, 3, "b2"),
        _heading("Target Handling", 1, 5, "b4"),
        _heading("Target tracking", 2, 6, "b5"),
    ]
    tables = [_id_table(4, 3, "t0"), _id_table(7, 3, "t1")]
    entries = heading_outline_entries(blocks, tables)
    assert _titles_types(entries) == [
        ("Functional and Performance", "Epic"),
        ("Synchronization", "Feature"),
        ("Target Handling", "Epic"),
        ("Target tracking", "Feature"),
    ]


def test_flat_shape_with_no_top_tier_yields_features_only_and_suppresses_the_title() -> None:
    # Real reference document shape (Mock_PRD_Sensor (Not Properly
    # Aligned).docx): every real section sits at the SAME level -- there
    # is no grouping tier above them at all, so the Title is the ONLY
    # heading at the document's own shallowest level, and its span
    # (extending to the end of the document, since nothing shallower ever
    # closes it) legitimately contains tables and deeper... no, SAME-level
    # headings. This is the S2 case, distinct from S1 above.
    blocks = [
        _heading("Product Requirements Document", 1, 0, "b0"),
        _para(1, block_id="b0b"),
        _heading("Synchronization", 2, 2, "b1"),
        _heading("Target Data report", 2, 4, "b2"),
        _heading("Target tracking", 2, 6, "b3"),
    ]
    tables = [_id_table(3, 3, "t0"), _id_table(5, 3, "t1"), _id_table(7, 3, "t2")]
    entries = heading_outline_entries(blocks, tables)
    assert _titles_types(entries) == [
        ("Synchronization", "Feature"),
        ("Target Data report", "Feature"),
        ("Target tracking", "Feature"),
    ]
    assert "Epic" not in {e.suggested_type for e in entries}
    assert "Product Requirements Document" not in {e.title for e in entries}


def test_three_tier_icd_shape_types_leaves_as_requirement_with_no_phantom() -> None:
    # mock_icd.docx's own real shape: "Power Distribution" (level 1) has a
    # real Feature-tier child ("3.3V Rail Requirements", itself split into
    # a leaf Requirement) so it becomes Epic; "Thermal Management" (SAME
    # level 1) has only a flat Requirement leaf so it stays Feature --
    # same nominal depth, different type, driven purely by nesting shape.
    blocks = [
        _heading("Power Distribution", 1, 0),
        _heading("3.3V Rail Requirements", 2, 1),
        _heading("Ripple Sub-Requirement", 3, 2, "b_ripple"),
        _heading("Rail Sequencing Requirements", 2, 4, "b_seq"),
        _heading("Thermal Management", 1, 6),
        _heading("Fan Control", 2, 7, "b_fan"),
    ]
    entries = heading_outline_entries(blocks)
    by_title = {e.title: e.suggested_type for e in entries}
    assert by_title["Power Distribution"] == "Epic"
    assert by_title["3.3V Rail Requirements"] == "Feature"
    assert by_title["Ripple Sub-Requirement"] == "Requirement"
    assert by_title["Rail Sequencing Requirements"] == "Requirement"
    assert by_title["Thermal Management"] == "Feature"
    assert by_title["Fan Control"] == "Requirement"


def test_airpro_shape_leaf_whose_own_text_is_the_requirement_stays_requirement() -> None:
    # AirPro's own convention: a leaf heading's TEXT is the requirement
    # statement itself, with nothing structurally below it at all. A
    # leading sibling heading keeps the leaf under test out of position 0
    # -- a prose-only span at position 0 is exactly the S1 Title-heuristic
    # shape (see test_a_lone_top_tier_heading_with_everything_else_
    # deeper_is_suppressed below for the equivalent S2 trade-off) and
    # would otherwise suppress this leaf for the wrong reason.
    blocks = [
        _heading("First independent leaf shall also apply", 2, 0, "b0"),
        _heading("Backplane shall include the following modules", 2, 1, "b1"),
    ]
    entries = heading_outline_entries(blocks)
    by_title = {e.title: e.suggested_type for e in entries}
    assert by_title["Backplane shall include the following modules"] == "Requirement"


def test_leaf_over_a_values_table_with_no_id_column_stays_requirement() -> None:
    blocks = [_heading("Power Budget", 2, 0, "b0"), _heading("Other Budget", 2, 2, "b1")]
    entries = heading_outline_entries(blocks, [_values_table(1)])
    by_title = {e.title: e.suggested_type for e in entries}
    assert by_title["Power Budget"] == "Requirement"


# --- Obligation-count threshold (D3) --------------------------------------


def test_leaf_with_exactly_one_obligation_stays_requirement() -> None:
    # "Other" precedes "Sync" so "Sync" (the leaf under test, with only a
    # prose-only span) is not itself position 0 -- see the module note on
    # S1's own Title-heuristic trade-off above.
    blocks = [_heading("Other", 2, 0, "b0"), _heading("Sync", 2, 1, "b1"), _shall_para(2)]
    entries = heading_outline_entries(blocks)
    by_title = {e.title: e.suggested_type for e in entries}
    assert by_title["Sync"] == "Requirement"


def test_leaf_with_two_obligations_becomes_feature_and_its_parent_becomes_epic() -> None:
    blocks = [
        _heading("Domain", 1, 0, "b0"), _heading("Sync", 2, 1, "b1"),
        _shall_para(2, "p1"), _shall_para(3, "p2"),
        _heading("Other Domain", 1, 4, "b2"),
    ]
    entries = heading_outline_entries(blocks)
    by_title = {e.title: e.suggested_type for e in entries}
    assert by_title["Domain"] == "Epic"
    assert by_title["Sync"] == "Feature"


def test_two_qualifying_id_table_rows_count_as_two_obligations() -> None:
    blocks = [_heading("Domain", 1, 0, "b0"), _heading("Sync", 2, 1, "b1"), _heading("Other Domain", 1, 3, "b2")]
    entries = heading_outline_entries(blocks, [_id_table(2, 2)])
    by_title = {e.title: e.suggested_type for e in entries}
    assert by_title["Domain"] == "Epic"
    assert by_title["Sync"] == "Feature"


def test_non_requirement_shaped_prose_never_counts_as_an_obligation() -> None:
    blocks = [
        _heading("Other", 2, 0, "b0"), _heading("Sync", 2, 1, "b1"),
        _para(2, block_id="p1"), _para(3, block_id="p2"),
    ]
    entries = heading_outline_entries(blocks)
    by_title = {e.title: e.suggested_type for e in entries}
    assert by_title["Sync"] == "Requirement"


# --- Generalization: no absolute level is ever compared -------------------


def test_four_tier_synthetic_document_nests_epic_under_epic() -> None:
    blocks = [
        _heading("Grand Domain", 1, 0, "b0"),
        _heading("Sub Domain", 2, 1, "b1"),
        _heading("Feature Area", 3, 2, "b2"),
        _heading("Sync", 4, 3, "b3"),
        _shall_para(4, "p1"),
        _shall_para(5, "p2"),
        _heading("Other Grand Domain", 1, 6, "b4"),
    ]
    entries = heading_outline_entries(blocks)
    by_title = {e.title: e.suggested_type for e in entries}
    assert by_title["Grand Domain"] == "Epic"
    assert by_title["Sub Domain"] == "Epic"
    assert by_title["Feature Area"] == "Epic"
    assert by_title["Sync"] == "Feature"


def test_level_offset_invariance_same_shape_different_absolute_levels() -> None:
    # The exact case an absolute {1: Epic, 2: Feature} map gets wrong:
    # AirPro's real top tier is level 2, not level 1. The SAME nesting
    # shape must produce IDENTICAL types regardless of which absolute
    # level numbers it happens to use. A second top-level sibling keeps
    # this a realistic multi-root document (see the S2 trade-off note
    # above).
    def _shape(level_a: int, level_b: int) -> list[Block]:
        return [
            _heading("Domain", level_a, 0, "b0"), _heading("Sync", level_b, 1, "b1"),
            _shall_para(2, "p1"), _shall_para(3, "p2"),
            _heading("Other Domain", level_a, 4, "b2"),
        ]

    for level_a, level_b in [(1, 2), (2, 3), (3, 5)]:  # (3, 5) also skips a level
        by_title = {e.title: e.suggested_type for e in heading_outline_entries(_shape(level_a, level_b))}
        assert by_title["Domain"] == "Epic"
        assert by_title["Sync"] == "Feature"


def test_skipped_intermediate_level_attaches_to_nearest_shallower_ancestor() -> None:
    blocks = [
        _heading("Domain", 1, 0, "b0"),
        _heading("Deep Leaf", 5, 1, "b1"),  # skips levels 2-4 entirely
        _shall_para(2, "p1"),
        _shall_para(3, "p2"),
        _heading("Other Domain", 1, 4, "b2"),
    ]
    entries = heading_outline_entries(blocks)
    by_title = {e.title: e.suggested_type for e in entries}
    assert by_title["Domain"] == "Epic"
    assert by_title["Deep Leaf"] == "Feature"


def test_degenerate_single_level_document_names_no_epic() -> None:
    blocks = [_heading("Alpha", 2, 0), _heading("Beta", 2, 1)]
    entries = heading_outline_entries(blocks, [_id_table(2, 2, "t0"), _id_table(3, 2, "t1")])
    assert {e.suggested_type for e in entries} <= {"Feature", "Requirement"}


def test_a_lone_top_tier_heading_with_everything_else_deeper_is_suppressed() -> None:
    # Known, deliberate trade-off (module docstring, decision D10 in the
    # plan): with no authoritative "this is a Word Title" signal on Block,
    # a genuine lone top-level Epic and a bare document Title are
    # structurally indistinguishable when nothing else shares its level --
    # S2 resolves the ambiguity toward suppression (the safer failure
    # direction: a suppressed real Epic just falls back to the model's
    # own pre-existing judgment, whereas naming a bare Title as an Epic is
    # the confirmed, actively wrong shape this fix exists to prevent).
    blocks = [_heading("Domain", 1, 0, "b0"), _heading("Sync", 2, 1, "b1"), _shall_para(2, "p1"), _shall_para(3, "p2")]
    entries = heading_outline_entries(blocks)
    assert "Domain" not in {e.title for e in entries}


def test_pdf_shaped_table_on_a_later_page_is_still_counted_via_order_key() -> None:
    # _order_key is (page, start_offset) -- a heading on page 1 and its
    # requirements table on page 2 must still resolve in document order.
    heading = Block(
        id="h0", kind=BlockKind.HEADING, text="Domain", heading_level=1,
        source_ref=SourceRef(document_path="x.pdf", start_offset=0, end_offset=1, page=1),
    )
    sync = Block(
        id="h1", kind=BlockKind.HEADING, text="Sync", heading_level=2,
        source_ref=SourceRef(document_path="x.pdf", start_offset=0, end_offset=1, page=1),
    )
    other_domain = Block(
        id="h2", kind=BlockKind.HEADING, text="Other Domain", heading_level=1,
        source_ref=SourceRef(document_path="x.pdf", start_offset=0, end_offset=1, page=3),
    )
    table = Table(
        id="t0",
        cells=[[TableCell(text=c) for c in row] for row in [
            ["#", "Requirement"],
            ["P-SENSOR-001#", "The system shall do thing 0."],
            ["P-SENSOR-002#", "The system shall do thing 1."],
        ]],
        source_ref=SourceRef(document_path="x.pdf", start_offset=0, end_offset=1, page=2),
    )
    entries = heading_outline_entries([heading, sync, other_domain], [table])
    by_title = {e.title: e.suggested_type for e in entries}
    assert by_title["Domain"] == "Epic"
    assert by_title["Sync"] == "Feature"


# --- entries_for_blocks -----------------------------------------------------


def test_entries_for_blocks_filters_and_preserves_order() -> None:
    blocks = [
        _heading("Domain", 1, 0, "b0"), _heading("Sync", 2, 1, "b1"), _heading("Other", 2, 2, "b2"),
        _heading("Other Domain", 1, 5, "b3"),
    ]
    entries = heading_outline_entries(blocks, [_id_table(3, 2, "t0"), _id_table(4, 2, "t1")])
    filtered = entries_for_blocks(entries, [blocks[0], blocks[1]])
    assert [e.block_id for e in filtered] == ["b0", "b1"]


def test_entries_for_blocks_never_raises_on_none_or_empty() -> None:
    assert entries_for_blocks(None, None) == []
    assert entries_for_blocks([], []) == []
    entries = heading_outline_entries([_heading("Domain", 1, 0, "b0")], [_id_table(1, 2)])
    assert entries_for_blocks(entries, None) == []
    assert entries_for_blocks(entries, []) == []


def test_filtering_a_document_wide_outline_survives_a_branch_split_the_suppression_heuristic_would_not() -> None:
    # The exact regression this filter-not-recompute design (D5) guards
    # against: classify_by_nesting's own TYPE computation is bottom-up
    # (subset-invariant -- a node's type depends only on its own
    # descendants, never its ancestors or siblings), so it alone would
    # survive a per-branch recompute intact. The S1/S2 Title-suppression
    # heuristic is NOT subset-invariant: it depends on how many OTHER
    # headings share the document's own shallowest level. A branch
    # isolating just ONE top-tier section's own complete subtree makes
    # that section look, from inside the branch alone, exactly like the
    # S2 "lone top-tier heading, everything else deeper" shape -- and
    # get wrongly suppressed as a possible Title -- even though the FULL
    # document has three other siblings at that same level, so S2 never
    # fires there. Filtering a document-wide computation, rather than
    # recomputing from the branch's own block subset, is what preserves
    # this real Epic.
    def _domain(title: str, offset: int, block_id: str) -> list:
        return [
            _heading(title, 1, offset, block_id), _heading(f"{title} Feature", 2, offset + 1, f"{block_id}f"),
            _shall_para(offset + 2, f"{block_id}p1"), _shall_para(offset + 3, f"{block_id}p2"),
        ]

    full_blocks = _domain("Alpha", 0, "a") + _domain("Beta", 4, "b") + _domain("Gamma", 8, "g") + _domain("Delta", 12, "d")
    full_entries = heading_outline_entries(full_blocks)
    assert ("Beta", "Epic") in _titles_types(full_entries)  # sanity: correctly typed in the full document

    beta_subset = full_blocks[4:8]  # Beta's own complete subtree, isolated -- as a branch split might produce
    filtered = entries_for_blocks(full_entries, beta_subset)
    assert ("Beta", "Epic") in _titles_types(filtered)  # preserved when filtered from the full-document computation

    recomputed_from_subset = heading_outline_entries(beta_subset)
    assert "Beta" not in {e.title for e in recomputed_from_subset}  # wrongly suppressed if recomputed in isolation


# --- Robustness --------------------------------------------------------------


def test_a_blank_heading_text_is_never_named() -> None:
    blocks = [_heading("   ", 1, 0, "b0"), _heading("Sub", 2, 1, "b1")]
    entries = heading_outline_entries(blocks, [_id_table(2, 2)])
    assert _titles_types(entries) == [("Sub", "Feature")]


def test_none_and_empty_input_never_raise() -> None:
    assert heading_outline_entries(None) == []
    assert heading_outline_entries([]) == []
    assert heading_outline_entries([], []) == []


def test_a_headingless_document_yields_nothing() -> None:
    assert heading_outline_entries([_para(0), _para(1, block_id="p2")]) == []
