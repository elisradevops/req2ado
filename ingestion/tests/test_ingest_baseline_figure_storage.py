# ingestion/tests/test_ingest_baseline_figure_storage.py
"""BASELINE (deterministic, no LLM) still stores every figure's bytes so the
orchestrator can attach them to ADO work items -- without any vision call."""

from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from app.vision.orchestrator_vision_client import FigureVisionResult
from tests.identity import identity_headers

client = TestClient(app)
FIXTURES = Path(__file__).parent / "fixtures"
MULTI_FIGURE = FIXTURES / "multi_figure.docx"  # exactly two figures


def _upload(filename: str, path: Path, **extra_params: object) -> dict:
    with open(path, "rb") as f:
        response = client.post(
            "/ingest",
            params=(params := {"redact": False, "user_id": "test-user", **extra_params}),
            headers=identity_headers(params),
            files={"file": (filename, f, "application/octet-stream")},
        )
    assert response.status_code == 200
    return response.json()


class _ExplodingVisionClient:
    def describe_figure(self, *args: object, **kwargs: object) -> FigureVisionResult | None:
        raise AssertionError("BASELINE must never call the vision client")


class _RecordingFigureFileClient:
    def __init__(self) -> None:
        self.stored: list[tuple[str, str, bytes, str]] = []

    def store(self, job_id: str, figure_id: str, image_bytes: bytes, mime_type: str) -> None:
        self.stored.append((job_id, figure_id, image_bytes, mime_type))


def test_baseline_ingest_stores_every_figure_without_any_vision_call(monkeypatch) -> None:
    import app.main as main_module

    recorder = _RecordingFigureFileClient()
    monkeypatch.setattr(main_module, "_vision_client", _ExplodingVisionClient())
    monkeypatch.setattr(main_module, "_figure_file_client", recorder)

    result = _upload("multi.docx", MULTI_FIGURE, mode="baseline", job_id="job-baseline-store")

    # The store pass runs on a small thread pool, so the order the stores land in is not defined; the figure ids are.
    assert sorted((job, fig, mime) for job, fig, _, mime in recorder.stored) == [
        ("job-baseline-store", "f0", "image/png"),
        ("job-baseline-store", "f1", "image/png"),
    ]
    assert all(len(data) > 0 for _, _, data, _ in recorder.stored)
    assert [figure["id"] for figure in result["figures"]] == ["f0", "f1"]
    assert result["failed_figure_storage_ids"] == []


def test_baseline_figures_keep_caption_status_none(monkeypatch) -> None:
    import app.main as main_module

    monkeypatch.setattr(main_module, "_vision_client", _ExplodingVisionClient())
    monkeypatch.setattr(main_module, "_figure_file_client", _RecordingFigureFileClient())

    result = _upload("multi.docx", MULTI_FIGURE, mode="baseline", job_id="job-baseline-status")

    assert result["vision_active"] is False
    assert [figure["caption_status"] for figure in result["figures"]] == [None, None]
    assert [figure["caption"] for figure in result["figures"]] == [None, None]


def test_baseline_store_failure_is_reported_in_failed_figure_storage_ids(monkeypatch) -> None:
    import app.main as main_module

    class _FailingFigureFileClient:
        def store(self, job_id: str, figure_id: str, image_bytes: bytes, mime_type: str) -> None:
            if figure_id == "f1":
                raise RuntimeError("orchestrator down")

    monkeypatch.setattr(main_module, "_vision_client", _ExplodingVisionClient())
    monkeypatch.setattr(main_module, "_figure_file_client", _FailingFigureFileClient())

    result = _upload("multi.docx", MULTI_FIGURE, mode="baseline", job_id="job-baseline-fail")

    assert result["failed_figure_storage_ids"] == ["f1"]
    assert [figure["caption_status"] for figure in result["figures"]] == [None, None]


def test_baseline_without_job_id_collects_and_stores_nothing(monkeypatch) -> None:
    import app.main as main_module

    class _ExplodingFigureFileClient:
        def store(self, *args: object, **kwargs: object) -> None:
            raise AssertionError("must not be called when job_id is omitted")

    monkeypatch.setattr(main_module, "_vision_client", _ExplodingVisionClient())
    monkeypatch.setattr(main_module, "_figure_file_client", _ExplodingFigureFileClient())

    result = _upload("multi.docx", MULTI_FIGURE, mode="baseline")

    assert result["failed_figure_storage_ids"] == []


def test_the_vision_path_still_stores_the_same_ids_as_before(monkeypatch) -> None:
    import app.main as main_module

    class _FakeVisionClient:
        def describe_figure(self, *args: object, **kwargs: object) -> FigureVisionResult | None:
            return FigureVisionResult(significant=True, description="a real caption")

    recorder = _RecordingFigureFileClient()
    monkeypatch.setattr(main_module, "_vision_client", _FakeVisionClient())
    monkeypatch.setattr(main_module, "_figure_file_client", recorder)

    _upload("multi.docx", MULTI_FIGURE, mode="survey", job_id="job-survey-store")

    assert [fig for _, fig, _, _ in recorder.stored] == ["f0", "f1"]


def test_an_unreadable_image_is_reported_as_a_store_failure(monkeypatch) -> None:
    import app.main as main_module

    recorder = _RecordingFigureFileClient()
    monkeypatch.setattr(main_module, "_figure_file_client", recorder)
    monkeypatch.setattr(main_module, "compress_figure_for_storage", lambda _bytes: None)

    assert main_module._store_figure_bytes("job-x", "f0", b"not an image") is False
    assert recorder.stored == []


def test_baseline_store_pass_runs_figures_concurrently_up_to_the_limit(monkeypatch) -> None:
    import threading

    import app.main as main_module

    lock = threading.Lock()
    state = {"now": 0, "max": 0}
    barrier = threading.Barrier(2, timeout=5)

    def _fake_store(job_id, figure_id, data, rasterized_bytes=None) -> bool:
        with lock:
            state["now"] += 1
            state["max"] = max(state["max"], state["now"])
        try:
            barrier.wait()  # both figures must be in flight together
        finally:
            with lock:
                state["now"] -= 1
        return True

    monkeypatch.setattr(main_module, "_vision_client", _ExplodingVisionClient())
    monkeypatch.setattr(main_module, "_store_figure_bytes", _fake_store)
    monkeypatch.setattr(main_module, "BASELINE_STORE_CONCURRENCY", 2)

    result = _upload("multi.docx", MULTI_FIGURE, mode="baseline", job_id="job-conc")

    assert state["max"] == 2
    assert result["failed_figure_storage_ids"] == []

    state["max"] = 0
    barrier = threading.Barrier(1, timeout=5)  # concurrency 1: never two in flight
    monkeypatch.setattr(main_module, "BASELINE_STORE_CONCURRENCY", 1)
    _upload("multi.docx", MULTI_FIGURE, mode="baseline", job_id="job-conc-1")
    assert state["max"] == 1


def test_figures_not_started_after_the_time_budget_are_reported_as_failed(monkeypatch) -> None:
    import time as time_module

    import app.main as main_module

    started: list[str] = []

    def _slow_store(job_id, figure_id, data, rasterized_bytes=None) -> bool:
        started.append(figure_id)
        time_module.sleep(0.1)
        return True

    monkeypatch.setattr(main_module, "_vision_client", _ExplodingVisionClient())
    monkeypatch.setattr(main_module, "_store_figure_bytes", _slow_store)
    monkeypatch.setattr(main_module, "BASELINE_STORE_CONCURRENCY", 1)
    monkeypatch.setattr(main_module, "BASELINE_STORE_BUDGET_SECONDS", 0.02)

    result = _upload("multi.docx", MULTI_FIGURE, mode="baseline", job_id="job-budget")

    assert started == ["f0"]
    assert result["failed_figure_storage_ids"] == ["f1"]


def test_cancel_stops_submitting_further_figures(monkeypatch) -> None:
    import app.main as main_module

    started: list[str] = []
    calls = {"n": 0}

    def _fake_store(job_id, figure_id, data, rasterized_bytes=None) -> bool:
        started.append(figure_id)
        return True

    def _cancel_on_second_check() -> None:
        calls["n"] += 1
        if calls["n"] >= 2:
            raise main_module.job_cancel.JobCancelled("cancelled")

    monkeypatch.setattr(main_module, "_vision_client", _ExplodingVisionClient())
    monkeypatch.setattr(main_module, "_store_figure_bytes", _fake_store)
    monkeypatch.setattr(main_module, "BASELINE_STORE_CONCURRENCY", 1)
    monkeypatch.setattr(main_module.job_cancel, "raise_if_cancelled", _cancel_on_second_check)

    with open(MULTI_FIGURE, "rb") as f:
        params = {"redact": False, "user_id": "test-user", "mode": "baseline", "job_id": "j-c"}
        response = client.post(
            "/ingest",
            params=params,
            headers=identity_headers(params),
            files={"file": ("multi.docx", f, "application/octet-stream")},
        )

    assert response.status_code == 499
    assert started == ["f0"]
