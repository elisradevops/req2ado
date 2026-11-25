"""Short titles for the requirements a document's grammar built (app.leveling.document_grammar), in both modes.

A requirement exported from a requirements tool is a code and a sentence; its title was the sentence cut at a word boundary, which a
project manager cannot scan. One batched model call per chunk writes a short title per requirement; code keeps it only when it is
grounded -- every significant word of the title is a word of the requirement's own text (by its stem: "receives" for "shall receive"),
so no code and no invented fact; no obligation word; a few words -- and otherwise keeps the extracted title. The description is never touched: it stays the
document's words.

Fail-open: a failed or partial answer keeps the extracted titles of the requirements it did not cover, with one warning per failed chunk.
The client caches each requirement's answer by its text (OrchestratorLlmClient.requirement_titles), so a re-run of the same file asks the
model only for requirements it has not seen."""

from __future__ import annotations

import re
from typing import Protocol

from app.leveling.bounded_chunks import run_chunks_bounded
from app.leveling.grounding import significant_words
from app.workitem.model import IntegrityWarning, WarningKind, WorkItemNode, WorkItemType

# Bump when the prompt or the checks below change meaning: part of every cached answer's key.
TITLE_PASS_VERSION = "1"
CHUNK_SIZE = 150
MAX_TITLE_WORDS = 14  # the prompt asks for 3-10; values and units ("100 V to 240 V at 50 Hz or 60 Hz") count as words
MAX_TITLE_CHARS = 90

# Words a title may use to join the requirement's own words ("Speakers mute when headphones are plugged in"): never a fact of their own.
_JOINING = frozenset("a an the of to in on at for and or by with its it be is are from as into than per up under over not does both when".split())
_OBLIGATION = re.compile(r"\b(shall|must|should|will)\b", re.IGNORECASE)


class RequirementTitleClient(Protocol):
    def requirement_titles(self, texts_by_id: dict[str, str], user_id: str | None = None) -> dict[str, dict]: ...


def statement_of(node: WorkItemNode) -> str:
    """The requirement's own text: its description without the trace (after the blank line)."""
    return node.description.split("\n\n", 1)[0]


def _stem(word: str) -> str:
    if word.endswith("ies") and len(word) > 4:
        return word[:-3] + "y"
    for suffix in ("ing", "es", "ed", "s"):
        if len(word) > (4 if suffix == "ed" else 3) and word.endswith(suffix) and not (suffix == "s" and word.endswith("ss")):
            word = word[: -len(suffix)]
            break
    return word[:-1] if len(word) > 3 and word.endswith("e") else word


def _stems(text: str) -> set[str]:
    return {_stem(w) for w in significant_words(text)}


def checked_title(title: object, statement: str) -> str | None:
    """The title the model wrote, if code accepts it: a few words, no code, no obligation word, and every significant word grounded in
    the requirement's own text. None otherwise (the extracted title is kept)."""
    if not isinstance(title, str):
        return None
    text = " ".join(title.split()).rstrip(".").strip()
    if not text or len(text) > MAX_TITLE_CHARS or len(text.split()) > MAX_TITLE_WORDS:
        return None
    # No separate code check: the requirement's code is not part of its text (it is the Customer ID), so a code in the title is ungrounded.
    if _OBLIGATION.search(text):
        return None
    wanted = _stems(text) - {_stem(w) for w in _JOINING}
    return text if wanted and wanted <= _stems(statement) else None


def write_requirement_titles(
    nodes: list[WorkItemNode],
    client: RequirementTitleClient,
    warnings: list[IntegrityWarning],
    user_id: str | None = None,
    concurrency: int = 1,
) -> int:
    """Writes a short title on every grammar-built Requirement (`verbatim`) whose title the model's answer grounds; returns how many it
    wrote. Chunks are merged in their own order, so the result does not depend on which chunk answers first."""
    targets = [n for n in nodes if n.verbatim and n.type == WorkItemType.REQUIREMENT]
    if not targets:
        return 0
    chunks = [targets[i : i + CHUNK_SIZE] for i in range(0, len(targets), CHUNK_SIZE)]
    payloads = [{n.local_id: statement_of(n) for n in chunk} for chunk in chunks]
    written = 0
    outcomes = run_chunks_bounded(payloads, lambda payload: client.requirement_titles(payload, user_id=user_id), concurrency)
    for chunk, outcome in zip(chunks, outcomes):
        if outcome.error is not None or not isinstance(outcome.value, dict):
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.ENHANCEMENT_CALL_FAILED,
                    f"Short titles could not be written for {len(chunk)} requirement(s); they keep the title taken from their text.",
                    node_ids=[n.local_id for n in chunk],
                    detail={"pass": "requirement_titles"},
                )
            )
            continue
        for node in chunk:
            entry = outcome.value.get(node.local_id)
            title = checked_title(entry.get("title") if isinstance(entry, dict) else None, statement_of(node))
            if title is not None:
                node.title = title
                written += 1
    return written
