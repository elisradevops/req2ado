"""Captions written after the Study: /ingest with defer_captions stores the figures and writes no caption, and /captions writes them from
the stored copies with the Study's orientation as context, through the same pass /ingest runs (main._caption_figures)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.main import app
from app.request_identity import USER_ID_HEADER
from app.vision.figure_storage_client import OrchestratorFigureFileClient
from app.vision.orchestrator_vision_client import FigureVisionResult
from tests.identity import identity_headers

FIXTURES = Path(__file__).parent / "fixtures"
client = TestClient(app)
JOB = "job-captions"


class _FakeVision:
    def __init__(self) -> None:
        self.contexts: list[str | None] = []

    def describe_figure(self, image_bytes, mime_type=None, document_context=None, user_id=None):  # noqa: ANN001, ANN201
        self.contexts.append(document_context)
        return FigureVisionResult(significant=True, description="a real caption")


class _MemoryRedis:
    def __init__(self) -> None:
        self.store: dict[str, bytes] = {}

    def get(self, key):  # noqa: ANN001, ANN201
        return self.store.get(key)

    def set(self, key, value, ex=None):  # noqa: ANN001, ANN201
        self.store[key] = value.encode("utf-8") if isinstance(value, str) else value

    def publish(self, channel, payload):  # noqa: ANN001, ANN201
        pass


class _FigureFiles:
    """The orchestrator's figure store, in memory: what /ingest stores is what /captions reads back."""

    def __init__(self) -> None:
        self.files: dict[tuple[str, str], bytes] = {}
        self.fetches: list[str] = []

    def store(self, job_id, figure_id, image_bytes, mime_type):  # noqa: ANN001, ANN201
        self.files[(job_id, figure_id)] = image_bytes

    def fetch(self, job_id, figure_id):  # noqa: ANN001, ANN201
        self.fetches.append(figure_id)
        return self.files.get((job_id, figure_id))


@pytest.fixture
def stack(monkeypatch):  # noqa: ANN001, ANN201
    vision, files = _FakeVision(), _FigureFiles()
    monkeypatch.setattr(main_module, "_vision_client", vision)
    monkeypatch.setattr(main_module, "_narration_redis", _MemoryRedis())
    monkeypatch.setattr(main_module, "_figure_file_client", files)
    return vision, files


def _ingest(**params: object) -> dict:
    with open(FIXTURES / "sample.docx", "rb") as f:
        response = client.post(
            "/ingest",
            params=(p := {"user_id": "test-user", "mode": "survey", "job_id": JOB, **params}),
            headers=identity_headers(p),
            files={"file": ("sample.docx", f, "application/octet-stream")},
        )
    assert response.status_code == 200
    return response.json()


def _captions(doc: dict, **body: object) -> httpx.Response:
    return client.post(
        "/captions", params={"job_id": JOB}, json={"doc": doc, **body}, headers={USER_ID_HEADER: "test-user"}
    )


def test_a_deferred_ingest_stores_every_figure_and_writes_no_caption(stack) -> None:  # noqa: ANN001
    vision, files = stack
    doc = _ingest(defer_captions=True)
    assert vision.contexts == []
    assert [b["text"] for b in doc["blocks"] if b["kind"] == "figure"] == ["[FIGURE: none]"]
    assert set(files.files) == {(JOB, f["id"]) for f in doc["figures"]}
    assert doc["vision_active"] is True and doc["failed_figure_storage_ids"] == []


def test_deferred_then_captioned_is_the_document_one_captioned_ingest_gives(stack) -> None:  # noqa: ANN001
    at_once = _ingest(primer_context="An avionics ICD.")
    deferred = _ingest(defer_captions=True)
    response = _captions(deferred, context="An avionics ICD.")
    assert response.status_code == 200
    assert response.json() == at_once


def test_captions_use_the_orientation_and_the_stored_copy_without_storing_again(stack) -> None:  # noqa: ANN001
    vision, files = stack
    doc = _ingest(defer_captions=True)
    stored = dict(files.files)
    captioned = _captions(doc, context="Document type: An ICD").json()
    assert vision.contexts == ["Document type: An ICD"]
    assert files.fetches == [f["id"] for f in doc["figures"]]
    assert files.files == stored  # nothing stored a second time
    assert [b["text"] for b in captioned["blocks"] if b["kind"] == "figure"] == ["[FIGURE: a real caption]"]


def test_a_figure_that_cannot_be_read_back_stays_uncaptioned(stack) -> None:  # noqa: ANN001
    vision, files = stack
    doc = _ingest(defer_captions=True)
    files.files.clear()
    captioned = _captions(doc, context="x").json()
    assert vision.contexts == []
    assert [b["text"] for b in captioned["blocks"] if b["kind"] == "figure"] == ["[FIGURE: none]"]
    assert [f["caption_status"] for f in captioned["figures"]] == ["vision_failed"]


def test_a_document_vision_did_not_run_for_comes_back_unchanged(stack) -> None:  # noqa: ANN001
    vision, files = stack
    doc = _ingest(skip_vision=True)
    assert _captions(doc, context="x").json() == doc
    assert vision.contexts == [] and files.fetches == []


def test_defer_captions_without_a_job_id_captions_as_usual(stack) -> None:  # noqa: ANN001
    vision, _ = stack
    with open(FIXTURES / "sample.docx", "rb") as f:
        response = client.post(
            "/ingest",
            params={"mode": "survey", "defer_captions": True},
            headers={USER_ID_HEADER: "test-user"},
            files={"file": ("sample.docx", f, "application/octet-stream")},
        )
    assert vision.contexts == [None]
    assert [b["text"] for b in response.json()["blocks"] if b["kind"] == "figure"] == ["[FIGURE: a real caption]"]


def test_captions_written_now_are_redacted_when_the_job_redacts(stack, monkeypatch) -> None:  # noqa: ANN001
    class _LeakyVision(_FakeVision):
        def describe_figure(self, *args, **kwargs):  # noqa: ANN002, ANN003, ANN201
            super().describe_figure(*args, **kwargs)
            return FigureVisionResult(significant=True, description="Contact jane.doe@example.com for the wiring")

    monkeypatch.setattr(main_module, "_vision_client", _LeakyVision())
    doc = _ingest(defer_captions=True, redact=True)
    captioned = _captions(doc, context="x", redact=True).json()
    figure_text = [b["text"] for b in captioned["blocks"] if b["kind"] == "figure"][0]
    assert "jane.doe@example.com" not in figure_text and "wiring" in figure_text
    # redacting the rest of the document again changes nothing
    assert [b["text"] for b in captioned["blocks"] if b["kind"] != "figure"] == [
        b["text"] for b in doc["blocks"] if b["kind"] != "figure"
    ]


def test_a_disconnected_caller_cancels_the_captions(stack) -> None:  # noqa: ANN001
    doc = _ingest(defer_captions=True)

    async def gone(self) -> bool:  # noqa: ANN001
        return True

    with patch("starlette.requests.Request.is_disconnected", gone):
        assert _captions(doc, context="x").status_code == 499


def test_the_figure_client_reads_a_stored_copy_and_says_none_for_a_missing_one() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/f1/bytes"):
            return httpx.Response(404)
        return httpx.Response(200, content=b"png")

    files = OrchestratorFigureFileClient("http://orch", "secret")
    files._transport = httpx.MockTransport(handler)
    assert files.fetch("j1", "f0") == b"png" and files.fetch("j1", "f1") is None
    assert seen[0].url.path == "/jobs/j1/figures/f0/bytes" and seen[0].headers["Authorization"] == "Bearer secret"
