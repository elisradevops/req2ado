"""The Study: one reading of the job's document, as the context every later prompt can be given (design: the Study phase, P1).

It is made of the grounded facts the document study already extracts (app.leveling.document_study: glossary, placeholder tokens, verification
statements, standards cited, table roles, each checked against the window it came from), a short orientation (what kind of document it is,
its purpose, the system it specifies, its conventions) written by one extra call over the outline and the first window, and, for tables that
state their items' types, each column's vocabulary computed by code.

The orientation is background only: it is never a source of values, and nothing it says is checked against the document. Everything else is
the document's own text.

Reading reuses the background study's machinery unchanged (StudyHandle: windows, healing, the per-window store, the lease limiter); only the
time budget differs: windows x the model's median seconds per window / concurrency, with the hard study budget as its ceiling.

Fail open: a window, the orientation call, the timing store or the result cache that fails leaves a partial Study, never an error. Only a
cancelled run raises (JobCancelled). Deterministic: the same document gives the same text, the same keys and the same vocabulary order."""

from __future__ import annotations

import hashlib
import inspect
import json
import logging
import math
import re
import statistics
import threading
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Protocol

from pydantic import BaseModel, Field

from app.canonical.model import BlockKind, CanonicalDoc, Table
from app.config import settings
from app.job_cancel import JobCancelled
from app.kb.profile import windows_of
from app.leveling.document_study import (
    STUDY_WINDOW_CHARS,
    STUDY_WINDOW_OVERLAP,
    DocumentStudy,
    StudyReadStats,
    _canonical,
)
from app.leveling.study_runner import StudyHandle
from app.leveling.study_store import study_version
from app.leveling.tree_builder import _order_key
from app.prompts import load_prompt
from app.request_identity import redact_identity, user_scope
from app.study.file_rules import TableRule, _grid, study_tables
from app.survey._response_schemas import document_orientation_schema

if TYPE_CHECKING:
    from app.leveling.llm_lease_limiter import LeaseLimiter
    from app.leveling.study_store import StudyStore
    from app.study.rulebook import FileRulebook

logger = logging.getLogger(__name__)

# Bump when the Study's own code pass (table text, vocabulary, orientation inputs and clipping) changes meaning, so cached Studies stop applying.
_STUDY_CODE_VERSION = "1"
ORIENTATION_FIELDS = ("document_type", "purpose", "system", "conventions")
_ORIENTATION_FIELD_CHARS = 250  # four fields: the whole orientation stays within about 1,000 characters
_OUTLINE_CHARS = 4_000
_OUTLINE_HEADING_LEVELS = 3
VOCABULARY_VALUES = 50  # distinct values kept per column
VOCABULARY_VALUE_CHARS = 200  # a longer value is free text, not vocabulary: it is left out
# Half a window (STUDY_WINDOW_CHARS): any window that falls inside a long table holds at least one whole marker line.
_TABLE_MARKER_EVERY = STUDY_WINDOW_CHARS // 2
_TIMING_SAMPLES_MIN = 3  # fewer measured windows than this: the default seconds per window is used
_RESULT_PREFIX = "studyresult"
_TIMING_PREFIX = "studytiming"


class OrientationClient(Protocol):
    def study_document_window(self, window_text: str, user_id: str | None = None) -> dict: ...

    def orient_document(self, outline: str, first_window: str, user_id: str | None = None) -> dict: ...


class Orientation(BaseModel):
    document_type: str = ""
    purpose: str = ""
    system: str = ""
    conventions: str = ""


class GlossaryEntry(BaseModel):
    term: str
    definition: str


class TableRole(BaseModel):
    table: str
    role: str


class ColumnVocabulary(BaseModel):
    table: str
    column: str
    values: list[str]
    more: int = 0  # distinct values left out by the cap


class StudyStats(BaseModel):
    windows_studied: int = 0
    windows_total: int = 0
    windows_cached: int = 0
    windows_retried: int = 0
    windows_split: int = 0
    windows_failed: int = 0
    breaker_opened: bool = False
    budget_stopped: bool = False
    budget_seconds: float = 0.0
    seconds_per_window: float = 0.0  # the estimate the budget was computed from
    stopped_by: str = "completed"  # StudyOutcome.stopped_by, or "empty" for a document with no text
    orientation_failed: bool = False
    from_cache: bool = False  # the whole Study came from the result cache: no model call was made


class Study(BaseModel):
    version: str
    orientation: Orientation = Field(default_factory=Orientation)
    glossary: list[GlossaryEntry] = Field(default_factory=list)
    placeholder_tokens: list[str] = Field(default_factory=list)
    verification_statements: list[str] = Field(default_factory=list)
    standards_cited: list[str] = Field(default_factory=list)
    table_roles: list[TableRole] = Field(default_factory=list)
    vocabulary: list[ColumnVocabulary] = Field(default_factory=list)
    stats: StudyStats = Field(default_factory=StudyStats)
    warnings: list[str] = Field(default_factory=list)

    @property
    def complete(self) -> bool:
        """Every window read and the orientation written: only such a Study is kept in the result cache."""
        s = self.stats
        return (
            s.windows_total > 0
            and s.windows_studied == s.windows_total
            and not s.orientation_failed
            and s.stopped_by == "completed"
        )


# -- the text that is read ---------------------------------------------------------------------------------------------------------


def _cell(row: list[str], col: int | None) -> str:
    return row[col].strip() if col is not None and col < len(row) else ""


def _row_line(rule: TableRule, row: list[str], type_name: str, title: str) -> str:
    description = " ".join(c for c in (_cell(row, col) for col in rule.description_cols) if c)
    return " · ".join(part for part in (type_name, " ".join(title.split()), " ".join(description.split())) if part)


def table_text(table: Table, rule: TableRule) -> str:
    """A table that states its items' types, one row per line (type · title · description) under its `[TABLE id]` marker line (with the
    table's caption and columns). The marker line is repeated every _TABLE_MARKER_EVERY characters, so every window that falls inside a long
    table still holds the marker its table roles are checked against; it also closes the table. The rows that are not imported (RowPlan.skipped, e.g. Test Cases)
    are rendered the same way, after the imported ones, with the type the file wrote: verification statements in them are then grounded in
    the text that is read."""
    grid = _grid(table)
    columns = ", ".join(label.strip() for label in rule.labels if label.strip())
    marker = " ".join(part for part in (f"[TABLE {table.id}]", table.caption or "", f"columns: {columns}" if columns else "") if part)
    lines = [marker]
    since_marker = 0

    def add(line: str) -> None:
        nonlocal since_marker
        if since_marker >= _TABLE_MARKER_EVERY:
            lines.append(marker)
            since_marker = 0
        lines.append(line)
        since_marker += len(line) + 1

    for plan in rule.kept:
        add(_row_line(rule, grid[plan.row], plan.type or "", plan.title))
    skipped = [plan for plan in rule.rows if plan.skipped]
    if skipped:
        add("Rows not imported:")
        for plan in skipped:
            row = grid[plan.row]
            title = plan.title or next((c for c in row if c.strip()), "")
            add(_row_line(rule, row, plan.raw_type, title))
    if len(lines) > 1:
        lines.append(marker)  # closing it too: the last, shorter window of a document can end inside the table
    return "\n".join(lines)


def study_text(doc: CanonicalDoc, rules: dict[str, TableRule]) -> str:
    """The document as the Study reads it: blocks and tables in document order (as render_section orders them), with every table that
    states its items' types rendered by table_text instead of as a markdown grid."""
    from app.leveling.llm_leveling import (  # here, not at the top: llm_leveling reads a given Study through this module
        _render_block_line,
        _table_to_markdown,
    )

    entries: list[tuple[tuple[int, int], str]] = []
    for block in doc.blocks:
        line = _render_block_line(block)
        if line is not None:
            entries.append((_order_key(block.source_ref), line))
    for table in doc.tables:
        rule = rules.get(table.id)
        if rule is not None:
            entries.append((_order_key(table.source_ref), table_text(table, rule)))
            continue
        markdown = _table_to_markdown(table)
        if markdown is not None:
            entries.append((_order_key(table.source_ref), f"[TABLE {table.id}]\n{markdown}"))
    entries.sort(key=lambda entry: entry[0])
    return "\n".join(line for _, line in entries)


# -- vocabulary (code only) ------------------------------------------------------------------------------------------------------


# A person as an Azure DevOps export or a sheet writes one: "Name <DOMAIN\\user>" or "Name <user@domain>" (an identity field), beside the
# deployment's own identity forms (app.request_identity: Windows SIDs, identity URIs).
_PERSON_VALUE = re.compile(r"<[^<>\s]+\\[^<>\s]+>|<[^<>\s@]+@[^<>\s]+>")


def _names_a_person(value: str) -> bool:
    return bool(_PERSON_VALUE.search(value)) or redact_identity(value) != value


def _vocabulary_columns(rule: TableRule) -> list[int]:
    """The columns whose values name a kind of thing (type, level, priority, method...): never the free-text columns (the title, the
    level title columns of a table nested by levels, the description) nor the identifiers (id, parent, customer id), whose values are
    all different by design."""
    excluded = {rule.title_col, rule.id_col, rule.parent_col, rule.customer_id_col, *rule.level_cols, *rule.description_cols}
    return [index for index in range(len(rule.labels)) if index not in excluded and rule.labels[index].strip()]


def table_vocabulary(table: Table, rule: TableRule) -> list[ColumnVocabulary]:
    """Each column's distinct values over the imported rows, in first-seen order (de-duplicated by their canonical form, the first
    spelling kept), at most VOCABULARY_VALUES of them; a value longer than VOCABULARY_VALUE_CHARS is free text and left out. A column
    with any value that names a person (Assigned To, Created By...) is left out whole: the vocabulary goes into prompts, people do not."""
    grid = _grid(table)
    name = table.caption or f"Table {table.id}"
    vocabulary: list[ColumnVocabulary] = []
    for col in _vocabulary_columns(rule):
        seen: set[str] = set()
        values: list[str] = []
        for plan in rule.kept:
            value = " ".join(_cell(grid[plan.row], col).split())
            if not value or len(value) > VOCABULARY_VALUE_CHARS:
                continue
            key = _canonical(value)
            if key not in seen:
                seen.add(key)
                values.append(value)
        if any(_names_a_person(value) for value in values):
            continue
        if values:
            vocabulary.append(
                ColumnVocabulary(
                    table=name,
                    column=rule.labels[col].strip(),
                    values=values[:VOCABULARY_VALUES],
                    more=max(0, len(values) - VOCABULARY_VALUES),
                )
            )
    return vocabulary


# -- orientation -----------------------------------------------------------------------------------------------------------------


def outline_of(doc: CanonicalDoc, rules: dict[str, TableRule]) -> str:
    """What the orientation reads beside the first window: the headings (top levels only) and, for each table that states its items'
    types, its columns and how many items of each type it holds. Capped at _OUTLINE_CHARS."""
    lines: list[str] = []
    for block in doc.blocks:
        if block.kind == BlockKind.HEADING and (block.heading_level or 1) <= _OUTLINE_HEADING_LEVELS:
            lines.append(f"{'#' * (block.heading_level or 1)} {' '.join(block.text.split())}")
    for table in doc.tables:
        rule = rules.get(table.id)
        if rule is None:
            continue
        counts = rule.type_counts()
        types = ", ".join(f"{n} {t}" for t, n in sorted(counts.items()) if t)
        columns = ", ".join(label.strip() for label in rule.labels if label.strip())
        lines.append(f"[TABLE {table.id}] columns: {columns}; items: {types}")
    text = "\n".join(lines)
    return text[:_OUTLINE_CHARS]


def checked_orientation(answer: object) -> Orientation:
    """The four fields, each a string with its whitespace squashed and clipped to _ORIENTATION_FIELD_CHARS; anything else is malformed."""
    if not isinstance(answer, dict) or not all(isinstance(answer.get(f), str) for f in ORIENTATION_FIELDS):
        raise ValueError("malformed orientation answer")

    def clip(text: str) -> str:
        text = " ".join(text.split())
        return text if len(text) <= _ORIENTATION_FIELD_CHARS else text[: _ORIENTATION_FIELD_CHARS - 1] + "…"

    return Orientation(**{f: clip(answer[f]) for f in ORIENTATION_FIELDS})


def _source_of(fn) -> str:
    try:
        return inspect.getsource(fn)
    except (OSError, TypeError):
        return fn.__qualname__


def study_result_version() -> str:
    """Identifies how a whole Study is made: the window reading (study_version), the orientation prompt and schema, and this module's code
    pass. Change any of them and a cached Study no longer applies."""
    parts = [
        study_version(),
        load_prompt("orient_document"),
        json.dumps(document_orientation_schema(), sort_keys=True),
        _STUDY_CODE_VERSION,
        _ORIENTATION_FIELD_CHARS,
        _OUTLINE_CHARS,
        _TABLE_MARKER_EVERY,
        VOCABULARY_VALUES,
        VOCABULARY_VALUE_CHARS,
        *(
            _source_of(fn)
            for fn in (table_text, study_text, table_vocabulary, _vocabulary_columns, _names_a_person, outline_of, checked_orientation)
        ),
        _PERSON_VALUE.pattern,
    ]
    return hashlib.sha256(json.dumps(parts).encode("utf-8")).hexdigest()[:12]


# -- timing and budget -----------------------------------------------------------------------------------------------------------


class _TimedClient:
    """Measures each window call that answers (inside the lease, so waiting for a slot is not counted). Shared by the worker threads."""

    def __init__(self, inner: OrientationClient, clock: Callable[[], float]) -> None:
        self._inner = inner
        self._clock = clock
        self._lock = threading.Lock()
        self.samples: list[float] = []

    def study_document_window(self, window_text: str, user_id: str | None = None) -> dict:
        started = self._clock()
        answer = self._inner.study_document_window(window_text, user_id=user_id)
        with self._lock:
            self.samples.append(self._clock() - started)
        return answer


class StudyTimings:
    """The model's recent seconds per window, in Redis (one capped list per model, no user data). Fail open: no client or any Redis error
    is "nothing measured", and the default is used."""

    def __init__(self, redis_client, samples: int, ttl_seconds: int) -> None:
        self._redis = redis_client
        self._samples = samples
        self._ttl_seconds = ttl_seconds

    def _key(self, model: str | None) -> str:
        return f"{_TIMING_PREFIX}:{model or 'default'}"

    def median(self, model: str | None) -> float | None:
        if self._redis is None:
            return None
        try:
            raw = self._redis.lrange(self._key(model), 0, self._samples - 1)
        except Exception as error:  # noqa: BLE001 -- fail open
            logger.warning("Study timings unavailable (%s); using the default.", type(error).__name__)
            return None
        values = []
        for item in raw or []:
            try:
                value = float(item)
            except (TypeError, ValueError):
                continue
            if math.isfinite(value) and value > 0:
                values.append(value)
        return statistics.median(values) if len(values) >= _TIMING_SAMPLES_MIN else None

    def record(self, model: str | None, samples: list[float]) -> None:
        good = [s for s in samples if math.isfinite(s) and s > 0]
        if self._redis is None or not good:
            return
        key = self._key(model)
        try:
            self._redis.lpush(key, *(f"{s:.3f}" for s in good))
            self._redis.ltrim(key, 0, self._samples - 1)
            self._redis.expire(key, self._ttl_seconds)
        except Exception as error:  # noqa: BLE001 -- fail open
            logger.warning("Study timings not recorded (%s).", type(error).__name__)


def study_budget(windows: int, seconds_per_window: float, concurrency: int, ceiling: float) -> float:
    """Seconds for `windows` windows read `concurrency` at a time, plus one round of slack for a slow window, at most `ceiling`."""
    rounds = math.ceil(max(windows, 1) / max(concurrency, 1)) + 1
    return min(ceiling, rounds * seconds_per_window)


# -- result cache ----------------------------------------------------------------------------------------------------------------


class StudyResultCache:
    """Whole Studies, per user scope, keyed by version, text hash and model. Only complete Studies are stored. Fail open."""

    def __init__(self, redis_client, ttl_seconds: int) -> None:
        self._redis = redis_client
        self._ttl_seconds = ttl_seconds

    @staticmethod
    def key(scope: str, model: str | None, text: str) -> str:
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]
        return f"{_RESULT_PREFIX}:{study_result_version()}:{scope}:{digest}:{model or 'default'}"

    def get(self, key: str) -> Study | None:
        if self._redis is None:
            return None
        try:
            raw = self._redis.get(key)
        except Exception as error:  # noqa: BLE001 -- fail open
            logger.warning("Study cache unavailable (get: %s).", type(error).__name__)
            return None
        if raw is None:
            return None
        try:
            return Study.model_validate_json(raw)
        except ValueError:
            return None

    def put(self, key: str, study: Study) -> None:
        if self._redis is None:
            return
        try:
            self._redis.set(key, study.model_dump_json(), ex=self._ttl_seconds)
        except Exception as error:  # noqa: BLE001 -- fail open
            logger.warning("Study cache unavailable (put: %s).", type(error).__name__)


# -- the Study -------------------------------------------------------------------------------------------------------------------


def _orient(client: OrientationClient, outline: str, first_window: str, user_id: str | None) -> Orientation | None:
    try:
        return checked_orientation(client.orient_document(outline, first_window, user_id=user_id))
    except JobCancelled:
        raise
    except Exception as error:  # noqa: BLE001 -- background only: the grounded facts stand without it
        logger.warning("Study: the orientation could not be written (%s); carrying on without it.", type(error).__name__)
        return None


def build_study(
    doc: CanonicalDoc,
    client: OrientationClient,
    user_id: str | None,
    model: str | None,
    *,
    rulebook: FileRulebook | None = None,
    store: StudyStore | None = None,
    limiter: LeaseLimiter | None = None,
    timings: StudyTimings | None = None,
    cache: StudyResultCache | None = None,
    clock: Callable[[], float] = time.monotonic,
    **handle_overrides,
) -> Study:
    """Reads the whole document once and returns its Study. A user id is required for any stored state (window store, limiter, result
    cache): without one, nothing is read from or written to them. Raises only JobCancelled."""
    version = study_result_version()
    rules = study_tables(doc, rulebook)
    text = study_text(doc, rules)
    vocabulary = [entry for table in doc.tables if table.id in rules for entry in table_vocabulary(table, rules[table.id])]
    windows = windows_of(text, STUDY_WINDOW_CHARS, STUDY_WINDOW_OVERLAP) if text.strip() else []
    if not windows:
        return Study(version=version, vocabulary=vocabulary, stats=StudyStats(stopped_by="empty"))

    scope = user_scope(user_id) if user_id else None
    key = StudyResultCache.key(scope, model, text) if cache is not None and scope else None
    if key is not None:
        cached = cache.get(key)  # type: ignore[union-attr]
        if cached is not None:
            cached.stats.from_cache = True
            return cached

    measured = timings.median(model) if timings is not None else None
    seconds_per_window = measured if measured is not None else float(settings.study_default_seconds_per_window)
    to_read = min(len(windows), settings.survey_study_max_windows)
    budget = study_budget(to_read, seconds_per_window, settings.survey_study_concurrency, settings.survey_study_hard_budget_seconds)

    timed = _TimedClient(client, clock)
    # The background study's own settings, except the deadline: the Study's budget replaces the fixed hard budget.
    handle = StudyHandle(
        render_text=lambda: text,
        client=timed,
        user_id=user_id,
        scope=scope or "anon",
        model=model,
        store=store if scope else None,
        limiter=limiter if scope else None,
        concurrency=settings.survey_study_concurrency,
        lookahead=settings.survey_study_lookahead,
        deadline_seconds=budget,
        soft_budget_seconds=min(budget, settings.survey_study_soft_budget_seconds),
        breaker_failures=settings.survey_study_breaker_failures,
        max_windows=settings.survey_study_max_windows,
        lease_max_wait_seconds=float(settings.survey_study_lease_max_wait_seconds),
        clock=clock,
        **handle_overrides,
    )
    handle.start()
    try:
        outcome = handle.result()
    except BaseException:
        handle.close(discard=True)
        raise
    handle.close()
    if timings is not None:
        timings.record(model, timed.samples)

    orientation = _orient(client, outline_of(doc, rules), windows[0], user_id)
    found = outcome.study
    read = found.read_stats if found is not None else None
    study = Study(
        version=version,
        orientation=orientation or Orientation(),
        glossary=[GlossaryEntry(**g) for g in (found.glossary if found else [])],
        placeholder_tokens=list(found.placeholder_tokens) if found else [],
        verification_statements=list(found.verification_statements) if found else [],
        standards_cited=list(found.standards_cited) if found else [],
        table_roles=[TableRole(**r) for r in (found.table_roles if found else [])],
        vocabulary=vocabulary,
        stats=StudyStats(
            windows_studied=found.windows_studied if found else 0,
            windows_total=len(windows),
            windows_cached=read.windows_cached if read else 0,
            windows_retried=read.windows_retried if read else 0,
            windows_split=read.windows_split if read else 0,
            windows_failed=read.windows_failed if read else 0,
            breaker_opened=read.breaker_opened if read else False,
            budget_stopped=(read.budget_stopped if read else False) or outcome.stopped_by == "deadline",
            budget_seconds=round(budget, 3),
            seconds_per_window=round(seconds_per_window, 3),
            stopped_by=outcome.stopped_by,
            orientation_failed=orientation is None,
        ),
        warnings=list(outcome.warnings),
    )
    if key is not None and study.complete:
        cache.put(key, study)  # type: ignore[union-attr]
    return study


# -- a Study given to /level (CanonicalDoc.study) ----------------------------------------------------------------------------------


def study_of(doc: CanonicalDoc) -> Study | None:
    """The Study the orchestrator put on the document, or None when there is none. One that is not a Study's JSON form is ignored with a
    warning (the caller then takes today's path), never trusted in part."""
    if doc.study is None:
        return None
    try:
        return Study.model_validate(doc.study)
    except ValueError:
        logger.warning("The Study sent with the document is not valid; carrying on without it.")
        return None


def as_document_study(study: Study) -> DocumentStudy | None:
    """The grounded facts in the shape the acceptance-criteria step reads (the background study's), or None when no window was read."""
    s = study.stats
    if s.windows_studied == 0 and not any(
        (study.glossary, study.placeholder_tokens, study.verification_statements, study.standards_cited, study.table_roles)
    ):
        return None
    return DocumentStudy(
        glossary=[g.model_dump() for g in study.glossary],
        placeholder_tokens=list(study.placeholder_tokens),
        verification_statements=list(study.verification_statements),
        standards_cited=list(study.standards_cited),
        table_roles=[r.model_dump() for r in study.table_roles],
        windows_studied=s.windows_studied,
        windows_total=s.windows_total,
        read_stats=StudyReadStats(
            s.windows_retried, s.windows_split, s.windows_failed, s.breaker_opened, s.budget_stopped, s.windows_cached
        ),
    )


_ORIENTATION_LABELS = {
    "document_type": "Document type",
    "purpose": "Purpose",
    "system": "System",
    "conventions": "Conventions",
}


def orientation_text(orientation: Orientation) -> str | None:
    """The orientation as the background text the primer used to be (one labelled line per written field), or None when it is empty."""
    lines = [f"{_ORIENTATION_LABELS[f]}: {getattr(orientation, f)}" for f in ORIENTATION_FIELDS if getattr(orientation, f)]
    return "\n".join(lines) or None
