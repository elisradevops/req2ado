import json
from pathlib import Path

from app.canonical.model import (
    Block,
    BlockKind,
    CanonicalDoc,
    Document,
    DocumentFormat,
    SourceRef,
    Table,
    TableCell,
)
from app.canonical.stats import compute_doc_stats
from app.dispatch import dispatch_by_extension
from app.leveling import document_map as dm
from app.leveling.document_map import (
    build_document_map,
    map_key,
    subtree_inputs_for_doc,
    write_document_map,
)

FIXTURES = Path(__file__).parent / "fixtures"


def _sr(offset: int) -> SourceRef:
    return SourceRef(document_path="x.docx", start_offset=offset, end_offset=offset + 1)


def _heading(i: int, level: int, text: str) -> Block:
    return Block(
        id=f"h{i}", kind=BlockKind.HEADING, heading_level=level, text=text, source_ref=_sr(i),
    )


def _para(i: int, text: str) -> Block:
    return Block(id=f"p{i}", kind=BlockKind.PARAGRAPH, text=text, source_ref=_sr(i))


def _doc(blocks=(), tables=()) -> CanonicalDoc:
    return CanonicalDoc(
        document=Document(path="x.docx", format=DocumentFormat.DOCX, sha256="x"),
        blocks=list(blocks),
        tables=list(tables),
    )


def _heading_doc() -> CanonicalDoc:
    # Two roots, four headings each, with body text under some of them.
    return _doc(
        blocks=[
            _heading(0, 1, "1  Power interfaces"),
            _para(1, "The BP shall provide regulated power to the payload."),
            _heading(2, 2, "1.1  Bus voltage"),
            _para(3, "Nominal bus voltage is 28 V."),
            _heading(4, 3, "1.1.1  The system shall limit ripple to 50 mV."),
            _heading(5, 3, "1.1.2  The system shall report faults within 1 s."),
            _heading(6, 1, "2  Data interfaces"),
            _heading(7, 2, "2.1  Frames"),
            _heading(8, 3, "2.1.1  Each frame shall carry a frame counter."),
            _heading(9, 3, "2.1.2  Each frame shall carry a CRC."),
            _para(10, "The CRC is sixteen bits."),
        ]
    )


def _table_doc() -> CanonicalDoc:
    rows = [
        ["Requirement ID", "Requirement / Section"],
        ["1.1", "External source detection"],
        ["1.1.1", "The system shall detect an external source."],
        ["1.1.2", "The system shall switch to it within two seconds."],
    ]
    table = Table(
        id="t1", cells=[[TableCell(text=c) for c in row] for row in rows], source_ref=_sr(0),
        caption="Source requirements",
    )
    return _doc(tables=[table])


def _build(doc: CanonicalDoc):
    return build_document_map(compute_doc_stats(doc), subtree_inputs_for_doc(doc))


def test_heading_map_lists_every_claimed_heading_in_document_order() -> None:
    doc_map = _build(_heading_doc())
    assert doc_map.unit == "headings"
    assert doc_map.total_items == 8
    assert [i.title for i in doc_map.items][:3] == [
        "Power interfaces", "Bus voltage", "The system shall limit ripple to 50 mV.",
    ]
    assert [i.depth for i in doc_map.items][:4] == [0, 1, 2, 2]


def test_heading_map_has_one_group_per_root_heading() -> None:
    doc_map = _build(_heading_doc())
    assert [g.title for g in doc_map.groups] == ["Power interfaces", "Data interfaces"]
    assert [g.item_count for g in doc_map.groups] == [4, 4]
    assert [g.item_start for g in doc_map.groups] == [0, 4]


def test_item_words_include_the_body_text_under_each_heading() -> None:
    doc_map = _build(_heading_doc())
    power = doc_map.items[0]
    # "1  Power interfaces" (3 words, the ID counts) + one 9-word paragraph
    assert power.words == 3 + 9
    # "1.1  Bus voltage" (3) + "Nominal bus voltage is 28 V." (6)
    assert doc_map.items[1].words == 3 + 6


def test_group_words_equal_the_sum_of_their_item_words() -> None:
    doc_map = _build(_heading_doc())
    for group in doc_map.groups:
        items = doc_map.items[group.item_start : group.item_start + group.item_count]
        assert group.words == sum(item.words for item in items)


def test_item_words_never_exceed_the_document_total() -> None:
    doc_map = _build(_heading_doc())
    assert sum(item.words for item in doc_map.items) <= doc_map.stats["words"]


def test_table_map_is_one_group_in_rows() -> None:
    doc_map = _build(_table_doc())
    assert doc_map.unit == "rows"
    assert len(doc_map.groups) == 1
    assert doc_map.groups[0].kind == "table"
    assert doc_map.groups[0].title == "Source requirements"
    assert doc_map.total_items == len(doc_map.items) == doc_map.groups[0].item_count


def test_mixed_headings_and_tables_use_the_generic_unit() -> None:
    doc = _heading_doc()
    doc.tables.extend(_table_doc().tables)
    doc_map = _build(doc)
    assert doc_map.unit == "items"
    assert {g.kind for g in doc_map.groups} == {"heading", "table"}


def test_titles_are_clipped_to_one_line() -> None:
    long_title = "1  Power " + "very long heading " * 20
    doc = _doc(
        blocks=[
            _heading(0, 1, long_title),
            _heading(1, 2, "1.1  Child one"),
            _heading(2, 2, "1.2  Child two"),
        ]
    )
    doc_map = _build(doc)
    assert doc_map.items, "the headings should qualify"
    for item in doc_map.items:
        assert "\n" not in item.title
        assert len(item.title) <= dm.TITLE_MAX_CHARS


def test_map_is_deterministic_and_json_serializable() -> None:
    first = json.dumps(_build(_heading_doc()).to_dict(), sort_keys=True)
    second = json.dumps(_build(_heading_doc()).to_dict(), sort_keys=True)
    assert first == second


def test_document_without_structure_has_an_empty_map() -> None:
    doc_map = _build(_doc(blocks=[_para(0, "just some prose")]))
    assert doc_map.groups == []
    assert doc_map.items == []
    assert doc_map.total_items == 0
    assert doc_map.stats["words"] == 3


def test_every_shipped_fixture_builds_a_consistent_map() -> None:
    names = [
        "mock_icd.docx", "mock_prd_sensor.docx", "sample.docx",
        "sample.xlsx", "sample.csv", "sample.md",
    ]
    for name in names:
        doc = dispatch_by_extension(name, str(FIXTURES / name))
        doc_map = _build(doc)
        assert sum(g.item_count for g in doc_map.groups) == doc_map.total_items
        assert len(doc_map.items) <= doc_map.total_items


def test_item_cap_truncates_but_keeps_counts(monkeypatch) -> None:
    monkeypatch.setattr(dm, "MAX_MAP_ITEMS", 3)
    doc_map = _build(_heading_doc())
    assert doc_map.truncated is True
    assert len(doc_map.items) == 3
    assert doc_map.total_items == 8
    assert sum(g.item_count for g in doc_map.groups) == 8


def test_byte_cap_drops_items_but_keeps_groups(monkeypatch) -> None:
    full = _build(_heading_doc())
    monkeypatch.setattr(dm, "MAX_MAP_BYTES", 200)
    doc_map = _build(_heading_doc())
    assert doc_map.truncated is True
    assert doc_map.items == []
    assert len(doc_map.groups) == len(full.groups)
    assert doc_map.total_items == full.total_items


class _FakeRedis:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, int | None]] = []

    def set(self, name: str, value: str, ex: int | None = None) -> None:
        self.calls.append((name, value, ex))


class _BrokenRedis:
    def set(self, name: str, value: str, ex: int | None = None) -> None:
        raise ConnectionError("redis is down")


def test_write_stores_the_map_under_the_job_key_with_a_ttl() -> None:
    redis = _FakeRedis()
    assert write_document_map(redis, "job-1", _build(_heading_doc())) is True
    name, payload, ttl = redis.calls[0]
    assert name == map_key("job-1") == "job-events:job-1:map"
    assert ttl == dm.MAP_TTL_SECONDS
    assert json.loads(payload)["version"] == dm.MAP_VERSION


def test_write_never_raises_when_redis_is_down() -> None:
    assert write_document_map(_BrokenRedis(), "job-1", _build(_heading_doc())) is False


def _empty_stats():  # noqa: ANN202
    doc = CanonicalDoc(
        document=Document(path="x.docx", format=DocumentFormat.DOCX, sha256="x"), blocks=[],
    )
    return compute_doc_stats(doc)


def _hierarchy_rows():  # noqa: ANN202
    from app.canonical.model import SourceRef
    from app.leveling.id_hierarchy import HierarchyRow

    def row(label, node_type, parent, id_text, shall=False):  # noqa: ANN001, ANN202
        return HierarchyRow(
            label=label, has_shall=shall,
            source_ref=SourceRef(document_path="x.docx", start_offset=0, end_offset=1),
            node_type=node_type, parent_index=parent, id_text=id_text,
            id_disambiguator_needed=False, needs_synthesis=False, id_text_is_authored=True,
        )

    return [
        row("Power", "Epic", None, "1"),
        row("Input", "Feature", 0, "1.1"),
        row("The unit shall limit ripple.", "Requirement", 1, "1.1.1", True),
        row("Note folded into the one above", None, 2, "1.1.1.1"),
        row("The unit shall report faults.", "Requirement", 1, "1.1.2", True),
    ]


def test_map_item_refs_are_exactly_the_local_ids_of_the_nodes_the_builder_creates() -> None:
    from app.leveling.document_map import SubtreeInput, build_document_map
    from app.leveling.id_tree_builder import build_hierarchy_subtree

    rows = _hierarchy_rows()
    nodes, _ = build_hierarchy_subtree(rows, "det0_")
    doc_map = build_document_map(
        _empty_stats(),
        [SubtreeInput(kind="heading", title="Hierarchy", rows=rows, row_words=[5] * len(rows))],
    )
    assert [item.ref for item in doc_map.items] == [n.local_id for n in nodes]


def test_rows_that_fold_into_another_item_are_not_outline_items_and_counts_agree() -> None:
    from app.leveling.document_map import SubtreeInput, build_document_map

    rows = _hierarchy_rows()
    doc_map = build_document_map(
        _empty_stats(),
        [SubtreeInput(kind="heading", title="Hierarchy", rows=rows, row_words=[5] * len(rows))],
    )
    assert len(rows) == 5 and doc_map.total_items == 4
    assert all("1_1_1_1" not in item.ref for item in doc_map.items)
    assert sum(g.item_count for g in doc_map.groups) == doc_map.total_items
    assert doc_map.groups[0].item_start == 0


def test_second_subtree_refs_use_its_own_prefix() -> None:
    from app.leveling.document_map import SubtreeInput, build_document_map, node_local_id

    rows = _hierarchy_rows()
    sub = SubtreeInput(kind="heading", title="H", rows=rows, row_words=[1] * len(rows))
    doc_map = build_document_map(_empty_stats(), [sub, sub])
    assert {item.ref for item in doc_map.items if item.ref.startswith("det1_")} == {
        node_local_id(1, r.id_text) for r in rows if r.node_type
    }
