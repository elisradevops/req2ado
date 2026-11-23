"""The Study (app.leveling.study) and its /study route: one reading of the document, its grounded facts, orientation and table vocabulary."""

from __future__ import annotations

import threading
import time
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app import job_cancel
from app.canonical.model import (
    Block,
    BlockKind,
    CanonicalDoc,
    Document,
    DocumentFormat,
    SourceRef,
    Table,
    TableCell,
)
from app.leveling import study as study_module
from app.leveling.study import (
    VOCABULARY_VALUES,
    StudyResultCache,
    StudyTimings,
    build_study,
    study_budget,
    study_text,
    table_vocabulary,
)
from app.leveling.study_store import StudyStore
from app.main import app
from app.study.file_rules import study_tables

USER = "user-1"
TEST_CASE_LINE = "Verified by test procedure TP-12 at ambient temperature"


class _FakeRedis:
    """get/set(nx, ex)/delete for the window store and the result cache; lpush/ltrim/lrange/expire for the timings."""

    def __init__(self) -> None:
        self.data: dict[str, object] = {}
        self.lock = threading.Lock()

    def get(self, key):  # noqa: ANN001, ANN201
        return self.data.get(key)

    def set(self, key, value, ex=None, nx=False):  # noqa: ANN001, ANN201
        with self.lock:
            if nx and key in self.data:
                return False
            self.data[key] = value
            return True

    def delete(self, *keys):  # noqa: ANN002, ANN201
        for key in keys:
            self.data.pop(key, None)

    def lpush(self, key, *values):  # noqa: ANN001, ANN002, ANN201
        self.data[key] = [*reversed(values), *self.data.get(key, [])]

    def ltrim(self, key, start, end):  # noqa: ANN001, ANN201
        self.data[key] = self.data.get(key, [])[start : end + 1]

    def lrange(self, key, start, end):  # noqa: ANN001, ANN201
        return self.data.get(key, [])[start : end + 1]

    def expire(self, key, seconds):  # noqa: ANN001, ANN201
        return True


class _FakeClient:
    """Answers every window with what it contains and one fact it does not; the orientation with four fixed fields."""

    def __init__(self, orient_fails: bool = False, window_seconds: float = 0.0) -> None:
        self.windows: list[str] = []
        self.orientations = 0
        self.orient_fails = orient_fails
        self.window_seconds = window_seconds
        self.lock = threading.Lock()

    def study_document_window(self, window_text: str, user_id: str | None = None) -> dict:
        job_cancel.raise_if_cancelled()
        with self.lock:
            self.windows.append(window_text)
        if self.window_seconds:
            time.sleep(self.window_seconds)
        verification = [TEST_CASE_LINE] if TEST_CASE_LINE in window_text else []
        return {
            "glossary": [{"term": "BIT", "definition": "Built-in test"}] if "BIT" in window_text else [],
            "placeholder_tokens": ["TBD"] if "TBD" in window_text else [],
            "verification_statements": [*verification, "Measured in a thermal chamber at 85 C"],  # the second is invented
            "standards_cited": ["MIL-STD-461G"] if "MIL-STD-461G" in window_text else [],
            "table_roles": [{"table": "t0", "role": "the radio's work items"}],
        }

    def orient_document(self, outline: str, first_window: str, user_id: str | None = None) -> dict:
        job_cancel.raise_if_cancelled()
        self.orientations += 1
        if self.orient_fails:
            raise RuntimeError("the model did not answer")
        return {
            "document_type": "A system requirements specification",
            "purpose": "States what the radio must do",
            "system": "The radio",
            "conventions": "One row per item with a type column  ",
        }


def _ref(offset: int) -> SourceRef:
    return SourceRef(document_path="radio.docx", start_offset=offset, end_offset=offset + 1)


def _table() -> Table:
    rows = [
        ["Type", "Title", "Description", "Priority", "Verification"],
        ["Epic", "Radio", "The radio unit", "High", "Test"],
        ["Feature", "Power", "Power handling", "High", "Analysis"],
        ["Requirement", "Input voltage", "The radio shall accept 28 V", "high", "Test"],
        ["Requirement", "Boot time", "The radio shall boot within TBD s", "Low", "Inspection"],
        ["Requirement", "BIT", "BIT: Built-in test, run at power-up", "Medium", "Test"],
        ["Test Case", "TC-1", TEST_CASE_LINE, "", ""],
    ]
    return Table(id="t0", caption="Radio items", cells=[[TableCell(text=c) for c in r] for r in rows], source_ref=_ref(5))


def _doc(paragraphs: int = 0) -> CanonicalDoc:
    blocks = [
        Block(id="h1", kind=BlockKind.HEADING, text="1 Scope", heading_level=1, source_ref=_ref(0)),
        Block(id="p1", kind=BlockKind.PARAGRAPH, text="The radio complies with MIL-STD-461G.", source_ref=_ref(1)),
    ]
    filler = "The radio shall report its status to the operator station every second. " * 40
    blocks += [
        Block(id=f"f{i}", kind=BlockKind.PARAGRAPH, text=f"{i} {filler}", source_ref=_ref(10 + i)) for i in range(paragraphs)
    ]
    return CanonicalDoc(
        document=Document(path="radio.docx", format=DocumentFormat.DOCX, sha256="h"),
        blocks=blocks,
        tables=[_table()],
    )


def _build(doc: CanonicalDoc, client: _FakeClient, redis: _FakeRedis | None = None, user_id: str | None = USER, **kwargs):  # noqa: ANN201
    redis = redis if redis is not None else _FakeRedis()
    stores = {
        "store": StudyStore(redis, 3600),
        "timings": StudyTimings(redis, 20, 3600),
        "cache": StudyResultCache(redis, 3600),
        "poll_seconds": 0.01,
    }
    return build_study(doc, client, user_id, "model-a", **{**stores, **kwargs})


# --- the text that is read -----------------------------------------------------------------------------------------------------


def test_a_stated_table_is_read_one_row_per_line_including_the_rows_not_imported() -> None:
    doc = _doc()
    text = study_text(doc, study_tables(doc))
    assert "[TABLE t0]" in text
    assert "Requirement · Input voltage · The radio shall accept 28 V" in text
    assert "Rows not imported:" in text and f"Test Case · TC-1 · {TEST_CASE_LINE}" in text
    assert "| Type |" not in text  # not the markdown grid
    assert text.index("1 Scope") < text.index("[TABLE t0]")  # document order



def test_every_window_of_a_long_table_holds_its_marker() -> None:
    from app.kb.profile import windows_of
    from app.leveling.document_study import STUDY_WINDOW_CHARS, STUDY_WINDOW_OVERLAP

    rows = [["Type", "Title", "Description"], ["Epic", "Root", "The unit"], ["Feature", "Group", "A group"]]
    rows += [["Requirement", f"Item {i}", f"The unit shall do thing number {i} within the stated time. " * 3] for i in range(800)]
    table = Table(id="t9", caption="Long", cells=[[TableCell(text=c) for c in r] for r in rows], source_ref=_ref(0))
    doc = CanonicalDoc(document=Document(path="x.xlsx", format=DocumentFormat.XLSX, sha256="h"), tables=[table])
    windows = windows_of(study_text(doc, study_tables(doc)), STUDY_WINDOW_CHARS, STUDY_WINDOW_OVERLAP)
    assert len(windows) > 3
    assert all("[TABLE t9] Long columns: Type, Title, Description" in window for window in windows)

def test_a_verification_statement_from_a_row_not_imported_is_kept() -> None:
    study = _build(_doc(), _FakeClient())
    assert TEST_CASE_LINE in study.verification_statements


def test_a_fact_the_window_does_not_contain_is_dropped() -> None:
    study = _build(_doc(), _FakeClient())
    assert all("thermal chamber" not in s for s in study.verification_statements)
    assert study.standards_cited == ["MIL-STD-461G"]
    assert [(g.term, g.definition) for g in study.glossary] == [("BIT", "Built-in test")]
    assert study.placeholder_tokens == ["TBD"]
    assert [(r.table, r.role) for r in study.table_roles] == [("t0", "the radio's work items")]


# --- vocabulary ----------------------------------------------------------------------------------------------------------------


def test_the_vocabulary_is_each_columns_distinct_values_over_the_imported_rows() -> None:
    doc = _doc()
    vocabulary = {(v.table, v.column): v for v in table_vocabulary(doc.tables[0], study_tables(doc)["t0"])}
    assert set(vocabulary) == {("Radio items", "Type"), ("Radio items", "Priority"), ("Radio items", "Verification")}
    assert vocabulary[("Radio items", "Priority")].values == ["High", "Low", "Medium"]  # "high" is "High" again; first spelling kept
    assert vocabulary[("Radio items", "Verification")].values == ["Test", "Analysis", "Inspection"]  # first-seen order; no Test Case row
    assert vocabulary[("Radio items", "Type")].values == ["Epic", "Feature", "Requirement"]


def test_the_vocabulary_is_capped_and_says_how_many_were_left_out() -> None:
    rows = [["Type", "Title", "Code"], ["Epic", "Root", "c-root"]]
    rows += [["Requirement", f"Item {i}", f"c{i}"] for i in range(VOCABULARY_VALUES + 7)]
    rows.insert(2, ["Feature", "Group", "c-group"])
    table = Table(id="t1", cells=[[TableCell(text=c) for c in r] for r in rows], source_ref=_ref(0))
    doc = CanonicalDoc(document=Document(path="x.xlsx", format=DocumentFormat.XLSX, sha256="h"), tables=[table])
    (code,) = [v for v in table_vocabulary(table, study_tables(doc)["t1"]) if v.column == "Code"]
    assert len(code.values) == VOCABULARY_VALUES and code.more == VOCABULARY_VALUES + 9 - VOCABULARY_VALUES
    assert code.values[:3] == ["c-root", "c-group", "c0"]


# --- orientation ---------------------------------------------------------------------------------------------------------------


def test_the_orientation_is_written_once_and_clipped() -> None:
    client = _FakeClient()
    study = _build(_doc(), client)
    assert client.orientations == 1
    assert study.orientation.system == "The radio"
    assert study.orientation.conventions == "One row per item with a type column"  # whitespace squashed


def test_a_failed_orientation_keeps_the_grounded_facts() -> None:
    redis = _FakeRedis()
    study = _build(_doc(), _FakeClient(orient_fails=True), redis)
    assert study.orientation.model_dump() == {"document_type": "", "purpose": "", "system": "", "conventions": ""}
    assert study.stats.orientation_failed
    assert TEST_CASE_LINE in study.verification_statements and study.standards_cited == ["MIL-STD-461G"]
    assert not any(k.startswith("studyresult:") for k in redis.data)  # an incomplete Study is not cached


# --- budget --------------------------------------------------------------------------------------------------------------------


def test_the_budget_is_rounds_of_the_median_window_plus_one_capped_at_the_ceiling() -> None:
    assert study_budget(10, 30.0, 4, 10_000) == (3 + 1) * 30.0
    assert study_budget(10, 30.0, 4, 100) == 100


def test_the_budget_stops_the_reading_early_with_partial_stats(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(study_module.settings, "study_default_seconds_per_window", 0.05)
    monkeypatch.setattr(study_module.settings, "survey_study_concurrency", 1)
    study = _build(_doc(paragraphs=40), _FakeClient(window_seconds=0.15))
    assert study.stats.windows_total > 3
    assert study.stats.stopped_by == "deadline" and study.stats.budget_stopped
    assert study.stats.windows_studied < study.stats.windows_total
    assert study.stats.budget_seconds == pytest.approx(0.05 * (study.stats.windows_total + 1))


def test_measured_window_times_set_the_next_budget() -> None:
    redis = _FakeRedis()
    _build(_doc(paragraphs=40), _FakeClient(window_seconds=0.01), redis, cache=None)
    assert len(redis.data["studytiming:model-a"]) >= 3
    timings = StudyTimings(redis, 20, 3600)
    assert timings.median("model-a") is not None and timings.median("model-b") is None


# --- cache and determinism -----------------------------------------------------------------------------------------------------


def test_a_cache_hit_makes_no_model_call() -> None:
    redis = _FakeRedis()
    first = _build(_doc(), _FakeClient(), redis)
    assert first.complete and not first.stats.from_cache
    again = _FakeClient()
    second = _build(_doc(), again, redis)
    assert again.windows == [] and again.orientations == 0
    assert second.stats.from_cache
    assert second.model_dump(exclude={"stats"}) == first.model_dump(exclude={"stats"})


def test_a_caller_without_a_user_id_shares_nothing() -> None:
    redis = _FakeRedis()
    _build(_doc(), _FakeClient(), redis, user_id=None)
    assert not any(k.startswith(("studyresult:", "study:")) for k in redis.data)


def test_the_same_document_gives_the_same_text_key_and_vocabulary() -> None:
    doc_a, doc_b = _doc(paragraphs=3), _doc(paragraphs=3)
    text_a, text_b = study_text(doc_a, study_tables(doc_a)), study_text(doc_b, study_tables(doc_b))
    assert text_a == text_b
    assert StudyResultCache.key("s", "m", text_a) == StudyResultCache.key("s", "m", text_b)
    assert _build(doc_a, _FakeClient()).vocabulary == _build(doc_b, _FakeClient()).vocabulary


def test_an_empty_document_is_an_empty_study_not_an_error() -> None:
    doc = CanonicalDoc(document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"))
    client = _FakeClient()
    study = _build(doc, client)
    assert study.stats.stopped_by == "empty" and client.windows == [] and client.orientations == 0


# --- /study --------------------------------------------------------------------------------------------------------------------


@pytest.fixture
def no_redis(monkeypatch):  # noqa: ANN001, ANN201
    from app import main

    monkeypatch.setattr(main, "_study_store", StudyStore(None, 3600))
    monkeypatch.setattr(main, "_study_limiter", None)
    monkeypatch.setattr(main, "_study_timings", StudyTimings(None, 20, 3600))
    monkeypatch.setattr(main, "_study_result_cache", StudyResultCache(None, 3600))


def test_the_route_returns_the_study_as_json(no_redis) -> None:  # noqa: ANN001
    async def fake(model, user_id):  # noqa: ANN001, ANN201
        return _FakeClient()

    with patch("app.main._survey_client", fake):
        response = TestClient(app).post(
            "/study", json={"doc": _doc().model_dump(mode="json"), "model": "model-a"}, headers={"X-Req2Ado-User-Id": USER}
        )
    assert response.status_code == 200
    body = response.json()
    assert body["orientation"]["system"] == "The radio"
    assert TEST_CASE_LINE in body["verification_statements"]
    assert body["stats"]["windows_studied"] == body["stats"]["windows_total"] == 1
    assert {v["column"] for v in body["vocabulary"]} == {"Type", "Priority", "Verification"}


def test_a_disconnected_caller_cancels_the_study(no_redis) -> None:  # noqa: ANN001
    client = _FakeClient(window_seconds=0.2)

    async def fake(model, user_id):  # noqa: ANN001, ANN201
        return client

    async def gone(self) -> bool:  # noqa: ANN001
        return True

    with patch("app.main._survey_client", fake), patch("starlette.requests.Request.is_disconnected", gone):
        response = TestClient(app).post("/study", json={"doc": _doc(paragraphs=40).model_dump(mode="json")})
    assert response.status_code == 499
    assert client.orientations == 0


def test_the_version_route_names_the_current_version() -> None:
    assert TestClient(app).get("/study/version").json() == {"version": study_module.study_result_version()}



def test_the_route_reports_each_window_as_the_jobs_study_stage(no_redis, monkeypatch) -> None:  # noqa: ANN001
    from app import main

    published: list = []

    class _Publisher:
        def __init__(self, redis, job_id):  # noqa: ANN001
            self.job_id = job_id

        def publish(self, progress) -> None:  # noqa: ANN001
            published.append((self.job_id, progress.phase, progress.blocks_done, progress.blocks_total))

    monkeypatch.setattr(main, "NarrationPublisher", _Publisher)

    async def fake(model, user_id):  # noqa: ANN001, ANN201
        return _FakeClient()

    with patch("app.main._survey_client", fake):
        response = TestClient(app).post(
            "/study", params={"job_id": "job-7"}, json={"doc": _doc(paragraphs=40).model_dump(mode="json")}, headers={"X-Req2Ado-User-Id": USER}
        )
    assert response.status_code == 200
    total = response.json()["stats"]["windows_total"]
    assert published[0] == ("job-7", "study_window", 0, total)
    assert published[-1] == ("job-7", "study_window", total, total)
    assert all(phase == "study_window" for _, phase, _, _ in published)


def test_the_route_reports_nothing_without_a_job(no_redis, monkeypatch) -> None:  # noqa: ANN001
    from app import main

    monkeypatch.setattr(main, "NarrationPublisher", lambda *a: (_ for _ in ()).throw(AssertionError("no job, no publisher")))

    async def fake(model, user_id):  # noqa: ANN001, ANN201
        return _FakeClient()

    with patch("app.main._survey_client", fake):
        response = TestClient(app).post("/study", json={"doc": _doc().model_dump(mode="json")}, headers={"X-Req2Ado-User-Id": USER})
    assert response.status_code == 200


def test_the_streamed_route_reports_windows_then_ends_with_the_study(no_redis, monkeypatch) -> None:  # noqa: ANN001
    import json as json_module

    from app import main

    monkeypatch.setattr(main, "STUDY_HEARTBEAT_SECONDS", 0.02)
    monkeypatch.setattr(study_module.settings, "survey_study_concurrency", 1)

    async def fake(model, user_id):  # noqa: ANN001, ANN201
        return _FakeClient(window_seconds=0.05)

    with patch("app.main._survey_client", fake):
        response = TestClient(app).post(
            "/study",
            json={"doc": _doc(paragraphs=40).model_dump(mode="json")},
            headers={"X-Req2Ado-User-Id": USER, "Accept": "application/x-ndjson"},
        )
    assert response.status_code == 200 and response.headers["content-type"].startswith("application/x-ndjson")
    lines = [json_module.loads(line) for line in response.text.splitlines()]
    heartbeats, last = lines[:-1], lines[-1]
    assert heartbeats and all(h["type"] == "heartbeat" for h in heartbeats)
    total = last["study"]["stats"]["windows_total"]
    assert {h["windowsTotal"] for h in heartbeats} <= {0, total}
    assert [h["windowsDone"] for h in heartbeats] == sorted(h["windowsDone"] for h in heartbeats)  # never goes back
    assert last["type"] == "result" and last["study"]["stats"]["windows_studied"] == total
