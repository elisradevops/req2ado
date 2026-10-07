# ingestion/tests/test_ingest_caption_status.py
# Task 4b sub-fix (ii): Figure.caption_status disambiguates the 2 causes of
# caption=None that happen while vision IS active ("insignificant" vs
# "vision_failed") -- and CanonicalDoc.vision_active (sub-fix i) records
# whether vision ran for this document at all. Mirrors
# test_ingest_figure_storage.py's own TestClient conventions.
import uuid
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
            # user_id defaults on: vision only runs for a request carrying the
            # submitting user's identity. Pass user_id=None-equivalent by
            # overriding with "" to exercise the no-user case.
            params={"redact": False, "user_id": "test-user", **extra_params},
            files={"file": (filename, f, "application/octet-stream")},
        )
    assert response.status_code == 200
    return response.json()


class _SignificantVisionClient:
    """Vision-result shape (a): the call succeeded and the model judged the
    figure significant -- a real caption, caption_status stays null."""

    def describe_figure(self, image_bytes: bytes, mime_type: str | None = None, document_context: str | None = None, user_id: str | None = None) -> FigureVisionResult | None:
        return FigureVisionResult(significant=True, description="a real caption")


class _InsignificantVisionClient:
    """Vision-result shape (b): the call succeeded but the model judged the
    figure decorative/non-technical -- caption=None, caption_status="insignificant"."""

    def describe_figure(self, image_bytes: bytes, mime_type: str | None = None, document_context: str | None = None, user_id: str | None = None) -> FigureVisionResult | None:
        return FigureVisionResult(significant=False, description="")


class _SignificantVisionClientWithTitle:
    """Task 7: vision-result shape (a) plus a title -- the LLM-generated
    name fallback."""

    def describe_figure(self, image_bytes: bytes, mime_type: str | None = None, document_context: str | None = None, user_id: str | None = None) -> FigureVisionResult | None:
        return FigureVisionResult(significant=True, description="a real caption", title="Panel Layout Diagram")


class _FailingVisionClient:
    """Vision-result shape (c): the call itself errored/returned an
    unparseable response -- main.py's _describe_figure ambiguous-result
    branch, caption=None, caption_status="vision_failed"."""

    def describe_figure(self, image_bytes: bytes, mime_type: str | None = None, document_context: str | None = None, user_id: str | None = None) -> FigureVisionResult | None:
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


def test_vision_active_is_false_when_the_request_has_no_user_identity(monkeypatch) -> None:
    # Vision is no longer gated on a global LLM_VISION_MODEL; it needs the
    # submitting user's identity so the orchestrator can resolve the model.
    import app.main as main_module

    monkeypatch.setattr(main_module, "_vision_client", _SignificantVisionClient())

    result = _upload("sample.docx", FIXTURES / "sample.docx", mode="survey", user_id="")

    assert result["vision_active"] is False
    assert result["vision_skip_reason"] == "no_user"
    assert result["figures"][0]["caption_status"] is None


def test_vision_skip_reason_reflects_why_the_gate_stayed_shut(monkeypatch) -> None:
    import app.main as main_module

    monkeypatch.setattr(main_module, "_vision_client", _SignificantVisionClient())
    path = FIXTURES / "sample.docx"

    baseline = _upload("sample.docx", path, mode="baseline")
    skipped = _upload("sample.docx", path, mode="survey", skip_vision=True)
    orchestrator_decided = _upload(
        "sample.docx", path, mode="survey", skip_vision=True, vision_skip_reason="model_not_vision_capable",
    )
    active = _upload("sample.docx", path, mode="survey", primer_context="skip-reason-active")

    assert baseline["vision_skip_reason"] == "baseline_mode"
    assert skipped["vision_skip_reason"] == "skip_vision_requested"
    assert orchestrator_decided["vision_skip_reason"] == "model_not_vision_capable"
    assert active["vision_active"] is True and active["vision_skip_reason"] is None


MULTI_FIGURE_FIXTURE_NAME = "multi_figure.docx"


def test_multi_figure_document_captions_every_figure_with_matching_ids(monkeypatch) -> None:
    # The core equivalence guarantee: a multi-figure document must come back
    # with each figure's OWN caption on the right id, and each figure's
    # paired FIGURE-kind block carrying that same caption in its text --
    # which is what /level's _figure_line actually reads to decide
    # figure_ids vs uncaptioned_figure_ids.
    import app.main as main_module

    class _PerImageVisionClient:
        """A distinct caption per distinct image, so a mis-ordered
        reassignment is detectable rather than masked by identical text."""

        def describe_figure(self, image_bytes: bytes, mime_type: str | None = None, document_context: str | None = None, user_id: str | None = None):
            import hashlib

            digest = hashlib.sha256(image_bytes).hexdigest()[:8]
            return FigureVisionResult(significant=True, description=f"caption for {digest}")

    monkeypatch.setattr(main_module, "_vision_client", _PerImageVisionClient())

    result = _upload(
        MULTI_FIGURE_FIXTURE_NAME, FIXTURES / MULTI_FIGURE_FIXTURE_NAME, mode="survey",
        primer_context="multi-figure-caption-ids",
    )

    figures = result["figures"]
    assert len(figures) >= 2
    assert [f["id"] for f in figures] == [f"f{i}" for i in range(len(figures))]
    for figure in figures:
        assert figure["caption"] and figure["caption"].startswith("caption for ")

    figure_blocks = [b for b in result["blocks"] if b["kind"] == "figure"]
    assert len(figure_blocks) == len(figures)
    for block, figure in zip(figure_blocks, figures):
        # Positional pairing -- the same pairing tree_builder.
        # figure_id_by_block_id uses, and the reason source_ref must NOT be
        # used here.
        assert block["text"] == f"[FIGURE: {figure['caption']}]"


def test_an_uncaptioned_figure_keeps_the_none_placeholder_block_text(monkeypatch) -> None:
    # The other half: when vision returns no real caption, the paired block
    # text must stay "[FIGURE: none]" -- _figure_line treats that as
    # uncaptioned, which is what populates uncaptioned_figure_ids in /level.
    import app.main as main_module

    class _InsignificantVisionClient:
        def describe_figure(self, image_bytes: bytes, mime_type: str | None = None, document_context: str | None = None, user_id: str | None = None):
            return FigureVisionResult(significant=False, description="")

    monkeypatch.setattr(main_module, "_vision_client", _InsignificantVisionClient())

    result = _upload(
        "sample.docx", FIXTURES / "sample.docx", mode="survey",
        primer_context="uncaptioned-placeholder-block-text",
    )

    assert result["figures"][0]["caption"] is None
    assert result["figures"][0]["caption_status"] == "insignificant"
    figure_blocks = [b for b in result["blocks"] if b["kind"] == "figure"]
    assert figure_blocks[0]["text"] == "[FIGURE: none]"


def test_figure_captioning_happens_after_parsing_not_during_it(monkeypatch) -> None:
    # Proves the two phases really are split: no vision call may be made
    # while the loader is still walking the document. Observed by recording
    # whether describe_figure was ever entered before the loader returned.
    import app.main as main_module

    events: list[str] = []
    original_dispatch = main_module.dispatch_by_extension

    def recording_dispatch(*args, **kwargs):
        events.append("parse_start")
        doc = original_dispatch(*args, **kwargs)
        events.append("parse_end")
        return doc

    class _RecordingVisionClient:
        def describe_figure(self, image_bytes: bytes, mime_type: str | None = None, document_context: str | None = None, user_id: str | None = None):
            events.append("vision")
            return FigureVisionResult(significant=True, description="a real caption")

    monkeypatch.setattr(main_module, "dispatch_by_extension", recording_dispatch)
    monkeypatch.setattr(main_module, "_vision_client", _RecordingVisionClient())

    _upload(
        "sample.docx", FIXTURES / "sample.docx", mode="survey",
        # uuid, not a fixed literal: the caption cache key includes this
        # context and lives for 7 days in a real Redis, so a fixed value makes
        # every rerun a cache hit -- no vision call at all, and the
        # "vision in events" assertion below would fail spuriously.
        primer_context=f"captioning-after-parsing-{uuid.uuid4()}",
    )

    assert "vision" in events
    assert events.index("vision") > events.index("parse_end")
