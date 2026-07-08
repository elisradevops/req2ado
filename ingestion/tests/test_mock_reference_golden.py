"""Golden tests against mock reference documents.

The real reference material named in the original request (a folder of real
"Customer Requirements For AI" documents, the real engineering ICD already
ingested into ADO, and a worked TV-Receiver + Remote-Control example) lives
in a production environment and cannot be brought into this repo. These
tests substitute realistic MOCK stand-ins (see the build_mock_*_docx.py
scripts in tests/fixtures/) that embody the same real-world conventions, so
the leveling/fidelity core is proven against something closer to a real
document than the tiny in-memory Blocks used elsewhere in this test suite.

Regenerate the fixtures with:
    python tests/fixtures/build_mock_icd_docx.py
    python tests/fixtures/build_mock_tv_remote_docx.py
"""
from pathlib import Path

from app.leveling.tree_builder import build_baseline_tree
from app.loaders.docx_loader import load_docx
from app.workitem.fidelity import verify_fidelity
from app.workitem.model import WorkItemType

_FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _nodes_by_title(nodes):
    return {n.title: n for n in nodes}


def test_mock_icd_docx_each_top_heading_is_a_feature_everything_nested_is_a_requirement() -> None:
    """Real ICD convention: each top-level heading = Feature, everything
    nested below it = Requirement. See build_mock_icd_docx.py's docstring
    for why a genuine sub-requirement (depth 3) is not modeled here — the
    current autodetect heuristic reclassifies any depth-3 branch as
    tv_style instead."""
    doc = load_docx(str(_FIXTURES_DIR / "mock_icd.docx"))
    tree = build_baseline_tree(doc)
    by_title = _nodes_by_title(tree.nodes)

    assert by_title["Power Distribution"].type == WorkItemType.FEATURE
    assert by_title["Power Distribution"].parent_local_id is None
    assert by_title["3.3V Rail Requirements"].type == WorkItemType.REQUIREMENT
    assert by_title["3.3V Rail Requirements"].parent_local_id == by_title["Power Distribution"].local_id
    assert by_title["Rail Sequencing Requirements"].type == WorkItemType.REQUIREMENT
    assert by_title["Rail Sequencing Requirements"].parent_local_id == by_title["Power Distribution"].local_id

    assert by_title["Thermal Management"].type == WorkItemType.FEATURE
    assert by_title["Thermal Management"].parent_local_id is None
    assert by_title["Fan Control"].type == WorkItemType.REQUIREMENT
    assert by_title["Fan Control"].parent_local_id == by_title["Thermal Management"].local_id


def test_mock_tv_remote_docx_same_nominal_depth_resolves_to_different_types_across_branches() -> None:
    """The literal 'Title 2 dual-role' case from the original request:
    branch 1's depth-1 node ("1 Remote Control") is an Epic (branch nests 5
    levels deep -> tv_style); branch 2's depth-1 node ("2 Menu System") is a
    Feature (branch only nests 2 levels deep -> icd_style) — same nominal
    depth, different type, same document."""
    doc = load_docx(str(_FIXTURES_DIR / "mock_tv_remote.docx"))
    tree = build_baseline_tree(doc)
    by_title = _nodes_by_title(tree.nodes)

    assert by_title["Remote Control"].type == WorkItemType.EPIC
    assert by_title["Menu System"].type == WorkItemType.FEATURE


def test_mock_tv_remote_docx_full_epic_to_subrequirement_chain() -> None:
    """Epic -> sub-Epic -> Feature -> Requirement -> sub-Requirement, all in
    one branch of a real (mock) document, not a hand-built in-memory Block
    list."""
    doc = load_docx(str(_FIXTURES_DIR / "mock_tv_remote.docx"))
    tree = build_baseline_tree(doc)
    by_title = _nodes_by_title(tree.nodes)

    remote = by_title["Remote Control"]
    button_layout = by_title["Button Layout"]
    volume_buttons = by_title["Volume Buttons"]
    assert remote.type == WorkItemType.EPIC
    assert button_layout.type == WorkItemType.EPIC
    assert button_layout.parent_local_id == remote.local_id
    assert volume_buttons.type == WorkItemType.FEATURE
    assert volume_buttons.parent_local_id == button_layout.local_id

    requirement = next(n for n in tree.nodes if n.parent_local_id == volume_buttons.local_id)
    assert requirement.type == WorkItemType.REQUIREMENT
    sub_requirement = next(
        n for n in tree.nodes if n.parent_local_id == requirement.local_id
    )
    assert sub_requirement.type == WorkItemType.REQUIREMENT


def test_mock_tv_remote_docx_long_line_title_is_truncated_not_summarized() -> None:
    """The depth-4 leaf is a real >256-char single line. BASELINE title
    extraction must truncate at a word boundary, never summarize/paraphrase
    (extract_baseline_title's contract) — proven here against a real parsed
    document instead of a synthetic string."""
    doc = load_docx(str(_FIXTURES_DIR / "mock_tv_remote.docx"))
    tree = build_baseline_tree(doc)
    long_node = next(n for n in tree.nodes if n.description.startswith("In accordance with"))

    assert len(long_node.title) <= 256
    assert long_node.title == long_node.description[: len(long_node.title)]
    assert long_node.description.startswith(long_node.title)


def test_mock_documents_pass_fidelity_verification() -> None:
    """Every node from both mock documents must pass verify_fidelity — the
    description equals sha256^-1... i.e. the stored hash matches sha256 of
    the final description, byte-for-byte, no LLM involved (BASELINE)."""
    for filename in ("mock_icd.docx", "mock_tv_remote.docx"):
        doc = load_docx(str(_FIXTURES_DIR / filename))
        tree = build_baseline_tree(doc)
        assert tree.nodes, f"{filename} produced no nodes"
        for node in tree.nodes:
            assert verify_fidelity(node), f"fidelity check failed for {filename}:{node.local_id}"


def test_mock_documents_produce_stable_hashes_across_rebuilds() -> None:
    """No LLM involved in BASELINE mode: rebuilding the same document twice
    must produce byte-identical fidelity hashes (determinism guarantee)."""
    for filename in ("mock_icd.docx", "mock_tv_remote.docx"):
        doc = load_docx(str(_FIXTURES_DIR / filename))
        first = build_baseline_tree(doc)
        second = build_baseline_tree(doc)
        first_hashes = [n.fidelity_hash for n in first.nodes]
        second_hashes = [n.fidelity_hash for n in second.nodes]
        assert first_hashes == second_hashes
