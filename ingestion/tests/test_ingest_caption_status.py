# ingestion/tests/test_ingest_caption_status.py
# Task 4b sub-fix (ii): Figure.caption_status disambiguates the 2 causes of
# caption=None that happen while vision IS active ("insignificant" vs
# "vision_failed") -- and CanonicalDoc.vision_active (sub-fix i) records
# whether vision ran for this document at all. Mirrors
# test_ingest_figure_storage.py's own TestClient conventions.
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from app.vision.orchestrator_vision_client import FigureVisionResult

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


class _SignificantVisionClient:
    """Vision-result shape (a): the call succeeded and the model judged the
    figure significant -- a real caption, caption_status stays null."""

    def describe_figure(self, image_bytes: bytes, mime_type: str | None = None, document_context: str | None = None) -> FigureVisionResult | None:
        return FigureVisionResult(significant=True, description="a real caption")


class _InsignificantVisionClient:
    """Vision-result shape (b): the call succeeded but the model judged the
    figure decorative/non-technical -- caption=None, caption_status="insignificant"."""

    def describe_figure(self, image_bytes: bytes, mime_type: str | None = None, document_context: str | None = None) -> FigureVisionResult | None:
        return FigureVisionResult(significant=False, description="")


class _FailingVisionClient:
    """Vision-result shape (c): the call itself errored/returned an
    unparseable response -- main.py's _describe_figure ambiguous-result
    branch, caption=None, caption_status="vision_failed"."""

    def describe_figure(self, image_bytes: bytes, mime_type: str | None = None, document_context: str | None = None) -> FigureVisionResult | None:
        return None


def test_significant_figure_has_no_caption_status(monkeypatch) -> None:
    import app.main as main_module

    monkeypatch.setattr(main_module, "_vision_client", _SignificantVisionClient())

    # primer_context is part of _describe_figure's own cache key (see
    # _figure_caption_cache_key) -- given a unique value per test here so
    # each scenario's own live vision-call result isn't masked by a PRIOR
    # test's cached entry for the byte-identical sample.docx figure image
    # (this module's tests run against a real, persistent Redis, not a
    # per-test fake).
    result = _upload("sample.docx", FIXTURES / "sample.docx", mode="survey", primer_context="caption-status-significant")

    assert result["figures"][0]["caption"] == "a real caption"
    assert result["figures"][0]["caption_status"] is None
    assert result["vision_active"] is True


def test_insignificant_figure_gets_insignificant_caption_status(monkeypatch) -> None:
    import app.main as main_module

    monkeypatch.setattr(main_module, "_vision_client", _InsignificantVisionClient())

    result = _upload("sample.docx", FIXTURES / "sample.docx", mode="survey", primer_context="caption-status-insignificant")

    assert result["figures"][0]["caption"] is None
    assert result["figures"][0]["caption_status"] == "insignificant"
    assert result["vision_active"] is True


def test_failed_vision_call_gets_vision_failed_caption_status(monkeypatch) -> None:
    import app.main as main_module

    monkeypatch.setattr(main_module, "_vision_client", _FailingVisionClient())

    result = _upload("sample.docx", FIXTURES / "sample.docx", mode="survey", primer_context="caption-status-vision-failed")

    assert result["figures"][0]["caption"] is None
    assert result["figures"][0]["caption_status"] == "vision_failed"
    assert result["vision_active"] is True


def test_vision_active_is_false_and_caption_status_stays_null_for_baseline_mode(monkeypatch) -> None:
    # BASELINE never opens the vision gate at all, regardless of what
    # _vision_client would have said -- describe_figure is never called, so
    # caption_status must never be set even though the document has a real
    # figure.
    import app.main as main_module

    monkeypatch.setattr(main_module, "_vision_client", _SignificantVisionClient())

    result = _upload("sample.docx", FIXTURES / "sample.docx", mode="baseline")

    assert result["vision_active"] is False
    assert result["figures"][0]["caption"] is None
    assert result["figures"][0]["caption_status"] is None


def test_vision_active_is_false_when_skip_vision_is_set(monkeypatch) -> None:
    # /jobs/preview's own call -- skip_vision=true even in survey mode.
    import app.main as main_module

    monkeypatch.setattr(main_module, "_vision_client", _SignificantVisionClient())

    result = _upload("sample.docx", FIXTURES / "sample.docx", mode="survey", skip_vision=True)

    assert result["vision_active"] is False
    assert result["figures"][0]["caption_status"] is None


def test_vision_active_is_false_when_no_vision_client_is_configured(monkeypatch) -> None:
    # No LLM_VISION_MODEL configured at all (the real _vision_client is None
    # by default in this deployment) -- describe_figure_fn is never built.
    import app.main as main_module

    monkeypatch.setattr(main_module, "_vision_client", None)

    result = _upload("sample.docx", FIXTURES / "sample.docx", mode="survey")

    assert result["vision_active"] is False
    assert result["figures"][0]["caption_status"] is None
