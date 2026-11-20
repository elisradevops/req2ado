"""What a file says about its own structure, read before any item is built (the pre-study of a table file).

A tracker export or a requirements sheet usually states each item's type, its level and its parent in columns. Reading those once, for the whole
table, gives a rule per table (`TableRule`); the items are then built from the rule (leveling/rule_builder.py), and nothing downstream may
re-type an item the rule covers. Each rule says where it came from ("stated" in the file, or "learned" from the rows that do state it), what
evidence it rests on, and how many rows it covers, so the wizard can show it and a verifier can check the tree against it.

A rule comes from a `RuleSpec` (study/rulebook.py): which column is what, and how a row's type and parent are known. `study_table` reads the spec from
column headings it recognises (deterministic, no model); a model's validated answer (study/model_rules.py) is the same spec for a file whose headings
are not known to the code. `rule_from_spec` turns either into the rule, so one builder serves both. A table that states no types is not covered here
and goes on to the paths that read it by shape."""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

from app.canonical.markup import html_to_plain
from app.canonical.model import CanonicalDoc, Table, plain_text_rows
from app.study.rulebook import FileRulebook, RuleSpec, fold

LADDER = ("Epic", "Feature", "Requirement")
_RANK = {name: rank for rank, name in enumerate(LADDER)}
# (child type, allowed parent types); a root can only be an Epic. Same nesting as the rest of the pipeline's ladder.
_VALID_PARENT = {
    "Epic": {"Epic"},
    "Feature": {"Epic", "Feature"},
    "Requirement": {"Feature", "Requirement"},
}

_TYPE_HEADERS = {"work item type", "workitemtype", "item type", "itemtype", "wit", "type"}
_LEVEL_HEADER = re.compile(r"^title\s*([1-9])$", re.IGNORECASE)
_TITLE_HEADERS = {"title", "name", "summary"}
_ID_HEADERS = {"id", "work item id", "item id"}
_PARENT_HEADERS = {"parent", "parent id", "parent item"}
_CUSTOMER_ID_HEADERS = {
    "customer id",
    "customer_id",
    "customer requirement id",
    "requirement id",
    "req id",
    "external id",
}
_DESCRIPTION_HEADERS = {"description", "desc", "details"}
_LONG_TEXT_HEADER = re.compile(
    r"description|acceptance|rationale|notes?|criteria|assessment|explanation|comments?|details",
    re.IGNORECASE,
)
_MIN_LADDER_SHARE = 0.6  # of the typed rows, the share that must be Epic/Feature/Requirement for the column to be taken as the type column
_LEARN_SHARE = 0.9  # of the typed rows at a level, the share that must agree before an untyped row at that level takes that type
_LONG_TEXT_CHARS = 100
_LONG_TEXT_FILLED = 0.2
_MAX_HEADER_CHARS = 80


def _norm(header: str) -> str:
    return re.sub(r"\s+", " ", header.strip().lower())


@dataclass
class RowPlan:
    """One data row, read by the rule: what it is, who its parent is, or why it is not imported."""

    row: int  # index into the table's grid
    level: int | None
    type: str | None  # Epic / Feature / Requirement, or None for a row that is not imported
    raw_type: str  # the type as the file wrote it ("" when it wrote none)
    title: str
    parent: int | None  # index into TableRule.rows; None for a root
    skipped: str | None = (
        None  # why it is not imported: "type:<name>", "under_skipped", "in_cycle", "no_title", "no_type"
    )
    type_source: str = "stated"  # "stated" or "learned"


@dataclass
class TableRule:
    table_id: str
    labels: list[str]
    header_row: int
    type_col: int | None
    level_cols: list[int]
    title_col: int | None
    id_col: int | None
    parent_col: int | None
    customer_id_col: int | None
    description_cols: list[int]
    nesting: str  # see study/rulebook.py NESTINGS
    level_col: int | None = None
    type_map: dict[str, str | None] | None = None
    level_types: dict[int, str] | None = None
    origin: str = "stated"
    rows: list[RowPlan] = field(default_factory=list)
    blank_rows: int = 0
    violations: list[str] = field(default_factory=list)

    @property
    def kept(self) -> list[RowPlan]:
        return [r for r in self.rows if r.type is not None and r.skipped is None]

    def skipped_counts(self) -> Counter:
        return Counter(r.skipped for r in self.rows if r.skipped)

    def type_counts(self) -> Counter:
        return Counter(r.type for r in self.kept)

    def describe(self) -> str:
        def col(index: int | None) -> str:
            return f"'{self.labels[index]}'" if index is not None and index < len(self.labels) else "?"

        nesting = {
            "levels": "nesting from " + ", ".join(col(c) for c in self.level_cols),
            "level_number": f"nesting from the depth in {col(self.level_col)}",
            "outline_number": f"nesting from the outline numbers in {col(self.level_col)}",
            "id_parent": f"nesting from {col(self.id_col)} and {col(self.parent_col)}",
            "order": "nesting from row order",
        }[self.nesting]
        counts = ", ".join(
            f"{n} {t}{'s' if n != 1 else ''}"
            for t, n in ((t, self.type_counts()[t]) for t in LADDER)
            if n
        )
        stated = (
            f"Types are stated in column {col(self.type_col)}"
            if self.type_col is not None
            else "Types follow the depth"
        )
        return f"{stated} ({counts}); {nesting}."


def _grid(table: Table) -> list[list[str]]:
    rows = plain_text_rows(table)
    width = max((len(r) for r in rows), default=0)
    return [r + [""] * (width - len(r)) for r in rows]


def _find_header_row(grid: list[list[str]]) -> int | None:
    for index, row in enumerate(grid[:5]):
        filled = [c.strip() for c in row if c.strip()]
        if len(filled) >= 2:
            return index if all(len(c) <= _MAX_HEADER_CHARS for c in filled) else None
    return None


def _ladder_type(value: str) -> str | None:
    cleaned = value.strip().lower()
    return next((name for name in LADDER if name.lower() == cleaned), None)


def study_table(table: Table) -> TableRule | None:
    """The rule a table states in headings the code recognises, or None when it does not state its items' types in a column."""
    grid = _grid(table)
    header_row = _find_header_row(grid)
    if header_row is None or len(grid) - header_row < 2:
        return None
    labels = [c.strip() for c in grid[header_row]]
    normalized = [_norm(label) for label in labels]
    body = [row for i, row in enumerate(grid) if i > header_row]

    type_col = None
    for candidate in (c for c, h in enumerate(normalized) if h in _TYPE_HEADERS):
        values = [row[candidate].strip() for row in body if row[candidate].strip()]
        if values and sum(1 for v in values if _ladder_type(v)) / len(values) >= _MIN_LADDER_SHARE:
            type_col = candidate
            break
    if type_col is None:
        return None

    def first(headers: set[str]) -> int | None:
        return next((c for c, h in enumerate(normalized) if h in headers and c != type_col), None)

    level_cols = sorted(
        (c for c, h in enumerate(normalized) if _LEVEL_HEADER.match(h)),
        key=lambda c: int(_LEVEL_HEADER.match(normalized[c]).group(1)),  # type: ignore[union-attr]
    )
    title_col, id_col, parent_col = (
        first(_TITLE_HEADERS),
        first(_ID_HEADERS),
        first(_PARENT_HEADERS),
    )
    if len(level_cols) >= 2:
        nesting = "levels"
    elif title_col is not None and id_col is not None and parent_col is not None:
        nesting = "id_parent"
    elif title_col is not None:
        nesting = "order"
    else:
        return None

    structural = {type_col, title_col, id_col, parent_col, *level_cols}
    description_col = first(_DESCRIPTION_HEADERS)
    description_cols = ([description_col] if description_col is not None else []) + _long_text_columns(
        labels, body, structural | {description_col}
    )
    spec = RuleSpec(
        header_row=header_row,
        nesting=nesting,
        type_col=type_col,
        level_cols=tuple(level_cols) if nesting == "levels" else (),
        title_col=title_col,
        id_col=id_col,
        parent_col=parent_col,
        customer_id_col=first(_CUSTOMER_ID_HEADERS),
        description_cols=tuple(description_cols),
        origin="stated",
    )
    rule = rule_from_spec(table, spec)
    return rule if rule is not None and rule.kept else None


def _long_text_columns(labels: list[str], body: list[list[str]], taken: set[int | None]) -> list[int]:
    """The columns, other than the ones already given a role, whose text belongs in the item's description: long or described as such."""
    extra: list[int] = []
    for c, label in enumerate(labels):
        if c in taken or not label:
            continue
        values = [row[c].strip() for row in body if row[c].strip()]
        if not values:
            continue
        filled = len(values) / len(body)
        long_text = (
            sum(len(v) for v in values) / len(values) >= _LONG_TEXT_CHARS and filled >= _LONG_TEXT_FILLED
        )
        if long_text or _LONG_TEXT_HEADER.search(label):
            extra.append(c)
    return extra


def rule_from_spec(table: Table, spec: RuleSpec) -> TableRule | None:
    """The rule a spec gives for `table`: every data row read (type, level, parent, or why it is not imported). None when the spec does not fit the
    table (a column out of range, a header row beyond the grid)."""
    grid = _grid(table)
    width = len(grid[0]) if grid else 0
    columns = [spec.type_col, spec.level_col, spec.title_col, spec.id_col, spec.parent_col, spec.customer_id_col]
    columns += [*spec.level_cols, *spec.description_cols]
    if not 0 <= spec.header_row < len(grid) - 1 or any(c is not None and not 0 <= c < width for c in columns):
        return None
    rule = TableRule(
        table_id=table.id,
        labels=[c.strip() for c in grid[spec.header_row]],
        header_row=spec.header_row,
        type_col=spec.type_col,
        level_cols=list(spec.level_cols),
        title_col=spec.title_col,
        id_col=spec.id_col,
        parent_col=spec.parent_col,
        customer_id_col=spec.customer_id_col,
        description_cols=list(spec.description_cols),
        nesting=spec.nesting,
        level_col=spec.level_col,
        type_map=spec.type_map,
        level_types=spec.level_types,
        origin=spec.origin,
    )
    _plan_rows(rule, [(i, row) for i, row in enumerate(grid) if i > spec.header_row])
    return rule


_BY_DEPTH = ("levels", "level_number", "outline_number")
_NUMBER = re.compile(r"\d+")
_OUTLINE = re.compile(r"^\s*(\d+(?:\.\d+)*)\.?(?:\s|$)")


def _row_title_and_level(rule: TableRule, row: list[str]) -> tuple[str, int | None]:
    """The row's title and its depth (0 = outermost; None when the row states none)."""
    if rule.nesting == "levels":
        for level, col in enumerate(rule.level_cols):
            if row[col].strip():
                return html_to_plain(row[col].strip()), level
        return "", None
    title = html_to_plain(row[rule.title_col].strip()) if rule.title_col is not None else ""
    level: int | None = None
    if rule.nesting == "level_number" and rule.level_col is not None:
        found = _NUMBER.search(row[rule.level_col])
        level = int(found.group()) - 1 if found and int(found.group()) >= 1 else None
    elif rule.nesting == "outline_number" and rule.level_col is not None:
        outline = _OUTLINE.match(row[rule.level_col])
        level = outline.group(1).count(".") if outline else None
    return title, level


def _resolve_type(rule: TableRule, raw_type: str, level: int | None) -> str | None:
    """The ladder type a row has: from its type column's value (through the spec's map), or from its depth when the table has no type column."""
    if rule.type_col is not None:
        if rule.type_map is None:
            return _ladder_type(raw_type)
        return rule.type_map.get(fold(raw_type)) if raw_type else None
    return rule.level_types.get(level) if rule.level_types and level is not None else None


def _plan_rows(rule: TableRule, body: list[tuple[int, list[str]]]) -> None:
    plans: list[RowPlan] = []
    rows_by_index = dict(body)
    for index, row in body:
        if not any(cell.strip() for cell in row):
            rule.blank_rows += 1
            continue
        raw_type = row[rule.type_col].strip() if rule.type_col is not None else ""
        title, level = _row_title_and_level(rule, row)
        plans.append(RowPlan(index, level, _resolve_type(rule, raw_type, level), raw_type, title, None))

    _learn_untyped(rule, plans)
    by_id: dict[str, int] = {}
    if rule.nesting == "id_parent":
        for position, plan in enumerate(plans):
            value = _cell(rows_by_index, plan.row, rule.id_col)
            if value:
                by_id.setdefault(value, position)

    stack: list[
        int
    ] = []  # positions of the rows still open (levels: by level; order: by type rank)
    for position, plan in enumerate(plans):
        if rule.nesting in _BY_DEPTH and plan.level is not None:
            while stack and (plans[stack[-1]].level or 0) >= plan.level:
                stack.pop()
            plan.parent = stack[-1] if stack else None
            stack.append(position)
        elif rule.nesting == "id_parent":
            reference = _cell(rows_by_index, plan.row, rule.parent_col)
            if reference and reference in by_id and by_id[reference] != position:
                plan.parent = by_id[reference]
            elif reference:
                rule.violations.append(
                    f"'{plan.title[:60]}': its parent '{reference}' is not a row of the file"
                )
        elif rule.nesting == "order" and plan.type in _RANK:
            while stack and _RANK.get(plans[stack[-1]].type or "", -1) >= _RANK[plan.type]:
                stack.pop()
            plan.parent = stack[-1] if stack else None
            stack.append(position)

    for plan in plans:
        if plan.type is None:
            plan.skipped = f"type:{plan.raw_type}" if plan.raw_type else "no_type"
        elif not plan.title:
            plan.skipped = "no_title"
    _skip_under_skipped(plans)
    # The ladder is checked once every skip is known: with ID/Parent nesting a parent may come after its child in the file.
    for plan in plans:
        if plan.skipped is None and plan.type is not None:
            parent_type = plans[plan.parent].type if plan.parent is not None else None
            if parent_type is None and plan.type != "Epic":
                rule.violations.append(f"{plan.type} '{plan.title[:60]}' has no parent")
            elif parent_type is not None and parent_type not in _VALID_PARENT[plan.type]:
                rule.violations.append(
                    f"{plan.type} '{plan.title[:60]}' sits under a {parent_type}"
                )
    rule.rows = plans


def _skip_under_skipped(plans: list[RowPlan]) -> None:
    """A row whose parent chain reaches a skipped row is skipped too ("under_skipped"); rows whose parents form a cycle are skipped as "in_cycle"
    and the rows under them as "under_skipped". Each chain is walked once (iteratively, so a deep chain listed child-first is linear)."""
    done = [plan.skipped is not None for plan in plans]
    for start in range(len(plans)):
        path: list[int] = []
        on_path: set[int] = set()
        position: int | None = start
        while position is not None and not done[position] and position not in on_path:
            path.append(position)
            on_path.add(position)
            position = plans[position].parent
        if position is not None and position in on_path:  # a cycle: `position` and the rows after it on the path
            cut = path.index(position)
            for member in path[cut:]:
                plans[member].skipped = "in_cycle"
                done[member] = True
            path = path[:cut]
        blocked = position is not None and plans[position].skipped is not None
        for member in path:
            if blocked:
                plans[member].skipped = "under_skipped"
            done[member] = True


def _cell(rows_by_index: dict[int, list[str]], grid_row: int, col: int | None) -> str:
    return rows_by_index[grid_row][col].strip() if col is not None else ""


def _learn_untyped(rule: TableRule, plans: list[RowPlan]) -> None:
    """A row that states no type at a level where the typed rows agree takes that type (marked 'learned')."""
    if rule.nesting != "levels" or rule.type_col is None:
        return
    by_level: dict[int, Counter] = {}
    for plan in plans:
        if plan.level is not None and plan.type is not None:
            by_level.setdefault(plan.level, Counter())[plan.type] += 1
    agreed = {
        level: counts.most_common(1)[0][0]
        for level, counts in by_level.items()
        if counts.most_common(1)[0][1] / sum(counts.values()) >= _LEARN_SHARE
    }
    for plan in plans:
        if plan.type is None and not plan.raw_type and plan.level in agreed:
            plan.type = agreed[plan.level]
            plan.type_source = "learned"


# Caps on what the wizard is shown of a table, so a 10,000-row sheet still answers in a few kilobytes.
DETAIL_SAMPLES = 3
DETAIL_SKIPPED_ROWS = 20
DETAIL_TEXT_CHARS = 120


def clip_detail(text: str) -> str:
    text = " ".join(text.split())
    return text if len(text) <= DETAIL_TEXT_CHARS else text[: DETAIL_TEXT_CHARS - 1] + "…"


def table_details(table: Table, rule: TableRule) -> dict:
    """What the rule makes of `table`, for the wizard to check against the file: the items of each type, a few of them with their parents, and the
    rows that are not imported with the reason code (RowPlan.skipped). Row numbers count the heading row as 1, as the sheet does."""
    samples: dict[str, list[dict]] = {}
    for plan in rule.kept:
        bucket = samples.setdefault(plan.type, [])  # type: ignore[arg-type]
        if len(bucket) < DETAIL_SAMPLES:
            parent = rule.rows[plan.parent].title if plan.parent is not None else None
            bucket.append({"row": plan.row + 1, "title": clip_detail(plan.title), "parent": clip_detail(parent) if parent else None})
    skipped = [plan for plan in rule.rows if plan.skipped]
    grid = _grid(table) if any(not plan.title for plan in skipped[:DETAIL_SKIPPED_ROWS]) else []

    def text(plan: RowPlan) -> str:
        # A row without a title is shown by its first filled cell, so it can still be found in the file.
        return clip_detail(plan.title or next((c for c in grid[plan.row] if c.strip()), ""))

    counts = rule.type_counts()
    return {
        "name": table.caption or f"Table {table.id}",
        "totalRows": len(rule.rows),
        "typeCounts": {t: counts[t] for t in LADDER},
        "samples": samples,
        "skipped": {
            "count": len(skipped),
            "byReason": dict(rule.skipped_counts()),
            "rows": [{"row": p.row + 1, "reason": p.skipped, "text": text(p)} for p in skipped[:DETAIL_SKIPPED_ROWS]],
            "more": max(0, len(skipped) - DETAIL_SKIPPED_ROWS),
        },
    }


def study_tables(doc: CanonicalDoc, rulebook: FileRulebook | None = None) -> dict[str, TableRule]:
    """The rule of every table of the document that states its items' types, by table id. Headings the code recognises come first; a table they
    do not cover takes the rulebook's spec for it (a model's validated answer, or the user's), when there is one."""
    rules: dict[str, TableRule] = {}
    for table in doc.tables:
        rule = study_table(table)
        if rule is None and rulebook is not None and table.id in rulebook.tables:
            candidate = rule_from_spec(table, rulebook.tables[table.id])
            rule = candidate if candidate is not None and candidate.kept else None
        if rule is not None:
            rules[table.id] = rule
    return rules
