"""Builds work items from the rule a table states (app.study.file_rules): the type, the parent and the fields of each row come from the file.

Nothing here decides a type or a parent by shape. A row is an item of the type the file gives it, under the parent the file gives it; a row of a type
the ladder does not have (a Test Case) is not imported and is counted in a warning, never silently dropped or retyped. Descriptions are the
Markdown of the description cells (HTML in a cell becomes bold, lists and paragraphs), word for word otherwise."""

from __future__ import annotations

import re
from collections import Counter

from app.canonical.markup import html_to_markdown
from app.canonical.model import CanonicalDoc, Table, plain_text_rows
from app.study.file_rules import TableRule, clip_detail
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
# The skipped rows a warning's sentence names; its detail lists all of them.
_NAMED_ROWS = 100


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
    return nodes, _warnings(table, rule, id_of)


def _warnings(table: Table, rule: TableRule, id_of: dict[int, str]) -> list[IntegrityWarning]:
    out: list[IntegrityWarning] = []
    caption = table.caption or f"Table {table.id}"
    skipped = rule.skipped_counts()
    for reason, count in sorted(skipped.items()):
        if reason.startswith("type:"):
            kind_name = reason[5:]
            # Row numbers count the heading row as 1, as the sheet does (file_rules.table_details).
            rows = [{"row": p.row + 1, "title": clip_detail(p.title)} for p in rule.rows if p.skipped == reason]
            named = "; ".join(f"row {r['row']} '{r['title']}'" for r in rows[:_NAMED_ROWS]) + (
                f"; and {len(rows) - _NAMED_ROWS} more" if len(rows) > _NAMED_ROWS else ""
            )
            out.append(
                IntegrityWarning.make(
                    WarningKind.SOURCE_TYPE_SKIPPED,
                    f"{count} row(s) of type '{kind_name}' in '{caption}' were not imported: only Epic, Feature and Requirement are work item "
                    f"types of this ladder. Nothing was retyped; add them by hand if they are wanted. The rows: {named}.",
                    detail={"type": kind_name, "count": count, "source": caption, "rows": rows},
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
    unread = _unread_columns(table, rule)
    if unread:
        out.append(
            IntegrityWarning.make(
                WarningKind.COLUMNS_NOT_IMPORTED,
                f"{len(unread)} column(s) of '{caption}' were not imported: {', '.join(unread)}. Only the type, title, nesting, Customer ID "
                "and Description columns are read; the values of these columns are in no work item.",
                detail={"source": caption, "columns": unread, "count": len(unread)},
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
                node_ids=[id_of[position] for position, _ in rule.ladder_violations],
                # One entry per item; a SURVEY hierarchy check (app.leveling.hierarchy_check) fills in the suggested fix and its reason.
                detail={
                    "count": len(rule.violations),
                    "source": caption,
                    "items": [
                        {"id": id_of[position], "problem": problem, "suggestion": None, "reason": ""}
                        for position, problem in rule.ladder_violations
                    ],
                },
            )
        )
    return out


def _unread_columns(table: Table, rule: TableRule) -> list[str]:
    """The labels of the columns the rule gives no role that hold a value in at least one imported row, in column order. A column that is
    empty on every imported row (an export's blank ID or Parent, a Test Case's steps) carries nothing into the items, so it is not named."""
    read = {rule.type_col, rule.level_col, rule.title_col, rule.id_col, rule.parent_col, rule.customer_id_col}
    read |= set(rule.level_cols) | set(rule.description_cols)
    grid = plain_text_rows(table)
    rows = [grid[plan.row] for plan in rule.kept if plan.row < len(grid)]
    return [
        label
        for col, label in enumerate(rule.labels)
        if label and col not in read and any(col < len(row) and row[col].strip() for row in rows)
    ]


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
    by_id = {n.local_id: n for n in tree.nodes}
    wrong: list[str] = []
    for index, table in enumerate(doc.tables):
        rule = rules.get(table.id)
        if rule is None:
            continue
        # Each stated row is found by the id tree_from_table_rules gave it (build_table_nodes: r<table index>_<kept index>), never by its title,
        # so two rows with one title cannot stand in for each other. A stated root must still be a root.
        kept = [p for p, plan in enumerate(rule.rows) if plan.skipped is None and plan.type is not None]
        id_of = {position: f"r{index}_{k}" for k, position in enumerate(kept)}
        for position, node_id in id_of.items():
            plan = rule.rows[position]
            node = by_id.get(node_id)
            expected_parent = id_of.get(plan.parent) if plan.parent is not None else None
            if node is None:
                wrong.append(f"{plan.type} '{plan.title[:60]}' (missing)")
            elif node.type.value != plan.type or node.parent_local_id != expected_parent:
                wrong.append(f"{plan.type} '{plan.title[:60]}' (has another type or parent)")
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

