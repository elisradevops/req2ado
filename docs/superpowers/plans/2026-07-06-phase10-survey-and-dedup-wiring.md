# Phase 10 SURVEY Mode + Embedding Dedup Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two biggest blockers found by the Phase 9 requirements traceability review: SURVEY mode and embedding-based dedup both have real, individually-tested logic in `ingestion/app/`, but neither is reachable through the live job pipeline (`orchestrator/src/modules/pipeline/pipeline.worker.ts` only ever calls the BASELINE path, and nothing in `ingestion/app`'s runtime constructs a `ChromaVectorStore`/`OrchestratorEmbedClient`). This phase wires both, end to end, from the Upload page through to a real ADO write.

**Architecture:** A direct read of every file this phase touches (done before writing this plan), followed by an independent adversarial design review (see below), confirms the pattern and closes the review's findings:
- SURVEY needs exactly one new capability class-side change (extend the already-real `OrchestratorLlmClient` — which already correctly calls the orchestrator's `POST /llm/chat` proxy for `generate_requirements` — with an `infer_hierarchy` method and a BATCHED whole-document requirement-generation method, satisfying `LlmLevelingClient`'s Protocol via the same class, not a separate one), one new ingestion-side orchestration change that actually calls the (now-batched) requirement generation and folds the formalized text back into `WorkItemNode.description`/`.tags` (today `build_survey_tree` never calls it at all), and a `mode` parameter threaded through `POST /level` → `IngestionHttpClient.level()` → `pipeline.worker.ts` → `JobsService.submit()` → `JobsController.submit()` → `Upload.tsx`'s already-built-but-disabled Survey radio button.
- Embedding dedup needs the mirror-image real client (`OrchestratorEmbedClient`, already correct) actually constructed somewhere, two new ingestion routes (`POST /dedup/check`, `POST /dedup/upsert` — neither exists today; `ingestion/app/main.py` has exactly three routes and none of them touch `app.dedup`), a new `DryRunDiffEntry.action` value (`dedup_skip`, distinct from the existing exact-hash `reuse`) so a probabilistic match is never silently conflated with a certain one, and an upsert call from `JobsService.confirm()` after every real create so future submissions can actually find it — the existing `check_for_duplicates()` function deliberately never upserts, by design (its own docstring), so a caller has always been required to do this and none exists yet.
- Neither ingestion nor `IngestionHttpClient` currently reads or sends `mode` at all — confirmed via direct code read, not assumed.
- SURVEY nodes need a real `fidelity_hash` too: `build_survey_tree` currently sets it to `None` (correct for a phase where SURVEY was never going to reach the dry-run/idempotency system), but `DryRunTreeNode.sourceHash`/`DryRunDiffEntry.sourceHash` are typed as non-nullable `string` on the TS side, and `IdempotencyService.lookup` needs a real key. This phase computes `fidelity_hash = sha256(final description)` for SURVEY nodes too — same field, same downstream meaning ("hash of the content that was actually written"), just computed over LLM-formalized text instead of a verbatim source span. This keeps every existing TS type and the idempotency system completely untouched. **Caveat, documented not hidden:** this hash is over LLM OUTPUT, not a verbatim source span — `temperature=0` is mostly-but-not-guaranteed deterministic, so a model/prompt change can shift the hash and produce a duplicate create on re-run. Weaker than BASELINE's guarantee; embedding dedup partially backstops it but isn't a substitute.

**Design review findings folded in (an independent adversarial Plan-agent pass against the first draft of this plan found real gaps — each is now a Global Constraint or an explicit step below, not a lingering risk):**
1. The first draft made ~2 LLM calls per node (title distillation + requirement generation) plus 1 for hierarchy — ~101 sequential blocking calls for a 50-block document, on ingestion's single-worker event loop. Fixed: no separate title-distillation LLM call at all (title is derived deterministically from the first generated requirement's text via the existing `extract_baseline_title`); requirement generation is batched into ONE call for the whole document, mirroring how `infer_hierarchy` already sends the whole outline in one call. ~101 calls become ~2.
2. `build_survey_tree`'s synchronous `httpx` calls block the whole ingestion process (single uvicorn worker, no `--workers`) for the entire duration of a SURVEY job. Fixed: the `/level` route wraps the SURVEY call in FastAPI's `run_in_threadpool`.
3. `ChromaVectorStore`'s local `PersistentClient` does not survive horizontal scaling (each ingestion instance would hold a different partial corpus) — this is a REAL, DOCUMENTED limitation for this phase (see Global Constraints), not fixed now; externalizing to a shared Chroma server is separate, deferred infra scope.
4. A `dedup_skip` match must never cause `confirm()` to re-parent an EXISTING ADO item under a new parent from the current document — that would silently mutate real ADO hierarchy based on a probabilistic guess. New children CAN still link up to a dedup_skip node's matched real id; the dedup_skip node itself, when it has a parent, must not get re-linked.
5. An embedding-service outage must not fail BASELINE jobs, which had zero LLM/embed dependency before this phase. `dedupCheck` fails OPEN (falls through to `action: 'create'`, logs the failure) rather than throwing and failing the whole diff.
6. Local models (the golden test's real target, e.g. Ollama) routinely wrap JSON in markdown fences despite being told not to — both new LLM-parsing call sites strip fences before `json.loads` rather than letting one fenced response fail an entire job.
7. The frontend's diff renderer (`JobStatus.tsx`) needs a visual state for `dedup_skip` distinct from `create`/`reuse` — not in the original draft, added as Task 10.

**Tech Stack:** No new dependencies for the HTTP calls (`httpx`, already present). FastAPI's built-in `starlette.concurrency.run_in_threadpool` for the event-loop-blocking fix (no new dependency — part of the already-installed `fastapi`/`starlette`).

## Global Constraints

- Every existing test in every package must keep passing unchanged. This phase is additive — BASELINE mode's code path, types, and behavior do not change.
- `mode` defaults to `'baseline'` everywhere it's threaded through (config schema, request bodies, DB column) — an operator who does nothing differently gets byte-identical behavior to before this phase.
- Do NOT touch `mcp-ado-server`, `RealAdoBackend`, or anything in the ADO write-back path itself — this phase is entirely about getting the RIGHT tree/diff TO that path, not changing how writes happen once a diff is confirmed.
- A dedup match (`dedup_skip`) is a PROBABILISTIC judgment (cosine similarity ≥ threshold), not a certain fact the way an exact-hash `reuse` match is. Never merge these two into the same `action` value — a reviewer looking at the dry-run diff must be able to tell "this is definitely the same content" from "this is probably the same content" at a glance.
- `check_for_duplicates()`'s own docstring is explicit that it never upserts — respect that boundary; the upsert call is a separate, deliberate step added in this phase, triggered only by a real confirmed write, never by a dry-run check.
- A dedup-skipped node's existing ADO parent link is NEVER touched — `confirm()` must not call `linkParentChild` when the CHILD side of a link is a `dedup_skip` entry.
- A dedup-check FAILURE (embedding service down, network error, anything) must never fail a job — fail open to `action: 'create'`, never fail closed.
- SURVEY mode must not block ingestion's event loop for other concurrent requests — the LLM-calling code path runs off the event loop (`run_in_threadpool` or equivalent), not inline in an `async def` route handler.
- Dedup is explicitly a single-ingestion-instance feature for this phase (local Chroma `PersistentClient`) — do not attempt to make it safe for horizontal scaling in this phase; document the limitation instead (see Task 6).
- Type hints/explicit types on every function signature; existing repo test conventions per package.

---

## Part A: SURVEY Mode Wiring

### Task 1: Extend `OrchestratorLlmClient` with `infer_hierarchy` and batched requirement generation

**Files:**
- Modify: `ingestion/app/survey/orchestrator_llm_client.py`
- Test: `ingestion/tests/test_orchestrator_llm_client.py` (append)

**Interfaces:** `OrchestratorLlmClient` gains `infer_hierarchy` (satisfying `LlmLevelingClient`) and `generate_requirements_for_document` — a NEW, whole-document, single-call method distinct from the existing per-block `generate_requirements` (kept as-is, still used elsewhere/by tests, not removed — this task adds a second, batched entry point rather than changing the existing one's contract). Per the design review, there is deliberately NO title-distillation method added — see Task 2 for why the title-distillation LLM call is eliminated instead of implemented.

**Boundary:** Only touch the one file + its test. Do not modify `llm_leveling.py`, `survey_title.py`, `build_survey_requirements.py`, or `requirement_client.py` in this task — Task 2 modifies `llm_leveling.py`.

- [ ] **Step 1: Confirm the exact current file before extending it**

Run: `cat ingestion/app/survey/orchestrator_llm_client.py` — confirm the existing `generate_requirements` method and constructor shape match what this plan assumes (base_url/bearer_token stored, `httpx.Client(transport=self._transport)`, POST to `{base_url}/llm/chat`).

- [ ] **Step 2: Add a fence-tolerant JSON helper (shared by both new call sites)**

```python
# ingestion/app/survey/orchestrator_llm_client.py — add near the top of the file
import re

_JSON_FENCE_PATTERN = re.compile(r"^```(?:json)?\s*\n?(.*?)\n?```$", re.DOTALL)


def _strip_json_fence(content: str) -> str:
    """Local models (Ollama included — the golden test's real target) often
    wrap JSON in markdown fences despite being explicitly told not to. Strip
    a single leading/trailing fence if present; otherwise return unchanged.
    Cheap insurance against a single fenced response failing an entire job."""
    match = _JSON_FENCE_PATTERN.match(content.strip())
    return match.group(1).strip() if match else content.strip()
```

- [ ] **Step 3: Add `infer_hierarchy`**

```python
# ingestion/app/survey/orchestrator_llm_client.py — add this method to the existing class
    def infer_hierarchy(self, outline: str, profile_hint: object | None) -> list[dict]:
        # profile_hint is currently unused by the real prompt — LlmLevelingClient's
        # Protocol declares it for future profile-aware prompting, not exercised yet.
        system_prompt = (
            "You infer a work-item hierarchy from an outline of requirement text. "
            "Each line of the outline is one candidate node, addressed by its "
            "0-based line index as a string. Return ONLY a JSON array of objects, "
            "each with 'node_id' (the line index as a string), 'type' (one of: "
            "Epic, Feature, Requirement), and 'parent_id' (the node_id of its "
            "parent, or null for a root node). Honor 'same depth, different type "
            "per branch' when the content implies it. Never invent a node_id not "
            "present in the outline. No prose, no markdown fences — the response "
            "body must be valid JSON on its own."
        )
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": outline},
            ],
            "temperature": 0,
        }
        with httpx.Client(transport=self._transport) as client:
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

- [ ] **Step 4: Add `generate_requirements_for_document` — ONE call for the whole document, not one per block**

```python
# ingestion/app/survey/orchestrator_llm_client.py — add this method too
    def generate_requirements_for_document(self, blocks_by_node_id: dict[str, str]) -> dict[str, list[dict]]:
        """Batched sibling of generate_requirements: one LLM call for every
        node in the tree, not one call per node. A first draft of this
        wiring made ~2 LLM calls per node (title distillation + per-block
        requirement generation) — for a 50-block document, ~101 sequential
        blocking calls. This method and dropping title distillation entirely
        (see llm_leveling.py) cut that to ~2 total calls per document,
        mirroring how infer_hierarchy already sends the whole outline in one
        call rather than one call per line."""
        system_prompt = (
            "You convert several informal requirement blocks into formal 'shall' "
            "statements. You are given a JSON object mapping each block's node_id "
            "to its raw text. Return ONLY a JSON object with the SAME node_id keys, "
            "each mapped to a list of objects with 'text' (a single formal "
            "shall-style requirement sentence) and 'tags' (a list of zero or more "
            "of: functional, non_functional, interface, performance, regulatory, "
            "safety, security, operation, maintenance, feature, behavior). A block "
            "that yields no formal requirement (e.g. a heading) maps to an empty "
            "list. Never invent a node_id not present in the input. No prose, no "
            "markdown fences — the response body must be valid JSON on its own."
        )
        payload = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(blocks_by_node_id)},
            ],
            "temperature": 0,
        }
        with httpx.Client(transport=self._transport) as client:
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

- [ ] **Step 5: Tests**

Follow this test file's existing pattern exactly (it already mocks `httpx` via the `_transport` injection seam for `generate_requirements` — mirror that for the two new methods):

```python
# Append to ingestion/tests/test_orchestrator_llm_client.py
def test_infer_hierarchy_parses_the_response_into_a_hierarchy_list():
    # mock transport returning a JSON array of {node_id, type, parent_id} objects,
    # assert infer_hierarchy(outline, None) returns it parsed and matches the
    # request body shape (messages, temperature=0) and Authorization header,
    # matching this file's existing test_generate_requirements_* pattern exactly.

def test_infer_hierarchy_raises_on_malformed_json():
    # mirrors the existing malformed-JSON test for generate_requirements.

def test_infer_hierarchy_strips_a_markdown_json_fence():
    # mock transport returning content wrapped in ```json ... ``` fences,
    # assert infer_hierarchy still parses it correctly.

def test_generate_requirements_for_document_sends_all_blocks_in_one_call():
    # mock transport returning {"n0": [{"text": "...", "tags": []}], "n1": []},
    # assert generate_requirements_for_document({"n0": "...", "n1": "..."})
    # returns the parsed dict, and assert the mock transport was invoked
    # EXACTLY ONCE (proves batching, not per-block calls).

def test_generate_requirements_for_document_strips_a_markdown_json_fence():
    # same fence-stripping proof as infer_hierarchy's version.
```

- [ ] **Step 6: Run to verify**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_orchestrator_llm_client.py -v` — expect all pass, no regressions.

- [ ] **Step 7: Commit**

```bash
git add ingestion/app/survey/orchestrator_llm_client.py ingestion/tests/test_orchestrator_llm_client.py
git commit -m "feat(ingestion): extend OrchestratorLlmClient with infer_hierarchy and batched whole-document requirement generation"
```

---

### Task 2: Fold batched requirement generation into `build_survey_tree`, drop the title-distillation LLM call

**Files:**
- Modify: `ingestion/app/leveling/llm_leveling.py`
- Test: `ingestion/tests/test_llm_leveling.py` (append/update)

**Interfaces:** `build_survey_tree`'s signature gains a `requirement_client` parameter typed against a NEW, narrower Protocol (`BatchedRequirementClient`, one method: `generate_requirements_for_document`) — NOT the existing `SurveyRequirementClient`/`TitleDistillationClient` (both dropped from this function's signature entirely; `title_client` is removed). `description`/`tags` come from the batched call's result; `title` is derived from that same result via the existing `extract_baseline_title`, with NO LLM call for titling — per the design review, `distill_survey_title`/`TitleDistillationClient` are not touched or used anywhere in this phase (left exactly as they are, unused, for a future phase if real per-node title distillation is ever wanted).

**Boundary:** Only touch `llm_leveling.py` and its test. Do not touch `build_survey_requirements.py`, `requirement_client.py`, or `survey_title.py` — none of the three are used by this task; leave them exactly as they are.

- [ ] **Step 1: Confirm the exact current `build_survey_tree` body before modifying**

Run: `cat ingestion/app/leveling/llm_leveling.py` — confirm the node-construction loop matches what Step 2 below modifies (description=display_text, tags=[], fidelity_hash=None, title via `distill_survey_title`).

- [ ] **Step 2: Rewrite the node loop around the batched call, drop title distillation**

```python
# ingestion/app/leveling/llm_leveling.py
from __future__ import annotations

import hashlib
from typing import Protocol

from app.canonical.model import CanonicalDoc
from app.distillation.title import extract_baseline_title
from app.leveling.depth import resolve_block_depth
from app.leveling.profiles import LevelingProfile
from app.workitem.model import RequirementTag, WorkItemMode, WorkItemNode, WorkItemTree, WorkItemType


class LlmLevelingClient(Protocol):
    """... (unchanged docstring) ..."""

    def infer_hierarchy(self, outline: str, profile_hint: LevelingProfile | None) -> list[dict]: ...


class BatchedRequirementClient(Protocol):
    """Interface for whole-document SURVEY requirement generation — one call
    covering every node, not one call per node (see
    OrchestratorLlmClient.generate_requirements_for_document's docstring for
    why: a per-node design made ~101 sequential LLM calls for a 50-block
    document). Deliberately narrower than SurveyRequirementClient (which is
    still used by build_survey_requirements.py for its own single-block
    callers, untouched by this phase) — this Protocol's single method takes
    ALL blocks at once."""

    def generate_requirements_for_document(self, blocks_by_node_id: dict[str, str]) -> dict[str, list[dict]]: ...


def _build_outline(doc: CanonicalDoc) -> str:
    lines = []
    for block in doc.blocks:
        _, display_text = resolve_block_depth(block)
        lines.append(display_text)
    return "\n".join(lines)


def build_survey_tree(
    doc: CanonicalDoc,
    llm_client: LlmLevelingClient,
    requirement_client: BatchedRequirementClient,
) -> WorkItemTree:
    """SURVEY-mode leveling: infers hierarchy, then formalizes every node's
    description into 'shall'-style requirement text + taxonomy tags via ONE
    batched call (see BatchedRequirementClient's docstring for why this is
    one call, not one per node). Title is derived deterministically from the
    first generated requirement's text via extract_baseline_title — NO LLM
    call for titling (a first draft added a distill_title LLM call; dropped
    per the design review, since extract_baseline_title already does the
    truncation work with no quality loss and no extra round-trip). Multiple
    generated requirements for one block are joined with a blank line
    between them — a block can legitimately decompose into more than one
    formal requirement. fidelity_hash is computed over the FINAL (formalized)
    description, since that's the content actually written to ADO and the
    idempotency map's key must match what a re-run would produce — but note
    this is a WEAKER guarantee than BASELINE's verbatim-source-span hash:
    temperature=0 is mostly-but-not-guaranteed deterministic, so a model or
    prompt change can shift this hash and produce a duplicate create on
    re-run. Embedding dedup partially backstops this; it is not a substitute."""
    outline = _build_outline(doc)
    hierarchy = llm_client.infer_hierarchy(outline, profile_hint=None)

    block_by_index = {str(i): block for i, block in enumerate(doc.blocks)}
    hierarchy_by_node_id = {entry["node_id"]: entry for entry in hierarchy}
    blocks_by_node_id = {
        node_id: resolve_block_depth(block_by_index[node_id])[1]
        for node_id in hierarchy_by_node_id
        if node_id in block_by_index
    }
    generated_by_node_id = requirement_client.generate_requirements_for_document(blocks_by_node_id)

    nodes: list[WorkItemNode] = []
    for node_id, entry in hierarchy_by_node_id.items():
        block = block_by_index.get(node_id)
        if block is None:
            continue
        display_text = blocks_by_node_id[node_id]
        raw_generated = generated_by_node_id.get(node_id, [])

        if raw_generated:
            description = "\n\n".join(item["text"] for item in raw_generated)
            tags = sorted(
                {RequirementTag(tag) for item in raw_generated for tag in item.get("tags", [])},
                key=lambda t: t.value,
            )
            title = extract_baseline_title(raw_generated[0]["text"])
        else:
            # No formal requirement extracted (e.g. a heading-only block) —
            # fall back to the raw display text rather than an empty
            # description, which would otherwise silently discard content.
            description = display_text
            tags = []
            title = extract_baseline_title(display_text)

        nodes.append(
            WorkItemNode(
                local_id=node_id,
                type=WorkItemType(entry["type"]),
                parent_local_id=entry["parent_id"],
                title=title,
                description=description,
                customer_id=None,
                source_ref=block.source_ref,
                fidelity_hash=hashlib.sha256(description.encode()).hexdigest(),
                tags=tags,
                mode=WorkItemMode.SURVEY,
            )
        )
    return WorkItemTree(nodes=nodes)
```

- [ ] **Step 3: Update existing tests for the new signature**

`ingestion/tests/test_llm_leveling.py` and `ingestion/tests/test_worktree_schema_conformance.py` both construct `FakeLlmLevelingClient` and call `build_survey_tree` — grep for every call site. Remove any `title_client`/`FakeTitleDistillationClient` argument (no longer part of the signature) and add a `FakeBatchedRequirementClient` (new fake, implementing `generate_requirements_for_document(blocks_by_node_id) -> dict[str, list[dict]]`) as the replacement second-to-last argument. Add tests asserting: (a) `fidelity_hash` is non-null and stable across two identical calls (mirroring BASELINE's own hash-stability test pattern); (b) `generate_requirements_for_document` is called EXACTLY ONCE per `build_survey_tree` call regardless of node count (proves the batching actually happened, not just that the code compiles); (c) a node with no generated requirements (empty list) falls back to the raw display text as its description, not an empty string.

- [ ] **Step 4: Run to verify**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_llm_leveling.py tests/test_worktree_schema_conformance.py -v` — expect all pass.

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/leveling/llm_leveling.py ingestion/tests/test_llm_leveling.py ingestion/tests/test_worktree_schema_conformance.py
git commit -m "feat(ingestion): fold batched requirement generation into build_survey_tree, drop the per-node title-distillation LLM call, add real fidelity_hash for SURVEY nodes"
```

---

### Task 3: Ingestion config module + `mode` branch in `/level`

**Files:**
- Create: `ingestion/app/config.py`
- Modify: `ingestion/app/main.py`
- Test: `ingestion/tests/test_ingest_endpoint.py` or a new `ingestion/tests/test_level_endpoint.py` (grep first for where `/level` already has coverage)

**Interfaces:** New env vars `ORCHESTRATOR_URL`, `LLM_PROXY_BEARER` (ingestion's own copies — matches the orchestrator's own env var name for the same secret, since it's the same bearer both sides must agree on). `POST /level` gains a `mode: str = "baseline"` query/body param.

**Boundary:** Only touch the two files + test. Confirmed via grep before writing this plan: no config module exists anywhere under `ingestion/app` today — this is the first one.

- [ ] **Step 1: Confirm no existing ingestion config module**

Run: `find ingestion/app -iname "config*.py"` — expect empty, confirming this is new.

- [ ] **Step 2: Write the config module**

```python
# ingestion/app/config.py
from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Ingestion's own config surface — did not exist before this phase.
    ORCHESTRATOR_URL/LLM_PROXY_BEARER let ingestion call BACK into the
    orchestrator's /llm/chat and /llm/embed proxies (never any LLM endpoint
    directly — same 'backend proxy, redact-first' boundary every real client
    in ingestion/app/survey and ingestion/app/dedup already documents in its
    own docstring). CHROMA_PERSIST_PATH has no default in ChromaVectorStore
    itself (its constructor requires a path) — this is where that path
    actually comes from at runtime."""

    orchestrator_url: str = "http://localhost:3001"
    llm_proxy_bearer: str = "dev-local-only"
    chroma_persist_path: str = "./.req2ado/vectors"

    class Config:
        env_prefix = ""


settings = Settings()
```

Check `ingestion/pyproject.toml` for `pydantic-settings` — if absent, add it (it's a natural extension of the already-present `pydantic` dependency, not a new ecosystem).

- [ ] **Step 3: Wire `mode` into `/level`**

```python
# ingestion/app/main.py
import tempfile
from pathlib import Path

from fastapi import FastAPI, UploadFile
from starlette.concurrency import run_in_threadpool

from app.canonical.model import CanonicalDoc
from app.config import settings
from app.dispatch import dispatch_by_extension
from app.leveling.llm_leveling import build_survey_tree
from app.leveling.tree_builder import build_baseline_tree
from app.redaction.redactor import redact_canonical_doc
from app.survey.orchestrator_llm_client import OrchestratorLlmClient
from app.workitem.model import WorkItemTree

app = FastAPI(title="req2ado-ingestion")


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/ingest", response_model=CanonicalDoc)
async def ingest(file: UploadFile, redact: bool = False, languages: str = "eng") -> CanonicalDoc:
    suffix = Path(file.filename or "").suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        doc = dispatch_by_extension(file.filename or "", tmp_path, languages=languages)
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    if redact:
        doc = redact_canonical_doc(doc)
    return doc


@app.post("/level", response_model=WorkItemTree)
async def level(doc: CanonicalDoc, customer_id: str | None = None, mode: str = "baseline") -> WorkItemTree:
    if mode == "survey":
        # One real client instance satisfies both Protocols build_survey_tree
        # needs (LlmLevelingClient, BatchedRequirementClient) — see Task 1's
        # docstring. run_in_threadpool: OrchestratorLlmClient's HTTP calls are
        # synchronous (httpx.Client, not an async client) — calling
        # build_survey_tree inline in this async route would block ingestion's
        # single-worker event loop for the whole job's duration, starving
        # every other concurrent request (including /health). Moving the
        # blocking work to FastAPI's threadpool keeps the loop free.
        client = OrchestratorLlmClient(settings.orchestrator_url, settings.llm_proxy_bearer)
        return await run_in_threadpool(build_survey_tree, doc, llm_client=client, requirement_client=client)
    return build_baseline_tree(doc, customer_id=customer_id)
```

Also add `from starlette.concurrency import run_in_threadpool` to `main.py`'s imports (part of the already-installed `fastapi`/`starlette` dependency, no new package).

- [ ] **Step 4: Tests**

```python
# New or appended test — mock OrchestratorLlmClient's HTTP calls (same
# transport-injection pattern as Task 1/2's tests) and assert:
# - POST /level with no mode (or mode=baseline) still calls build_baseline_tree
#   and is completely unaffected by this change (regression guard).
# - POST /level?mode=survey routes to build_survey_tree and returns a tree
#   whose nodes have mode="SURVEY".
```

- [ ] **Step 5: Run to verify**

Run: `cd ingestion && source .venv/bin/activate && pytest -v` — expect the full existing suite (148 passing baseline, 7 pre-existing poppler-gated failures unrelated) plus new tests, zero regressions to the BASELINE path.

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/config.py ingestion/app/main.py ingestion/pyproject.toml ingestion/tests/
git commit -m "feat(ingestion): add config module, wire mode=survey into POST /level"
```

---

### Task 4: Thread `mode` through the orchestrator and frontend

**Files:**
- Modify: `orchestrator/src/modules/pipeline/ingestion-http.client.ts`
- Modify: `orchestrator/src/modules/pipeline/pipeline.worker.ts`
- Modify: `orchestrator/src/modules/pipeline/jobs.service.ts`
- Modify: `orchestrator/src/modules/pipeline/jobs.controller.ts`
- Modify: `frontend/src/pages/Upload.tsx`
- Test: `orchestrator/test/ingestion-http.client.spec.ts`, `orchestrator/test/pipeline.worker.spec.ts`, `orchestrator/test/jobs.controller.e2e-spec.ts`, `frontend/src/pages/Upload.test.tsx` (append to each)

**Interfaces:** `IngestionHttpClient.level()` gains a `mode: 'baseline' | 'survey'` parameter. `PipelineJobInput`/`SubmitJobInput`/the BullMQ queue payload all gain `mode`. `POST /jobs` accepts an optional `mode` field in the multipart body (default `'baseline'`). `Upload.tsx`'s Survey radio becomes selectable.

**Boundary:** Only touch the five files listed + their tests. Do not change any BASELINE-path logic — `mode` defaulting to `'baseline'` everywhere must produce byte-identical behavior to before this task.

- [ ] **Step 1: `IngestionHttpClient.level()`**

```typescript
// orchestrator/src/modules/pipeline/ingestion-http.client.ts
  async level(
    doc: Record<string, unknown>,
    customerId: string | null,
    mode: 'baseline' | 'survey' = 'baseline',
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ mode });
    if (customerId) params.set('customer_id', customerId);
    const response = await fetch(`${this.baseUrl}/level?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    });
    if (!response.ok) {
      throw new Error(`Ingestion /level request failed: ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }
```

- [ ] **Step 2: `pipeline.worker.ts`**

```typescript
// orchestrator/src/modules/pipeline/pipeline.worker.ts — add mode to PipelineJobInput:
export interface PipelineJobInput {
  id: string;
  areaPath: string;
  customerId: string | null;
  mode: 'baseline' | 'survey';
  fileBuffer: Buffer;
  filename: string;
}

// inside runPipelineJob, pass job.mode through:
    const tree = (await deps.ingestionClient.level(doc, job.customerId, job.mode)) as { nodes: LeveledNode[] };
```

- [ ] **Step 3: `jobs.service.ts`**

```typescript
// orchestrator/src/modules/pipeline/jobs.service.ts
export interface SubmitJobInput {
  userId: string;
  areaPath: string;
  customerId: string | null;
  mode: 'baseline' | 'survey';
  fileBuffer: Buffer;
  filename: string;
  sourceHash: string;
}

// inside submit(), replace the hardcoded literal:
    const job = await this.prisma.job.create({
      data: {
        userId: input.userId,
        mode: input.mode,
        status: 'pending',
        sourceHash: input.sourceHash,
        areaPath: input.areaPath,
        customerId: input.customerId,
        originalFilename: input.filename,
      },
    });
    await this.queue.add('ingest-and-level', {
      id: job.id,
      areaPath: input.areaPath,
      customerId: input.customerId,
      mode: input.mode,
      fileBufferBase64: input.fileBuffer.toString('base64'),
      filename: input.filename,
    });
```

- [ ] **Step 4: `jobs.controller.ts`**

```typescript
// orchestrator/src/modules/pipeline/jobs.controller.ts — inside submit():
  async submit(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('areaPath') areaPath: string | undefined,
    @Body('customerId') customerId: string | undefined,
    @Body('mode') mode: string | undefined,
  ): Promise<{ jobId: string }> {
    // ... existing file/areaPath validation unchanged ...
    if (mode !== undefined && mode !== 'baseline' && mode !== 'survey') {
      throw new BadRequestException(`mode must be 'baseline' or 'survey', got: ${mode}`);
    }
    const sourceHash = createHash('sha256').update(file.buffer).digest('hex');
    return this.jobsService.submit({
      userId: 'placeholder-user-id',
      areaPath,
      customerId: customerId ?? null,
      mode: (mode as 'baseline' | 'survey' | undefined) ?? 'baseline',
      fileBuffer: file.buffer,
      filename: file.originalname,
      sourceHash,
    });
  }
```

Also check `pipeline-worker.main.ts`'s `QueuedJobData` type (decodes the base64 buffer back out) — it must also carry `mode` through, since it's a `Omit<PipelineJobInput, 'fileBuffer'> & {...}` shape per Phase 9's own fix — grep for its exact current definition before editing, don't assume.

- [ ] **Step 5: `Upload.tsx`**

```tsx
// frontend/src/pages/Upload.tsx
export function Upload({ onJobSubmitted }: UploadProps): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [areaPath, setAreaPath] = useState('');
  const [mode, setMode] = useState<'baseline' | 'survey'>('baseline');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'error'>('idle');

  const handleSubmit = async (): Promise<void> => {
    if (!file || !areaPath) return;
    setStatus('submitting');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('areaPath', areaPath);
      form.append('mode', mode);
      const response = await httpClient.post('/jobs', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      onJobSubmitted(response.data.jobId);
    } catch {
      setStatus('error');
    }
  };

  return (
    // ... unchanged JSX above the RadioGroup ...
          <RadioGroup value={mode} onChange={(e) => setMode(e.target.value as 'baseline' | 'survey')} sx={{ mb: 3 }}>
            <FormControlLabel value="baseline" control={<Radio />} label="Baseline — verbatim, deterministic" />
            <FormControlLabel value="survey" control={<Radio />} label="Survey — generative, formalized requirements" />
          </RadioGroup>
    // ... rest unchanged ...
  );
}
```

Remove the now-inapplicable `Tooltip`/`disabled` wrapper around the Survey option and its "coming soon" label — this is exactly what this whole phase exists to make no longer true. Update `Upload.test.tsx`'s existing tests for the new controlled `RadioGroup` (was a hardcoded literal `value="baseline"` with no `onChange` before) and add one new test selecting Survey and asserting the submitted `FormData` includes `mode=survey`.

- [ ] **Step 6: Tests + run**

Update/append tests per each file above, matching each test file's existing conventions (grep the file first). Run:
```bash
cd orchestrator && npx jest
cd ../frontend && npx vitest run
```
Expect zero regressions plus new passing tests for the mode threading.

- [ ] **Step 7: Commit**

```bash
git add orchestrator/src/modules/pipeline/ingestion-http.client.ts orchestrator/src/modules/pipeline/pipeline.worker.ts orchestrator/src/modules/pipeline/pipeline-worker.main.ts orchestrator/src/modules/pipeline/jobs.service.ts orchestrator/src/modules/pipeline/jobs.controller.ts orchestrator/test/ frontend/src/pages/Upload.tsx frontend/src/pages/Upload.test.tsx
git commit -m "feat: thread mode=baseline|survey end-to-end from Upload through to ingestion's /level"
```

---

### Task 5: Golden test for SURVEY mode

**Files:**
- Modify: `scripts/run-golden-e2e.sh` (add a second scenario, don't replace the BASELINE one)
- Create: `docs/golden-e2e-survey-fixture.txt` (a small, informal, synthetic note — not a real requirement document)

**Interfaces:** None new — this proves Tasks 1-4 compose correctly against the real mock ADO backend.

**Boundary:** Only touch these two files. Do not modify the existing BASELINE scenario's assertions.

- [ ] **Step 1: Write a small informal fixture**

```
# docs/golden-e2e-survey-fixture.txt
the receiver needs to handle at least 4 channels at once, and honestly the power draw
should probably stay under 2 watts or the thermal budget gets tight. also whatever
we ship needs to survive a basic drop test, nothing fancy.
```

- [ ] **Step 2: Add a SURVEY scenario to the golden script**

```bash
# Append to scripts/run-golden-e2e.sh, after the existing BASELINE assertions,
# before the final cleanup/PASSED line:

log "Submitting job #3 (SURVEY mode, informal fixture)"
JOB3_RESPONSE=$(curl -sf -X POST "http://localhost:${ORCH_PORT}/jobs" \
  -F "file=@${ROOT_DIR}/docs/golden-e2e-survey-fixture.txt" \
  -F "areaPath=${AREA_PATH}" \
  -F "mode=survey")
JOB3_ID="$(echo "$JOB3_RESPONSE" | jq -r '.jobId')"
log "Job #3 id: $JOB3_ID"

JOB3_BODY="$(poll_job_status "$JOB3_ID")"
JOB3_STATUS="$(echo "$JOB3_BODY" | jq -r '.status')"
if [ "$JOB3_STATUS" != "diff_ready" ]; then
  log "Job #3 (SURVEY) did not reach diff_ready. Body: $JOB3_BODY"
  exit 1
fi

JOB3_TITLES="$(echo "$JOB3_BODY" | jq -r '.dryRunDiff[].title')"
log "Job #3 (SURVEY) generated titles: $JOB3_TITLES"
if [ -z "$JOB3_TITLES" ]; then
  log "ASSERTION FAILED: SURVEY job produced no titled nodes at all"
  exit 1
fi

log "GOLDEN E2E (SURVEY) PASSED: job #3 produced $(echo "$JOB3_BODY" | jq '.dryRunDiff | length') node(s) from an informal fixture."
```

This requires a real (or realistically-mocked) LLM behind `LLM_BASE_URL` for the script's environment — if none is available when this task runs, report `DONE_WITH_CONCERNS` with the exact blocker rather than fake a pass, per this project's established honesty convention. A live local Ollama (per the earlier session's own findings — `LLM_BASE_URL=http://localhost:11434/v1` works against `chat()` unmodified) is the natural choice here since the golden script already runs everything else as local processes.

- [ ] **Step 3: Run and verify**

Run: `bash scripts/run-golden-e2e.sh` with a real or locally-running Ollama available. Expect both the existing BASELINE assertions AND the new SURVEY assertion to pass in the same run.

- [ ] **Step 4: Commit**

```bash
git add scripts/run-golden-e2e.sh docs/golden-e2e-survey-fixture.txt
git commit -m "test: add a SURVEY-mode scenario to the golden E2E script"
```

---

## Part B: Embedding Dedup Wiring

### Task 6: Ingestion dedup routes — `/dedup/check` and `/dedup/upsert`

**Files:**
- Modify: `ingestion/app/main.py`
- Test: new `ingestion/tests/test_dedup_endpoints.py`

**Interfaces:**
- `POST /dedup/check` — body `{text: string, area_path: string}` → `DuplicateCheckResult` (`is_duplicate`, `matched_item_id`, `similarity`).
- `POST /dedup/upsert` — body `{item_id: string, text: string, area_path: string}` → `{ok: true}`.

**Boundary:** Only touch `main.py` + the new test file. Do not modify `check_for_duplicates.py`/`vector_store.py`/`orchestrator_embed_client.py` — all three are already correct, just never constructed anywhere.

- [ ] **Step 1: Confirm no dedup routes exist today**

Run: `grep -n "dedup" ingestion/app/main.py` — expect no output, confirming this is new.

- [ ] **Step 2: Add the two routes**

```python
# ingestion/app/main.py — add these imports and routes
from pydantic import BaseModel

from app.config import settings
from app.dedup.check_for_duplicates import DuplicateCheckResult, check_for_duplicates
from app.dedup.orchestrator_embed_client import OrchestratorEmbedClient
from app.dedup.vector_store import ChromaVectorStore

_embed_client = OrchestratorEmbedClient(settings.orchestrator_url, settings.llm_proxy_bearer)
_vector_store = ChromaVectorStore(settings.chroma_persist_path)


class DedupCheckRequest(BaseModel):
    text: str
    area_path: str


class DedupUpsertRequest(BaseModel):
    item_id: str
    text: str
    area_path: str


@app.post("/dedup/check", response_model=DuplicateCheckResult)
async def dedup_check(body: DedupCheckRequest) -> DuplicateCheckResult:
    return check_for_duplicates(body.text, item_id="", area_path=body.area_path, embed_client=_embed_client, vector_store=_vector_store)


@app.post("/dedup/upsert")
async def dedup_upsert(body: DedupUpsertRequest) -> dict[str, bool]:
    [embedding] = _embed_client.embed([body.text])
    _vector_store.upsert(body.item_id, embedding, body.area_path)
    return {"ok": True}
```

Note: `check_for_duplicates`'s `item_id` parameter is unused inside the function itself (confirmed by reading its body — it only uses `text`/`area_path`/`embed_client`/`vector_store`/`threshold`; `item_id` is accepted but never referenced) — passing an empty string for the check call is harmless, not a hack, but flag this as a minor observation in the task's completion report since it's a slightly confusing parameter to require without using.

- [ ] **Step 3: Module-level client construction — confirm this is safe, document the real scaling limitation**

`_embed_client`/`_vector_store` are constructed once at import time (module load), matching the same pattern `mcp-ado-server/src/index.ts` used for its `MockAdoBackend` (one shared, stateful instance for the process's lifetime) — `ChromaVectorStore` is exactly this kind of resource (a persistent on-disk store meant to accumulate state across requests), so this is the correct construction pattern, not an oversight of Phase 9's per-request-credential lesson (that lesson applies to per-USER credentialed resources like `RealAdoBackend`, not to a shared local vector store).

**Real, documented limitation (design review finding, not silently assumed away):** `ChromaVectorStore`'s local `chromadb.PersistentClient` does NOT survive horizontal scaling. `docs/architecture.md` calls out "Python ingestion as horizontally-scaled compute service" as a requirement — dedup does not meet that requirement in this phase. If ingestion ever runs as more than one instance/container, each gets its own independent, incomplete copy of the corpus (a document upserted via instance A is invisible to a dedup check served by instance B), and if instances somehow shared a volume instead, local SQLite-backed Chroma risks lock contention/corruption under concurrent writers. Add this exact comment above the module-level construction:

```python
# LIMITATION (documented, not fixed in this phase): ChromaVectorStore's local
# PersistentClient does not survive horizontal scaling. Each ingestion
# instance gets an independent, incomplete corpus copy — dedup correctness
# requires ingestion to run as a SINGLE instance until Chroma is externalized
# to a shared server (chromadb.HttpClient against a real Chroma deployment).
# Matches the current Dockerfile (single uvicorn worker, no shared volume).
```

- [ ] **Step 4: Tests**

```python
# ingestion/tests/test_dedup_endpoints.py
# Mock OrchestratorEmbedClient.embed (transport injection, same pattern as
# Task 1) and use a real temporary-directory ChromaVectorStore (fast, local,
# no need to mock Chroma itself — matches ingestion/tests/test_vector_store.py's
# existing convention of using a real tmp_path-backed store).
#
# Tests:
# - POST /dedup/check against an empty store returns is_duplicate=False.
# - POST /dedup/upsert then POST /dedup/check with the same text returns
#   is_duplicate=True with a similarity very close to 1.0.
# - Two different area_paths: upsert into one, check against the other,
#   confirm no match (proves area-path scoping holds through the HTTP layer,
#   not just at the ChromaVectorStore unit level which already tests this).
```

- [ ] **Step 5: Run to verify**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_dedup_endpoints.py -v` — expect all pass.

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/main.py ingestion/tests/test_dedup_endpoints.py
git commit -m "feat(ingestion): add POST /dedup/check and POST /dedup/upsert, wiring the previously-unconstructed ChromaVectorStore/OrchestratorEmbedClient into the running service"
```

---

### Task 7: Wire dedup CHECK into the dry-run diff

**Files:**
- Modify: `orchestrator/src/modules/pipeline/ingestion-http.client.ts`
- Modify: `orchestrator/src/modules/writeback/dry-run.service.ts`
- Modify: `orchestrator/src/modules/pipeline/pipeline.worker.ts`
- Test: `orchestrator/test/dry-run.service.spec.ts`, `orchestrator/test/pipeline.worker.spec.ts` (append)

**Interfaces:** `DryRunDiffEntry.action` gains a third value: `'create' | 'reuse' | 'dedup_skip'`. `dedup_skip` carries `existingAdoId` (the matched item's real ADO id, parsed from the dedup check's `matched_item_id`) and a new `similarity: number` field — deliberately distinct from `reuse`'s certain exact-hash match, per this plan's Global Constraints.

**Boundary:** Only touch the three files listed + their tests. Do not change `reuse`'s existing meaning or any BASELINE-only code path — dedup checking only runs for nodes that are NOT already an exact-hash `reuse` (no point checking semantic similarity against a corpus when an exact match already resolved the node).

- [ ] **Step 1: Add an `IngestionHttpClient.checkDuplicate` method**

```typescript
// orchestrator/src/modules/pipeline/ingestion-http.client.ts
  async checkDuplicate(text: string, areaPath: string): Promise<{ isDuplicate: boolean; matchedItemId: string | null; similarity: number | null }> {
    const response = await fetch(`${this.baseUrl}/dedup/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, area_path: areaPath }),
    });
    if (!response.ok) {
      throw new Error(`Ingestion /dedup/check request failed: ${response.status}`);
    }
    const body = (await response.json()) as { is_duplicate: boolean; matched_item_id: string | null; similarity: number | null };
    return { isDuplicate: body.is_duplicate, matchedItemId: body.matched_item_id, similarity: body.similarity };
  }
```

- [ ] **Step 2: Extend `DryRunDiffEntry`, thread dedup checking into `diff()`**

```typescript
// orchestrator/src/modules/writeback/dry-run.service.ts
export interface DryRunDiffEntry {
  localId: string;
  parentLocalId: string | null;
  type: string;
  title: string;
  description: string;
  action: 'create' | 'reuse' | 'dedup_skip';
  existingAdoId: number | null;
  similarity: number | null;
  sourceHash: string;
  customerId: string | null;
}

@Injectable()
export class DryRunService {
  async diff(
    nodes: DryRunTreeNode[],
    idempotencyService: IdempotencyService,
    dedupCheck?: (text: string, areaPath: string) => Promise<{ isDuplicate: boolean; matchedItemId: string | null; similarity: number | null }>,
  ): Promise<DryRunDiffEntry[]> {
    const results: DryRunDiffEntry[] = [];
    for (const node of nodes) {
      const existingAdoId = await idempotencyService.lookup(node.sourceHash, node.customerId, node.areaPath);
      if (existingAdoId !== null) {
        results.push({
          localId: node.localId, parentLocalId: node.parentLocalId, type: node.type,
          title: node.title, description: node.description, action: 'reuse',
          existingAdoId, similarity: null, sourceHash: node.sourceHash, customerId: node.customerId,
        });
        continue;
      }
      if (dedupCheck) {
        // Fail OPEN, never closed: an embedding-service outage must not fail
        // BASELINE jobs, which had zero LLM/embed dependency before this
        // phase — that would be a straight regression introduced by an
        // unrelated feature. On any dedup-check error, log it and fall
        // through to the same 'create' path as if dedup were never enabled;
        // creating a possible duplicate is always safer than blocking every
        // submission on a dedup-service hiccup.
        try {
          const dedupResult = await dedupCheck(node.description, node.areaPath);
          if (dedupResult.isDuplicate && dedupResult.matchedItemId !== null) {
            results.push({
              localId: node.localId, parentLocalId: node.parentLocalId, type: node.type,
              title: node.title, description: node.description, action: 'dedup_skip',
              existingAdoId: Number(dedupResult.matchedItemId), similarity: dedupResult.similarity,
              sourceHash: node.sourceHash, customerId: node.customerId,
            });
            continue;
          }
        } catch (error) {
          // eslint-disable-next-line no-console -- operational visibility for a fail-open path, not app logging
          console.error(`Dedup check failed for node ${node.localId}, falling through to 'create':`, error);
        }
      }
      results.push({
        localId: node.localId, parentLocalId: node.parentLocalId, type: node.type,
        title: node.title, description: node.description, action: 'create',
        existingAdoId: null, similarity: null, sourceHash: node.sourceHash, customerId: node.customerId,
      });
    }
    return results;
  }
}
```

`dedupCheck` is an OPTIONAL callback (not a hard dependency on `IngestionHttpClient` inside `DryRunService`, which today has zero external dependencies by design per its own doc comment — "no MCP tool call... no ADO write" — keeping that property means it also shouldn't gain a network dependency on ingestion directly; the caller in `pipeline.worker.ts` supplies the callback instead).

- [ ] **Step 3: Wire it from `pipeline.worker.ts`**

```typescript
// orchestrator/src/modules/pipeline/pipeline.worker.ts — inside runPipelineJob, replace:
    const diff = await deps.dryRunService.diff(diffInputs, deps.idempotencyService);
// with:
    const diff = await deps.dryRunService.diff(
      diffInputs,
      deps.idempotencyService,
      (text, areaPath) => deps.ingestionClient.checkDuplicate(text, areaPath),
    );
```

- [ ] **Step 4: Tests**

```typescript
// dry-run.service.spec.ts — append tests:
// - a node with no exact-hash match AND dedupCheck returning isDuplicate:true
//   produces action='dedup_skip' with existingAdoId set from matchedItemId
//   and similarity populated.
// - a node with no exact-hash match AND dedupCheck returning isDuplicate:false
//   produces the existing action='create' behavior, unchanged.
// - a node WITH an exact-hash match never calls dedupCheck at all (assert
//   the mock dedupCheck function was NOT called for that node) — proves the
//   short-circuit ordering (exact match wins, no semantic check needed).
// - diff() called with NO dedupCheck argument at all behaves byte-identically
//   to before this task (regression guard for BASELINE-only callers, if any
//   remain, and for the golden E2E's existing assertions).
// - a dedupCheck callback that REJECTS (simulating an embedding-service
//   outage) does NOT propagate the error out of diff() — the node still
//   gets action='create', and diff() resolves normally for every other
//   node in the same call. This is the fail-open regression test: without
//   it, an embedding outage would silently start failing BASELINE jobs
//   that never had an LLM/embed dependency before this phase.

// pipeline.worker.spec.ts — append a test asserting deps.ingestionClient.checkDuplicate
// is called with the correct (description, areaPath) args for a create-candidate node.
```

- [ ] **Step 5: Run to verify**

Run: `cd orchestrator && npx jest` — expect zero regressions plus new passing tests.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/modules/pipeline/ingestion-http.client.ts orchestrator/src/modules/writeback/dry-run.service.ts orchestrator/src/modules/pipeline/pipeline.worker.ts orchestrator/test/dry-run.service.spec.ts orchestrator/test/pipeline.worker.spec.ts
git commit -m "feat(orchestrator): wire embedding-based dedup check into the dry-run diff, distinct from exact-hash reuse"
```

---

### Task 8: Upsert into the vector store after a real create

**Files:**
- Modify: `orchestrator/src/modules/pipeline/jobs.service.ts`
- Modify: `orchestrator/src/modules/pipeline/jobs.module.ts`
- Test: `orchestrator/test/jobs.service.spec.ts` (append)

**Interfaces:** `JobsService`'s constructor gains an `IngestionHttpClient` dependency (not previously injected into this class). `confirm()`'s create branch calls `ingestionClient.upsertDedupEntry(...)` after every successful real create — matching `check_for_duplicates()`'s own documented boundary that upserting is a separate, caller-driven step.

**Boundary:** Only touch the two files + test. `confirm()`'s existing create/link two-pass structure (Phase 9) is unchanged — this adds one more call inside the existing create branch, nothing else moves.

- [ ] **Step 1: Add `upsertDedupEntry` to `IngestionHttpClient`**

```typescript
// orchestrator/src/modules/pipeline/ingestion-http.client.ts
  async upsertDedupEntry(itemId: string, text: string, areaPath: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/dedup/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: itemId, text, area_path: areaPath }),
    });
    if (!response.ok) {
      throw new Error(`Ingestion /dedup/upsert request failed: ${response.status}`);
    }
  }
```

- [ ] **Step 2: Inject `IngestionHttpClient` into `JobsService`, call the upsert after each create**

```typescript
// orchestrator/src/modules/pipeline/jobs.service.ts
import type { IngestionHttpClient } from './ingestion-http.client';

@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly mcpClient: McpClient,
    private readonly idempotencyService: IdempotencyService,
    private readonly ingestionClient: IngestionHttpClient,
    redisUrl: string,
  ) {
    this.queue = new Queue('req2ado-pipeline', { connection: { url: redisUrl } as any });
  }

  // ... inside confirm()'s create loop, after idempotencyService.record(...):
      const created = await this.mcpClient.createWorkItem(entry.type, fields, credential);
      adoIdByLocalId.set(entry.localId, created.id);
      await this.idempotencyService.record(entry.sourceHash, entry.customerId, job.areaPath, created.id);
      await this.ingestionClient.upsertDedupEntry(String(created.id), entry.description, job.areaPath);
      createdCount += 1;
```

Note the constructor parameter ORDER change — check `jobs.module.ts`'s existing factory provider for `JobsService` (grep first) and update its `inject: [...]` array to match the new parameter position, or the DI wiring will silently pass the wrong value to the wrong parameter. This is a real, easy-to-miss mistake — verify by actually running the app/tests, not just reading the diff.

- [ ] **Step 3: Update `jobs.module.ts`'s factory provider**

Match whatever exact pattern this module already uses (grep for the existing `JobsService` provider before writing this) — add `IngestionHttpClient` to the `inject` array in the same position as the constructor parameter.

- [ ] **Step 4: Tests**

```typescript
// jobs.service.spec.ts — append:
// - a 'create' entry results in ingestionClient.upsertDedupEntry being
//   called with (String(created.id), entry.description, job.areaPath).
// - a 'reuse' entry (existingAdoId already set) does NOT call upsertDedupEntry
//   — only genuinely new creates get upserted, matching check_for_duplicates()'s
//   own "caller decides separately" boundary.
// - a 'dedup_skip' entry also does NOT call createWorkItem OR upsertDedupEntry
//   — confirm() must extend its existing "skip entries that aren't real creates"
//   branch (currently `if (entry.action === 'reuse' && ...)`) to also skip
//   'dedup_skip' entries, seeding adoIdByLocalId from THEIR existingAdoId too
//   so their children can still be linked correctly in pass 2.
```

**Important, easy to miss (pass 1):** `confirm()`'s existing pass-1 condition is `if (entry.action === 'reuse' && entry.existingAdoId !== null) { adoIdByLocalId.set(...); continue; }` — this task MUST broaden that condition to also handle `'dedup_skip'` the same way (seed the map, skip creation), or every dedup-skipped node will incorrectly fall through to the `createWorkItem` branch and get written anyway, silently defeating the entire point of Task 7. Write this as `if (entry.action !== 'create' && entry.existingAdoId !== null)` rather than enumerating both non-create values, so a future third non-create action doesn't require remembering to update this line again.

**Important, a second and separate change (pass 2) — the design review's dedup_skip re-parenting finding:** pass 2's existing loop calls `linkParentChild` for every entry with a non-null `parentLocalId`, using `adoIdByLocalId.get(entry.localId)` as the CHILD id. If `entry.action === 'dedup_skip'`, that child id is an EXISTING ADO item (matched only by a ≥0.90 similarity guess, not a certainty) — calling `linkParentChild` on it would silently RE-PARENT that pre-existing item under a newly-created parent from the CURRENT document. This must not happen. Update pass 2 to skip the link when the entry itself is `dedup_skip` (its existing parent, whatever it is, is left untouched), while still allowing OTHER nodes to link UP to a `dedup_skip` entry's matched id as their own parent (that direction is safe — a new child correctly pointing at an existing parent is exactly what linking is for):

```typescript
// orchestrator/src/modules/pipeline/jobs.service.ts — confirm()'s pass 2, exact change:
    for (const entry of diff) {
      if (entry.parentLocalId === null) continue;
      if (entry.action === 'dedup_skip') continue; // never re-parent an existing item matched only by similarity
      const childAdoId = adoIdByLocalId.get(entry.localId);
      const parentAdoId = adoIdByLocalId.get(entry.parentLocalId);
      if (childAdoId === undefined || parentAdoId === undefined) continue;
      await this.mcpClient.linkParentChild(childAdoId, parentAdoId, credential);
    }
```

Add a test proving this specifically: a `dedup_skip` entry with a non-null `parentLocalId` must NOT trigger a `linkParentChild` call for itself, while a separate `create` entry whose `parentLocalId` points at that same `dedup_skip` entry's `localId` MUST still link correctly (child → dedup_skip's `existingAdoId`).

- [ ] **Step 5: Run to verify**

Run: `cd orchestrator && npx jest` — expect zero regressions plus new passing tests. Pay specific attention to any test that constructs `JobsService` directly with positional constructor args (this project's existing test pattern, per `jobs.service.spec.ts`'s current tests) — every one needs updating for the new parameter.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/modules/pipeline/ingestion-http.client.ts orchestrator/src/modules/pipeline/jobs.service.ts orchestrator/src/modules/pipeline/jobs.module.ts orchestrator/test/jobs.service.spec.ts
git commit -m "feat(orchestrator): upsert into the dedup vector store after every real create; correctly skip dedup_skip entries in confirm()'s create loop"
```

---

### Task 9: Golden test for dedup

**Files:**
- Modify: `scripts/run-golden-e2e.sh`

**Interfaces:** None new.

**Boundary:** Only touch the script. Reuses the existing BASELINE fixture — no new fixture file needed, since the point is proving a SECOND, DIFFERENT document with near-identical (not identical) content gets skipped.

- [ ] **Step 1: Add a near-duplicate scenario**

```bash
# Append to scripts/run-golden-e2e.sh, after job #2's idempotency assertion:

log "Testing embedding dedup: near-duplicate text, different file, same area path"
NEARDUP_FILE="$(mktemp /tmp/req2ado-neardup.XXXXXX.txt)"
echo "1 Perimeter Intrusion Detection

The system shall detect any unauthorized perimeter intrusion within roughly 2 seconds and shall alert the operator, identifying which zone was affected." > "$NEARDUP_FILE"

JOB4_RESPONSE=$(curl -sf -X POST "http://localhost:${ORCH_PORT}/jobs" \
  -F "file=@${NEARDUP_FILE}" \
  -F "areaPath=${AREA_PATH}")
JOB4_ID="$(echo "$JOB4_RESPONSE" | jq -r '.jobId')"
JOB4_BODY="$(poll_job_status "$JOB4_ID")"
JOB4_ACTIONS="$(echo "$JOB4_BODY" | jq -r '.dryRunDiff[].action')"
log "Job #4 (near-duplicate) diff actions: $(echo "$JOB4_ACTIONS" | tr '\n' ' ')"
if ! echo "$JOB4_ACTIONS" | grep -q "dedup_skip"; then
  log "ASSERTION FAILED: expected the near-duplicate fixture to produce at least one dedup_skip action"
  rm -f "$NEARDUP_FILE"
  exit 1
fi
rm -f "$NEARDUP_FILE"
```

This depends on job #1 having already been confirmed (its embedding upserted) earlier in the same script run — confirm the script's existing ordering already guarantees this (job #1 confirm happens before this new block per the existing script structure) before assuming it.

- [ ] **Step 2: Run and verify**

Run: `bash scripts/run-golden-e2e.sh` — expect the new dedup assertion to pass alongside every existing assertion in the same run.

- [ ] **Step 3: Commit**

```bash
git add scripts/run-golden-e2e.sh
git commit -m "test: add a near-duplicate dedup scenario to the golden E2E script"
```

---

### Task 10: Frontend rendering for `dedup_skip`

**Files:**
- Modify: `frontend/src/pages/JobStatus.tsx`
- Test: `frontend/src/pages/JobStatus.test.tsx` (append)

**Interfaces:** `JobStatus.tsx`'s local `DryRunDiffEntry` type and `DiffMarker` component both gain a third state — this was not in the original draft; added per the design review's finding that nothing in the plan touched the diff-review UI despite adding a new action value it would otherwise render incorrectly (or crash on, if `DiffMarker`'s prop type is a narrow union).

**Boundary:** Only touch the one file + its test. Do not touch `Upload.tsx` here — Task 4 already handles that file.

- [ ] **Step 1: Confirm the exact current `DiffMarker`/`DryRunDiffEntry` shape**

Run: `grep -n "DiffMarker\|interface DryRunDiffEntry" frontend/src/pages/JobStatus.tsx` — confirm `DiffMarker`'s prop type is `{ action: 'create' | 'reuse' }` and the local `DryRunDiffEntry` interface has `localId`, `action`, `existingAdoId` (matching what Step 2 below extends).

- [ ] **Step 2: Extend the type and marker component**

```tsx
// frontend/src/pages/JobStatus.tsx
interface DryRunDiffEntry {
  localId: string;
  action: 'create' | 'reuse' | 'dedup_skip';
  existingAdoId: number | null;
  similarity: number | null;
}

function DiffMarker({ action }: { action: 'create' | 'reuse' | 'dedup_skip' }): JSX.Element {
  if (action === 'dedup_skip') {
    // Distinct from both create (solid green) and reuse (hollow, textSecondary
    // border) — amber/warning color signals "probabilistic match, reviewed
    // and skipped" rather than "certain" (reuse) or "new" (create). Never
    // reuse reuse's own color: a reviewer must be able to tell a CERTAIN
    // exact-hash match from a PROBABLE embedding match at a glance.
    return (
      <Box
        aria-hidden="true"
        sx={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          flexShrink: 0,
          bgcolor: 'transparent',
          border: '2px solid',
          borderColor: 'warning.main',
        }}
      />
    );
  }
  const isCreate = action === 'create';
  return (
    <Box
      aria-hidden="true"
      sx={{
        width: 10,
        height: 10,
        borderRadius: '50%',
        flexShrink: 0,
        bgcolor: isCreate ? 'success.main' : 'transparent',
        border: isCreate ? 'none' : `2px solid ${themeTokens.color.textSecondary}`,
      }}
    />
  );
}
```

- [ ] **Step 3: Show the similarity score for `dedup_skip` rows**

```tsx
// frontend/src/pages/JobStatus.tsx — inside the diff row's existing existingAdoId display:
                {entry.existingAdoId !== null && (
                  <Typography sx={{ fontFamily: themeTokens.font.mono, fontSize: '0.85rem', color: 'text.secondary' }}>
                    → ADO #{entry.existingAdoId}
                    {entry.action === 'dedup_skip' && entry.similarity !== null && (
                      <> ({Math.round(entry.similarity * 100)}% match)</>
                    )}
                  </Typography>
                )}
```

- [ ] **Step 4: Tests**

```tsx
// Append to frontend/src/pages/JobStatus.test.tsx
it('renders a dedup_skip entry distinctly from create and reuse, with its similarity score', async () => {
  // mock GET /jobs/:id returning a dryRunDiff entry with action='dedup_skip',
  // existingAdoId=99, similarity=0.93; assert the rendered row shows
  // "ADO #99" and "93% match", and that it's visually distinguishable
  // (e.g. assert the warning-colored marker renders, not the create/reuse
  // marker — check via a test id or the border color if the existing
  // tests already have a pattern for asserting on DiffMarker's rendered
  // style; otherwise assert on the similarity text as the primary proof).
});
```

- [ ] **Step 5: Run to verify**

Run: `cd frontend && npx vitest run` — expect zero regressions plus the new passing test.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/JobStatus.tsx frontend/src/pages/JobStatus.test.tsx
git commit -m "feat(req2ado-frontend): render dedup_skip distinctly from create/reuse in the dry-run diff, show similarity score"
```

---

## Self-Review Notes

- **Every design decision traces to a direct code read done before writing this plan, not an assumption:** `check_for_duplicates()`'s "never upserts" boundary is quoted from its own docstring; `OrchestratorLlmClient`'s existing shape and the fact that one class can satisfy multiple Protocols was confirmed by reading `llm_leveling.py`/`survey_title.py`/`requirement_client.py`'s actual Protocol definitions; `ingestion/app/main.py`'s exact current route list (three routes, no dedup, no mode param) was read directly, not inferred from prior phase summaries alone.
- **An independent adversarial design review (Plan-agent pass) was run against the FIRST draft of this plan before any implementation started, and its findings are folded into the plan itself, not left as open risks:** the ~101-calls-per-document LLM cost problem, the event-loop-blocking problem, the Chroma horizontal-scaling gap, the dedup_skip re-parenting hazard, the fail-open requirement, the JSON-fence fragility, and the missing frontend rendering were all found this way. Each became either a Global Constraint, an explicit plan step with real code, or a documented, locked-in limitation (Chroma) — none were silently dropped or left for an implementer to rediscover independently.
- **`dedup_skip` is deliberately never conflated with `reuse`:** an exact-hash match is a certain fact; a cosine-similarity match above threshold is a probabilistic judgment. Task 7's Global-Constraints-driven decision to give it a separate `action` value (carrying its own `similarity` score) means a human reviewing the dry-run diff can always tell which kind of match they're looking at — this matters more here than in most systems, since a wrongly-skipped genuinely-new requirement is a real traceability gap for a compliance-sensitive customer.
- **Two sharp edges flagged explicitly, not buried, both in Task 8:** (1) `confirm()`'s pass-1 create-loop skip condition must broaden to cover `dedup_skip` the same way it already covers `reuse`, or dedup-skipped nodes get written anyway, silently defeating Task 7 entirely; (2) pass-2's parent-linking loop must NOT re-link a `dedup_skip` entry itself (that would re-parent a pre-existing ADO item under a new parent based on a similarity guess), while still allowing OTHER nodes to link UP to it as their parent. Both are exactly the kind of interaction bug this project's own final-whole-branch-reviews have caught before; naming them explicitly means the implementer doesn't have to independently rediscover either.
- **SURVEY's LLM cost was cut from ~101 calls/document to ~2, and the blocking-event-loop problem was fixed, before a single line of implementation code was written** — not discovered during a later performance-review pass. Dropping the per-node title-distillation LLM call (Task 2) and batching requirement generation into one whole-document call (Task 1) are both zero-quality-cost changes, not a scope cut.
- **fidelity_hash for SURVEY nodes reuses the existing field/type, not a new one, but its weaker guarantee versus BASELINE is documented in the code and this plan, not silently equated:** keeps every TS type (`DryRunTreeNode.sourceHash`, `DryRunDiffEntry.sourceHash`, `IdempotencyMapping.sourceHash`) completely untouched — SURVEY mode's idempotency and dedup interplay work for free, without a parallel code path — while the docstring in `build_survey_tree` is explicit that `temperature=0` is not a perfect determinism guarantee the way a verbatim source-span hash is.
- **The Chroma horizontal-scaling gap is a genuine, locked-in scope decision (the user's own call, not an assumption):** dedup ships as single-instance-only for this phase, matching the current Dockerfile as-is; externalizing to a shared Chroma server is real, separate infra work, explicitly deferred rather than silently designed around.
- **No scope creep:** neither the ADO write-back path (`mcp-ado-server`, `RealAdoBackend`) nor anything about the per-request credential flow (Phase 9) is touched anywhere in this plan — this phase is entirely about correctly building the tree/diff that eventually reaches that unchanged write path.
- **Honest about what can't be verified in a sandboxed environment:** Task 5's SURVEY golden scenario and Task 9's dedup golden scenario both require a real (or realistically local) LLM/embedding backend — if genuinely unavailable when these tasks run, the plan instructs reporting `DONE_WITH_CONCERNS` rather than faking a pass, matching this project's established convention from every prior phase.
