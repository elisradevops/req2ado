import json

import httpx
from fastapi.testclient import TestClient

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.main import app
from app.survey.orchestrator_llm_client import OrchestratorLlmClient

client = TestClient(app)

# Substring unique to _SECTION_ANALYSIS_SYSTEM_PROMPT (the one-call holistic
# analyze_section/analyze_section_agentic call, replacing the old
# infer_hierarchy/generate_requirements_for_document two-call pair) -- used
# by every survey-mode MockTransport handler below to route the ONE real
# analysis call to a real nodes-shaped response, while any other call this
# job makes (quality scoring, kb relevance verification) falls through to a
# harmless empty-object default unless a test specifically needs to assert
# on it (see test_level_endpoint_survey_mode_populates_quality_score_from_a_real_scoring_call).
_ANALYZE_SECTION_MARKER = "analyzing one section"

# Substring unique to the author_content prompt -- SURVEY generation runs as
# TWO calls per branch now (STAGE 1 structure, STAGE 3 content), so every
# survey-mode handler below has to answer both or its nodes come back with
# their own titles standing in for missing descriptions.
_AUTHOR_CONTENT_MARKER = "authoring the requirement text"


def _authored_content(nodes: list[dict], request: httpx.Request) -> httpx.Response:
    """Answers a STAGE 3 author_content call from the same node fixture the
    STAGE 1 handler served. The caller keys each node by its local_id, which
    for these single-branch fixtures is exactly the temp_id STAGE 1
    returned (no "br{N}_" namespacing -- see build_survey_tree's
    node_id_prefix)."""
    requested = json.loads(json.loads(request.content)["messages"][1]["content"])["nodes"]
    by_temp_id = {node["temp_id"]: node for node in nodes}
    return httpx.Response(200, json={"content": json.dumps({
        local_id: {"description": by_temp_id[local_id]["text"], "tags": by_temp_id[local_id].get("tags", [])}
        for local_id in requested
        if local_id in by_temp_id
    })})


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
    nodes = [
        {
            "temp_id": "n0", "type": "Epic", "parent_temp_id": None, "title": "Power on",
            "text": "The system shall power on within 5 seconds.", "tags": ["functional"],
        }
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-bearer"
        body = json.loads(request.content)
        system_prompt = body["messages"][0]["content"]
        if _ANALYZE_SECTION_MARKER in system_prompt:
            return httpx.Response(200, json={"content": json.dumps({"nodes": nodes})})
        if _AUTHOR_CONTENT_MARKER in system_prompt:
            return _authored_content(nodes, request)
        return httpx.Response(200, json={"content": "{}"})  # scoring call -- degrades harmlessly, not asserted here

    original_init = OrchestratorLlmClient.__init__

    def patched_init(self, base_url, bearer_token, model=None, num_ctx=None, top_k=None, min_p=None, cache=None):
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
        nodes = [{"temp_id": "n0", "type": "Epic", "parent_temp_id": None, "title": "Power on", "text": "The system shall power on.", "tags": ["functional"]}]
        if _ANALYZE_SECTION_MARKER in system_prompt:
            return httpx.Response(200, json={"content": json.dumps({"nodes": nodes})})
        if _AUTHOR_CONTENT_MARKER in system_prompt:
            return _authored_content(nodes, request)
        return httpx.Response(200, json={"content": "{}"})

    original_init = OrchestratorLlmClient.__init__

    def patched_init(self, base_url, bearer_token, model=None, num_ctx=None, top_k=None, min_p=None, cache=None):
        original_init(self, base_url, bearer_token, model=model)
        self._transport = httpx.MockTransport(handler)

    monkeypatch.setattr(OrchestratorLlmClient, "__init__", patched_init)
    monkeypatch.setattr("app.main.settings.llm_proxy_bearer", "test-bearer")
    # retrieve_context is called from app.leveling.llm_leveling (build_survey_tree's
    # module), not from app.main — main.py only forwards user_id/embed_client/
    # vector_store through, it never calls retrieve_context itself. With the
    # default model (no tool-calling support), build_survey_tree computes this
    # ONCE for the whole document (§5c's fallback path) and threads the same
    # kb_context into analyze_section + scoring.
    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda user_id, query_text, embed_client, vector_store, **_: (
            "Injected KB reference text.",
            [{"source_file": "ref-doc.docx", "distance": 0.1, "similarity": 0.9, "text": "Injected KB reference text."}],
        ),
    )
    # judge_kb_relevance is wired for real (user_id is set) and routes
    # through the same MockTransport handler -- its own system prompt
    # doesn't carry kb_context (it's the thing being verified, not something
    # to ground itself in), so it's excluded from the assertion below via
    # its "knowledge-base snippets" phrase. score_epics_and_features_for_
    # document (fires here too -- the fixture's one node is type Epic) is a
    # separate, deliberately un-grounded rubric (structural scope-coherence/
    # decomposability judgments, not content-standard criteria) -- excluded
    # via its own distinguishing phrase.

    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr("x.txt"))],
    )
    response = client.post(
        "/level", params={"mode": "survey", "user_id": "Project\\Area1"}, json=doc.model_dump(mode="json")
    )
    assert response.status_code == 200
    grounded_prompts = [
        p
        for p in captured_system_prompts
        if "knowledge-base snippets" not in p and "Epic and Feature work items" not in p
    ]
    assert grounded_prompts and all("Injected KB reference text." in prompt for prompt in grounded_prompts)
    assert response.json()["kb_citations"] == [
        {"source_file": "ref-doc.docx", "similarity": 0.9, "relevance": "unknown"}
    ]


def test_level_endpoint_survey_mode_without_area_path_skips_kb_retrieval(monkeypatch) -> None:
    # Regression guard: omitting user_id (every pre-existing caller) must
    # never even attempt retrieval.
    def _fail_retrieve(*args, **kwargs):  # pragma: no cover - should never run
        raise AssertionError("retrieve_context must not be called when user_id is omitted")

    monkeypatch.setattr("app.leveling.llm_leveling.retrieve_context", _fail_retrieve)

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        system_prompt = body["messages"][0]["content"]
        nodes = [{"temp_id": "n0", "type": "Epic", "parent_temp_id": None, "title": "Power on", "text": "The system shall power on.", "tags": ["functional"]}]
        if _ANALYZE_SECTION_MARKER in system_prompt:
            return httpx.Response(200, json={"content": json.dumps({"nodes": nodes})})
        if _AUTHOR_CONTENT_MARKER in system_prompt:
            return _authored_content(nodes, request)
        return httpx.Response(200, json={"content": "{}"})

    original_init = OrchestratorLlmClient.__init__

    def patched_init(self, base_url, bearer_token, model=None, num_ctx=None, top_k=None, min_p=None, cache=None):
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
    # exact mocking mechanics for analyze_section (MockTransport-backed
    # OrchestratorLlmClient) — infer_trace_links is monkeypatched directly
    # instead, since this test only needs to prove the catalog reaches it
    # unchanged, not exercise its own HTTP prompt contract.
    catalog = [{"reference_name": "System.LinkTypes.Related", "name": "Related"}]
    captured: dict[str, list[dict]] = {}

    def fake_infer_trace_links(self, nodes, link_type_catalog, kb_context=None):
        captured["link_type_catalog"] = link_type_catalog
        return []

    monkeypatch.setattr(
        "app.survey.orchestrator_llm_client.OrchestratorLlmClient.infer_trace_links",
        fake_infer_trace_links,
    )

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        system_prompt = body["messages"][0]["content"]
        nodes = [{"temp_id": "n0", "type": "Epic", "parent_temp_id": None, "title": "Power on", "text": "The system shall power on.", "tags": ["functional"]}]
        if _ANALYZE_SECTION_MARKER in system_prompt:
            return httpx.Response(200, json={"content": json.dumps({"nodes": nodes})})
        if _AUTHOR_CONTENT_MARKER in system_prompt:
            return _authored_content(nodes, request)
        return httpx.Response(200, json={"content": "{}"})

    original_init = OrchestratorLlmClient.__init__

    def patched_init(self, base_url, bearer_token, model=None, num_ctx=None, top_k=None, min_p=None, cache=None):
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

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        system_prompt = body["messages"][0]["content"]
        nodes = [{"temp_id": "n0", "type": "Epic", "parent_temp_id": None, "title": "Power on", "text": "The system shall power on.", "tags": ["functional"]}]
        if _ANALYZE_SECTION_MARKER in system_prompt:
            return httpx.Response(200, json={"content": json.dumps({"nodes": nodes})})
        if _AUTHOR_CONTENT_MARKER in system_prompt:
            return _authored_content(nodes, request)
        return httpx.Response(200, json={"content": "{}"})

    original_init = OrchestratorLlmClient.__init__

    def patched_init(self, base_url, bearer_token, model=None, num_ctx=None, top_k=None, min_p=None, cache=None):
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
        # Requirement, not Epic -- quality scoring is scoped to
        # Requirement-type nodes only (EARS/INCOSE/ISO criteria describe
        # atomic testable statements, not Epic/Feature groupings), so an
        # Epic node here would never reach the scoring call this test
        # means to exercise.
        nodes = [{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "title": "Power on", "text": "The system shall power on.", "tags": ["functional"]}]
        if _ANALYZE_SECTION_MARKER in system_prompt:
            return httpx.Response(200, json={"content": json.dumps({"nodes": nodes})})
        if _AUTHOR_CONTENT_MARKER in system_prompt:
            return _authored_content(nodes, request)
        if "score" in system_prompt.lower() and "EARS" in system_prompt:
            return httpx.Response(200, json={"content": json.dumps({"n0": {"score": 72, "issues": ["vague_term"]}})})
        return httpx.Response(200, json={"content": "{}"})

    original_init = OrchestratorLlmClient.__init__

    def patched_init(self, base_url, bearer_token, model=None, num_ctx=None, top_k=None, min_p=None, cache=None):
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
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        system_prompt = body["messages"][0]["content"]
        nodes = [{"temp_id": "n0", "type": "Epic", "parent_temp_id": None, "title": "Power on", "text": "The system shall power on.", "tags": ["functional"]}]
        if _ANALYZE_SECTION_MARKER in system_prompt:
            return httpx.Response(200, json={"content": json.dumps({"nodes": nodes})})
        if _AUTHOR_CONTENT_MARKER in system_prompt:
            return _authored_content(nodes, request)
        return httpx.Response(200, json={"content": "{}"})

    original_init = OrchestratorLlmClient.__init__

    def patched_init(self, base_url, bearer_token, model=None, num_ctx=None, top_k=None, min_p=None, cache=None):
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


def test_exception_handlers_log_the_query_string_not_just_the_path(monkeypatch, caplog) -> None:
    """Regression guard: the global exception handlers used to log
    request.url.path, which silently drops job_id (a query param on
    /level) from the traceback line -- the one piece of context needed to
    correlate a 502/500 with a specific job. Asserted directly against the
    handler functions (not a real request through a mocked failure) since
    that's a simpler, equally faithful way to prove the log line now
    includes the query string."""
    import asyncio

    from starlette.requests import Request

    from app.main import _unhandled_exception_handler, _value_error_handler

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/level",
        "query_string": b"job_id=abc-123",
        "headers": [],
    }
    request = Request(scope)

    with caplog.at_level("ERROR"):
        asyncio.run(_value_error_handler(request, ValueError("bad upstream response")))
    assert "job_id=abc-123" in caplog.text

    caplog.clear()
    with caplog.at_level("ERROR"):
        asyncio.run(_unhandled_exception_handler(request, RuntimeError("boom")))
    assert "job_id=abc-123" in caplog.text


def test_logging_config_formats_job_id_with_a_default_when_absent(caplog) -> None:
    """Regression guard for the logging.basicConfig + _DefaultJobIdFilter
    setup in app.main -- a logger.warning call with no job_id `extra` must
    still format cleanly (job_id="-"), proving the format string's
    %(job_id)s reference doesn't crash ordinary, non-job-scoped log calls."""
    import logging

    logger = logging.getLogger("app.leveling.llm_leveling")
    with caplog.at_level("WARNING"):
        logger.warning("a warning with no job_id context")
    assert caplog.records[-1].job_id == "-"
