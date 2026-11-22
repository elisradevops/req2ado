"""Writes the text of the SURVEY items that code built from the document's prose (adopt_baseline_structure), on the FIXED tree.

The tree is decided before this runs: which items exist, their types, nesting and titles never change here. The model only rewrites a
description (author_content), in the source's language and obligation form (the client's language policy). Code then decides whether the
rewrite is kept, with the same value check the acceptance criteria use (app.leveling.criteria_grounding):

- a rewrite may state no number, unit, standard or section reference that its own source does not (an Epic or Feature may use any value
  of the items under it, which its summary describes);
- a Requirement's rewrite must also keep every such value its source states, so nothing measurable is lost in the rewording.

A rewrite that fails either check, an item the answer leaves out (the client also leaves out an answer in another script) and an item of a
failed call keep their source wording, with a warning. Only items with wording of their own are offered: a Requirement, or an Epic or
Feature whose description is just its heading. A description that carries a table, a parent with body text of its own (notes, lead-ins)
and a grouping item the pipeline added ("synth_" ids) are left as they are: rewriting them would replace source content with a summary.

Known limits, accepted: an identifier without digits ("ICD") is not checked; a unit conversion in the rewrite reads as a new value."""

from __future__ import annotations

import logging
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Protocol

from app.job_cancel import JobCancelled
from app.leveling.bounded_chunks import run_chunks_bounded
from app.leveling.criteria_grounding import given_values, ungrounded
from app.leveling.description_text import html_to_model_text, split_tables
from app.leveling.id_tree_builder import synthesis_updates
from app.leveling.live_context import current_stage_counter
from app.survey.content_filter import kb_blocked_warning, without_kb_when_blocked
from app.workitem.model import (
    IntegrityWarning,
    WarningKind,
    WorkItemNode,
    WorkItemType,
    record_prompt,
)

logger = logging.getLogger(__name__)

# One call writes at most this many items from at most this much source text, so a long branch stays under the output cap.
_ITEMS_PER_CALL = 30
_SECTION_CHARS = 12_000
_PASS = "authoring"


class ContentAuthoringClient(Protocol):
    def author_content(
        self,
        section_text: str,
        skeleton_nodes: dict[str, dict],
        kb_context: str | None = None,
        user_id: str | None = None,
    ) -> tuple[dict[str, dict], bool]: ...


@dataclass(frozen=True)
class _Chunk:
    section_text: str
    node_ids: list[str]


def _is_grouping(node: WorkItemNode) -> bool:
    return "synth_" in node.local_id


def _authorable(node: WorkItemNode) -> bool:
    if _is_grouping(node) or split_tables(node.description)[1]:
        return False
    if node.type == WorkItemType.REQUIREMENT:
        return bool(node.description.strip())
    return node.description.strip() == node.title.strip()


def _branch_roots(nodes: list[WorkItemNode]) -> dict[str, str]:
    """Each item's top-most ancestor that is not a grouping item: the branch it is written with."""
    by_id = {node.local_id: node for node in nodes}
    roots: dict[str, str] = {}
    for node in nodes:
        current = node
        while current.parent_local_id in by_id and not _is_grouping(by_id[current.parent_local_id]):
            current = by_id[current.parent_local_id]
        roots[node.local_id] = current.local_id
    return roots


def _chunks(nodes: list[WorkItemNode], text: dict[str, str]) -> list[_Chunk]:
    """Consecutive runs of one branch, in document order. Each call sees the source text of every item in its run (the items it writes and
    their neighbours, so a parent sees the items under it) and writes the authorable ones."""
    roots = _branch_roots(nodes)
    chunks: list[_Chunk] = []
    lines: list[str] = []
    ids: list[str] = []
    branch: str | None = None
    size = 0

    def close() -> None:
        if ids:
            chunks.append(_Chunk("\n".join(lines), list(ids)))
        lines.clear()
        ids.clear()

    for node in nodes:
        if _is_grouping(node):
            continue
        line = text[node.local_id]
        full = ids and (len(ids) >= _ITEMS_PER_CALL or size + len(line) > _SECTION_CHARS)
        if roots[node.local_id] != branch or full:
            close()
            size = 0
            branch = roots[node.local_id]
        lines.append(line)
        size += len(line)
        if _authorable(node):
            ids.append(node.local_id)
    close()
    return chunks


def _subtree_texts(node_id: str, nodes: list[WorkItemNode], text: dict[str, str]) -> Iterable[str]:
    children: dict[str, list[str]] = {}
    for node in nodes:
        if node.parent_local_id is not None:
            children.setdefault(node.parent_local_id, []).append(node.local_id)
    stack = [node_id]
    while stack:
        current = stack.pop()
        yield text[current]
        stack.extend(children.get(current, []))


def value_problems(
    rewrite: str, source: str, grounding_texts: Iterable[str], keep: bool
) -> list[str]:
    """The values `rewrite` adds that `grounding_texts` do not state, then (when `keep`) the values of `source` it no longer states, as
    labels ("added number:7", "dropped unit:v"). Empty when the rewrite may be kept."""
    added = [f"added {value}" for value in ungrounded(rewrite, given_values(grounding_texts))]
    dropped = (
        [f"dropped {value}" for value in ungrounded(source, given_values([rewrite]))]
        if keep
        else []
    )
    return added + dropped


def _warning(
    kind: WarningKind, message: str, node_ids: list[str], **detail: object
) -> IntegrityWarning:
    return IntegrityWarning.make(kind, message, node_ids=node_ids, detail={"pass": _PASS, **detail})


def author_fixed_tree(
    nodes: list[WorkItemNode],
    client: ContentAuthoringClient,
    warnings: list[IntegrityWarning],
    *,
    kb_context: str | None = None,
    user_id: str | None = None,
    concurrency: int = 1,
) -> None:
    """Rewrites the authorable items of `nodes` (the code-built items, in document order) in place. Never raises except JobCancelled."""
    by_id = {node.local_id: node for node in nodes}
    text = {node.local_id: html_to_model_text(node.description).strip() for node in nodes}
    chunks = _chunks(nodes, text)
    counter = current_stage_counter()
    if counter is not None:
        counter.set_total("write", sum(len(chunk.node_ids) for chunk in chunks))
    if not chunks:
        return

    def write(chunk: _Chunk) -> tuple[tuple[dict[str, dict], bool], bool]:
        payload = {
            node_id: {
                "type": by_id[node_id].type.value,
                "title": by_id[node_id].title,
                "parent_id": by_id[node_id].parent_local_id,
            }
            for node_id in chunk.node_ids
        }
        try:
            return without_kb_when_blocked(
                lambda kb: client.author_content(
                    chunk.section_text, payload, kb_context=kb, user_id=user_id
                ),
                kb_context,
                "author_content",
            )
        finally:
            if counter is not None:
                counter.advance("write", len(chunk.node_ids))

    failed: list[str] = []
    omitted: list[str] = []
    rejected: dict[str, list[str]] = {}
    without_kb: list[str] = []
    truncated = False
    for outcome in run_chunks_bounded(chunks, write, concurrency):
        chunk = chunks[outcome.chunk_index]
        if outcome.error is not None:
            if isinstance(outcome.error, JobCancelled):
                raise outcome.error
            logger.warning(
                "author_content call failed for %d item(s): %s",
                len(chunk.node_ids),
                type(outcome.error).__name__,
            )
            failed.extend(chunk.node_ids)
            continue
        (content, chunk_truncated), kb_left_out = outcome.value or (({}, False), False)
        truncated = truncated or chunk_truncated
        if kb_left_out:
            without_kb.extend(chunk.node_ids)
        for node_id in chunk.node_ids:
            node = by_id[node_id]
            entry = content.get(node_id)
            rewrite = entry.get("description") if isinstance(entry, dict) else None
            if not isinstance(rewrite, str) or not rewrite.strip():
                omitted.append(node_id)
                continue
            source = text[node_id]
            requirement = node.type == WorkItemType.REQUIREMENT
            grounding = [source] if requirement else list(_subtree_texts(node_id, nodes, text))
            problems = value_problems(rewrite, source, grounding, keep=requirement)
            if problems:
                rejected[node_id] = problems
                continue
            updates = synthesis_updates(
                {"text": rewrite, "tags": entry.get("tags")}, source, node.type
            )
            node.description = updates["description"]
            node.fidelity_hash = updates["fidelity_hash"]
            node.grounding_score = updates["grounding_score"]
            node.tags = updates.get("tags", []) if requirement else []
            record_prompt(node, entry)

    if counter is not None:
        counter.complete("write")
    if failed:
        warnings.append(
            _warning(
                WarningKind.ENHANCEMENT_CALL_FAILED,
                f"Writing the text of {len(failed)} item(s) failed; they keep their source wording.",
                failed,
            )
        )
    if omitted:
        warnings.append(
            _warning(
                WarningKind.ENHANCEMENT_RESPONSE_INCOMPLETE,
                f"The model's answer left out {len(omitted)} item(s), or answered them in another language; they keep their source wording.",
                omitted,
                reason="omitted",
            )
        )
    if rejected:
        warnings.append(
            _warning(
                WarningKind.ENHANCEMENT_RESPONSE_INCOMPLETE,
                f"{len(rejected)} rewritten item(s) added or dropped a number, unit, standard or reference; they keep their source wording.",
                list(rejected),
                reason="value_check",
                values=rejected,
            )
        )
    if without_kb:
        warnings.append(kb_blocked_warning(_PASS, "writing the item text", without_kb))
    if truncated:
        warnings.append(
            _warning(
                WarningKind.OUTPUT_TRUNCATED,
                "The model's output was cut off by the token limit while writing item text; the items it did not finish keep their "
                "source wording.",
                [],
            )
        )
    logger.info(
        "author_fixed_tree: offered=%d rewritten=%d omitted=%d rejected=%d failed=%d",
        sum(len(chunk.node_ids) for chunk in chunks),
        sum(len(chunk.node_ids) for chunk in chunks) - len(omitted) - len(rejected) - len(failed),
        len(omitted),
        len(rejected),
        len(failed),
    )
