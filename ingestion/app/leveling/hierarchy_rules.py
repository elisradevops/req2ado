from __future__ import annotations

import hashlib
import logging
import re
from collections import Counter

from app.workitem.model import (
    IntegrityWarning,
    WarningKind,
    WorkItemMode,
    WorkItemNode,
    WorkItemType,
)

logger = logging.getLogger(__name__)

_OBLIGATION = re.compile(
    r"\b(shall|must|should|will|may|needs? to|is required|are required)\b", re.IGNORECASE
)

E, F, R = WorkItemType.EPIC, WorkItemType.FEATURE, WorkItemType.REQUIREMENT

# The notice reads only the three words a requirement is written with. The typing rule above is wider (it also reads may, will, needs to), which
# is right for deciding a shape but would name "Release notes - May 2025" or "Will-call interfaces" in a message that says "states a requirement".
_STATES_A_REQUIREMENT_NOTICE = re.compile(r"\b(shall|must|should)\b", re.IGNORECASE)

# (child type, parent type) pairs the ladder allows. Same-type nesting is allowed (Epic under Epic, Feature under
# Feature, Requirement under Requirement); a root can only be an Epic.
_VALID_PARENT = {E: {E}, F: {E, F}, R: {F, R}}


def states_a_requirement(title: str) -> bool:
    """A heading whose own text carries an obligation modal states a requirement."""
    return bool(_OBLIGATION.search(title or ""))


# A file's own requirement level, learned from the whole file: when at least this many headings are leaves and nearly all of them sit at one nesting depth,
# that depth is where the file writes its requirements, and a leaf above it is a section that is still empty, not a requirement.
LEAF_FLOOR_MIN_LEAVES = 20
LEAF_FLOOR_SHARE = 0.9


def learn_leaf_floor(
    nodes: list[WorkItemNode], non_structural_ids: set[str] | frozenset[str] = frozenset()
) -> int | None:
    """The nesting depth at which `nodes` (the whole file, not one branch) write their requirements, or None when no depth is clear enough to
    be a rule. Read over every leaf heading: with LEAF_FLOOR_MIN_LEAVES or more of them and LEAF_FLOOR_SHARE of them at one depth, that depth is
    the floor. A file whose leaves sit at mixed depths has no rule, and the shape rule alone types it."""
    ids = {n.local_id for n in nodes}
    parent_of = {n.local_id: n.parent_local_id for n in nodes if n.parent_local_id in ids}
    has_child = {
        n.parent_local_id
        for n in nodes
        if n.parent_local_id in ids and n.local_id not in non_structural_ids
    }
    depth_cache: dict[str, int] = {}

    def depth(local_id: str, path: tuple[str, ...] = ()) -> int:
        if local_id not in depth_cache:
            parent = parent_of.get(local_id)
            depth_cache[local_id] = (
                0
                if parent is None or parent in path or local_id in path
                else depth(parent, (*path, local_id)) + 1
            )
        return depth_cache[local_id]

    leaf_depths = Counter(
        depth(n.local_id)
        for n in nodes
        if n.local_id not in has_child and n.local_id not in non_structural_ids
    )
    total = sum(leaf_depths.values())
    if total < LEAF_FLOOR_MIN_LEAVES:
        return None
    floor, count = leaf_depths.most_common(1)[0]
    return floor if count / total >= LEAF_FLOOR_SHARE else None


def type_headings_by_shape(
    nodes: list[WorkItemNode],
    non_structural_ids: set[str] | frozenset[str] = frozenset(),
    locked: dict[str, WorkItemType] | None = None,
    leaf_floor: int | None = None,
) -> None:
    """Types the nodes of ONE heading-built forest from its shape, keeping the nesting exactly as the headings give it
    (nothing is moved, nothing is dropped, titles/descriptions/source refs/hashes are never touched):
    - a heading with no children is a Requirement;
    - a heading that states a requirement (obligation modal in its own title) and has only leaf children stays a
      Requirement, its sub-requirements nested under it;
    - any other heading with children is a section: the top one is an Epic when it has a sub-section, else a Feature;
      a section below a section is a Feature (a Feature may hold Features).
    `non_structural_ids` names nodes (such as the front-matter node) that do not make their parent a section.
    `locked` maps a node to the type the file itself states for it (see study/heading_rules.py): that type is final, and the node counts as a
    section or a requirement for the nodes around it accordingly. `leaf_floor` is the depth the whole file writes its requirements at
    (learn_leaf_floor): a leaf heading above it is a section, not a requirement.
    Mutates `nodes` in place; a node that stops being a Requirement loses its Customer ID, which only a Requirement
    carries."""
    ids = {n.local_id for n in nodes}
    children: dict[str, list[WorkItemNode]] = {}
    for n in nodes:
        if n.parent_local_id in ids and n.local_id not in non_structural_ids:
            children.setdefault(n.parent_local_id, []).append(n)  # type: ignore[arg-type]
    by_id = {n.local_id: n for n in nodes}

    def is_leaf(n: WorkItemNode) -> bool:
        return n.local_id not in children

    def is_statement(n: WorkItemNode) -> bool:
        return (
            not is_leaf(n)
            and states_a_requirement(n.source_title or n.title)
            and all(is_leaf(c) for c in children[n.local_id])
        )

    depth_of: dict[str, int] = {}

    def depth(n: WorkItemNode) -> int:
        if n.local_id not in depth_of:
            chain, current, seen = (
                0,
                by_id.get(n.parent_local_id) if n.parent_local_id else None,
                {n.local_id},
            )
            while current is not None and current.local_id not in seen:
                seen.add(current.local_id)
                chain += 1
                current = by_id.get(current.parent_local_id) if current.parent_local_id else None
            depth_of[n.local_id] = chain
        return depth_of[n.local_id]

    def is_section(n: WorkItemNode) -> bool:
        if locked and n.local_id in locked:
            return locked[n.local_id] != R
        if leaf_floor is not None and is_leaf(n) and depth(n) < leaf_floor:
            return True
        return not is_leaf(n) and not is_statement(n)

    for n in nodes:
        if locked and n.local_id in locked:
            new_type = locked[n.local_id]
        elif not is_section(n):
            new_type = R
        else:
            parent = by_id.get(n.parent_local_id) if n.parent_local_id else None
            has_section_above = False
            seen: set[str] = set()
            while parent is not None and parent.local_id not in seen:
                seen.add(parent.local_id)
                if is_section(parent):
                    has_section_above = True
                    break
                parent = by_id.get(parent.parent_local_id) if parent.parent_local_id else None
            if has_section_above:
                new_type = F
            else:
                new_type = E if any(is_section(c) for c in children.get(n.local_id, [])) else F
        if new_type != R:
            n.customer_id = None
        n.type = new_type


def requirement_heading_warning(nodes: list[WorkItemNode]) -> IntegrityWarning | None:
    """One notice for the headings that state a requirement yet became sections (they have sub-sections), or None.
    Read from the final tree, once per run: a section node (Epic or Feature) that has children, built from a heading whose own
    text says shall, must or should. Synthesized nodes (bridge Features, regrouped or wrapped Epics) are not headings of the source."""
    has_children = {n.parent_local_id for n in nodes if n.parent_local_id}
    flagged: list[WorkItemNode] = []
    for n in nodes:
        if n.type == R or "synth_" in n.local_id or n.local_id not in has_children:
            continue
        heading = n.source_title or n.title
        if heading and _STATES_A_REQUIREMENT_NOTICE.search(heading):
            flagged.append(n)
    if not flagged:
        return None
    headings = [(n.source_title or n.title) for n in flagged]
    shown = "; ".join(f"“{h}”" for h in headings[:3]) + ("; …" if len(headings) > 3 else "")
    return IntegrityWarning.make(
        WarningKind.REQUIREMENT_HEADING_IS_SECTION,
        f"{len(flagged)} heading{' states' if len(flagged) == 1 else 's state'} a requirement but "
        f"{'has' if len(flagged) == 1 else 'have'} sub-sections, so {'it is' if len(flagged) == 1 else 'they are'} kept "
        f"as {'a section' if len(flagged) == 1 else 'sections'} with the statement at the top of the description, not as "
        f"{'a Requirement' if len(flagged) == 1 else 'Requirements'}: {shown}.",
        node_ids=[n.local_id for n in flagged],
        detail={"headings": headings},
    )


def _synthetic(
    node_id: str, node_type: WorkItemType, parent: str | None, title: str, like: WorkItemNode
) -> WorkItemNode:
    from app.leveling.tree_builder import _hash_identity_for_synthesized_node

    return WorkItemNode(
        local_id=node_id,
        type=node_type,
        parent_local_id=parent,
        title=title,
        description=title,
        source_ref=like.source_ref.model_copy(deep=True),
        fidelity_hash=hashlib.sha256(title.encode()).hexdigest(),
        identity_hash=_hash_identity_for_synthesized_node(node_id, like.source_ref),
        tags=[],
        mode=like.mode
        if like.mode in (WorkItemMode.BASELINE, WorkItemMode.SURVEY)
        else WorkItemMode.BASELINE,
        grounding_score=1.0 if like.grounding_score is not None else None,
    )


def _ensure_ladder_on(
    nodes: list[WorkItemNode],
    doc_title: str,
    warnings: list[IntegrityWarning],
    id_prefix: str = "",
    existing: dict[str, WorkItemNode] | None = None,
) -> None:
    """Makes the tree a valid Epic -> Feature -> Requirement ladder by adding only the missing parents; no existing
    node is retyped, renamed or dropped:
    - a Feature under a Requirement, or an Epic under a Feature or Requirement, moves up to its nearest valid ancestor;
    - a Requirement directly under an Epic goes under a Feature titled like that Epic (one per Epic);
    - a Feature or Requirement with no parent goes under one Epic titled from the document name (its loose
      Requirements under a Feature with that same title), so only Epics are ever roots.
    Idempotent. Mutates `nodes` in place; new nodes are appended at the end (like every other synthesized node), and
    consumers link by local_id, so list order carries no meaning. A synthetic node that already exists (from an earlier
    run, possibly outside `nodes`: see `existing`) is reused, never created a second time under the same id."""
    if not nodes:
        return
    by_id = {n.local_id: n for n in nodes}
    known = {**(existing or {}), **by_id}

    def valid_ancestor(node: WorkItemNode) -> str | None:
        parent = by_id.get(node.parent_local_id) if node.parent_local_id else None
        seen: set[str] = {node.local_id}
        while (
            parent is not None
            and parent.type not in _VALID_PARENT[node.type]
            and parent.local_id not in seen
        ):
            seen.add(parent.local_id)
            parent = by_id.get(parent.parent_local_id) if parent.parent_local_id else None
        return (
            parent.local_id
            if parent is not None and parent.type in _VALID_PARENT[node.type]
            else None
        )

    for n in nodes:
        parent = by_id.get(n.parent_local_id) if n.parent_local_id else None
        if parent is None or parent.type in _VALID_PARENT[n.type]:
            continue
        if n.type == R and parent.type == E:
            continue  # handled below: grouped under a same-title Feature
        n.parent_local_id = valid_ancestor(n)

    new_nodes: list[WorkItemNode] = []

    def add(node: WorkItemNode) -> None:
        by_id[node.local_id] = node
        new_nodes.append(node)

    for epic in [n for n in nodes if n.type == E]:
        direct = [n for n in nodes if n.type == R and n.parent_local_id == epic.local_id]
        if not direct:
            continue
        bridge_id = f"{id_prefix}synth_feature_{epic.local_id}"
        bridge = known.get(bridge_id)
        if bridge is None:
            bridge = _synthetic(bridge_id, F, epic.local_id, epic.title, epic)
            add(bridge)
            known[bridge_id] = bridge
        for n in direct:
            n.parent_local_id = bridge_id
        warnings.append(
            IntegrityWarning.make(
                WarningKind.BRIDGE_FEATURE_SYNTHESIZED,
                f"'{epic.title}' had Requirements directly under it; they were grouped under a Feature titled like "
                "the Epic, structure only, no content invented.",
                node_ids=[bridge_id, *(n.local_id for n in direct)],
                detail={"epicId": epic.local_id, "featureId": bridge_id},
            )
        )

    orphans = [
        n for n in nodes if n.type != E and not (n.parent_local_id and n.parent_local_id in by_id)
    ]
    if orphans:
        first = orphans[0]
        epic_id = f"{id_prefix}synth_doc_epic"
        doc_epic = known.get(epic_id)
        if doc_epic is None:
            doc_epic = _synthetic(epic_id, E, None, doc_title, first)
            add(doc_epic)
            known[epic_id] = doc_epic
        loose = [n for n in orphans if n.type == R]
        for n in orphans:
            if n.type == F:
                n.parent_local_id = epic_id
        if loose:
            feature_id = f"{id_prefix}synth_feature_{epic_id}"
            if feature_id not in known:
                doc_feature = _synthetic(feature_id, F, epic_id, doc_title, first)
                add(doc_feature)
                known[feature_id] = doc_feature
            for n in loose:
                n.parent_local_id = feature_id
        warnings.append(
            IntegrityWarning.make(
                WarningKind.CATCHALL_EPIC_WRAP,
                f"{len(orphans)} top-level item(s) had no Epic above them; they were grouped under one Epic "
                "titled from the document name, structure only, no content invented.",
                node_ids=[epic_id, *(n.local_id for n in orphans)],
                detail={
                    "epicId": epic_id,
                    "featureIds": [n.local_id for n in orphans if n.type == F],
                },
            )
        )
    nodes.extend(new_nodes)
    from app.leveling.id_tree_builder import recompute_child_types

    recompute_child_types(nodes)


def ensure_ladder(
    nodes: list[WorkItemNode],
    doc_title: str,
    warnings: list[IntegrityWarning],
    id_prefix: str = "",
    scope: set[str] | None = None,
) -> None:
    """Applies `_ensure_ladder_on` to `nodes`, or only to the nodes whose local_id is in `scope` (which must include
    every ancestor of a scoped node, see `scope_with_ancestors`). Nodes outside the scope are left exactly as they
    were; new nodes are appended; child_type is recomputed for the whole list."""
    from app.leveling.id_tree_builder import recompute_child_types

    if scope is None:
        _ensure_ladder_on(nodes, doc_title, warnings, id_prefix)
        return
    scoped = [n for n in nodes if n.local_id in scope]
    _ensure_ladder_on(
        scoped, doc_title, warnings, id_prefix, existing={n.local_id: n for n in nodes}
    )
    nodes.extend(n for n in scoped if n.local_id not in scope)
    recompute_child_types(nodes)


def scope_with_ancestors(seed: list[WorkItemNode], all_nodes: list[WorkItemNode]) -> set[str]:
    """The ids of `seed` plus every ancestor of theirs in `all_nodes`: the scope SURVEY hands to `ensure_ladder`, so
    only the document's own structure (deterministic and BASELINE-adopted nodes), not model-authored nodes, is
    completed."""
    parent_of = {n.local_id: n.parent_local_id for n in all_nodes}
    scope: set[str] = set()
    for node in seed:
        current: str | None = node.local_id
        while current is not None and current not in scope and current in parent_of:
            scope.add(current)
            current = parent_of[current]
    return scope
