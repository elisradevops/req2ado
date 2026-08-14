# ingestion/tests/test_vision_disabled_warning.py
# Task 4b sub-fix (i): a single TREE-level WarningKind.VISION_CAPTIONING_
# DISABLED warning (never one per figure) whenever CanonicalDoc.vision_active
# is False and the document has at least one figure -- emitted by /level's
# own _append_vision_disabled_warning. Gated to mode == "survey" only (final
# whole-branch review finding): BASELINE mode never activates vision by
# design (see main.py's own vision_active computation, which requires
# mode == "survey"), so doc.vision_active is unconditionally False for every
# BASELINE job with a figure -- an expected, permanent, non-actionable fact
# for that mode, not worth flagging on every single BASELINE run. Mirrors
# test_level_endpoint.py's own TestClient conventions.
import json

import httpx
from fastapi.testclient import TestClient

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, Figure, SourceRef
from app.main import app
from app.survey.orchestrator_llm_client import OrchestratorLlmClient

client = TestClient(app)

_ANALYZE_SECTION_MARKER = "analyzing one section"


def _sr(path: str) -> SourceRef:
    return SourceRef(document_path=path, start_offset=0, end_offset=10)


def _doc_with_a_figure(vision_active: bool) -> CanonicalDoc:
    path = "x.txt"
    return CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_sr(path)),
        ],
        figures=[Figure(id="f0", caption=None, source_ref=_sr(path))],
        vision_active=vision_active,
    )


def _vision_warnings(body: dict) -> list[dict]:
    return [w for w in body["warnings"] if w["kind"] == "vision_captioning_disabled"]


def _survey_handler(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    system_prompt = body["messages"][0]["content"]
    if _ANALYZE_SECTION_MARKER in system_prompt:
        nodes = [{"temp_id": "n0", "type": "Epic", "parent_temp_id": None, "text": "The system shall power on.", "tags": ["functional"]}]
        return httpx.Response(200, json={"content": json.dumps({"nodes": nodes})})
    return httpx.Response(200, json={"content": "{}"})


def _patch_orchestrator_client(monkeypatch) -> None:
    original_init = OrchestratorLlmClient.__init__

    def patched_init(self, base_url, bearer_token, model=None, num_ctx=None, top_k=None, min_p=None, cache=None):
        original_init(self, base_url, bearer_token, model=model)
        self._transport = httpx.MockTransport(_survey_handler)

    monkeypatch.setattr(OrchestratorLlmClient, "__init__", patched_init)
    monkeypatch.setattr("app.main.settings.llm_proxy_bearer", "test-bearer")


def test_baseline_never_emits_the_warning_even_with_vision_disabled_and_figures_present() -> None:
    # BASELINE never activates vision by design (mode != "survey") -- the
    # warning is gated off for this mode entirely, regardless of
    # vision_active/figures, since it would otherwise fire unconditionally on
    # every BASELINE job with a figure.
    doc = _doc_with_a_figure(vision_active=False)
    response = client.post("/level", json=doc.model_dump(mode="json"))
    assert response.status_code == 200
    assert _vision_warnings(response.json()) == []


def test_baseline_emits_no_warning_when_vision_active() -> None:
    doc = _doc_with_a_figure(vision_active=True)
    response = client.post("/level", json=doc.model_dump(mode="json"))
    assert response.status_code == 200
    assert _vision_warnings(response.json()) == []


def test_baseline_emits_no_warning_when_vision_disabled_but_no_figures_exist() -> None:
    path = "x.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr(path))],
        vision_active=False,
    )
    response = client.post("/level", json=doc.model_dump(mode="json"))
    assert response.status_code == 200
    assert _vision_warnings(response.json()) == []


def test_survey_mode_emits_one_warning_when_vision_disabled_and_figures_present(
    monkeypatch,
) -> None:
    # SURVEY jobs where vision was explicitly turned off still reflect a
    # real per-job configuration choice, so the warning still applies there.
    _patch_orchestrator_client(monkeypatch)
    doc = _doc_with_a_figure(vision_active=False)
    response = client.post("/level", params={"mode": "survey"}, json=doc.model_dump(mode="json"))
    assert response.status_code == 200
    warnings = _vision_warnings(response.json())
    assert len(warnings) == 1
    assert warnings[0]["severity"] == "needs_review"
    assert "1 figure(s)" in warnings[0]["raw"]
    # Tree-level, not per-figure: node_ids stays empty (this isn't attributed
    # to any specific node the way a per-figure signal would be).
    assert warnings[0]["node_ids"] == []


def test_survey_mode_emits_no_warning_when_vision_active(monkeypatch) -> None:
    _patch_orchestrator_client(monkeypatch)
    doc = _doc_with_a_figure(vision_active=True)
    response = client.post("/level", params={"mode": "survey"}, json=doc.model_dump(mode="json"))
    assert response.status_code == 200
    assert _vision_warnings(response.json()) == []


def test_survey_mode_warning_count_matches_figures_but_stays_one_warning_object(
    monkeypatch,
) -> None:
    # Multiple figures -- proves the warning fires ONCE per tree (with the
    # real count folded into its own `raw` text), never once per figure.
    _patch_orchestrator_client(monkeypatch)
    path = "x.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr(path))],
        figures=[
            Figure(id="f0", caption=None, source_ref=_sr(path)),
            Figure(id="f1", caption=None, source_ref=_sr(path)),
            Figure(id="f2", caption=None, source_ref=_sr(path)),
        ],
        vision_active=False,
    )
    response = client.post("/level", params={"mode": "survey"}, json=doc.model_dump(mode="json"))
    assert response.status_code == 200
    warnings = _vision_warnings(response.json())
    assert len(warnings) == 1
    assert "3 figure(s)" in warnings[0]["raw"]
