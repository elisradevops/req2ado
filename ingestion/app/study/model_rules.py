"""A model reads the file's conventions; code decides what they are worth.

The header detectors (study/file_rules.py, study/heading_rules.py) know the conventions the code was written for ("Work Item Type", "Title 1",
"Feature: X"). A file that states its structure some other way (Hebrew headings, a Kind column of Group/Item, a numeric Level column, an outline
number) is read here: the model is shown a bounded, normalised PROFILE of the file (statistics over every row, every distinct value of each
low-cardinality column, every heading, with the file's own row, column and heading numbers) and answers with a small closed-vocabulary rulebook.
It never writes items and never sees a free-text slot that could reach one.

What keeps the structure the same every time for the same file:
  * the answer is checked against the WHOLE file (columns in range, the header echoed back, every distinct type value mapped, titles and levels
    filled on nearly every row, nesting the ladder allows, labels recounted); a field that fails is refused and the file stays on the deterministic
    path, reported, never half applied;
  * the model is asked several times and a field is kept only when most answers agree (disagreement is "unknown", which fails the table closed);
  * the validated rulebook is canonicalised and hashed (study/rulebook.py), so equal meaning is an equal hash and an equal tree;
  * the header detectors always win where they apply, so the model only fills the gaps.
A model that is down, slow or wrong therefore costs a warning, never a different tree."""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections import Counter
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Protocol

from app.canonical.markup import html_to_cell_text
from app.canonical.model import BlockKind, CanonicalDoc, Table
from app.config import settings
from app.job_cancel import JobCancelled, submit_in_context
from app.leveling.code_shape import (
    CodeShape,
    leading_code_token,
    learn_code_shape,
    shape_candidates,
)
from app.leveling.customer_id import opens_a_requirement
from app.leveling.depth import resolve_block_depth
from app.leveling.document_layout import find_front_matter, section_of, without_front_matter
from app.leveling.numbering import parse_numbering
from app.prompts import load_prompt
from app.study.file_rules import (
    DETAIL_SAMPLES,
    _find_header_row,
    _grid,
    clip_detail,
    rule_from_spec,
    study_table,
)
from app.study.heading_rules import MIN_LABELLED, MIN_LABELLED_SHARE
from app.study.rulebook import (
    DOCUMENT_KINDS,
    FRONT_MATTER_ROLES,
    LADDER,
    PROPOSAL_ACTIONS,
    TITLE_POLICIES,
    DocumentRules,
    FileRulebook,
    FrontMatterPart,
    LabelRule,
    Proposal,
    RuleSpec,
    fold,
)
from app.workitem.model import IntegrityWarning, WarningKind

logger = logging.getLogger(__name__)

SAMPLE_CELL_CHARS = 120
SAMPLE_MAX_CHARS = 14_000
LOW_CARDINALITY = 30  # a column with at most this many distinct values lists every one of them
HEAD_ROWS = 20
TAIL_ROWS = 5
TOP_ROWS = 6
MAX_HEADER_ROW = 5
MIN_COVERAGE = 0.9  # of the data rows, the share a chosen title, level or parent column must serve
MIN_LADDER_SHARE = 0.6  # of the rows that state a type, the share that must map to Epic/Feature/Requirement
MIN_SECTION_PARENT_SHARE = 0.5  # of the rows that have children, the share that must be an Epic or a Feature
MAX_INVERSION_SHARE = 0.1  # of the imported rows, the share allowed to nest in a way the ladder does not allow
MAX_HEADINGS = 400
MIN_DOCUMENT_HEADINGS = 6
LABEL_SEPARATORS = (":", "-", "–", "—", ".")
ROLES = (
    "type",
    "level_title",
    "level_number",
    "outline_number",
    "id",
    "parent_id",
    "title",
    "customer_id",
    "description",
    "metadata",
)
_NESTING_FROM_MODEL = {
    "level_columns": "levels",
    "level_number": "level_number",
    "outline_number": "outline_number",
    "id_parent": "id_parent",
    "row_order": "order",
}
_MAPS_TO = {"Epic": "Epic", "Feature": "Feature", "Requirement": "Requirement"}


class FileRulesStudyClient(Protocol):
    """The model client the pre-study asks. `vote` tells repeated asks of the same sample apart for the response cache only; it never reaches the model.
    `accept` says whether an answer can be used (it passed the checks against the file): only such an answer may be kept and reused."""

    def study_file_rules_table(
        self, sample: dict, user_id: str | None = None, vote: int = 0, accept: Callable[[dict], bool] | None = None
    ) -> dict: ...

    def study_file_rules_document(
        self, sample: dict, user_id: str | None = None, vote: int = 0, accept: Callable[[dict], bool] | None = None
    ) -> dict: ...


# --------------------------------------------------------------------------------------------------------------------------------------------
# Tables
# --------------------------------------------------------------------------------------------------------------------------------------------


def _clip(text: str) -> str:
    text = " ".join(html_to_cell_text(text).split())
    return text if len(text) <= SAMPLE_CELL_CHARS else text[:SAMPLE_CELL_CHARS] + "…"


def table_sample(table: Table) -> dict:
    """The bounded, normalised view the model studies. HTML is already text; statistics cover every row below the first heading row, so a column's
    list of distinct values never includes its own heading; rows shown are the file's own row numbers."""
    grid = [[" ".join(html_to_cell_text(c).split()) for c in row] for row in _grid(table)]
    width = len(grid[0]) if grid else 0
    guess = _find_header_row(_grid(table))
    first_data = (guess if guess is not None else 0) + 1
    body = grid[first_data:]
    columns = []
    first_row_of: dict[tuple[int, str], int] = {}
    for column in range(width):
        values = [row[column] for row in body]
        filled = [v for v in values if v]
        counts = Counter(filled)
        entry = {
            "column": column,
            "filledFraction": round(len(filled) / len(values), 2) if values else 0,
            "distinctCount": len(counts),
            "averageLength": round(sum(len(v) for v in filled) / len(filled)) if filled else 0,
            "numericFraction": round(sum(1 for v in filled if re.fullmatch(r"[\d.,]+", v)) / len(filled), 2)
            if filled
            else 0,
        }
        if 0 < len(counts) <= LOW_CARDINALITY:
            entry["allValues"] = [{"value": _clip(v), "count": counts[v]} for v in dict.fromkeys(filled)]
            for offset, row in enumerate(body):
                if row[column]:
                    first_row_of.setdefault((column, row[column]), first_data + offset)
        columns.append(entry)

    stratified = sorted(set(first_row_of.values()))
    head = list(range(first_data, min(first_data + HEAD_ROWS, len(grid))))
    tail = list(range(max(first_data, len(grid) - TAIL_ROWS), len(grid)))
    top = list(range(min(TOP_ROWS, len(grid))))

    def build(head_rows: int, clip: int) -> dict:
        chosen = sorted({*top, *head[:head_rows], *tail, *stratified})

        def cell(text: str) -> str:
            return text if len(text) <= clip else text[:clip] + "…"

        return {
            "rowCount": len(grid),
            "columnCount": width,
            "statsFromRow": first_data,
            "columns": columns,
            "rows": [{"row": r, "cells": [cell(_clip(c)) for c in grid[r]]} for r in chosen],
        }

    sample = build(HEAD_ROWS, SAMPLE_CELL_CHARS)
    for head_rows, clip in ((10, SAMPLE_CELL_CHARS), (5, SAMPLE_CELL_CHARS), (5, 60), (0, 60), (0, 30)):
        if len(str(sample)) <= SAMPLE_MAX_CHARS:
            break
        sample = build(head_rows, clip)
    return sample


_GLOSS_AFTER = re.compile(r"^(.*?)\s*[(（\[](.*?)[)）\]]$")
_GLOSS_BEFORE = re.compile(r"^[(（\[](.*?)[)）\]]\s*(.*)$")


def _same_heading(given: str, actual: str, headings: list[str]) -> bool:
    """Whether the heading the model gave is the table's. The column NUMBER is what the rules use; the echoed heading only guards against a misread
    number. A model that "copies" a Hebrew heading often adds a gloss ('ID (מזהה)', 'מזהה (ID)'), which is still the right column, so either side of
    one bracketed gloss may be the real heading. Mere containment is not enough ('Full Name' contains 'Name'), and a text that is another column's
    heading (`headings`: the header row) is that column."""
    real, said = fold(actual), fold(given)
    if said == real:
        return True
    if any(said == fold(h) or _glossed(said) & {fold(h)} for h in headings if fold(h) != real):
        return False
    return bool(real) and real in _glossed(said)


def _glossed(said: str) -> set[str]:
    """Both sides of one bracketed gloss in `said` ('x (y)', '(y) x'), or nothing."""
    for pattern in (_GLOSS_AFTER, _GLOSS_BEFORE):
        found = pattern.match(said)
        if found:
            return {part.strip() for part in found.groups() if part.strip()}
    return set()


def _shown(value: object) -> str:
    """A value quoted for a refusal message: one line, at most 40 characters (it is the file's own heading or value, never a long text)."""
    text = " ".join(str(value).split())
    return "'" + (text if len(text) <= 40 else text[:39] + "…") + "'"


def _level_cols(roles: dict[int, tuple[str, int | None]]) -> list[tuple[int, int]]:
    return sorted((level, col) for col, (role, level) in roles.items() if role == "level_title" and level is not None)


def check_spec(table: Table, spec: RuleSpec) -> str | None:
    """Why a spec cannot be used for `table`, or None. The checks that apply to a model's answer and to the result of voting alike."""
    rule = rule_from_spec(table, spec)
    if rule is None:
        return "the rules do not fit the table (a column or the header row is out of range)"
    total = len(rule.rows)
    if total == 0 or not rule.kept:
        return "no row would be imported with these rules"
    if sum(1 for r in rule.rows if r.title) / total < MIN_COVERAGE:
        return "the title is empty on too many rows"
    if spec.nesting in ("levels", "level_number", "outline_number") and sum(1 for r in rule.rows if r.level is not None) / total < MIN_COVERAGE:
        return "the depth of too many rows cannot be read with these rules"
    unresolved = [v for v in rule.violations if "is not a row of the file" in v]
    if spec.nesting == "id_parent" and len(unresolved) / total > 1 - MIN_COVERAGE:
        return "the parent of too many rows is not a row of the file"
    inversions = [v for v in rule.violations if v not in unresolved]
    if len(inversions) / len(rule.kept) > MAX_INVERSION_SHARE:
        return "too many rows nest in a way the Epic > Feature > Requirement ladder does not allow"
    # A table with a hierarchy whose rows that have children are nearly all Requirements has no Epic or Feature level: the signature of a type map
    # that calls everything a Requirement (a Requirement under a Requirement is allowed, so the nesting check above cannot see it).
    parents = {r.parent for r in rule.kept if r.parent is not None}
    if parents and sum(1 for p in parents if rule.rows[p].type in ("Epic", "Feature")) / len(parents) < MIN_SECTION_PARENT_SHARE:
        return "the rows that have children are mostly Requirements, so the table would have no Epic or Feature level"
    return None


def validate_table_answer(raw: dict, table: Table) -> RuleSpec | str:
    """The model's answer as a RuleSpec, or the reason it cannot be used. Checked against the table itself: the model can misread a column
    number, invent a heading or leave a value unmapped, and rules applied that way would turn every row into the wrong item."""
    grid = _grid(table)
    width = len(grid[0]) if grid else 0
    if raw.get("sheet_kind") != "work_items":
        return f"the model read this table as something other than a list of work items (it answered {_shown(raw.get('sheet_kind'))})"
    header_row = raw.get("header_row")
    if not isinstance(header_row, int) or isinstance(header_row, bool) or not 0 <= header_row <= min(MAX_HEADER_ROW, len(grid) - 2):
        return "the model gave no usable header row"
    entries = raw.get("columns")
    if not isinstance(entries, list):
        return "the model named no columns"
    roles: dict[int, tuple[str, int | None]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            return "the model's column list could not be read"
        column, role, header = entry.get("column"), entry.get("role"), entry.get("header")
        if not isinstance(column, int) or isinstance(column, bool) or not 0 <= column < width:
            return "the model named a column that is not in the table"
        if role not in ROLES or column in roles:
            return "the model gave a column an unknown role or two roles"
        if not isinstance(header, str) or not _same_heading(header, grid[header_row][column], grid[header_row]):
            return (
                f"the heading the model gave for column {column} ({_shown(header)}) is not the table's ({_shown(grid[header_row][column])})"
            )
        level = entry.get("level")
        roles[column] = (role, level if isinstance(level, int) and not isinstance(level, bool) else None)

    def only(role: str) -> int | None:
        found = [c for c, (r, _) in sorted(roles.items()) if r == role]
        return found[0] if len(found) == 1 else None

    for single in ("type", "level_number", "outline_number", "id", "parent_id", "title", "customer_id"):
        if sum(1 for r, _ in roles.values() if r == single) > 1:
            return f"the model gave more than one {single} column"
    nesting = _NESTING_FROM_MODEL.get(str(raw.get("nesting")))
    if nesting is None:
        return "the model could not say how the rows nest"
    levels = _level_cols(roles)
    title_col, type_col = only("title"), only("type")
    level_col = only("level_number") if nesting == "level_number" else only("outline_number") if nesting == "outline_number" else None
    if nesting == "levels":
        if len(levels) < 2 or [lv for lv, _ in levels] != list(range(1, len(levels) + 1)):
            return "the model named fewer than two level columns, or numbered them out of order"
    elif nesting in ("level_number", "outline_number"):
        if level_col is None or title_col is None:
            return "the model gave no depth column or no title column for the depth it chose"
    elif nesting == "id_parent":
        if only("id") is None or only("parent_id") is None or title_col is None:
            return "the model gave no id, parent or title column for the parent links it chose"
    elif type_col is None or title_col is None:
        return "row order needs a type column and a title column"

    data = grid[header_row + 1 :]
    type_map: dict[str, str | None] | None = None
    level_types: dict[int, str] | None = None
    if type_col is not None:
        said: dict[str, str | None] = {}
        for item in raw.get("type_values") if isinstance(raw.get("type_values"), list) else []:
            if not isinstance(item, dict) or not isinstance(item.get("value"), str):
                return "the model's type values could not be read"
            mapped = _MAPS_TO.get(str(item.get("maps_to")))
            key = fold(item["value"])
            if key in said and said[key] != mapped:
                return f"the model mapped the type value '{item['value']}' two ways"
            said[key] = mapped
        # The map is built from the file's own values, never from the model's spellings: a model that adds a gloss ('אפיק (Epic)') or changes a quote
        # still maps the value it was shown, and the stored rulebook says what the file says.
        type_map = {}
        for value in dict.fromkeys(fold(row[type_col]) for row in data if row[type_col].strip()):
            if value in said:
                type_map[value] = said[value]
                continue
            hits = {mapped for key, mapped in said.items() if value in key}
            if len(hits) != 1:
                return f"the model did not map the type value '{value}'" if not hits else f"the model mapped the type value '{value}' more than one way"
            type_map[value] = hits.pop()
        values = [fold(row[type_col]) for row in data if row[type_col].strip()]
        if not values or sum(1 for v in values if type_map[v]) / len(values) < MIN_LADDER_SHARE:
            return "too few rows have a type that maps to Epic, Feature or Requirement"
    else:
        level_types = {}
        for item in raw.get("level_types") if isinstance(raw.get("level_types"), list) else []:
            level, mapped = item.get("level") if isinstance(item, dict) else None, _MAPS_TO.get(str(item.get("maps_to")) if isinstance(item, dict) else "")
            if isinstance(level, int) and not isinstance(level, bool) and level >= 1 and mapped:
                level_types[level - 1] = mapped
        if not level_types or nesting not in ("levels", "level_number", "outline_number"):
            return "the table has no type column and the model gave no type for each depth"

    spec = RuleSpec(
        header_row=header_row,
        nesting=nesting,
        type_col=type_col,
        level_cols=tuple(c for _, c in levels) if nesting == "levels" else (),
        level_col=level_col,
        title_col=title_col if nesting != "levels" else None,
        id_col=only("id"),
        parent_col=only("parent_id"),
        customer_id_col=only("customer_id"),
        description_cols=tuple(c for c, (r, _) in sorted(roles.items()) if r == "description"),
        type_map=type_map,
        level_types=level_types,
        origin="model",
    )
    return check_spec(table, spec) or spec


def _atoms(spec: RuleSpec) -> dict[tuple, object]:
    atoms: dict[tuple, object] = {
        ("header_row",): spec.header_row,
        ("nesting",): spec.nesting,
        ("type_col",): spec.type_col,
        ("level_cols",): spec.level_cols,
        ("level_col",): spec.level_col,
        ("title_col",): spec.title_col,
        ("id_col",): spec.id_col,
        ("parent_col",): spec.parent_col,
        ("customer_id_col",): spec.customer_id_col,
    }
    for column in spec.description_cols:
        atoms[("description", column)] = True
    for value, mapped in (spec.type_map or {}).items():
        atoms[("type", value)] = mapped
    for depth, mapped in (spec.level_types or {}).items():
        atoms[("depth", depth)] = mapped
    return atoms


def _majority(values: list[object], total: int) -> tuple[bool, object]:
    """(found, value): the value more than half of the `total` answers agree on."""
    counts = Counter(values)
    value, count = counts.most_common(1)[0]
    return (count * 2 > total, value)


def vote_specs(specs: list[RuleSpec], table: Table) -> RuleSpec | str:
    """One spec from several validated ones: each field is what more than half of them say; a field they do not agree on is unknown, and an
    unknown structural field fails the table (never a guess). The result is checked against the table again."""
    total = len(specs)
    if total == 1:
        return specs[0]
    atoms = [_atoms(s) for s in specs]
    decided: dict[tuple, object] = {}
    for key in dict.fromkeys(k for a in atoms for k in a):
        present = [a[key] for a in atoms if key in a]
        found, value = _majority(present, total)
        if key[0] in ("description", "type", "depth"):
            if found:
                decided[key] = value
            elif key[0] == "type":
                decided[key] = None  # a value the answers disagree on is not imported
            continue
        if not found:
            return f"the model's answers disagree on {key[0]}"
        decided[key] = value
    for key in (("header_row",), ("nesting",), ("type_col",), ("level_cols",), ("level_col",), ("title_col",), ("id_col",), ("parent_col",), ("customer_id_col",)):
        if key not in decided:
            return f"the model's answers disagree on {key[0]}"
    type_map = {k[1]: v for k, v in decided.items() if k[0] == "type"}
    level_types = {k[1]: v for k, v in decided.items() if k[0] == "depth"}
    spec = RuleSpec(
        header_row=decided[("header_row",)],  # type: ignore[arg-type]
        nesting=decided[("nesting",)],  # type: ignore[arg-type]
        type_col=decided[("type_col",)],  # type: ignore[arg-type]
        level_cols=decided[("level_cols",)],  # type: ignore[arg-type]
        level_col=decided[("level_col",)],  # type: ignore[arg-type]
        title_col=decided[("title_col",)],  # type: ignore[arg-type]
        id_col=decided[("id_col",)],  # type: ignore[arg-type]
        parent_col=decided[("parent_col",)],  # type: ignore[arg-type]
        customer_id_col=decided[("customer_id_col",)],  # type: ignore[arg-type]
        description_cols=tuple(sorted(k[1] for k in decided if k[0] == "description")),  # type: ignore[type-var]
        type_map=type_map if decided[("type_col",)] is not None else None,
        level_types=level_types or None,
        origin="model",
    )
    return check_spec(table, spec) or spec


class TransientReason(str):
    """Why no answer could be used, when the model could not be reached for enough of the votes (an error, a timeout, a budget refusal):
    not a reading of the file, so it is never kept as one (the orchestrator stores only settled readings)."""


def _ask(
    ask: Callable[[int, Callable[[dict], bool]], dict],
    validate: Callable[[dict], object | str],
    votes: int,
    describe: str,
) -> tuple[list, str | None]:
    """Asks `votes` times and returns the validated answers; the reason when none can be used. A cancelled run always propagates. The asks run
    at once (up to prestudy_vote_concurrency), and their answers are read in vote order, so the result does not depend on which came back first."""

    def accept(raw: dict) -> bool:
        return not isinstance(validate(raw), str)

    def one(vote: int) -> tuple[object, Exception | None]:
        try:
            return ask(vote, accept), None
        except JobCancelled:
            raise
        except Exception as error:  # noqa: BLE001 -- a failed ask is one answer short, reported; the file stays on the deterministic path
            return None, error

    workers = min(votes, settings.prestudy_vote_concurrency)
    if workers > 1:
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="prestudy") as pool:
            futures = [submit_in_context(pool, one, vote) for vote in range(votes)]
            results = [future.result() for future in futures]
    else:
        results = [one(vote) for vote in range(votes)]
    answers: list = []
    reasons: list[str] = []
    errors = 0
    for vote, (raw, error) in enumerate(results):
        if error is not None:
            errors += 1
            logger.warning("Pre-study ask %d for %s failed: %s", vote, describe, error, exc_info=error)
            reasons.append("the model could not be asked")
            continue
        checked = validate(raw) if isinstance(raw, dict) else "the answer could not be read"
        if isinstance(checked, str):
            reasons.append(checked)
            # What the model answered, without any of the file's text: enough to tell a model that did not follow the format from one that misread the file.
            logger.info(
                "Pre-study answer %d for %s refused (%s); shape: %s",
                vote,
                describe,
                checked,
                {k: (v if isinstance(v, (str, int, bool, type(None))) else f"{type(v).__name__}[{len(v)}]") for k, v in raw.items()}
                if isinstance(raw, dict)
                else type(raw).__name__,
            )
        else:
            answers.append(checked)
    needed = 1 if votes == 1 else 2
    if len(answers) < needed:
        reason = (reasons[0] if reasons else "no usable answer") + (f" ({len(answers)} of {votes} answers usable)" if votes > 1 else "")
        # Errors decided it when the votes that did answer, plus the ones that errored, could have been enough.
        return [], TransientReason(reason) if errors and len(answers) + errors >= needed else reason
    return answers, None


def study_table_with_model(
    table: Table, client: FileRulesStudyClient, user_id: str | None = None, votes: int = 3
) -> tuple[RuleSpec | None, str | None]:
    """(spec, None) when the model's answers, validated and voted, give usable rules for `table`; (None, reason) otherwise."""
    sample = table_sample(table)
    answers, reason = _ask(
        lambda vote, accept: client.study_file_rules_table(sample, user_id=user_id, vote=vote, accept=accept),
        lambda raw: validate_table_answer(raw, table),
        votes,
        f"table {table.id}",
    )
    if reason is not None:
        return None, reason
    voted = vote_specs(answers, table)
    return (None, voted) if isinstance(voted, str) else (voted, None)


# --------------------------------------------------------------------------------------------------------------------------------------------
# Documents
# --------------------------------------------------------------------------------------------------------------------------------------------


def document_headings(doc: CanonicalDoc) -> list[dict]:
    """Every heading-like block of the document with the file's own number for it (`i`), its heading level, its nesting depth under the open
    headings (0 = outermost, the depth a built item has), its number label and its text after the number."""
    headings: list[dict] = []
    open_levels: list[int] = []
    for block in doc.blocks:
        level, _ = resolve_block_depth(block)
        if level is None or block.kind not in (BlockKind.HEADING, BlockKind.PARAGRAPH):
            continue
        while open_levels and open_levels[-1] >= level:
            open_levels.pop()
        label, remainder = parse_numbering(block.text)
        headings.append(
            {
                "i": len(headings),
                "level": level,
                "depth": len(open_levels),
                "number": label,
                "text": " ".join((remainder if label else block.text).split()),
                "block_id": block.id,
            }
        )
        open_levels.append(level)
    return headings


_LEADING = re.compile(r"^(?P<label>[^\s:\-–—.]+(?:\s[^\s:\-–—.]+)?)\s*(?P<sep>[:\-–—.])\s+\S")


def _leading_patterns(headings: list[dict]) -> list[dict]:
    seen: dict[tuple[str, str], list[int]] = {}
    for h in headings:
        match = _LEADING.match(h["text"])
        if match:
            seen.setdefault((match["label"], match["sep"]), []).append(h["i"])
    ranked = sorted(seen.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    return [
        {"label": label, "separator": sep, "count": len(ids), "headings": ids[:5]}
        for (label, sep), ids in ranked
        if len(ids) >= 2
    ][:12]


def document_sample(doc: CanonicalDoc, cover: list[dict] | None = None) -> dict:
    """The outline the model reads. `cover` is cover_lines() of the WHOLE document: the outline itself has the cover left out."""
    headings = document_headings(doc)
    patterns = _leading_patterns(headings)
    shown = headings
    if len(headings) > MAX_HEADINGS:
        keep = {h["i"] for h in headings[:150]} | {h["i"] for h in headings[-50:]}
        per_level: Counter = Counter()
        for h in headings:
            per_level[h["level"]] += 1
            if per_level[h["level"]] <= 10:
                keep.add(h["i"])
        for pattern in patterns:
            keep.update(pattern["headings"][:3])
        shown = [h for h in headings if h["i"] in keep]
    bodies = _heading_bodies(doc)
    return {
        "headingCount": len(headings),
        "headings": [
            {
                "i": h["i"],
                "level": h["level"],
                "depth": h["depth"],
                "number": h["number"],
                "text": _clip(h["text"]),
                **bodies.get(h["block_id"], {}),
            }
            for h in shown
        ],
        "leadingPatterns": patterns,
        "levelCounts": dict(sorted(Counter(h["level"] for h in headings).items())),
        "depthCounts": dict(sorted(Counter(h["depth"] for h in headings).items())),
        "codeCandidates": _code_candidates(doc),
        "coverLines": list(cover or []),
    }


MAX_COVER_LINES = 25


def cover_lines(doc: CanonicalDoc) -> list[dict]:
    """The lines of the cover, numbered (`j`) for the model to name the title by: the first page's blocks, or, for a file without pages, the
    blocks before its first numbered heading. The model picks the title's lines; code joins them (validate_profile)."""
    paged = any(b.source_ref.page for b in doc.blocks)
    lines: list[dict] = []
    for block in doc.blocks:
        if paged and block.source_ref.page not in (None, 1):
            break
        numbered = block.kind == BlockKind.HEADING and (
            block.number_label or parse_numbering(block.text)[0]
        )
        if not paged and numbered:
            break
        text = " ".join(block.text.split())
        if text and block.kind in (BlockKind.HEADING, BlockKind.PARAGRAPH, BlockKind.NOTE):
            lines.append({"j": len(lines), "text": _clip(text)})
        if len(lines) >= MAX_COVER_LINES:
            break
    return lines



# The code shapes shown to the model (most frequent first), with this many example codes and one example paragraph each.
MAX_CODE_SHAPES = 4
CODE_EXAMPLES = 6


def _body_paragraphs(doc: CanonicalDoc) -> list[str]:
    return [b.text for b in doc.blocks if b.kind in (BlockKind.PARAGRAPH, BlockKind.LIST_ITEM)]


def _code_candidates(doc: CanonicalDoc) -> list[dict]:
    """The shapes of the code-like tokens that open paragraphs (leveling/code_shape.py): the model names which, if any, is the document's
    requirement code by copying example codes."""
    out = []
    paragraphs = _body_paragraphs(doc)
    for shape, tokens in shape_candidates(paragraphs)[:MAX_CODE_SHAPES]:
        sample = next((t for t in paragraphs if leading_code_token(t) == tokens[0]), "")
        out.append({"shape": shape, "count": len(tokens), "examples": sorted(set(tokens))[:CODE_EXAMPLES], "sample": _clip(sample)})
    return out


def _heading_bodies(doc: CanonicalDoc) -> dict[str, dict]:
    """Per heading block id, what its own text (up to the next heading) holds: how many paragraphs open with a code-like token, how many
    tables, whether it states an obligation, and its text when it is a one-line marker ("None.", "Not applicable.")."""
    from app.leveling.document_grammar import MAX_MARKER_WORDS, OBLIGATION

    stats: dict[str, dict] = {}
    current: str | None = None
    texts: dict[str, list[str]] = {}
    for block in doc.blocks:
        if block.kind == BlockKind.HEADING:
            current = block.id
            texts[current] = []
        elif current is not None and block.kind in (BlockKind.PARAGRAPH, BlockKind.LIST_ITEM, BlockKind.NOTE, BlockKind.OPEN_TBD):
            texts[current].append(block.text)
    tables_by_heading: Counter = Counter()
    heading_order = [(b.id, (b.source_ref.page or 0, b.source_ref.start_offset)) for b in doc.blocks if b.kind == BlockKind.HEADING]
    for table in doc.tables:
        key = (table.source_ref.page or 0, table.source_ref.start_offset)
        owner = None
        for heading_id, order in heading_order:
            if order <= key:
                owner = heading_id
        if owner is not None:
            tables_by_heading[owner] += 1
    for heading_id, body in texts.items():
        joined = " ".join(" ".join(body).split())
        entry = {
            "coded": sum(1 for t in body if leading_code_token(t) is not None),
            "tables": tables_by_heading[heading_id],
            "obligation": bool(OBLIGATION.search(joined)),
        }
        if len(body) == 1 and 0 < len(joined.split()) <= MAX_MARKER_WORDS:
            entry["marker"] = joined
        stats[heading_id] = entry
    return stats


_RANK = {name: rank for rank, name in enumerate(LADDER)}


# Front matter may not be more than this share of the document's blocks: an answer that would leave out the body is refused.
MAX_FRONT_MATTER_SHARE = 0.5


def validate_front_matter(raw: dict, headings: list[dict], doc: CanonicalDoc | None) -> tuple[FrontMatterPart, ...]:
    """The headings the model named as opening front matter, each checked against the document: the heading exists, its role is known, its
    section holds no requirement code (a section with requirements is never front matter), and together they are at most
    MAX_FRONT_MATTER_SHARE of the blocks. A part that fails is dropped on its own; it never refuses the rest of the answer."""
    if doc is None or not isinstance(raw.get("front_matter_headings"), list):
        return ()
    by_i = {h["i"]: h for h in headings}
    parts: dict[str, FrontMatterPart] = {}
    covered: set[str] = set()
    for item in raw["front_matter_headings"]:
        if not isinstance(item, dict):
            continue
        i, role = item.get("i"), item.get("role")
        if not isinstance(i, int) or isinstance(i, bool) or i not in by_i or role not in FRONT_MATTER_ROLES:
            continue
        block_id = by_i[i]["block_id"]
        section, _tables = section_of(doc, block_id)
        if not section or any(opens_a_requirement(b.text) for b in section):
            continue
        parts[block_id] = FrontMatterPart(block_id, role)
        covered.update(b.id for b in section)
    if doc.blocks and len(covered) > MAX_FRONT_MATTER_SHARE * len(doc.blocks):
        return ()
    return tuple(sorted(parts.values(), key=lambda p: p.block_id))


def validate_document_answer(
    raw: dict, headings: list[dict], doc: CanonicalDoc | None = None, cover: list[dict] | None = None
) -> DocumentRules | str:
    """The model's answer as DocumentRules, or the reason it cannot be used. Labels are recounted over every heading of the document; front
    matter is checked against the document (validate_front_matter)."""
    labels: list[LabelRule] = []
    seen: set[str] = set()
    for item in raw.get("labels") if isinstance(raw.get("labels"), list) else []:
        if not isinstance(item, dict):
            return "the model's label list could not be read"
        label, sep, mapped = item.get("label"), item.get("separator"), _MAPS_TO.get(str(item.get("maps_to")))
        if isinstance(label, str):
            label = re.sub(r"\s*\([^)]*\)\s*$", "", label).strip()  # a gloss the model added: 'יכולת (Feature)'
        if not isinstance(label, str) or not label.strip() or len(label) > 40 or sep not in LABEL_SEPARATORS or mapped is None:
            continue
        if fold(label) in seen:
            continue
        starts = [h for h in headings if _starts_with_label(h["text"], label, sep)]
        if len(starts) < MIN_LABELLED:
            continue
        seen.add(fold(label))
        labels.append(LabelRule(label.strip(), sep, mapped))
    if labels:
        by_i = {h["i"]: r for h in headings if (r := _label_of(h["text"], labels)) is not None}
        if len(by_i) / len(headings) < MIN_LABELLED_SHARE:
            labels = []
        else:
            parent_of: dict[int, int | None] = {}
            stack: list[dict] = []
            for h in headings:
                while stack and stack[-1]["level"] >= h["level"]:
                    stack.pop()
                parent_of[h["i"]] = stack[-1]["i"] if stack else None
                stack.append(h)
            pairs = [(by_i[i], by_i[p]) for i, p in parent_of.items() if p is not None and i in by_i and p in by_i]
            if pairs and sum(1 for child, parent in pairs if _RANK[child.type] < _RANK[parent.type]) / len(pairs) > MAX_INVERSION_SHARE:
                return "the labels the model named contradict how the headings nest"
    depth_types: list[tuple[int, str]] = []
    for item in raw.get("depth_types") if isinstance(raw.get("depth_types"), list) else []:
        depth, mapped = (item.get("depth"), _MAPS_TO.get(str(item.get("maps_to")))) if isinstance(item, dict) else (None, None)
        if isinstance(depth, int) and not isinstance(depth, bool) and 0 <= depth <= 9 and mapped:
            depth_types.append((depth, mapped))
    depth_types = sorted(dict(depth_types).items())
    present = {h["depth"] for h in headings}
    if any(depth not in present for depth, _ in depth_types):
        return "the model gave a type for a depth the document does not have"
    if any(_RANK[b] < _RANK[a] for (_, a), (_, b) in zip(depth_types, depth_types[1:])):
        return "the types the model gave for each depth go back up the ladder"
    front_matter = validate_front_matter(raw, headings, doc)
    grammar = validate_grammar(raw, headings, doc)
    profile = validate_profile(raw, headings, cover)
    if not labels and not depth_types and not front_matter and not any(grammar.values()):
        return "the model found no type, no front matter and no grammar the document states"
    return DocumentRules(
        labels=tuple(labels), depth_types=tuple(depth_types), origin="model", front_matter=front_matter, **grammar, **profile
    )


# A cover line that only marks the document is never its title.
_MARKING = re.compile(
    r"^(company |commercial )?(confidential|restricted|secret|internal|proprietary|draft|unclassified|not classified)\b",
    re.I,
)
MAX_TITLE_LINE_WORDS = 15
MAX_PROPOSALS = 10
MAX_SPELLING_CHANGES = 2  # words changed in one heading
MAX_SPELLING_DISTANCE = 2  # edits per changed word
MIN_SPELLING_WORD = 4
_STOP = frozenset("a an and the of for in on to with by or at as from its".split())


def _edit_distance(a: str, b: str) -> int:
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def _words(text: str) -> list[str]:
    return re.findall(r"\w+", fold(text))


def _grounded(title: str, pool: str) -> bool:
    """Every significant word of a proposed name is in `pool` (the section's sub-headings, the cover title): the same word, or one sharing
    its first five letters ("Environment" from "Environmental conditions")."""
    have = set(_words(pool))
    wanted = [w for w in _words(title) if w not in _STOP and len(w) > 1]
    return bool(wanted) and all(
        w in have or (len(w) >= 5 and any(h[:5] == w[:5] for h in have if len(h) >= 5))
        for w in wanted
    )


def _descendants(headings: list[dict], i: int) -> list[dict]:
    """The headings under heading `i`: those after it, deeper than it, until one at its depth or shallower."""
    index = next((k for k, h in enumerate(headings) if h["i"] == i), None)
    if index is None:
        return []
    out = []
    for h in headings[index + 1 :]:
        if h["depth"] <= headings[index]["depth"]:
            break
        out.append(h)
    return out


def validate_profile(raw: dict, headings: list[dict], cover: list[dict] | None) -> dict:
    """The document profile the model named, each part checked on its own (a part that fails is dropped, never the answer):
    * document_kind, title_policy: one of the known values;
    * cover_title_lines: 1 to 4 adjacent cover lines, none a marking or a notice; code joins them into the cover title;
    * proposals: a heading of the document; drop_wrapper only for a heading with sections under it; a rename only to a name grounded in its
      sub-headings or the cover title, and different from the heading;
    * spelling_fixes: the same words, at most MAX_SPELLING_CHANGES changed, each by at most MAX_SPELLING_DISTANCE edits."""
    result: dict = {
        "document_kind": None,
        "cover_title": None,
        "proposals": (),
        "spelling_fixes": (),
        "title_policy": None,
    }
    if raw.get("document_kind") in DOCUMENT_KINDS:
        result["document_kind"] = raw["document_kind"]
    if raw.get("title_policy") in TITLE_POLICIES:
        result["title_policy"] = raw["title_policy"]

    by_j = {line["j"]: line["text"] for line in cover or []}
    picked = raw.get("cover_title_lines")
    if (
        isinstance(picked, list)
        and 0 < len(picked) <= 4
        and all(isinstance(j, int) and not isinstance(j, bool) for j in picked)
    ):
        js = sorted(set(picked))
        texts = [by_j.get(j) for j in js]
        if (
            all(texts)
            and all(b - a == 1 for a, b in zip(js, js[1:]))
            and not any(_MARKING.match(t) or len(t.split()) > MAX_TITLE_LINE_WORDS for t in texts)  # type: ignore[arg-type]
        ):
            result["cover_title"] = " ".join(texts)  # type: ignore[arg-type]

    by_i = {h["i"]: h for h in headings}
    proposals: list[Proposal] = []
    seen: set[str] = set()
    for item in (raw.get("proposals") if isinstance(raw.get("proposals"), list) else [])[
        : MAX_PROPOSALS * 2
    ]:
        if not isinstance(item, dict) or item.get("action") not in PROPOSAL_ACTIONS:
            continue
        i = item.get("i")
        heading = by_i.get(i) if isinstance(i, int) and not isinstance(i, bool) else None
        if heading is None or heading["block_id"] in seen:
            continue
        below = _descendants(headings, heading["i"])
        reason = " ".join(str(item.get("reason") or "").split())[:300]
        if item["action"] == "drop_wrapper":
            if not below:
                continue
            proposal = Proposal(heading["block_id"], "drop_wrapper", None, reason)
        else:
            new_title = " ".join(str(item.get("new_title") or "").split())
            pool = " ".join([*(h["text"] for h in below), result["cover_title"] or ""])
            if (
                not new_title
                or len(new_title) > 80
                or fold(new_title) == fold(heading["text"])
                or not _grounded(new_title, pool)
            ):
                continue
            proposal = Proposal(heading["block_id"], "rename", new_title, reason)
        seen.add(heading["block_id"])
        proposals.append(proposal)
    result["proposals"] = tuple(proposals[:MAX_PROPOSALS])

    fixes: list[tuple[str, str]] = []
    for item in raw.get("spelling_fixes") if isinstance(raw.get("spelling_fixes"), list) else []:
        i = item.get("i") if isinstance(item, dict) else None
        heading = by_i.get(i) if isinstance(i, int) and not isinstance(i, bool) else None
        fixed = " ".join(str(item.get("fixed") or "").split()) if heading else ""
        if heading is None or not fixed:
            continue
        before, after = heading["text"].split(), fixed.split()
        changed = [(a, b) for a, b in zip(before, after) if a != b]
        if (
            len(before) == len(after)
            and 0 < len(changed) <= MAX_SPELLING_CHANGES
            and all(
                min(len(a), len(b)) >= MIN_SPELLING_WORD
                and fold(a) != fold(b)
                and _edit_distance(fold(a), fold(b)) <= MAX_SPELLING_DISTANCE
                for a, b in changed
            )
        ):
            fixes.append((heading["block_id"], fixed))
    result["spelling_fixes"] = tuple(sorted(dict(fixes).items()))
    return result



def validate_grammar(raw: dict, headings: list[dict], doc: CanonicalDoc | None) -> dict:
    """The grammar the model named, each part checked against the document on its own (a part that fails is dropped, never the answer):
      * requirement_codes: every code opens a paragraph of the document, they share one shape, and that shape opens at least
        MIN_UNITS paragraphs;
      * leaf_convention, empty_sections: one of the known values (anything else is no answer);
      * context_headings: sections with no paragraph opened by the requirement code and no requirement;
      * back_matter_headings: the same, and after the last requirement of the document."""
    from app.leveling.document_grammar import MIN_UNITS
    from app.study.rulebook import EMPTY_TREATMENTS, LEAF_CONVENTIONS

    result: dict = {
        "requirement_codes": (),
        "leaf_convention": None,
        "empty_treatment": None,
        "context_headings": (),
        "back_matter_headings": (),
    }
    if doc is None:
        return result
    paragraphs = _body_paragraphs(doc)
    opening = {leading_code_token(t) for t in paragraphs} - {None}
    codes = raw.get("requirement_codes")
    shape: CodeShape | None = None
    if isinstance(codes, list) and codes and all(isinstance(c, str) for c in codes):
        named = sorted({c.strip() for c in codes if c.strip()})[:12]
        shape = CodeShape.from_examples(named) if all(c in opening for c in named) else None
        if shape is not None and sum(1 for t in paragraphs if shape.opens(t)) >= MIN_UNITS:
            result["requirement_codes"] = tuple(named)
        else:
            shape = None
    if raw.get("leaf_convention") in LEAF_CONVENTIONS:
        result["leaf_convention"] = raw["leaf_convention"]
    if raw.get("empty_sections") in EMPTY_TREATMENTS:
        result["empty_treatment"] = raw["empty_sections"]

    # With no confirmed code, the shape code learns on its own guards the sections: a section with coded requirements is never context.
    guard = shape or learn_code_shape(paragraphs)

    def opens_requirement(text: str) -> bool:
        return opens_a_requirement(text) or (guard is not None and guard.opens(text))

    by_i = {h["i"]: h for h in headings}
    order = {b.id: k for k, b in enumerate(doc.blocks)}
    last_requirement = max((order[b.id] for b in doc.blocks if opens_requirement(b.text)), default=-1)

    def free_of_requirements(i: object) -> str | None:
        if not isinstance(i, int) or isinstance(i, bool) or i not in by_i:
            return None
        block_id = by_i[i]["block_id"]
        section, _tables = section_of(doc, block_id)
        if not section or any(opens_requirement(b.text) for b in section):
            return None
        return block_id

    context = raw.get("context_headings") if isinstance(raw.get("context_headings"), list) else []
    result["context_headings"] = tuple(sorted({b for b in map(free_of_requirements, context) if b}))
    back = raw.get("back_matter_headings") if isinstance(raw.get("back_matter_headings"), list) else []
    result["back_matter_headings"] = tuple(
        sorted({b for b in map(free_of_requirements, back) if b and order.get(b, -1) > last_requirement})
    )
    return result


def _label_of(text: str, labels: list[LabelRule]) -> LabelRule | None:
    return next((r for r in labels if _starts_with_label(text, r.label, r.separator)), None)


def _starts_with_label(text: str, label: str, separator: str) -> bool:
    folded = fold(text)
    prefix = fold(label)
    return folded.startswith(prefix) and folded[len(prefix) :].lstrip().startswith(separator) and len(folded) > len(prefix) + 1


def document_details(doc: CanonicalDoc, rules: DocumentRules) -> dict | None:
    """About how many headings of each type the rules state, with a few examples, for the wizard. Approximate by design: the build also folds,
    drops and adds headings (front matter, repeated titles, missing parents), and a heading the rules do not type is typed by its shape, not counted
    here. None when the rules state no type."""
    if not rules.labels and not rules.depth_types:
        return None
    by_depth = dict(rules.depth_types)
    counts: Counter = Counter()
    samples: dict[str, list[dict]] = {}
    open_headings: list[dict] = []
    for heading in document_headings(doc):
        while open_headings and open_headings[-1]["depth"] >= heading["depth"]:
            open_headings.pop()
        label = _label_of(heading["text"], list(rules.labels))
        stated = label.type if label is not None else by_depth.get(heading["depth"])
        if stated is not None:
            counts[stated] += 1
            bucket = samples.setdefault(stated, [])
            if len(bucket) < DETAIL_SAMPLES:
                parent = open_headings[-1]["text"] if open_headings else None
                bucket.append({"row": None, "title": clip_detail(heading["text"]), "parent": clip_detail(parent) if parent else None})
        open_headings.append(heading)
    return {"typeCounts": {t: counts[t] for t in LADDER}, "samples": samples, "approximate": True}


def vote_documents(rules: list[DocumentRules]) -> DocumentRules:
    total = len(rules)
    if total == 1:
        return rules[0]
    label_votes: dict[tuple[str, str], Counter] = {}
    original: dict[tuple[str, str], str] = {}
    depth_votes: dict[int, Counter] = {}
    for r in rules:
        for label in r.labels:
            key = (fold(label.label), label.separator)
            label_votes.setdefault(key, Counter())[label.type] += 1
            original.setdefault(key, label.label)
        for depth, mapped in r.depth_types:
            depth_votes.setdefault(depth, Counter())[mapped] += 1
    labels = tuple(
        LabelRule(original[key], key[1], counts.most_common(1)[0][0])
        for key, counts in sorted(label_votes.items())
        if counts.most_common(1)[0][1] * 2 > total
    )
    depths = tuple(
        (depth, counts.most_common(1)[0][0])
        for depth, counts in sorted(depth_votes.items())
        if counts.most_common(1)[0][1] * 2 > total
    )
    front_votes: dict[str, Counter] = {}
    for r in rules:
        for part in r.front_matter:
            front_votes.setdefault(part.block_id, Counter())[part.role] += 1
    front = tuple(
        FrontMatterPart(block_id, counts.most_common(1)[0][0])
        for block_id, counts in sorted(front_votes.items())
        if sum(counts.values()) * 2 > total  # a majority calls it front matter; the role is the most named one
    )
    return DocumentRules(
        labels=labels, depth_types=depths, origin="model", front_matter=front, **_vote_grammar(rules), **_vote_profile(rules)
    )


def _vote_profile(rules: list[DocumentRules]) -> dict:
    """Each profile part by strict majority: the kind, the policy and the cover title by value (the title compared folded), each proposal by
    its heading, action and folded new name (the shown reason is the first in sorted order, so the result does not depend on arrival order),
    each spelling fix by heading and text. A part with no majority is no answer."""
    total = len(rules)

    def majority(values: list) -> object | None:
        counts = Counter(v for v in values if v)
        if not counts:
            return None
        value, count = sorted(counts.items(), key=lambda kv: (-kv[1], str(kv[0])))[0]
        return value if count * 2 > total else None

    titles: dict[str, list[str]] = {}
    for r in rules:
        if r.cover_title:
            titles.setdefault(fold(r.cover_title), []).append(r.cover_title)
    title_key = majority([fold(r.cover_title) if r.cover_title else None for r in rules])
    proposal_votes: dict[tuple[str, str, str], list[Proposal]] = {}
    for r in rules:
        for p in r.proposals:
            proposal_votes.setdefault((p.block_id, p.action, fold(p.new_title or "")), []).append(p)
    proposals = tuple(
        Proposal(
            key[0],
            key[1],
            min(p.new_title for p in group) if key[1] == "rename" else None,
            min(p.reason for p in group),
        )  # type: ignore[type-var]
        for key, group in sorted(proposal_votes.items())
        if len(group) * 2 > total
    )
    fix_votes = Counter(f for r in rules for f in r.spelling_fixes)
    return {
        "document_kind": majority([r.document_kind for r in rules]),
        "cover_title": min(titles[title_key]) if title_key else None,  # type: ignore[index]
        "proposals": proposals,
        "spelling_fixes": tuple(sorted(f for f, n in fix_votes.items() if n * 2 > total)),
        "title_policy": majority([r.title_policy for r in rules]),
    }



def _vote_grammar(rules: list[DocumentRules]) -> dict:
    """Each grammar part by strict majority: the requirement code by the pattern its examples induce (the examples of that majority are
    pooled), the conventions by value, and each context or back-matter heading on its own. A part with no majority is no answer."""
    total = len(rules)

    def majority(values: list) -> object | None:
        counts = Counter(v for v in values if v)
        if not counts:
            return None
        value, count = sorted(counts.items(), key=lambda kv: (-kv[1], str(kv[0])))[0]
        return value if count * 2 > total else None

    patterns = {r.requirement_codes: getattr(CodeShape.from_examples(r.requirement_codes), "pattern", None) for r in rules if r.requirement_codes}
    winner = majority([patterns.get(r.requirement_codes) for r in rules])
    codes = tuple(sorted({c for r in rules if r.requirement_codes and patterns.get(r.requirement_codes) == winner for c in r.requirement_codes}))[:12] if winner else ()

    def headings(attr: str) -> tuple[str, ...]:
        votes = Counter(h for r in rules for h in getattr(r, attr))
        return tuple(sorted(h for h, n in votes.items() if n * 2 > total))

    return {
        "requirement_codes": codes,
        "leaf_convention": majority([r.leaf_convention for r in rules]),
        "empty_treatment": majority([r.empty_treatment for r in rules]),
        "context_headings": headings("context_headings"),
        "back_matter_headings": headings("back_matter_headings"),
    }


def study_document_with_model(
    doc: CanonicalDoc,
    client: FileRulesStudyClient,
    user_id: str | None = None,
    votes: int = 3,
    cover: list[dict] | None = None,
) -> tuple[DocumentRules | None, str | None]:
    """`cover` is cover_lines() of the whole document (`doc` here has its cover left out)."""
    headings = document_headings(doc)
    if len(headings) < MIN_DOCUMENT_HEADINGS:
        return None, None
    sample = document_sample(doc, cover=cover)
    answers, reason = _ask(
        lambda vote, accept: client.study_file_rules_document(
            sample, user_id=user_id, vote=vote, accept=accept
        ),
        lambda raw: validate_document_answer(raw, headings, doc, cover=cover),
        votes,
        "the document",
    )
    if reason is not None:
        return None, reason
    voted = vote_documents(answers)
    # Each answer passed validation only by stating something (a type, front matter or a grammar); the vote keeps what a majority agrees on.
    if (
        not voted.labels
        and not voted.depth_types
        and not voted.front_matter
        and not voted.has_grammar()
    ):
        return None, "the model's answers disagree on what the document states"
    return voted, None


# --------------------------------------------------------------------------------------------------------------------------------------------
# The whole file
# --------------------------------------------------------------------------------------------------------------------------------------------


def _has_running_text(doc: CanonicalDoc) -> bool:
    from app.leveling.tree_builder import _is_unsupported_content_note

    return any(not _is_unsupported_content_note(b) for b in doc.blocks)


def prestudy(
    doc: CanonicalDoc,
    client: FileRulesStudyClient,
    user_id: str | None = None,
    votes: int | None = None,
) -> tuple[FileRulebook, list[IntegrityWarning]]:
    """What the model learned about the conventions of `doc` that the header detectors do not cover, and a warning per table or document it was
    asked about (what was learned, or why it was refused). Never raises for a model that fails or answers badly; a cancelled run propagates."""
    votes = votes or settings.prestudy_votes
    warnings: list[IntegrityWarning] = []
    tables: dict[str, RuleSpec] = {}
    document: DocumentRules | None = None
    if not _has_running_text(doc):
        asked = [t for t in doc.tables if len(t.cells) >= 3 and study_table(t) is None]
        for table in asked[: settings.prestudy_max_tables]:
            spec, reason = study_table_with_model(table, client, user_id, votes)
            caption = table.caption or f"Table {table.id}"
            if spec is None:
                warnings.append(_rejected(caption, reason or "no usable answer"))
                continue
            tables[table.id] = spec
            rule = rule_from_spec(table, spec)
            assert rule is not None
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.PRESTUDY_APPLIED,
                    f"The model read how '{caption}' states its items, and the answer was checked against every row: {rule.describe()}",
                    detail={"source": caption, "rules": rule.describe(), "rulebook": FileRulebook(tables={table.id: spec}).hash},
                )
            )
    else:
        # The outline the model reads leaves out the front matter the document's own structure already shows (contents entries, everything
        # before the first numbered section), so the model is asked only about what is still open.
        document, reason = study_document_with_model(
            without_front_matter(doc, find_front_matter(doc)), client, user_id, votes, cover=cover_lines(doc)
        )
        if reason is not None:
            warnings.append(_rejected("the document", reason))
        elif document is not None:
            parts = (
                [f"{r.label}{r.separator} = {r.type}" for r in document.labels]
                + [f"depth {d + 1} = {t}" for d, t in document.depth_types]
                + [f"{p.role.replace('_', ' ')} left out" for p in document.front_matter]
                + ([f"cover title '{document.cover_title}'"] if document.cover_title else [])
                + [f"{len(document.proposals)} structure proposal(s) for the user"] * bool(document.proposals)
                + [f"{len(document.spelling_fixes)} heading spelling fix(es)"] * bool(document.spelling_fixes)
            )
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.PRESTUDY_APPLIED,
                    "The model read how the document states its item types, and the answer was checked against every heading: " + "; ".join(parts) + ".",
                    detail={"source": "the document", "rules": parts, "rulebook": FileRulebook(document=document).hash},
                )
            )
    return FileRulebook(tables=tables, document=document), warnings


def _rejected(source: str, reason: str) -> IntegrityWarning:
    return IntegrityWarning.make(
        WarningKind.PRESTUDY_REJECTED,
        f"The model's reading of how {source} states its items was not used: {reason}. The file was read by its recognised headings and its shape instead.",
        # transient: the model could not be reached, so this is no reading of the file and must not be kept as one.
        detail={"source": source, "reason": str(reason), "transient": isinstance(reason, TransientReason)},
    )


# Bump when the sampling, validation or voting code changes meaning, so a rulebook stored under an older version is asked for again.
# 4: front matter (validate_front_matter), the outline without the code-found front matter; 5: the grammar; 6: the document profile
_CODE_PASS_VERSION = "6"


def prestudy_version() -> str:
    """Identifies how a file is studied: the prompts, the response schemas, the number of votes and the code pass. A rulebook stored under another
    version is not reused (precedent: leveling/study_store.study_version)."""
    from app.survey._response_schemas import file_rules_document_schema, file_rules_table_schema

    parts = [
        load_prompt("study_file_rules_table"),
        load_prompt("study_file_rules_document"),
        json.dumps(file_rules_table_schema(), sort_keys=True),
        json.dumps(file_rules_document_schema(), sort_keys=True),
        settings.prestudy_votes,
        _CODE_PASS_VERSION,
    ]
    return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()[:16]


def check_rulebook(doc: CanonicalDoc, rulebook: FileRulebook) -> str | None:
    """Why a rulebook (a user's edit) cannot be applied to `doc`, or None. The hard checks of a model's answer, without the model: every table it names
    exists and its rules fit that table, and a document's labels are real labels."""
    tables = {t.id: t for t in doc.tables}
    for table_id, spec in rulebook.tables.items():
        table = tables.get(table_id)
        if table is None:
            return f"the rules name a table ({table_id}) that this file does not have"
        reason = check_spec(table, spec)
        if reason is not None:
            return f"the rules for '{table.caption or table_id}' do not fit it: {reason}"
    if rulebook.document is not None and (rulebook.document.labels or rulebook.document.depth_types):
        headings = document_headings(doc)
        if not headings:
            return "the rules describe headings, and this file has none"
        present = {h["depth"] for h in headings}
        if any(depth not in present for depth, _ in rulebook.document.depth_types):
            return "the rules give a type for a depth this file does not have"
        for rule in rulebook.document.labels:
            if sum(1 for h in headings if _starts_with_label(h["text"], rule.label, rule.separator)) < MIN_LABELLED:
                return f"the label '{rule.label}{rule.separator}' does not begin at least {MIN_LABELLED} headings"
    if rulebook.document is not None:
        for part in rulebook.document.front_matter:
            section, _tables = section_of(doc, part.block_id)
            if not section:
                return f"the rules leave out a heading ({part.block_id}) that this file does not have"
            if any(opens_a_requirement(b.text) for b in section):
                return f"the rules leave out '{section[0].text[:60]}', whose section holds requirements"
    return None
