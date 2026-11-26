"""What a built tree must never be (owner rules after the wave 1 production probe, 2026-11-26), applied to every finished tree, BASELINE and
SURVEY alike, whatever built it:

- **R2, no empty items:** an Epic or Feature with no Requirement anywhere below it is judged by what the FILE says about it, not by what
  req2ado imports (owner, approach C, 2026-11-26):
  - an item the builder inferred from a heading: its own text is document context, kept in the description of the nearest item above it
    (owner: never drop it); at the top level it goes to the next top Epic when it comes before the requirements, and is left out and
    reported as back matter when it comes after them; a placeholder ("None.", "Not applicable.", "Reserved") or no content is left out
    and reported with its pages;
  - an item the file itself states (a tracker export's type column, a heading labelled "Feature:") with content -- its own description, or
    rows of types req2ado does not import, such as Test Cases -- is the file's own planned item: kept, with the review mark
    NO_REQUIREMENT so the reviewer can choose not to write it; one with nothing is left out.
- **R1, no parentless Feature or Requirement:** after the removals, the ladder is completed by hierarchy_rules.ensure_ladder (only Epics are
  roots), which reports every item it moved. Items a table states keep their stated place.
- **R6, titles fit Azure DevOps:** a title over 255 characters is shortened at a word with a "…" marker; its full text stays in the
  description. The model's own shorter title, when it writes one, replaces it later (/level).
"""

from __future__ import annotations

import re
from collections.abc import Callable

from app.distillation.description import assemble_description
from app.distillation.title import ADO_TITLE_LIMIT, shortened_title
from app.leveling.hierarchy_rules import ensure_ladder, scope_with_ancestors
from app.leveling.rule_builder import is_rule_built
from app.workitem.model import IntegrityWarning, WarningKind, WorkItemNode, WorkItemType

MAX_MARKER_WORDS = 6  # as document_grammar's: a section whose whole text is a few words with no obligation is a placeholder
_OBLIGATION = re.compile(r"\b(shall|must|should|will)\b", re.IGNORECASE)

LeftOut = tuple[str, int | None, int | None]
# The review mark on an item the file states and req2ado keeps although no requirement sits under it (approach C): never written.
NO_REQUIREMENT = "No requirement under it"


def is_marker(text: str) -> bool:
    words = text.split()
    return 0 < len(words) <= MAX_MARKER_WORDS and not _OBLIGATION.search(text)


def apply_tree_rules(
    nodes: list[WorkItemNode],
    warnings: list[IntegrityWarning],
    doc_title: str,
    rehash: Callable[[WorkItemNode], None],
) -> list[LeftOut]:
    """Applies R2, R1 and R6 to `nodes` in place; returns the sections R2 left out (heading, first page, last page) for the caller to report
    with the document's other left-out parts."""
    left_out = _without_empty_items(nodes, warnings, rehash, doc_title)
    # A stated item's type and parent are final (rule_builder): the ladder is completed around them, never by moving them.
    stated = {n.local_id for n in nodes if is_rule_built(n.local_id)}
    scope = scope_with_ancestors([n for n in nodes if n.local_id not in stated], nodes) - stated if stated else None
    ensure_ladder(nodes, doc_title, warnings, scope=scope)
    _titles_within_limit(nodes, rehash)
    return left_out


def _own_text(node: WorkItemNode) -> str:
    """The item's own text: its description, unless that only repeats its title."""
    text = node.description.strip()
    return "" if " ".join(text.split()).casefold() == " ".join(node.title.split()).casefold() else text


def _without_empty_items(nodes: list[WorkItemNode], warnings: list[IntegrityWarning], rehash, doc_title: str) -> list[LeftOut]:  # noqa: ANN001
    by_id = {n.local_id: n for n in nodes}

    def ancestors(node: WorkItemNode):  # noqa: ANN202
        parent = by_id.get(node.parent_local_id or "")
        seen: set[str] = set()
        while parent is not None and parent.local_id not in seen:
            seen.add(parent.local_id)
            yield parent
            parent = by_id.get(parent.parent_local_id or "")

    containers = [n for n in nodes if n.type != WorkItemType.REQUIREMENT]
    holds_requirement = {a.local_id for n in nodes if n.type == WorkItemType.REQUIREMENT for a in ancestors(n)}
    planned = {
        n.local_id
        for n in containers
        # Any text of its own counts: a tracker's Description field is not judged by length, unlike a document section's body.
        if n.local_id not in holds_requirement and n.type_stated and (n.unimported_children or _own_text(n))
    }
    # An item that holds a kept planned item is not empty either.
    kept = holds_requirement | planned | {a.local_id for i in planned for a in ancestors(by_id[i])}
    for n in containers:
        if n.local_id in kept and n.local_id not in holds_requirement and NO_REQUIREMENT not in n.derived_marks:
            n.derived_marks = [*n.derived_marks, NO_REQUIREMENT]
    empty = [n for n in containers if n.local_id not in kept]
    if not empty:
        return []
    removed = {n.local_id for n in empty}
    order = {n.local_id: i for i, n in enumerate(nodes)}
    first_requirement = min((order[n.local_id] for n in nodes if n.type == WorkItemType.REQUIREMENT), default=len(nodes))

    def target_for(node: WorkItemNode) -> WorkItemNode | None:
        """Where the item's text goes: the nearest item kept above it; at the top level, the next top Epic when the text comes before
        the requirements; None (left out and reported as back matter) when it comes after them."""
        above = next((a for a in ancestors(node) if a.local_id not in removed), None)
        if above is not None:
            return above
        if order[node.local_id] > first_requirement:
            return None
        return next(
            (n for n in nodes[order[node.local_id] + 1 :] if n.parent_local_id is None and n.local_id not in removed and n.type == WorkItemType.EPIC),
            None,
        )

    left_out: list[LeftOut] = []
    context: list[str] = []
    for node in empty:  # document order: an area's text comes before its sub-areas'
        text = _own_text(node)
        has_children = any(c.parent_local_id == node.local_id for c in empty)
        target = target_for(node)
        # Only a section with nothing under it is a placeholder ("None."); an area's short lead-in is context, kept (owner, 2026-11-26).
        if text and not (is_marker(text) and not has_children) and target is not None:
            target.description = assemble_description(target.description, text) if target.description else text
            rehash(target)
            context.append(node.source_title or node.title)
        elif node.title == doc_title and not text:
            continue  # an item the builder named after the document to hold others: not a section of the file
        elif text or not has_children:
            # A placeholder, back matter, or a section with no text and nothing under it; an empty area above other empty areas is not
            # listed twice.
            ref = node.source_ref
            left_out.append((node.source_title or node.title, ref.page if ref else None, getattr(ref, "page_end", None) if ref else None))
    nodes[:] = [n for n in nodes if n.local_id not in removed]
    if context:
        names = "; ".join(f'"{t}"' for t in context[:10]) + (" ..." if len(context) > 10 else "")
        warnings.append(
            IntegrityWarning.make(
                WarningKind.INFORMATIONAL_SECTION_FOLDED,
                f"Held no requirement, so its text was kept in the parent item's description, not made an item: {names}.",
                node_ids=[],
                detail={"sections": context},
            )
        )
    return left_out


def _titles_within_limit(nodes: list[WorkItemNode], rehash) -> None:  # noqa: ANN001
    for node in nodes:
        if len(" ".join(node.title.split())) <= ADO_TITLE_LIMIT:
            continue
        full = " ".join(node.title.split())
        node.title = shortened_title(full)
        if full not in " ".join(node.description.split()):
            node.description = assemble_description(full, node.description) if node.description else full
            rehash(node)
