from app.leveling.document_study import DocumentStudy, study_document


class _StubClient:
    def __init__(self, answers: list[dict | Exception]) -> None:
        self._answers = list(answers)
        self.windows: list[str] = []

    def study_document_window(self, window_text: str, user_id: str | None = None) -> dict:
        self.windows.append(window_text)
        answer = self._answers.pop(0) if self._answers else {}
        if isinstance(answer, Exception):
            raise answer
        return answer


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
        "verification_statements": "not a list",
        "standards_cited": None,
        "table_roles": [{"table": "t1"}],
    }])

    study = study_document(TEXT, client)

    assert study is not None
    assert study.glossary == []
    assert study.placeholder_tokens == ["N"]
    assert study.verification_statements == []
    assert study.standards_cited == []
    assert study.table_roles == []


def test_windows_merge_without_duplicates_and_failures_are_skipped() -> None:
    text = ("word " * 5000) + "TBD " + ("word " * 5000)
    client = _StubClient([{"placeholder_tokens": ["word"]}, RuntimeError("model down"), {"placeholder_tokens": ["word", "TBD"]}])

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


def test_window_count_is_capped() -> None:
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
