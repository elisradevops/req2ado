# P2c RAG-Grounded Quality Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every SURVEY-mode requirement a 0-100 quality score and a closed set of flagged issue labels, judged against org-specific rules retrieved from the KB (reusing P2b's per-document `kb_context`) when available, falling back to EARS/INCOSE/ISO-29148 criteria baked into the prompt when it isn't.

**Architecture:** A third batched whole-document LLM call, `score_requirements_for_document`, runs inside `build_survey_tree` after the existing formalization loop produces final node descriptions. It reuses the same `kb_context` string already computed once per document — zero new retrieval calls, one new LLM round-trip. Score/issues flow: `WorkItemNode` (ingestion) → `DryRunTreeNode`/`DryRunDiffEntry` (orchestrator) → `NodeDetailPanel` + new `IssueChips` (frontend, detail-panel-only).

**Tech Stack:** Python/FastAPI/pydantic (ingestion), TypeScript/NestJS (orchestrator), React/MUI/Vitest (frontend).

## Global Constraints

- `scoring_client` is an OPTIONAL parameter on `build_survey_tree`, defaulting to `None` — fully additive, matching P2b's precedent. When `None` (every pre-existing test call site), scoring is skipped entirely: every node's `quality_score` stays `None`, `quality_issues` stays `[]`.
- Scoring reuses the SAME `kb_context` string already computed by `retrieve_context` for the other two LLM calls — no new retrieval, no doc_type filtering.
- One batched call per document (all nodes at once), not one call per node.
- Per-node tolerant parsing: a missing/malformed `score` (non-int, out of 0-100) or malformed `issues` (non-list, or containing values outside `RequirementQualityIssue`) for one node never crashes the job or affects sibling nodes — falls back to `quality_score=None`/`quality_issues=[]` for that node only. A raw per-node entry that isn't even a dict (e.g. a list) is treated the same as a missing entry — `{}`.
- A totally malformed top-level JSON response (unparseable) raises `ValueError`, matching `generate_requirements_for_document`'s existing precedent.
- `RequirementQualityIssue` values (exact 7, all lowercase snake_case): `ambiguous`, `not_testable`, `compound`, `missing_acceptance_criteria`, `vague_term`, `passive_voice`, `missing_rationale`.
- Orchestrator TS: push `qualityScore`/`qualityIssues` as raw passthrough (`node.qualityScore`, `node.qualityIssues`), never coerced via `?? null`/`?? []` — this keeps the value `undefined` (not `null`) when a test's tree-node object omits the field, which Jest's `toEqual`/`toHaveBeenCalledWith` treat as equal to an absent key. This is what keeps every pre-existing orchestrator test passing unmodified.
- `ingestion/tests` run via `.venv/bin/python -m pytest` (not bare `pytest`). Orchestrator tests via `npm test` in `orchestrator/`. Frontend tests via `npm test` in `frontend/` (Vitest).

---

### Task 1: `RequirementQualityIssue` enum + `WorkItemNode` fields

**Files:**
- Modify: `ingestion/app/workitem/model.py`
- Modify: `ingestion/tests/test_workitem_model.py`

**Interfaces:**
- Produces: `RequirementQualityIssue(str, Enum)` with the 7 values listed in Global Constraints. `WorkItemNode` gains `quality_score: int | None = None` and `quality_issues: list[RequirementQualityIssue] = Field(default_factory=list)`.

- [ ] **Step 1: Write the failing tests**

Add to `ingestion/tests/test_workitem_model.py` (append after `test_work_item_node_accepts_tags`):

```python
def test_work_item_node_defaults_quality_fields_to_none_and_empty() -> None:
    node = WorkItemNode(
        local_id="n0",
        type=WorkItemType.EPIC,
        parent_local_id=None,
        title="Receiver",
        description="1 Receiver",
        source_ref=_source_ref(),
        mode=WorkItemMode.BASELINE,
    )
    assert node.quality_score is None
    assert node.quality_issues == []


def test_work_item_node_accepts_quality_score_and_issues() -> None:
    node = WorkItemNode(
        local_id="n1",
        type=WorkItemType.REQUIREMENT,
        parent_local_id="n0",
        title="Shall support Hebrew",
        description="The system shall support Hebrew input.",
        source_ref=_source_ref(),
        mode=WorkItemMode.SURVEY,
        quality_score=85,
        quality_issues=[RequirementQualityIssue.VAGUE_TERM],
    )
    assert node.quality_score == 85
    assert node.quality_issues == [RequirementQualityIssue.VAGUE_TERM]
```

Update the import line at the top of the file:

```python
from app.workitem.model import RequirementQualityIssue, RequirementTag, WorkItemMode, WorkItemNode, WorkItemTree, WorkItemType
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_workitem_model.py -v -k quality`
Expected: FAIL with `ImportError: cannot import name 'RequirementQualityIssue'`

- [ ] **Step 3: Implement**

In `ingestion/app/workitem/model.py`, add the new enum after `RequirementTag` (before `class WorkItemNode`):

```python
class RequirementQualityIssue(str, Enum):
    AMBIGUOUS = "ambiguous"
    NOT_TESTABLE = "not_testable"
    COMPOUND = "compound"
    MISSING_ACCEPTANCE_CRITERIA = "missing_acceptance_criteria"
    VAGUE_TERM = "vague_term"
    PASSIVE_VOICE = "passive_voice"
    MISSING_RATIONALE = "missing_rationale"
```

Add two fields to `WorkItemNode`, after `tags: list[RequirementTag] = Field(default_factory=list)`:

```python
    quality_score: int | None = None
    quality_issues: list[RequirementQualityIssue] = Field(default_factory=list)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_workitem_model.py -v`
Expected: PASS (all tests in the file, including pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/workitem/model.py ingestion/tests/test_workitem_model.py
git commit -m "feat(workitem): add RequirementQualityIssue enum and quality fields to WorkItemNode"
```

---

### Task 2: `OrchestratorLlmClient.score_requirements_for_document`

**Files:**
- Modify: `ingestion/app/survey/orchestrator_llm_client.py`
- Modify: `ingestion/tests/test_orchestrator_llm_client.py`

**Interfaces:**
- Produces: `OrchestratorLlmClient.score_requirements_for_document(self, descriptions_by_node_id: dict[str, str], kb_context: str | None = None) -> dict[str, dict]`. Response shape per node_id: `{"score": int, "issues": list[str]}`.

- [ ] **Step 1: Write the failing tests**

Add to `ingestion/tests/test_orchestrator_llm_client.py`:

```python
def test_score_requirements_for_document_parses_valid_json_response() -> None:
    response_json = {
        "content": json.dumps({"0": {"score": 85, "issues": ["vague_term"]}})
    }
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(response_json)

    result = client.score_requirements_for_document({"0": "The system shall be fast."})
    assert result == {"0": {"score": 85, "issues": ["vague_term"]}}


def test_score_requirements_for_document_sends_temperature_zero() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        captured["temperature"] = body["temperature"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"0": "text"})
    assert captured["temperature"] == 0


def test_score_requirements_for_document_raises_on_malformed_json_content() -> None:
    response_json = {"content": "not valid json"}
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(response_json)

    with pytest.raises(ValueError, match="malformed"):
        client.score_requirements_for_document({"0": "text"})


def test_score_requirements_for_document_prepends_kb_context_when_present() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["system_prompt"] = json.loads(request.content)["messages"][0]["content"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"0": "text"}, kb_context="Org rule: always specify units.")
    assert captured["system_prompt"].startswith(
        "Reference material from the knowledge base (may be incomplete or "
        "irrelevant — use only what's genuinely helpful):\n\n"
        "Org rule: always specify units.\n\n"
    )
    assert "EARS" in captured["system_prompt"] or "INCOSE" in captured["system_prompt"]


def test_score_requirements_for_document_prompt_unchanged_when_kb_context_is_none() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["system_prompt"] = json.loads(request.content)["messages"][0]["content"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"0": "text"})
    assert "Reference material from the knowledge base" not in captured["system_prompt"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_orchestrator_llm_client.py -v -k score_requirements`
Expected: FAIL with `AttributeError: 'OrchestratorLlmClient' object has no attribute 'score_requirements_for_document'`

- [ ] **Step 3: Implement**

Add to `ingestion/app/survey/orchestrator_llm_client.py`, as a new method on `OrchestratorLlmClient` (after `generate_requirements_for_document`):

```python
    def score_requirements_for_document(
        self, descriptions_by_node_id: dict[str, str], kb_context: str | None = None
    ) -> dict[str, dict]:
        """Batched whole-document quality scoring: one call scoring every
        node's FINAL formalized description, matching the same
        one-call-per-document rationale as generate_requirements_for_document.
        Runs as a separate call (not merged into generate_requirements_for_document)
        so formalization and scoring stay distinct concerns/prompts. The
        EARS/INCOSE/ISO-29148 criteria are always present in the system
        prompt — the model's general knowledge of these public standards is
        the baseline; kb_context, when supplied, is prepended as additive
        org-specific rules, not a replacement branch."""
        system_prompt = (
            "You score requirement quality against EARS, INCOSE, and ISO/IEC/IEEE "
            "29148 criteria: is it unambiguous, individually testable, atomic "
            "(a single requirement per statement), in active voice, and does it "
            "include acceptance criteria and a clear rationale. You are given a "
            "JSON object mapping each node_id to its final formalized requirement "
            "text. Return ONLY a JSON object with the SAME node_id keys, each "
            "mapped to an object with 'score' (an integer 0-100, where 100 is "
            "fully compliant) and 'issues' (a list of zero or more of: ambiguous, "
            "not_testable, compound, missing_acceptance_criteria, vague_term, "
            "passive_voice, missing_rationale). Never invent a node_id not present "
            "in the input. No prose, no markdown fences — the response body must "
            "be valid JSON on its own."
        )
        system_prompt = _with_kb_context(system_prompt, kb_context)
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(descriptions_by_node_id)},
            ],
            "temperature": 0,
        }
        with httpx.Client(transport=self._transport, timeout=_LLM_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/chat",
                json=payload,
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
        response.raise_for_status()
        content = _strip_json_fence(response.json()["content"])
        try:
            return json.loads(content)
        except json.JSONDecodeError as exc:
            raise ValueError(f"malformed JSON in LLM response content: {content!r}") from exc
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_orchestrator_llm_client.py -v`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/survey/orchestrator_llm_client.py ingestion/tests/test_orchestrator_llm_client.py
git commit -m "feat(survey): add score_requirements_for_document to OrchestratorLlmClient"
```

---

### Task 3: `build_survey_tree` — wire scoring in, once per document, tolerant per-node

**Files:**
- Modify: `ingestion/app/leveling/llm_leveling.py`
- Modify: `ingestion/tests/test_llm_leveling.py`

**Interfaces:**
- Consumes: `RequirementQualityIssue` (Task 1, from `app.workitem.model`). `OrchestratorLlmClient.score_requirements_for_document` shape (Task 2) — but this task's Protocol is independent of that concrete class.
- Produces: `BatchedScoringClient` Protocol with `score_requirements_for_document(self, descriptions_by_node_id: dict[str, str], kb_context: str | None = None) -> dict[str, dict]`. `build_survey_tree` gains `scoring_client: BatchedScoringClient | None = None` (trailing param, after `vector_store`).

- [ ] **Step 1: Write the failing tests**

Add to `ingestion/tests/test_llm_leveling.py` (append at the end of the file):

```python
class FakeBatchedScoringClient:
    """Hand-written test double for the batched (whole-document) scoring
    call — proves build_survey_tree calls score_requirements_for_document
    exactly once for the whole document, not once per node. Result
    defaults to a perfect score with no issues per node, but can be
    overridden via `results` to exercise the tolerant-parsing fallback
    paths."""

    def __init__(self, results: dict[str, dict] | None = None) -> None:
        self._results = results
        self.calls: list[dict[str, str]] = []

    def score_requirements_for_document(
        self, descriptions_by_node_id: dict[str, str], kb_context: str | None = None
    ) -> dict[str, dict]:
        self.calls.append(descriptions_by_node_id)
        if self._results is not None:
            return self._results
        return {node_id: {"score": 100, "issues": []} for node_id in descriptions_by_node_id}


def test_build_survey_tree_without_scoring_client_leaves_quality_fields_unset() -> None:
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient())
    for node in tree.nodes:
        assert node.quality_score is None
        assert node.quality_issues == []


def test_build_survey_tree_threads_scores_and_issues_into_nodes() -> None:
    from app.workitem.model import RequirementQualityIssue

    fake_scoring_client = FakeBatchedScoringClient(
        results={
            "0": {"score": 90, "issues": ["vague_term"]},
            "1": {"score": 40, "issues": ["not_testable", "compound"]},
        }
    )
    tree = build_survey_tree(
        _small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(), scoring_client=fake_scoring_client
    )
    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["0"].quality_score == 90
    assert by_id["0"].quality_issues == [RequirementQualityIssue.VAGUE_TERM]
    assert by_id["1"].quality_score == 40
    assert sorted(i.value for i in by_id["1"].quality_issues) == ["compound", "not_testable"]


def test_build_survey_tree_calls_scoring_exactly_once_regardless_of_node_count() -> None:
    fake_scoring_client = FakeBatchedScoringClient()
    build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(), scoring_client=fake_scoring_client)
    assert len(fake_scoring_client.calls) == 1


def test_build_survey_tree_passes_final_descriptions_not_raw_block_text_to_scoring() -> None:
    fake_scoring_client = FakeBatchedScoringClient()
    build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(), scoring_client=fake_scoring_client)
    # FakeBatchedRequirementClient's default result is "The system shall handle: {text}"
    # — scoring must receive that FINAL formalized text, not the raw block text.
    assert fake_scoring_client.calls[0]["0"] == "The system shall handle: Display"


def test_build_survey_tree_reuses_same_kb_context_for_scoring_as_other_calls(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    captured: dict[str, str | None] = {}

    class _CapturingScoringClient:
        def score_requirements_for_document(
            self, descriptions_by_node_id: dict[str, str], kb_context: str | None = None
        ) -> dict[str, dict]:
            captured["scoring_kb_context"] = kb_context
            return {node_id: {"score": 100, "issues": []} for node_id in descriptions_by_node_id}

    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda area_path, query_text, embed_client, vector_store, **_: "injected KB text",
    )

    build_survey_tree(
        _small_doc(),
        FakeLlmLevelingClient(),
        FakeBatchedRequirementClient(),
        area_path="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
        scoring_client=_CapturingScoringClient(),
    )
    assert captured["scoring_kb_context"] == "injected KB text"


def test_build_survey_tree_tolerates_malformed_score_and_issues_per_node() -> None:
    # A non-int score, an out-of-range score, a non-list issues value, and an
    # issue string outside RequirementQualityIssue must each fall back
    # gracefully — never crash, never affect sibling nodes.
    fake_scoring_client = FakeBatchedScoringClient(
        results={
            "0": {"score": "not-a-number", "issues": "not-a-list"},
            "1": {"score": 150, "issues": ["not_testable", "made_up_issue"]},
        }
    )
    tree = build_survey_tree(
        _small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(), scoring_client=fake_scoring_client
    )
    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["0"].quality_score is None
    assert by_id["0"].quality_issues == []
    assert by_id["1"].quality_score is None  # 150 is out of the 0-100 range
    assert [i.value for i in by_id["1"].quality_issues] == ["not_testable"]


def test_build_survey_tree_tolerates_a_non_dict_per_node_scoring_entry() -> None:
    # Reproduces what happens if a caller's LLM proxy mock/fixture returns a
    # value shaped like generate_requirements_for_document's response (a
    # list) instead of scoring's {"score":.., "issues":..} dict for some
    # node_id — must be treated as "no entry", not crash on list.get(...).
    fake_scoring_client = FakeBatchedScoringClient(results={"0": [{"text": "wrong shape"}]})
    tree = build_survey_tree(
        _small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(), scoring_client=fake_scoring_client
    )
    node0 = next(node for node in tree.nodes if node.local_id == "0")
    assert node0.quality_score is None
    assert node0.quality_issues == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_llm_leveling.py -v -k "scoring or without_scoring_client or reuses_same_kb_context_for_scoring"`
Expected: FAIL with `TypeError: build_survey_tree() got an unexpected keyword argument 'scoring_client'`

- [ ] **Step 3: Implement**

In `ingestion/app/leveling/llm_leveling.py`, update the import line (line 12) to also pull in `RequirementQualityIssue`:

```python
from app.workitem.model import RequirementQualityIssue, RequirementTag, WorkItemMode, WorkItemNode, WorkItemTree, WorkItemType
```

Add the new Protocol after `BatchedRequirementClient` (after line 38):

```python
class BatchedScoringClient(Protocol):
    """Interface for whole-document SURVEY quality scoring — one call
    covering every node's FINAL formalized description, mirroring
    BatchedRequirementClient's one-call-per-document rationale. Runs
    after formalization (build_survey_tree calls it with each node's
    already-formalized description, not the raw block text)."""

    def score_requirements_for_document(
        self, descriptions_by_node_id: dict[str, str], kb_context: str | None = None
    ) -> dict[str, dict]: ...
```

Add `from app.kb.retrieval import retrieve_context` stays as-is (already imported). Update `build_survey_tree`'s signature (currently ending at `vector_store: KbVectorStore | None = None,`) to add a trailing param:

```python
def build_survey_tree(
    doc: CanonicalDoc,
    llm_client: LlmLevelingClient,
    requirement_client: BatchedRequirementClient,
    area_path: str | None = None,
    embed_client: object | None = None,
    vector_store: KbVectorStore | None = None,
    scoring_client: BatchedScoringClient | None = None,
) -> WorkItemTree:
```

Append one sentence to the docstring (after the existing KB-retrieval sentence): `"When scoring_client is supplied, one additional batched call scores every node's FINAL formalized description using the SAME kb_context already computed for the other two calls; when scoring_client is omitted, every node's quality_score stays None and quality_issues stays empty — matching pre-scoring behavior exactly. Per-node scoring entries that are missing, malformed, or out of the 0-100 range are tolerated individually and never abort the batch."`

At the very end of the function, replace:

```python
    return WorkItemTree(nodes=nodes)
```

with:

```python
    if scoring_client is not None:
        descriptions_by_node_id = {node.local_id: node.description for node in nodes}
        scoring_by_node_id = scoring_client.score_requirements_for_document(descriptions_by_node_id, kb_context=kb_context)
        valid_issue_values = {issue.value for issue in RequirementQualityIssue}
        for node in nodes:
            raw_entry = scoring_by_node_id.get(node.local_id, {})
            if not isinstance(raw_entry, dict):
                raw_entry = {}
            raw_score = raw_entry.get("score")
            if isinstance(raw_score, int) and not isinstance(raw_score, bool) and 0 <= raw_score <= 100:
                node.quality_score = raw_score
            raw_issues = raw_entry.get("issues", [])
            if isinstance(raw_issues, list):
                node.quality_issues = sorted(
                    {
                        RequirementQualityIssue(issue)
                        for issue in raw_issues
                        if isinstance(issue, str) and issue in valid_issue_values
                    },
                    key=lambda issue: issue.value,
                )

    return WorkItemTree(nodes=nodes)
```

(The `not isinstance(raw_score, bool)` guard exists because `bool` is a subclass of `int` in Python — `isinstance(True, int)` is `True` — and a stray boolean must not be accepted as a 0-100 score.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_llm_leveling.py -v`
Expected: PASS (all tests in the file, including every pre-existing P2b test — none needed modification since `scoring_client` defaults to `None`)

- [ ] **Step 5: Run the full ingestion suite to confirm no regressions**

Run: `cd ingestion && .venv/bin/python -m pytest -v`
Expected: same pass/fail counts as the pre-existing baseline (7 pre-existing OCR/poppler failures, unrelated) plus every new test from Tasks 1-3 passing.

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/leveling/llm_leveling.py ingestion/tests/test_llm_leveling.py
git commit -m "feat(survey): wire quality scoring into build_survey_tree, once per document, tolerant per-node"
```

---

### Task 4: `/level` route — wire `scoring_client` through

**Files:**
- Modify: `ingestion/app/main.py`
- Modify: `ingestion/tests/test_level_endpoint.py`

**Interfaces:**
- Consumes: `build_survey_tree(doc, llm_client, requirement_client, area_path=None, embed_client=None, vector_store=None, scoring_client=None)` (Task 3).
- Produces: the `mode == "survey"` branch of `POST /level` always passes `scoring_client=client` (the same `OrchestratorLlmClient` instance already used for `llm_client`/`requirement_client` — one instance satisfies all three Protocols).

- [ ] **Step 1: Write the failing test**

Add to `ingestion/tests/test_level_endpoint.py`:

```python
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

    def patched_init(self, base_url, bearer_token):
        original_init(self, base_url, bearer_token)
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
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_level_endpoint.py -v -k quality_score_from_a_real_scoring_call`
Expected: FAIL — `quality_score` is `None`/missing in the response since `scoring_client` isn't wired into the route yet.

- [ ] **Step 3: Wire it up**

In `ingestion/app/main.py`, change the `build_survey_tree` call inside the `mode == "survey"` branch (the `run_in_threadpool(...)` call) to add one more keyword argument:

```python
        return await run_in_threadpool(
            build_survey_tree,
            doc,
            llm_client=client,
            requirement_client=client,
            area_path=area_path,
            embed_client=_embed_client,
            vector_store=_kb_vector_store,
            scoring_client=client,
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_level_endpoint.py -v`
Expected: PASS (all tests in the file, including every pre-existing test from Phase 1/P2b — none needed modification, since `build_survey_tree`'s tolerant per-node scoring parsing treats those tests' non-scoring-shaped mock responses as "no valid entry" rather than crashing, per Task 3's `isinstance` guards).

- [ ] **Step 5: Run the full ingestion suite**

Run: `cd ingestion && .venv/bin/python -m pytest -v`
Expected: same baseline pass/fail counts as Task 3 Step 5, plus these new tests passing.

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/main.py ingestion/tests/test_level_endpoint.py
git commit -m "feat(survey): wire scoring_client through /level route"
```

---

### Task 5: Orchestrator — thread `qualityScore`/`qualityIssues` through the pipeline

**Files:**
- Modify: `orchestrator/src/modules/pipeline/pipeline.worker.ts`
- Modify: `orchestrator/src/modules/writeback/dry-run.service.ts`
- Modify: `orchestrator/test/pipeline.worker.spec.ts`
- Modify: `orchestrator/test/dry-run.service.spec.ts`

**Interfaces:**
- Consumes: ingestion's `/level` response now includes `quality_score: int | null` and `quality_issues: string[]` per node (Task 4).
- Produces: `DryRunTreeNode` and `DryRunDiffEntry` (`dry-run.service.ts`) both gain `qualityScore?: number | null` and `qualityIssues?: string[]`. `LeveledNode` (`pipeline.worker.ts`) gains `quality_score?: number | null` and `quality_issues?: string[]`.

- [ ] **Step 1: Write the failing tests**

Add to `orchestrator/test/dry-run.service.spec.ts` (append at the end of the file, before the closing `});`):

```typescript
  it('carries qualityScore and qualityIssues through from tree node to diff entry', async () => {
    const nodes = [
      {
        localId: 'r1', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
        sourceHash: 'h1', customerId: null, areaPath: 'Proj\\Area', tags: [],
        qualityScore: 72, qualityIssues: ['vague_term'],
      },
    ];
    const service = new DryRunService();
    const diff = await service.diff(nodes as any, { lookup: jest.fn().mockResolvedValue(null) } as any);
    expect(diff[0].qualityScore).toBe(72);
    expect(diff[0].qualityIssues).toEqual(['vague_term']);
  });

  it('leaves qualityScore/qualityIssues undefined when the tree node omits them (byte-identical pre-P2c behavior)', async () => {
    const nodes = [
      {
        localId: 'r1', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
        sourceHash: 'h1', customerId: null, areaPath: 'Proj\\Area', tags: [],
      },
    ];
    const service = new DryRunService();
    const diff = await service.diff(nodes as any, { lookup: jest.fn().mockResolvedValue(null) } as any);
    expect(diff[0].qualityScore).toBeUndefined();
    expect(diff[0].qualityIssues).toBeUndefined();
  });
```

Add to `orchestrator/test/pipeline.worker.spec.ts` (append a new `it(...)` after the existing `'carries parent_local_id/type/title/description...'` test, same `describe` block):

```typescript
  it('carries quality_score/quality_issues from ingestion through to the dry-run diff input', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({
      nodes: [
        {
          local_id: 'n0',
          fidelity_hash: 'hashA',
          customer_id: 'CUST-1',
          quality_score: 72,
          quality_issues: ['vague_term'],
        },
        {
          local_id: 'n1',
          fidelity_hash: 'hashB',
          customer_id: 'CUST-1',
        },
      ],
    });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', customerId: 'CUST-1', mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
      },
    );

    expect(fakeDryRunService.diff).toHaveBeenCalledWith(
      [
        {
          localId: 'n0', sourceHash: 'hashA', customerId: 'CUST-1', areaPath: 'Project\\Area1', tags: [],
          qualityScore: 72, qualityIssues: ['vague_term'],
        },
        {
          localId: 'n1', sourceHash: 'hashB', customerId: 'CUST-1', areaPath: 'Project\\Area1', tags: [],
          qualityScore: undefined, qualityIssues: undefined,
        },
      ],
      fakeIdempotencyService,
      expect.any(Function),
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd orchestrator && npm test -- dry-run.service.spec.ts pipeline.worker.spec.ts`
Expected: FAIL — TypeScript compile error or `undefined` mismatch, since `qualityScore`/`qualityIssues` don't exist on `DryRunTreeNode`/`DryRunDiffEntry`/`LeveledNode` yet.

- [ ] **Step 3: Implement**

In `orchestrator/src/modules/writeback/dry-run.service.ts`, add two fields to `DryRunTreeNode` (after `tags: string[];`, line 13):

```typescript
  qualityScore?: number | null;
  qualityIssues?: string[];
```

Add the same two fields to `DryRunDiffEntry` (after `tags: string[];`, line 38):

```typescript
  qualityScore?: number | null;
  qualityIssues?: string[];
```

In each of the 3 places `diff()` pushes a result object (the `'reuse'` push, the `'dedup_skip'` push, and the `'create'` push — each currently ends with `tags: node.tags,`), add the passthrough right after `tags: node.tags,`:

```typescript
          tags: node.tags, qualityScore: node.qualityScore, qualityIssues: node.qualityIssues,
```

(Raw passthrough, no `?? null`/`?? []` — see Global Constraints for why.)

In `orchestrator/src/modules/pipeline/pipeline.worker.ts`, add two fields to `LeveledNode` (after `tags: string[];`, line 30):

```typescript
  quality_score?: number | null;
  quality_issues?: string[];
```

In the `diffInputs` mapping (the `tree.nodes.map((node) => ({...}))` block), add two lines after `tags: node.tags ?? [],`:

```typescript
      qualityScore: node.quality_score,
      qualityIssues: node.quality_issues,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd orchestrator && npm test -- dry-run.service.spec.ts pipeline.worker.spec.ts`
Expected: PASS (all tests in both files, including every pre-existing test — the raw-passthrough design keeps `qualityScore`/`qualityIssues` `undefined` when a test's node object omits them, which Jest's `toEqual`/`toHaveBeenCalledWith` treat as equal to an absent key).

- [ ] **Step 5: Run the full orchestrator suite**

Run: `cd orchestrator && npm test`
Expected: all tests pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/modules/pipeline/pipeline.worker.ts orchestrator/src/modules/writeback/dry-run.service.ts orchestrator/test/pipeline.worker.spec.ts orchestrator/test/dry-run.service.spec.ts
git commit -m "feat(orchestrator): thread qualityScore/qualityIssues through the SURVEY pipeline"
```

---

### Task 6: Frontend — `IssueChips` component + `NodeDetailPanel` score display

**Files:**
- Create: `frontend/src/utils/issueColors.ts`
- Create: `frontend/src/components/IssueChips.tsx`
- Create: `frontend/src/components/IssueChips.test.tsx`
- Modify: `frontend/src/components/DiffTree.tsx` (interface only)
- Modify: `frontend/src/components/NodeDetailPanel.tsx`
- Modify: `frontend/src/components/NodeDetailPanel.test.tsx`

**Interfaces:**
- Consumes: `DryRunDiffEntry.qualityScore?: number | null`, `DryRunDiffEntry.qualityIssues?: string[]` (Task 5's orchestrator shape, mirrored in the frontend's own copy of this interface).
- Produces: `IssueChips({ issues }: { issues: string[] | undefined }): React.ReactElement`. `NodeDetailPanel` renders a score line + `<IssueChips issues={entry.qualityIssues} />` when `entry.qualityScore != null`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/IssueChips.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IssueChips } from './IssueChips';

describe('IssueChips', () => {
  it('renders one chip per issue', () => {
    render(<IssueChips issues={['vague_term', 'not_testable']} />);
    expect(screen.getByText('vague_term')).toBeInTheDocument();
    expect(screen.getByText('not_testable')).toBeInTheDocument();
  });

  it('renders nothing when issues is undefined', () => {
    const { container } = render(<IssueChips issues={undefined} />);
    expect(container.querySelectorAll('.MuiChip-root').length).toBe(0);
  });

  it('renders nothing when issues is an empty array', () => {
    const { container } = render(<IssueChips issues={[]} />);
    expect(container.querySelectorAll('.MuiChip-root').length).toBe(0);
  });
});
```

Update `frontend/src/components/NodeDetailPanel.test.tsx`'s second test (the "renders the entry title..." one) to also cover the score/issues case — replace the whole file with:

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NodeDetailPanel } from './NodeDetailPanel';

describe('NodeDetailPanel', () => {
  it('renders a placeholder when nothing is selected', () => {
    render(<NodeDetailPanel entry={null} />);
    expect(screen.getByText(/select a node/i)).toBeInTheDocument();
  });

  it('renders the entry title, description, type, and tags when selected', () => {
    render(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: ['functional'] }}
      />,
    );
    expect(screen.getByText('Req Title')).toBeInTheDocument();
    expect(screen.getByText('Req body')).toBeInTheDocument();
    expect(screen.getByText('functional')).toBeInTheDocument();
  });

  it('renders the quality score and issue chips when present', () => {
    render(
      <NodeDetailPanel
        entry={{
          localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body',
          action: 'create', customerId: null, tags: [], qualityScore: 72, qualityIssues: ['vague_term'],
        }}
      />,
    );
    expect(screen.getByText(/72\s*\/\s*100/)).toBeInTheDocument();
    expect(screen.getByText('vague_term')).toBeInTheDocument();
  });

  it('renders no score line when qualityScore is absent', () => {
    render(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
      />,
    );
    expect(screen.queryByText(/\/\s*100/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npm test -- IssueChips.test.tsx NodeDetailPanel.test.tsx`
Expected: FAIL — `IssueChips` module doesn't exist yet; `NodeDetailPanel`'s new tests fail since the component doesn't render a score/issues yet.

- [ ] **Step 3: Implement**

Create `frontend/src/utils/issueColors.ts`:

```typescript
const ISSUE_COLORS: Record<string, string> = {
  ambiguous: '#dc2626',
  not_testable: '#b45309',
  compound: '#7c3aed',
  missing_acceptance_criteria: '#0891b2',
  vague_term: '#ea580c',
  passive_voice: '#4d7c0f',
  missing_rationale: '#be123c',
};

export function issueColor(issue: string): string {
  return ISSUE_COLORS[issue] ?? '#64748b';
}
```

Create `frontend/src/components/IssueChips.tsx`:

```typescript
import Stack from '@mui/material/Stack';
import Chip from '@mui/material/Chip';
import { issueColor } from '../utils/issueColors';

export function IssueChips({ issues }: { issues: string[] | undefined }): React.ReactElement {
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap">
      {(issues ?? []).map((issue) => (
        <Chip key={issue} label={issue} size="small" sx={{ backgroundColor: issueColor(issue), color: '#fff' }} />
      ))}
    </Stack>
  );
}
```

In `frontend/src/components/DiffTree.tsx`, add two fields to `DryRunDiffEntry` (after `tags?: string[];`, line 17):

```typescript
  qualityScore?: number | null;
  qualityIssues?: string[];
```

Replace the full contents of `frontend/src/components/NodeDetailPanel.tsx`:

```typescript
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { TagChips } from './TagChips';
import { IssueChips } from './IssueChips';
import type { DryRunDiffEntry } from './DiffTree';

export function NodeDetailPanel({ entry }: { entry: DryRunDiffEntry | null }): React.ReactElement {
  if (!entry) {
    return <Box p={2}><Typography color="text.secondary">Select a node to view details.</Typography></Box>;
  }
  return (
    <Box p={2}>
      <Typography variant="overline">{entry.type}</Typography>
      <Typography variant="h6">{entry.title}</Typography>
      <Typography variant="body2">{entry.description}</Typography>
      <TagChips tags={entry.tags} />
      {entry.qualityScore != null && (
        <>
          <Typography variant="body2">Quality score: {entry.qualityScore} / 100</Typography>
          <IssueChips issues={entry.qualityIssues} />
        </>
      )}
    </Box>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npm test -- IssueChips.test.tsx NodeDetailPanel.test.tsx TagChips.test.tsx DiffTree.test.tsx`
Expected: PASS (all tests, including pre-existing `TagChips`/`DiffTree` tests — `DiffTree.tsx`'s interface change is additive-only).

- [ ] **Step 5: Run the full frontend suite**

Run: `cd frontend && npm test`
Expected: all tests pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/utils/issueColors.ts frontend/src/components/IssueChips.tsx frontend/src/components/IssueChips.test.tsx frontend/src/components/DiffTree.tsx frontend/src/components/NodeDetailPanel.tsx frontend/src/components/NodeDetailPanel.test.tsx
git commit -m "feat(frontend): add IssueChips and quality score display to NodeDetailPanel"
```

---

### Task 7: Update handoff documentation

**Files:**
- Modify: `docs/handoff-frontend-rebuild.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Add a P2c section**

Add a new subsection after the existing "§4b. P2b — RAG retrieval-injection into SURVEY" section (before "## 5. Backend API surface"):

```markdown
## 4c. P2c — RAG-grounded quality scoring (current)

Every SURVEY-mode node now gets a 0-100 quality score and zero or more flagged issue labels, judged against org rules retrieved from the KB when available, falling back to EARS/INCOSE/ISO-29148 criteria baked into the prompt (the model's general knowledge of these public standards, not a second retrieval) when it isn't. A new batched whole-document call, `OrchestratorLlmClient.score_requirements_for_document` (`ingestion/app/survey/orchestrator_llm_client.py`), runs inside `build_survey_tree` (`ingestion/app/leveling/llm_leveling.py`) after the existing formalization loop, scoring every node's FINAL formalized description in one call. It reuses the SAME `kb_context` string already computed once per document by P2b's `retrieve_context` — zero new retrieval calls, one new LLM round-trip per document.

**Fully additive.** `build_survey_tree` gained a new optional `scoring_client` param defaulting to `None` — every pre-existing test call site needed zero changes. `POST /level`'s production caller (`app/main.py`) always supplies the real `OrchestratorLlmClient` instance as `scoring_client` (the same instance already used for `llm_client`/`requirement_client`).

**Tolerant per-node parsing.** A missing, malformed (non-int, out of 0-100 range), or wrongly-shaped (e.g. not even a dict) scoring entry for one node_id falls back to `quality_score=None`/`quality_issues=[]` for that node only — never crashes the batch or affects sibling nodes. `RequirementQualityIssue` (`ingestion/app/workitem/model.py`) is a closed 7-value enum (`ambiguous`, `not_testable`, `compound`, `missing_acceptance_criteria`, `vague_term`, `passive_voice`, `missing_rationale`); an issue string from the LLM outside this set is silently dropped, same tolerant philosophy as `RequirementTag` today.

**Data flow.** `WorkItemNode.quality_score`/`quality_issues` (ingestion) → `DryRunTreeNode`/`DryRunDiffEntry.qualityScore`/`qualityIssues` (orchestrator, `pipeline.worker.ts` + `dry-run.service.ts`) → `NodeDetailPanel` (frontend), which renders a `{score}/100` line plus a new `IssueChips` component (mirrors `TagChips`, own color mapping via `issueColors.ts`) — detail-panel-only, the `DiffTree` tree rows are unchanged.

**Not yet done:** P2d (learning-loop write-back of confirmed/accepted items into the KB). Editable/re-scoreable items from the review UI (Phase 3's per-item chat/refine work may eventually trigger re-scoring; not this phase). Org-authored custom scoring rubrics beyond what's already retrievable via the existing per-document `kb_context`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/handoff-frontend-rebuild.md
git commit -m "docs: document P2c RAG-grounded quality scoring in handoff guide"
```
