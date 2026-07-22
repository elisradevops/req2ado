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
            # A genuine depth-4 leaf, matching the golden mock_tv_remote.docx
            # reference -- without this, max_depth=3 alone is no longer
            # enough to signal tv_style (docs/architecture.md 1g's fix:
            # depth<=3 is now icd_style), so this fixture must actually reach
            # depth 4 to stay tv_style/Epic at depth 1, same as a real
            # TV-Receiver-style document would.
            Block(
                id="b3", kind=BlockKind.PARAGRAPH,
                text="1.1.1.1 The receiver shall scan all channels within 10 seconds.",
                source_ref=_sr("x.txt"),
            ),
        ],
    )
    response = client.post("/level", json=doc.model_dump(mode="json"))
    assert response.status_code == 200
    body = response.json()
    assert len(body["nodes"]) == 4
    assert body["nodes"][0]["type"] == "Epic"
    assert body["nodes"][1]["type"] == "Epic"
    assert body["nodes"][2]["type"] == "Feature"
    assert body["nodes"][3]["type"] == "Requirement"


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
            # A genuine depth-4 leaf, matching the golden mock_tv_remote.docx
            # reference -- without this, max_depth=3 alone is no longer
            # enough to signal tv_style (docs/architecture.md 1g's fix:
            # depth<=3 is now icd_style), so this fixture must actually reach
            # depth 4 to stay tv_style/Epic at depth 1, same as a real
            # TV-Receiver-style document would.
            Block(
                id="b3", kind=BlockKind.PARAGRAPH,
                text="1.1.1.1 The receiver shall scan all channels within 10 seconds.",
                source_ref=_sr("x.txt"),
            ),
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

    def patched_init(self, base_url, bearer_token, model=None):
        original_init(self, base_url, bearer_token, model=model)
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


def test_level_endpoint_survey_mode_with_area_path_injects_kb_context(monkeypatch) -> None:
    captured_system_prompts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        system_prompt = json.loads(request.content)["messages"][0]["content"]
        captured_system_prompts.append(system_prompt)
        if "hierarchy" in system_prompt:
            return httpx.Response(200, json={"content": json.dumps([{"node_id": "0", "type": "Epic", "parent_id": None}])})
        return httpx.Response(
            200,
            json={"content": json.dumps({"0": [{"text": "The system shall power on.", "tags": ["functional"]}]})},
        )

    original_init = OrchestratorLlmClient.__init__

    def patched_init(self, base_url, bearer_token, model=None):
        original_init(self, base_url, bearer_token, model=model)
        self._transport = httpx.MockTransport(handler)

    monkeypatch.setattr(OrchestratorLlmClient, "__init__", patched_init)
    monkeypatch.setattr("app.main.settings.llm_proxy_bearer", "test-bearer")
    # retrieve_context is called from app.leveling.llm_leveling (build_survey_tree's
    # module), not from app.main — main.py only forwards area_path/embed_client/
    # vector_store through, it never calls retrieve_context itself.
    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda area_path, query_text, embed_client, vector_store, **_: (
            "Injected KB reference text.",
            [{"source_file": "ref-doc.docx", "distance": 0.1, "similarity": 0.9, "text": "Injected KB reference text."}],
        ),
    )
    # judge_kb_relevance is wired for real (area_path is set) and routes
    # through the same MockTransport handler -- it doesn't match "hierarchy"
    # so falls into the generate_requirements_for_document-shaped branch,
    # whose response ({"0": [...]}) _parse_json_object accepts fine even
    # though judge_kb_relevance doesn't actually consume its shape here.
    # Not asserted on in this test; kb_citations relevance-field coverage
    # lives in test_llm_leveling.py.

    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr("x.txt"))],
    )
    response = client.post(
        "/level", params={"mode": "survey", "area_path": "Project\\Area1"}, json=doc.model_dump(mode="json")
    )
    assert response.status_code == 200
    # judge_kb_relevance's own system prompt doesn't carry kb_context (it's
    # the thing being verified, not something to ground itself in) -- only
    # the hierarchy/generation/scoring prompts must include it.
    grounded_prompts = [p for p in captured_system_prompts if "knowledge-base snippets" not in p]
    assert grounded_prompts and all("Injected KB reference text." in prompt for prompt in grounded_prompts)
    assert response.json()["kb_citations"] == [
        {"source_file": "ref-doc.docx", "similarity": 0.9, "relevance": "unknown"}
    ]


def test_level_endpoint_survey_mode_without_area_path_skips_kb_retrieval(monkeypatch) -> None:
    # Regression guard: omitting area_path (every pre-existing caller) must
    # never even attempt retrieval.
    def _fail_retrieve(*args, **kwargs):  # pragma: no cover - should never run
        raise AssertionError("retrieve_context must not be called when area_path is omitted")

    monkeypatch.setattr("app.leveling.llm_leveling.retrieve_context", _fail_retrieve)

    hierarchy = [{"node_id": "0", "type": "Epic", "parent_id": None}]
    requirements_by_node = {"0": [{"text": "The system shall power on.", "tags": ["functional"]}]}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        system_prompt = body["messages"][0]["content"]
        if "hierarchy" in system_prompt:
            return httpx.Response(200, json={"content": json.dumps(hierarchy)})
        return httpx.Response(200, json={"content": json.dumps(requirements_by_node)})

    original_init = OrchestratorLlmClient.__init__

    def patched_init(self, base_url, bearer_token, model=None):
        original_init(self, base_url, bearer_token, model=model)
        self._transport = httpx.MockTransport(handler)

    monkeypatch.setattr(OrchestratorLlmClient, "__init__", patched_init)
    monkeypatch.setattr("app.main.settings.llm_proxy_bearer", "test-bearer")

    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr("x.txt"))],
    )
    response = client.post("/level", params={"mode": "survey"}, json=doc.model_dump(mode="json"))
    assert response.status_code == 200


def test_level_endpoint_survey_mode_passes_link_type_catalog_through(monkeypatch) -> None:
    # Mirrors test_level_endpoint_survey_mode_without_area_path_skips_kb_retrieval's
    # exact mocking mechanics for infer_hierarchy/generate_requirements_for_document
    # (MockTransport-backed OrchestratorLlmClient) — infer_trace_links is
    # monkeypatched directly instead, since this test only needs to prove the
    # catalog reaches it unchanged, not exercise its own HTTP prompt contract.
    catalog = [{"reference_name": "System.LinkTypes.Related", "name": "Related"}]
    captured: dict[str, list[dict]] = {}

    def fake_infer_trace_links(self, nodes, link_type_catalog, kb_context=None):
        captured["link_type_catalog"] = link_type_catalog
        return []

    monkeypatch.setattr(
        "app.survey.orchestrator_llm_client.OrchestratorLlmClient.infer_trace_links",
        fake_infer_trace_links,
    )

    hierarchy = [{"node_id": "0", "type": "Epic", "parent_id": None}]
    requirements_by_node = {"0": [{"text": "The system shall power on.", "tags": ["functional"]}]}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        system_prompt = body["messages"][0]["content"]
        if "hierarchy" in system_prompt:
            return httpx.Response(200, json={"content": json.dumps(hierarchy)})
        return httpx.Response(200, json={"content": json.dumps(requirements_by_node)})

    original_init = OrchestratorLlmClient.__init__

    def patched_init(self, base_url, bearer_token, model=None):
        original_init(self, base_url, bearer_token, model=model)
        self._transport = httpx.MockTransport(handler)

    monkeypatch.setattr(OrchestratorLlmClient, "__init__", patched_init)
    monkeypatch.setattr("app.main.settings.llm_proxy_bearer", "test-bearer")

    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr("x.txt"))],
    )
    response = client.post(
        "/level",
        params={"mode": "survey", "link_type_catalog": json.dumps(catalog)},
        json=doc.model_dump(mode="json"),
    )

    assert response.status_code == 200
    assert captured["link_type_catalog"] == catalog


def test_level_endpoint_survey_mode_empty_link_type_catalog_skips_trace_link_inference(monkeypatch) -> None:
    # Regression test: link_type_catalog="[]" decodes to an empty list, which is
    # falsy but `is not None`. The /level route must treat an empty catalog the
    # same as no catalog at all (no link_type_client wired in), so
    # infer_trace_links is never called — mirrors
    # test_level_endpoint_survey_mode_passes_link_type_catalog_through's mocking
    # mechanics, but with an empty catalog and an assertion that the monkeypatch
    # was never invoked.
    captured: dict[str, list[dict]] = {}

    def fake_infer_trace_links(self, nodes, link_type_catalog, kb_context=None):
        captured["link_type_catalog"] = link_type_catalog
        return []

    monkeypatch.setattr(
        "app.survey.orchestrator_llm_client.OrchestratorLlmClient.infer_trace_links",
        fake_infer_trace_links,
    )

    hierarchy = [{"node_id": "0", "type": "Epic", "parent_id": None}]
    requirements_by_node = {"0": [{"text": "The system shall power on.", "tags": ["functional"]}]}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        system_prompt = body["messages"][0]["content"]
        if "hierarchy" in system_prompt:
            return httpx.Response(200, json={"content": json.dumps(hierarchy)})
        return httpx.Response(200, json={"content": json.dumps(requirements_by_node)})

    original_init = OrchestratorLlmClient.__init__

    def patched_init(self, base_url, bearer_token, model=None):
        original_init(self, base_url, bearer_token, model=model)
        self._transport = httpx.MockTransport(handler)

    monkeypatch.setattr(OrchestratorLlmClient, "__init__", patched_init)
    monkeypatch.setattr("app.main.settings.llm_proxy_bearer", "test-bearer")

    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr("x.txt"))],
    )
    response = client.post(
        "/level",
        params={"mode": "survey", "link_type_catalog": "[]"},
        json=doc.model_dump(mode="json"),
    )

    assert response.status_code == 200
    assert captured == {}


def test_level_endpoint_survey_mode_populates_quality_score_from_a_real_scoring_call(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        system_prompt = json.loads(request.content)["messages"][0]["content"]
        if "hierarchy" in system_prompt:
            return httpx.Response(200, json={"content": json.dumps([{"node_id": "0", "type": "Epic", "parent_id": None}])})
        if "score" in system_prompt.lower() and "EARS" in system_prompt:
            return httpx.Response(200, json={"content": json.dumps({"0": {"score": 72, "issues": ["vague_term"]}})})
        return httpx.Response(
            200,
            json={"content": json.dumps({"0": [{"text": "The system shall power on.", "tags": ["functional"]}]})},
        )

    original_init = OrchestratorLlmClient.__init__

    def patched_init(self, base_url, bearer_token, model=None):
        original_init(self, base_url, bearer_token, model=model)
        self._transport = httpx.MockTransport(handler)

    monkeypatch.setattr(OrchestratorLlmClient, "__init__", patched_init)
    monkeypatch.setattr("app.main.settings.llm_proxy_bearer", "test-bearer")

    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr("x.txt"))],
    )
    response = client.post("/level", params={"mode": "survey"}, json=doc.model_dump(mode="json"))
    assert response.status_code == 200
    body = response.json()
    assert body["nodes"][0]["quality_score"] == 72
    assert body["nodes"][0]["quality_issues"] == ["vague_term"]


def test_level_endpoint_survey_mode_without_area_path_has_empty_kb_citations(monkeypatch) -> None:
    hierarchy = [{"node_id": "0", "type": "Epic", "parent_id": None}]
    requirements_by_node = {"0": [{"text": "The system shall power on.", "tags": ["functional"]}]}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        system_prompt = body["messages"][0]["content"]
        if "hierarchy" in system_prompt:
            return httpx.Response(200, json={"content": json.dumps(hierarchy)})
        return httpx.Response(200, json={"content": json.dumps(requirements_by_node)})

    original_init = OrchestratorLlmClient.__init__

    def patched_init(self, base_url, bearer_token, model=None):
        original_init(self, base_url, bearer_token, model=model)
        self._transport = httpx.MockTransport(handler)

    monkeypatch.setattr(OrchestratorLlmClient, "__init__", patched_init)
    monkeypatch.setattr("app.main.settings.llm_proxy_bearer", "test-bearer")

    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr("x.txt"))],
    )
    response = client.post("/level", params={"mode": "survey"}, json=doc.model_dump(mode="json"))
    assert response.status_code == 200
    assert response.json()["kb_citations"] == []


def test_level_endpoint_baseline_mode_has_empty_kb_citations() -> None:
    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr("x.txt"))],
    )
    response = client.post("/level", json=doc.model_dump(mode="json"))
    assert response.status_code == 200
    assert response.json()["kb_citations"] == []
