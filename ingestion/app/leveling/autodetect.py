from __future__ import annotations

import re

from app.canonical.model import Block, BlockKind
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


_SUB_MARKER_PATTERN = re.compile(r"^SUB-\s*[-–—]?\s*")


def _strip_sub_marker(text: str) -> tuple[bool, str]:
    match = _SUB_MARKER_PATTERN.match(text)
    if match:
        return True, text[match.end() :]
    return False, text


def _is_lettered_suffix(label: str) -> bool:
    return label.rsplit(".", 1)[-1].isalpha()


class _Node:
    __slots__ = ("block_id", "depth", "display_text", "is_override", "children", "type", "child_type")

    def __init__(self, block_id: str, depth: int, display_text: str, is_override: bool) -> None:
        self.block_id = block_id
        self.depth = depth
        self.display_text = display_text
        self.is_override = is_override
        self.children: list[_Node] = []
        self.type: WorkItemType | None = None
        self.child_type: WorkItemType | None = None


def classify_numbering_branch(branch_blocks: list[Block]) -> dict[str, tuple[WorkItemType, WorkItemType, str]]:
    """Bottom-up, tree-shape-derived Epic/Feature/Requirement classification
    for a numbering-label branch -- replaces the old depth-threshold
    tv_style/icd_style heuristic entirely for this convention. Per the
    spec's own hierarchy rule ("a Requirement MAY be a child of a
    Requirement (sub-Req), a Feature child of a Feature (sub-Feature), an
    Epic child of an Epic (sub-Epic)"), a node either advances one tier
    below its parent or repeats its parent's tier -- what decides which,
    for an unmarked node, is whether promoting it would still leave room
    for its own descendants to reach Requirement.

    An "override" node -- one whose numbering label's final dot-segment is
    alphabetic (a lettered sub-item, e.g. "1.1.2.2.a") OR whose stripped
    text starts with the literal marker "SUB-" -- repeats its parent's tier
    instead of advancing: these are the SAME mechanism, just two different
    textual spellings of "sub-X" from the app's own hierarchy rule. An
    override node's type is its parent's already-computed type, and it is
    excluded from its parent's own children-classification (it does not
    count toward "did this parent's children all resolve to Requirement").

    A non-override node's type, given its non-override children's
    (already-classified) types:
    - zero non-override children (a true leaf, or every child was an
      override) -> Requirement.
    - every non-override child is Requirement -> Feature.
    - otherwise (at least one non-override child already promoted past
      Requirement) -> Epic. This is a strict two-way split: the ladder only
      ever moves downward (a Requirement cannot have a Feature child), so
      any child that needed its own further breakdown forces this parent
      to sit at or above Feature; a parent at exactly Feature is only valid
      when every real child is a leaf-level Requirement.

    Returns a dict keyed by block.id -> (type, child_type, stripped_display_text)
    for every block whose numbering label resolves (parse_numbering
    succeeds) -- a block with no numbering label at all (an unleveled
    orphan paragraph, folded elsewhere by tree_builder.py) is omitted, same
    set of blocks resolve_block_depth would resolve a non-None depth for."""
    stack: list[_Node] = []
    roots: list[_Node] = []
    all_nodes: list[_Node] = []

    for block in branch_blocks:
        label, remainder = parse_numbering(block.text)
        if label is None:
            continue
        depth = numbering_depth(label)
        is_lettered = _is_lettered_suffix(label)
        has_sub_marker, stripped = _strip_sub_marker(remainder)
        node = _Node(block.id, depth, stripped, is_lettered or has_sub_marker)

        while stack and stack[-1].depth >= depth:
            stack.pop()
        if stack:
            stack[-1].children.append(node)
        else:
            roots.append(node)
        stack.append(node)
        all_nodes.append(node)

    def classify(node: _Node) -> WorkItemType:
        non_override_types = []
        for child in node.children:
            child_type = classify(child)
            if not child.is_override:
                non_override_types.append(child_type)
        if not non_override_types:
            node.type = WorkItemType.REQUIREMENT
        elif all(t == WorkItemType.REQUIREMENT for t in non_override_types):
            node.type = WorkItemType.FEATURE
        else:
            node.type = WorkItemType.EPIC
        return node.type

    for root in roots:
        classify(root)

    # Override nodes inherit their parent's FINAL type -- must run as a
    # second, top-down pass after every node's own intrinsic (bottom-up)
    # type has been computed, since a strict post-order walk visits a node
    # before its parent's own type is known. Root-level override nodes (no
    # parent to inherit from) keep their intrinsic classification -- not
    # expected in practice (SUB-/lettered markers only ever appear on
    # nested lines in every example seen), but the fallback must exist
    # rather than crash.
    def apply_overrides(node: _Node, parent: _Node | None) -> None:
        if node.is_override and parent is not None:
            node.type = parent.type
        for child in node.children:
            apply_overrides(child, node)

    for root in roots:
        apply_overrides(root, None)

    def compute_child_type(node: _Node) -> WorkItemType:
        if node.type == WorkItemType.REQUIREMENT:
            return WorkItemType.REQUIREMENT
        non_override_child_types = {c.type for c in node.children if not c.is_override}
        if len(non_override_child_types) == 1:
            return next(iter(non_override_child_types))
        return WorkItemType.FEATURE if node.type == WorkItemType.EPIC else WorkItemType.REQUIREMENT

    for node in all_nodes:
        node.child_type = compute_child_type(node)

    return {node.block_id: (node.type, node.child_type, node.display_text) for node in all_nodes}
