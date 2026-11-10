import json

from app import main as main_module
from app.canonical.model import (
    Block,
    BlockKind,
    CanonicalDoc,
    Document,
    DocumentFormat,
    SourceRef,
)
from app.leveling import document_map as dm


def _sr(i: int) -> SourceRef:
    return SourceRef(document_path="x.docx", start_offset=i, end_offset=i + 1)


def _doc() -> CanonicalDoc:
    headings = [
        (1, "1  Power"), (2, "1.1  Bus voltage"),
        (3, "1.1.1  The system shall limit ripple."), (3, "1.1.2  The system shall report faults."),
    ]
    return CanonicalDoc(
        document=Document(path="x.docx", format=DocumentFormat.DOCX, sha256="x"),
        blocks=[
            Block(
                id=f"h{i}", kind=BlockKind.HEADING, heading_level=level, text=text,
                source_ref=_sr(i),
            )
            for i, (level, text) in enumerate(headings)
        ],
    )


class _FakeRedis:
    def __init__(self) -> None:
        self.sets: list[tuple[str, str, int | None]] = []

    def set(self, name, value, ex=None):  # noqa: ANN001
        self.sets.append((name, value, ex))


SENTINEL = object()


def _run(monkeypatch, *, live_progress: bool, job_id):  # noqa: ANN001, ANN202
    fake = _FakeRedis()
    monkeypatch.setattr(main_module, "_narration_redis", fake)
    monkeypatch.setattr(main_module.settings, "live_progress", live_progress)
    monkeypatch.setattr(main_module, "build_survey_tree", lambda *a, **k: SENTINEL)
    monkeypatch.setattr(main_module, "_get_criteria_retriever", lambda user_id: None)
    result = main_module._build_survey_tree_with_scoring(_doc(), None, None, None, job_id)
    return fake, result


def test_flag_off_writes_nothing_and_still_builds_the_tree(monkeypatch) -> None:
    fake, result = _run(monkeypatch, live_progress=False, job_id="job-1")
    assert result is SENTINEL
    assert fake.sets == []


def test_flag_on_writes_the_map_for_the_job(monkeypatch) -> None:
    fake, result = _run(monkeypatch, live_progress=True, job_id="job-1")
    assert result is SENTINEL
    assert [name for name, _, _ in fake.sets] == ["job-events:job-1:map"]
    payload = json.loads(fake.sets[0][1])
    assert payload["totalItems"] == 4


def test_flag_on_without_a_job_id_writes_nothing(monkeypatch) -> None:
    fake, result = _run(monkeypatch, live_progress=True, job_id=None)
    assert result is SENTINEL
    assert fake.sets == []


def test_a_map_failure_never_breaks_the_job(monkeypatch) -> None:
    def boom(_doc):  # noqa: ANN001, ANN202
        raise RuntimeError("detector exploded")

    monkeypatch.setattr(dm, "subtree_inputs_for_doc", boom)
    fake, result = _run(monkeypatch, live_progress=True, job_id="job-1")
    assert result is SENTINEL
    assert fake.sets == []


def test_publish_returns_false_when_redis_is_down(monkeypatch) -> None:
    class Broken:
        def set(self, *a, **k):  # noqa: ANN002, ANN003, ANN202
            raise ConnectionError("down")

    assert dm.publish_document_map(Broken(), "job-1", _doc()) is False


def _client():  # noqa: ANN202
    from fastapi.testclient import TestClient

    return TestClient(main_module.app)


def test_the_map_route_publishes_the_map_of_a_given_document(monkeypatch) -> None:
    # A cache hit skips /ingest and /level, so the orchestrator hands the cached document here to give the new job its map.
    fake = _FakeRedis()
    monkeypatch.setattr(main_module, "_narration_redis", fake)
    monkeypatch.setattr(main_module.settings, "live_progress", True)
    response = _client().post("/document-map", params={"job_id": "job-9"}, json=_doc().model_dump(mode="json"))
    assert response.status_code == 200
    assert response.json() == {"published": True}
    assert [name for name, _, _ in fake.sets] == ["job-events:job-9:map"]
    assert json.loads(fake.sets[0][1])["totalItems"] == 4


def test_the_map_route_writes_nothing_when_live_progress_is_off(monkeypatch) -> None:
    fake = _FakeRedis()
    monkeypatch.setattr(main_module, "_narration_redis", fake)
    monkeypatch.setattr(main_module.settings, "live_progress", False)
    response = _client().post("/document-map", params={"job_id": "job-9"}, json=_doc().model_dump(mode="json"))
    assert response.status_code == 200
    assert response.json() == {"published": False}
    assert fake.sets == []


def test_ingest_publishes_the_map_as_soon_as_the_document_exists(monkeypatch) -> None:
    # Before: the map was written when /level started, minutes after the job did, so the running screen found none at first.
    from tests.test_ingest_caption_status import FIXTURES, _upload

    fake = _FakeRedis()
    monkeypatch.setattr(main_module, "_narration_redis", fake)
    monkeypatch.setattr(main_module.settings, "live_progress", True)
    _upload("sample.docx", FIXTURES / "sample.docx", mode="survey", skip_vision=True, job_id="job-ing-1")
    assert "job-events:job-ing-1:map" in [name for name, _, _ in fake.sets]


def test_ingest_without_a_job_id_publishes_no_map(monkeypatch) -> None:
    from tests.test_ingest_caption_status import FIXTURES, _upload

    fake = _FakeRedis()
    monkeypatch.setattr(main_module, "_narration_redis", fake)
    monkeypatch.setattr(main_module.settings, "live_progress", True)
    _upload("sample.docx", FIXTURES / "sample.docx", mode="survey", skip_vision=True)
    assert [name for name, _, _ in fake.sets if name.endswith(":map")] == []
