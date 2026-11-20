"""Builds work items from the rule a table states (app.study.file_rules): the type, the parent and the fields of each row come from the file.

Nothing here decides a type or a parent by shape. A row is an item of the type the file gives it, under the parent the file gives it; a row of a type
the ladder does not have (a Test Case) is not imported and is counted in a warning, never silently dropped or retyped. Descriptions are the
Markdown of the description cells (HTML in a cell becomes bold, lists and paragraphs), word for word otherwise."""

from __future__ import annotations

import re
from collections import Counter

from app.canonical.markup import html_to_markdown
from app.canonical.model import CanonicalDoc, Table, plain_text_rows
from app.study.file_rules import TableRule
from app.workitem.model import (
    IntegrityWarning,
    WarningKind,
    WorkItemMode,
    WorkItemNode,
    WorkItemType,
)

_TYPE = {
    "Epic": WorkItemType.EPIC,
    "Feature": WorkItemType.FEATURE,
    "Requirement": WorkItemType.REQUIREMENT,
}
_CHILD_TYPE = {
    WorkItemType.EPIC: WorkItemType.FEATURE,
    WorkItemType.FEATURE: WorkItemType.REQUIREMENT,
    WorkItemType.REQUIREMENT: WorkItemType.REQUIREMENT,
}
_MAX_TITLE = 256
# The ids tree_from_table_rules gives (r<table index>_<item index>); no other builder's ids have this shape.
_RULE_ID = re.compile(r"r\d+_\d+")


def _label(header: str) -> str:
    """A column heading as a section label: the 'HTML' a tracker puts on a rich-text field's name is not part of what it is called."""
    return re.sub(r"\s+HTML$", "", header.strip(), flags=re.IGNORECASE)


def _description(rule: TableRule, row: list[str], title: str) -> str:
    parts: list[str] = []
    for position, col in enumerate(rule.description_cols):
        value = html_to_markdown(row[col].strip())
        if not value:
            continue
        # A single description column is the description itself, whatever its heading says (a Hebrew "תיאור" too); with several, each is
        # labelled, except a first one that is named as the description.
        primary = len(rule.description_cols) == 1 or position == 0 and re.sub(r"\s+", " ", rule.labels[col].strip().lower()) in {
            "description",
            "desc",
            "details",
        }
        parts.append(value if primary else f"**{_label(rule.labels[col])}:**\n\n{value}")
    return "\n\n".join(parts) or title


def build_table_nodes(
    table: Table, rule: TableRule, id_prefix: str, hash_description, hash_identity
) -> tuple[list[WorkItemNode], list[IntegrityWarning]]:
    """The items of `table` as its rule states them, and the warnings about what was not imported or does not fit the ladder.
    `hash_description(text)` and `hash_identity(discriminator, source_ref)` are tree_builder's own hashes, passed in so a rule-built node is
    hashed exactly like any other BASELINE node."""
    grid = plain_text_rows(table)
    width = max((len(r) for r in grid), default=0)
    padded = {i: r + [""] * (width - len(r)) for i, r in enumerate(grid)}
    # Ids are given in row order first, then parents are linked: with ID/Parent nesting a parent may come after its child in the file.
    kept = [position for position, plan in enumerate(rule.rows) if plan.skipped is None and plan.type is not None]
    id_of = {position: f"{id_prefix}{index}" for index, position in enumerate(kept)}
    path_of: dict[int, list[str]] = {}  # RowPlan position -> the titles above it, outermost first

    def section_path(position: int) -> list[str]:
        # Walked iteratively and remembered, so a deep chain listed child-first is not recursed into.
        chain: list[int] = []
        current = position
        while current not in path_of:
            parent = rule.rows[current].parent
            if parent is None or parent not in id_of:
                path_of[current] = []
                break
            chain.append(current)
            current = parent
        for link in reversed(chain):
            parent = rule.rows[link].parent
            path_of[link] = [*path_of[parent], rule.rows[parent].title[:_MAX_TITLE]]
        return path_of[position]

    nodes: list[WorkItemNode] = []
    for position in kept:
        plan = rule.rows[position]
        row = padded[plan.row]
        parent_id = id_of.get(plan.parent) if plan.parent is not None else None
        node_type = _TYPE[plan.type]
        description = _description(rule, row, plan.title)
        source_ref = table.source_ref.model_copy(update={"section_path": section_path(position)})
        customer_id = row[rule.customer_id_col].strip() if rule.customer_id_col is not None else ""
        node = WorkItemNode(
            local_id=id_of[position],
            type=node_type,
            parent_local_id=parent_id,
            title=plan.title[:_MAX_TITLE],
            source_title=plan.title[:_MAX_TITLE],
            description=description,
            customer_id=customer_id or None if node_type == WorkItemType.REQUIREMENT else None,
            source_ref=source_ref,
            fidelity_hash=hash_description(description),
            identity_hash=hash_identity(f"{table.id}:row{plan.row}", table.source_ref),
            tags=[],
            mode=WorkItemMode.BASELINE,
            child_type=_CHILD_TYPE[node_type],
        )
        nodes.append(node)
    return nodes, _warnings(table, rule)


def _warnings(table: Table, rule: TableRule) -> list[IntegrityWarning]:
    out: list[IntegrityWarning] = []
    caption = table.caption or f"Table {table.id}"
    skipped = rule.skipped_counts()
    for reason, count in sorted(skipped.items()):
        if reason.startswith("type:"):
            kind_name = reason[5:]
            out.append(
                IntegrityWarning.make(
                    WarningKind.SOURCE_TYPE_SKIPPED,
                    f"{count} row(s) of type '{kind_name}' in '{caption}' were not imported: only Epic, Feature and Requirement are work item "
                    "types of this ladder. Nothing was retyped; add them by hand if they are wanted.",
                    detail={"type": kind_name, "count": count, "source": caption},
                )
            )
        elif reason == "under_skipped":
            out.append(
                IntegrityWarning.make(
                    WarningKind.SOURCE_TYPE_SKIPPED,
                    f"{count} row(s) in '{caption}' sit under a row that was not imported, so they were not imported either.",
                    detail={"reason": reason, "count": count, "source": caption},
                )
            )
        elif reason == "in_cycle":
            out.append(
                IntegrityWarning.make(
                    WarningKind.SOURCE_TYPE_SKIPPED,
                    f"{count} row(s) in '{caption}' were not imported: their parents form a cycle (each is, through its parents, its own "
                    "ancestor), so none of them has a place in the tree.",
                    detail={"reason": reason, "count": count, "source": caption},
                )
            )
        elif reason in ("no_title", "no_type"):
            what = (
                "has no title"
                if reason == "no_title"
                else "states no type and none could be learned from its level"
            )
            out.append(
                IntegrityWarning.make(
                    WarningKind.SOURCE_TYPE_SKIPPED,
                    f"{count} row(s) in '{caption}' were not imported: the row {what}.",
                    detail={"reason": reason, "count": count, "source": caption},
                )
            )
    if rule.violations:
        shown = "; ".join(rule.violations[:5]) + (
            f"; and {len(rule.violations) - 5} more" if len(rule.violations) > 5 else ""
        )
        out.append(
            IntegrityWarning.make(
                WarningKind.SOURCE_STRUCTURE_VIOLATION,
                f"'{caption}' states a structure the Epic > Feature > Requirement ladder does not allow, kept as the file states it: {shown}.",
                detail={"count": len(rule.violations), "source": caption},
            )
        )
    return out


def type_counts(nodes: list[WorkItemNode]) -> Counter:
    return Counter(n.type.value for n in nodes)


def tree_from_table_rules(
    doc: CanonicalDoc, rules: dict[str, TableRule], hash_description, hash_identity
) -> tuple[list[WorkItemNode], list[IntegrityWarning]]:
    """Every rule-covered table of `doc` as nodes, in table order; ids are unique across tables."""
    nodes: list[WorkItemNode] = []
    warnings: list[IntegrityWarning] = []
    for index, table in enumerate(doc.tables):
        rule = rules.get(table.id)
        if rule is None:
            continue
        built, notes = build_table_nodes(table, rule, f"r{index}_", hash_description, hash_identity)
        nodes += built
        warnings += notes
    return nodes, warnings


def is_rule_built(local_id: str) -> bool:
    """Whether a node is one tree_from_table_rules built: its type and parent are what the file states, so no repair pass may change them."""
    return _RULE_ID.fullmatch(local_id) is not None


def verify_tree_against_rules(doc: CanonicalDoc, tree, rules: dict[str, TableRule] | None = None) -> list[IntegrityWarning]:
    """Checks a finished tree against what the file states: every item a rule covers must be in the tree with the type the file gives it, under the
    parent the file gives it. Returns one warning naming the items that are not (none when all are). Nothing is changed: no pass is meant to
    break a stated item, and this is how one that does is seen. `rules` are the rules to check against (default: the ones the code's own header
    detectors read from the tables)."""
    from app.leveling.tree_builder import _is_unsupported_content_note
    from app.study.file_rules import study_tables

    if any(not _is_unsupported_content_note(b) for b in doc.blocks):
        return []
    rules = study_tables(doc) if rules is None else rules
    if not rules:
        return []
    by_title: dict[str, list[WorkItemNode]] = {}
    for node in tree.nodes:
        by_title.setdefault((node.source_title or node.title).strip(), []).append(node)
    by_id = {n.local_id: n for n in tree.nodes}
    wrong: list[str] = []
    for rule in rules.values():
        for plan in rule.kept:
            parent_title = rule.rows[plan.parent].title[:_MAX_TITLE] if plan.parent is not None else None
            candidates = by_title.get(plan.title[:_MAX_TITLE], [])
            found = any(
                c.type.value == plan.type
                and (parent_title is None or _title_of(by_id.get(c.parent_local_id)) == parent_title)
                for c in candidates
            )
            if not found:
                state = "missing" if not candidates else "has another type or parent"
                wrong.append(f"{plan.type} '{plan.title[:60]}' ({state})")
    if not wrong:
        return []
    shown = "; ".join(wrong[:5]) + (f"; and {len(wrong) - 5} more" if len(wrong) > 5 else "")
    return [
        IntegrityWarning.make(
            WarningKind.RULEBOOK_MISMATCH,
            f"{len(wrong)} item(s) differ from what the file states: {shown}.",
            detail={"count": len(wrong)},
        )
    ]


def _title_of(node: WorkItemNode | None) -> str | None:
    return (node.source_title or node.title).strip() if node is not None else None
