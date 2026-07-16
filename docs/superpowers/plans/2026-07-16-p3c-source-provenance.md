# P3c — Source Provenance Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, on every SURVEY-mode generated diff entry, which KB documents (if any) grounded its content/quality score, plus the always-on standards baseline used for quality scoring.

**Architecture:** `retrieve_context()` (ingestion) starts returning the citation list (KB doc names) it already computes internally but currently discards, alongside its existing context string. `build_survey_tree` threads that list through unchanged as one job-level `kb_citations` field (shared by every node — retrieval runs once per document, not per node). It rides the existing `/level` → `dryRunDiff` pipeline all the way to a new `Job.kbCitations` column, surfaced on `GET /jobs/:id`, and rendered as a "Sources" section in `NodeDetailPanel`.

**Tech Stack:** Python/FastAPI + pydantic (ingestion), NestJS + Prisma/Postgres (orchestrator), React + MUI + Zustand (frontend). Ingestion tests: pytest (`.venv/bin/python -m pytest`). Orchestrator tests: Jest, hand-built plain-object mocks, no `TestingModule`. Frontend tests: Vitest + `@testing-library/react`.

## Global Constraints

- Repo root: `/Users/EdenZviSchwartz/Repos/Projects/elisradevops/req2ado` (standalone repo, branch `main`). Run all commands from this root, not the `req2ado-phase10` worktree.
- Job-level granularity only — one shared citation list per job, identical for every node. No per-node/per-chunk attribution (out of scope per spec).
- Citation list is doc names only (`source_file`) — no `doc_type`/`source_id` enrichment (out of scope per spec).
- SURVEY mode only. BASELINE jobs always have `kbCitations: []` and never render the Sources section.
- The standards line ("Judged against EARS, INCOSE, ISO/IEC/IEEE 29148") is static and always shown for SURVEY `create` nodes, independent of whether KB citations exist.
- Ingestion tests run via `.venv/bin/python -m pytest`, not bare `pytest` (per `docs/handoff-frontend-rebuild.md` §9).
- `orchestrator/.env`'s `DATABASE_URL` may point at the wrong local Postgres (`5432` instead of docker-compose's `5434`) — when running `npx prisma migrate dev`, target port `5434` explicitly if that quirk is still present.

---

## File Structure

**Ingestion (Python):**
- Modify `ingestion/app/kb/retrieval.py` — `retrieve_context()` return type becomes `tuple[str | None, list[str]]`.
- Modify `ingestion/tests/kb/test_retrieval.py` — update assertions for the new tuple return.
- Modify `ingestion/app/workitem/model.py` — `WorkItemTree` gains `kb_citations: list[str]`.
- Modify `ingestion/app/leveling/llm_leveling.py` — `build_survey_tree` unpacks the tuple, passes `kb_citations` to the returned `WorkItemTree`.
- Modify `ingestion/tests/test_llm_leveling.py` — update every `retrieve_context` mock to return a tuple; add `kb_citations` assertions.
- Modify `ingestion/tests/test_level_endpoint.py` — update the one `retrieve_context` mock to return a tuple; add a citations-in-response test.

**Orchestrator (NestJS):**
- Modify `orchestrator/src/modules/pipeline/ingestion-http.client.ts` — `level()` gains an optional 4th `areaPath` param, forwarded as `area_path` (fixes a latent bug: the real pipeline never forwarded `area_path`, so P2b/P2c's KB grounding has never actually activated in production — see Task 4).
- Modify `orchestrator/test/ingestion-http.client.spec.ts` — add a test asserting `area_path` is forwarded.
- Modify `orchestrator/prisma/schema.prisma` — `Job` gains `kbCitations String[] @default([])`.
- Create migration `orchestrator/prisma/migrations/<timestamp>_add_job_kb_citations/migration.sql`.
- Modify `orchestrator/src/modules/pipeline/pipeline.worker.ts` — pass `job.areaPath` into `ingestionClient.level()`; extract `kb_citations` from the ingestion response and persist it on the `Job` row.
- Modify `orchestrator/test/pipeline.worker.spec.ts` — update existing exact-match assertions to include `kbCitations`; add a new test for citations passthrough.
- Modify `orchestrator/src/modules/pipeline/jobs.service.ts` — `getById()` returns `kbCitations`.
- Modify `orchestrator/src/modules/pipeline/jobs.controller.ts` — `getById()`'s return type includes `kbCitations`.
- Modify `orchestrator/test/jobs.service.spec.ts` — add a `getById` test.

**Frontend (React):**
- Modify `frontend/src/store/jobsStore.ts` — `JobDetail` gains `kbCitations?: string[]`.
- Modify `frontend/src/pages/JobDetail.tsx` — track `kbCitations` state, pass `jobMode`/`kbCitations` props to `NodeDetailPanel`.
- Modify `frontend/src/components/NodeDetailPanel.tsx` — new "Sources" section.
- Modify `frontend/src/components/NodeDetailPanel.test.tsx` — add tests for the Sources section.

---

## Task 1: `retrieve_context()` returns citations alongside context

**Files:**
- Modify: `ingestion/app/kb/retrieval.py`
- Test: `ingestion/tests/kb/test_retrieval.py`

**Interfaces:**
- Produces: `retrieve_context(area_path, query_text, embed_client, vector_store, top_k=5, max_distance=0.7) -> tuple[str | None, list[str]]`. First element: joined survivor text (unchanged behavior), or `None`. Second element: unique `source_file` values from survivor hits, dedup'd, first-seen order (nearest-first, matching `KbVectorStore.query()`'s existing ordering) — `[]` when the first element is `None` for any reason (empty collection, no hit clears the bar, or embed/query raised).

- [ ] **Step 1: Write the failing tests**

Replace `ingestion/tests/kb/test_retrieval.py` in full:

```python
import logging

from app.kb.kb_vector_store import KbVectorStore
from app.kb.retrieval import retrieve_context


class FakeEmbedClient:
    def __init__(self, embedding: list[float] | None = None, raises: Exception | None = None) -> None:
        self._embedding = embedding or [1.0, 0.0, 0.0]
        self._raises = raises
        self.calls: list[list[str]] = []

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(texts)
        if self._raises:
            raise self._raises
        return [self._embedding]


class RaisingVectorStore:
    def query(self, area_path: str, embedding: list[float], top_k: int) -> list[dict]:
        raise RuntimeError("chroma unavailable")


def test_retrieve_context_returns_none_and_empty_citations_for_empty_collection(tmp_path) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    context, citations = retrieve_context("Project\\Area1", "some outline", FakeEmbedClient(), store)
    assert context is None
    assert citations == []


def test_retrieve_context_joins_hits_within_threshold(tmp_path) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    store.upsert_chunk(
        chunk_id="s1:doc.txt:0", embedding=[1.0, 0.0, 0.0], text="close chunk text",
        area_path="Project\\Area1", source_file="doc.txt", source_id="s1", chunk_index=0, file_hash="h1",
    )
    context, citations = retrieve_context("Project\\Area1", "some outline", FakeEmbedClient(embedding=[1.0, 0.0, 0.0]), store)
    assert context == "close chunk text"
    assert citations == ["doc.txt"]


def test_retrieve_context_dedups_citations_across_multiple_hits_from_the_same_file(tmp_path) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    store.upsert_chunk(
        chunk_id="s1:doc.txt:0", embedding=[1.0, 0.0, 0.0], text="chunk one",
        area_path="Project\\Area1", source_file="doc.txt", source_id="s1", chunk_index=0, file_hash="h1",
    )
    store.upsert_chunk(
        chunk_id="s1:doc.txt:1", embedding=[1.0, 0.0, 0.0], text="chunk two",
        area_path="Project\\Area1", source_file="doc.txt", source_id="s1", chunk_index=1, file_hash="h1",
    )
    context, citations = retrieve_context("Project\\Area1", "some outline", FakeEmbedClient(embedding=[1.0, 0.0, 0.0]), store, top_k=5)
    assert citations == ["doc.txt"]
    assert context is not None and "chunk one" in context and "chunk two" in context


def test_retrieve_context_citations_span_multiple_distinct_files(tmp_path) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    store.upsert_chunk(
        chunk_id="s1:doc1.txt:0", embedding=[1.0, 0.0, 0.0], text="from doc1",
        area_path="Project\\Area1", source_file="doc1.txt", source_id="s1", chunk_index=0, file_hash="h1",
    )
    store.upsert_chunk(
        chunk_id="s2:doc2.txt:0", embedding=[1.0, 0.0, 0.0], text="from doc2",
        area_path="Project\\Area1", source_file="doc2.txt", source_id="s2", chunk_index=0, file_hash="h2",
    )
    context, citations = retrieve_context("Project\\Area1", "some outline", FakeEmbedClient(embedding=[1.0, 0.0, 0.0]), store, top_k=5)
    assert sorted(citations) == ["doc1.txt", "doc2.txt"]


def test_retrieve_context_discards_hits_below_similarity_bar(tmp_path) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    # Orthogonal embedding -> cosine distance 1.0 -> similarity 0.0, well below the 0.3 cutoff.
    store.upsert_chunk(
        chunk_id="s1:doc.txt:0", embedding=[0.0, 1.0, 0.0], text="unrelated chunk",
        area_path="Project\\Area1", source_file="doc.txt", source_id="s1", chunk_index=0, file_hash="h1",
    )
    context, citations = retrieve_context("Project\\Area1", "some outline", FakeEmbedClient(embedding=[1.0, 0.0, 0.0]), store)
    assert context is None
    assert citations == []


def test_retrieve_context_returns_none_and_logs_warning_when_embed_raises(tmp_path, caplog) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    embed_client = FakeEmbedClient(raises=RuntimeError("orchestrator unreachable"))
    with caplog.at_level(logging.WARNING):
        context, citations = retrieve_context("Project\\Area1", "some outline", embed_client, store)
    assert context is None
    assert citations == []
    assert "orchestrator unreachable" in caplog.text


def test_retrieve_context_returns_none_and_logs_warning_when_query_raises(caplog) -> None:
    with caplog.at_level(logging.WARNING):
        context, citations = retrieve_context("Project\\Area1", "some outline", FakeEmbedClient(), RaisingVectorStore())
    assert context is None
    assert citations == []
    assert "chroma unavailable" in caplog.text
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/kb/test_retrieval.py -v`
Expected: FAIL — `retrieve_context` still returns a bare `str | None`, so unpacking into `context, citations` raises `TypeError: cannot unpack non-iterable NoneType object` (or `str object is not... `) on every test.

- [ ] **Step 3: Implement**

Replace `ingestion/app/kb/retrieval.py` in full:

```python
from __future__ import annotations

import logging
from typing import Protocol

from app.kb.kb_vector_store import KbVectorStore

logger = logging.getLogger(__name__)


class EmbedClient(Protocol):
    def embed(self, texts: list[str]) -> list[list[float]]: ...


def retrieve_context(
    area_path: str,
    query_text: str,
    embed_client: EmbedClient,
    vector_store: KbVectorStore,
    top_k: int = 5,
    max_distance: float = 0.7,
) -> tuple[str | None, list[str]]:
    """Embeds query_text, queries the KB collection for area_path, keeps
    hits with distance <= max_distance (cosine similarity >= 0.3), and
    joins their text with a blank-line separator. Returns
    (context, citations): context is None when the collection is empty, no
    hit clears the similarity bar, or the embed/query call itself raises
    (network failure, Chroma error) — KB retrieval is an enhancement, not a
    hard dependency, and must never fail or block a SURVEY job. citations is
    the deduped, first-seen-order list of surviving hits' source_file names
    (P3c source provenance) — always [] when context is None. Any exception
    is caught and logged here; this is the single seam that makes KB failure
    non-fatal for callers."""
    try:
        [embedding] = embed_client.embed([query_text])
        hits = vector_store.query(area_path, embedding, top_k)
    except Exception as exc:  # noqa: BLE001 - retrieval must never fail a SURVEY job
        logger.warning("KB retrieval failed for area_path=%s: %s", area_path, exc)
        return None, []

    survivors = [hit for hit in hits if hit["distance"] <= max_distance]
    if not survivors:
        return None, []

    context = "\n\n".join(hit["text"] for hit in survivors)
    citations: list[str] = []
    for hit in survivors:
        if hit["source_file"] not in citations:
            citations.append(hit["source_file"])
    return context, citations
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ingestion && .venv/bin/python -m pytest tests/kb/test_retrieval.py -v`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/kb/retrieval.py ingestion/tests/kb/test_retrieval.py
git commit -m "feat(kb): retrieve_context returns source citations alongside context"
```

---

## Task 2: Thread `kb_citations` through `build_survey_tree` and `WorkItemTree`

**Files:**
- Modify: `ingestion/app/workitem/model.py`
- Modify: `ingestion/app/leveling/llm_leveling.py`
- Test: `ingestion/tests/test_llm_leveling.py`

**Interfaces:**
- Consumes: `retrieve_context(...) -> tuple[str | None, list[str]]` from Task 1.
- Produces: `WorkItemTree.kb_citations: list[str]` (default `[]`). `build_survey_tree(...)` populates it from `retrieve_context`'s second element when KB params are supplied; stays `[]` otherwise.

- [ ] **Step 1: Write the failing tests**

In `ingestion/tests/test_llm_leveling.py`, update the three existing `retrieve_context` mocks to return tuples, and add citation assertions. First, the mock at (currently) lines 210-213:

```python
    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda area_path, query_text, embed_client, vector_store, **_: ("injected KB text", ["doc-a.docx"]),
    )
```

The fake function at (currently) lines 232-234:

```python
    def _fake_retrieve_context(area_path, query_text, embed_client, vector_store, **_):
        call_count["n"] += 1
        return None, []
```

The mock at (currently) lines 377-380:

```python
    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda area_path, query_text, embed_client, vector_store, **_: ("injected KB text", ["doc-a.docx"]),
    )
```

Then add these new tests, appended to the end of the file:

```python
def test_build_survey_tree_without_area_path_has_empty_kb_citations() -> None:
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient())
    assert tree.kb_citations == []


def test_build_survey_tree_threads_kb_citations_from_retrieve_context(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda area_path, query_text, embed_client, vector_store, **_: ("injected KB text", ["doc-a.docx", "doc-b.pdf"]),
    )

    tree = build_survey_tree(
        _small_doc(),
        FakeLlmLevelingClient(),
        FakeBatchedRequirementClient(),
        area_path="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
    )
    assert tree.kb_citations == ["doc-a.docx", "doc-b.pdf"]


def test_build_survey_tree_kb_citations_empty_when_retrieval_finds_nothing(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda area_path, query_text, embed_client, vector_store, **_: (None, []),
    )

    tree = build_survey_tree(
        _small_doc(),
        FakeLlmLevelingClient(),
        FakeBatchedRequirementClient(),
        area_path="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
    )
    assert tree.kb_citations == []
```

Also update the end-to-end integration test `test_build_survey_tree_end_to_end_injects_real_ingested_kb_chunk` (currently lines 249-301) — add one assertion line right after its existing two `assert captured[...]` lines:

```python
    assert captured["hierarchy_kb_context"] == "The receiver shall decode HDR10 metadata."
    assert captured["requirements_kb_context"] == "The receiver shall decode HDR10 metadata."
    assert tree.kb_citations == ["spec.docx"]
```

(This requires capturing `build_survey_tree`'s return value into `tree` — currently the call at line 291 discards it: change `build_survey_tree(` to `tree = build_survey_tree(` for that call site.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_llm_leveling.py -v`
Expected: FAIL — `WorkItemTree` has no `kb_citations` attribute yet (`AttributeError`), and the three updated mocks now return 2-tuples that `build_survey_tree` doesn't yet unpack (its existing single-value assignment `kb_context = retrieve_context(...)` would bind `kb_context` to the whole tuple, breaking the `_with_kb_context` string checks downstream — visible as `TypeError`/assertion failures on the pre-existing `kb_context` assertions).

- [ ] **Step 3: Implement**

In `ingestion/app/workitem/model.py`, change:

```python
class WorkItemTree(BaseModel):
    nodes: list[WorkItemNode] = Field(default_factory=list)
```

to:

```python
class WorkItemTree(BaseModel):
    nodes: list[WorkItemNode] = Field(default_factory=list)
    kb_citations: list[str] = Field(default_factory=list)
```

In `ingestion/app/leveling/llm_leveling.py`, change:

```python
    outline = _build_outline(doc)
    kb_context: str | None = None
    if area_path is not None and embed_client is not None and vector_store is not None:
        kb_context = retrieve_context(area_path, outline, embed_client, vector_store)
```

to:

```python
    outline = _build_outline(doc)
    kb_context: str | None = None
    kb_citations: list[str] = []
    if area_path is not None and embed_client is not None and vector_store is not None:
        kb_context, kb_citations = retrieve_context(area_path, outline, embed_client, vector_store)
```

and change the function's final line from:

```python
    return WorkItemTree(nodes=nodes)
```

to:

```python
    return WorkItemTree(nodes=nodes, kb_citations=kb_citations)
```

Also update the function's docstring — after the sentence ending "...matching pre-KB behavior exactly.", insert:

```
    kb_citations (the deduped list of KB source_file names that grounded
    kb_context) is returned once on the tree, not per node — retrieval runs
    once per document, so every node in a tree shares the same citation
    list (P3c source provenance).
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_llm_leveling.py -v`
Expected: PASS (all tests, including the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/workitem/model.py ingestion/app/leveling/llm_leveling.py ingestion/tests/test_llm_leveling.py
git commit -m "feat(leveling): thread kb_citations through build_survey_tree onto WorkItemTree"
```

---

## Task 3: `/level` response includes `kb_citations`

**Files:**
- Test: `ingestion/tests/test_level_endpoint.py`

No production code changes — `/level`'s `response_model=WorkItemTree` (`ingestion/app/main.py`) already serializes whatever fields `WorkItemTree` has, so Task 2's model change is sufficient. This task locks the HTTP-level contract with regression tests and fixes the one pre-existing mock this change breaks.

**Interfaces:**
- Consumes: `WorkItemTree.kb_citations` from Task 2.

- [ ] **Step 1: Write the failing tests**

In `ingestion/tests/test_level_endpoint.py`, update `test_level_endpoint_survey_mode_with_area_path_injects_kb_context`'s mock (currently lines 133-136):

```python
    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda area_path, query_text, embed_client, vector_store, **_: ("Injected KB reference text.", ["ref-doc.docx"]),
    )
```

and add an assertion right after the existing `assert all(...)` line in that same test:

```python
    assert response.status_code == 200
    assert all("Injected KB reference text." in prompt for prompt in captured_system_prompts)
    assert response.json()["kb_citations"] == ["ref-doc.docx"]
```

Then append two new tests to the end of the file, following the same `monkeypatch`-fixture pattern as the existing `test_level_endpoint_survey_mode_without_area_path_skips_kb_retrieval` test:

```python
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
    assert response.json()["kb_citations"] == []


def test_level_endpoint_baseline_mode_has_empty_kb_citations() -> None:
    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr("x.txt"))],
    )
    response = client.post("/level", json=doc.model_dump(mode="json"))
    assert response.status_code == 200
    assert response.json()["kb_citations"] == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_level_endpoint.py -v`
Expected: FAIL on `test_level_endpoint_survey_mode_with_area_path_injects_kb_context` (mock now returns a tuple where a bare string was expected — breaks `_with_kb_context`'s `if kb_context is None` check inside `llm_leveling.py`'s consumers since `kb_context` briefly held a tuple before Task 2 landed; if Task 2 is already merged, this instead just fails the new `kb_citations` assertion, which is the real target) and on the two new tests (`kb_citations` key doesn't exist without Task 2, or exists but this locks it at the HTTP layer).

- [ ] **Step 3: Implement**

No implementation changes — Task 2 already made `WorkItemTree` (and therefore `/level`'s JSON response) carry `kb_citations`. This step is a no-op; proceed to Step 4.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_level_endpoint.py -v`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add ingestion/tests/test_level_endpoint.py
git commit -m "test(level): lock kb_citations into the /level response contract"
```

---

## Task 4: Fix the latent bug — forward `area_path` to ingestion's `/level`

**Files:**
- Modify: `orchestrator/src/modules/pipeline/ingestion-http.client.ts`
- Test: `orchestrator/test/ingestion-http.client.spec.ts`

**Why this task exists:** `IngestionHttpClient.level()` currently takes only `(doc, customerId, mode)` — it never sends `area_path` to ingestion's `/level` endpoint. Since `/level`'s KB retrieval (P2b, P2c) is gated entirely on `area_path` being present, **the real orchestrator pipeline has never actually triggered KB grounding** — `kb_context`/`kb_citations` are always `(None, [])` in every real job today, regardless of how much KB content is ingested for that area path. Without this fix, P3c's Sources section would never show a KB line in production. This is a bug in existing P2b/P2c wiring, not new P3c scope, but it must be fixed for P3c's KB-citation path to ever be reachable.

**Interfaces:**
- Produces: `IngestionHttpClient.level(doc, customerId, mode?, areaPath?) -> Promise<Record<string, unknown>>` — 4th param optional, appended as `area_path` query param only when provided.

- [ ] **Step 1: Write the failing test**

Add to `orchestrator/test/ingestion-http.client.spec.ts`, inside the existing `describe('IngestionHttpClient.level', ...)` block (alongside the tests shown in Context above):

```typescript
  it('forwards area_path as a query param when provided', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level({ blocks: [] }, 'CUST-1', 'survey', 'Project\\Area1');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/level?mode=survey&customer_id=CUST-1&area_path=Project%5CArea1');
  });

  it('omits area_path when not provided, matching pre-existing behavior', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level({ blocks: [] }, 'CUST-1', 'survey');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/level?mode=survey&customer_id=CUST-1');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd orchestrator && npx jest test/ingestion-http.client.spec.ts -t "area_path"`
Expected: FAIL on the first new test — `level()` only accepts 3 params today, so the 4th argument is silently ignored and the URL never contains `area_path`.

- [ ] **Step 3: Implement**

In `orchestrator/src/modules/pipeline/ingestion-http.client.ts`, change:

```typescript
  async level(
    doc: Record<string, unknown>,
    customerId: string | null,
    mode: 'baseline' | 'survey' = 'baseline',
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ mode });
    if (customerId) params.set('customer_id', customerId);
```

to:

```typescript
  async level(
    doc: Record<string, unknown>,
    customerId: string | null,
    mode: 'baseline' | 'survey' = 'baseline',
    areaPath?: string,
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ mode });
    if (customerId) params.set('customer_id', customerId);
    if (areaPath) params.set('area_path', areaPath);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd orchestrator && npx jest test/ingestion-http.client.spec.ts`
Expected: PASS (all tests in the file, including the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/modules/pipeline/ingestion-http.client.ts orchestrator/test/ingestion-http.client.spec.ts
git commit -m "fix(pipeline): forward area_path to ingestion's /level, activating KB retrieval in the real pipeline"
```

---

## Task 5: Persist `kbCitations` on the `Job` row

**Files:**
- Modify: `orchestrator/prisma/schema.prisma`
- Create: `orchestrator/prisma/migrations/<timestamp>_add_job_kb_citations/migration.sql` (generated, not hand-written)
- Modify: `orchestrator/src/modules/pipeline/pipeline.worker.ts`
- Test: `orchestrator/test/pipeline.worker.spec.ts`

**Interfaces:**
- Consumes: `IngestionHttpClient.level(doc, customerId, mode, areaPath)` from Task 4; `job.areaPath` from `PipelineJobInput` (already exists).
- Produces: `Job.kbCitations: string[]` column, persisted alongside `dryRunDiff` on the `diff_ready` transition.

- [ ] **Step 1: Write the failing tests**

In `orchestrator/test/pipeline.worker.spec.ts`, update the existing test `'updates the Job row status to diff_ready and stores the diff on success'` (currently lines 56-76) — change its final assertion from:

```typescript
    expect(fakePrisma.job.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: { status: 'diff_ready', dryRunDiff: [] },
    });
```

to:

```typescript
    expect(fakePrisma.job.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: { status: 'diff_ready', dryRunDiff: [], kbCitations: [] },
    });
```

Then add two new tests, appended to the `describe` block (before its closing `});`):

```typescript
  it('passes job.areaPath through to ingestionClient.level as the 4th argument', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', customerId: null, mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
      },
    );

    expect(fakeIngestionClient.level).toHaveBeenCalledWith({ blocks: [] }, null, 'survey', 'Project\\Area1');
  });

  it("persists the tree's kb_citations onto the Job row alongside dryRunDiff", async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({ nodes: [], kb_citations: ['doc-a.docx', 'doc-b.pdf'] });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', customerId: null, mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
      },
    );

    expect(fakePrisma.job.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: { status: 'diff_ready', dryRunDiff: [], kbCitations: ['doc-a.docx', 'doc-b.pdf'] },
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd orchestrator && npx jest test/pipeline.worker.spec.ts`
Expected: FAIL — the updated exact-match assertion fails because `data` doesn't yet include `kbCitations`; the "passes job.areaPath" test fails because `level()` is still called with only 3 args; the "persists kb_citations" test fails for the same reason as the updated assertion.

- [ ] **Step 3: Implement**

In `orchestrator/prisma/schema.prisma`, change the `Job` model's `dryRunDiff` line:

```prisma
  dryRunDiff       Json?
```

to:

```prisma
  dryRunDiff       Json?
  kbCitations      String[] @default([])
```

Generate the migration:

```bash
cd orchestrator && DATABASE_URL="postgresql://postgres:postgres@localhost:5434/req2ado" npx prisma migrate dev --name add_job_kb_citations
```

(Adjust the connection string to match whatever the local docker-compose Postgres credentials actually are — check `docker-compose.yml`'s `postgres` service env if unsure. Port `5434` per the known `orchestrator/.env` quirk in Global Constraints.)

In `orchestrator/src/modules/pipeline/pipeline.worker.ts`, change the `LeveledNode` interface's neighboring type — add a new field to the tree-cast type. Change:

```typescript
    const tree = (await deps.ingestionClient.level(doc, job.customerId, job.mode)) as { nodes: LeveledNode[] };
```

to:

```typescript
    const tree = (await deps.ingestionClient.level(doc, job.customerId, job.mode, job.areaPath)) as {
      nodes: LeveledNode[];
      kb_citations?: string[];
    };
```

Then change:

```typescript
    await deps.prisma.job.update({
      where: { id: job.id },
      data: { status: 'diff_ready', dryRunDiff: diff as any },
    });
```

to:

```typescript
    await deps.prisma.job.update({
      where: { id: job.id },
      data: { status: 'diff_ready', dryRunDiff: diff as any, kbCitations: tree.kb_citations ?? [] },
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd orchestrator && npx jest test/pipeline.worker.spec.ts`
Expected: PASS (all tests, including the 2 new ones).

Also run the full orchestrator suite to confirm the migration and schema change didn't break anything unrelated:

Run: `cd orchestrator && npx jest`
Expected: PASS (previous full-suite count was 173 tests per the P3b handoff notes — expect that number plus the tests added in this task and Task 4/6).

- [ ] **Step 5: Commit**

```bash
git add orchestrator/prisma/schema.prisma orchestrator/prisma/migrations orchestrator/src/modules/pipeline/pipeline.worker.ts orchestrator/test/pipeline.worker.spec.ts
git commit -m "feat(pipeline): persist kb_citations onto the Job row alongside dryRunDiff"
```

---

## Task 6: Expose `kbCitations` on `GET /jobs/:id`

**Files:**
- Modify: `orchestrator/src/modules/pipeline/jobs.service.ts`
- Modify: `orchestrator/src/modules/pipeline/jobs.controller.ts`
- Test: `orchestrator/test/jobs.service.spec.ts`

**Interfaces:**
- Consumes: `Job.kbCitations` column from Task 5.
- Produces: `JobsService.getById(id) -> Promise<{ id, status, mode, dryRunDiff, kbCitations } | null>`. `GET /jobs/:id` response gains `kbCitations: string[]`.

- [ ] **Step 1: Write the failing test**

Add to `orchestrator/test/jobs.service.spec.ts`, as a new top-level `describe` block appended to the end of the file:

```typescript
describe('JobsService.getById', () => {
  it('returns kbCitations alongside the existing job fields', async () => {
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: 'diff_ready',
          mode: 'survey',
          dryRunDiff: [{ localId: 'n0' }],
          kbCitations: ['doc-a.docx'],
        }),
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.getById('job-1');

    expect(result).toEqual({
      id: 'job-1',
      status: 'diff_ready',
      mode: 'survey',
      dryRunDiff: [{ localId: 'n0' }],
      kbCitations: ['doc-a.docx'],
    });
  });

  it('returns null for an unknown job', async () => {
    const prisma = { job: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    expect(await service.getById('missing')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd orchestrator && npx jest test/jobs.service.spec.ts -t "getById"`
Expected: FAIL — the first test's `toEqual` fails because `getById()` doesn't yet include `kbCitations` in its returned object.

- [ ] **Step 3: Implement**

In `orchestrator/src/modules/pipeline/jobs.service.ts`, change:

```typescript
  async getById(id: string): Promise<{ id: string; status: string; mode: string; dryRunDiff: unknown } | null> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) return null;
    return { id: job.id, status: job.status, mode: job.mode, dryRunDiff: job.dryRunDiff };
  }
```

to:

```typescript
  async getById(
    id: string,
  ): Promise<{ id: string; status: string; mode: string; dryRunDiff: unknown; kbCitations: string[] } | null> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) return null;
    return { id: job.id, status: job.status, mode: job.mode, dryRunDiff: job.dryRunDiff, kbCitations: job.kbCitations };
  }
```

In `orchestrator/src/modules/pipeline/jobs.controller.ts`, change:

```typescript
  @Get(':id')
  async getById(@Param('id') id: string): Promise<{ id: string; status: string; mode: string; dryRunDiff: unknown }> {
    const job = await this.jobsService.getById(id);
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    return job;
  }
```

to:

```typescript
  @Get(':id')
  async getById(
    @Param('id') id: string,
  ): Promise<{ id: string; status: string; mode: string; dryRunDiff: unknown; kbCitations: string[] }> {
    const job = await this.jobsService.getById(id);
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    return job;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd orchestrator && npx jest test/jobs.service.spec.ts test/jobs.controller.e2e-spec.ts`
Expected: PASS (all tests — the e2e spec mocks `getById` directly and doesn't assert on `kbCitations`'s absence, so it's unaffected by the wider return type).

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/modules/pipeline/jobs.service.ts orchestrator/src/modules/pipeline/jobs.controller.ts orchestrator/test/jobs.service.spec.ts
git commit -m "feat(jobs): expose kbCitations on GET /jobs/:id"
```

---

## Task 7: Frontend — thread `kbCitations`/`mode` into `JobDetail` state

**Files:**
- Modify: `frontend/src/store/jobsStore.ts`
- Modify: `frontend/src/pages/JobDetail.tsx`

**Interfaces:**
- Consumes: `GET /jobs/:id`'s `kbCitations` field from Task 6.
- Produces: `JobDetail.kbCitations?: string[]` type. `JobDetail.tsx` holds `kbCitations` state and passes `jobMode`/`kbCitations` props into `NodeDetailPanel` (consumed by Task 8).

No test file for this task in isolation — it's pure plumbing with no independently-testable behavior of its own; Task 8's `NodeDetailPanel` tests are what exercise this wiring (passing `jobMode`/`kbCitations` as direct props, matching how `AddChildForm`'s `jobMode` prop is already tested independently of `JobDetail.tsx`). Verified via the frontend build + Task 8's tests, not a dedicated unit test here.

- [ ] **Step 1: Implement the type change**

In `frontend/src/store/jobsStore.ts`, change:

```typescript
export interface JobDetail {
  id: string;
  status: string;
  mode: string;
  dryRunDiff: unknown;
}
```

to:

```typescript
export interface JobDetail {
  id: string;
  status: string;
  mode: string;
  dryRunDiff: unknown;
  kbCitations?: string[];
}
```

- [ ] **Step 2: Wire state and props in `JobDetail.tsx`**

In `frontend/src/pages/JobDetail.tsx`, add a new state hook right after the existing `mode` state (currently line 24):

```typescript
  const [mode, setMode] = useState<string | null>(null);
  const [kbCitations, setKbCitations] = useState<string[]>([]);
```

In the initial-load `useEffect` (currently lines 32-44), change:

```typescript
    getJob(id).then((job) => {
      if (cancelled) return;
      setStatus(job.status);
      setMode(job.mode);
      setDiff((job.dryRunDiff as DryRunDiffEntry[] | null) ?? []);
    });
```

to:

```typescript
    getJob(id).then((job) => {
      if (cancelled) return;
      setStatus(job.status);
      setMode(job.mode);
      setKbCitations(job.kbCitations ?? []);
      setDiff((job.dryRunDiff as DryRunDiffEntry[] | null) ?? []);
    });
```

Finally, pass the new props into `NodeDetailPanel` (currently line 143):

```typescript
            <NodeDetailPanel jobId={id!} entry={selectedEntry} onSave={handleSaveEdit} />
```

to:

```typescript
            <NodeDetailPanel
              jobId={id!}
              entry={selectedEntry}
              jobMode={mode as 'baseline' | 'survey' | null}
              kbCitations={kbCitations}
              onSave={handleSaveEdit}
            />
```

- [ ] **Step 3: Verify the frontend still builds**

Run: `cd frontend && npm run build`
Expected: fails at this point with a TS error — `NodeDetailPanel` doesn't yet accept `jobMode`/`kbCitations` props. This is expected; Task 8 adds them. Do not attempt to make this task's build pass standalone — commit Tasks 7 and 8 together if a clean intermediate state matters, or proceed directly to Task 8 without a separate commit here.

- [ ] **Step 4: Commit** (deferred to Task 8 — see Step 3 note)

No standalone commit for this task; its changes are committed together with Task 8's in that task's Step 5.

---

## Task 8: Frontend — "Sources" section in `NodeDetailPanel`

**Files:**
- Modify: `frontend/src/components/NodeDetailPanel.tsx`
- Test: `frontend/src/components/NodeDetailPanel.test.tsx`

**Interfaces:**
- Consumes: `jobMode?: 'baseline' | 'survey' | null` and `kbCitations?: string[]` — new props from Task 7's `JobDetail.tsx` call site.
- Produces: a "Sources" section, visible only when `jobMode === 'survey'` and `entry.action === 'create'`.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/components/NodeDetailPanel.test.tsx`, as new `it` blocks inside the existing `describe('NodeDetailPanel', ...)`:

```typescript
  it('shows the standards line and KB references for a SURVEY create entry with citations', () => {
    renderPanel(
      <NodeDetailPanel
        jobId="job-1"
        jobMode="survey"
        kbCitations={['doc-a.docx', 'doc-b.pdf']}
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
      />,
    );
    expect(screen.getByText(/EARS, INCOSE, ISO\/IEC\/IEEE 29148/)).toBeInTheDocument();
    expect(screen.getByText(/doc-a\.docx, doc-b\.pdf/)).toBeInTheDocument();
  });

  it('shows the standards line but no KB references line when kbCitations is empty', () => {
    renderPanel(
      <NodeDetailPanel
        jobId="job-1"
        jobMode="survey"
        kbCitations={[]}
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
      />,
    );
    expect(screen.getByText(/EARS, INCOSE, ISO\/IEC\/IEEE 29148/)).toBeInTheDocument();
    expect(screen.queryByText(/KB references/i)).not.toBeInTheDocument();
  });

  it('does not show the Sources section for a BASELINE job', () => {
    renderPanel(
      <NodeDetailPanel
        jobId="job-1"
        jobMode="baseline"
        kbCitations={[]}
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
      />,
    );
    expect(screen.queryByText(/EARS, INCOSE, ISO\/IEC\/IEEE 29148/)).not.toBeInTheDocument();
  });

  it('does not show the Sources section for a reuse entry, even in a SURVEY job', () => {
    renderPanel(
      <NodeDetailPanel
        jobId="job-1"
        jobMode="survey"
        kbCitations={['doc-a.docx']}
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'reuse', existingAdoId: 42, customerId: null, tags: [] }}
      />,
    );
    expect(screen.queryByText(/EARS, INCOSE, ISO\/IEC\/IEEE 29148/)).not.toBeInTheDocument();
  });

  it('does not show the Sources section when jobMode is omitted (backward compatible with pre-existing callers)', () => {
    renderPanel(
      <NodeDetailPanel
        jobId="job-1"
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
      />,
    );
    expect(screen.queryByText(/EARS, INCOSE, ISO\/IEC\/IEEE 29148/)).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/NodeDetailPanel.test.tsx`
Expected: FAIL on the first 4 new tests (`NodeDetailPanel` doesn't accept `jobMode`/`kbCitations` props yet, and renders no Sources section at all); the 5th test passes trivially (no such text exists yet regardless).

- [ ] **Step 3: Implement**

In `frontend/src/components/NodeDetailPanel.tsx`, change the props destructuring:

```typescript
export function NodeDetailPanel({
  jobId,
  entry,
  onSave,
}: {
  jobId: string;
  entry: DryRunDiffEntry | null;
  onSave?: (localId: string, patch: { title: string; description: string }) => void;
}): React.ReactElement {
```

to:

```typescript
export function NodeDetailPanel({
  jobId,
  entry,
  jobMode,
  kbCitations,
  onSave,
}: {
  jobId: string;
  entry: DryRunDiffEntry | null;
  jobMode?: 'baseline' | 'survey' | null;
  kbCitations?: string[];
  onSave?: (localId: string, patch: { title: string; description: string }) => void;
}): React.ReactElement {
```

Then add the Sources section to the read-only render branch. Change:

```typescript
      <TagChips tags={entry.tags} />
      {entry.qualityScore != null && (
        <>
          <Typography variant="body2">Quality score: {entry.qualityScore} / 100</Typography>
          <IssueChips issues={entry.qualityIssues} />
        </>
      )}
      {canEdit && <Button onClick={startEditing}>Edit</Button>}
```

to:

```typescript
      <TagChips tags={entry.tags} />
      {entry.qualityScore != null && (
        <>
          <Typography variant="body2">Quality score: {entry.qualityScore} / 100</Typography>
          <IssueChips issues={entry.qualityIssues} />
        </>
      )}
      {jobMode === 'survey' && entry.action === 'create' && (
        <Box mt={1}>
          <Typography variant="subtitle2">Sources</Typography>
          <Typography variant="body2">Judged against EARS, INCOSE, ISO/IEC/IEEE 29148</Typography>
          {kbCitations && kbCitations.length > 0 && (
            <Typography variant="body2">KB references: {kbCitations.join(', ')}</Typography>
          )}
        </Box>
      )}
      {canEdit && <Button onClick={startEditing}>Edit</Button>}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/NodeDetailPanel.test.tsx`
Expected: PASS (all tests, including the 5 new ones and every pre-existing test — the new props are optional and default to rendering nothing extra).

Then verify the full frontend build succeeds (this also closes out Task 7's Step 3, which was left intentionally broken):

Run: `cd frontend && npm run build`
Expected: PASS.

Then run the full frontend test suite to confirm no regressions elsewhere:

Run: `cd frontend && npx vitest run`
Expected: PASS (previous full count was 62 tests per the P3b handoff notes — expect that plus this task's 5 new tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/store/jobsStore.ts frontend/src/pages/JobDetail.tsx frontend/src/components/NodeDetailPanel.tsx frontend/src/components/NodeDetailPanel.test.tsx
git commit -m "feat(frontend): render a Sources section (KB citations + standards baseline) in NodeDetailPanel"
```

---

## Final verification

- [ ] Run the full ingestion suite: `cd ingestion && .venv/bin/python -m pytest` — expect no new failures beyond the 7 pre-existing OCR/poppler failures noted in the P3b handoff.
- [ ] Run the full orchestrator suite: `cd orchestrator && npx jest` — expect all green.
- [ ] Run the full frontend suite: `cd frontend && npx vitest run` — expect all green.
- [ ] Manual smoke test against a real docker-compose stack (per this repo's established live-verification pattern): ingest a real KB document into an area path (`POST /kb/ingest-url`), submit a SURVEY job against a document in that same area path, open the resulting job's diff, select a `create` node, and confirm the Sources section shows both the standards line and the KB reference to the ingested document. This is the first real-world exercise of Task 4's bug fix — the KB grounding this whole feature displays has never actually fired against a real job before this plan.
