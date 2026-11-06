"""Proposes acceptance criteria for SURVEY requirements whose own text says nothing checkable (review finding R6).

Who is asked is decided by code (`eligible_nodes`), from each requirement's own text and its children, whatever format the document came
from and however its headings nest: a Requirement of at least three words that states no checkable value, cites no standard and says nothing
about how it is verified (app.leveling.criteria_grounding.has_quantity), and is not a lead-in whose children are requirements of their
own. The sampled scorer flags play no part, so the same document gives the same set on every fresh run; the study (see document_study)
changes what the model is told and how its answer is checked, never who is asked.

A requirement whose text carries an unmistakable unresolved-value marker (TBD, TBC, TBS, TBR, TBA, or a run of XXX, ??, ___, ***), found by
code in that text whatever the study listed, gets a "needs author input" note instead, with no model call; any other marker of the document
("N", "shall", an acronym like "DC") is too ambiguous to skip the model on, so it is passed to the model as
document_conventions.unresolved_markers and the model decides. Everything else is sent, in bounded chunks asked concurrently under the
shared limiter, with its hierarchy (ancestors, child items, tables), the document conventions that bear on it and the job's context primer.

Every number, unit, standard and section reference in an answer is checked in code against the text the model was given (the requirement,
its children, its tables, the glossary entries and cited standards sent with it; ancestors and the primer ground nothing): a criterion
stating a value the input does not state is dropped, and a requirement left with no criterion, or whose assumptions state one, gets the
"needs author input" note.

The result is appended to the description as a labelled section AFTER scoring, so the scored text, identity_hash and fidelity_hash are
untouched: the section is a proposal, not source text. A failed call warns and leaves the descriptions alone."""

from __future__ import annotations

import html
import logging
import re
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, wait
from typing import TYPE_CHECKING, Literal, NamedTuple, Protocol

from app.config import settings
from app.job_cancel import JobCancelled, raise_if_cancelled, submit_in_context
from app.leveling.criteria_grounding import Grounding, given_values, has_quantity, ungrounded
from app.leveling.description_text import description_for_model
from app.leveling.document_study import DocumentStudy, contains_token
from app.leveling.llm_call_gate import LeaseGate, StepBudgetExceeded, use_gate
from app.request_identity import user_scope
from app.workitem.model import (
    IntegrityWarning,
    WarningKind,
    WorkItemNode,
    WorkItemType,
)

if TYPE_CHECKING:
    from app.leveling.llm_lease_limiter import LeaseLimiter

logger = logging.getLogger(__name__)

SECTION_TITLE = "Proposed acceptance criteria"
NEEDS_INPUT_TITLE = "Needs author input"
# Marks a section this module appended: a second pass recognises it by structure, not by wording the source text might contain, and
# description_for_model leaves it out, so scoring and re-scoring never read model-written criteria as the author's text.
_MARKER = "data-r2a"

CHUNK_SIZE = 8
_MIN_WORDS = 3  # fewer words is a label or a fragment, not a statement to write criteria for
# A requirement that introduces a list: a trailing colon, "the following", "as follows" (and the Hebrew "as follows", "the following"). It is
# left out only when every child is a requirement of its own (the children get their own criteria); with no such child it is still asked.
_LEAD_IN = re.compile(
    r"[:\uff1a]\s*$|\bthe following\b|\bas follows\b|כדלקמן|הבאים|הבאות", re.IGNORECASE
)
_POLL_SECONDS = 1.0
_RETRY_WAIT_SECONDS = 300.0
_MAX_ANCESTORS = 4
_MAX_CHILDREN = 8
_MAX_CHILD_CHARS = 200
_MAX_TABLES = 2
_MAX_TABLE_CHARS = 1500
_MAX_CONVENTION_ITEMS = 5
_MAX_BACKGROUND_CHARS = 2000


class AcceptanceCriteriaClient(Protocol):
    def propose_acceptance_criteria(
        self,
        items_by_id: dict[str, dict],
        user_id: str | None = None,
        background: str | None = None,
    ) -> dict[str, dict]: ...


def _children_of(nodes: list[WorkItemNode]) -> dict[str, list[WorkItemNode]]:
    children: dict[str, list[WorkItemNode]] = {}
    for n in nodes:
        if n.parent_local_id:
            children.setdefault(n.parent_local_id, []).append(n)
    return children


def _is_eligible(node: WorkItemNode, plain: str, kids: list[WorkItemNode]) -> bool:
    """`plain` is the node's plain description text. Pure code on the node's own text and its children: no scorer flag, no heading level."""
    text = plain.strip() or node.title or ""
    if (
        node.type != WorkItemType.REQUIREMENT
        or len(re.findall(r"\w+", text)) < _MIN_WORDS
        or has_quantity(text)
    ):
        return False
    if (
        kids
        and _LEAD_IN.search(text)
        and all(k.type == WorkItemType.REQUIREMENT and (k.title or k.description) for k in kids)
    ):
        return False
    return True


def _eligible_pairs(nodes: list[WorkItemNode]) -> list[tuple[WorkItemNode, str]]:
    """The eligible nodes with their plain text, which is computed once and shared by every later use."""
    children = _children_of(nodes)
    pairs = []
    for n in nodes:
        plain = description_for_model(n.description)
        if _is_eligible(n, plain, children.get(n.local_id, [])):
            pairs.append((n, plain))
    return pairs


def eligible_nodes(nodes: list[WorkItemNode]) -> list[WorkItemNode]:
    return [n for n, _ in _eligible_pairs(nodes)]


def _clip(text: str, limit: int) -> str:
    text = " ".join(
        text[: limit * 4].split()
    )  # a large table is cut before the split, not after it
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _conventions(
    node: WorkItemNode, plain: str, study: DocumentStudy | None, folded_terms: list[str]
) -> dict:
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
    node: WorkItemNode,
    plain: str,
    by_id: dict[str, WorkItemNode],
    children: dict[str, list[WorkItemNode]],
    study: DocumentStudy | None,
    table_text: Callable[[str], str | None],
    roles: dict[str, str],
    folded_terms: list[str],
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
            tables.append(
                {"id": table_id, "role": roles.get(table_id), "text": _clip(text, _MAX_TABLE_CHARS)}
            )
    return {
        "text": plain,
        "ancestors": ancestors,
        "children": [
            _clip(c.title or c.description, _MAX_CHILD_CHARS)
            for c in children.get(node.local_id, [])[:_MAX_CHILDREN]
        ],
        "tables": tables,
        "document_conventions": _conventions(node, plain, study, folded_terms),
    }


def _list_html(items: list[str]) -> str:
    return "<ul>" + "".join(f"<li>{html.escape(i)}</li>" for i in items) + "</ul>"


def _strings(raw: object) -> list[str]:
    return (
        [s.strip() for s in raw if isinstance(s, str) and s.strip()]
        if isinstance(raw, list)
        else []
    )


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
        if contains_token(plain_text[max(0, match.start() - 4) : match.end() + 4], marker):
            found.append(marker)
    return found


def _needs_input_section(tokens: list[str]) -> str:
    detail = (
        f"Unresolved value(s) in this requirement: {', '.join(tokens)}. "
        if tokens
        else "This requirement needs a value that the text does not provide. "
    )
    return f'<div {_MARKER}="needs-input"><p><b>{NEEDS_INPUT_TITLE}</b></p><p>{html.escape(detail)}Acceptance criteria were not proposed.</p></div>'


def _grounding_of(item: dict, cited: frozenset[str]) -> Grounding:
    """What may ground a number, unit or section reference in the answer for `item`: exactly what the model was given as that requirement's
    own content (text, children, tables, the glossary entries sent). A cited standard is grounded by those and by `cited`, the standards sent
    (the same for every node, so computed once by the caller)."""
    conventions = item["document_conventions"]
    own = given_values(
        [
            item["text"],
            *item["children"],
            *(t["text"] for t in item["tables"]),
            *(
                f"{g.get('term') or ''} {g.get('definition') or ''}"
                for g in conventions["glossary"]
                if isinstance(g, dict)
            ),
        ]
    )
    return Grounding(own.numbers, own.units, own.standards | cited, own.refs)


class _Outcome(NamedTuple):
    """How one chunk went: asked and answered, not asked because the step's budget ran out, or failed (value = the exception)."""

    kind: Literal["ok", "late", "failed"]
    value: object = None


def _ask(
    client: AcceptanceCriteriaClient,
    items: dict[str, dict],
    user_id: str | None,
    background: str | None,
    gate: LeaseGate,
) -> dict[str, dict]:
    extra = (
        {"background": background} if background else {}
    )  # only when there is one: a client written before it exists keeps working
    with use_gate(gate):
        return client.propose_acceptance_criteria(items, user_id=user_id, **extra)


def _ask_all(
    chunks: list[dict[str, dict]],
    ask: Callable[[dict[str, dict]], dict[str, dict]],
    workers: int,
) -> list[_Outcome]:
    """Asks every chunk, `workers` at once, and returns one outcome per chunk IN CHUNK ORDER, whichever finishes first:
    _Outcome("ok", answers), _Outcome("late") when the step's budget ran out first, or _Outcome("failed", exception). Workers only call the model; every
    node and warning is touched by the caller's thread afterwards. JobCancelled is re-raised, and the chunks not yet started are dropped."""
    pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="criteria")
    try:
        futures = [submit_in_context(pool, ask, items) for items in chunks]
        outcomes: list[_Outcome] = []
        for future in futures:
            while not wait([future], timeout=_POLL_SECONDS)[0]:
                raise_if_cancelled()
            try:
                outcomes.append(_Outcome("ok", future.result()))
            except JobCancelled:
                raise
            except StepBudgetExceeded:
                outcomes.append(_Outcome("late"))
            except Exception as error:  # noqa: BLE001 -- a proposal is an extra: a failed chunk is reported by the caller, never fatal
                outcomes.append(_Outcome("failed", error))
        return outcomes
    finally:
        pool.shutdown(
            wait=False, cancel_futures=True
        )  # never waits for a call under way: it ends by itself, and holds no lease once it does


def propose_acceptance_criteria(
    nodes: list[WorkItemNode],
    study: DocumentStudy | None,
    client: AcceptanceCriteriaClient,
    warnings: list[IntegrityWarning],
    table_text: Callable[[str], str | None],
    user_id: str | None = None,
    background: str | None = None,
    limiter: LeaseLimiter | None = None,
    model: str | None = None,
) -> None:
    pending = [
        (n, plain) for n, plain in _eligible_pairs(nodes) if f'{_MARKER}="' not in n.description
    ]
    if not pending:
        return
    to_ask: list[tuple[WorkItemNode, str]] = []
    needs_input = 0
    for node, plain in pending:
        found = unmistakable_markers(plain)
        if found:
            _append(node, _needs_input_section(found))
            needs_input += 1
        else:
            to_ask.append((node, plain))
    roles = {r["table"]: r["role"] for r in (study.table_roles if study else [])}
    # once per call, not per node; outside the try below, so a malformed entry must not raise (it folds to "" and never matches)
    folded_terms = [str(g.get("term") or "").casefold() for g in (study.glossary if study else [])]
    by_id = {n.local_id: n for n in nodes}
    children = _children_of(nodes)
    background = _clip(background, _MAX_BACKGROUND_CHARS) if background else None
    cited = given_values(
        str(s) for s in (study.standards_cited[:_MAX_CONVENTION_ITEMS] if study else [])
    ).standards
    tables_seen: dict[str, str | None] = {}

    def cached_table_text(
        table_id: str,
    ) -> str | None:  # a table shared by many nodes is rendered once
        if table_id not in tables_seen:
            tables_seen[table_id] = table_text(table_id)
        return tables_seen[table_id]

    chunks = [to_ask[start : start + CHUNK_SIZE] for start in range(0, len(to_ask), CHUNK_SIZE)]
    shared_limiter = (
        limiter if user_id else None
    )  # a call without a user id has no scope to count against
    gate = LeaseGate(
        shared_limiter,
        model,
        user_scope(user_id) if user_id else "",
        time.monotonic() + settings.survey_criteria_stage_budget_seconds,
        settings.survey_criteria_lease_max_wait_seconds,
    )
    # Never all of the user's slots: the same user's other jobs (their study windows) need one. 2 without a shared limiter to count against.
    ceiling = max(1, settings.survey_study_user_slots - 1) if shared_limiter is not None else 2
    workers = max(1, min(settings.survey_criteria_concurrency, ceiling, len(chunks)))

    def ask(items: dict[str, dict]) -> dict[str, dict]:
        return _ask(client, items, user_id, background, gate)

    # The one more try of a failed chunk runs on the job's own thread: it waits for a slot for a short while only, never the rest of the budget.
    retry_gate = LeaseGate(
        shared_limiter,
        model,
        user_scope(user_id) if user_id else "",
        min(gate.deadline, time.monotonic() + _RETRY_WAIT_SECONDS),
        settings.survey_criteria_lease_max_wait_seconds,
    )

    def retry(items: dict[str, dict]) -> dict[str, dict]:
        return _ask(client, items, user_id, background, retry_gate)

    # Every context is built here, on the caller's thread, before any worker starts: workers read these dicts and write nothing. A chunk whose
    # context cannot be built is a failed chunk (reported below), never an exception.
    outcomes: list[_Outcome] = [_Outcome("failed")] * len(chunks)
    chunk_items: dict[int, dict[str, dict]] = {}
    groundings: dict[str, Grounding] = {}
    for index, pairs in enumerate(chunks):
        try:
            items = {
                n.local_id: _context(
                    n, plain, by_id, children, study, cached_table_text, roles, folded_terms
                )
                for n, plain in pairs
            }
            groundings.update(
                {local_id: _grounding_of(item, cited) for local_id, item in items.items()}
            )
        except JobCancelled:
            raise
        except Exception as error:  # noqa: BLE001 -- see _ask_all
            outcomes[index] = _Outcome("failed", error)
        else:
            chunk_items[index] = items
    asked = list(chunk_items)
    for index, outcome in zip(
        asked, _ask_all([chunk_items[i] for i in asked], ask, workers) if asked else []
    ):
        outcomes[index] = outcome
    failed_chunks = [
        i for i in asked if outcomes[i].kind == "failed"
    ]  # one more try (a 429 burst or a cut-off), in the pool, with a short wait
    for index, outcome in zip(
        failed_chunks,
        _ask_all([chunk_items[i] for i in failed_chunks], retry, workers) if failed_chunks else [],
    ):
        outcomes[index] = outcome
    unanswered: list[str] = []
    late: list[str] = []
    dropped_nodes: list[str] = []
    dropped = failed = 0
    for pairs, (kind, value) in zip(chunks, outcomes):
        chunk = [n for n, _ in pairs]
        if kind == "late":
            late.extend(n.local_id for n in chunk)
            continue
        if kind == "failed":
            failed += len(chunk)
            logger.warning(
                "Acceptance-criteria proposal failed for %d item(s): %s",
                len(chunk),
                type(value).__name__,
            )
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.ENHANCEMENT_CALL_FAILED,
                    f"Acceptance criteria could not be proposed for {len(chunk)} item(s); they were left as they were.",
                    node_ids=[n.local_id for n in chunk],
                    detail={"pass": "acceptance_criteria"},
                )
            )
            continue
        answers = value
        for node in chunk:
            answer = answers.get(node.local_id) if isinstance(answers, dict) else None
            if not isinstance(answer, dict):
                unanswered.append(node.local_id)
                continue
            if answer.get("needs_author_input") is True:
                _append(node, _needs_input_section([]))
                needs_input += 1
                continue
            criteria = _strings(answer.get("criteria"))
            if not criteria:
                continue
            assumptions = _strings(answer.get("assumptions"))
            grounding = groundings[node.local_id]
            kept = [c for c in criteria if not ungrounded(c, grounding)]
            invented_assumption = any(ungrounded(a, grounding) for a in assumptions)
            if len(kept) < len(criteria):
                dropped += len(criteria) - len(kept)
                dropped_nodes.append(node.local_id)
            if not kept or invented_assumption:
                # Nothing the input supports is left, or an assumption states a value it does not: say so, never invent one.
                if invented_assumption and kept:
                    dropped_nodes.append(node.local_id)
                _append(node, _needs_input_section([]))
                needs_input += 1
                continue
            body = f"<p><b>{SECTION_TITLE}</b></p>{_list_html(kept)}"
            if assumptions:
                body += f"<p><i>Assumptions</i></p>{_list_html(assumptions)}"
            _append(node, f'<div {_MARKER}="criteria">{body}</div>')
    if unanswered:
        warnings.append(
            IntegrityWarning.make(
                WarningKind.ENHANCEMENT_CALL_FAILED,
                f"The model returned no usable answer for {len(unanswered)} item(s); acceptance criteria were not proposed for them.",
                node_ids=unanswered,
                detail={"pass": "acceptance_criteria"},
            )
        )
    if late:
        warnings.append(
            IntegrityWarning.make(
                WarningKind.ENHANCEMENT_CALL_FAILED,
                f"The acceptance-criteria step ran out of time before {len(late)} item(s) could be asked; they were left as they were.",
                node_ids=late,
                detail={"pass": "acceptance_criteria"},
            )
        )
    if dropped_nodes:
        warnings.append(
            IntegrityWarning.make(
                WarningKind.ENHANCEMENT_CALL_FAILED,
                f"Proposed criteria for {len(set(dropped_nodes))} item(s) stated a value the document does not state; {dropped} criterion(s) were left out.",
                node_ids=list(dict.fromkeys(dropped_nodes)),
                detail={"pass": "acceptance_criteria", "dropped": dropped},
            )
        )
    logger.info(
        "Acceptance criteria: eligible=%d asked=%d chunks=%d workers=%d needs_input=%d dropped_criteria=%d failed=%d late=%d unanswered=%d",
        len(pending),
        len(to_ask),
        len(chunks),
        workers,
        needs_input,
        dropped,
        failed,
        len(late),
        len(unanswered),
    )
