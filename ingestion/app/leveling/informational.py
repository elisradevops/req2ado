"""A section that describes the document, not the system ("1.1 Scope -- This specification defines the requirements of the unit"),
is not a requirement.

The structure step made every leaf section a Requirement, so a Scope or Purpose paragraph became one, and SURVEY then rewrote it as
"The system shall define the requirements of ...": an obligation the document never states (owner example, 2026-11-24). Here such a
leaf is folded into its parent's description instead: its text is kept word for word, it is never an item, and the fold is reported
once.

Deliberately narrow, because a real requirement need not say "shall" (a Hebrew requirement is often a plain future tense): a section
is informational only when its TITLE is a context title (Introduction, Scope, Purpose, ...) AND its text states no obligation and no
requirement code. A section with any other title is never judged by its wording."""

from __future__ import annotations

import re

from app.distillation.description import assemble_description
from app.leveling.customer_id import leading_requirement_code
from app.leveling.numbering import parse_numbering
from app.workitem.model import IntegrityWarning, WarningKind, WorkItemNode, WorkItemType

# Titles of sections that set context for the requirements rather than state them, in English and Hebrew.
_CONTEXT_TITLES = frozenset(
    {
        "introduction",
        "scope",
        "purpose",
        "overview",
        "general",
        "background",
        "summary",
        "definitions",
        "glossary",
        "references",
        "applicable documents",
        "reference documents",
        "document overview",
        "system overview",
        "מבוא",
        "היקף",
        "מטרה",
        "מטרת המסמך",
        "כללי",
        "רקע",
        "סקירה",
        "הגדרות",
        "מסמכים ישימים",
        "מסמכים מצוטטים",
        "תמצית",
    }
)
# An obligation, in English and Hebrew ("חייב", "נדרש", "יש ל..."), and words that state a requirement outright.
_OBLIGATION = re.compile(
    r"\b(shall|must|will|should|required to|is required)\b|חייב|נדרש|יש ל|דרישה", re.IGNORECASE
)


def _bare_title(title: str) -> str:
    label, rest = parse_numbering(title)
    text = rest if label is not None else title
    return " ".join(re.sub(r"[^\w\s]", " ", text).split()).casefold()


def is_informational(title: str, text: str) -> bool:
    """A section that only describes the document: a context title, and no obligation or requirement code in its text."""
    if _bare_title(title) not in _CONTEXT_TITLES:
        return False
    body = " ".join(text.split())
    if leading_requirement_code(body)[0] is not None or any(
        leading_requirement_code(line)[0] for line in text.splitlines()
    ):
        return False
    return not _OBLIGATION.search(body)


def fold_informational_sections(nodes: list[WorkItemNode], rehash) -> IntegrityWarning | None:  # noqa: ANN001
    """Folds every informational leaf Requirement into its parent's description (in place) and returns one warning naming them, or None.
    `rehash(node)` recomputes a node's hashes after its description changed. A root, or a node with children, is never folded."""
    by_id = {n.local_id: n for n in nodes}
    has_children = {n.parent_local_id for n in nodes if n.parent_local_id}
    folded: list[WorkItemNode] = []
    for node in nodes:
        parent = by_id.get(node.parent_local_id) if node.parent_local_id else None
        if (
            node.type == WorkItemType.REQUIREMENT
            and parent is not None
            and node.local_id not in has_children
            and is_informational(node.title, node.description)
        ):
            parent.description = assemble_description(
                parent.description, f"{node.title}\n\n{node.description}".strip()
            )
            rehash(parent)
            folded.append(node)
    if not folded:
        return None
    gone = {n.local_id for n in folded}
    nodes[:] = [n for n in nodes if n.local_id not in gone]
    names = "; ".join(f'"{n.title}"' for n in folded[:10]) + (" ..." if len(folded) > 10 else "")
    return IntegrityWarning.make(
        WarningKind.INFORMATIONAL_SECTION_FOLDED,
        f"Described the document rather than stating a requirement, so kept in the parent item's description, not made a Requirement: {names}.",
        node_ids=sorted({n.parent_local_id for n in folded if n.parent_local_id}),
        detail={"sections": [n.title for n in folded]},
    )
