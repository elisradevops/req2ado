"""A trace link must be supported by its evidence: the quote has to refer to the item it links to.

Prod: Sonnet proposed 124 links on a document where the other models proposed 27 to 31 (58 more were dropped because
their quote was not in the source). A quote that really is in the source but says nothing about the target is no
evidence that the source refers to the target, so such a link is dropped, and one source cannot attach to dozens of
targets."""
from __future__ import annotations

from app.canonical.model import SourceRef
from app.leveling.trace_links import MAX_LINKS_PER_SOURCE, _infer_trace_links_for_nodes
from app.workitem.model import WorkItemMode, WorkItemNode, WorkItemType

CATALOG = [{"reference_name": "System.LinkTypes.Related", "name": "Related"}]


def _node(local_id: str, title: str, description: str, customer_id: str | None = None) -> WorkItemNode:
    return WorkItemNode(
        local_id=local_id, type=WorkItemType.REQUIREMENT, parent_local_id=None, title=title, description=description,
        customer_id=customer_id, source_ref=SourceRef(document_path="x.docx", start_offset=0, end_offset=1), mode=WorkItemMode.SURVEY,
    )


class _Client:
    def __init__(self, links: list[dict]) -> None:
        self._links = links

    def infer_trace_links(self, nodes, link_type_catalog, kb_context=None, user_id=None):
        return self._links


def _link(source: str, target: str, quote: str) -> dict:
    return {"source_node_id": source, "reference_name": "System.LinkTypes.Related", "target_ref": target, "evidence_quote": quote}


NODES = [
    _node("n0", "Power budget", "The unit shall meet the Thermal Management limits defined elsewhere in this document.", "REQ-1"),
    _node("n1", "Thermal Management", "The enclosure shall dissipate 40 W.", "REQ-2"),
    _node("n2", "Unrelated", "The receiver shall lock within 5 ms.", "REQ-3"),
]


def test_a_link_whose_quote_names_the_target_is_kept() -> None:
    links = _infer_trace_links_for_nodes(NODES, _Client([_link("n0", "n1", "meet the Thermal Management limits")]), CATALOG, [], None, 0, 0)
    assert [(l.source_local_id, l.target_local_id) for l in links] == [("n0", "n1")]


def test_a_link_whose_quote_is_in_the_source_but_says_nothing_about_the_target_is_dropped() -> None:
    links = _infer_trace_links_for_nodes(NODES, _Client([_link("n0", "n2", "meet the Thermal Management limits")]), CATALOG, [], None, 0, 0)
    assert links == []


def test_the_target_may_be_named_by_its_customer_id() -> None:
    nodes = [_node("n0", "A", "See requirement REQ-2 for the thermal limit."), NODES[1]]
    links = _infer_trace_links_for_nodes(nodes, _Client([_link("n0", "n1", "See requirement REQ-2")]), CATALOG, [], None, 0, 0)
    assert len(links) == 1


def test_a_cross_job_target_must_appear_literally_in_the_quote() -> None:
    nodes = [_node("n0", "A", "The unit shall comply with REQ-SYS-012 of the system specification.")]
    kept = _infer_trace_links_for_nodes(nodes, _Client([_link("n0", "REQ-SYS-012", "comply with REQ-SYS-012")]), CATALOG, [], None, 0, 0)
    dropped = _infer_trace_links_for_nodes(nodes, _Client([_link("n0", "REQ-SYS-099", "comply with REQ-SYS-012")]), CATALOG, [], None, 0, 0)
    assert len(kept) == 1 and dropped == []


def test_one_source_cannot_attach_to_dozens_of_targets() -> None:
    targets = [_node(f"t{i}", f"Target number {i}", f"Text of target {i}.") for i in range(MAX_LINKS_PER_SOURCE + 6)]
    quote = " and ".join(f"Target number {i}" for i in range(len(targets)))
    source = _node("s", "Source", f"This item mentions {quote}.")
    links = _infer_trace_links_for_nodes([source, *targets], _Client([_link("s", f"t{i}", f"Target number {i}") for i in range(len(targets))]), CATALOG, [], None, 0, 0)
    assert len(links) == MAX_LINKS_PER_SOURCE
    assert [l.target_local_id for l in links] == [f"t{i}" for i in range(MAX_LINKS_PER_SOURCE)]  # the first ones, deterministically


def test_words_every_requirement_uses_do_not_ground_a_link() -> None:
    nodes = [
        _node("n0", "A", "The system shall provide the thing described in the other section."),
        _node("n1", "The system shall provide support", "Another requirement."),
    ]
    assert _infer_trace_links_for_nodes(nodes, _Client([_link("n0", "n1", "The system shall provide the thing")]), CATALOG, [], None, 0, 0) == []


def test_the_whole_title_of_the_target_grounds_a_link_even_when_its_words_are_generic() -> None:
    nodes = [
        _node("n0", "A", "The system shall provide support as in The system shall provide support."),
        _node("n1", "The system shall provide support", "Another requirement."),
    ]
    links = _infer_trace_links_for_nodes(nodes, _Client([_link("n0", "n1", "The system shall provide support")]), CATALOG, [], None, 0, 0)
    assert len(links) == 1
