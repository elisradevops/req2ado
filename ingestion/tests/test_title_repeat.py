"""R5: a title is not repeated atop its description; hashes still identify the full source."""
from __future__ import annotations

from pathlib import Path

from app.leveling.tree_builder import _hash_description, _hash_identity, build_baseline_tree
from app.loaders.docx_loader import load_docx
from app.workitem.fidelity import verify_fidelity

FIXTURES = Path(__file__).parent / "fixtures"


def test_icd_headings_are_not_repeated_in_their_descriptions() -> None:
    tree = build_baseline_tree(load_docx(str(FIXTURES / "mock_icd.docx")))
    by_title = {n.title: n for n in tree.nodes}
    rail = by_title["3.3V Rail Requirements"]
    assert rail.description.startswith("The 3.3V rail shall maintain output regulation")
    for node in tree.nodes:
        assert not node.description.startswith(node.title + "\n")
        assert verify_fidelity(node)


def test_identity_hash_still_identifies_the_full_source_text() -> None:
    tree = build_baseline_tree(load_docx(str(FIXTURES / "mock_icd.docx")))
    rail = next(n for n in tree.nodes if n.title == "3.3V Rail Requirements")
    full = rail.title + "\n" + rail.description
    assert rail.identity_hash == _hash_identity(full, rail.source_ref)
    assert rail.fidelity_hash == _hash_description(rail.description)


def test_heading_only_requirement_keeps_its_text() -> None:
    tree = build_baseline_tree(load_docx(str(FIXTURES / "mock_prd_sensor.docx")))
    node = next(n for n in tree.nodes if n.title == "Synchronization")
    assert node.description == "Synchronization"


def test_table_row_uses_its_name_cell_as_title() -> None:
    tree = build_baseline_tree(load_docx(str(FIXTURES / "mock_prd_sensor.docx")))
    node = next(n for n in tree.nodes if n.customer_id == "P-SENSOR-000#")
    assert node.title == "Time sync source"
    assert node.description == "The system shall synchronize to Standard-XX within N ms."
    assert verify_fidelity(node)


def test_row_without_a_name_cell_keeps_longest_cell_title() -> None:
    from app.leveling.requirement_rows import row_title_and_description

    assert row_title_and_description("P-1#", ("The unit shall boot within 5 s.",)) == (
        "The unit shall boot within 5 s.",
        "The unit shall boot within 5 s.",
    )
    assert row_title_and_description("P-1#", ()) == ("P-1#", "P-1#")


def test_a_statement_first_cell_is_not_taken_for_a_name() -> None:
    from app.leveling.requirement_rows import row_title_and_description

    cells = ("The unit shall boot within 5 s.", "Test")
    expected = ("The unit shall boot within 5 s.", "\n".join(cells))
    assert row_title_and_description("P-1#", cells) == expected


def test_a_short_last_cell_is_not_taken_for_a_name() -> None:
    from app.leveling.requirement_rows import row_title_and_description

    cells = ("Boot time", "The unit shall boot within 5 s.", "Test")
    expected = ("Boot time", "The unit shall boot within 5 s.\nTest")
    assert row_title_and_description("P-1#", cells) == expected


def test_a_name_the_title_extractor_would_cut_keeps_every_cell() -> None:
    from app.distillation.title import extract_baseline_title
    from app.leveling.requirement_rows import row_title_and_description

    cells = ("Max. voltage", "The unit shall not exceed 5 V on any rail.")
    title, description = row_title_and_description("P-1#", cells)
    assert extract_baseline_title(title) == title
    assert description == "\n".join(cells)


def test_a_name_row_loses_no_cell_between_title_and_description() -> None:
    from app.leveling.requirement_rows import row_title_and_description

    cells = ("Boot time", "The unit shall boot within 5 s.", "Test")
    title, description = row_title_and_description("P-1#", cells)
    assert "\n".join([title, description]) == "\n".join(cells)


def test_deterministic_heading_path_strips_after_span_folding_and_keeps_identity() -> None:
    from app.canonical.model import (
        Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef,
    )
    from app.leveling.llm_leveling import _detect_deterministic_subtrees

    def block(i: int, kind: BlockKind, text: str, level: int | None = None) -> Block:
        ref = SourceRef(document_path="x.docx", start_offset=i * 10, end_offset=i * 10 + 9)
        return Block(id=f"b{i}", kind=kind, heading_level=level, text=text, source_ref=ref)

    doc = CanonicalDoc(
        document=Document(path="x.docx", format=DocumentFormat.DOCX, sha256="x"),
        blocks=[
            block(0, BlockKind.HEADING, "1  Power", 1),
            block(1, BlockKind.HEADING, "1.1  Bus voltage", 2),
            block(2, BlockKind.PARAGRAPH, "Supplementary note on the bus."),
            block(3, BlockKind.HEADING, "1.1.1  The system shall limit ripple.", 3),
            block(4, BlockKind.HEADING, "1.1.2  The system shall report faults.", 3),
        ],
    )
    nodes, _warnings, _residual = _detect_deterministic_subtrees(doc, None)
    bus = next(n for n in nodes if n.title == "Bus voltage")
    assert bus.description == "Supplementary note on the bus."
    assert verify_fidelity(bus)
    full = "Bus voltage\nSupplementary note on the bus."
    assert bus.identity_hash == _hash_identity(full, bus.source_ref)
    assert not any(n.description.startswith(n.title + "\n") for n in nodes)
