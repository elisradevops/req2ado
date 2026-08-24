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


class _SignificantVisionClientWithTitle:
    """Task 7: vision-result shape (a) plus a title -- the LLM-generated
    name fallback."""

    def describe_figure(self, image_bytes: bytes, mime_type: str | None = None, document_context: str | None = None) -> FigureVisionResult | None:
        return FigureVisionResult(significant=True, description="a real caption", title="Panel Layout Diagram")


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


def test_task7_vision_title_is_used_as_figure_name_when_the_document_provides_no_caption(monkeypatch) -> None:
    # sample.docx never has a document-provided caption (Task 4's
    # _FIGURE_CAPTION_PATTERN is PDF-only), so this exercises the pure
    # fallback path: the vision model's own title becomes Figure.name.
    import app.main as main_module

    monkeypatch.setattr(main_module, "_vision_client", _SignificantVisionClientWithTitle())

    result = _upload("sample.docx", FIXTURES / "sample.docx", mode="survey", primer_context="caption-status-title-fallback")

    assert result["figures"][0]["caption"] == "a real caption"
    assert result["figures"][0]["name"] == "Panel Layout Diagram"


def test_task7_no_vision_title_leaves_figure_name_none(monkeypatch) -> None:
    # _SignificantVisionClient (no title arg) mirrors a model response that
    # omitted the optional title field entirely.
    import app.main as main_module

    monkeypatch.setattr(main_module, "_vision_client", _SignificantVisionClient())

    result = _upload("sample.docx", FIXTURES / "sample.docx", mode="survey", primer_context="caption-status-no-title")

    assert result["figures"][0]["caption"] == "a real caption"
    assert result["figures"][0]["name"] is None


def test_task7_insignificant_figure_gets_no_title_fallback_either(monkeypatch) -> None:
    # An insignificant figure gets no caption AND no name from either
    # source -- title is only ever set on the significant branch.
    import app.main as main_module

    monkeypatch.setattr(main_module, "_vision_client", _InsignificantVisionClient())

    result = _upload("sample.docx", FIXTURES / "sample.docx", mode="survey", primer_context="caption-status-insignificant-no-title")

    assert result["figures"][0]["caption"] is None
    assert result["figures"][0]["name"] is None


def _build_pdf_with_named_figure(tmp_path: Path) -> Path:
    """A one-page PDF with one figure AND a real "Figure 1: ..." caption
    line below it (Task 4), using the SAME geometry test_pdf_loader.py's
    own `_build_pdf_with_image_and_line` fixture validates (image at
    y=400/height=100, caption at y=375 -> a ~15.5pt gap, well inside
    _FIGURE_CAPTION_MAX_GAP_POINTS)."""
    from PIL import Image as PILImage
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas as rl_canvas

    image_path = tmp_path / "figure.png"
    PILImage.new("RGB", (150, 150), color="blue").save(image_path)
    out_path = tmp_path / "figure_with_caption.pdf"
    c = rl_canvas.Canvas(str(out_path), pagesize=letter)
    c.drawImage(str(image_path), 100, 400, width=150, height=100)
    c.drawString(100, 375, "Figure 1: Document-Provided Diagram Title")
    c.showPage()
    c.save()
    return out_path


def test_task7_document_caption_wins_over_a_vision_title_when_both_exist(tmp_path, monkeypatch) -> None:
    # Task 4's document-provided name must never be overridden by Task 7's
    # LLM fallback -- the fallback only ever fills a gap, never replaces an
    # already-known name.
    import app.main as main_module

    monkeypatch.setattr(main_module, "_vision_client", _SignificantVisionClientWithTitle())

    pdf_path = _build_pdf_with_named_figure(tmp_path)
    result = _upload("figure_with_caption.pdf", pdf_path, mode="survey", primer_context="caption-status-document-wins")

    assert result["figures"][0]["name"] == "Document-Provided Diagram Title"


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
