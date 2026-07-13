# P2a — SharePoint Connector + Knowledge Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the SharePoint connector + knowledge-base foundation for Phase 2 (RAG-first knowledge layer): fetch documents from SharePoint, chunk them, embed them, and persist chunk text + embeddings in a per-area-path Chroma collection, plus the frontend/backend surface to configure and trigger it.

**Architecture:** ingestion (Python/FastAPI) owns fetch→chunk→embed→store via a new `app/kb/` package, reusing existing document loaders and the existing orchestrator-embed-proxy client. orchestrator (NestJS) owns non-secret source config (Prisma `KbSource`) and forwards sync requests (with the bearer token, never persisted) to ingestion, mirroring the existing ADO per-request-credential pattern. frontend adds a `/knowledge-base` page to configure sources and trigger Sync.

**Tech Stack:** Python 3.12 / FastAPI / chromadb / httpx (ingestion), NestJS / Prisma / Postgres (orchestrator), React 19 / Vite / MUI 6 / Zustand (frontend) — all existing, no new major dependencies.

## Global Constraints

- No retrieval-injection into any LLM stage in this phase — that's P2b. `POST /kb/sync` only stores chunks; nothing reads from the KB collection yet.
- Bearer token is never persisted server-side — travels in the request body only, exactly once per Sync call. Matches the ADO PAT pattern (see `orchestrator/src/modules/auth/ado-pat.provider.ts` and `docs/docgen-connection-pattern.md`).
- KB chunks are scoped per area path, in a **separate** Chroma collection namespace (`req2ado_kb_<hash>`) from dedup's existing `req2ado_<hash>` collections — never the same collection.
- Individual file parse/fetch failures must not abort a sync — always report partial results (`filesFailed`), never throw for the whole request.
- Reuse existing ingestion loaders (`dispatch_by_extension`) and the existing `OrchestratorEmbedClient` — do not write a new parser or a new embed-calling client.

---

### Task 1: ingestion — chunker

**Files:**
- Create: `ingestion/app/kb/__init__.py` (empty)
- Create: `ingestion/app/kb/chunker.py`
- Test: `ingestion/tests/kb/__init__.py` (empty)
- Test: `ingestion/tests/kb/test_chunker.py`

**Interfaces:**
- Consumes: `app.canonical.model.Block`, `BlockKind`, `CanonicalDoc` (existing, unchanged).
- Produces: `KbChunk` (fields: `text: str`, `chunk_index: int`), `chunk_canonical_doc(doc: CanonicalDoc) -> list[KbChunk]` — used by Task 4's sync service.

- [ ] **Step 1: Write the failing test**

```python
# ingestion/tests/kb/test_chunker.py
from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.kb.chunker import chunk_canonical_doc

REF = SourceRef(document_path="doc.txt", start_offset=0, end_offset=0)


def _doc(blocks: list[Block]) -> CanonicalDoc:
    return CanonicalDoc(document=Document(path="doc.txt", format=DocumentFormat.TXT, sha256="h"), blocks=blocks)


def test_groups_blocks_into_one_chunk_per_heading_section() -> None:
    blocks = [
        Block(id="b0", kind=BlockKind.HEADING, text="Section 1", heading_level=1, source_ref=REF),
        Block(id="b1", kind=BlockKind.PARAGRAPH, text="Para under section 1", source_ref=REF),
        Block(id="b2", kind=BlockKind.HEADING, text="Section 2", heading_level=1, source_ref=REF),
        Block(id="b3", kind=BlockKind.PARAGRAPH, text="Para under section 2", source_ref=REF),
    ]
    chunks = chunk_canonical_doc(_doc(blocks))
    assert len(chunks) == 2
    assert chunks[0].text == "Section 1\nPara under section 1"
    assert chunks[0].chunk_index == 0
    assert chunks[1].text == "Section 2\nPara under section 2"
    assert chunks[1].chunk_index == 1


def test_preamble_before_first_heading_becomes_its_own_chunk() -> None:
    blocks = [
        Block(id="b0", kind=BlockKind.PARAGRAPH, text="Preamble text", source_ref=REF),
        Block(id="b1", kind=BlockKind.HEADING, text="Section 1", heading_level=1, source_ref=REF),
        Block(id="b2", kind=BlockKind.PARAGRAPH, text="Para under section 1", source_ref=REF),
    ]
    chunks = chunk_canonical_doc(_doc(blocks))
    assert len(chunks) == 2
    assert chunks[0].text == "Preamble text"
    assert chunks[1].text == "Section 1\nPara under section 1"


def test_a_subheading_joins_its_parent_sections_chunk() -> None:
    blocks = [
        Block(id="b0", kind=BlockKind.HEADING, text="Section 1", heading_level=1, source_ref=REF),
        Block(id="b1", kind=BlockKind.HEADING, text="1.1 Sub", heading_level=2, source_ref=REF),
        Block(id="b2", kind=BlockKind.PARAGRAPH, text="Para under 1.1", source_ref=REF),
    ]
    chunks = chunk_canonical_doc(_doc(blocks))
    assert len(chunks) == 1
    assert chunks[0].text == "Section 1\n1.1 Sub\nPara under 1.1"


def test_documents_with_no_headings_fall_back_to_a_fixed_size_window() -> None:
    blocks = [Block(id=f"b{i}", kind=BlockKind.PARAGRAPH, text=f"Para {i}", source_ref=REF) for i in range(25)]
    chunks = chunk_canonical_doc(_doc(blocks))
    assert len(chunks) == 3  # 25 blocks / window of 10 = 3 chunks (10, 10, 5)
    assert chunks[0].text == "\n".join(f"Para {i}" for i in range(10))
    assert chunks[2].text == "\n".join(f"Para {i}" for i in range(20, 25))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ingestion && .venv/bin/python -m pytest tests/kb/test_chunker.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.kb'`

- [ ] **Step 3: Write minimal implementation**

```python
# ingestion/app/kb/__init__.py
```

```python
# ingestion/app/kb/chunker.py
from __future__ import annotations

from pydantic import BaseModel

from app.canonical.model import Block, BlockKind, CanonicalDoc

# Fallback window for documents with no heading structure at all — keeps
# chunks a reasonable retrieval unit instead of one giant chunk per file.
MAX_BLOCKS_PER_CHUNK = 10


class KbChunk(BaseModel):
    text: str
    chunk_index: int


def chunk_canonical_doc(doc: CanonicalDoc) -> list[KbChunk]:
    """Groups a CanonicalDoc's blocks into chunks by heading section: a
    HEADING block starts a new chunk unless it's a sub-heading (deeper
    level) of the currently-open section, in which case it joins that
    chunk. Documents with no heading blocks at all fall back to a
    fixed-size window (MAX_BLOCKS_PER_CHUNK)."""
    has_headings = any(block.kind == BlockKind.HEADING for block in doc.blocks)
    if not has_headings:
        return _chunk_by_fixed_window(doc.blocks)
    return _chunk_by_heading(doc.blocks)


def _chunk_by_heading(blocks: list[Block]) -> list[KbChunk]:
    chunks: list[KbChunk] = []
    current_texts: list[str] = []
    current_level: int | None = None

    def flush() -> None:
        if current_texts:
            chunks.append(KbChunk(text="\n".join(current_texts), chunk_index=len(chunks)))

    for block in blocks:
        starts_new_section = block.kind == BlockKind.HEADING and (
            current_level is None or block.heading_level is None or block.heading_level <= current_level
        )
        if starts_new_section:
            flush()
            current_texts = [block.text]
            current_level = block.heading_level
        else:
            current_texts.append(block.text)
    flush()
    return chunks


def _chunk_by_fixed_window(blocks: list[Block]) -> list[KbChunk]:
    chunks: list[KbChunk] = []
    for start in range(0, len(blocks), MAX_BLOCKS_PER_CHUNK):
        window = blocks[start : start + MAX_BLOCKS_PER_CHUNK]
        chunks.append(KbChunk(text="\n".join(b.text for b in window), chunk_index=len(chunks)))
    return chunks
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/kb/test_chunker.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/kb/__init__.py ingestion/app/kb/chunker.py ingestion/tests/kb/__init__.py ingestion/tests/kb/test_chunker.py
git commit -m "feat(kb): add heading-aware chunker for KB documents"
```

---

### Task 2: ingestion — KB vector store

**Files:**
- Create: `ingestion/app/kb/kb_vector_store.py`
- Test: `ingestion/tests/kb/test_kb_vector_store.py`

**Interfaces:**
- Consumes: `chromadb.PersistentClient` (existing dependency, already used by `app/dedup/vector_store.py`).
- Produces: `KbVectorStore` class with `upsert_chunk(chunk_id, embedding, text, area_path, source_file, chunk_index, file_hash)`, `existing_file_hash(area_path, source_file) -> str | None`, `delete_file_chunks(area_path, source_file)` — used by Task 4's sync service.

- [ ] **Step 1: Write the failing test**

```python
# ingestion/tests/kb/test_kb_vector_store.py
import tempfile

from app.kb.kb_vector_store import KbVectorStore


def test_existing_file_hash_returns_none_for_a_never_ingested_file() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        assert store.existing_file_hash("Project\\Area1", "doc.txt") is None


def test_upsert_chunk_then_existing_file_hash_returns_the_stored_hash() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.upsert_chunk(
            chunk_id="doc.txt:0",
            embedding=[1.0, 0.0, 0.0],
            text="chunk text",
            area_path="Project\\Area1",
            source_file="doc.txt",
            chunk_index=0,
            file_hash="hash-1",
        )
        assert store.existing_file_hash("Project\\Area1", "doc.txt") == "hash-1"


def test_kb_collections_are_isolated_from_dedup_collections_for_the_same_area_path() -> None:
    from app.dedup.vector_store import ChromaVectorStore

    with tempfile.TemporaryDirectory() as tmp:
        kb_store = KbVectorStore(persist_path=tmp)
        dedup_store = ChromaVectorStore(persist_path=tmp)
        kb_store.upsert_chunk(
            chunk_id="doc.txt:0", embedding=[1.0, 0.0, 0.0], text="t", area_path="Project\\Area1",
            source_file="doc.txt", chunk_index=0, file_hash="hash-1",
        )
        # Dedup's store must see nothing from the KB collection — separate namespace.
        assert dedup_store.query_nearest([1.0, 0.0, 0.0], area_path="Project\\Area1") is None


def test_delete_file_chunks_removes_all_chunks_for_that_file_only() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = KbVectorStore(persist_path=tmp)
        store.upsert_chunk(
            chunk_id="doc.txt:0", embedding=[1.0, 0.0, 0.0], text="t0", area_path="Project\\Area1",
            source_file="doc.txt", chunk_index=0, file_hash="hash-1",
        )
        store.upsert_chunk(
            chunk_id="other.txt:0", embedding=[0.0, 1.0, 0.0], text="t1", area_path="Project\\Area1",
            source_file="other.txt", chunk_index=0, file_hash="hash-2",
        )
        store.delete_file_chunks("Project\\Area1", "doc.txt")
        assert store.existing_file_hash("Project\\Area1", "doc.txt") is None
        assert store.existing_file_hash("Project\\Area1", "other.txt") == "hash-2"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ingestion && .venv/bin/python -m pytest tests/kb/test_kb_vector_store.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.kb.kb_vector_store'`

- [ ] **Step 3: Write minimal implementation**

```python
# ingestion/app/kb/kb_vector_store.py
from __future__ import annotations

import hashlib

import chromadb


def _kb_collection_name_for_area_path(area_path: str) -> str:
    # Separate namespace from dedup's `req2ado_<hash>` collections (see
    # dedup/vector_store.py) — KB chunks store real source text and are a
    # different concern from dedup's embeddings-only vectors. Keeping them
    # in different collections means neither can leak into the other's
    # queries.
    digest = hashlib.sha256(area_path.encode()).hexdigest()[:32]
    return f"req2ado_kb_{digest}"


class KbVectorStore:
    """Area-Path-scoped knowledge-base store: unlike ChromaVectorStore
    (dedup, embeddings-only), this stores chunk source text + metadata
    alongside each embedding — P2b's retrieval needs the actual text to
    inject into LLM prompts, not just a similarity score."""

    def __init__(self, persist_path: str) -> None:
        self._client = chromadb.PersistentClient(path=persist_path)

    def _get_collection(self, area_path: str):
        return self._client.get_or_create_collection(
            name=_kb_collection_name_for_area_path(area_path),
            metadata={"hnsw:space": "cosine"},
        )

    def upsert_chunk(
        self,
        chunk_id: str,
        embedding: list[float],
        text: str,
        area_path: str,
        source_file: str,
        chunk_index: int,
        file_hash: str,
    ) -> None:
        collection = self._get_collection(area_path)
        collection.upsert(
            ids=[chunk_id],
            embeddings=[embedding],
            documents=[text],
            metadatas=[{"source_file": source_file, "chunk_index": chunk_index, "file_hash": file_hash}],
        )

    def existing_file_hash(self, area_path: str, source_file: str) -> str | None:
        """Returns the stored file_hash for any existing chunk of this
        source_file, or None if the file has never been ingested. Used for
        hash-based skip-unchanged: if this matches the freshly-computed
        hash, the caller skips re-parsing/re-embedding the file."""
        collection = self._get_collection(area_path)
        result = collection.get(where={"source_file": source_file}, limit=1)
        metadatas = result.get("metadatas") or []
        if not metadatas:
            return None
        return metadatas[0]["file_hash"]

    def delete_file_chunks(self, area_path: str, source_file: str) -> None:
        """Deletes all previously-stored chunks for this source_file before
        re-ingesting a changed file, so stale chunks (e.g. from a
        since-removed section) don't linger alongside the new ones."""
        collection = self._get_collection(area_path)
        collection.delete(where={"source_file": source_file})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/kb/test_kb_vector_store.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/kb/kb_vector_store.py ingestion/tests/kb/test_kb_vector_store.py
git commit -m "feat(kb): add KB vector store with source text + metadata"
```

---

### Task 3: ingestion — SharePoint client

**Files:**
- Create: `ingestion/app/kb/sharepoint_client.py`
- Test: `ingestion/tests/kb/test_sharepoint_client.py`

**Interfaces:**
- Consumes: `httpx` (existing dependency).
- Produces: `SharePointFile` (fields: `name: str`, `server_relative_url: str`), `SharePointClient` class with `list_files(library, folder) -> list[SharePointFile]`, `fetch_file_bytes(server_relative_url) -> bytes` — used by Task 4's sync service.

- [ ] **Step 1: Write the failing test**

```python
# ingestion/tests/kb/test_sharepoint_client.py
import httpx
import pytest

from app.kb.sharepoint_client import SharePointClient


def _transport_returning(json_body: dict, expected_auth: str) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == expected_auth
        return httpx.Response(200, json=json_body)
    return httpx.MockTransport(handler)


def test_list_files_parses_the_sharepoint_rest_response(monkeypatch) -> None:
    body = {"d": {"results": [{"Name": "doc.docx", "ServerRelativeUrl": "/sites/s/Lib/Folder/doc.docx"}]}}
    transport = _transport_returning(body, "Bearer tok-1")

    real_client_init = httpx.Client.__init__

    def patched_init(self, *args, **kwargs):
        kwargs["transport"] = transport
        real_client_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.Client, "__init__", patched_init)

    client = SharePointClient(site_url="https://contoso.sharepoint.com/sites/s", bearer_token="tok-1")
    files = client.list_files("Lib", "Folder")

    assert len(files) == 1
    assert files[0].name == "doc.docx"
    assert files[0].server_relative_url == "/sites/s/Lib/Folder/doc.docx"


def test_fetch_file_bytes_returns_the_raw_response_body(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer tok-1"
        return httpx.Response(200, content=b"file bytes")

    transport = httpx.MockTransport(handler)
    real_client_init = httpx.Client.__init__

    def patched_init(self, *args, **kwargs):
        kwargs["transport"] = transport
        real_client_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.Client, "__init__", patched_init)

    client = SharePointClient(site_url="https://contoso.sharepoint.com/sites/s", bearer_token="tok-1")
    content = client.fetch_file_bytes("/sites/s/Lib/Folder/doc.docx")

    assert content == b"file bytes"


def test_list_files_raises_on_a_non_2xx_response(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "unauthorized"})

    transport = httpx.MockTransport(handler)
    real_client_init = httpx.Client.__init__

    def patched_init(self, *args, **kwargs):
        kwargs["transport"] = transport
        real_client_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.Client, "__init__", patched_init)

    client = SharePointClient(site_url="https://contoso.sharepoint.com/sites/s", bearer_token="bad-tok")
    with pytest.raises(httpx.HTTPStatusError):
        client.list_files("Lib", "Folder")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ingestion && .venv/bin/python -m pytest tests/kb/test_sharepoint_client.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.kb.sharepoint_client'`

- [ ] **Step 3: Write minimal implementation**

```python
# ingestion/app/kb/sharepoint_client.py
from __future__ import annotations

import httpx
from pydantic import BaseModel


class SharePointFile(BaseModel):
    name: str
    server_relative_url: str


class SharePointClient:
    """Fetches file listings and content from a SharePoint site via its
    REST API, using a literal bearer token (Authorization: Bearer <token>)
    — the user's confirmed real-world SharePoint access model (see
    docs/docgen-connection-pattern.md's SharePoint Online/bearer path).
    NTLM on-prem auth is explicitly out of scope for this phase."""

    def __init__(self, site_url: str, bearer_token: str) -> None:
        self._site_url = site_url.rstrip("/")
        self._bearer_token = bearer_token

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._bearer_token}",
            "Accept": "application/json;odata=verbose",
        }

    def list_files(self, library: str, folder: str) -> list[SharePointFile]:
        server_relative_url = f"{library}/{folder}".strip("/")
        url = f"{self._site_url}/_api/web/GetFolderByServerRelativeUrl('{server_relative_url}')/Files"
        with httpx.Client() as client:
            response = client.get(url, headers=self._headers())
        response.raise_for_status()
        entries = response.json()["d"]["results"]
        return [SharePointFile(name=entry["Name"], server_relative_url=entry["ServerRelativeUrl"]) for entry in entries]

    def fetch_file_bytes(self, server_relative_url: str) -> bytes:
        url = f"{self._site_url}/_api/web/GetFileByServerRelativeUrl('{server_relative_url}')/$value"
        with httpx.Client() as client:
            response = client.get(url, headers=self._headers())
        response.raise_for_status()
        return response.content
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/kb/test_sharepoint_client.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/kb/sharepoint_client.py ingestion/tests/kb/test_sharepoint_client.py
git commit -m "feat(kb): add SharePoint REST client (bearer-token auth)"
```

---

### Task 4: ingestion — sync service + FastAPI route

**Files:**
- Create: `ingestion/app/kb/sync_service.py`
- Modify: `ingestion/app/main.py`
- Test: `ingestion/tests/kb/test_sync_service.py`

**Interfaces:**
- Consumes: `chunk_canonical_doc` (Task 1), `KbVectorStore` (Task 2), `SharePointClient` (Task 3), `dispatch_by_extension` (existing, `app/dispatch.py`), an `embed_client` with `.embed(texts: list[str]) -> list[list[float]]` (existing `OrchestratorEmbedClient`, `app/dedup/orchestrator_embed_client.py`).
- Produces: `KbSyncResult` (fields: `files_processed: int`, `files_skipped: int`, `files_failed: list[KbSyncFileFailure]`, `chunks_stored: int`), `sync_kb_source(site_url, library, folder, area_path, bearer_token, embed_client, vector_store) -> KbSyncResult`, and the FastAPI route `POST /kb/sync` — consumed by Task 6 (orchestrator's `IngestionHttpClient.syncKb`).

- [ ] **Step 1: Write the failing test**

```python
# ingestion/tests/kb/test_sync_service.py
from unittest.mock import MagicMock, patch

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.kb.kb_vector_store import KbVectorStore
from app.kb.sharepoint_client import SharePointFile
from app.kb.sync_service import sync_kb_source

REF = SourceRef(document_path="doc.txt", start_offset=0, end_offset=0)


def _fake_doc(text: str) -> CanonicalDoc:
    return CanonicalDoc(
        document=Document(path="doc.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.PARAGRAPH, text=text, source_ref=REF)],
    )


class FakeEmbedClient:
    def embed(self, texts: list[str]) -> list[list[float]]:
        return [[1.0, 0.0, 0.0] for _ in texts]


@patch("app.kb.sync_service.dispatch_by_extension")
@patch("app.kb.sync_service.SharePointClient")
def test_syncs_a_new_file_end_to_end(mock_sharepoint_cls, mock_dispatch, tmp_path) -> None:
    mock_sharepoint = MagicMock()
    mock_sharepoint.list_files.return_value = [SharePointFile(name="doc.txt", server_relative_url="/s/Lib/Folder/doc.txt")]
    mock_sharepoint.fetch_file_bytes.return_value = b"file content"
    mock_sharepoint_cls.return_value = mock_sharepoint
    mock_dispatch.return_value = _fake_doc("Some paragraph text")

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    result = sync_kb_source(
        site_url="https://contoso.sharepoint.com/sites/s",
        library="Lib",
        folder="Folder",
        area_path="Project\\Area1",
        bearer_token="tok-1",
        embed_client=FakeEmbedClient(),
        vector_store=vector_store,
    )

    assert result.files_processed == 1
    assert result.files_skipped == 0
    assert result.files_failed == []
    assert result.chunks_stored == 1
    assert vector_store.existing_file_hash("Project\\Area1", "doc.txt") is not None


@patch("app.kb.sync_service.dispatch_by_extension")
@patch("app.kb.sync_service.SharePointClient")
def test_skips_a_file_whose_hash_is_unchanged(mock_sharepoint_cls, mock_dispatch, tmp_path) -> None:
    mock_sharepoint = MagicMock()
    mock_sharepoint.list_files.return_value = [SharePointFile(name="doc.txt", server_relative_url="/s/Lib/Folder/doc.txt")]
    mock_sharepoint.fetch_file_bytes.return_value = b"same content"
    mock_sharepoint_cls.return_value = mock_sharepoint
    mock_dispatch.return_value = _fake_doc("Some paragraph text")

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    kwargs = dict(
        site_url="https://contoso.sharepoint.com/sites/s", library="Lib", folder="Folder",
        area_path="Project\\Area1", bearer_token="tok-1", embed_client=FakeEmbedClient(), vector_store=vector_store,
    )
    sync_kb_source(**kwargs)  # first sync: ingests
    result = sync_kb_source(**kwargs)  # second sync: same content, should skip

    assert result.files_processed == 0
    assert result.files_skipped == 1
    assert result.chunks_stored == 0


@patch("app.kb.sync_service.dispatch_by_extension")
@patch("app.kb.sync_service.SharePointClient")
def test_a_single_file_failure_is_reported_and_does_not_abort_the_sync(mock_sharepoint_cls, mock_dispatch, tmp_path) -> None:
    mock_sharepoint = MagicMock()
    mock_sharepoint.list_files.return_value = [
        SharePointFile(name="bad.txt", server_relative_url="/s/Lib/Folder/bad.txt"),
        SharePointFile(name="good.txt", server_relative_url="/s/Lib/Folder/good.txt"),
    ]
    mock_sharepoint.fetch_file_bytes.return_value = b"content"
    mock_sharepoint_cls.return_value = mock_sharepoint
    mock_dispatch.side_effect = [ValueError("corrupt file"), _fake_doc("Good text")]

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    result = sync_kb_source(
        site_url="https://contoso.sharepoint.com/sites/s", library="Lib", folder="Folder",
        area_path="Project\\Area1", bearer_token="tok-1", embed_client=FakeEmbedClient(), vector_store=vector_store,
    )

    assert result.files_processed == 1
    assert len(result.files_failed) == 1
    assert result.files_failed[0].file == "bad.txt"
    assert result.chunks_stored == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ingestion && .venv/bin/python -m pytest tests/kb/test_sync_service.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.kb.sync_service'`

- [ ] **Step 3: Write minimal implementation**

```python
# ingestion/app/kb/sync_service.py
from __future__ import annotations

import hashlib
import tempfile
from pathlib import Path

from pydantic import BaseModel

from app.dispatch import dispatch_by_extension
from app.kb.chunker import chunk_canonical_doc
from app.kb.kb_vector_store import KbVectorStore
from app.kb.sharepoint_client import SharePointClient


class KbSyncFileFailure(BaseModel):
    file: str
    reason: str


class KbSyncResult(BaseModel):
    files_processed: int
    files_skipped: int
    files_failed: list[KbSyncFileFailure]
    chunks_stored: int


def sync_kb_source(
    site_url: str,
    library: str,
    folder: str,
    area_path: str,
    bearer_token: str,
    embed_client,
    vector_store: KbVectorStore,
) -> KbSyncResult:
    """Fetches every file in a SharePoint folder, skips files whose content
    hash already matches what's stored (skip-unchanged), and re-ingests
    everything else: parse -> chunk -> embed -> upsert. A single file's
    fetch/parse/embed failure is recorded and skipped, never aborts the
    whole sync (RAG-first 'never blocks' principle, docs/req2ado-roadmap.md)."""
    sharepoint = SharePointClient(site_url, bearer_token)
    files = sharepoint.list_files(library, folder)

    files_processed = 0
    files_skipped = 0
    chunks_stored = 0
    failures: list[KbSyncFileFailure] = []

    for file in files:
        try:
            content = sharepoint.fetch_file_bytes(file.server_relative_url)
            file_hash = hashlib.sha256(content).hexdigest()

            if vector_store.existing_file_hash(area_path, file.name) == file_hash:
                files_skipped += 1
                continue

            suffix = Path(file.name).suffix
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(content)
                tmp_path = tmp.name
            try:
                doc = dispatch_by_extension(file.name, tmp_path)
            finally:
                Path(tmp_path).unlink(missing_ok=True)

            vector_store.delete_file_chunks(area_path, file.name)
            for chunk in chunk_canonical_doc(doc):
                [embedding] = embed_client.embed([chunk.text])
                vector_store.upsert_chunk(
                    chunk_id=f"{file.name}:{chunk.chunk_index}",
                    embedding=embedding,
                    text=chunk.text,
                    area_path=area_path,
                    source_file=file.name,
                    chunk_index=chunk.chunk_index,
                    file_hash=file_hash,
                )
                chunks_stored += 1
            files_processed += 1
        except Exception as exc:  # noqa: BLE001 - any single file's failure must not abort the sync
            failures.append(KbSyncFileFailure(file=file.name, reason=str(exc)))

    return KbSyncResult(
        files_processed=files_processed,
        files_skipped=files_skipped,
        files_failed=failures,
        chunks_stored=chunks_stored,
    )
```

Now wire the route into `ingestion/app/main.py`. Add these imports alongside the existing ones:

```python
from app.kb.kb_vector_store import KbVectorStore
from app.kb.sync_service import KbSyncResult, sync_kb_source
```

Add this instance alongside `_embed_client`/`_vector_store` (same limitation note applies — single-instance-only, no shared volume yet, see Task 5):

```python
_kb_vector_store = KbVectorStore(settings.chroma_persist_path)
```

Add this request model alongside `DedupCheckRequest`/`DedupUpsertRequest`:

```python
class KbSyncRequest(BaseModel):
    site_url: str
    library: str
    folder: str
    area_path: str
    bearer_token: str
```

Add this route at the end of the file:

```python
@app.post("/kb/sync", response_model=KbSyncResult)
async def kb_sync(body: KbSyncRequest) -> KbSyncResult:
    # sync_kb_source makes synchronous httpx calls in a loop (SharePoint
    # fetch + embed per chunk) — same run_in_threadpool reasoning as /level:
    # without it, this would block ingestion's single-worker event loop for
    # the whole sync's duration.
    return await run_in_threadpool(
        sync_kb_source,
        body.site_url,
        body.library,
        body.folder,
        body.area_path,
        body.bearer_token,
        _embed_client,
        _kb_vector_store,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/kb/test_sync_service.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full ingestion suite to confirm no regressions**

Run: `cd ingestion && .venv/bin/python -m pytest -v`
Expected: all tests pass, including the new `tests/kb/` ones

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/kb/sync_service.py ingestion/app/main.py ingestion/tests/kb/test_sync_service.py
git commit -m "feat(kb): add KB sync service and POST /kb/sync route"
```

---

### Task 5: docker-compose — persist the vector store across rebuilds

**Files:**
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: nothing new.
- Produces: the `req2ado_chroma` named volume (already declared, currently unused) mounted into the `ingestion` service — used by both the existing dedup store and the new KB store, since both are `chromadb.PersistentClient(settings.chroma_persist_path)` instances inside the same container.

- [ ] **Step 1: Add the volume mount to the `ingestion` service**

In `docker-compose.yml`, find the `ingestion` service block:

```yaml
  ingestion:
    build: ./ingestion
    env_file: .env
    environment:
      PORT: 8000
    ports:
      # Host port 8000 is taken by an unrelated container on dev machines
      # (see scripts/run-golden-e2e.sh) — map to 8010 instead, matching the
      # local-process golden E2E script's port for consistency.
      - "8010:8000"
```

Change it to:

```yaml
  ingestion:
    build: ./ingestion
    env_file: .env
    environment:
      PORT: 8000
    ports:
      # Host port 8000 is taken by an unrelated container on dev machines
      # (see scripts/run-golden-e2e.sh) — map to 8010 instead, matching the
      # local-process golden E2E script's port for consistency.
      - "8010:8000"
    volumes:
      # Chroma's PersistentClient (dedup vectors + P2a's KB chunks) writes
      # to settings.chroma_persist_path ("./.req2ado/vectors", resolved
      # against the Dockerfile's WORKDIR /app) — without a volume this
      # resets on every `docker compose up --build`. Reuses the
      # already-declared (previously unused) req2ado_chroma volume rather
      # than adding a new one.
      - req2ado_chroma:/app/.req2ado/vectors
```

- [ ] **Step 2: Verify the volume is declared at the bottom of the file**

Run: `grep -A3 '^volumes:' docker-compose.yml`
Expected output includes:
```
volumes:
  req2ado_pg:
  req2ado_chroma:
```
(already present — no change needed here)

- [ ] **Step 3: Rebuild and confirm the mount is live**

Run: `docker compose up -d --build ingestion && docker exec req2ado-ingestion-1 sh -c "touch /app/.req2ado/vectors/marker && ls /app/.req2ado/vectors"`
Expected: `marker` listed, and after `docker compose restart ingestion`, a second `ls` still shows `marker` (proves the volume persists across container restarts).

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "fix(infra): persist Chroma vector store across container rebuilds"
```

---

### Task 6: orchestrator — Prisma `KbSource` model + migration

**Files:**
- Modify: `orchestrator/prisma/schema.prisma`
- Create: `orchestrator/prisma/migrations/<timestamp>_add_kb_source/migration.sql` (generated, not hand-written)

**Interfaces:**
- Produces: Prisma model `KbSource` (fields: `id: String`, `areaPath: String`, `siteUrl: String`, `library: String`, `folder: String`, `displayName: String`, `lastSyncedAt: DateTime?`, `createdAt: DateTime`) — consumed by Task 7's `KbService`.

- [ ] **Step 1: Add the model to `orchestrator/prisma/schema.prisma`**

Add this model at the end of the file (after the existing `IdempotencyMapping` model):

```prisma
// Non-secret SharePoint connector config only — the bearer token used to
// Sync is never persisted, matching docs/docgen-connection-pattern.md's
// "only non-secret config persists server-side" rule.
model KbSource {
  id           String    @id @default(uuid())
  areaPath     String
  siteUrl      String
  library      String
  folder       String
  displayName  String
  lastSyncedAt DateTime?
  createdAt    DateTime  @default(now())
}
```

- [ ] **Step 2: Generate the migration**

`.env`'s `DATABASE_URL` targets `localhost:5432` — a leftover local-process Postgres container from prior golden-e2e runs (see `docker-compose.yml`'s comment on the `postgres` service), NOT the docker-compose stack's Postgres, which is mapped to host port `5434`. Target the compose stack's Postgres explicitly so its migration history stays in sync with the image that will actually run:

Run: `docker compose up -d postgres` (ensure it's running first)
Run: `cd orchestrator && DATABASE_URL="postgresql://req2ado:req2ado@localhost:5434/req2ado" npx prisma migrate dev --name add_kb_source`
Expected: a new `orchestrator/prisma/migrations/<timestamp>_add_kb_source/migration.sql` file is created containing a `CREATE TABLE "KbSource" (...)` statement, and the command exits 0.

- [ ] **Step 3: Verify the Prisma client regenerated with the new model**

Run: `cd orchestrator && grep -n "KbSource" node_modules/.prisma/client/index.d.ts | head -3`
Expected: at least one match (confirms `npx prisma migrate dev` also ran `prisma generate`)

- [ ] **Step 4: Commit**

```bash
git add orchestrator/prisma/schema.prisma orchestrator/prisma/migrations/
git commit -m "feat(kb): add KbSource Prisma model (non-secret connector config)"
```

---

### Task 7: orchestrator — `IngestionHttpClient.syncKb`

**Files:**
- Modify: `orchestrator/src/modules/pipeline/ingestion-http.client.ts`
- Test: `orchestrator/test/ingestion-http.client.spec.ts` (extend existing file if present, else create)

**Interfaces:**
- Consumes: ingestion's `POST /kb/sync` route (Task 4).
- Produces: `IngestionHttpClient.syncKb(siteUrl, library, folder, areaPath, bearerToken) -> Promise<{filesProcessed, filesSkipped, filesFailed, chunksStored}>` — used by Task 8's `KbService`.

- [ ] **Step 1: Check for an existing test file to extend**

Run: `ls orchestrator/test/ingestion-http.client.spec.ts 2>/dev/null && echo EXISTS || echo MISSING`

- [ ] **Step 2: Write the failing test**

If `MISSING`, create `orchestrator/test/ingestion-http.client.spec.ts` with this content. If `EXISTS`, add this `describe` block to the existing file instead.

```typescript
import { IngestionHttpClient } from '../src/modules/pipeline/ingestion-http.client';

describe('IngestionHttpClient.syncKb', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('posts snake_case fields to /kb/sync and maps the snake_case response to camelCase', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        files_processed: 2,
        files_skipped: 1,
        files_failed: [{ file: 'bad.txt', reason: 'corrupt' }],
        chunks_stored: 5,
      }),
    });
    global.fetch = mockFetch as any;

    const client = new IngestionHttpClient('http://ingestion:8000');
    const result = await client.syncKb('https://contoso.sharepoint.com/sites/s', 'Lib', 'Folder', 'Project\\Area1', 'tok-1');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://ingestion:8000/kb/sync',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          site_url: 'https://contoso.sharepoint.com/sites/s',
          library: 'Lib',
          folder: 'Folder',
          area_path: 'Project\\Area1',
          bearer_token: 'tok-1',
        }),
      }),
    );
    expect(result).toEqual({
      filesProcessed: 2,
      filesSkipped: 1,
      filesFailed: [{ file: 'bad.txt', reason: 'corrupt' }],
      chunksStored: 5,
    });
  });

  it('throws when ingestion responds with a non-ok status', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 502 }) as any;
    const client = new IngestionHttpClient('http://ingestion:8000');
    await expect(
      client.syncKb('https://contoso.sharepoint.com/sites/s', 'Lib', 'Folder', 'Project\\Area1', 'tok-1'),
    ).rejects.toThrow('Ingestion /kb/sync request failed: 502');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd orchestrator && npx jest test/ingestion-http.client.spec.ts -v`
Expected: FAIL with `client.syncKb is not a function`

- [ ] **Step 4: Add `syncKb` to `IngestionHttpClient`**

In `orchestrator/src/modules/pipeline/ingestion-http.client.ts`, add this method inside the `IngestionHttpClient` class (after the existing `upsertDedupEntry` method):

```typescript
  async syncKb(
    siteUrl: string,
    library: string,
    folder: string,
    areaPath: string,
    bearerToken: string,
  ): Promise<{
    filesProcessed: number;
    filesSkipped: number;
    filesFailed: { file: string; reason: string }[];
    chunksStored: number;
  }> {
    const response = await fetch(`${this.baseUrl}/kb/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        site_url: siteUrl,
        library,
        folder,
        area_path: areaPath,
        bearer_token: bearerToken,
      }),
      dispatcher: LONG_RUNNING_AGENT,
    });
    if (!response.ok) {
      throw new Error(`Ingestion /kb/sync request failed: ${response.status}`);
    }
    const body = (await response.json()) as {
      files_processed: number;
      files_skipped: number;
      files_failed: { file: string; reason: string }[];
      chunks_stored: number;
    };
    return {
      filesProcessed: body.files_processed,
      filesSkipped: body.files_skipped,
      filesFailed: body.files_failed,
      chunksStored: body.chunks_stored,
    };
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd orchestrator && npx jest test/ingestion-http.client.spec.ts -v`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/modules/pipeline/ingestion-http.client.ts orchestrator/test/ingestion-http.client.spec.ts
git commit -m "feat(kb): add IngestionHttpClient.syncKb"
```

---

### Task 8: orchestrator — `KbService`

**Files:**
- Create: `orchestrator/src/modules/kb/kb.service.ts`
- Test: `orchestrator/test/kb.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaClient` (`prisma.kbSource.*`, Task 6), `IngestionHttpClient.syncKb` (Task 7).
- Produces: `KbService` with `create(input: KbSourceInput) -> Promise<KbSourceSummary>`, `list() -> Promise<KbSourceSummary[]>`, `sync(id: string, bearerToken: string) -> Promise<KbSyncResult | null>` (null means source not found) — used by Task 9's `KbController`.

- [ ] **Step 1: Write the failing test**

```typescript
// orchestrator/test/kb.service.spec.ts
import { KbService } from '../src/modules/kb/kb.service';

describe('KbService', () => {
  it('create() persists a KbSource via prisma and returns it', async () => {
    const created = { id: 'kb-1', areaPath: 'Project\\Area1', siteUrl: 'https://s', library: 'Lib', folder: 'Folder', displayName: 'Docs', lastSyncedAt: null, createdAt: new Date() };
    const prisma = { kbSource: { create: jest.fn().mockResolvedValue(created) } };
    const service = new KbService(prisma as any, {} as any);

    const result = await service.create({ areaPath: 'Project\\Area1', siteUrl: 'https://s', library: 'Lib', folder: 'Folder', displayName: 'Docs' });

    expect(prisma.kbSource.create).toHaveBeenCalledWith({
      data: { areaPath: 'Project\\Area1', siteUrl: 'https://s', library: 'Lib', folder: 'Folder', displayName: 'Docs' },
    });
    expect(result).toEqual(created);
  });

  it('list() returns all sources ordered newest-first', async () => {
    const prisma = { kbSource: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new KbService(prisma as any, {} as any);

    await service.list();

    expect(prisma.kbSource.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' } });
  });

  it('sync() returns null when the KbSource does not exist', async () => {
    const prisma = { kbSource: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new KbService(prisma as any, {} as any);

    const result = await service.sync('missing-id', 'tok-1');

    expect(result).toBeNull();
  });

  it('sync() forwards the source config + bearer token to ingestion, updates lastSyncedAt, and returns the result', async () => {
    const source = { id: 'kb-1', areaPath: 'Project\\Area1', siteUrl: 'https://s', library: 'Lib', folder: 'Folder' };
    const syncResult = { filesProcessed: 1, filesSkipped: 0, filesFailed: [], chunksStored: 3 };
    const prisma = {
      kbSource: {
        findUnique: jest.fn().mockResolvedValue(source),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const ingestionClient = { syncKb: jest.fn().mockResolvedValue(syncResult) };
    const service = new KbService(prisma as any, ingestionClient as any);

    const result = await service.sync('kb-1', 'tok-1');

    expect(ingestionClient.syncKb).toHaveBeenCalledWith('https://s', 'Lib', 'Folder', 'Project\\Area1', 'tok-1');
    expect(prisma.kbSource.update).toHaveBeenCalledWith({ where: { id: 'kb-1' }, data: { lastSyncedAt: expect.any(Date) } });
    expect(result).toEqual(syncResult);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd orchestrator && npx jest test/kb.service.spec.ts -v`
Expected: FAIL with `Cannot find module '../src/modules/kb/kb.service'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// orchestrator/src/modules/kb/kb.service.ts
import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { IngestionHttpClient } from '../pipeline/ingestion-http.client';

export interface KbSourceInput {
  areaPath: string;
  siteUrl: string;
  library: string;
  folder: string;
  displayName: string;
}

export interface KbSourceSummary {
  id: string;
  areaPath: string;
  siteUrl: string;
  library: string;
  folder: string;
  displayName: string;
  lastSyncedAt: Date | null;
  createdAt: Date;
}

export interface KbSyncResult {
  filesProcessed: number;
  filesSkipped: number;
  filesFailed: { file: string; reason: string }[];
  chunksStored: number;
}

@Injectable()
export class KbService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ingestionClient: IngestionHttpClient,
  ) {}

  async create(input: KbSourceInput): Promise<KbSourceSummary> {
    return this.prisma.kbSource.create({ data: input });
  }

  async list(): Promise<KbSourceSummary[]> {
    return this.prisma.kbSource.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async sync(id: string, bearerToken: string): Promise<KbSyncResult | null> {
    const source = await this.prisma.kbSource.findUnique({ where: { id } });
    if (!source) return null;
    const result = await this.ingestionClient.syncKb(source.siteUrl, source.library, source.folder, source.areaPath, bearerToken);
    await this.prisma.kbSource.update({ where: { id }, data: { lastSyncedAt: new Date() } });
    return result;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd orchestrator && npx jest test/kb.service.spec.ts -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/modules/kb/kb.service.ts orchestrator/test/kb.service.spec.ts
git commit -m "feat(kb): add KbService (source CRUD + sync orchestration)"
```

---

### Task 9: orchestrator — `KbController` + `KbModule` + wiring

**Files:**
- Create: `orchestrator/src/modules/kb/kb.controller.ts`
- Create: `orchestrator/src/modules/kb/kb.module.ts`
- Modify: `orchestrator/src/app.module.ts`
- Test: `orchestrator/test/kb.controller.spec.ts`

**Interfaces:**
- Consumes: `KbService` (Task 8).
- Produces: `GET /kb/sources`, `POST /kb/sources`, `POST /kb/sources/:id/sync` routes — consumed by Task 10's frontend `api/kb.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// orchestrator/test/kb.controller.spec.ts
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { KbController } from '../src/modules/kb/kb.controller';

describe('KbController', () => {
  it('create() throws BadRequestException when any required field is missing', async () => {
    const controller = new KbController({} as any);
    await expect(controller.create(undefined, 'https://s', 'Lib', 'Folder', 'Docs')).rejects.toThrow(BadRequestException);
  });

  it('create() delegates to KbService.create when all fields are present', async () => {
    const created = { id: 'kb-1' };
    const kbService = { create: jest.fn().mockResolvedValue(created) };
    const controller = new KbController(kbService as any);

    const result = await controller.create('Project\\Area1', 'https://s', 'Lib', 'Folder', 'Docs');

    expect(kbService.create).toHaveBeenCalledWith({ areaPath: 'Project\\Area1', siteUrl: 'https://s', library: 'Lib', folder: 'Folder', displayName: 'Docs' });
    expect(result).toBe(created);
  });

  it('sync() throws BadRequestException when bearerToken is missing', async () => {
    const controller = new KbController({} as any);
    await expect(controller.sync('kb-1', undefined)).rejects.toThrow(BadRequestException);
  });

  it('sync() throws NotFoundException when KbService.sync returns null', async () => {
    const kbService = { sync: jest.fn().mockResolvedValue(null) };
    const controller = new KbController(kbService as any);
    await expect(controller.sync('missing-id', 'tok-1')).rejects.toThrow(NotFoundException);
  });

  it('sync() returns the result when KbService.sync succeeds', async () => {
    const syncResult = { filesProcessed: 1, filesSkipped: 0, filesFailed: [], chunksStored: 2 };
    const kbService = { sync: jest.fn().mockResolvedValue(syncResult) };
    const controller = new KbController(kbService as any);

    const result = await controller.sync('kb-1', 'tok-1');

    expect(kbService.sync).toHaveBeenCalledWith('kb-1', 'tok-1');
    expect(result).toBe(syncResult);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd orchestrator && npx jest test/kb.controller.spec.ts -v`
Expected: FAIL with `Cannot find module '../src/modules/kb/kb.controller'`

- [ ] **Step 3: Write the controller**

```typescript
// orchestrator/src/modules/kb/kb.controller.ts
import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { KbService, KbSourceSummary, KbSyncResult } from './kb.service';

@Controller('kb/sources')
export class KbController {
  constructor(private readonly kbService: KbService) {}

  @Get()
  async list(): Promise<KbSourceSummary[]> {
    return this.kbService.list();
  }

  @Post()
  async create(
    @Body('areaPath') areaPath: string | undefined,
    @Body('siteUrl') siteUrl: string | undefined,
    @Body('library') library: string | undefined,
    @Body('folder') folder: string | undefined,
    @Body('displayName') displayName: string | undefined,
  ): Promise<KbSourceSummary> {
    if (!areaPath || !siteUrl || !library || !folder || !displayName) {
      throw new BadRequestException('areaPath, siteUrl, library, folder, and displayName are all required');
    }
    return this.kbService.create({ areaPath, siteUrl, library, folder, displayName });
  }

  @Post(':id/sync')
  async sync(@Param('id') id: string, @Body('bearerToken') bearerToken: string | undefined): Promise<KbSyncResult> {
    if (!bearerToken) {
      throw new BadRequestException('bearerToken is required');
    }
    const result = await this.kbService.sync(id, bearerToken);
    if (!result) {
      throw new NotFoundException(`KbSource ${id} not found`);
    }
    return result;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd orchestrator && npx jest test/kb.controller.spec.ts -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Write the module**

```typescript
// orchestrator/src/modules/kb/kb.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { KbController } from './kb.controller';
import { KbService } from './kb.service';
import { IngestionHttpClient } from '../pipeline/ingestion-http.client';

@Module({
  imports: [ConfigModule],
  controllers: [KbController],
  providers: [
    { provide: PrismaClient, useValue: new PrismaClient() },
    {
      provide: IngestionHttpClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new IngestionHttpClient(config.get<string>('INGESTION_BASE_URL')!),
    },
    {
      provide: KbService,
      inject: [PrismaClient, IngestionHttpClient],
      useFactory: (prisma: PrismaClient, ingestionClient: IngestionHttpClient) => new KbService(prisma, ingestionClient),
    },
  ],
})
export class KbModule {}
```

- [ ] **Step 6: Register `KbModule` in `app.module.ts`**

In `orchestrator/src/app.module.ts`, add the import:

```typescript
import { KbModule } from './modules/kb/kb.module';
```

And add `KbModule` to the `imports` array (after `JobsModule`):

```typescript
    JobsModule,
    KbModule,
    WikiModule,
```

- [ ] **Step 7: Run the full orchestrator suite to confirm no regressions**

Run: `cd orchestrator && npm test`
Expected: all existing tests plus the new `kb.service.spec.ts`/`kb.controller.spec.ts`/`ingestion-http.client.spec.ts` pass

- [ ] **Step 8: Start the stack and smoke-test the new routes**

Run: `docker compose up -d --build orchestrator && sleep 3 && curl -s -X POST http://localhost:3001/kb/sources -H "Content-Type: application/json" -d '{"areaPath":"Project","siteUrl":"https://contoso.sharepoint.com/sites/s","library":"Lib","folder":"Folder","displayName":"Test Source"}'`
Expected: JSON response with an `id` field, `lastSyncedAt: null`

Run: `curl -s http://localhost:3001/kb/sources`
Expected: JSON array containing the source just created

- [ ] **Step 9: Commit**

```bash
git add orchestrator/src/modules/kb/kb.controller.ts orchestrator/src/modules/kb/kb.module.ts orchestrator/src/app.module.ts orchestrator/test/kb.controller.spec.ts
git commit -m "feat(kb): add KbController/KbModule, wire into AppModule"
```

---

### Task 10: frontend — `api/kb.ts` client

**Files:**
- Create: `frontend/src/api/kb.ts`
- Test: `frontend/src/api/kb.test.ts`

**Interfaces:**
- Consumes: `httpClient` (existing, `frontend/src/api/httpClient.ts`).
- Produces: `KbSourceSummary`, `KbSourceInput`, `KbSyncResult` types, `listKbSources()`, `createKbSource(input)`, `syncKbSource(id, bearerToken)` — used by Task 11's `KnowledgeBase` page.

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/api/kb.test.ts
import { describe, it, expect, vi } from 'vitest';
import { httpClient } from './httpClient';
import { listKbSources, createKbSource, syncKbSource } from './kb';

vi.mock('./httpClient');

describe('kb api', () => {
  it('listKbSources GETs /kb/sources', async () => {
    const sources = [{ id: 'kb-1', areaPath: 'Project', siteUrl: 'https://s', library: 'Lib', folder: 'Folder', displayName: 'Docs', lastSyncedAt: null, createdAt: '2026-07-12T00:00:00Z' }];
    (httpClient.get as any).mockResolvedValue({ data: sources });

    const result = await listKbSources();

    expect(httpClient.get).toHaveBeenCalledWith('/kb/sources');
    expect(result).toEqual(sources);
  });

  it('createKbSource POSTs the input to /kb/sources', async () => {
    const created = { id: 'kb-1' };
    (httpClient.post as any).mockResolvedValue({ data: created });
    const input = { areaPath: 'Project', siteUrl: 'https://s', library: 'Lib', folder: 'Folder', displayName: 'Docs' };

    const result = await createKbSource(input);

    expect(httpClient.post).toHaveBeenCalledWith('/kb/sources', input);
    expect(result).toEqual(created);
  });

  it('syncKbSource POSTs the bearer token to /kb/sources/:id/sync', async () => {
    const syncResult = { filesProcessed: 1, filesSkipped: 0, filesFailed: [], chunksStored: 2 };
    (httpClient.post as any).mockResolvedValue({ data: syncResult });

    const result = await syncKbSource('kb-1', 'tok-1');

    expect(httpClient.post).toHaveBeenCalledWith('/kb/sources/kb-1/sync', { bearerToken: 'tok-1' });
    expect(result).toEqual(syncResult);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/api/kb.test.ts`
Expected: FAIL with `Cannot find module './kb'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// frontend/src/api/kb.ts
import { httpClient } from './httpClient';

export interface KbSourceSummary {
  id: string;
  areaPath: string;
  siteUrl: string;
  library: string;
  folder: string;
  displayName: string;
  lastSyncedAt: string | null;
  createdAt: string;
}

export interface KbSourceInput {
  areaPath: string;
  siteUrl: string;
  library: string;
  folder: string;
  displayName: string;
}

export interface KbSyncResult {
  filesProcessed: number;
  filesSkipped: number;
  filesFailed: { file: string; reason: string }[];
  chunksStored: number;
}

export async function listKbSources(): Promise<KbSourceSummary[]> {
  const response = await httpClient.get<KbSourceSummary[]>('/kb/sources');
  return response.data;
}

export async function createKbSource(input: KbSourceInput): Promise<KbSourceSummary> {
  const response = await httpClient.post<KbSourceSummary>('/kb/sources', input);
  return response.data;
}

export async function syncKbSource(id: string, bearerToken: string): Promise<KbSyncResult> {
  const response = await httpClient.post<KbSyncResult>(`/kb/sources/${id}/sync`, { bearerToken });
  return response.data;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/api/kb.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/kb.ts frontend/src/api/kb.test.ts
git commit -m "feat(kb): add frontend api/kb.ts client"
```

---

### Task 11: frontend — `KnowledgeBase` page, route, nav link

**Files:**
- Create: `frontend/src/pages/KnowledgeBase.tsx`
- Create: `frontend/src/pages/KnowledgeBase.test.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/AppShell.tsx`

**Interfaces:**
- Consumes: `listKbSources`, `createKbSource`, `syncKbSource`, `KbSourceSummary` (Task 10), `useToast` (existing, `frontend/src/components/ToastProvider.tsx`).
- Produces: the `/knowledge-base` route and nav entry.

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/pages/KnowledgeBase.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KnowledgeBase } from './KnowledgeBase';
import { ToastProvider } from '../components/ToastProvider';
import * as kbApi from '../api/kb';

vi.mock('../api/kb');

function renderPage(): void {
  render(
    <ToastProvider>
      <KnowledgeBase />
    </ToastProvider>,
  );
}

describe('KnowledgeBase', () => {
  it('lists existing sources with their area path and last-synced time', async () => {
    vi.spyOn(kbApi, 'listKbSources').mockResolvedValue([
      { id: 'kb-1', areaPath: 'Project\\Area1', siteUrl: 'https://s', library: 'Lib', folder: 'Folder', displayName: 'Docs', lastSyncedAt: null, createdAt: '2026-07-12T00:00:00Z' },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Docs')).toBeInTheDocument());
    expect(screen.getByText(/Project\\Area1/)).toBeInTheDocument();
  });

  it('creates a new source when the Add Source form is submitted', async () => {
    vi.spyOn(kbApi, 'listKbSources').mockResolvedValue([]);
    const created = { id: 'kb-2', areaPath: 'Project\\Area2', siteUrl: 'https://s2', library: 'Lib2', folder: 'Folder2', displayName: 'New Docs', lastSyncedAt: null, createdAt: '2026-07-12T00:00:00Z' };
    vi.spyOn(kbApi, 'createKbSource').mockResolvedValue(created);
    renderPage();

    await userEvent.type(screen.getByLabelText(/display name/i), 'New Docs');
    await userEvent.type(screen.getByLabelText(/site url/i), 'https://s2');
    await userEvent.type(screen.getByLabelText(/^library$/i), 'Lib2');
    await userEvent.type(screen.getByLabelText(/^folder$/i), 'Folder2');
    await userEvent.type(screen.getByLabelText(/^area path$/i), 'Project\\Area2');
    await userEvent.click(screen.getByRole('button', { name: /add source/i }));

    await waitFor(() => expect(kbApi.createKbSource).toHaveBeenCalledWith({
      displayName: 'New Docs', siteUrl: 'https://s2', library: 'Lib2', folder: 'Folder2', areaPath: 'Project\\Area2',
    }));
    await waitFor(() => expect(screen.getByText('New Docs')).toBeInTheDocument());
  });

  it('shows a success toast summarizing the sync result', async () => {
    vi.spyOn(kbApi, 'listKbSources').mockResolvedValue([
      { id: 'kb-1', areaPath: 'Project\\Area1', siteUrl: 'https://s', library: 'Lib', folder: 'Folder', displayName: 'Docs', lastSyncedAt: null, createdAt: '2026-07-12T00:00:00Z' },
    ]);
    vi.spyOn(kbApi, 'syncKbSource').mockResolvedValue({ filesProcessed: 2, filesSkipped: 1, filesFailed: [], chunksStored: 7 });
    renderPage();
    await waitFor(() => expect(screen.getByText('Docs')).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText(/bearer token/i), 'tok-1');
    await userEvent.click(screen.getByRole('button', { name: /^sync$/i }));

    await waitFor(() => expect(screen.getByText(/2 file\(s\) processed, 7 chunk\(s\) stored/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/KnowledgeBase.test.tsx`
Expected: FAIL with `Cannot find module './KnowledgeBase'`

- [ ] **Step 3: Write the page**

```tsx
// frontend/src/pages/KnowledgeBase.tsx
import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import { createKbSource, listKbSources, syncKbSource, type KbSourceSummary } from '../api/kb';
import { useToast } from '../components/ToastProvider';

export function KnowledgeBase(): React.ReactElement {
  const { showToast } = useToast();
  const [sources, setSources] = useState<KbSourceSummary[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [siteUrl, setSiteUrl] = useState('');
  const [library, setLibrary] = useState('');
  const [folder, setFolder] = useState('');
  const [areaPath, setAreaPath] = useState('');
  const [bearerToken, setBearerToken] = useState('');
  const [syncingId, setSyncingId] = useState<string | null>(null);

  useEffect(() => {
    listKbSources().then(setSources);
  }, []);

  async function handleCreate(): Promise<void> {
    const created = await createKbSource({ displayName, siteUrl, library, folder, areaPath });
    setSources((prev) => [created, ...prev]);
    setDisplayName('');
    setSiteUrl('');
    setLibrary('');
    setFolder('');
    setAreaPath('');
  }

  async function handleSync(id: string): Promise<void> {
    if (!bearerToken) {
      showToast('Bearer token is required to sync.', 'error');
      return;
    }
    setSyncingId(id);
    try {
      const result = await syncKbSource(id, bearerToken);
      if (result.filesFailed.length > 0) {
        showToast(`Synced with ${result.filesFailed.length} file(s) failed — ${result.filesProcessed} file(s) processed, ${result.chunksStored} chunk(s) stored.`, 'error');
      } else {
        showToast(`${result.filesProcessed} file(s) processed, ${result.chunksStored} chunk(s) stored.`, 'success');
      }
      setSources(await listKbSources());
    } catch {
      showToast('Sync failed — check the site URL, library, folder, and bearer token.', 'error');
    } finally {
      setSyncingId(null);
    }
  }

  return (
    <Box>
      <Typography variant="h5">Knowledge Base</Typography>
      <Box display="flex" flexDirection="column" gap={2} maxWidth={480} my={2}>
        <TextField label="Display Name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        <TextField label="Site URL" value={siteUrl} onChange={(event) => setSiteUrl(event.target.value)} />
        <TextField label="Library" value={library} onChange={(event) => setLibrary(event.target.value)} />
        <TextField label="Folder" value={folder} onChange={(event) => setFolder(event.target.value)} />
        <TextField label="Area Path" value={areaPath} onChange={(event) => setAreaPath(event.target.value)} />
        <Button
          variant="contained"
          onClick={handleCreate}
          disabled={!displayName || !siteUrl || !library || !folder || !areaPath}
        >
          Add Source
        </Button>
      </Box>
      <TextField
        label="Bearer Token (used for Sync, not stored)"
        value={bearerToken}
        onChange={(event) => setBearerToken(event.target.value)}
        fullWidth
        sx={{ maxWidth: 480, mb: 2 }}
      />
      <List>
        {sources.map((source) => (
          <ListItem
            key={source.id}
            secondaryAction={
              <Button onClick={() => handleSync(source.id)} disabled={syncingId === source.id}>
                {syncingId === source.id ? 'Syncing…' : 'Sync'}
              </Button>
            }
          >
            <ListItemText
              primary={source.displayName}
              secondary={`${source.areaPath} — last synced: ${source.lastSyncedAt ?? 'never'}`}
            />
          </ListItem>
        ))}
      </List>
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/pages/KnowledgeBase.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Add the route to `App.tsx`**

In `frontend/src/App.tsx`, add the import:

```typescript
import { KnowledgeBase } from './pages/KnowledgeBase';
```

And add the route inside the nested `<Routes>` (after `/jobs/:id`):

```typescript
                        <Route path="/jobs/:id" element={<JobDetail />} />
                        <Route path="/knowledge-base" element={<KnowledgeBase />} />
                        <Route path="/help" element={<Wiki />} />
```

- [ ] **Step 6: Add the nav link to `AppShell.tsx`**

In `frontend/src/components/AppShell.tsx`, add the icon import:

```typescript
import StorageIcon from '@mui/icons-material/Storage';
```

And add an entry to `NAV_ITEMS` (after `New Job`, before `Help`):

```typescript
const NAV_ITEMS = [
  { to: '/jobs', label: 'Jobs', icon: <WorkIcon /> },
  { to: '/jobs/new', label: 'New Job', icon: <AddIcon /> },
  { to: '/knowledge-base', label: 'Knowledge Base', icon: <StorageIcon /> },
  { to: '/help', label: 'Help', icon: <HelpIcon /> },
];
```

- [ ] **Step 7: Run the full frontend suite to confirm no regressions**

Run: `cd frontend && npm test -- --run`
Expected: all existing tests plus the new `kb.test.ts`/`KnowledgeBase.test.tsx` pass

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/KnowledgeBase.tsx frontend/src/pages/KnowledgeBase.test.tsx frontend/src/App.tsx frontend/src/components/AppShell.tsx
git commit -m "feat(kb): add Knowledge Base page, route, and nav link"
```

---

### Task 12: Full-stack live verification

**Files:** none (verification only)

**Interfaces:** none (exercises the whole P2a surface end-to-end against the mock-backed docker-compose stack)

- [ ] **Step 1: Rebuild the whole stack**

Run: `docker compose up -d --build`
Expected: all 7 services report `Started`/`Healthy`

- [ ] **Step 2: Confirm the KB API works end-to-end (mock SharePoint not available, so this proves wiring/persistence, not real content ingestion)**

Run:
```bash
curl -s -X POST http://localhost:3001/kb/sources -H "Content-Type: application/json" \
  -d '{"areaPath":"Project","siteUrl":"https://contoso.sharepoint.com/sites/s","library":"Lib","folder":"Folder","displayName":"Test Source"}'
```
Expected: JSON with an `id` and `lastSyncedAt: null`

Run: `curl -s http://localhost:3001/kb/sources`
Expected: JSON array containing the source

Run (this call will fail against a real SharePoint tenant with a fake URL — that's expected; it proves the request reaches ingestion and a clean error surfaces rather than a crash):
```bash
curl -s -X POST http://localhost:3001/kb/sources/<id-from-above>/sync -H "Content-Type: application/json" -d '{"bearerToken":"fake-token"}'
```
Expected: a `500`-range error response (SharePoint fetch failure), NOT a hang or an unhandled exception in `docker logs req2ado-orchestrator-1` / `docker logs req2ado-ingestion-1`

- [ ] **Step 3: Click through the frontend `/knowledge-base` page in a browser**

Navigate to `http://localhost:4082/knowledge-base` (authenticated session required — see the gap-closure session's approach of seeding `sessionStorage`'s `req2ado-auth` key if no real ADO login is available). Confirm: the page loads, the previously-created "Test Source" row appears with its area path, the Add Source form is present and disabled until all fields are filled.

- [ ] **Step 4: Confirm the volume persists across a rebuild**

Run: `docker compose up -d --build ingestion && curl -s http://localhost:3001/kb/sources`
Expected: the "Test Source" KB source config still lists (it's in Postgres, unaffected by ingestion rebuilds) — this step is really validating Task 5's volume mount didn't regress ingestion's boot.

- [ ] **Step 5: Report findings**

Summarize what was verified live vs. what remains unverified (real SharePoint tenant/token — not available in local dev, same class of gap as `/auth/login`'s real-ADO dependency noted in `docs/handoff-frontend-rebuild.md`).
