"""What the new-job page shows about a studied file (the approved mockup, 2026-11-25): the verdict, the decisions, the automatic fixes, what
was left out, and the Epics and Features the job will build -- read off the same deterministic build the job runs, with no model call.

The outline is built with every proposal undecided (the file's original); the page applies the user's Accept / Keep to it as they decide, and
the job applies the stored decisions for real. Display only: not part of the rulebook, its hash or prestudy_version()."""

from __future__ import annotations

from app.canonical.model import CanonicalDoc
from app.study.rulebook import DocumentRules, FileRulebook
from app.workitem.model import WorkItemType

MAX_OUTLINE = 400  # Epics and Features shown; a larger file is cut, and `outlineMore` says by how many
MAX_LISTED = 40


def heading_id_of(local_id: str) -> str | None:
    """The heading block an item of the document's grammar was built from: its local id is "g_" + that block's id
    (app.leveling.document_grammar). None for an item another path built, or the document's own Epic."""
    return local_id[2:] if local_id.startswith("g_") and local_id != "g_epic" else None


def file_reading(doc: CanonicalDoc, rulebook: FileRulebook) -> dict | None:
    """None when the file has no document rules to read it by (a spreadsheet: its tables say how it reads)."""
    from app.leveling.tree_builder import build_baseline_tree
    from app.study.model_rules import document_headings

    document: DocumentRules | None = rulebook.document
    if document is None:
        return None
    undecided = FileRulebook(tables=rulebook.tables, document=DocumentRules(**{**document.__dict__, "proposal_decisions": ()}))
    tree = build_baseline_tree(doc, undecided)
    nodes = tree.nodes
    children: dict[str, list] = {}
    for n in nodes:
        if n.parent_local_id:
            children.setdefault(n.parent_local_id, []).append(n)

    def requirements_under(local_id: str) -> int:
        return sum((c.type == WorkItemType.REQUIREMENT) + requirements_under(c.local_id) for c in children.get(local_id, []))

    groups = [n for n in nodes if n.type != WorkItemType.REQUIREMENT]
    outline = [
        {
            "id": n.local_id,
            "parent": n.parent_local_id,
            "type": n.type.value,
            "title": n.title,
            "headingId": heading_id_of(n.local_id),
            "requirements": requirements_under(n.local_id),
        }
        for n in groups[:MAX_OUTLINE]
    ]
    requirements = [n for n in nodes if n.type == WorkItemType.REQUIREMENT]
    heading_text = {h["block_id"]: h["text"] for h in document_headings(doc)}
    title_of = {o["headingId"]: o["title"] for o in outline if o["headingId"]}
    decided = dict(document.proposal_decisions)
    left_out = next((w for w in tree.warnings if w.kind.value == "front_matter_left_out"), None)
    context = next((w for w in tree.warnings if w.kind.value == "informational_section_folded"), None)
    return {
        "kind": document.document_kind,
        "coverTitle": document.cover_title,
        "requirements": len(requirements),
        "withIds": sum(1 for n in requirements if n.customer_id),
        "epics": sum(1 for n in nodes if n.type == WorkItemType.EPIC),
        "features": sum(1 for n in nodes if n.type == WorkItemType.FEATURE),
        "outline": outline,
        "outlineMore": max(0, len(groups) - MAX_OUTLINE),
        "decisions": [
            {
                "headingId": p.block_id,
                "action": p.action,
                "title": title_of.get(p.block_id) or heading_text.get(p.block_id, ""),
                "newTitle": p.new_title,
                "reason": p.reason,
                "decision": decided.get(p.block_id),
            }
            for p in document.proposals
        ],
        "fixes": [{"headingId": b, "from": heading_text.get(b, ""), "to": fixed} for b, fixed in document.spelling_fixes],
        # A few requirements as the job will build them (the first coded ones, and a coded sub-item when there is one): what a requirement,
        # its code and its place look like in this file.
        "examples": _examples(nodes),
        "leftOut": (left_out.detail.get("parts", []) if left_out else [])[:MAX_LISTED],
        "context": (context.detail.get("sections", []) if context else [])[:MAX_LISTED],
    }


def _examples(nodes: list) -> list[dict]:
    by_id = {n.local_id: n for n in nodes}
    coded = [n for n in nodes if n.type == WorkItemType.REQUIREMENT and n.customer_id]
    sub = [n for n in coded if (parent := by_id.get(n.parent_local_id or "")) is not None and parent.type == WorkItemType.REQUIREMENT]
    chosen = coded[:2] + sub[:1] if sub else coded[:3]
    return [
        {"customerId": n.customer_id, "title": n.title, "under": by_id[n.parent_local_id].title if n.parent_local_id in by_id else None}
        for n in chosen
    ]
