import json
import logging

import pytest

from app.job_cancel import JobCancelled
from app.kb.profile import windows_of
from app.leveling import document_study as study_document_module
from app.leveling import study_store as study_store_module
from app.leveling.document_study import (
    STUDY_WINDOW_CHARS,
    STUDY_WINDOW_OVERLAP,
    StudyReadStats,
    WindowFindings,
    study_document,
)
from app.leveling.study_store import StudyStore, study_version
from app.request_identity import user_scope


class _FakeRedis:
    """In-memory stand-in for redis-py: SET honours NX (True, or None when the key exists) and every set records its TTL."""

    def __init__(self) -> None:
        self.data: dict[str, bytes] = {}
        self.ttls: dict[str, int | None] = {}
        self.sets = 0

    def get(self, key):
        return self.data.get(key)

    def set(self, key, value, ex=None, nx=False):
        self.sets += 1
        if nx and key in self.data:
            return None
        self.data[key] = value.encode() if isinstance(value, str) else value
        self.ttls[key] = ex
        return True

    def delete(self, *keys):
        return sum(self.data.pop(key, None) is not None for key in keys)


class _DownRedis:
    def __init__(self) -> None:
        self.calls = 0

    def _boom(self, *args, **kwargs):
        self.calls += 1
        raise ConnectionError("redis is down")

    get = set = delete = _boom


_EMPTY = {
    "glossary": [], "placeholder_tokens": [], "verification_statements": [], "standards_cited": [], "table_roles": [],
}


class _Client:
    """Answers each window by its position in the document, so two runs over one document get the same findings; counts calls."""

    def __init__(self, fail_on: int | None = None, error: Exception | None = None, cancel_on: int | None = None) -> None:
        self.windows: list[str] = []
        self.fail_on, self.error, self.cancel_on = fail_on, error, cancel_on

    def study_document_window(self, window_text: str, user_id: str | None = None) -> dict:
        self.windows.append(window_text)
        n = len(self.windows)
        if n == self.cancel_on:
            raise JobCancelled("gone")
        if n == self.fail_on:
            raise self.error
        return {**_EMPTY, "placeholder_tokens": ["word"], "standards_cited": ["word word"], "verification_statements": ["word"]}


DOC = ("word " * 7000) + "TBD " + ("word " * 7000)
WINDOWS = len(windows_of(DOC, STUDY_WINDOW_CHARS, STUDY_WINDOW_OVERLAP))
SCOPE = user_scope("Microsoft.Identity;distinctive-user@example.com")


def _store(redis=None, ttl: int = 60) -> StudyStore:
    return StudyStore(redis if redis is not None else _FakeRedis(), ttl)


def _findings(token: str) -> WindowFindings:
    return WindowFindings(placeholder_tokens=(token,), glossary=(("term", "definition"),), table_roles=(("t1", "role"),))


def test_second_writer_gets_first_result() -> None:
    redis = _FakeRedis()
    first, second = _store(redis).run(SCOPE, None, DOC), _store(redis).run(SCOPE, None, DOC)

    assert first.put(0, _findings("A")) == _findings("A")
    assert second.put(0, _findings("B")) == _findings("A")  # the loser reads the winner back
    assert len(redis.data) == 1
    second.cleanup()  # the loser wrote nothing, so it deletes nothing
    assert len(redis.data) == 1

    studies = [study_document(DOC, _Client(), store=_store(redis), scope=SCOPE) for _ in range(2)]
    for study in studies:
        study.read_stats = StudyReadStats()  # only how each job got its windows differs
    assert studies[0] == studies[1]
    assert studies[0].placeholder_tokens[0] == "A"  # window 0 is the first writer's, in both jobs


def test_resume_skips_stored_windows() -> None:
    redis = _FakeRedis()
    first_client, second_client = _Client(), _Client()

    first = study_document(DOC, first_client, store=_store(redis), scope=SCOPE)
    second = study_document(DOC, second_client, store=_store(redis), scope=SCOPE)

    assert len(first_client.windows) == WINDOWS and second_client.windows == []
    assert first.read_stats.windows_cached == 0 and second.read_stats.windows_cached == WINDOWS
    assert second.windows_studied == second.windows_total == WINDOWS
    assert second.read_stats.windows_cached == WINDOWS
    first.read_stats = second.read_stats
    assert first == second


def test_cancel_deletes_only_own_keys() -> None:
    redis = _FakeRedis()
    other_run = _store(redis).run(SCOPE, None, DOC)
    other_run.put(0, _findings("earlier"))  # same user, same document, written by a run that is still alive
    foreign = _store(redis).run("0123456789abcdef", None, DOC)
    foreign.put(1, _findings("other user"))
    earlier_keys = set(redis.data)

    client = _Client(cancel_on=3)  # window 0 is served from the store, windows 1 and 2 are written, 3 is cancelled
    with pytest.raises(JobCancelled):
        study_document(DOC, client, store=_store(redis), scope=SCOPE)

    assert set(redis.data) == earlier_keys | set()  # this run's keys are gone; the other two remain
    assert len(redis.data) == 2


def test_failure_deletes_own_keys(monkeypatch) -> None:
    redis = _FakeRedis()
    client = _Client()
    real = study_document_module.read_window

    def exploding(client_, text, *args, **kwargs):
        if len(client_.windows) == 2:
            raise RuntimeError("unexpected")
        return real(client_, text, *args, **kwargs)

    monkeypatch.setattr(study_document_module, "read_window", exploding)

    with pytest.raises(RuntimeError, match="unexpected"):
        study_document(DOC, client, store=_store(redis), scope=SCOPE)

    assert len(client.windows) == 2 and redis.data == {}


def test_success_and_partial_completion_keep_keys(monkeypatch) -> None:
    redis = _FakeRedis()
    study_document(DOC, _Client(), store=_store(redis), scope=SCOPE)
    assert len(redis.data) == WINDOWS

    class _FailsAfterFirst(_Client):
        def study_document_window(self, window_text, user_id=None):
            if self.windows:
                self.windows.append(window_text)
                raise PermissionError("denied")
            return super().study_document_window(window_text, user_id)

    partial = _FakeRedis()
    monkeypatch.setattr(study_document_module.settings, "survey_study_breaker_failures", 1)
    study = study_document(DOC, _FailsAfterFirst(), store=_store(partial), scope=SCOPE)

    assert study.read_stats.breaker_opened and len(partial.data) == 1


def test_partial_window_is_never_stored() -> None:
    redis = _FakeRedis()
    text = "Latency shall be TBD ms.\nPower per MIL-STD-704 applies."

    class _HalfFails:
        def __init__(self) -> None:
            self.n = 0

        def study_document_window(self, window_text, user_id=None):
            self.n += 1
            if self.n == 1:
                raise ValueError("cut off")  # whole read fails -> read as two halves
            if self.n == 3:
                raise PermissionError("second half denied")
            return {**_EMPTY, "placeholder_tokens": ["TBD"]}

    study = study_document(text, _HalfFails(), store=_store(redis), scope=SCOPE)

    assert study.placeholder_tokens == ["TBD"] and study.windows_studied == 0
    assert redis.data == {}


def test_stored_value_holds_findings_only_not_the_window_text() -> None:
    redis = _FakeRedis()
    user_id = "distinctive-user@example.com"
    study_document(DOC, _Client(), user_id=user_id, store=_store(redis), scope=user_scope(user_id))

    assert redis.data
    for key, value in redis.data.items():
        stored = json.loads(value)
        assert set(stored) == set(WindowFindings.__dataclass_fields__)
        assert len(value) < 400 < STUDY_WINDOW_CHARS // 10
        assert "word word word" not in value.decode()


def test_stored_value_never_holds_window_text_the_model_did_not_return() -> None:
    redis = _FakeRedis()
    sentence = "Zebra quartz jumps over the lazy xylophone"

    class _Quoting:
        def study_document_window(self, window_text, user_id=None):
            return {**_EMPTY, "verification_statements": ["TBD"]}

    study_document(f"{sentence}. Latency shall be TBD ms.", _Quoting(), store=_store(redis), scope=SCOPE)

    assert redis.data
    assert all(sentence.casefold() not in value.decode().casefold() and "Zebra" not in value.decode() for value in redis.data.values())


def test_every_key_has_ttl() -> None:
    redis = _FakeRedis()
    study_document(DOC, _Client(), store=_store(redis, ttl=1234), scope=SCOPE)

    assert redis.ttls and set(redis.ttls.values()) == {1234} and set(redis.ttls) == set(redis.data)


def test_keys_never_contain_the_raw_user_id() -> None:
    redis = _FakeRedis()
    user_id = "Microsoft.Identity;distinctive-user@example.com"
    study_document(DOC, _Client(), user_id=user_id, store=_store(redis), scope=user_scope(user_id))

    pieces = {user_id[i:i + 7] for i in range(len(user_id) - 6)}
    for key in redis.data:
        assert user_scope(user_id) in key and not any(piece in key for piece in pieces)


def test_other_user_scope_does_not_share() -> None:
    redis = _FakeRedis()
    study_document(DOC, _Client(), store=_store(redis), scope=SCOPE)
    other = _Client()

    study = study_document(DOC, other, store=_store(redis), scope=user_scope("someone-else"))

    assert len(other.windows) == WINDOWS and study.read_stats.windows_cached == 0
    assert len(redis.data) == 2 * WINDOWS


def test_study_version_changes_with_prompt_window_size_or_code_pass(monkeypatch) -> None:
    base = study_version()
    assert len(base) == 12 and base == study_version()

    monkeypatch.setattr(study_store_module, "STUDY_WINDOW_CHARS", STUDY_WINDOW_CHARS + 1)
    assert study_version() != base
    monkeypatch.setattr(study_store_module, "STUDY_WINDOW_CHARS", STUDY_WINDOW_CHARS)
    monkeypatch.setattr(study_store_module, "STUDY_WINDOW_OVERLAP", STUDY_WINDOW_OVERLAP + 1)
    assert study_version() != base
    monkeypatch.setattr(study_store_module, "STUDY_WINDOW_OVERLAP", STUDY_WINDOW_OVERLAP)
    monkeypatch.setattr(study_store_module, "_CODE_PASS_VERSION", "2")
    assert study_version() != base
    monkeypatch.setattr(study_store_module, "_CODE_PASS_VERSION", "1")
    assert study_version() == base
    real_load_prompt = study_store_module.load_prompt
    monkeypatch.setattr(study_store_module, "load_prompt", lambda name, *a, **k: real_load_prompt(name, *a, **k) + " changed")
    assert study_version() != base
    monkeypatch.undo()
    monkeypatch.setattr(study_store_module, "document_study_schema", lambda: {"changed": True})
    assert study_version() != base


def test_study_version_changes_when_validation_source_changes(monkeypatch) -> None:
    base = study_version()
    assert base == study_version()

    monkeypatch.setattr(study_store_module.inspect, "getsource", lambda fn: "def changed(): pass")
    assert study_version() != base
    monkeypatch.undo()
    assert study_version() == base


def test_study_version_changes_when_the_source_of_windows_of_changes(monkeypatch) -> None:
    """windows_of defines what window index i means, so editing it must invalidate stored windows."""
    base = study_version()
    real_getsource = study_store_module.inspect.getsource
    monkeypatch.setattr(
        study_store_module.inspect, "getsource",
        lambda fn: real_getsource(fn) + "# changed" if fn is study_store_module.windows_of else real_getsource(fn),
    )
    assert study_version() != base
    monkeypatch.undo()
    assert study_version() == base


def test_study_version_survives_unavailable_source(monkeypatch) -> None:
    def no_source(fn):
        raise OSError("source not available")

    monkeypatch.setattr(study_store_module.inspect, "getsource", no_source)
    assert len(study_version()) == 12


def test_key_layout_has_version_scope_document_model_and_window() -> None:
    redis = _FakeRedis()
    run = _store(redis).run(SCOPE, "model-x", DOC)
    run.put(3, _findings("A"))
    run_default = _store(redis).run(SCOPE, None, DOC)
    run_default.put(3, _findings("A"))

    keys = sorted(redis.data)
    assert all(k.startswith(f"study:{study_version()}:{SCOPE}:") for k in keys)
    assert keys[0].endswith(":default:w3") and keys[1].endswith(":model-x:w3")


def test_malformed_stored_value_is_a_miss_and_not_deleted() -> None:
    redis = _FakeRedis()
    seed = _store(redis).run(SCOPE, None, DOC)
    seed.put(0, _findings("A"))
    (key,) = redis.data
    valid = json.loads(redis.data[key])
    for foreign in (b"not json", b"[1, 2]", b'{"glossary": "x"}', json.dumps({**valid, "placeholder_tokens": [1]}).encode(),
                    json.dumps({**valid, "glossary": [["only-one"]]}).encode(), json.dumps({"glossary": []}).encode()):
        redis.data[key] = foreign
        run = _store(redis).run(SCOPE, None, DOC)
        assert run.get(0) is None
        assert run.put(0, _findings("B")) == _findings("B")  # lost the race to a value it cannot read: own findings, nothing stored
        run.cleanup()
        assert redis.data[key] == foreign


def test_redis_down_runs_uncached_and_warns_once(caplog) -> None:
    redis = _DownRedis()
    client = _Client()

    with caplog.at_level(logging.WARNING, logger="app.leveling.study_store"):
        study = study_document(DOC, client, store=_store(redis), scope=SCOPE)

    assert study is not None and study.windows_studied == WINDOWS and len(client.windows) == WINDOWS
    warnings = [r for r in caplog.records if r.name == "app.leveling.study_store"]
    assert len(warnings) == 1 and SCOPE not in warnings[0].getMessage()


def test_no_redis_client_behaves_as_no_store() -> None:
    client = _Client()
    study = study_document(DOC, client, store=StudyStore(None, 60), scope=SCOPE)

    assert study == study_document(DOC, _Client()) and study.read_stats.windows_cached == 0


def test_no_store_is_unchanged_behaviour() -> None:
    client = _Client()

    study = study_document(DOC, client)

    assert len(client.windows) == WINDOWS and study.read_stats.windows_cached == 0
    assert study.windows_studied == WINDOWS


def test_degenerate_answers_are_never_stored_but_an_all_empty_answer_is() -> None:
    redis = _FakeRedis()
    text = "Latency shall be TBD ms.\nPower per MIL-STD-704 applies."

    class _Degenerate:
        def study_document_window(self, window_text, user_id=None):
            return {"glossary": []}

    study = study_document(text, _Degenerate(), store=_store(redis), scope=SCOPE)

    assert study is None and redis.data == {}  # nothing was read, nothing is cached as studied

    class _Toc:
        def study_document_window(self, window_text, user_id=None):
            return _EMPTY

    study = study_document(text, _Toc(), store=_store(redis), scope=SCOPE)

    assert study is not None and study.windows_studied == 1
    assert len(redis.data) == 1 and json.loads(next(iter(redis.data.values())))["placeholder_tokens"] == []


def _store_windows(redis: _FakeRedis, indexes) -> None:
    run = _store(redis).run(SCOPE, None, DOC)
    for index in indexes:
        run.put(index, _findings(f"S{index}"))


def test_windows_stored_after_the_breaker_trips_are_still_used(monkeypatch) -> None:
    monkeypatch.setattr(study_document_module.settings, "survey_study_breaker_failures", 2)
    redis = _FakeRedis()
    _store_windows(redis, [2, 3])

    class _AlwaysDenied(_Client):
        def study_document_window(self, window_text, user_id=None):
            self.windows.append(window_text)
            raise PermissionError("denied")

    client = _AlwaysDenied()
    slept: list[float] = []

    study = study_document(DOC, client, store=_store(redis), scope=SCOPE, sleep=slept.append)

    assert len(client.windows) == 2 and slept == []  # two failures open the breaker; windows 2 and 3 cost no model call
    assert study.read_stats.breaker_opened and study.read_stats.windows_cached == 2
    assert study.placeholder_tokens == ["S2", "S3"] and study.windows_studied == 2


def test_an_unstored_window_after_the_breaker_is_skipped_unread(monkeypatch) -> None:
    monkeypatch.setattr(study_document_module.settings, "survey_study_breaker_failures", 1)
    redis = _FakeRedis()
    _store_windows(redis, [3])

    class _AlwaysDenied(_Client):
        def study_document_window(self, window_text, user_id=None):
            self.windows.append(window_text)
            raise PermissionError("denied")

    client = _AlwaysDenied()

    study = study_document(DOC, client, store=_store(redis), scope=SCOPE)

    assert len(client.windows) == 1  # window 0 trips the breaker; 1 and 2 are unstored: skipped, not read
    assert study.placeholder_tokens == ["S3"] and (study.windows_studied, study.windows_total) == (1, WINDOWS)


def test_windows_stored_after_the_hard_budget_are_still_used(monkeypatch) -> None:
    monkeypatch.setattr(study_document_module.settings, "survey_study_hard_budget_seconds", 10)
    redis = _FakeRedis()
    _store_windows(redis, [3])
    now = [0.0]

    class _Slow(_Client):
        def study_document_window(self, window_text, user_id=None):
            now[0] += 60
            return super().study_document_window(window_text, user_id)

    client = _Slow()

    study = study_document(DOC, client, store=_store(redis), scope=SCOPE, clock=lambda: now[0])

    assert len(client.windows) == 1  # the budget is spent after window 0
    assert study.read_stats.budget_stopped and study.read_stats.windows_cached == 1
    assert "S3" in study.placeholder_tokens and study.windows_studied == 2


def test_study_version_changes_with_the_quote_and_token_limits(monkeypatch) -> None:
    base = study_version()

    monkeypatch.setattr(study_store_module, "_MAX_QUOTE_CHARS", study_document_module._MAX_QUOTE_CHARS + 1)
    assert study_version() != base
    monkeypatch.setattr(study_store_module, "_MAX_QUOTE_CHARS", study_document_module._MAX_QUOTE_CHARS)
    monkeypatch.setattr(study_store_module, "_MAX_TOKEN_CHARS", study_document_module._MAX_TOKEN_CHARS + 1)
    assert study_version() != base
    monkeypatch.setattr(study_store_module, "_MAX_TOKEN_CHARS", study_document_module._MAX_TOKEN_CHARS)
    assert study_version() == base
