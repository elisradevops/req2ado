"""With AI review's wording suggestions for the items a document's grammar built (app.leveling.document_grammar). Never applied.

Owner decisions (2026-11-25): every AI wording change is a suggestion the reviewer accepts, never applied by itself; an Epic or Feature
with no text of its own in the file has an empty description, and With AI review offers a summary of the items under it; a requirement
gets a wording suggestion only when the review's score marks it weak or it carries a quality issue. The item keeps the document's words;
the suggestion travels beside it (`WorkItemNode.description_suggestion`) for the reviewer to accept, discuss or reject.

Code keeps a suggestion only when it is safe to offer:
  * a summary: grounded in the requirements under the item (SUGGESTION_GROUNDING_FLOOR of its words are theirs), and not its title again;
  * a rewrite: different from the requirement, grounded in it, adds no obligation the requirement does not state, and loses nothing
    (no number or identifier dropped, not several statements, not far longer: app.chat.rewrite_check's "high" warnings). The trace
    under the requirement is kept as it is.

Fail-open: a failed call leaves the items without suggestions, with one warning per failed chunk."""

from __future__ import annotations

import re
from typing import Protocol

from app.chat.rewrite_check import check_rewrite
from app.leveling.bounded_chunks import run_chunks_bounded
from app.leveling.document_grammar import invents_obligation
from app.leveling.grounding import grounding_score
from app.workitem.model import IntegrityWarning, WarningKind, WorkItemNode, WorkItemType

# The review screen flags an item at 0.2 grounding as worth a look; something offered for a reviewer to accept must be held higher.
SUGGESTION_GROUNDING_FLOOR = 0.5
# The score below which the review calls a requirement weak (LOW_QUALITY_THRESHOLD in the frontend's diffFlagging.ts).
WEAK_SCORE = 50
CHUNK_SIZE = 60


class SuggestionClient(Protocol):
    def summarize_parent_nodes(self, nodes_by_id: dict[str, dict], user_id: str | None = None) -> dict[str, dict]: ...

    def synthesize_leaf_requirements(self, items_by_id: dict[str, dict], user_id: str | None = None) -> dict[str, dict]: ...


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().casefold()


def checked_summary(text: object, title: str, requirement_texts: list[str]) -> str | None:
    if not isinstance(text, str) or not text.strip():
        return None
    summary = " ".join(text.split())
    if _norm(summary) == _norm(title) or grounding_score(summary, "\n".join(requirement_texts)) < SUGGESTION_GROUNDING_FLOOR:
        return None
    return summary


def checked_rewrite(text: object, statement: str) -> str | None:
    if not isinstance(text, str) or not text.strip():
        return None
    rewrite = text.strip()
    if _norm(rewrite) == _norm(statement) or invents_obligation(rewrite, statement):
        return None
    if grounding_score(rewrite, statement) < SUGGESTION_GROUNDING_FLOOR:
        return None
    if any(w.get("severity") == "high" for w in check_rewrite(None, statement, None, rewrite)):
        return None
    return rewrite


def _is_weak(node: WorkItemNode) -> bool:
    return (node.quality_score is not None and node.quality_score < WEAK_SCORE) or bool(node.quality_issues)


def _run(payloads: list[dict], call, warnings: list[IntegrityWarning], pass_name: str, what: str):  # noqa: ANN001, ANN202
    """(payload, its answer) for every chunk, in chunk order; a failed chunk is reported once and answers {}."""
    for payload, outcome in zip(payloads, run_chunks_bounded(payloads, call, 1)):
        if outcome.error is not None or not isinstance(outcome.value, dict):
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.ENHANCEMENT_CALL_FAILED,
                    f"{what} could not be suggested for {len(payload)} item(s); they keep the document's words with no suggestion.",
                    node_ids=list(payload),
                    detail={"pass": pass_name},
                )
            )
            yield payload, {}
            continue
        yield payload, outcome.value


def write_suggestions(
    nodes: list[WorkItemNode], client: SuggestionClient, warnings: list[IntegrityWarning], user_id: str | None = None
) -> tuple[int, int]:
    """Sets `description_suggestion` on the grammar-built items it is safe to offer one for; returns (summaries, rewrites)."""
    by_id = {n.local_id: n for n in nodes}
    children: dict[str, list[WorkItemNode]] = {}
    for n in nodes:
        if n.parent_local_id:
            children.setdefault(n.parent_local_id, []).append(n)

    def requirements_under(node: WorkItemNode) -> list[WorkItemNode]:
        out: list[WorkItemNode] = []
        for child in children.get(node.local_id, []):
            out += ([child] if child.type == WorkItemType.REQUIREMENT else []) + requirements_under(child)
        return out

    def path(node: WorkItemNode) -> str:
        chain = []
        parent = by_id.get(node.parent_local_id or "")
        while parent is not None:
            chain.append(parent.title)
            parent = by_id.get(parent.parent_local_id or "")
        return " > ".join(reversed(chain))

    summaries = 0
    containers = [
        n for n in nodes if n.verbatim and n.type != WorkItemType.REQUIREMENT and not n.description.strip() and requirements_under(n)
    ]
    payloads = []
    for i in range(0, len(containers), CHUNK_SIZE):
        payloads.append(
            {
                n.local_id: {
                    "title": n.title,
                    "requirement_titles": [r.title for r in requirements_under(n)],
                    "requirement_descriptions": [r.description.split("\n\n", 1)[0] for r in requirements_under(n)],
                }
                for n in containers[i : i + CHUNK_SIZE]
            }
        )
    call = lambda payload: client.summarize_parent_nodes(payload, user_id=user_id)  # noqa: E731
    for payload, answer in _run(payloads, call, warnings, "summary_suggestions", "A summary"):
        for node_id, item in payload.items():
            entry = answer.get(node_id)
            summary = checked_summary(entry.get("description") if isinstance(entry, dict) else None, item["title"], item["requirement_descriptions"])
            if summary is not None:
                by_id[node_id].description_suggestion = summary
                summaries += 1

    rewrites = 0
    weak = [n for n in nodes if n.verbatim and n.type == WorkItemType.REQUIREMENT and _is_weak(n)]
    payloads = [
        {n.local_id: {"text": n.description.split("\n\n", 1)[0], "context": path(n)} for n in weak[i : i + CHUNK_SIZE]}
        for i in range(0, len(weak), CHUNK_SIZE)
    ]
    call = lambda payload: client.synthesize_leaf_requirements(payload, user_id=user_id)  # noqa: E731
    for payload, answer in _run(payloads, call, warnings, "wording_suggestions", "A wording change"):
        for node_id, item in payload.items():
            entry = answer.get(node_id)
            rewrite = checked_rewrite(entry.get("text") if isinstance(entry, dict) else None, item["text"])
            if rewrite is not None:
                node = by_id[node_id]
                trace = node.description.split("\n\n", 1)[1] if "\n\n" in node.description else ""
                node.description_suggestion = f"{rewrite}\n\n{trace}" if trace else rewrite
                rewrites += 1
    return summaries, rewrites
