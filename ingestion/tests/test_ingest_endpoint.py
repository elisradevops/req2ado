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


def test_describe_figure_caches_by_image_hash_so_a_rerun_gets_the_same_caption(monkeypatch) -> None:
    # Regression guard for a confirmed real cause of run-to-run SURVEY
    # node-count variance: a figure's caption used to be freshly (re-)
    # sampled on every job, and caption text feeds llm_leveling.py's
    # token-budget branch splitter -- a differently-worded caption on a
    # re-run could shift branch boundaries and total node count.
    # Memoizing by the image's own byte hash makes two calls with the
    # SAME bytes return the SAME caption without a second vision call.
    import app.main as main_module

    class _FakeVisionClient:
        def __init__(self) -> None:
            self.calls = 0

        def describe_figure(self, image_bytes: bytes, mime_type: str | None = None) -> str:
            self.calls += 1
            return f"caption #{self.calls}"

    class _FakeRedis:
        def __init__(self) -> None:
            self._store: dict[str, bytes] = {}

        def get(self, key):
            return self._store.get(key)

        def set(self, key, value, ex=None):
            self._store[key] = value.encode("utf-8") if isinstance(value, str) else value

        def publish(self, channel, payload):
            pass

    fake_client = _FakeVisionClient()
    fake_redis = _FakeRedis()
    monkeypatch.setattr(main_module, "_vision_client", fake_client)
    monkeypatch.setattr(main_module, "_narration_redis", fake_redis)

    first = main_module._describe_figure(b"identical-image-bytes")
    second = main_module._describe_figure(b"identical-image-bytes")

    assert first == "caption #1"
    assert second == "caption #1"  # cache hit -- NOT "caption #2"
    assert fake_client.calls == 1


def test_describe_figure_calls_the_vision_client_again_for_genuinely_different_images(monkeypatch) -> None:
    import app.main as main_module

    class _FakeVisionClient:
        def __init__(self) -> None:
            self.calls = 0

        def describe_figure(self, image_bytes: bytes, mime_type: str | None = None) -> str:
            self.calls += 1
            return f"caption #{self.calls}"

    class _FakeRedis:
        def __init__(self) -> None:
            self._store: dict[str, bytes] = {}

        def get(self, key):
            return self._store.get(key)

        def set(self, key, value, ex=None):
            self._store[key] = value.encode("utf-8") if isinstance(value, str) else value

        def publish(self, channel, payload):
            pass

    fake_client = _FakeVisionClient()
    monkeypatch.setattr(main_module, "_vision_client", fake_client)
    monkeypatch.setattr(main_module, "_narration_redis", _FakeRedis())

    first = main_module._describe_figure(b"image-one")
    second = main_module._describe_figure(b"image-two")

    assert first == "caption #1"
    assert second == "caption #2"
    assert fake_client.calls == 2


def test_describe_figure_degrades_to_a_live_call_when_the_cache_read_or_write_fails(monkeypatch) -> None:
    # Fail-open, same convention as the dedup check (dry-run.service.ts) and
    # KB retrieval (retrieval.py) -- a cache outage must never break figure
    # captioning, only make it non-cached for that call.
    import app.main as main_module

    class _FakeVisionClient:
        def describe_figure(self, image_bytes: bytes, mime_type: str | None = None) -> str:
            return "live caption"

    class _ExplodingRedis:
        def get(self, key):
            raise ConnectionError("redis is down")

        def set(self, key, value, ex=None):
            raise ConnectionError("redis is down")

    monkeypatch.setattr(main_module, "_vision_client", _FakeVisionClient())
    monkeypatch.setattr(main_module, "_narration_redis", _ExplodingRedis())

    assert main_module._describe_figure(b"some-image-bytes") == "live caption"


def test_describe_figure_never_caches_a_blank_result(monkeypatch) -> None:
    # Real bug this guards against (confirmed live, AirPro document, all 39
    # figures): a vision call that once returned an empty string got cached
    # unconditionally and then replayed that same empty caption on every
    # subsequent resubmit for a full week (_FIGURE_CAPTION_CACHE_TTL_SECONDS)
    # -- every figure in the activity log read "no useful caption returned",
    # indistinguishable from a genuinely content-free document.
    import app.main as main_module

    class _FakeVisionClient:
        def __init__(self) -> None:
            self.calls = 0

        def describe_figure(self, image_bytes: bytes, mime_type: str | None = None) -> str:
            self.calls += 1
            return "" if self.calls == 1 else "a real caption on retry"

    class _FakeRedis:
        def __init__(self) -> None:
            self._store: dict[str, bytes] = {}

        def get(self, key):
            return self._store.get(key)

        def set(self, key, value, ex=None):
            self._store[key] = value.encode("utf-8") if isinstance(value, str) else value

        def publish(self, channel, payload):
            pass

    fake_client = _FakeVisionClient()
    monkeypatch.setattr(main_module, "_vision_client", fake_client)
    monkeypatch.setattr(main_module, "_narration_redis", _FakeRedis())

    first = main_module._describe_figure(b"same-image-bytes")
    second = main_module._describe_figure(b"same-image-bytes")

    assert first == ""
    # NOT served from a poisoned cache -- the blank result was never
    # written, so the second call goes live again and self-heals.
    assert second == "a real caption on retry"
    assert fake_client.calls == 2


def test_describe_figure_still_caches_the_real_no_technical_content_sentinel(monkeypatch) -> None:
    # The blank-caption guard must NOT treat NO_TECHNICAL_CONTENT as blank --
    # it's a real, meaningful, deterministic answer (this figure genuinely
    # has no technical content) and should be memoized exactly like any
    # other real caption.
    import app.main as main_module
    from app.vision.orchestrator_vision_client import NO_TECHNICAL_CONTENT_SENTINEL

    class _FakeVisionClient:
        def __init__(self) -> None:
            self.calls = 0

        def describe_figure(self, image_bytes: bytes, mime_type: str | None = None) -> str:
            self.calls += 1
            return NO_TECHNICAL_CONTENT_SENTINEL

    class _FakeRedis:
        def __init__(self) -> None:
            self._store: dict[str, bytes] = {}

        def get(self, key):
            return self._store.get(key)

        def set(self, key, value, ex=None):
            self._store[key] = value.encode("utf-8") if isinstance(value, str) else value

        def publish(self, channel, payload):
            pass

    fake_client = _FakeVisionClient()
    monkeypatch.setattr(main_module, "_vision_client", fake_client)
    monkeypatch.setattr(main_module, "_narration_redis", _FakeRedis())

    first = main_module._describe_figure(b"blank-figure-bytes")
    second = main_module._describe_figure(b"blank-figure-bytes")

    assert first == NO_TECHNICAL_CONTENT_SENTINEL
    assert second == NO_TECHNICAL_CONTENT_SENTINEL
    assert fake_client.calls == 1  # cache hit -- the sentinel WAS cached


def test_ingest_publishes_describe_figure_and_parse_done_narration_when_job_id_is_given(monkeypatch) -> None:
    # job_id is optional (absent for /jobs/preview's own call, which has no
    # job yet to narrate for) -- when a real job submission supplies it,
    # /ingest must publish real parse-stage progress on the same channel
    # /level's SURVEY narration already uses, instead of leaving the parse
    # stage a total black box for however long figure captioning takes.
    import app.main as main_module

    class _FakeVisionClient:
        def describe_figure(self, image_bytes: bytes, mime_type: str | None = None) -> str:
            return "a real caption"

    class _FakeRedis:
        def __init__(self) -> None:
            self.published: list[str] = []

        def set(self, key, value, ex=None):
            pass

        def rpush(self, key, value):
            pass

        def ltrim(self, key, start, end):
            pass

        def expire(self, key, seconds):
            pass

        def publish(self, channel, payload):
            self.published.append(payload)

    fake_redis = _FakeRedis()
    monkeypatch.setattr(main_module, "_vision_client", _FakeVisionClient())
    monkeypatch.setattr(main_module, "_narration_redis", fake_redis)

    _upload("sample.docx", FIXTURES / "sample.docx", mode="survey", job_id="job-narration-test")

    import json

    payloads = [json.loads(p) for p in fake_redis.published]
    phases = [p["phase"] for p in payloads]
    assert "describe_figure" in phases
    assert "parse_done" in phases

    # Two describe_figure events for this ONE figure -- an in-flight signal
    # (fired before the vision call, figureCaption null) and a real-result
    # signal (fired after, carrying the actual caption text). Without the
    # second, a figure-heavy document showed the same generic "figure N so
    # far" line for every figure with zero differentiating content
    # (confirmed live: 7 identical rows for 7 real figures).
    figure_events = [p for p in payloads if p["phase"] == "describe_figure"]
    assert len(figure_events) == 2
    assert figure_events[0]["figureIndex"] == 1
    assert figure_events[0]["figureCaption"] is None
    assert figure_events[1]["figureIndex"] == 1
    assert figure_events[1]["figureCaption"] == "a real caption"
    assert "a real caption" in figure_events[1]["message"]

    # Real gap this guards against (item 16): a .docx upload should now run
    # a cheap structural pre-count ahead of the real walk, so the in-flight
    # describe_figure event's message carries a real "figure 1 of 1"
    # denominator instead of the old open-ended "figure 1 so far" -- sample.docx
    # has exactly one figure, so index and total are both 1.
    assert figure_events[0]["figureCount"] == 1
    assert "figure 1 of 1" in figure_events[0]["message"]

    parse_done_event = next(p for p in payloads if p["phase"] == "parse_done")
    assert parse_done_event["tableCount"] == 1  # sample.docx has 1 table
    assert parse_done_event["figureCount"] == 1

    # Real bug this guards against (confirmed live): tableRowCount was
    # previously derived from rows_from_table (the ID-hierarchy-QUALIFYING
    # rows only, legitimately [] for a table whose content isn't ID-shaped)
    # instead of the table's own real raw row count -- every non-qualifying
    # table read as "0 row(s)", indistinguishable from a genuinely empty or
    # mis-parsed one. Ground truth comes from parsing the SAME fixture
    # directly, not a hardcoded number, so this stays correct if the fixture
    # ever changes.
    from app.dispatch import dispatch_by_extension

    real_doc = dispatch_by_extension("sample.docx", str(FIXTURES / "sample.docx"))
    table_events = [p for p in payloads if p["phase"] == "table_detected"]
    assert len(table_events) == 1
    assert table_events[0]["tableRowCount"] == len(real_doc.tables[0].rows)
    assert table_events[0]["tableRowCount"] > 0
    # table_detected doesn't need a pre-count -- it fires from a post-parse
    # loop over the full table list, so position/total are always known.
    assert table_events[0]["tableIndex"] == 1
    assert table_events[0]["tableCount"] == 1
    assert "table 1 of 1" in table_events[0]["message"]


def test_ingest_publishes_no_narration_when_job_id_is_omitted(monkeypatch) -> None:
    # /jobs/preview's own call never supplies job_id -- must not publish
    # anything (there is no job to attach the narration to).
    import app.main as main_module

    class _FakeVisionClient:
        def describe_figure(self, image_bytes: bytes, mime_type: str | None = None) -> str:
            return "a real caption"

    class _FakeRedis:
        def __init__(self) -> None:
            self.published: list[str] = []

        def set(self, key, value, ex=None):
            pass

        def rpush(self, key, value):
            pass

        def ltrim(self, key, start, end):
            pass

        def expire(self, key, seconds):
            pass

        def publish(self, channel, payload):
            self.published.append(payload)

    fake_redis = _FakeRedis()
    monkeypatch.setattr(main_module, "_vision_client", _FakeVisionClient())
    monkeypatch.setattr(main_module, "_narration_redis", fake_redis)

    _upload("sample.docx", FIXTURES / "sample.docx", mode="survey")

    assert fake_redis.published == []


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


def test_level_survey_reports_the_real_error_detail_not_a_bare_500() -> None:
    # Confirmed real UX gap (user-reported): a failed SURVEY job's audit
    # trail only ever showed "Ingestion /level request failed: 500" --
    # accurate but useless, since Starlette's default (no handler
    # registered) discards the real exception message into a generic
    # '{"detail": "Internal Server Error"}' body. The real message (e.g. a
    # malformed-JSON LLM response) must reach the response body so the
    # orchestrator's audit entry can show it.
    import app.main as main_module

    def _raise_value_error(*args: object, **kwargs: object) -> None:
        raise ValueError("malformed JSON in LLM response content: 'Based'")

    original = main_module._build_survey_tree_with_scoring
    main_module._build_survey_tree_with_scoring = _raise_value_error
    try:
        response = client.post(
            "/level",
            params={"mode": "survey"},
            json={"document": {"path": "x.txt", "format": "txt", "sha256": "h"}, "blocks": [], "tables": [], "figures": []},
        )
        # ValueError means "an upstream dependency (the LLM) misbehaved" --
        # 502 Bad Gateway, not a generic 500, and the real message survives.
        assert response.status_code == 502
        assert response.json()["detail"] == "malformed JSON in LLM response content: 'Based'"
    finally:
        main_module._build_survey_tree_with_scoring = original


def test_level_survey_reports_a_genuine_internal_error_as_500() -> None:
    import app.main as main_module

    def _raise_runtime_error(*args: object, **kwargs: object) -> None:
        raise RuntimeError("unexpected internal failure")

    original = main_module._build_survey_tree_with_scoring
    main_module._build_survey_tree_with_scoring = _raise_runtime_error
    # TestClient's default raise_server_exceptions=True re-raises ANY
    # unhandled-exception-shaped ASGI signal for debugging visibility, even
    # when a registered exception_handler already produced a real response
    # -- a real production ASGI server (uvicorn) has no such re-raise
    # behavior and would return the handler's response exactly like the
    # ValueError case above did. A dedicated client with this off is the
    # standard way to test a bare Exception handler through the full stack.
    lenient_client = TestClient(main_module.app, raise_server_exceptions=False)
    try:
        response = lenient_client.post(
            "/level",
            params={"mode": "survey"},
            json={"document": {"path": "x.txt", "format": "txt", "sha256": "h"}, "blocks": [], "tables": [], "figures": []},
        )
        assert response.status_code == 500
        assert response.json()["detail"] == "unexpected internal failure"
    finally:
        main_module._build_survey_tree_with_scoring = original


def test_build_survey_tree_with_scoring_passes_the_client_as_title_tag_client() -> None:
    # Confirmed real gap: main.py's /level call site never actually passed
    # a title_tag_client at all, so every deterministically-built node kept
    # its raw extract_baseline_title-derived title and empty tags in
    # production, even though the title/tag enhancement pass was fully
    # built and tested. OrchestratorLlmClient implements the TitleTagClient
    # protocol directly, so it's the SAME client already passed as
    # analysis_client/scoring_client/etc above.
    import app.main as main_module
    from app.canonical.model import CanonicalDoc, Document, DocumentFormat
    from app.leveling.tree_builder import WorkItemTree

    captured: dict[str, object] = {}

    def _capture(doc, **kwargs):
        captured.update(kwargs)
        return WorkItemTree(nodes=[], warnings=[], kb_citations=[], trace_links=[])

    original = main_module.build_survey_tree
    main_module.build_survey_tree = _capture
    try:
        fake_client = object()
        main_module._build_survey_tree_with_scoring(
            doc=CanonicalDoc(
                document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
                blocks=[], tables=[], figures=[],
            ),
            client=fake_client,
            customer_id=None,
            user_id=None,
            link_type_catalog=None,
            job_id=None,
        )
        assert captured["title_tag_client"] is fake_client
    finally:
        main_module.build_survey_tree = original


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
