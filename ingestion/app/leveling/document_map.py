from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Protocol

from app.canonical.model import Block, BlockKind, CanonicalDoc
from app.canonical.stats import DocStats, compute_doc_stats, count_words
from app.leveling.id_hierarchy import (
    HierarchyRow,
    rows_from_heading_structure,
    rows_from_id_headings,
    rows_from_table,
)

logger = logging.getLogger(__name__)

# Job transparency (docs/job-transparency-implementation-plan.md, B2): the
# static "what is in your document" description the running screen fetches
# once -- true counts plus an outline of exactly the items the deterministic
# path will turn into work items. Pure data: building it never calls a model
# and never changes how the job runs.

MAP_VERSION = 1
MAX_MAP_ITEMS = 5000
TITLE_MAX_CHARS = 80
# Hard ceiling on the serialized map. Past it the item list is dropped and only
# groups (with counts) are kept, so a huge document cannot turn one Redis value
# into a document copy.
MAX_MAP_BYTES = 300_000
MAP_TTL_SECONDS = 24 * 3600


def map_key(job_id: str) -> str:
    return f"job-events:{job_id}:map"


@dataclass(frozen=True)
class MapItem:
    ref: str
    title: str
    words: int
    depth: int
    # Epic / Feature / Requirement as resolved by the detector, or None.
    type: str | None


@dataclass(frozen=True)
class MapGroup:
    ref: str
    title: str
    kind: str  # "heading" | "table"
    # Position of this group's first item in the FULL item sequence. When the
    # item list was truncated it is a prefix, so slicing still works and later
    # groups simply have no items listed.
    item_start: int
    item_count: int
    words: int


@dataclass(frozen=True)
class DocumentMap:
    version: int
    # What the running screen should call an item: "headings", "rows" or "items".
    unit: str
    stats: dict[str, Any]
    groups: list[MapGroup]
    items: list[MapItem]
    # True when the item list was cut or dropped to respect the size limits.
    truncated: bool = False
    # Items of every group are always counted in `item_count`, even when the
    # item list itself was dropped.
    total_items: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "unit": self.unit,
            "stats": self.stats,
            "truncated": self.truncated,
            "totalItems": self.total_items,
            "groups": [
                {"ref": g.ref, "title": g.title, "kind": g.kind,
                 "itemStart": g.item_start, "itemCount": g.item_count, "words": g.words}
                for g in self.groups
            ],
            "items": [
                {"ref": i.ref, "title": i.title, "words": i.words, "depth": i.depth, "type": i.type}
                for i in self.items
            ],
        }


@dataclass(frozen=True)
class SubtreeInput:
    """One deterministic subtree exactly as the pipeline will build it: a
    heading hierarchy or one qualifying table, with the resolved rows and each
    row's word count (used later to weight progress, so it must be computed
    the same way everywhere)."""

    kind: str  # "heading" | "table"
    title: str
    rows: list[HierarchyRow]
    row_words: list[int]


def _clip(text: str) -> str:
    one_line = " ".join(text.split())
    if len(one_line) <= TITLE_MAX_CHARS:
        return one_line
    return one_line[: TITLE_MAX_CHARS - 1].rstrip() + "…"


def _row_depth(rows: list[HierarchyRow], index: int) -> int:
    depth = 0
    seen: set[int] = set()
    parent = rows[index].parent_index
    while parent is not None and parent not in seen:
        seen.add(parent)
        depth += 1
        parent = rows[parent].parent_index
    return depth


def _heading_row_words(
    rows: list[HierarchyRow], heading_block_ids: list[str], blocks: list[Block],
) -> list[int]:
    """Words of each claimed heading plus the body content up to the next
    heading block (claimed or not) -- the same boundary the span-claiming
    pass in `_detect_deterministic_subtrees` uses, so the weights match what
    the model will actually be asked about."""
    index_by_block = {bid: i for i, bid in enumerate(heading_block_ids)}
    words = [0] * len(rows)
    current: int | None = None
    for block in blocks:
        if block.kind == BlockKind.HEADING and block.heading_level is not None:
            current = index_by_block.get(block.id)
            if current is not None:
                words[current] += count_words(block.text)
            continue
        if current is not None and block.kind not in (BlockKind.TABLE, BlockKind.FIGURE):
            words[current] += count_words(block.text)
    return words


def subtree_inputs_for_doc(doc: CanonicalDoc) -> list[SubtreeInput]:
    """Mirrors the detection order in `_detect_deterministic_subtrees`: every
    qualifying table first (each its own subtree), then the heading hierarchy
    (ID-bearing headings win over structure-only). Pure reads of `doc`."""
    inputs: list[SubtreeInput] = []
    for table in doc.tables:
        rows = rows_from_table(table)
        if not rows:
            continue
        words = [count_words(row.label) for row in rows]
        inputs.append(SubtreeInput("table", table.caption or f"Table {table.id}", rows, words))

    heading_rows, _, heading_block_ids = rows_from_id_headings(doc.blocks)
    if not heading_rows:
        heading_rows, _, heading_block_ids = rows_from_heading_structure(doc.blocks)
    if heading_rows:
        inputs.append(
            SubtreeInput(
                "heading", "Heading hierarchy", heading_rows,
                _heading_row_words(heading_rows, heading_block_ids, doc.blocks),
            )
        )
    return inputs


def _group_ranges(sub: SubtreeInput) -> list[tuple[int, int]]:
    """(start, end) row ranges: a table subtree is one group; a heading
    hierarchy is one group per root heading and its descendants."""
    if sub.kind == "table" or not sub.rows:
        return [(0, len(sub.rows))] if sub.rows else []
    starts = [i for i, row in enumerate(sub.rows) if row.parent_index is None]
    if not starts or starts[0] != 0:
        starts = [0] + [s for s in starts if s != 0]
    ends = starts[1:] + [len(sub.rows)]
    return list(zip(starts, ends))


def node_local_id(subtree_index: int, id_text: str) -> str:
    """The local id the deterministic builder gives a row's node:
    `det{subtree}_{id with dots as underscores}` (see build_hierarchy_subtree).
    Map items and live frames both use it, which is how the outline follows the run."""
    return f"det{subtree_index}_{id_text.replace('.', '_')}"


def build_document_map(stats: DocStats, subtrees: list[SubtreeInput]) -> DocumentMap:
    unit = "items"
    kinds = {s.kind for s in subtrees}
    if kinds == {"heading"}:
        unit = "headings"
    elif kinds == {"table"}:
        unit = "rows"

    groups: list[MapGroup] = []
    items: list[MapItem] = []
    total_items = 0
    truncated = False
    for sub_index, sub in enumerate(subtrees):
        for range_index, (start, end) in enumerate(_group_ranges(sub)):
            first = sub.rows[start]
            title = sub.title if sub.kind == "table" else _clip(first.label)
            group_words = sum(sub.row_words[start:end])
            group_start = total_items
            # Rows that fold into another item's text produce no work item, so
            # they are not outline items: they would wait forever.
            node_rows = [i for i in range(start, end) if sub.rows[i].node_type is not None]
            for row_index in node_rows:
                total_items += 1
                if len(items) >= MAX_MAP_ITEMS:
                    truncated = True
                    continue
                row = sub.rows[row_index]
                items.append(
                    MapItem(
                        # The node's own local id (see build_hierarchy_subtree), the same
                        # ref the live frames carry, so the outline can follow the run.
                        ref=node_local_id(sub_index, row.id_text),
                        title=_clip(row.label) or row.id_text,
                        words=sub.row_words[row_index], depth=_row_depth(sub.rows, row_index),
                        type=row.node_type,
                    )
                )
            groups.append(
                MapGroup(
                    ref=f"g{sub_index}.{range_index}", title=_clip(title) or sub.title,
                    kind=sub.kind,
                    item_start=group_start,
                    item_count=len(node_rows), words=group_words,
                )
            )

    doc_map = DocumentMap(
        version=MAP_VERSION, unit=unit, stats=_stats_dict(stats), groups=groups, items=items,
        truncated=truncated, total_items=total_items,
    )
    return _enforce_byte_limit(doc_map)


def _stats_dict(stats: DocStats) -> dict[str, Any]:
    return {
        "words": stats.words, "blocks": stats.blocks, "headings": stats.headings,
        "tables": stats.tables, "tableRows": stats.table_rows, "figures": stats.figures,
        "pages": stats.pages,
    }


def _enforce_byte_limit(doc_map: DocumentMap) -> DocumentMap:
    if len(json.dumps(doc_map.to_dict(), ensure_ascii=False).encode("utf-8")) <= MAX_MAP_BYTES:
        return doc_map
    return DocumentMap(
        version=doc_map.version, unit=doc_map.unit, stats=doc_map.stats, groups=doc_map.groups,
        items=[], truncated=True, total_items=doc_map.total_items,
    )


class _RedisLike(Protocol):
    def set(self, name: str, value: str, ex: int | None = ...) -> Any: ...


def write_document_map(redis_client: _RedisLike, job_id: str, doc_map: DocumentMap) -> bool:
    """Best-effort: the map is a display aid, so any failure is logged and
    swallowed -- it must never fail or slow the job."""
    try:
        payload = json.dumps(doc_map.to_dict(), ensure_ascii=False)
        redis_client.set(map_key(job_id), payload, ex=MAP_TTL_SECONDS)
        return True
    except Exception:  # noqa: BLE001 - observation must never break the job
        logger.warning("Failed to write document map for job %s", job_id, exc_info=True)
        return False


def publish_document_map(redis_client: _RedisLike, job_id: str, doc: CanonicalDoc) -> bool:
    """Builds and stores the map for one job. Wraps the whole thing so even a
    detector error is swallowed: this is observation, and the pipeline's own
    detection (which runs separately) remains the source of truth."""
    try:
        doc_map = build_document_map(compute_doc_stats(doc), subtree_inputs_for_doc(doc))
    except Exception:  # noqa: BLE001 - observation must never break the job
        logger.warning("Failed to build document map for job %s", job_id, exc_info=True)
        return False
    return write_document_map(redis_client, job_id, doc_map)


__all__ = [
    "DocumentMap", "MapGroup", "MapItem", "SubtreeInput", "build_document_map",
    "map_key", "publish_document_map", "subtree_inputs_for_doc", "write_document_map",
]
