# ingestion/tests/test_ingest_endpoint.py
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import settings
from app.main import _sniff_image_mime_type, app

client = TestClient(app)
FIXTURES = Path(__file__).parent / "fixtures"


def _upload(filename: str, path: Path, redact: bool = False, **extra_params: object) -> dict:
    with open(path, "rb") as f:
        response = client.post(
            "/ingest",
            params={"redact": redact, **extra_params},
            files={"file": (filename, f, "application/octet-stream")},
        )
    assert response.status_code == 200
    return response.json()


def test_ingest_txt() -> None:
    body = _upload("sample.txt", FIXTURES / "sample.txt")
    assert body["document"]["format"] == "txt"
    assert len(body["blocks"]) == 2


def test_ingest_markdown() -> None:
    body = _upload("sample.md", FIXTURES / "sample.md")
    assert body["document"]["format"] == "md"
    assert any(b["kind"] == "heading" for b in body["blocks"])


def test_ingest_docx() -> None:
    body = _upload("sample.docx", FIXTURES / "sample.docx")
    assert body["document"]["format"] == "docx"
    assert len(body["tables"]) == 1


def test_ingest_xlsx() -> None:
    body = _upload("sample.xlsx", FIXTURES / "sample.xlsx")
    assert body["document"]["format"] == "xlsx"
    assert len(body["tables"]) == 2


def test_ingest_pdf() -> None:
    body = _upload("sample.pdf", FIXTURES / "sample.pdf")
    assert body["document"]["format"] == "pdf"
    assert len(body["blocks"]) >= 1


def test_ingest_scanned_pdf_via_ocr() -> None:
    body = _upload("scanned_sample.pdf", FIXTURES / "scanned_sample.pdf")
    assert body["document"]["format"] == "pdf_scanned"
    assert any(b["kind"] == "open_tbd" for b in body["blocks"])


def test_ingest_pptx() -> None:
    body = _upload("sample.pptx", FIXTURES / "sample.pptx")
    assert body["document"]["format"] == "pptx"
    assert any(b["kind"] == "heading" for b in body["blocks"])


def test_ingest_csv() -> None:
    body = _upload("sample.csv", FIXTURES / "sample.csv")
    assert body["document"]["format"] == "csv"
    assert len(body["tables"]) == 1
    assert body["tables"][0]["rows"][0] == ["Component", "Voltage", "Current (A)"]


def test_ingest_rtf() -> None:
    body = _upload("sample.rtf", FIXTURES / "sample.rtf")
    assert body["document"]["format"] == "rtf"
    assert any("thermal requirements" in b["text"] for b in body["blocks"])


def test_ingest_image() -> None:
    body = _upload("sample.png", FIXTURES / "sample.png")
    assert body["document"]["format"] == "image"
    assert len(body["blocks"]) == 1
    assert body["blocks"][0]["kind"] == "figure"


def test_ingest_with_redact_strips_emails() -> None:
    # sample.txt has no email, so use a temp fixture with one inline
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".txt", mode="w", delete=False) as f:
        f.write("Contact jane.doe@example.com for details.")
        temp_path = Path(f.name)

    body = _upload(temp_path.name, temp_path, redact=True)
    assert "jane.doe@example.com" not in body["blocks"][0]["text"]
    temp_path.unlink()


def test_ingest_rejects_a_file_exceeding_the_configured_size_cap(monkeypatch) -> None:
    # Regression: /ingest previously buffered the whole upload into memory
    # with no size guard of its own at this layer (the orchestrator's own
    # check happens before forwarding here, but this endpoint is
    # independently reachable). Set a tiny cap so a small fixture trips it
    # without needing to actually construct a huge file.
    monkeypatch.setattr(settings, "max_upload_size_mb", 0)  # effectively 0 bytes allowed
    with tempfile.NamedTemporaryFile(suffix=".txt", mode="w", delete=False) as f:
        f.write("more than zero bytes of content")
        temp_path = Path(f.name)

    with open(temp_path, "rb") as f:
        response = client.post(
            "/ingest", files={"file": (temp_path.name, f, "application/octet-stream")}
        )
    assert response.status_code == 413
    temp_path.unlink()


def test_ingest_skip_vision_skips_figure_captioning_even_when_vision_is_configured(monkeypatch) -> None:
    # Regression: /jobs/preview (orchestrator) only needs blockCount/
    # sectionCount/fileType -- it never reads figure captions -- but before
    # skip_vision existed, every embedded image in a merely-previewed
    # document paid the full per-image vision-LLM inference cost anyway
    # (confirmed live: a single small image made preview take 28s instead
    # of ~30ms). skip_vision=true must suppress describe_figure entirely,
    # even when a real vision client IS configured.
    import app.main as main_module

    class _FakeVisionClient:
        def __init__(self) -> None:
            self.calls = 0

        def describe_figure(self, image_bytes: bytes, mime_type: str | None = None) -> str:
            self.calls += 1
            return "a description nobody asked for"

    fake_client = _FakeVisionClient()
    monkeypatch.setattr(main_module, "_vision_client", fake_client)

    body = _upload("sample.docx", FIXTURES / "sample.docx", **{"skip_vision": True})
    figure_blocks = [b for b in body["blocks"] if b["kind"] == "figure"]
    assert len(figure_blocks) == 1
    assert figure_blocks[0]["text"] == "[FIGURE: none]"  # placeholder, not the fake caption
    assert fake_client.calls == 0


def test_ingest_survey_mode_still_captions_when_vision_is_configured(monkeypatch) -> None:
    # Companion to the test above -- proves skip_vision is opt-in, not a
    # silent global regression: real SURVEY job submission
    # (pipeline.worker.ts, mode='survey') must keep getting real captions.
    import app.main as main_module

    class _FakeVisionClient:
        def __init__(self) -> None:
            self.calls = 0

        def describe_figure(self, image_bytes: bytes, mime_type: str | None = None) -> str:
            self.calls += 1
            return "a real caption"

    fake_client = _FakeVisionClient()
    monkeypatch.setattr(main_module, "_vision_client", fake_client)

    body = _upload("sample.docx", FIXTURES / "sample.docx", mode="survey")
    figure_blocks = [b for b in body["blocks"] if b["kind"] == "figure"]
    assert figure_blocks[0]["text"] == "[FIGURE: a real caption]"
    assert fake_client.calls == 1


def test_ingest_baseline_mode_never_captions_even_when_vision_is_configured(monkeypatch) -> None:
    # BASELINE is contractually verbatim/no-AI: a figure caption is
    # model-authored text, and must never reach a contract-baseline
    # System.Description regardless of skip_vision or whether a vision
    # client is configured (LLM_VISION_MODEL set). This is the mode gate
    # itself -- distinct from skip_vision, which is a latency optimization
    # for /jobs/preview only. Default mode ("baseline", per /ingest's own
    # signature) must behave identically to an explicit mode="baseline".
    import app.main as main_module

    class _FakeVisionClient:
        def __init__(self) -> None:
            self.calls = 0

        def describe_figure(self, image_bytes: bytes, mime_type: str | None = None) -> str:
            self.calls += 1
            return "a description that must never appear in baseline"

    fake_client = _FakeVisionClient()
    monkeypatch.setattr(main_module, "_vision_client", fake_client)

    body = _upload("sample.docx", FIXTURES / "sample.docx")  # mode omitted -> default baseline
    figure_blocks = [b for b in body["blocks"] if b["kind"] == "figure"]
    assert figure_blocks[0]["text"] == "[FIGURE: none]"
    assert fake_client.calls == 0

    fake_client.calls = 0
    body = _upload("sample.docx", FIXTURES / "sample.docx", mode="baseline")  # explicit, same result
    figure_blocks = [b for b in body["blocks"] if b["kind"] == "figure"]
    assert figure_blocks[0]["text"] == "[FIGURE: none]"
    assert fake_client.calls == 0


def test_ingest_unrecognized_mode_value_fails_safe_to_baseline(monkeypatch) -> None:
    # Fail-safe direction matches /level's own `if mode == "survey"` fork
    # (main.py) -- anything other than the exact string "survey" must never
    # open the vision gate.
    import app.main as main_module

    class _FakeVisionClient:
        def __init__(self) -> None:
            self.calls = 0

        def describe_figure(self, image_bytes: bytes, mime_type: str | None = None) -> str:
            self.calls += 1
            return "should never be reached"

    fake_client = _FakeVisionClient()
    monkeypatch.setattr(main_module, "_vision_client", fake_client)

    body = _upload("sample.docx", FIXTURES / "sample.docx", mode="Survey")  # wrong case, not "survey"
    figure_blocks = [b for b in body["blocks"] if b["kind"] == "figure"]
    assert figure_blocks[0]["text"] == "[FIGURE: none]"
    assert fake_client.calls == 0


def test_ingest_then_level_baseline_never_touches_a_configured_vision_client() -> None:
    # Executable version of the "BASELINE is no-AI" invariant that
    # config.yaml's enabled_in_baseline: false documents but nothing reads
    # (see docs/architecture audit): drives the real pipeline shape
    # (/ingest?mode=baseline -> /level?mode=baseline) end to end over a
    # figure-bearing document with a real vision client monkeypatched to
    # raise on any call. If BASELINE ever reopens the vision gate, this
    # fails loudly instead of silently emitting a model-authored caption.
    import app.main as main_module

    class _ExplodingVisionClient:
        def describe_figure(self, image_bytes: bytes, mime_type: str | None = None) -> str:
            raise AssertionError("BASELINE must never call describe_figure")

    monkeypatch_target = main_module._vision_client
    main_module._vision_client = _ExplodingVisionClient()
    try:
        with open(FIXTURES / "sample.docx", "rb") as f:
            ingest_response = client.post(
                "/ingest",
                params={"mode": "baseline"},
                files={"file": ("sample.docx", f, "application/octet-stream")},
            )
        assert ingest_response.status_code == 200
        doc = ingest_response.json()

        level_response = client.post("/level", params={"mode": "baseline"}, json=doc)
        assert level_response.status_code == 200
        figure_blocks = [n for n in level_response.json()["nodes"] if "[FIGURE:" in n["description"]]
        assert all("none" in n["description"] for n in figure_blocks)
    finally:
        main_module._vision_client = monkeypatch_target


def test_ingest_unsupported_extension_returns_400() -> None:
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".exe", mode="wb", delete=False) as f:
        f.write(b"not a real document")
        temp_path = Path(f.name)

    with open(temp_path, "rb") as f:
        response = client.post(
            "/ingest", files={"file": (temp_path.name, f, "application/octet-stream")}
        )
    assert response.status_code == 400
    temp_path.unlink()


def test_sniff_image_mime_type_detects_jpeg() -> None:
    assert _sniff_image_mime_type(b"\xff\xd8\xff\xe0rest of jpeg") == "image/jpeg"


def test_sniff_image_mime_type_detects_png() -> None:
    assert _sniff_image_mime_type(b"\x89PNG\r\n\x1a\nrest of png") == "image/png"


def test_sniff_image_mime_type_detects_gif() -> None:
    assert _sniff_image_mime_type(b"GIF89arest of gif") == "image/gif"


def test_sniff_image_mime_type_detects_bmp() -> None:
    assert _sniff_image_mime_type(b"BMrest of bmp") == "image/bmp"


def test_sniff_image_mime_type_detects_webp() -> None:
    assert _sniff_image_mime_type(b"RIFF\x00\x00\x00\x00WEBPrest") == "image/webp"


def test_sniff_image_mime_type_detects_tiff() -> None:
    assert _sniff_image_mime_type(b"II*\x00rest of tiff") == "image/tiff"


def test_sniff_image_mime_type_returns_none_for_unrecognized_bytes() -> None:
    assert _sniff_image_mime_type(b"not a real image format") is None
