"""A first, extractive reading of the whole document, before any acceptance-criteria work.

How a document marks an unresolved value (TBD, ??, N, XYZ), how it states verification, what its glossary, standards and tables are, varies
from one document to the next, so the model reads the document once and reports only what the text itself states. Every entry is checked
against the window it came from and dropped when the text does not contain it, so a model answer can never put words in the document's mouth.

Pattern of app.kb.profile (overlapping windows, strict JSON, malformed entries dropped), built for the job's document instead of a KB
document. A window that fails is healed where it can be (a 429 is retried after a jittered wait; a cut-off or empty answer is read again as two
halves) and skipped when it cannot; a run of failures or an exhausted time budget stops the study early with what was read. When nothing
was read the result is None and the caller carries on with the hierarchy alone."""
from __future__ import annotations

import logging
import math
import random
import re
import time
import unicodedata
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol

import httpx

from app.config import settings
from app.job_cancel import JobCancelled, raise_if_cancelled
from app.kb.profile import windows_of
from app.leveling.scoring import _is_splittable_upstream_failure

if TYPE_CHECKING:
    from app.leveling.study_store import StudyStore

logger = logging.getLogger(__name__)

# The study reads the document in windows of its own size (same shape as the KB profile's, tuned separately). The windows depend only on
# the text, never on the model, so the same document is always cut the same way. A document longer than
# settings.survey_study_max_windows windows is studied only up to that cap.
STUDY_WINDOW_CHARS = 20_000
STUDY_WINDOW_OVERLAP = 500
_MAX_QUOTE_CHARS = 300
_MAX_TOKEN_CHARS = 20
# Self-healing of one window: a 429 is retried at most this many times (the client already retried a fast one before we see it, so the
# rounds stay few), after a jittered wait capped at _MAX_BACKOFF_SECONDS, or at _MAX_RETRY_AFTER_SECONDS when the server names a wait.
_MAX_429_RETRIES = 2
_MAX_BACKOFF_SECONDS = 60
_MAX_RETRY_AFTER_SECONDS = 120
_SLEEP_SLICE_SECONDS = 1.0  # a back-off is slept in slices this long, so a cancellation is noticed within one slice
_ANSWER_KEYS = ("glossary", "placeholder_tokens", "verification_statements", "standards_cited", "table_roles", "lead_in_patterns", "purpose_statements")
_MAX_PURPOSE_STATEMENTS = 3  # the overview quotes at most this many, taken in document order
_NEWLINE_PREFERENCE = 0.10  # a newline this close (fraction of the text) to the middle is preferred to a nearer space


class DocumentStudyClient(Protocol):
    def study_document_window(self, window_text: str, user_id: str | None = None) -> dict: ...


@dataclass(frozen=True)
class StudyReadStats:
    """How the study's reading went; windows_split is counted once per window, never per half."""
    windows_retried: int = 0
    windows_split: int = 0
    windows_failed: int = 0
    breaker_opened: bool = False
    budget_stopped: bool = False
    windows_cached: int = 0  # windows served from the study store, not read by the model


@dataclass
class DocumentStudy:
    glossary: list[dict] = field(default_factory=list)  # {term, definition}
    placeholder_tokens: list[str] = field(default_factory=list)
    verification_statements: list[str] = field(default_factory=list)
    standards_cited: list[str] = field(default_factory=list)
    table_roles: list[dict] = field(default_factory=list)  # {table, role}
    lead_in_patterns: list[str] = field(default_factory=list)
    purpose_statements: list[str] = field(default_factory=list)  # sentences the document states its own purpose or scope in
    windows_studied: int = 0
    windows_total: int = 0
    read_stats: StudyReadStats = field(default_factory=StudyReadStats)


@dataclass(frozen=True)
class WindowFindings:
    """What one window states, validated against that window. Immutable, so results of windows read concurrently can only be combined by
    merge_findings."""
    glossary: tuple[tuple[str, str], ...] = ()  # (term, definition)
    placeholder_tokens: tuple[str, ...] = ()
    verification_statements: tuple[str, ...] = ()
    standards_cited: tuple[str, ...] = ()
    table_roles: tuple[tuple[str, str], ...] = ()  # (table, role)
    lead_in_patterns: tuple[str, ...] = ()
    purpose_statements: tuple[str, ...] = ()


def _squash(text: str) -> str:
    return " ".join(text.split()).casefold()


def _canonical(text: str) -> str:
    """The comparison form for de-duplication only (NFKC would rewrite Hebrew presentation forms, so it is never what is stored)."""
    return " ".join(unicodedata.normalize("NFKC", text).split()).casefold()


def _strings(raw: object, window: str, max_chars: int) -> list[str]:
    """The non-empty strings of `raw` that the window text really contains."""
    if not isinstance(raw, list):
        return []
    squashed = _squash(window)
    return [
        item.strip() for item in raw
        if isinstance(item, str) and item.strip() and len(item.strip()) <= max_chars and _squash(item) in squashed
    ]


def _objects(raw: object, *fields: str) -> list[dict]:
    if not isinstance(raw, list):
        return []
    return [
        {f: item[f].strip() for f in fields}
        for item in raw
        if isinstance(item, dict) and all(isinstance(item.get(f), str) and item[f].strip() for f in fields)
    ]


def _is_marker_text(token: str) -> bool:
    """The pipeline's own text, not the document's: a rendering marker ("[TABLE t3]") or the redactor's "<redacted>"."""
    return "[TABLE" in token or "<redacted>" in token.casefold()


def window_findings(answer: object, window: str) -> WindowFindings:
    if not isinstance(answer, dict):
        return WindowFindings()
    squashed = _squash(window)
    glossary = [g for g in _objects(answer.get("glossary"), "term", "definition") if _squash(g["term"]) in squashed]
    # A marker must stand alone in the window exactly as returned (case included): a letter that merely occurs somewhere, or a lowercase
    # variant of "TBD", is not the document's marker.
    tokens = [
        t for t in _strings(answer.get("placeholder_tokens"), window, _MAX_TOKEN_CHARS)
        if not _is_marker_text(t) and contains_token(window, t)
    ]
    table_roles = [r for r in _objects(answer.get("table_roles"), "table", "role") if f"[TABLE {r['table']}]" in window]
    return WindowFindings(
        glossary=tuple((g["term"], g["definition"]) for g in glossary),
        placeholder_tokens=tuple(tokens),
        verification_statements=tuple(_strings(answer.get("verification_statements"), window, _MAX_QUOTE_CHARS)),
        standards_cited=tuple(_strings(answer.get("standards_cited"), window, _MAX_QUOTE_CHARS)),
        table_roles=tuple((r["table"], r["role"]) for r in table_roles),
        lead_in_patterns=tuple(_strings(answer.get("lead_in_patterns"), window, _MAX_QUOTE_CHARS)),
        purpose_statements=tuple(_strings(answer.get("purpose_statements"), window, _MAX_QUOTE_CHARS)),
    )


def _first_of_each(items: Iterable, key) -> list:
    """The first item for each distinct key, in order."""
    seen: set = set()
    kept = []
    for item in items:
        k = key(item)
        if k not in seen:
            seen.add(k)
            kept.append(item)
    return kept


def merge_findings(indexed: Iterable[tuple[int, WindowFindings]]) -> DocumentStudy:
    """Pure and order-free: sorted by window index first, so whichever order windows finished in, the result is the same. Entries are
    de-duplicated by their canonical form (NFKC, case-folded, whitespace squashed) keeping the first verbatim spelling in window order;
    markers are the document's own case-sensitive text, so those are compared exactly. windows_total is the caller's to set."""
    ordered = [found for _, found in sorted(indexed, key=lambda pair: pair[0])]

    def gather(name: str) -> list:
        return [item for found in ordered for item in getattr(found, name)]

    return DocumentStudy(
        glossary=[
            {"term": t, "definition": d} for t, d in _first_of_each(gather("glossary"), lambda g: _canonical(g[0]))
        ],
        placeholder_tokens=_first_of_each(gather("placeholder_tokens"), lambda t: t),
        verification_statements=_first_of_each(gather("verification_statements"), _canonical),
        standards_cited=_first_of_each(gather("standards_cited"), _canonical),
        table_roles=[
            {"table": t, "role": r} for t, r in _first_of_each(gather("table_roles"), lambda r: _canonical(r[0]))
        ],
        lead_in_patterns=_first_of_each(gather("lead_in_patterns"), _canonical),
        purpose_statements=_first_of_each(gather("purpose_statements"), _canonical)[:_MAX_PURPOSE_STATEMENTS],
        windows_studied=len(ordered),
    )


def combine_window_findings(parts: Iterable[WindowFindings]) -> WindowFindings:
    """The findings of a window's halves as one window's, in the order given (no de-duplication: merge_findings does that)."""
    parts = list(parts)
    return WindowFindings(**{
        name: tuple(item for part in parts for item in getattr(part, name))
        for name in WindowFindings.__dataclass_fields__
    })


def _nearest(text: str, middle: int, wanted: Callable[[str], bool], radius: int) -> int | None:
    """The index within `radius` of `middle` of the nearest character that is `wanted` (the earlier one on a tie), else None."""
    for distance in range(radius + 1):
        for cut in (middle - distance, middle + distance):
            if 0 <= cut < len(text) and wanted(text[cut]):
                return cut
    return None


def split_window(text: str) -> tuple[str, str]:
    """Two non-overlapping halves, cut at the whitespace character nearest the middle (a newline within 10% of the middle wins over a
    nearer space; no whitespace at all: cut at the middle). That one whitespace character is the only text dropped."""
    middle = len(text) // 2
    cut = _nearest(text, middle, lambda c: c == "\n", max(1, int(len(text) * _NEWLINE_PREFERENCE)))
    if cut is None:
        cut = _nearest(text, middle, str.isspace, len(text))
    if cut is None:
        return text[:middle], text[middle:]
    return text[:cut], text[cut + 1:]


class _Rng(Protocol):
    def uniform(self, a: float, b: float) -> float: ...


@dataclass(frozen=True)
class WindowRead:
    """The outcome of reading one window. findings is None when nothing was read; failed means the window was NOT fully studied (a whole
    read, or both halves), even when one half's findings are kept."""
    findings: WindowFindings | None
    retries: int = 0
    split: bool = False
    failed: bool = False


def _failure_label(error: BaseException | None) -> str:
    """What a log line may say about a failed read: the HTTP status or the exception type, never its text (a malformed-answer error carries
    the model's output, which can quote the document)."""
    if isinstance(error, httpx.HTTPStatusError):
        return f"HTTP {error.response.status_code}"
    return type(error).__name__


def _retry_after_seconds(error: httpx.HTTPStatusError) -> float | None:
    """The header's delay in seconds; an HTTP-date, a negative or a non-finite value is ignored."""
    try:
        seconds = float(error.response.headers.get("Retry-After"))
    except (TypeError, ValueError):
        return None
    return seconds if math.isfinite(seconds) and seconds >= 0 else None


def _backoff_seconds(error: httpx.HTTPStatusError, attempt: int, rng: _Rng) -> float:
    hinted = _retry_after_seconds(error)
    if hinted is not None:
        return min(hinted, _MAX_RETRY_AFTER_SECONDS) + rng.uniform(0, 1)
    return rng.uniform(0, min(_MAX_BACKOFF_SECONDS, 2 * 2 ** attempt))


def _is_rate_limited(error: BaseException) -> bool:
    return isinstance(error, httpx.HTTPStatusError) and error.response.status_code == 429


def _cancellable_sleep(seconds: float) -> None:
    """time.sleep in slices of at most a second, raising JobCancelled before each slice once the run is cancelled."""
    remaining = seconds
    while remaining > 0:
        raise_if_cancelled()
        piece = min(remaining, _SLEEP_SLICE_SECONDS)
        time.sleep(piece)
        remaining -= piece


def _checked_answer(answer: object) -> dict:
    """The model's answer when it has the shape the schema demands: all six keys, each a list (all of them empty is a legitimately empty
    window, e.g. a table of contents). Anything else is malformed, so the window is read again as halves and never counted as studied."""
    if not isinstance(answer, dict) or not all(isinstance(answer.get(key), list) for key in _ANSWER_KEYS):
        raise ValueError("malformed study answer")
    return answer


def _read_text(
    client: DocumentStudyClient, text: str, user_id: str | None, sleep: Callable[[float], None], rng: _Rng, max_429_retries: int,
) -> tuple[WindowFindings | None, int, Exception | None]:
    """One text read, retrying a 429 up to `max_429_retries` times. Returns the findings (None on failure), the retries made and the
    error that ended the read; JobCancelled propagates."""
    retries = 0
    while True:
        try:
            return window_findings(_checked_answer(client.study_document_window(text, user_id=user_id)), text), retries, None
        except JobCancelled:
            raise
        except Exception as error:  # noqa: BLE001 -- best-effort context: the caller classifies the failure
            if not _is_rate_limited(error) or retries >= max_429_retries:
                return None, retries, error
            sleep(_backoff_seconds(error, retries, rng))  # type: ignore[arg-type]
            retries += 1


def read_window(
    client: DocumentStudyClient,
    text: str,
    user_id: str | None = None,
    sleep: Callable[[float], None] = _cancellable_sleep,
    rng: _Rng | None = None,
) -> WindowRead:
    """Reads one window and heals what it can; shares no state, so windows can be read from different threads. A 429 is retried (twice at
    most) after a jittered wait; a cut-off, 5xx, 400 or empty/malformed answer reads the window once as two halves, each half once (one retry
    of a 429 allowed); anything else skips the window. JobCancelled always propagates."""
    rng = rng or random.Random()
    findings, retries, error = _read_text(client, text, user_id, sleep, rng, _MAX_429_RETRIES)
    if error is None:
        return WindowRead(findings, retries)
    if not (_is_splittable_upstream_failure(error) or isinstance(error, ValueError)):
        logger.warning("Document study: a window could not be read (%s); skipping it.", _failure_label(error))
        return WindowRead(None, retries, failed=True)
    logger.warning("Document study: a window could not be read whole (%s); reading it as two halves.", _failure_label(error))
    halves: list[WindowFindings] = []
    half_failed = False
    for half in split_window(text):
        if not half.strip():  # nothing to read: neither a finding nor a failure
            continue
        found, half_retries, half_error = _read_text(client, half, user_id, sleep, rng, 1)
        retries += half_retries
        if found is None:  # a half that fails again is lost, the other half is kept
            logger.warning("Document study: half of a window could not be read (%s); skipping it.", _failure_label(half_error))
            half_failed = True
        else:
            halves.append(found)
    return WindowRead(combine_window_findings(halves) if halves else None, retries, split=True, failed=half_failed)


def study_document(
    document_text: str,
    client: DocumentStudyClient,
    user_id: str | None = None,
    *,
    sleep: Callable[[float], None] = _cancellable_sleep,
    rng: _Rng | None = None,
    clock: Callable[[], float] = time.monotonic,
    store: StudyStore | None = None,
    scope: str | None = None,
    model: str | None = None,
) -> DocumentStudy | None:
    if not document_text.strip():
        return None
    windows = windows_of(document_text, STUDY_WINDOW_CHARS, STUDY_WINDOW_OVERLAP)
    run = store.run(scope or "anon", model, document_text) if store is not None else None
    results: list[tuple[int, WindowFindings]] = []
    studied = retried = split = failed = cached = consecutive_failures = 0
    breaker_opened = budget_stopped = soft_warned = False
    stopped = False  # once the breaker or the budget has tripped, only the store is consulted: no model call, no wait
    started = clock()
    try:
        for index, window in enumerate(windows[:settings.survey_study_max_windows]):
            stored = run.get(index) if run is not None else None
            if stored is not None:  # a window already studied: no model call, no budget, no wait
                results.append((index, stored))
                studied += 1
                cached += 1
                consecutive_failures = 0
                continue
            if stopped:
                continue
            elapsed = clock() - started
            if elapsed >= settings.survey_study_hard_budget_seconds:
                logger.warning("Document study: the %ss time budget is spent; stopping with %d window(s) read.",
                               settings.survey_study_hard_budget_seconds, studied)
                budget_stopped = stopped = True
                continue
            if not soft_warned and elapsed >= settings.survey_study_soft_budget_seconds:
                logger.warning("Document study: past %ss and still reading (window %d of %d).",
                               settings.survey_study_soft_budget_seconds, index + 1, len(windows))
                soft_warned = True
            read = read_window(client, window, user_id, sleep, rng)
            retried += read.retries > 0
            split += read.split
            failed += read.failed
            findings = read.findings
            if findings is not None and run is not None and not read.failed:
                findings = run.put(index, findings)  # the first writer's findings win, so concurrent jobs agree
            if findings is not None:
                results.append((index, findings))
            if read.failed:
                consecutive_failures += 1
                if consecutive_failures >= settings.survey_study_breaker_failures:
                    logger.warning("Document study: %d windows in a row could not be read; stopping the study.", consecutive_failures)
                    breaker_opened = stopped = True
            else:
                studied += 1
                consecutive_failures = 0
    except BaseException:  # a cancelled or failed run removes what it stored; a finished one (even partial) keeps it as the cache
        if run is not None:
            run.cleanup()
        raise
    if not results:
        return None
    study = merge_findings(results)
    study.windows_studied = studied  # a window with only one half read keeps its findings but does not count as studied
    study.windows_total = len(windows)
    study.read_stats = StudyReadStats(retried, split, failed, breaker_opened, budget_stopped, cached)
    return study


def contains_token(text: str, token: str) -> bool:
    """True when `token` stands alone in `text`, case-sensitive: the document's own marker, as written. Never inside a longer word and
    never joined to a neighbour by "/" or "+" ("Y/N", "N+1"). Short alphabetic markers ("N", "X", "XX") are also ignored right after a
    number ("50 N" is a unit) and when part of a name or assignment ("X-ray", "N-1", "N=5"); "TBD", "??" and the like are not."""
    escaped = re.escape(token)
    before, after = r"(?<![\w/+])", r"(?![\w/+])"
    if token.isalpha() and len(token) <= 2:
        before += r"(?<!\d)(?<!\d )(?<!\w-)(?<!\w\.)"
        after += r"(?!-\w)(?!\.\w)(?!=)"
    elif not any(c.isalnum() for c in token):
        # "what??" is prose, "10??" is a number left unresolved: only a letter in front rules it out.
        before = r"(?<![A-Za-z/+])(?<!" + re.escape(token[0]) + ")"
        after += "(?!" + re.escape(token[-1]) + ")"
    return re.search(f"{before}{escaped}{after}", text) is not None
