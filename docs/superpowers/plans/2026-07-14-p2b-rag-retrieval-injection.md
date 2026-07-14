# P2b RAG Retrieval-Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ground SURVEY mode's `infer_hierarchy` and `generate_requirements_for_document` LLM calls with relevant KB material (retrieved from the existing `req2ado_kb_<hash>` Chroma collections) when it exists, falling back cleanly to baseline model knowledge when it doesn't.

**Architecture:** A new `retrieve_context()` helper embeds the document outline once, queries the area-path-scoped `KbVectorStore`, and returns a joined context string (or `None`). `build_survey_tree` calls it once per document and threads the result into both LLM Protocol methods, which prepend it to their system prompts when present. All new KB-related parameters are optional with `None` defaults, so every existing call site keeps working unchanged except the four test fakes that must accept the new `kb_context` keyword (Task 4).

**Tech Stack:** Python, FastAPI, chromadb, httpx, pytest. All work is in `ingestion/`.

## Global Constraints

- Retrieval must never raise out of `retrieve_context` — any embed/query failure is caught, logged as a warning, and treated identically to "no KB material" (returns `None`).
- No doc_type filtering — query the whole area_path KB collection.
- One retrieval per document (the outline), not per node/block.
- Top-k = 5, similarity cutoff = 0.3 (i.e. chromadb cosine distance ≤ 0.7).
- All new params (`area_path`, `embed_client`, `vector_store`, `kb_context`) default to `None` wherever added, so pre-existing callers/tests that don't know about KB retrieval keep working without modification.
- `ingestion/tests` run via `.venv/bin/python -m pytest` (not bare `pytest`).

---

### Task 1: `KbVectorStore.query` — nearest-chunk retrieval

**Files:**
- Modify: `ingestion/app/kb/kb_vector_store.py`
- Test: `ingestion/tests/kb/test_kb_vector_store.py`

**Interfaces:**
- Produces: `KbVectorStore.query(area_path: str, embedding: list[float], top_k: int) -> list[dict]`, each dict shaped `{"text": str, "distance": float, "source_file": str}`. Returns `[]` if the collection has no chunks (mirrors `ChromaVectorStore.query_nearest`'s `count() == 0` guard in `app/dedup/vector_store.py:41`).

- [ ] **Step 1: Write the failing tests**

Add to `ingestion/tests/kb/test_kb_vector_store.py`:

```python
def test_query_returns_empty_list_for_a_never_ingested_area_path() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        assert store.query("Project\\Area1", embedding=[1.0, 0.0, 0.0], top_k=5) == []


def test_query_returns_nearest_chunks_ordered_by_distance() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.upsert_chunk(
            chunk_id="source-1:doc.txt:0", embedding=[1.0, 0.0, 0.0], text="near chunk",
            area_path="Project\\Area1", source_file="doc.txt", source_id="source-1",
            chunk_index=0, file_hash="hash-1",
        )
        store.upsert_chunk(
            chunk_id="source-1:doc.txt:1", embedding=[0.0, 1.0, 0.0], text="far chunk",
            area_path="Project\\Area1", source_file="doc.txt", source_id="source-1",
            chunk_index=1, file_hash="hash-1",
        )
        results = store.query("Project\\Area1", embedding=[1.0, 0.0, 0.0], top_k=5)
        assert len(results) == 2
        assert results[0]["text"] == "near chunk"
        assert results[0]["source_file"] == "doc.txt"
        assert results[0]["distance"] < results[1]["distance"]


def test_query_respects_top_k() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        for i in range(3):
            store.upsert_chunk(
                chunk_id=f"source-1:doc.txt:{i}", embedding=[1.0, float(i), 0.0], text=f"chunk {i}",
                area_path="Project\\Area1", source_file="doc.txt", source_id="source-1",
                chunk_index=i, file_hash="hash-1",
            )
        results = store.query("Project\\Area1", embedding=[1.0, 0.0, 0.0], top_k=2)
        assert len(results) == 2
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/kb/test_kb_vector_store.py -v -k test_query`
Expected: FAIL with `AttributeError: 'KbVectorStore' object has no attribute 'query'`

- [ ] **Step 3: Implement `query`**

Add to `ingestion/app/kb/kb_vector_store.py`, after `delete_file_chunks`:

```python
    def query(self, area_path: str, embedding: list[float], top_k: int) -> list[dict]:
        """Returns up to top_k nearest chunks for this area_path's KB
        collection, ordered nearest-first, each as {text, distance,
        source_file}. distance is chromadb's cosine distance (lower =
        closer) — callers apply their own similarity cutoff. Empty list
        if the collection has no chunks (mirrors ChromaVectorStore.
        query_nearest's empty-collection guard)."""
        collection = self._get_collection(area_path)
        if collection.count() == 0:
            return []
        result = collection.query(query_embeddings=[embedding], n_results=top_k)
        documents = result["documents"][0]
        distances = result["distances"][0]
        metadatas = result["metadatas"][0]
        return [
            {"text": documents[i], "distance": distances[i], "source_file": metadatas[i]["source_file"]}
            for i in range(len(documents))
        ]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ingestion && .venv/bin/python -m pytest tests/kb/test_kb_vector_store.py -v`
Expected: PASS (all tests in the file, including the pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/kb/kb_vector_store.py ingestion/tests/kb/test_kb_vector_store.py
git commit -m "feat(kb): add KbVectorStore.query for nearest-chunk retrieval"
```

---

### Task 2: `retrieve_context` — embed + query + threshold, failure-safe

**Files:**
- Create: `ingestion/app/kb/retrieval.py`
- Test: `ingestion/tests/kb/test_retrieval.py`

**Interfaces:**
- Consumes: `KbVectorStore.query(area_path, embedding, top_k) -> list[dict]` (Task 1). An embed client duck-typed as `embed(texts: list[str]) -> list[list[float]]` (matches `OrchestratorEmbedClient.embed` in `app/dedup/orchestrator_embed_client.py:15`).
- Produces: `retrieve_context(area_path: str, query_text: str, embed_client, vector_store: KbVectorStore, top_k: int = 5, max_distance: float = 0.7) -> str | None`.

- [ ] **Step 1: Write the failing tests**

Create `ingestion/tests/kb/test_retrieval.py`:

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


def test_retrieve_context_returns_none_for_empty_collection(tmp_path) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    result = retrieve_context("Project\\Area1", "some outline", FakeEmbedClient(), store)
    assert result is None


def test_retrieve_context_joins_hits_within_threshold(tmp_path) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    store.upsert_chunk(
        chunk_id="s1:doc.txt:0", embedding=[1.0, 0.0, 0.0], text="close chunk text",
        area_path="Project\\Area1", source_file="doc.txt", source_id="s1", chunk_index=0, file_hash="h1",
    )
    result = retrieve_context("Project\\Area1", "some outline", FakeEmbedClient(embedding=[1.0, 0.0, 0.0]), store)
    assert result == "close chunk text"


def test_retrieve_context_discards_hits_below_similarity_bar(tmp_path) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    # Orthogonal embedding -> cosine distance 1.0 -> similarity 0.0, well below the 0.3 cutoff.
    store.upsert_chunk(
        chunk_id="s1:doc.txt:0", embedding=[0.0, 1.0, 0.0], text="unrelated chunk",
        area_path="Project\\Area1", source_file="doc.txt", source_id="s1", chunk_index=0, file_hash="h1",
    )
    result = retrieve_context("Project\\Area1", "some outline", FakeEmbedClient(embedding=[1.0, 0.0, 0.0]), store)
    assert result is None


def test_retrieve_context_returns_none_and_logs_warning_when_embed_raises(tmp_path, caplog) -> None:
    store = KbVectorStore(persist_path=str(tmp_path))
    embed_client = FakeEmbedClient(raises=RuntimeError("orchestrator unreachable"))
    with caplog.at_level(logging.WARNING):
        result = retrieve_context("Project\\Area1", "some outline", embed_client, store)
    assert result is None
    assert "orchestrator unreachable" in caplog.text


def test_retrieve_context_returns_none_and_logs_warning_when_query_raises(caplog) -> None:
    with caplog.at_level(logging.WARNING):
        result = retrieve_context("Project\\Area1", "some outline", FakeEmbedClient(), RaisingVectorStore())
    assert result is None
    assert "chroma unavailable" in caplog.text
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/kb/test_retrieval.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.kb.retrieval'`

- [ ] **Step 3: Implement `retrieve_context`**

Create `ingestion/app/kb/retrieval.py`:

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
) -> str | None:
    """Embeds query_text, queries the KB collection for area_path, keeps
    hits with distance <= max_distance (cosine similarity >= 0.3), and
    joins their text with a blank-line separator. Returns None when the
    collection is empty, no hit clears the similarity bar, or the
    embed/query call itself raises (network failure, Chroma error) — KB
    retrieval is an enhancement, not a hard dependency, and must never
    fail or block a SURVEY job. Any exception is caught and logged here;
    this is the single seam that makes KB failure non-fatal for callers."""
    try:
        [embedding] = embed_client.embed([query_text])
        hits = vector_store.query(area_path, embedding, top_k)
    except Exception as exc:  # noqa: BLE001 - retrieval must never fail a SURVEY job
        logger.warning("KB retrieval failed for area_path=%s: %s", area_path, exc)
        return None

    survivors = [hit["text"] for hit in hits if hit["distance"] <= max_distance]
    if not survivors:
        return None
    return "\n\n".join(survivors)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ingestion && .venv/bin/python -m pytest tests/kb/test_retrieval.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/kb/retrieval.py ingestion/tests/kb/test_retrieval.py
git commit -m "feat(kb): add retrieve_context, failure-safe KB retrieval for SURVEY"
```

---

### Task 3: `OrchestratorLlmClient` — prepend KB context to system prompts

**Files:**
- Modify: `ingestion/app/survey/orchestrator_llm_client.py`
- Test: `ingestion/tests/test_orchestrator_llm_client.py`

**Interfaces:**
- Consumes: nothing new from other tasks (pure string handling).
- Produces: `infer_hierarchy(self, outline: str, profile_hint: object | None, kb_context: str | None = None) -> list[dict]` and `generate_requirements_for_document(self, blocks_by_node_id: dict[str, str], kb_context: str | None = None) -> dict[str, list[dict]]` — both with the new trailing optional param. When `kb_context` is `None`, system prompt is byte-identical to today's.

- [ ] **Step 1: Write the failing tests**

Add to `ingestion/tests/test_orchestrator_llm_client.py`:

```python
def test_infer_hierarchy_prepends_kb_context_when_present() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["system_prompt"] = json.loads(request.content)["messages"][0]["content"]
        return httpx.Response(200, json={"content": "[]"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.infer_hierarchy("some outline", None, kb_context="Reference chunk about displays.")
    assert captured["system_prompt"].startswith(
        "Reference material from the knowledge base (may be incomplete or "
        "irrelevant — use only what's genuinely helpful):\n\n"
        "Reference chunk about displays.\n\n"
    )
    assert "You infer a work-item hierarchy" in captured["system_prompt"]


def test_infer_hierarchy_prompt_unchanged_when_kb_context_is_none() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["system_prompt"] = json.loads(request.content)["messages"][0]["content"]
        return httpx.Response(200, json={"content": "[]"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.infer_hierarchy("some outline", None)
    assert captured["system_prompt"].startswith("You infer a work-item hierarchy")
    assert "Reference material from the knowledge base" not in captured["system_prompt"]


def test_generate_requirements_for_document_prepends_kb_context_when_present() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["system_prompt"] = json.loads(request.content)["messages"][0]["content"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.generate_requirements_for_document({"0": "text"}, kb_context="Reference chunk about displays.")
    assert captured["system_prompt"].startswith(
        "Reference material from the knowledge base (may be incomplete or "
        "irrelevant — use only what's genuinely helpful):\n\n"
        "Reference chunk about displays.\n\n"
    )
    assert "You convert several informal requirement blocks" in captured["system_prompt"]


def test_generate_requirements_for_document_prompt_unchanged_when_kb_context_is_none() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["system_prompt"] = json.loads(request.content)["messages"][0]["content"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.generate_requirements_for_document({"0": "text"})
    assert captured["system_prompt"].startswith("You convert several informal requirement blocks")
    assert "Reference material from the knowledge base" not in captured["system_prompt"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_orchestrator_llm_client.py -v -k kb_context`
Expected: FAIL with `TypeError: infer_hierarchy() got an unexpected keyword argument 'kb_context'`

- [ ] **Step 3: Implement the prepend**

In `ingestion/app/survey/orchestrator_llm_client.py`, add a module-level helper right after `_strip_json_fence`:

```python
def _with_kb_context(system_prompt: str, kb_context: str | None) -> str:
    if kb_context is None:
        return system_prompt
    return (
        "Reference material from the knowledge base (may be incomplete or "
        "irrelevant — use only what's genuinely helpful):\n\n"
        f"{kb_context}\n\n"
        f"{system_prompt}"
    )
```

Change `infer_hierarchy`'s signature (line 75) to:

```python
    def infer_hierarchy(self, outline: str, profile_hint: object | None, kb_context: str | None = None) -> list[dict]:
```

and immediately before its `payload = {...}` block, add:

```python
        system_prompt = _with_kb_context(system_prompt, kb_context)
```

Change `generate_requirements_for_document`'s signature (line 109) to:

```python
    def generate_requirements_for_document(
        self, blocks_by_node_id: dict[str, str], kb_context: str | None = None
    ) -> dict[str, list[dict]]:
```

and immediately before its `payload = {...}` block, add:

```python
        system_prompt = _with_kb_context(system_prompt, kb_context)
```

(`generate_requirements`, the single-block non-batched method, is untouched — out of scope per the design spec, which only covers the two whole-document SURVEY calls.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_orchestrator_llm_client.py -v`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/survey/orchestrator_llm_client.py ingestion/tests/test_orchestrator_llm_client.py
git commit -m "feat(survey): prepend KB context to infer_hierarchy/generate_requirements_for_document prompts"
```

---

### Task 4: `build_survey_tree` — wire retrieval in, once per document

**Files:**
- Modify: `ingestion/app/leveling/llm_leveling.py`
- Modify: `ingestion/tests/test_llm_leveling.py`
- Modify: `ingestion/tests/test_worktree_schema_conformance.py`

**Interfaces:**
- Consumes: `retrieve_context(area_path, query_text, embed_client, vector_store, top_k=5, max_distance=0.7) -> str | None` (Task 2). `KbVectorStore` (Task 1, only used as a type import for the new param's annotation).
- Produces: `build_survey_tree(doc, llm_client, requirement_client, area_path=None, embed_client=None, vector_store=None) -> WorkItemTree`. `LlmLevelingClient.infer_hierarchy(self, outline, profile_hint, kb_context=None)` and `BatchedRequirementClient.generate_requirements_for_document(self, blocks_by_node_id, kb_context=None)` Protocol signatures both gain the trailing optional param.

- [ ] **Step 1: Write the failing tests**

First, update the two existing fakes so they accept the new keyword (both are called positionally-then-keyword elsewhere in the file, so adding a defaulted param is safe). In `ingestion/tests/test_llm_leveling.py`, change `FakeLlmLevelingClient.infer_hierarchy` (line 26):

```python
    def infer_hierarchy(self, outline: str, profile_hint: str | None, kb_context: str | None = None) -> list[dict]:
```

and `FakeBatchedRequirementClient.generate_requirements_for_document` (line 47):

```python
    def generate_requirements_for_document(
        self, blocks_by_node_id: dict[str, str], kb_context: str | None = None
    ) -> dict[str, list[dict]]:
```

Also update the two inline fakes further down in the same file: `_FlatHierarchyClient.infer_hierarchy` (around line 135) and `_SingleObjectHierarchyClient.infer_hierarchy` (around line 170) get the same trailing `kb_context: str | None = None` param added to their signatures (bodies unchanged).

In `ingestion/tests/test_worktree_schema_conformance.py`, update the fake's `infer_hierarchy` (line 56) the same way:

```python
    def infer_hierarchy(self, outline: str, profile_hint: str | None, kb_context: str | None = None) -> list[dict]:
```

Now add new tests to `ingestion/tests/test_llm_leveling.py` (append at the end of the file):

```python
def test_build_survey_tree_without_area_path_skips_retrieval_entirely() -> None:
    # No area_path/embed_client/vector_store supplied -> retrieval must not
    # even be attempted. Proven by the fake raising if kb_context ever
    # arrives non-None (it never should, since retrieval was skipped).
    class _AssertingHierarchyClient:
        def infer_hierarchy(self, outline: str, profile_hint: str | None, kb_context: str | None = None) -> list[dict]:
            assert kb_context is None
            return [{"node_id": "0", "type": "Feature", "parent_id": None}, {"node_id": "1", "type": "Requirement", "parent_id": "0"}]

    tree = build_survey_tree(_small_doc(), _AssertingHierarchyClient(), FakeBatchedRequirementClient())
    assert len(tree.nodes) == 2


def test_build_survey_tree_threads_kb_context_into_both_calls(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    captured: dict[str, str | None] = {}

    class _CapturingHierarchyClient:
        def infer_hierarchy(self, outline: str, profile_hint: str | None, kb_context: str | None = None) -> list[dict]:
            captured["hierarchy_kb_context"] = kb_context
            return [{"node_id": "0", "type": "Feature", "parent_id": None}, {"node_id": "1", "type": "Requirement", "parent_id": "0"}]

    class _CapturingRequirementClient:
        def generate_requirements_for_document(
            self, blocks_by_node_id: dict[str, str], kb_context: str | None = None
        ) -> dict[str, list[dict]]:
            captured["requirements_kb_context"] = kb_context
            return {node_id: [{"text": f"shall {text}", "tags": []}] for node_id, text in blocks_by_node_id.items()}

    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda area_path, query_text, embed_client, vector_store, **_: "injected KB text",
    )

    build_survey_tree(
        _small_doc(),
        _CapturingHierarchyClient(),
        _CapturingRequirementClient(),
        area_path="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
    )
    assert captured["hierarchy_kb_context"] == "injected KB text"
    assert captured["requirements_kb_context"] == "injected KB text"


def test_build_survey_tree_calls_retrieve_context_exactly_once(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    call_count = {"n": 0}

    def _fake_retrieve_context(area_path, query_text, embed_client, vector_store, **_):
        call_count["n"] += 1
        return None

    monkeypatch.setattr("app.leveling.llm_leveling.retrieve_context", _fake_retrieve_context)

    build_survey_tree(
        _small_doc(),
        FakeLlmLevelingClient(),
        FakeBatchedRequirementClient(),
        area_path="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
    )
    assert call_count["n"] == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_llm_leveling.py tests/test_worktree_schema_conformance.py -v`
Expected: the two new tests FAIL (`TypeError: build_survey_tree() got an unexpected keyword argument 'area_path'`); pre-existing tests in both files still PASS since the fake changes are purely additive.

- [ ] **Step 3: Implement the wiring**

In `ingestion/app/leveling/llm_leveling.py`, add the import (after the existing imports, line 10):

```python
from app.kb.kb_vector_store import KbVectorStore
from app.kb.retrieval import retrieve_context
```

Update `LlmLevelingClient` (line 21):

```python
    def infer_hierarchy(self, outline: str, profile_hint: LevelingProfile | None, kb_context: str | None = None) -> list[dict]: ...
```

Update `BatchedRequirementClient` (line 34):

```python
    def generate_requirements_for_document(
        self, blocks_by_node_id: dict[str, str], kb_context: str | None = None
    ) -> dict[str, list[dict]]: ...
```

Update `build_survey_tree`'s signature (line 45) and its body (line 67-68 and line 85):

```python
def build_survey_tree(
    doc: CanonicalDoc,
    llm_client: LlmLevelingClient,
    requirement_client: BatchedRequirementClient,
    area_path: str | None = None,
    embed_client: object | None = None,
    vector_store: KbVectorStore | None = None,
) -> WorkItemTree:
```

(docstring: append one sentence — `"When area_path, embed_client, and vector_store are all supplied, one KB retrieval call grounds both the hierarchy and requirement-generation calls with the same retrieved context; when any is omitted, retrieval is skipped entirely (kb_context stays None), matching pre-KB behavior exactly."`)

Then in the body, replace:

```python
    outline = _build_outline(doc)
    hierarchy = llm_client.infer_hierarchy(outline, profile_hint=None)
```

with:

```python
    outline = _build_outline(doc)
    kb_context: str | None = None
    if area_path is not None and embed_client is not None and vector_store is not None:
        kb_context = retrieve_context(area_path, outline, embed_client, vector_store)
    hierarchy = llm_client.infer_hierarchy(outline, profile_hint=None, kb_context=kb_context)
```

And replace:

```python
    generated_by_node_id = requirement_client.generate_requirements_for_document(blocks_by_node_id)
```

with:

```python
    generated_by_node_id = requirement_client.generate_requirements_for_document(blocks_by_node_id, kb_context=kb_context)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_llm_leveling.py tests/test_worktree_schema_conformance.py -v`
Expected: PASS (all tests in both files)

- [ ] **Step 5: Run the full ingestion suite to confirm no regressions**

Run: `cd ingestion && .venv/bin/python -m pytest -v`
Expected: same pass/fail counts as the pre-existing baseline (235/242, 7 pre-existing OCR/poppler failures unrelated to this work — see `docs/handoff-frontend-rebuild.md` §4a) plus the new tests from Tasks 1-4 passing.

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/leveling/llm_leveling.py ingestion/tests/test_llm_leveling.py ingestion/tests/test_worktree_schema_conformance.py
git commit -m "feat(survey): wire KB retrieval into build_survey_tree, once per document"
```

---

### Task 5: `/level` route — thread `area_path` and KB singletons through

**Files:**
- Modify: `ingestion/app/main.py`
- Modify: `ingestion/tests/test_level_endpoint.py`

**Interfaces:**
- Consumes: `build_survey_tree(doc, llm_client, requirement_client, area_path=None, embed_client=None, vector_store=None)` (Task 4). Module-level `_embed_client` (`OrchestratorEmbedClient`) and `_kb_vector_store` (`KbVectorStore`), both already instantiated in `main.py` lines 32/34.
- Produces: `POST /level` gains an optional query param `area_path: str | None = None`. When `mode == "survey"` and `area_path` is provided, KB retrieval runs; when omitted (as every pre-existing caller does), behavior is byte-for-byte identical to today.

- [ ] **Step 1: Write the failing test**

Add to `ingestion/tests/test_level_endpoint.py`:

```python
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

    def patched_init(self, base_url, bearer_token):
        original_init(self, base_url, bearer_token)
        self._transport = httpx.MockTransport(handler)

    monkeypatch.setattr(OrchestratorLlmClient, "__init__", patched_init)
    monkeypatch.setattr("app.main.settings.llm_proxy_bearer", "test-bearer")
    # retrieve_context is called from app.leveling.llm_leveling (build_survey_tree's
    # module), not from app.main — main.py only forwards area_path/embed_client/
    # vector_store through, it never calls retrieve_context itself.
    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda area_path, query_text, embed_client, vector_store, **_: "Injected KB reference text.",
    )

    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr("x.txt"))],
    )
    response = client.post(
        "/level", params={"mode": "survey", "area_path": "Project\\Area1"}, json=doc.model_dump(mode="json")
    )
    assert response.status_code == 200
    assert all("Injected KB reference text." in prompt for prompt in captured_system_prompts)


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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_level_endpoint.py -v -k "kb_context or kb_retrieval"`
Expected: the first new test FAILs (`area_path` isn't a recognized query param yet, so the KB context never reaches the captured prompts); the second new test currently PASSes already (nothing calls retrieve_context yet regardless) — re-run both after Step 3 to confirm they hold once the wiring exists.

- [ ] **Step 3: Wire it up**

No new import needed in `ingestion/app/main.py` — `build_survey_tree` (Task 4) is the only caller of `retrieve_context`; `main.py` just forwards the three new params through. Change the `/level` route (lines 77-90) to:

```python
@app.post("/level", response_model=WorkItemTree)
async def level(
    doc: CanonicalDoc, customer_id: str | None = None, mode: str = "baseline", area_path: str | None = None
) -> WorkItemTree:
    if mode == "survey":
        # One real client instance satisfies both Protocols build_survey_tree
        # needs (LlmLevelingClient, BatchedRequirementClient) — see Task 1's
        # docstring. run_in_threadpool: OrchestratorLlmClient's HTTP calls are
        # synchronous (httpx.Client, not an async client) — calling
        # build_survey_tree inline in this async route would block ingestion's
        # single-worker event loop for the whole job's duration, starving
        # every other concurrent request (including /health). Moving the
        # blocking work to FastAPI's threadpool keeps the loop free.
        # area_path is optional here: when the caller omits it (no KB scope
        # known yet), build_survey_tree skips retrieval entirely and behaves
        # exactly as it did before KB retrieval existed.
        client = OrchestratorLlmClient(settings.orchestrator_url, settings.llm_proxy_bearer)
        return await run_in_threadpool(
            build_survey_tree,
            doc,
            llm_client=client,
            requirement_client=client,
            area_path=area_path,
            embed_client=_embed_client,
            vector_store=_kb_vector_store,
        )
    return build_baseline_tree(doc, customer_id=customer_id)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_level_endpoint.py -v`
Expected: PASS (all tests in the file, including the three pre-existing ones)

- [ ] **Step 5: Run the full ingestion suite**

Run: `cd ingestion && .venv/bin/python -m pytest -v`
Expected: same baseline pass/fail counts as Task 4 Step 5, plus these new tests passing.

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/main.py ingestion/tests/test_level_endpoint.py
git commit -m "feat(survey): thread area_path through /level for optional KB retrieval"
```

---

### Task 6: Update handoff documentation

**Files:**
- Modify: `docs/handoff-frontend-rebuild.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Add a P2b section**

Add a new subsection after the existing "§4a. KB connector" section (before "## 5. Backend API surface"), following the same voice/density as the existing handoff doc:

```markdown
## 4b. P2b — RAG retrieval-injection into SURVEY (current)

Wires the read side of the KB store into SURVEY mode's two whole-document LLM calls. `build_survey_tree` (`ingestion/app/leveling/llm_leveling.py`) now accepts optional `area_path`/`embed_client`/`vector_store` params; when all three are supplied it calls the new `retrieve_context()` (`ingestion/app/kb/retrieval.py`) exactly once per document — embeds the outline, queries `KbVectorStore.query()` (new method, `ingestion/app/kb/kb_vector_store.py`) for the area_path's KB collection, keeps hits at cosine similarity ≥ 0.3 (distance ≤ 0.7) out of top-5, and joins survivors into one context string. That same string is threaded into both `infer_hierarchy` and `generate_requirements_for_document` (`ingestion/app/survey/orchestrator_llm_client.py`), each prepending it to their system prompt as a labeled "reference material, may be irrelevant" block when present.

**Fully additive, fully optional.** Every new parameter defaults to `None`; when `area_path` is omitted (as every pre-KB caller does), retrieval is skipped entirely and behavior is byte-for-byte identical to before this phase. `POST /level` gained an optional `area_path` query param for this reason — omitted, it behaves exactly as before.

**Failure-safe by construction.** `retrieve_context` catches any exception from the embed call or the Chroma query and returns `None` (logged as a warning) — a KB outage never blocks or fails a SURVEY job, it just falls back to the model's baseline knowledge, identical to the empty-collection case.

**No doc_type filtering** — queries the whole area_path collection regardless of doc_type (which is sparse metadata to begin with, see §4a). **One retrieval per document**, not per node/block — matches the batching philosophy `generate_requirements_for_document` was already built around.

**Not yet done:** no chat feature exists to retrieve into (roadmap mentions it as a future target). P2c (RAG-grounded quality scoring) and P2d (learning-loop write-back) are separate, later phases.
```

- [ ] **Step 2: Commit**

```bash
git add docs/handoff-frontend-rebuild.md
git commit -m "docs: document P2b RAG retrieval-injection in handoff guide"
```
