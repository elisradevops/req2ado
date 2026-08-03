from __future__ import annotations

from app.canonical.model import Block, BlockKind
from app.leveling.id_hierarchy import classify_by_nesting, strip_sub_marker
from app.leveling.numbering import numbering_depth, parse_numbering
from app.workitem.model import WorkItemType


def is_heading_style_branch(branch_blocks: list[Block]) -> bool:
    """Distinguishes the two document conventions resolve_block_depth
    already knows about but tree_builder.py previously discarded: a real
    Word Heading style (the real-ICD convention, see
    profiles.heading_style_type_for_depth) versus a parsed numbering label
    (the flat customer-narrative convention, see
    classify_numbering_branch below).

    Checks ONLY the branch's own root/first block, not "any block in the
    branch" -- _split_into_branches (tree_builder.py) already guarantees a
    branch's first block sits exactly at the branch's top-level depth, so
    it always has a real resolved depth and is never an unleveled orphan.
    This is more robust than an "any block" check against an incidental
    styled paragraph appearing deeper inside an otherwise numbering-label
    branch (see test_heading_style_detection_uses_only_the_branch_root_not_any_block).
    No fixture or the golden scenario mixes the two conventions within one
    branch; if a real document ever does, the root block's own convention
    winning is the documented behavior, not an unhandled crash."""
    return bool(branch_blocks) and branch_blocks[0].kind == BlockKind.HEADING


def _is_lettered_suffix(label: str) -> bool:
    return label.rsplit(".", 1)[-1].isalpha()


def classify_numbering_branch(branch_blocks: list[Block]) -> dict[str, tuple[WorkItemType, WorkItemType, str]]:
    """Bottom-up, tree-shape-derived Epic/Feature/Requirement classification
    for a numbering-label branch -- replaces the old depth-threshold
    tv_style/icd_style heuristic entirely for this convention.

    An "override" node -- one whose numbering label's final dot-segment is
    alphabetic (a lettered sub-item, e.g. "1.1.2.2.a") OR whose stripped
    text starts with the literal marker "SUB-" -- repeats its parent's tier
    instead of advancing: these are the SAME mechanism, just two different
    textual spellings of "sub-X" from the app's own hierarchy rule.

    The actual bottom-up/top-down classification ladder is factored out
    into `id_hierarchy.classify_by_nesting` (level+override -> type,
    shared with convention 3's pure structural heading detector, which has
    no numbering labels at all but needs the identical ladder) -- this
    function's own job is now just: parse each block's numbering label,
    strip its display text, and translate the result to/from that shared
    function's generic (key, level, is_override) shape.

    Returns a dict keyed by block.id -> (type, child_type, stripped_display_text)
    for every block whose numbering label resolves (parse_numbering
    succeeds) -- a block with no numbering label at all (an unleveled
    orphan paragraph, folded elsewhere by tree_builder.py) is omitted, same
    set of blocks resolve_block_depth would resolve a non-None depth for."""
    items: list[tuple[str, int, bool]] = []
    display_text_by_id: dict[str, str] = {}

    for block in branch_blocks:
        label, remainder = parse_numbering(block.text)
        if label is None:
            continue
        depth = numbering_depth(label)
        is_lettered = _is_lettered_suffix(label)
        has_sub_marker, stripped = strip_sub_marker(remainder)
        items.append((block.id, depth, is_lettered or has_sub_marker))
        display_text_by_id[block.id] = stripped

    types_by_id = classify_by_nesting(items)
    return {
        block_id: (node_type, child_type, display_text_by_id[block_id])
        for block_id, (node_type, child_type) in types_by_id.items()
    }
