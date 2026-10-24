"""POST /level answers as a stream of lines when the caller asks for it (Accept: application/x-ndjson), and exactly as before otherwise."""
import json
import threading

from fastapi.testclient import TestClient

from app import main
from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.workitem.model import WorkItemTree

client = TestClient(main.app)
NDJSON = "application/x-ndjson"


def doc_json() -> str:
    ref = SourceRef(document_path="x.txt", start_offset=0, end_offset=10)
    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.PARAGRAPH, text="The receiver shall do a thing.", source_ref=ref)],
    )
    return doc.model_dump_json()


def patch_run(monkeypatch, build, wait: float = 0.0) -> None:
    def fake(doc, client_, user_id, catalog, job_id, model, primer_context, rubric_report):
        threading.Event().wait(wait)
        rubric_report.update({"version": "rubric-7", "degraded": False})
        return build()

    monkeypatch.setattr("app.main._build_survey_tree_with_scoring", fake)
    monkeypatch.setattr("app.main._resolve_caps", lambda *a, **k: type("Caps", (), {"context_budget_tokens": 8000})())


def post(accept: str | None = None):
    headers = {"Content-Type": "application/json", "X-Req2Ado-User-Id": "u1"}
    if accept:
        headers["Accept"] = accept
    return client.post("/level?mode=survey&model=m&job_id=j1", content=doc_json(), headers=headers)


def lines_of(response) -> list[dict]:
    return [json.loads(raw) for raw in response.text.splitlines() if raw.strip()]


def tree() -> WorkItemTree:
    return WorkItemTree(nodes=[], warnings=[])


def test_the_stream_ends_with_one_result_line_holding_the_same_tree_and_rubric_as_the_plain_answer(monkeypatch) -> None:
    patch_run(monkeypatch, tree)
    plain = post()
    streamed = post(NDJSON)
    assert streamed.status_code == 200 and streamed.headers["content-type"].startswith(NDJSON)
    lines = lines_of(streamed)
    assert [line["type"] for line in lines] == ["result"]
    assert lines[0]["tree"] == plain.json()
    assert lines[0]["rubric"] == {"version": plain.headers["x-req2ado-rubric-version"], "degraded": False} == {"version": "rubric-7", "degraded": False}


def test_a_slow_run_sends_heartbeats_first(monkeypatch) -> None:
    patch_run(monkeypatch, tree, wait=0.4)
    monkeypatch.setattr(main, "LEVEL_HEARTBEAT_SECONDS", 0.1)
    kinds = [line["type"] for line in lines_of(post(NDJSON))]
    assert kinds[-1] == "result" and kinds.count("heartbeat") >= 2


def test_without_the_header_the_answer_is_the_plain_json_it_always_was(monkeypatch) -> None:
    patch_run(monkeypatch, tree)
    response = post()
    assert response.headers["content-type"].startswith("application/json") and response.json()["nodes"] == []
    assert response.headers["x-req2ado-rubric-version"] == "rubric-7"


def test_a_degraded_rubric_is_reported_in_the_result_line(monkeypatch) -> None:
    def fake(doc, client_, user_id, catalog, job_id, model, primer_context, rubric_report):
        rubric_report.update({"version": "stored-3", "degraded": True})
        return tree()

    patch_run(monkeypatch, tree)
    monkeypatch.setattr("app.main._build_survey_tree_with_scoring", fake)
    assert lines_of(post(NDJSON))[-1]["rubric"] == {"version": "stored-3", "degraded": True}


def test_a_run_that_fails_ends_with_one_error_line_like_the_plain_status(monkeypatch) -> None:
    def boom():
        raise ValueError("the model said no")

    patch_run(monkeypatch, boom)
    lines = lines_of(post(NDJSON))
    assert [line["type"] for line in lines] == ["error"]
    assert lines[0]["status"] == 502 and "the model said no" in lines[0]["detail"]
    assert post().status_code == 502  # the plain route's answer for the same failure
