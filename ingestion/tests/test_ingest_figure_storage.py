# ingestion/tests/test_ingest_figure_storage.py
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
FIXTURES = Path(__file__).parent / "fixtures"


def _upload(filename: str, path: Path, **extra_params: object) -> dict:
    with open(path, "rb") as f:
        response = client.post(
            "/ingest",
            params={"redact": False, **extra_params},
            files={"file": (filename, f, "application/octet-stream")},
        )
    assert response.status_code == 200
    return response.json()


class _FakeVisionClient:
    def describe_figure(self, image_bytes: bytes, mime_type: str | None = None) -> str:
        return "a real caption"


def test_ingest_stores_a_compressed_figure_file_when_job_id_is_given(monkeypatch) -> None:
    import app.main as main_module

    stored: list[tuple[str, str, bytes, str]] = []

    class _FakeFigureFileClient:
        def store(self, job_id: str, figure_id: str, image_bytes: bytes, mime_type: str) -> None:
            stored.append((job_id, figure_id, image_bytes, mime_type))

    monkeypatch.setattr(main_module, "_vision_client", _FakeVisionClient())
    monkeypatch.setattr(main_module, "_figure_file_client", _FakeFigureFileClient())

    _upload("sample.docx", FIXTURES / "sample.docx", mode="survey", job_id="job-figure-storage-test")

    # sample.docx has exactly one figure -- the loader's own 0-based
    # f"f{figure_index}" id scheme assigns it "f0".
    assert len(stored) == 1
    job_id, figure_id, image_bytes, mime_type = stored[0]
    assert job_id == "job-figure-storage-test"
    assert figure_id == "f0"
    assert mime_type == "image/png"
    assert len(image_bytes) > 0


def test_ingest_never_stores_a_figure_file_when_job_id_is_omitted(monkeypatch) -> None:
    # /jobs/preview's own call never supplies job_id -- must never call the
    # storage client at all (there is no job to store a figure against).
    import app.main as main_module

    class _ExplodingFigureFileClient:
        def store(self, job_id: str, figure_id: str, image_bytes: bytes, mime_type: str) -> None:
            raise AssertionError("must not be called when job_id is omitted")

    monkeypatch.setattr(main_module, "_vision_client", _FakeVisionClient())
    monkeypatch.setattr(main_module, "_figure_file_client", _ExplodingFigureFileClient())

    _upload("sample.docx", FIXTURES / "sample.docx", mode="survey")


def test_ingest_still_returns_the_caption_when_figure_file_storage_fails(monkeypatch) -> None:
    # Best-effort: a storage POST failure (network, oversized, orchestrator
    # down) must never fail the describe_figure call it's piggybacking on.
    import app.main as main_module

    class _FailingFigureFileClient:
        def store(self, job_id: str, figure_id: str, image_bytes: bytes, mime_type: str) -> None:
            raise RuntimeError("orchestrator unreachable")

    monkeypatch.setattr(main_module, "_vision_client", _FakeVisionClient())
    monkeypatch.setattr(main_module, "_figure_file_client", _FailingFigureFileClient())

    result = _upload("sample.docx", FIXTURES / "sample.docx", mode="survey", job_id="job-figure-storage-fail-test")

    assert result["figures"][0]["caption"] == "a real caption"
