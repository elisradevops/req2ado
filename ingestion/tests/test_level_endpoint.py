import json

import httpx
from fastapi.testclient import TestClient

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.main import app
from app.survey.orchestrator_llm_client import OrchestratorLlmClient

client = TestClient(app)


def _sr(path: str) -> SourceRef:
    return SourceRef(document_path=path, start_offset=0, end_offset=10)


def test_level_endpoint_returns_worktree_json() -> None:
    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr("x.txt")),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="1.1 Broadcast & Inputs", source_ref=_sr("x.txt")),
            Block(id="b2", kind=BlockKind.PARAGRAPH, text="1.1.1 Channel Scan", source_ref=_sr("x.txt")),
        ],
    )
    response = client.post("/level", json=doc.model_dump(mode="json"))
    assert response.status_code == 200
    body = response.json()
    assert len(body["nodes"]) == 3
    assert body["nodes"][0]["type"] == "Epic"
    assert body["nodes"][1]["type"] == "Epic"
    assert body["nodes"][2]["type"] == "Feature"


def test_level_endpoint_accepts_and_stamps_customer_id() -> None:
    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr("x.txt")),
        ],
    )
    response = client.post("/level", params={"customer_id": "CUST-042"}, json=doc.model_dump(mode="json"))
    assert response.status_code == 200
    body = response.json()
    assert body["nodes"][0]["customer_id"] == "CUST-042"


def test_level_endpoint_default_mode_still_uses_baseline_tree(monkeypatch) -> None:
    # Regression guard: with the mode branch added, no-mode/mode=baseline must
    # remain completely unaffected — never construct an OrchestratorLlmClient,
    # never touch the network.
    def _fail_init(self, base_url, bearer_token):  # pragma: no cover - should never run
        raise AssertionError("OrchestratorLlmClient must not be constructed in baseline mode")

    monkeypatch.setattr(OrchestratorLlmClient, "__init__", _fail_init)

    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr("x.txt")),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="1.1 Broadcast & Inputs", source_ref=_sr("x.txt")),
            Block(id="b2", kind=BlockKind.PARAGRAPH, text="1.1.1 Channel Scan", source_ref=_sr("x.txt")),
        ],
    )
    response = client.post("/level", params={"mode": "baseline"}, json=doc.model_dump(mode="json"))
    assert response.status_code == 200
    body = response.json()
    assert body["nodes"][0]["type"] == "Epic"
    assert body["nodes"][0]["mode"] == "BASELINE"


def test_level_endpoint_mode_survey_routes_to_build_survey_tree(monkeypatch) -> None:
    hierarchy = [{"node_id": "0", "type": "Epic", "parent_id": None}]
    requirements_by_node = {
        "0": [{"text": "The system shall power on within 5 seconds.", "tags": ["functional"]}]
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-bearer"
        body = json.loads(request.content)
        system_prompt = body["messages"][0]["content"]
        if "hierarchy" in system_prompt:
            return httpx.Response(200, json={"content": json.dumps(hierarchy)})
        return httpx.Response(200, json={"content": json.dumps(requirements_by_node)})

    original_init = OrchestratorLlmClient.__init__

    def patched_init(self, base_url, bearer_token):
        original_init(self, base_url, bearer_token)
        self._transport = httpx.MockTransport(handler)

    monkeypatch.setattr(OrchestratorLlmClient, "__init__", patched_init)
    monkeypatch.setattr("app.main.settings.llm_proxy_bearer", "test-bearer")

    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr("x.txt")),
        ],
    )
    response = client.post("/level", params={"mode": "survey"}, json=doc.model_dump(mode="json"))
    assert response.status_code == 200
    body = response.json()
    assert len(body["nodes"]) == 1
    assert body["nodes"][0]["mode"] == "SURVEY"
    assert "shall" in body["nodes"][0]["description"]
