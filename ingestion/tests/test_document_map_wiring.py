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
