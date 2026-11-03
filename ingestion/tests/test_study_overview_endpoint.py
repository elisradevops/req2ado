from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app
from tests.identity import identity_headers

client = TestClient(app)
FIXTURE = Path(__file__).parent / "fixtures" / "mock_icd.docx"
_ANSWER = {
    "glossary": [], "placeholder_tokens": [], "verification_statements": ["verified per test procedure TP-114"], "standards_cited": [],
    "table_roles": [], "lead_in_patterns": [], "purpose_statements": [],
}


class _FakeStudyClient:
    def __init__(self, answer: dict | Exception) -> None:
        self.answer = answer
        self.windows: list[str] = []

    def study_document_window(self, window_text: str, user_id: str | None = None) -> dict:
        self.windows.append(window_text)
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


def _post(fake: _FakeStudyClient, user_id: str | None = "u1", **params: object):
    async def _client_for(model, uid):
        return fake

    all_params = {"user_id": user_id, **params} if user_id else dict(params)
    with patch("app.main._survey_client", _client_for), patch("app.main._study_store", None), patch("app.main._study_limiter", None):
        with open(FIXTURE, "rb") as f:
            return client.post(
                "/study/overview", params=all_params, headers=identity_headers(all_params),
                files={"file": ("mock_icd.docx", f, "application/octet-stream")},
            )


def test_the_overview_facts_come_from_a_study_of_the_uploaded_document() -> None:
    fake = _FakeStudyClient({
        **_ANSWER,
        "purpose_statements": ["Output ripple on the 3.3V rail shall not exceed 50mV peak-to-peak, measured per test procedure TP-114a."],
    })
    response = _post(fake)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["read"] is True
    assert body["facts"]["purpose_statements"] == ["Output ripple on the 3.3V rail shall not exceed 50mV peak-to-peak, measured per test procedure TP-114a."]
    assert body["facts"]["verification_statements"] == 1
    assert fake.windows and "Power Distribution" in fake.windows[0]  # the study read the document's real text


def test_a_quote_the_document_does_not_contain_never_reaches_the_overview() -> None:
    response = _post(_FakeStudyClient({**_ANSWER, "purpose_statements": ["This document describes a nuclear submarine."]}))
    assert response.json()["facts"]["purpose_statements"] == []


def test_a_study_that_read_nothing_says_so_instead_of_inventing_an_overview() -> None:
    body = _post(_FakeStudyClient(RuntimeError("model down"))).json()
    assert body["read"] is False and body["facts"] is None and body["reason"] == "unread"


def test_a_call_without_a_user_does_not_read_the_document_at_all() -> None:
    fake = _FakeStudyClient(_ANSWER)
    body = _post(fake, user_id=None).json()
    assert body == {"read": False, "facts": None, "reason": "no_user", "warnings": []}
    assert fake.windows == []


# Streamed (Accept: application/x-ndjson): the wizard shows what the study is doing instead of a spinner that looks stuck. Progress lines are the
# study's own count of windows accounted for; a heartbeat says the model is still working; the stream ends with exactly one result (or error) line.
import json
import time

NDJSON = "application/x-ndjson"


def _post_stream(fake: _FakeStudyClient, **params: object):
    async def _client_for(model, uid):
        return fake

    all_params = {"user_id": "u1", **params}
    with patch("app.main._survey_client", _client_for), patch("app.main._study_store", None), patch("app.main._study_limiter", None):
        with open(FIXTURE, "rb") as f:
            response = client.post(
                "/study/overview", params=all_params, headers={**identity_headers(all_params), "Accept": NDJSON},
                files={"file": ("mock_icd.docx", f, "application/octet-stream")},
            )
    return response, [json.loads(line) for line in response.text.splitlines() if line.strip()]


def test_a_streamed_study_reports_progress_then_one_result_line() -> None:
    response, lines = _post_stream(_FakeStudyClient({**_ANSWER, "purpose_statements": []}))
    assert response.status_code == 200 and response.headers["content-type"].startswith(NDJSON)
    progress = [(l["done"], l["total"]) for l in lines if l["type"] == "progress"]
    assert progress[0] == (0, 1) and progress[-1] == (1, 1)
    *_, last = lines
    assert last["type"] == "result" and last["read"] is True and last["facts"]["verification_statements"] == 1
    assert [l["type"] for l in lines].count("result") == 1


def test_the_streamed_result_equals_the_plain_answer() -> None:
    fake = _FakeStudyClient(_ANSWER)
    plain = _post(fake).json()
    _, lines = _post_stream(_FakeStudyClient(_ANSWER))
    result = {k: v for k, v in lines[-1].items() if k != "type"}
    assert result == plain


def test_a_slow_model_is_met_with_heartbeats(monkeypatch) -> None:
    monkeypatch.setattr("app.main.STUDY_OVERVIEW_HEARTBEAT_SECONDS", 0.05)

    class _Slow(_FakeStudyClient):
        def study_document_window(self, window_text, user_id=None):
            time.sleep(0.4)
            return super().study_document_window(window_text, user_id)

    _, lines = _post_stream(_Slow(_ANSWER))
    assert any(l["type"] == "heartbeat" for l in lines)
    assert lines[-1]["type"] == "result"


def test_a_failure_after_the_stream_started_is_a_line_not_a_broken_response() -> None:
    _, lines = _post_stream(_FakeStudyClient(RuntimeError("model down")))
    assert lines[-1]["type"] == "result" and lines[-1]["read"] is False and lines[-1]["reason"] == "unread"
