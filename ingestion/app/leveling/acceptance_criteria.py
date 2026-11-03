"""Proposes acceptance criteria for SURVEY requirements the scorer flagged as lacking them (review finding R6).

Only requirements flagged missing_acceptance_criteria / not_testable are eligible, and never ones flagged as placeholders, open items,
fragments or non-requirements: those lack a value or a statement, and a model asked for criteria would invent numbers. A requirement whose
text carries an unmistakable unresolved-value marker (TBD, TBC, TBS, TBR, TBA, or a run of XXX, ??, ___, ***), found by code in that text
whatever the study listed, gets a "needs author input" note instead, with no model call; any other marker of the document (see document_study) ("N", "shall", an acronym like "DC") is too ambiguous to skip the model on, so it is passed to the model as
document_conventions.unresolved_markers and the model decides. Everything else is sent, in bounded chunks, with its hierarchy (ancestors, child items, tables) and the document conventions
that bear on it.

The result is appended to the description as a labelled section AFTER scoring, so the scored text, identity_hash and fidelity_hash are
untouched: the section is a proposal, not source text. A failed call warns and leaves the descriptions alone."""
from __future__ import annotations

import html
import logging
import re
from collections.abc import Callable
from typing import Protocol

from app.job_cancel import JobCancelled
from app.leveling.description_text import description_for_model
from app.leveling.document_study import DocumentStudy, contains_token
from app.workitem.model import (
    IntegrityWarning,
    RequirementQualityIssue,
    WarningKind,
    WorkItemNode,
    WorkItemType,
)

logger = logging.getLogger(__name__)

SECTION_TITLE = "Proposed acceptance criteria"
NEEDS_INPUT_TITLE = "Needs author input"
# Marks a section this module appended: a second pass recognises it by structure, not by wording the source text might contain, and
# description_for_model leaves it out, so scoring and re-scoring never read model-written criteria as the author's text.
_MARKER = "data-r2a"

CHUNK_SIZE = 8
_ELIGIBLE = {RequirementQualityIssue.MISSING_ACCEPTANCE_CRITERIA, RequirementQualityIssue.NOT_TESTABLE}
_BLOCKING = {
    RequirementQualityIssue.PLACEHOLDER, RequirementQualityIssue.OPEN_ITEM_TBD,
    RequirementQualityIssue.FRAGMENT, RequirementQualityIssue.NOT_A_REQUIREMENT,
}
_MAX_ANCESTORS = 4
_MAX_CHILDREN = 8
_MAX_CHILD_CHARS = 200
_MAX_TABLES = 2
_MAX_TABLE_CHARS = 1500
_MAX_CONVENTION_ITEMS = 5


class AcceptanceCriteriaClient(Protocol):
    def propose_acceptance_criteria(self, items_by_id: dict[str, dict], user_id: str | None = None) -> dict[str, dict]: ...


def eligible_nodes(nodes: list[WorkItemNode]) -> list[WorkItemNode]:
    return [
        n for n in nodes
        if n.type == WorkItemType.REQUIREMENT
        and _ELIGIBLE.intersection(n.quality_issues)
        and not _BLOCKING.intersection(n.quality_issues)
    ]


def _clip(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _conventions(node: WorkItemNode, plain: str, study: DocumentStudy | None, folded_terms: list[str]) -> dict:
    """`plain` is the node's plain text; `folded_terms` are the casefolded glossary terms, one per glossary entry (both computed once)."""
    markers = [t for t in (study.placeholder_tokens if study else []) if contains_token(plain, t)]
    if study is None:
        return {"glossary": [], "verification": [], "standards": [], "unresolved_markers": markers}
    own = f"{node.title} {node.description}".casefold()
    glossary: list[dict] = []
    for entry, term in zip(study.glossary, folded_terms):
        if term and term in own:
            glossary.append(entry)
            if len(glossary) == _MAX_CONVENTION_ITEMS:
                break
    return {
        "glossary": glossary,
        "verification": study.verification_statements[:_MAX_CONVENTION_ITEMS],
        "standards": study.standards_cited[:_MAX_CONVENTION_ITEMS],
        "unresolved_markers": markers,
    }


def _context(
    node: WorkItemNode, plain: str, by_id: dict[str, WorkItemNode], children: dict[str, list[WorkItemNode]],
    study: DocumentStudy | None, table_text: Callable[[str], str | None], roles: dict[str, str], folded_terms: list[str],
) -> dict:
    ancestors: list[str] = []
    parent = by_id.get(node.parent_local_id) if node.parent_local_id else None
    while parent is not None and len(ancestors) < _MAX_ANCESTORS:
        ancestors.insert(0, parent.title)
        parent = by_id.get(parent.parent_local_id) if parent.parent_local_id else None
    tables = []
    for table_id in node.table_ids[:_MAX_TABLES]:
        text = table_text(table_id)
        if text:
            tables.append({"id": table_id, "role": roles.get(table_id), "text": _clip(text, _MAX_TABLE_CHARS)})
    return {
        "text": plain,
        "ancestors": ancestors,
        "children": [_clip(c.title or c.description, _MAX_CHILD_CHARS) for c in children.get(node.local_id, [])[:_MAX_CHILDREN]],
        "tables": tables,
        "document_conventions": _conventions(node, plain, study, folded_terms),
    }


def _list_html(items: list[str]) -> str:
    return "<ul>" + "".join(f"<li>{html.escape(i)}</li>" for i in items) + "</ul>"


def _strings(raw: object) -> list[str]:
    return [s.strip() for s in raw if isinstance(s, str) and s.strip()] if isinstance(raw, list) else []


def _append(node: WorkItemNode, section: str) -> None:
    node.description = f"{node.description}\n{section}" if node.description else section


# Only a marker no acronym, word or number can be: TBD, TBC, TBS, TBR, TBA (also dotted: "T.B.D."), or a run of one repeated character
# (XXX, ??, ___, ***; "X.X.X" is a section-style reference, not a run). "N/A" is a deliberate "not applicable", not a missing value, so
# the model decides on it. A requirement wrongly sent to "Needs author input" is a skipped requirement, so everything else ("Tbd", "XX",
# "P1", "TBX", "DC", "RF") goes to the model, which sees the document's own markers in document_conventions.unresolved_markers.
_MARKER_CANDIDATES = re.compile(r"T\.B\.[DCSRA]\.|TB[DCSRA]|X{3,}|\?{2,}|_{3,}|\*{3,}")


def unmistakable_markers(plain_text: str) -> list[str]:
    """The unmistakable markers standing alone in the text (see `contains_token`), in order of first occurrence, without duplicates.
    Found by code in each requirement's own text, so the result never depends on what a study's model listed."""
    found: list[str] = []
    for match in _MARKER_CANDIDATES.finditer(plain_text):
        marker = match.group()
        if marker in found:
            continue
        # The neighbourhood is enough for contains_token's lookarounds (at most 3 characters either side).
        if contains_token(plain_text[max(0, match.start() - 4):match.end() + 4], marker):
            found.append(marker)
    return found


def _needs_input_section(tokens: list[str]) -> str:
    detail = f"Unresolved value(s) in this requirement: {', '.join(tokens)}. " if tokens else "A value this requirement needs is missing. "
    return (
        f'<div {_MARKER}="needs-input"><p><b>{NEEDS_INPUT_TITLE}</b></p><p>{html.escape(detail)}Acceptance criteria were not proposed.</p></div>'
    )


def propose_acceptance_criteria(
    nodes: list[WorkItemNode],
    study: DocumentStudy | None,
    client: AcceptanceCriteriaClient,
    warnings: list[IntegrityWarning],
    table_text: Callable[[str], str | None],
    user_id: str | None = None,
) -> None:
    pending = [
        n for n in eligible_nodes(nodes)
        if f'{_MARKER}="' not in n.description
    ]
    if not pending:
        return
    to_ask: list[tuple[WorkItemNode, str]] = []  # with the node's plain text, which is computed once and shared by every use below
    for node in pending:
        plain = description_for_model(node.description)
        found = unmistakable_markers(plain)
        if found:
            _append(node, _needs_input_section(found))
        else:
            to_ask.append((node, plain))
    roles = {r["table"]: r["role"] for r in (study.table_roles if study else [])}
    # once per call, not per node; outside the try below, so a malformed entry must not raise (it folds to "" and never matches)
    folded_terms = [str(g.get("term") or "").casefold() for g in (study.glossary if study else [])]
    by_id = {n.local_id: n for n in nodes}
    children: dict[str, list[WorkItemNode]] = {}
    for n in nodes:
        if n.parent_local_id:
            children.setdefault(n.parent_local_id, []).append(n)
    unanswered: list[str] = []
    for start in range(0, len(to_ask), CHUNK_SIZE):
        pairs = to_ask[start:start + CHUNK_SIZE]
        chunk = [n for n, _ in pairs]
        try:
            items = {n.local_id: _context(n, plain, by_id, children, study, table_text, roles, folded_terms) for n, plain in pairs}
            answers = client.propose_acceptance_criteria(items, user_id=user_id)
        except JobCancelled:
            raise
        except Exception as error:  # noqa: BLE001 -- a proposal is an extra: report it, keep every description as it was
            logger.warning("Acceptance-criteria proposal failed for %d item(s): %s", len(chunk), error)
            warnings.append(IntegrityWarning.make(
                WarningKind.ENHANCEMENT_CALL_FAILED,
                f"Acceptance criteria could not be proposed for {len(chunk)} item(s); they were left as they were.",
                node_ids=[n.local_id for n in chunk], detail={"pass": "acceptance_criteria"},
            ))
            continue
        for node in chunk:
            answer = answers.get(node.local_id) if isinstance(answers, dict) else None
            if not isinstance(answer, dict):
                unanswered.append(node.local_id)
                continue
            if answer.get("needs_author_input") is True:
                _append(node, _needs_input_section([]))
                continue
            criteria = _strings(answer.get("criteria"))
            if not criteria:
                continue
            body = f"<p><b>{SECTION_TITLE}</b></p>{_list_html(criteria)}"
            assumptions = _strings(answer.get("assumptions"))
            if assumptions:
                body += f"<p><i>Assumptions</i></p>{_list_html(assumptions)}"
            _append(node, f'<div {_MARKER}="criteria">{body}</div>')
    if unanswered:
        warnings.append(IntegrityWarning.make(
            WarningKind.ENHANCEMENT_CALL_FAILED,
            f"The model returned no usable answer for {len(unanswered)} item(s); acceptance criteria were not proposed for them.",
            node_ids=unanswered, detail={"pass": "acceptance_criteria"},
        ))
