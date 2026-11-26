"""The owner's tree-building rules after the wave 1 production probe (2026-11-26). What the builder must never do, for every file:

- R1: no parentless Feature or Requirement, also after a rename, a removed level or a collapse; a breach is repaired and reported.
- R2: no Epic or Feature without a requirement below it (test_grammar_builder_rules.py covers the TV twin's empty sections).
- R6: no title over the Azure DevOps limit of 255 characters, every type; a longer one is shortened at a word with a marker and the full
  text stays in the description.

The ladder itself over every fixture is test_structure_contract.py's `ladder_violations`."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.dispatch import dispatch_by_extension
from app.leveling.tree_builder import build_baseline_tree
from app.loaders.pdf_loader import load_pdf
from app.study.model_rules import document_headings
from app.study.rulebook import DocumentRules, FileRulebook, Proposal
from app.workitem.model import WorkItemNode
from tests.test_structure_contract import REGISTRY, _load, _survey, ladder_violations

sys.path.insert(0, str(Path(__file__).parent / "fixtures" / "tv_twin"))
from build_tv_twin_pdf import build_twin_spec_pdf  # noqa: E402

CODES = ("aud_1", "btn_2", "men_3", "tun_1")
ADO_TITLE_LIMIT = 255
SCHEMAS = Path(__file__).resolve().parents[2] / "shared" / "schemas"


def empty_containers(tree) -> list[str]:
    """The Epics and Features with no Requirement anywhere below them (R2)."""
    children: dict[str | None, list] = {}
    for n in tree.nodes:
        children.setdefault(n.parent_local_id, []).append(n)

    def holds_requirement(node) -> bool:
        return any(c.type.value == "Requirement" or holds_requirement(c) for c in children.get(node.local_id, []))

    return [f"{n.type.value}: {n.title}" for n in tree.nodes if n.type.value != "Requirement" and not holds_requirement(n)]


@pytest.mark.parametrize("label,filename", REGISTRY, ids=[label for label, _ in REGISTRY])
def test_no_fixture_builds_an_epic_or_feature_without_a_requirement_below_it(label: str, filename: str) -> None:
    doc = _load(filename)
    assert empty_containers(build_baseline_tree(doc)) == [], label
    assert empty_containers(_survey(doc, 1)) == [], label


# --- R1: the ladder holds after the study's structural changes -----------------------------------------------------------------------


@pytest.fixture(scope="module")
def tv(tmp_path_factory):
    return load_pdf(str(build_twin_spec_pdf(tmp_path_factory.mktemp("rules"))[0]))


def test_removing_the_top_level_never_leaves_a_feature_without_a_parent(tv) -> None:
    """The top "Requirements" level holds Epics and two Features ("Software", "Test"). Removing it would leave those Features as roots: the
    document's grammar puts the top sections under one Epic named from the cover instead (owner decision 4: a loose Feature goes under an Epic
    named from the document)."""
    top = next(h["block_id"] for h in document_headings(tv) if h["number"] == "2")
    drop = Proposal(top, "drop_wrapper", None, "A generic name holding everything.")
    tree = build_baseline_tree(tv, FileRulebook(document=DocumentRules(requirement_codes=CODES, proposals=(drop,))))
    assert ladder_violations(tree) == []
    assert "Requirements" not in {n.title for n in tree.nodes}
    assert sum(1 for n in tree.nodes if n.type.value == "Requirement") == 121
    by_title = {n.title: n for n in tree.nodes}
    roots = [n for n in tree.nodes if n.parent_local_id is None]
    assert len(roots) == 1 and "Vireo Television Set" in roots[0].title
    assert by_title["Software"].parent_local_id == by_title["Test"].parent_local_id == roots[0].local_id


# --- R6: titles fit Azure DevOps ----------------------------------------------------------------------------------------------------


def test_the_contract_allows_at_most_255_title_characters() -> None:
    schema = json.loads((SCHEMAS / "work-item-tree.schema.json").read_text(encoding="utf-8"))
    titles = [d["properties"]["title"] for d in _objects_with_title(schema)]
    assert titles and all(t.get("maxLength") == ADO_TITLE_LIMIT for t in titles), titles
    with pytest.raises(ValidationError):
        WorkItemNode(local_id="x", type="Requirement", title="a" * (ADO_TITLE_LIMIT + 1), description="", mode="BASELINE")


def _objects_with_title(node) -> list[dict]:
    found = []
    if isinstance(node, dict):
        if isinstance(node.get("properties"), dict) and "title" in node["properties"]:
            found.append(node)
        for value in node.values():
            found.extend(_objects_with_title(value))
    elif isinstance(node, list):
        for value in node:
            found.extend(_objects_with_title(value))
    return found


LONG = (
    "The unit shall record every operator action, every alarm raised by the cooling loop, every change of the setpoint made from the "
    "front panel or the remote console, and every restart of the controller, together with the time, the operator's role and the "
    "previous value, in a log that survives a power loss and holds at least ninety days of entries"
)


def _assert_shortened(title: str, full_text: str, description: str) -> None:
    assert len(title) <= ADO_TITLE_LIMIT, len(title)
    assert title.endswith("…"), title[-20:]
    kept = title[:-1].rstrip()
    assert full_text.startswith(kept) and full_text[len(kept)] in " ,;:", "cut inside a word"
    assert full_text in " ".join(description.split())


def test_a_requirement_sentence_longer_than_the_limit_is_shortened_at_a_word(tmp_path: Path) -> None:
    assert len(LONG) > ADO_TITLE_LIMIT
    path = tmp_path / "spec.md"
    others = "\n\n".join(f"REQ-{n:03d}: The unit shall perform function number {n} within {n} s." for n in range(2, 7))
    path.write_text(f"# 1 Requirements\n\n## 1.1 Logging\n\nREQ-001: {LONG}.\n\n{others}\n", encoding="utf-8")
    tree = build_baseline_tree(dispatch_by_extension("spec.md", str(path)))
    node = next(n for n in tree.nodes if n.customer_id == "REQ-001")
    _assert_shortened(node.title, LONG, node.description)


def test_a_stated_sheet_title_longer_than_the_limit_is_shortened_at_a_word(tmp_path: Path) -> None:
    path = tmp_path / "export.csv"
    rows = [
        "ID,Work Item Type,Title 1,Title 2,Title 3",
        "1,Epic,Logging,,",
        "2,Feature,,Operator log,",
        f'3,Requirement,,,"{LONG}"',
    ]
    path.write_text("\n".join(rows) + "\n", encoding="utf-8")
    tree = build_baseline_tree(dispatch_by_extension("export.csv", str(path)))
    node = next(n for n in tree.nodes if n.type.value == "Requirement")
    _assert_shortened(node.title, LONG, node.description)


# --- R1's model step: the AI chooses the parent among the places code offers (app.leveling.parent_choice) -------------------------------


class _Chooser:
    """A model that places each item under the offered option titled `wants[item title]`, or answers `answer` as given."""

    def __init__(self, wants: dict[str, str] | None = None, answer: dict | None = None, fail: bool = False) -> None:
        self.wants, self.answer, self.fail, self.seen = wants or {}, answer, fail, None

    def choose_parents(self, items_by_id: dict[str, dict], user_id: str | None = None) -> dict[str, dict]:
        self.seen = items_by_id
        if self.fail:
            raise RuntimeError("the proxy refused the call")
        if self.answer is not None:
            return self.answer
        picks = {}
        for item_id, item in items_by_id.items():
            want = self.wants.get(item["title"])
            option = next((o for o, place in item["options"].items() if place["title"] == want), None)
            if option:
                picks[item_id] = {"option": option, "reason": f"About {want}."}
        return picks


def _orphaned():
    """A tree whose top level is gone (a removed or missing heading): two Features are left without a parent, beside two Epics. The rule
    pass completes the ladder with code (the Epic named after the document), and reports the wrap."""
    from app.leveling.tree_builder import _rehash
    from app.leveling.tree_rules import apply_tree_rules
    from app.workitem.model import WorkItemTree
    from tests.test_structure_contract import _section

    nodes = [
        _section("e1", "TV receiver", "Epic"),
        _section("f1", "Tuner", "Feature", "e1"),
        _section("r1", "Tuner locks within 1.5 s", "Requirement", "f1"),
        _section("e2", "Remote control", "Epic"),
        _section("f2", "Buttons", "Feature", "e2"),
        _section("r2", "Buttons light up", "Requirement", "f2"),
        _section("f3", "Software", "Feature"),
        _section("r3", "Software updates over the network", "Requirement", "f3"),
        _section("f4", "Remote batteries", "Feature"),
        _section("r4", "Batteries last 12 months", "Requirement", "f4"),
    ]
    tree = WorkItemTree(nodes=nodes, warnings=[])
    apply_tree_rules(tree.nodes, tree.warnings, "Vireo Television Set", _rehash)
    return tree


def test_the_build_wraps_parentless_items_under_the_documents_epic_and_names_them() -> None:
    tree = _orphaned()
    assert ladder_violations(tree) == []
    wrap = next(w for w in tree.warnings if w.kind.value == "catchall_epic_wrap")
    assert set(wrap.node_ids[1:]) == {"f3", "f4"}


def test_the_ai_places_each_parentless_item_and_the_reviewer_is_told() -> None:
    from app.leveling.parent_choice import choose_parents

    tree = _orphaned()
    chooser = _Chooser({"Software": "TV receiver", "Remote batteries": "Remote control"})
    moved = choose_parents(tree.nodes, tree.warnings, chooser)
    by_title = {n.title: n for n in tree.nodes}
    assert moved == 2
    assert by_title["Software"].parent_local_id == "e1"
    assert by_title["Remote batteries"].parent_local_id == "e2"
    assert ladder_violations(tree) == []
    # Every option offered is a place the ladder allows, the code's own placement first.
    for item in chooser.seen.values():
        assert item["options"]["o0"]["title"] == "Vireo Television Set"
        assert all(place["type"] in ("Epic", "Feature") for place in item["options"].values())
    # The document-named Epic held only those two: it is gone, and so is its warning; the moves are reported.
    assert not [n for n in tree.nodes if "synth_" in n.local_id]
    kinds = [w.kind.value for w in tree.warnings]
    assert "catchall_epic_wrap" not in kinds and "parent_chosen" in kinds
    chosen = next(w for w in tree.warnings if w.kind.value == "parent_chosen")
    assert {m["reason"] for m in chosen.detail["moves"]} == {"About TV receiver.", "About Remote control."}


def test_an_item_the_ai_keeps_under_the_documents_epic_stays_there() -> None:
    from app.leveling.parent_choice import choose_parents

    tree = _orphaned()
    assert choose_parents(tree.nodes, tree.warnings, _Chooser({"Software": "TV receiver", "Remote batteries": "Vireo Television Set"})) == 1
    by_title = {n.title: n for n in tree.nodes}
    assert by_title["Remote batteries"].parent_local_id == by_title["Vireo Television Set"].local_id
    assert ladder_violations(tree) == []


@pytest.mark.parametrize(
    "chooser",
    [
        _Chooser(fail=True),  # the call failed
        _Chooser(answer={}),  # nothing came back
        _Chooser(answer={"x": {"option": "o1", "reason": "?"}}),  # an id that was not asked
        _Chooser(answer={"f3": {"option": "o99", "reason": "Invented."}}),  # an option that was not offered
    ],
    ids=["failed", "empty", "unknown-id", "not-offered"],
)
def test_without_a_usable_answer_the_codes_placement_stays(chooser) -> None:
    from app.leveling.parent_choice import choose_parents

    tree = _orphaned()
    before = {n.local_id: n.parent_local_id for n in tree.nodes}
    assert choose_parents(tree.nodes, tree.warnings, chooser) == 0
    assert {n.local_id: n.parent_local_id for n in tree.nodes} == before
    assert ladder_violations(tree) == []


# --- R6's model step: the AI names an item whose title the build had to shorten ---------------------------------------------------------


class _Titler:
    def __init__(self, titles: dict[str, str]) -> None:
        self.titles, self.asked = titles, {}

    def requirement_titles(self, texts_by_id: dict[str, str], user_id: str | None = None) -> dict[str, dict]:
        self.asked = texts_by_id
        return {k: {"title": self.titles[k]} for k in texts_by_id if k in self.titles}


def test_a_shortened_title_is_renamed_by_the_ai_even_when_the_file_gives_its_own_titles(tmp_path: Path) -> None:
    from app.leveling.requirement_titles import was_shortened, write_requirement_titles

    path = tmp_path / "export.csv"
    rows = ["ID,Work Item Type,Title 1,Title 2,Title 3", "1,Epic,Logging,,", "2,Feature,,Operator log,", f'3,Requirement,,,"{LONG}"']
    path.write_text("\n".join(rows) + "\n", encoding="utf-8")
    tree = build_baseline_tree(dispatch_by_extension("export.csv", str(path)))
    node = next(n for n in tree.nodes if n.type.value == "Requirement")
    assert was_shortened(node)
    titler = _Titler({node.local_id: "Log of operator actions and alarms"})
    write_requirement_titles(tree.nodes, titler, tree.warnings, grammar_requirements=False)
    assert set(titler.asked) == {node.local_id}  # only the shortened item: the file gives the others their titles
    assert node.title == "Log of operator actions and alarms"
    assert LONG in " ".join(node.description.split())


def test_a_shortened_title_keeps_the_marked_cut_when_the_ai_title_is_not_grounded(tmp_path: Path) -> None:
    from app.leveling.requirement_titles import write_requirement_titles

    path = tmp_path / "export.csv"
    rows = ["ID,Work Item Type,Title 1,Title 2,Title 3", "1,Epic,Logging,,", "2,Feature,,Operator log,", f'3,Requirement,,,"{LONG}"']
    path.write_text("\n".join(rows) + "\n", encoding="utf-8")
    tree = build_baseline_tree(dispatch_by_extension("export.csv", str(path)))
    node = next(n for n in tree.nodes if n.type.value == "Requirement")
    cut = node.title
    write_requirement_titles(tree.nodes, _Titler({node.local_id: "Audit trail for regulators"}), tree.warnings, grammar_requirements=False)
    assert node.title == cut and cut.endswith("…")
