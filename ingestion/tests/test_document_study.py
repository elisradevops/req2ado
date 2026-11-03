import itertools
import logging

import httpx
import pytest

from app.config import settings
from app.job_cancel import JobCancelled
from app.kb.profile import windows_of
from app.leveling.document_study import (
    STUDY_WINDOW_CHARS,
    STUDY_WINDOW_OVERLAP,
    DocumentStudy,
    StudyReadStats,
    WindowFindings,
    combine_window_findings,
    merge_findings,
    read_window,
    split_window,
    study_document,
    window_findings,
)


_EMPTY_ANSWER = {
    "glossary": [], "placeholder_tokens": [], "verification_statements": [], "standards_cited": [], "table_roles": [], "lead_in_patterns": [],
}


class _StubClient:
    """`raw` answers are returned as given; otherwise a dict answer is completed to the six keys the schema requires."""

    def __init__(self, answers: list[dict | Exception], raw: bool = False) -> None:
        self._answers = list(answers)
        self._raw = raw
        self.windows: list[str] = []

    def study_document_window(self, window_text: str, user_id: str | None = None) -> dict:
        self.windows.append(window_text)
        answer = self._answers.pop(0) if self._answers else {}
        if isinstance(answer, Exception):
            raise answer
        return answer if self._raw or not isinstance(answer, dict) else {**_EMPTY_ANSWER, **answer}


TEXT = "Report rate shall be N Hz. Latency shall be TBD ms. Power per MIL-STD-704 and VITA 65.\n[TABLE t1]\n| a | b |"


def test_keeps_only_what_the_window_text_states() -> None:
    client = _StubClient([{
        "glossary": [{"term": "SRU", "definition": "Shop replaceable unit"}, {"term": "LRU", "definition": "invented"}],
        "placeholder_tokens": ["N", "TBD", "XYZ"],
        "verification_statements": ["Report rate shall be N Hz.", "verified by magic"],
        "standards_cited": ["MIL-STD-704", "ISO 9999"],
        "table_roles": [{"table": "t1", "role": "configuration values"}, {"table": "t9", "role": "ghost"}],
        "lead_in_patterns": ["Latency shall be"],
    }])

    study = study_document(TEXT + " SRU is defined here.", client)

    assert isinstance(study, DocumentStudy)
    assert [g["term"] for g in study.glossary] == ["SRU"]
    assert study.placeholder_tokens == ["N", "TBD"]
    assert study.verification_statements == ["Report rate shall be N Hz."]
    assert study.standards_cited == ["MIL-STD-704"]
    assert study.table_roles == [{"table": "t1", "role": "configuration values"}]
    assert study.lead_in_patterns == ["Latency shall be"]


def test_malformed_entries_are_dropped_not_trusted() -> None:
    client = _StubClient([{
        "glossary": ["x", {"term": 3, "definition": "d"}, {"term": "N", "definition": ""}],
        "placeholder_tokens": [1, None, "", "N"],
        "verification_statements": [5, ""],
        "standards_cited": [None],
        "table_roles": [{"table": "t1"}],
        "lead_in_patterns": [],
    }])

    study = study_document(TEXT, client)

    assert study is not None
    assert study.glossary == []
    assert study.placeholder_tokens == ["N"]
    assert study.verification_statements == []
    assert study.standards_cited == []
    assert study.table_roles == []


def test_windows_merge_without_duplicates_and_failures_are_skipped() -> None:
    text = ("word " * 7000) + "TBD " + ("word " * 7000)  # 4 windows of 20k; "TBD" sits in the second one only
    client = _StubClient([{"placeholder_tokens": ["word"]}, {"placeholder_tokens": ["word", "TBD"]}, RuntimeError("model down")])

    study = study_document(text, client)

    assert study is not None
    assert study.placeholder_tokens == ["word", "TBD"]
    assert study.windows_total == len(client.windows) >= 3
    assert study.windows_studied == study.windows_total - 1  # exactly the one failing window is skipped


def test_every_window_failing_returns_none() -> None:
    assert study_document(TEXT, _StubClient([RuntimeError("down")])) is None


def test_blank_document_is_not_studied() -> None:
    client = _StubClient([])
    assert study_document("   \n", client) is None
    assert client.windows == []


def test_window_count_is_capped(monkeypatch) -> None:
    monkeypatch.setattr(settings, "survey_study_max_windows", 30)
    text = "word " * 400_000
    client = _StubClient([])

    study = study_document(text, client)

    assert study is not None
    assert len(client.windows) == 30
    assert study.windows_studied == 30
    assert study.windows_total > 30


def test_a_marker_must_stand_alone_in_the_window_exactly_as_returned() -> None:
    text = "Force of 50 N applies. Redundancy N+1 holds. Column Y/N. Value is TBD here. Inside CNC words."
    client = _StubClient([{"placeholder_tokens": ["N", "tbd", "TBD", "CNC", "N+1", "Y/N"]}])

    study = study_document(text, client)

    assert study is not None
    assert study.placeholder_tokens == ["TBD", "CNC", "N+1", "Y/N"]  # "N" only appears as a unit / joined; "tbd" differs in case


def test_contains_token_ignores_units_joined_forms_and_longer_words() -> None:
    from app.leveling.document_study import contains_token

    assert not contains_token("shall withstand 50 N of force", "N")
    assert not contains_token("an N+1 design", "N")
    assert not contains_token("a Y/N column", "N")
    assert not contains_token("CNC machine", "N")
    assert contains_token("latency shall be N ms", "N")
    assert contains_token("rate: ?? Hz", "??")


def test_unresolved_markers_after_a_number_or_beside_punctuation_are_still_recognised() -> None:
    from app.leveling.document_study import contains_token

    assert contains_token("respond within 5 TBD seconds", "TBD")
    assert contains_token("Req 3 TBD", "TBD")
    assert contains_token("up to 10?? units", "??")
    assert contains_token("the rate is N.", "N")  # sentence-final period
    assert not contains_token("an X-ray unit", "X")
    assert not contains_token("class N-1 design", "N")
    assert not contains_token("where N=5", "N")
    assert not contains_token("version 1.N build", "N")
    assert not contains_token("value ???", "??")
    assert not contains_token("what??", "??")


def _wf(**kw) -> WindowFindings:
    return WindowFindings(**{k: tuple(v) for k, v in kw.items()})


def test_merge_is_identical_for_shuffled_completion_order() -> None:
    windows = [
        (0, _wf(glossary=[("SRU", "unit")], placeholder_tokens=["TBD"], standards_cited=["MIL-STD-704"], table_roles=[("t1", "values")])),
        (1, _wf(glossary=[("LRU", "line unit")], placeholder_tokens=["XXxx", "TBD"], verification_statements=["Verified by test."])),
        (2, _wf(glossary=[("sru", "other")], placeholder_tokens=["XXXX"], lead_in_patterns=["shall be"], standards_cited=["mil-std-704"])),
        (3, _wf(placeholder_tokens=["??"], table_roles=[("t2", "limits")], lead_in_patterns=["SHALL  be"])),
    ]
    expected = merge_findings(windows)

    assert expected.windows_studied == 4
    for order in itertools.permutations(windows):
        assert merge_findings(order) == expected
    assert [g["term"] for g in expected.glossary] == ["SRU", "LRU"]
    assert expected.placeholder_tokens == ["TBD", "XXxx", "XXXX", "??"]


def test_merge_keeps_first_verbatim_spelling_and_dedups_by_normalised_form() -> None:
    hebrew = "\ufb2a\u05d1\u05d3\u05d9\u05e7\u05d4"  # a Hebrew presentation form: NFKC would rewrite it
    merged = merge_findings([
        (1, _wf(standards_cited=["vita  65", "\uff36ITA 66"], glossary=[("\u05d1\u05d3\u05d9\u05e7\u05d4", "x")])),
        (0, _wf(standards_cited=["VITA 65"], verification_statements=[hebrew])),
        (2, _wf(verification_statements=[hebrew], standards_cited=["VITA 66"])),
    ])

    assert merged.standards_cited == ["VITA 65", "\uff36ITA 66"]  # window 0's spelling wins; full-width V is equal to "V" under NFKC
    assert merged.verification_statements == [hebrew]  # stored untouched, not NFKC-rewritten
    assert merged.verification_statements[0] != __import__("unicodedata").normalize("NFKC", hebrew)


def test_placeholder_tokens_dedup_is_case_sensitive() -> None:
    merged = merge_findings([(0, _wf(placeholder_tokens=["XXxx", "XXXX", "XXxx"])), (1, _wf(placeholder_tokens=["XXXX", "xxxx"]))])

    assert merged.placeholder_tokens == ["XXxx", "XXXX", "xxxx"]


def test_marker_named_redacted_or_table_is_rejected() -> None:
    text = "Value <redacted> and <REDACTED> and [TABLE t3] and TBD."
    found = window_findings(
        {"placeholder_tokens": ["<redacted>", "<REDACTED>", "<Redacted>", "[TABLE t3]", "[TABLE", "TBD"]}, text,
    )

    assert found.placeholder_tokens == ("TBD",)


def test_hebrew_and_redacted_text_still_matches_quotes() -> None:
    text = "\u05d4\u05d1\u05d3\u05d9\u05e7\u05d4 \u05ea\u05ea\u05d1\u05e6\u05e2 \u05d1\u05de\u05e2\u05d1\u05d3\u05d4 <redacted> \u05d0\u05d5 <redacted>. Rate is TBD."
    client = _StubClient([{
        "verification_statements": ["\u05d4\u05d1\u05d3\u05d9\u05e7\u05d4 \u05ea\u05ea\u05d1\u05e6\u05e2  \u05d1\u05de\u05e2\u05d1\u05d3\u05d4", "\u05de\u05e9\u05e4\u05d8 \u05de\u05d1\u05d5\u05d3\u05d4"],
        "placeholder_tokens": ["<redacted>", "TBD"],
    }])

    study = study_document(text, client)

    assert study is not None
    assert study.verification_statements == ["\u05d4\u05d1\u05d3\u05d9\u05e7\u05d4 \u05ea\u05ea\u05d1\u05e6\u05e2  \u05d1\u05de\u05e2\u05d1\u05d3\u05d4"]
    assert study.placeholder_tokens == ["TBD"]


def test_windows_fixed_at_20k_independent_of_model() -> None:
    text = "word " * 30_000
    first, second = _StubClient([]), _StubClient([])
    first.model, second.model = "model-a", "model-b"

    study_document(text, first)
    study_document(text, second)

    assert STUDY_WINDOW_CHARS == 20_000
    assert first.windows == second.windows == windows_of(text, 20_000, STUDY_WINDOW_OVERLAP)
    assert STUDY_WINDOW_OVERLAP == 500


def test_window_cap_comes_from_settings(monkeypatch) -> None:
    text = "word " * 30_000
    client = _StubClient([])
    monkeypatch.setattr(settings, "survey_study_max_windows", 2)

    study = study_document(text, client)

    assert study is not None
    assert len(client.windows) == study.windows_studied == 2
    assert study.windows_total > 2
    assert type(settings).model_fields["survey_study_max_windows"].default == 300


def test_study_document_result_is_the_merge_of_per_window_findings() -> None:
    text = ("word " * 7000) + "TBD " + ("word " * 7000)
    answers = [{"placeholder_tokens": ["word"]}, {"placeholder_tokens": ["TBD", "word"]}, {"standards_cited": ["word"]}, {}]
    client = _StubClient(answers)

    study = study_document(text, client)

    windows = windows_of(text, STUDY_WINDOW_CHARS, STUDY_WINDOW_OVERLAP)
    expected = merge_findings((i, window_findings(a, w)) for i, (a, w) in enumerate(zip(answers, windows)))
    expected.windows_total = len(windows)
    assert study == expected


def test_window_findings_are_immutable() -> None:
    found = window_findings({"placeholder_tokens": ["TBD"]}, "TBD")

    assert isinstance(found.placeholder_tokens, tuple)
    with pytest.raises(AttributeError):
        found.placeholder_tokens = ()  # type: ignore[misc]


# --- self-healing per window ---


def _status_error(status: int, headers: dict | None = None) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "http://upstream.invalid/chat")
    return httpx.HTTPStatusError(f"{status}", request=request, response=httpx.Response(status, headers=headers, request=request))


class _TopRng:
    """uniform() answers its upper bound, so a test can assert the bound itself."""

    def uniform(self, a: float, b: float) -> float:
        return b


class _Sleeps:
    def __init__(self) -> None:
        self.delays: list[float] = []

    def __call__(self, seconds: float) -> None:
        self.delays.append(seconds)


class _FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


class _TickingClient(_StubClient):
    """Every call takes `step` seconds on the fake clock."""

    def __init__(self, clock: _FakeClock, step: float, answers: list | None = None) -> None:
        super().__init__(answers or [])
        self._clock, self._step = clock, step

    def study_document_window(self, window_text: str, user_id: str | None = None) -> dict:
        self._clock.now += self._step
        return super().study_document_window(window_text, user_id=user_id)


FOUR_WINDOWS = ("word " * 7000) + "TBD " + ("word " * 7000)
HALVES_TEXT = "Latency shall be TBD ms.\nPower per MIL-STD-704 applies."


def test_429_backs_off_with_jitter_then_succeeds() -> None:
    client = _StubClient([_status_error(429), _status_error(429), {"placeholder_tokens": ["TBD"]}])
    sleeps = _Sleeps()

    read = read_window(client, HALVES_TEXT, sleep=sleeps, rng=_TopRng())

    assert sleeps.delays == [2, 4]  # full jitter: uniform(0, min(60, 2 * 2**attempt)), here at the upper bound
    assert client.windows == [HALVES_TEXT] * 3
    assert read.findings is not None and read.findings.placeholder_tokens == ("TBD",)
    assert (read.retries, read.split, read.failed) == (2, False, False)


def test_429_retry_after_header_is_honoured_and_capped() -> None:
    client = _StubClient([_status_error(429, {"Retry-After": "7"}), _status_error(429, {"Retry-After": "900"}), {}])
    sleeps = _Sleeps()

    read = read_window(client, HALVES_TEXT, sleep=sleeps, rng=_TopRng())

    assert sleeps.delays == [7 + 1, 120 + 1]  # the header plus a small jitter; capped at 120 s
    assert not read.failed

    # an HTTP-date (or garbage) is ignored: back to the jittered backoff
    client = _StubClient([_status_error(429, {"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}), {}])
    sleeps = _Sleeps()
    read_window(client, HALVES_TEXT, sleep=sleeps, rng=_TopRng())
    assert sleeps.delays == [2]


def test_429_gives_up_after_two_backoffs_and_counts_failed() -> None:
    client = _StubClient([_status_error(429)] * 5)
    sleeps = _Sleeps()

    read = read_window(client, HALVES_TEXT, sleep=sleeps, rng=_TopRng())

    assert len(client.windows) == 3 and len(sleeps.delays) == 2  # no third backoff, and no split for a 429
    assert read.findings is None
    assert (read.retries, read.split, read.failed) == (2, False, True)


def test_cutoff_splits_once_and_merges_halves_in_order() -> None:
    client = _StubClient([
        _status_error(504), {"placeholder_tokens": ["TBD"]}, {"standards_cited": ["MIL-STD-704"], "placeholder_tokens": ["TBD"]},
    ])

    read = read_window(client, HALVES_TEXT, sleep=_Sleeps(), rng=_TopRng())

    first, second = split_window(HALVES_TEXT)
    assert client.windows == [HALVES_TEXT, first, second]
    assert read.findings == WindowFindings(placeholder_tokens=("TBD",), standards_cited=("MIL-STD-704",))
    assert (read.split, read.failed) == (True, False)


@pytest.mark.parametrize("error", [ValueError("empty completion"), httpx.ReadTimeout("cut"), _status_error(400)])
def test_empty_or_malformed_completion_splits(error: Exception) -> None:
    client = _StubClient([error, {}, {}])

    read = read_window(client, HALVES_TEXT, sleep=_Sleeps(), rng=_TopRng())

    assert len(client.windows) == 3
    assert (read.split, read.failed) == (True, False)


def test_half_failure_is_not_retried_again_and_window_is_not_counted_studied() -> None:
    client = _StubClient([_status_error(504), {"placeholder_tokens": ["TBD"]}, _status_error(502), {}, {}])

    study = study_document(HALVES_TEXT, client, sleep=_Sleeps(), rng=_TopRng())

    assert len(client.windows) == 3  # whole, first half, second half: the failed half is not split or retried again
    assert study is not None and study.placeholder_tokens == ["TBD"]  # the good half's findings are kept
    assert (study.windows_studied, study.windows_total) == (0, 1)  # so the caller's "partly read" warning still fires
    assert study.read_stats == StudyReadStats(windows_retried=0, windows_split=1, windows_failed=1)


def test_half_gets_one_429_retry_only() -> None:
    client = _StubClient([_status_error(504), _status_error(429), {}, _status_error(429), _status_error(429)])
    sleeps = _Sleeps()

    read = read_window(client, HALVES_TEXT, sleep=sleeps, rng=_TopRng())

    assert len(sleeps.delays) == 2 and len(client.windows) == 5  # one retry per half, no more
    assert read.failed and read.findings is not None and read.retries == 2


def test_split_window_is_deterministic_whitespace_aligned_and_lossless() -> None:
    hebrew = "שלום עולם זה טקסט בדיקה ארוך מספיק כדי לפצל אותו באמצע המשפט הזה"
    for text in (hebrew, "alpha beta gamma delta epsilon zeta", "one two three four five six seven eight nine ten", "a\tb\u00a0c d"):
        first, second = split_window(text)
        assert split_window(text) == (first, second)
        separator = text[len(first)]
        assert separator.isspace()
        assert first + separator + second == text
        assert abs(len(first) - len(text) // 2) <= len(text) // 2

    # a newline close to the middle is preferred to a nearer space
    assert split_window("aaaa bbbb\ncccc dddd") == ("aaaa bbbb", "cccc dddd")
    assert split_window("aaaa bbbbbbbbbb cccc dddd")[0] == "aaaa bbbbbbbbbb"
    # a long text with no whitespace is cut at the middle, losing nothing
    solid = "x" * 101
    first, second = split_window(solid)
    assert (first, second) == ("x" * 50, "x" * 51) and first + second == solid


def test_combine_window_findings_keeps_part_order() -> None:
    a = WindowFindings(placeholder_tokens=("A",), glossary=(("t", "d"),))
    b = WindowFindings(placeholder_tokens=("B",), table_roles=(("t1", "r"),))

    assert combine_window_findings([a, b]) == WindowFindings(
        placeholder_tokens=("A", "B"), glossary=(("t", "d"),), table_roles=(("t1", "r"),),
    )
    assert combine_window_findings([]) == WindowFindings()


def test_terminal_error_skips_window_without_retry() -> None:
    client = _StubClient([_status_error(401)])
    sleeps = _Sleeps()

    read = read_window(client, HALVES_TEXT, sleep=sleeps, rng=_TopRng())

    assert len(client.windows) == 1 and sleeps.delays == []
    assert (read.findings, read.retries, read.split, read.failed) == (None, 0, False, True)


def test_job_cancelled_propagates_and_is_not_retried() -> None:
    client = _StubClient([JobCancelled("gone"), {}])
    with pytest.raises(JobCancelled):
        study_document(FOUR_WINDOWS, client, sleep=_Sleeps(), rng=_TopRng())
    assert len(client.windows) == 1

    # also from inside a half read
    client = _StubClient([_status_error(504), JobCancelled("gone"), {}])
    with pytest.raises(JobCancelled):
        read_window(client, HALVES_TEXT, sleep=_Sleeps(), rng=_TopRng())
    assert len(client.windows) == 2


def test_breaker_opens_after_n_consecutive_failures_and_study_is_partial(monkeypatch) -> None:
    monkeypatch.setattr(settings, "survey_study_breaker_failures", 2)
    client = _StubClient([{}, _status_error(401), _status_error(401), {}, {}])

    study = study_document(FOUR_WINDOWS, client, sleep=_Sleeps(), rng=_TopRng())

    assert len(client.windows) == 3  # the 4th window is never read
    assert study is not None
    assert (study.windows_studied, study.windows_total) == (1, 4)
    assert study.read_stats.breaker_opened and study.read_stats.windows_failed == 2


def test_a_fully_studied_window_resets_the_breaker_count(monkeypatch) -> None:
    monkeypatch.setattr(settings, "survey_study_breaker_failures", 2)
    client = _StubClient([_status_error(401), {}, _status_error(401), {}])

    study = study_document(FOUR_WINDOWS, client, sleep=_Sleeps(), rng=_TopRng())

    assert len(client.windows) == 4
    assert study is not None and (study.windows_studied, study.windows_total) == (2, 4)
    assert not study.read_stats.breaker_opened


def test_hard_budget_keeps_what_was_read(monkeypatch) -> None:
    monkeypatch.setattr(settings, "survey_study_hard_budget_seconds", 100)
    clock = _FakeClock()
    client = _TickingClient(clock, 60, [{"placeholder_tokens": ["word"]}, {"placeholder_tokens": ["TBD"]}])

    study = study_document(FOUR_WINDOWS, client, clock=clock, sleep=_Sleeps(), rng=_TopRng())

    assert len(client.windows) == 2  # checked before each window: 0 s, 60 s read; at 120 s it stops
    assert study is not None and study.placeholder_tokens == ["word", "TBD"]
    assert (study.windows_studied, study.windows_total) == (2, 4)
    assert study.read_stats.budget_stopped


def test_soft_budget_warns_once_and_continues(monkeypatch, caplog) -> None:
    monkeypatch.setattr(settings, "survey_study_soft_budget_seconds", 50)
    clock = _FakeClock()
    client = _TickingClient(clock, 60)

    with caplog.at_level(logging.WARNING, logger="app.leveling.document_study"):
        study = study_document(FOUR_WINDOWS, client, clock=clock, sleep=_Sleeps(), rng=_TopRng())

    assert len(client.windows) == 4 and study is not None and study.windows_studied == 4
    assert len([r for r in caplog.records if "still reading" in r.getMessage()]) == 1
    assert not study.read_stats.budget_stopped


def test_split_is_counted_once_in_stats() -> None:
    client = _StubClient([_status_error(504), {}, {}])

    study = study_document(HALVES_TEXT, client, sleep=_Sleeps(), rng=_TopRng())

    assert study is not None
    assert study.read_stats == StudyReadStats(windows_split=1)  # two halves, one split; both read, so nothing failed
    assert study.windows_studied == 1


def test_study_with_every_window_failing_still_returns_none() -> None:
    client = _StubClient([RuntimeError("down")] * 10)
    assert study_document(FOUR_WINDOWS, client, sleep=_Sleeps(), rng=_TopRng()) is None
    assert len(client.windows) == 4  # fewer failures than the breaker's limit, so every window is tried


def test_study_settings_defaults() -> None:
    fields = type(settings).model_fields
    assert fields["survey_study_breaker_failures"].default == 5
    assert fields["survey_study_soft_budget_seconds"].default == 1800
    assert fields["survey_study_hard_budget_seconds"].default == 2700


# malformed answers, cancel-aware sleep and blank halves (fix pass T4b) ----

@pytest.mark.parametrize("answer", [{}, {"glossary": []}, {**_EMPTY_ANSWER, "table_roles": None}, {**_EMPTY_ANSWER, "standards_cited": "x"}, []])
def test_a_degenerate_answer_is_malformed_and_reads_the_window_as_halves(answer) -> None:
    client = _StubClient([answer, answer, answer], raw=True)

    read = read_window(client, HALVES_TEXT, sleep=_Sleeps(), rng=_TopRng())

    assert len(client.windows) == 3  # whole, then each half
    assert read.findings is None and (read.split, read.failed) == (True, True)


def test_a_degenerate_whole_answer_is_healed_by_well_formed_halves() -> None:
    client = _StubClient([{}, {**_EMPTY_ANSWER, "placeholder_tokens": ["TBD"]}, _EMPTY_ANSWER], raw=True)

    read = read_window(client, HALVES_TEXT, sleep=_Sleeps(), rng=_TopRng())

    assert read.findings == WindowFindings(placeholder_tokens=("TBD",)) and (read.split, read.failed) == (True, False)


def test_an_answer_with_all_six_keys_empty_is_a_legitimately_empty_window() -> None:
    client = _StubClient([_EMPTY_ANSWER])

    study = study_document("Table of contents\n1 Scope 3\n2 Purpose 4", client, sleep=_Sleeps(), rng=_TopRng())

    assert len(client.windows) == 1
    assert study is not None and (study.windows_studied, study.windows_total) == (1, 1)
    assert study.read_stats == StudyReadStats()


def test_cancellable_sleep_stops_promptly_when_cancelled(monkeypatch) -> None:
    from app.job_cancel import cancellation_scope
    from app.leveling import document_study as module

    slept: list[float] = []
    monkeypatch.setattr(module.time, "sleep", slept.append)

    with cancellation_scope() as token:
        token.cancel()
        with pytest.raises(JobCancelled):
            module._cancellable_sleep(30)

    assert len(slept) <= 1


def test_cancellable_sleep_sleeps_in_slices_of_at_most_a_second(monkeypatch) -> None:
    from app.leveling import document_study as module

    slept: list[float] = []
    monkeypatch.setattr(module.time, "sleep", slept.append)

    module._cancellable_sleep(2.5)

    assert slept == [1, 1, 0.5]


def test_cancellable_sleep_is_the_default_of_read_window_and_study_document() -> None:
    import inspect

    from app.leveling import document_study as module

    assert inspect.signature(read_window).parameters["sleep"].default is module._cancellable_sleep
    assert inspect.signature(study_document).parameters["sleep"].default is module._cancellable_sleep


def test_a_blank_half_is_not_sent_and_does_not_fail_the_window() -> None:
    text = " " * 8 + "ab"  # cut at the middle space: the first half is whitespace only
    client = _StubClient([ValueError("cut off"), _EMPTY_ANSWER])

    read = read_window(client, text, sleep=_Sleeps(), rng=_TopRng())

    assert len(client.windows) == 2 and all(w.strip() for w in client.windows[1:])
    assert read.findings == WindowFindings() and (read.split, read.failed) == (True, False)


def test_a_one_character_window_with_an_empty_half_is_read_once_more_and_not_failed() -> None:
    client = _StubClient([ValueError("cut off"), _EMPTY_ANSWER])

    read = read_window(client, "a", sleep=_Sleeps(), rng=_TopRng())

    assert client.windows == ["a", "a"]  # the empty half is skipped, the other half is the whole character
    assert read.findings == WindowFindings() and (read.split, read.failed) == (True, False)


def test_failed_window_logs_never_carry_the_error_text(caplog) -> None:
    """A malformed-answer error carries the model's output, which can quote the document: the logs may say the exception type or the HTTP
    status, never the message."""
    import logging

    import httpx

    caplog.set_level(logging.WARNING)
    secret = "A DISTINCTIVE SENTENCE FROM THE DOCUMENT"
    request = httpx.Request("POST", "http://orchestrator.internal/llm/chat")

    class _Failing:
        def study_document_window(self, window_text, user_id=None):
            raise ValueError(f"malformed JSON in LLM response content: {secret}")

    class _Failing502:
        def study_document_window(self, window_text, user_id=None):
            raise httpx.HTTPStatusError(f"bad gateway: {secret}", request=request, response=httpx.Response(502, request=request))

    class _Odd:
        def study_document_window(self, window_text, user_id=None):
            raise RuntimeError(secret)

    for client in (_Failing(), _Failing502(), _Odd()):
        read_window(client, "some window text here", sleep=lambda _s: None)

    assert secret not in caplog.text
    assert "ValueError" in caplog.text and "HTTP 502" in caplog.text and "RuntimeError" in caplog.text
