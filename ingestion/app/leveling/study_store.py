"""Per-user storage of what each fully studied window of a document states (app.leveling.document_study), in Redis.

It lets the same user's re-run of a document, or a run resumed after a crash, skip the model calls for windows already studied, and makes
two concurrent jobs of one user over one document settle on one stored study (first writer wins; the loser reads the winner back). A run
deletes only the keys it wrote itself when it is cancelled or fails; every key expires on its own and carries the user's hashed scope
(app.request_identity.user_scope), so nothing is shared between users and the raw user id is never in a key or a log line.

The stored value holds only the validated findings (short quotes and glossary definitions taken from the document), never the window text.

Fail open, like app.survey.llm_cache: with no Redis client, or after any Redis error, the run behaves as if there were no store (one
warning per run, without keys or user data).

Thread use: every call on a StudyRun is made from ONE coordinator thread (a run keeps a plain list of the keys it wrote, no locks)."""
from __future__ import annotations

import hashlib
import inspect
import json
import logging
import uuid

from app.leveling.document_study import (
    _MAX_QUOTE_CHARS, _MAX_TOKEN_CHARS, STUDY_WINDOW_CHARS, STUDY_WINDOW_OVERLAP, WindowFindings,
    _checked_answer, _is_marker_text, contains_token, window_findings,
)
from app.kb.profile import windows_of
from app.prompts import load_prompt
from app.survey._response_schemas import document_study_schema

logger = logging.getLogger(__name__)

# Bump when the extraction/validation code (window_findings and what it keeps) changes meaning, so stored findings stop applying.
_CODE_PASS_VERSION = "1"

_PAIR_FIELDS = ("glossary", "table_roles")


def _source_of(fn) -> str:
    try:
        return inspect.getsource(fn)
    except (OSError, TypeError):
        return fn.__qualname__


def study_version() -> str:
    """Identifies how a window is read: change the prompt, the schema, the window size, the quote/token limits or the code pass and stored findings no longer
    apply (precedent: app.kb.profile.extraction_version). The source of the validation functions is part of it, so editing them invalidates
    stored findings even when _CODE_PASS_VERSION is not bumped; so is windows_of (app.kb.profile), which defines what window index i means."""
    parts = [
        load_prompt("study_document"), json.dumps(document_study_schema(), sort_keys=True),
        STUDY_WINDOW_CHARS, STUDY_WINDOW_OVERLAP, _MAX_QUOTE_CHARS, _MAX_TOKEN_CHARS, _CODE_PASS_VERSION,
        *(_source_of(fn) for fn in (window_findings, contains_token, _is_marker_text, _checked_answer, windows_of)),
    ]
    return hashlib.sha256(json.dumps(parts).encode("utf-8")).hexdigest()[:12]


def _is_strings(value: object) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _is_pairs(value: object) -> bool:
    return isinstance(value, list) and all(isinstance(p, list) and len(p) == 2 and _is_strings(p) for p in value)


def _parse(raw: object) -> WindowFindings | None:
    """The findings a stored value holds, or None when it is not exactly the shape this module writes."""
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    names = set(WindowFindings.__dataclass_fields__)
    if not isinstance(data, dict) or set(data) != names:
        return None
    if not all(_is_pairs(data[n]) if n in _PAIR_FIELDS else _is_strings(data[n]) for n in names):
        return None
    return WindowFindings(**{
        n: tuple(tuple(item) if n in _PAIR_FIELDS else item for item in data[n]) for n in names
    })


def _dump(findings: WindowFindings) -> str:
    return json.dumps({n: getattr(findings, n) for n in WindowFindings.__dataclass_fields__}, ensure_ascii=False, separators=(",", ":"))


class StudyStore:
    """`redis_client` is any object with get(key), set(key, value, ex=..., nx=...) and delete(*keys), or None for no store."""

    def __init__(self, redis_client, ttl_seconds: int) -> None:
        self._redis = redis_client
        self._ttl_seconds = ttl_seconds

    def run(self, scope: str, model: str | None, document_text: str) -> "StudyRun":
        """One study run over one document; `scope` is the already-hashed user_scope(user_id)."""
        prefix = f"study:{study_version()}:{scope}:{hashlib.sha256(document_text.encode('utf-8')).hexdigest()[:24]}:{model or 'default'}"
        return StudyRun(self._redis, self._ttl_seconds, prefix)


class StudyRun:
    def __init__(self, redis_client, ttl_seconds: int, prefix: str) -> None:
        self._redis = redis_client
        self._ttl_seconds = ttl_seconds
        self._prefix = prefix
        self._written: list[str] = []
        self._down = redis_client is None
        self._warned = False
        self.nonce = uuid.uuid4().hex  # for logs and tests only

    def _key(self, index: int) -> str:
        return f"{self._prefix}:w{index}"

    def _fail(self, action: str, error: Exception) -> None:
        """The store is treated as absent for the rest of the run; one warning, never the key or the error text (it may carry the key)."""
        self._down = True
        if not self._warned:
            self._warned = True
            logger.warning("Study store unavailable (%s: %s); the document study runs without it.", action, type(error).__name__)

    def get(self, index: int) -> WindowFindings | None:
        """The stored findings of window `index`; a missing, unreadable or foreign value is a miss and is never deleted."""
        if self._down:
            return None
        try:
            raw = self._redis.get(self._key(index))
        except Exception as error:  # noqa: BLE001 -- fail open
            self._fail("get", error)
            return None
        return None if raw is None else _parse(raw)

    def put(self, index: int, findings: WindowFindings) -> WindowFindings:
        """Stores the findings if no run has yet and returns what to use: the first writer's findings (read back) when this run lost the
        race, else its own."""
        if self._down:
            return findings
        key = self._key(index)
        try:
            if self._redis.set(key, _dump(findings), ex=self._ttl_seconds, nx=True):
                self._written.append(key)
                return findings
            winner = _parse(self._redis.get(key))
        except Exception as error:  # noqa: BLE001 -- fail open
            self._fail("put", error)
            return findings
        return winner if winner is not None else findings

    def cleanup(self) -> None:
        """Deletes exactly the keys this run wrote (never another run's, even for the same user and document)."""
        if not self._written or self._redis is None:
            return
        keys, self._written = self._written, []
        try:
            self._redis.delete(*keys)
        except Exception as error:  # noqa: BLE001 -- the keys expire on their own
            self._fail("cleanup", error)
