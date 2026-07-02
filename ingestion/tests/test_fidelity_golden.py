# ingestion/tests/test_fidelity_golden.py
from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.leveling.tree_builder import build_baseline_tree
from app.workitem.fidelity import verify_fidelity


def _sr(path: str, start: int, end: int) -> SourceRef:
    return SourceRef(document_path=path, start_offset=start, end_offset=end)


def _golden_doc() -> CanonicalDoc:
    path = "golden.txt"
    return CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="golden-hash"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, text="1 Power Subsystem", heading_level=1, source_ref=_sr(path, 0, 18)),
            Block(id="b1", kind=BlockKind.HEADING, text="1.1 3.3V Rail Requirements", heading_level=2, source_ref=_sr(path, 19, 46)),
            Block(id="b2", kind=BlockKind.OPEN_TBD, text="OPEN: confirm connector part number before release.", source_ref=_sr(path, 47, 100)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="TBD: verify against thermal derating curve.", source_ref=_sr(path, 101, 146)),
            Block(id="b4", kind=BlockKind.FIGURE, text="[FIGURE: rail schematic]", source_ref=_sr(path, 147, 172)),
        ],
    )


def test_description_is_byte_for_byte_verbatim_join_of_folded_blocks() -> None:
    tree = build_baseline_tree(_golden_doc())
    requirement_node = tree.nodes[1]
    expected = (
        "1.1 3.3V Rail Requirements"
        "\nOPEN: confirm connector part number before release."
        "\nTBD: verify against thermal derating curve."
        "\n[FIGURE: rail schematic]"
    )
    assert requirement_node.description == expected


def test_open_marker_text_is_preserved_verbatim_in_description() -> None:
    tree = build_baseline_tree(_golden_doc())
    requirement_node = tree.nodes[1]
    assert "OPEN: confirm connector part number before release." in requirement_node.description


def test_tbd_marker_text_is_preserved_verbatim_in_description() -> None:
    tree = build_baseline_tree(_golden_doc())
    requirement_node = tree.nodes[1]
    assert "TBD: verify against thermal derating curve." in requirement_node.description


def test_figure_placeholder_is_preserved_verbatim_in_description() -> None:
    tree = build_baseline_tree(_golden_doc())
    requirement_node = tree.nodes[1]
    assert "[FIGURE: rail schematic]" in requirement_node.description


def test_every_node_passes_verify_fidelity() -> None:
    tree = build_baseline_tree(_golden_doc())
    for node in tree.nodes:
        assert verify_fidelity(node) is True


def test_rebuilding_the_same_document_produces_identical_hashes() -> None:
    # Determinism: same source in -> same fidelity_hash out, every time.
    # No LLM involved in BASELINE mode, so this must hold exactly.
    tree_a = build_baseline_tree(_golden_doc())
    tree_b = build_baseline_tree(_golden_doc())
    hashes_a = [node.fidelity_hash for node in tree_a.nodes]
    hashes_b = [node.fidelity_hash for node in tree_b.nodes]
    assert hashes_a == hashes_b


def test_rebuilding_the_same_document_produces_identical_titles_and_descriptions() -> None:
    tree_a = build_baseline_tree(_golden_doc())
    tree_b = build_baseline_tree(_golden_doc())
    assert [n.title for n in tree_a.nodes] == [n.title for n in tree_b.nodes]
    assert [n.description for n in tree_a.nodes] == [n.description for n in tree_b.nodes]


def test_customer_id_and_fidelity_are_independent_dimensions() -> None:
    # Stamping customer_id must never perturb fidelity_hash — Customer ID is
    # pipeline metadata, not part of the hashed source-fidelity content.
    tree_no_customer = build_baseline_tree(_golden_doc())
    tree_with_customer = build_baseline_tree(_golden_doc(), customer_id="CUST-042")
    hashes_no_customer = [node.fidelity_hash for node in tree_no_customer.nodes]
    hashes_with_customer = [node.fidelity_hash for node in tree_with_customer.nodes]
    assert hashes_no_customer == hashes_with_customer
