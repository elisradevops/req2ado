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
    FRONT_MATTER_ROLES,
    LADDER,
    DocumentRules,
    FileRulebook,
    FrontMatterPart,
    LabelRule,
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


def document_sample(doc: CanonicalDoc) -> dict:
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
    return {
        "headingCount": len(headings),
        "headings": [
            {"i": h["i"], "level": h["level"], "depth": h["depth"], "number": h["number"], "text": _clip(h["text"])}
            for h in shown
        ],
        "leadingPatterns": patterns,
        "levelCounts": dict(sorted(Counter(h["level"] for h in headings).items())),
        "depthCounts": dict(sorted(Counter(h["depth"] for h in headings).items())),
    }


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


def validate_document_answer(raw: dict, headings: list[dict], doc: CanonicalDoc | None = None) -> DocumentRules | str:
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
    if not labels and not depth_types and not front_matter:
        return "the model found no type and no front matter the document states"
    return DocumentRules(labels=tuple(labels), depth_types=tuple(depth_types), origin="model", front_matter=front_matter)


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
    return DocumentRules(labels=labels, depth_types=depths, origin="model", front_matter=front)


def study_document_with_model(
    doc: CanonicalDoc, client: FileRulesStudyClient, user_id: str | None = None, votes: int = 3
) -> tuple[DocumentRules | None, str | None]:
    headings = document_headings(doc)
    if len(headings) < MIN_DOCUMENT_HEADINGS:
        return None, None
    sample = document_sample(doc)
    answers, reason = _ask(
        lambda vote, accept: client.study_file_rules_document(sample, user_id=user_id, vote=vote, accept=accept),
        lambda raw: validate_document_answer(raw, headings, doc),
        votes,
        "the document",
    )
    if reason is not None:
        return None, reason
    voted = vote_documents(answers)
    if not voted.labels and not voted.depth_types and not voted.front_matter:
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
        document, reason = study_document_with_model(without_front_matter(doc, find_front_matter(doc)), client, user_id, votes)
        if reason is not None:
            warnings.append(_rejected("the document", reason))
        elif document is not None:
            parts = (
                [f"{r.label}{r.separator} = {r.type}" for r in document.labels]
                + [f"depth {d + 1} = {t}" for d, t in document.depth_types]
                + [f"{p.role.replace('_', ' ')} left out" for p in document.front_matter]
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
_CODE_PASS_VERSION = "4"  # 4: front matter (validate_front_matter), the outline without the code-found front matter


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
