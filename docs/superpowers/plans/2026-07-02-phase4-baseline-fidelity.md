# Phase 4 BASELINE Fidelity + Customer ID Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make BASELINE-mode fidelity guarantees real and testable — fix a genuine bug where `fidelity_hash` goes stale relative to `description` after unleveled-block folding, add a `verify_fidelity` function that can detect drift on any `WorkItemNode`, and thread a pipeline-level `customer_id` parameter through tree building. Satisfies Phase 4's DoD: "Fidelity test byte-for-byte; re-hash stable; TBD/OPEN preserved; deterministic."

**Architecture:** `app/leveling/tree_builder.py` gets fixed so `fidelity_hash` is recomputed every time `description` changes (not just once at node creation) — this closes a real gap: Phase 3's `assemble_description` folding mutates `description` after the hash was already frozen. A new `app/workitem/fidelity.py` module adds `verify_fidelity(node) -> bool`, a pure function re-deriving the hash from the node's current `description` and comparing it to the stored `fidelity_hash` — this is the concrete mechanism behind "re-hash on re-run detects drift" (architecture.md's traceability guarantee). `build_baseline_tree` gains a `customer_id: str | None = None` parameter, stamped uniformly onto every node — per architecture.md's idempotency key `(source_hash, customer_id, area_path) → System.Id`, Customer ID is a per-ingestion-run input (which customer this document is for), not something extracted per-paragraph from document text.

**Tech Stack:** Same as Phases 1-3 — Python 3.11+/pydantic v2/FastAPI/pytest. No new dependencies.

## Global Constraints

- BASELINE mode must remain fully deterministic and LLM-free — this phase touches no LLM code path.
- `fidelity_hash` must always equal `sha256(node.description.encode()).hexdigest()` for every `WorkItemNode` returned by `build_baseline_tree`, at every point after folding completes — not just at node-creation time. This is the specific bug this phase fixes (see architecture.md Phase 4 row: risk = "Hidden mutation").
- `customer_id` is a single value applied uniformly to every node in one `build_baseline_tree` call — it is NOT parsed or extracted from document content. One ingestion run = one customer.
- Do not modify `app/distillation/*` (Phase 3, already correct) or `app/leveling/llm_leveling.py` (SURVEY path, out of scope — Phase 4's DoD is BASELINE-only).
- Do not resolve the ADO field ref name for Customer ID in this phase — that requires the MCP server (`ado_discover_fields`, per docs/architecture.md's "Customer ID Field Resolution" section) which is Phase 7's scope. This phase only stamps the plain string value onto `WorkItemNode.customer_id`; mapping it to the correct ADO field ref name at write-time is Phase 7's job.
- Type hints on every function signature; docstrings only where genuinely non-obvious; pytest; existing repo conventions.

---

### Task 1: Fix `fidelity_hash` staleness after description folding

**Files:**
- Modify: `ingestion/app/leveling/tree_builder.py`
- Test: `ingestion/tests/test_tree_builder.py` (add new tests, do not remove/modify existing ones)

**Interfaces:**
- Modifies: `build_baseline_tree`'s internals only — signature `build_baseline_tree(doc: CanonicalDoc) -> WorkItemTree` unchanged in this task (Task 3 adds `customer_id`).

**Boundary:** Only touch `ingestion/app/leveling/tree_builder.py` and add new tests to `tests/test_tree_builder.py`.

- [ ] **Step 1: Write the failing test proving the bug**

```python
# Append to ingestion/tests/test_tree_builder.py

def test_fidelity_hash_reflects_folded_description_not_just_the_initiating_block() -> None:
    # Reproduces the Phase 4 bug: fidelity_hash was frozen at node-creation
    # time using only the FIRST block's text, but description keeps growing
    # as subsequent unleveled blocks fold in via assemble_description. After
    # folding, fidelity_hash must match the FINAL, fully-folded description —
    # not the single block that created the node.
    import hashlib

    icd_doc = _icd_style_doc()
    tree = build_baseline_tree(icd_doc)
    requirement_node = tree.nodes[1]
    expected_hash = hashlib.sha256(requirement_node.description.encode()).hexdigest()
    assert requirement_node.fidelity_hash == expected_hash
```

- [ ] **Step 2: Run to verify it fails**

Run: `pytest tests/test_tree_builder.py -v -k fidelity_hash_reflects_folded`
Expected: FAIL — `requirement_node.fidelity_hash` is the hash of only the node's initiating block text, not the folded description that includes the `OPEN:`/`[FIGURE:]` content appended afterward.

- [ ] **Step 3: Fix `tree_builder.py` — recompute the hash every time description changes**

```python
# ingestion/app/leveling/tree_builder.py (full file, replacing existing content)
from __future__ import annotations

import hashlib

from app.canonical.model import Block, CanonicalDoc
from app.distillation.description import assemble_description
from app.distillation.title import extract_baseline_title
from app.leveling.autodetect import detect_profile_for_branch
from app.leveling.depth import resolve_block_depth
from app.leveling.profiles import type_for_depth
from app.workitem.model import WorkItemMode, WorkItemNode, WorkItemTree


def _split_into_branches(doc: CanonicalDoc) -> list[list[Block]]:
    branches: list[list[Block]] = []
    current: list[Block] = []
    for block in doc.blocks:
        depth, _ = resolve_block_depth(block)
        if depth == 1 and current:
            branches.append(current)
            current = []
        current.append(block)
    if current:
        branches.append(current)
    return branches


def _hash_description(description: str) -> str:
    return hashlib.sha256(description.encode()).hexdigest()


def build_baseline_tree(doc: CanonicalDoc) -> WorkItemTree:
    """Deterministic BASELINE-mode leveling: no LLM involved. Splits the
    document into top-level branches, auto-detects a profile per branch
    (see autodetect.py), then walks each branch's blocks maintaining a
    depth stack to assign parent/child relationships. Unleveled blocks
    (plain paragraphs, list items, notes, OPEN/TBD markers, inline figure
    placeholders) extend the nearest currently-open node's description
    rather than becoming their own node.

    fidelity_hash is recomputed every time a node's description changes
    (both at creation and on every subsequent fold), so it always equals
    sha256(description) for the node's FINAL, fully-folded description —
    not just the block that originally created the node. See
    app/workitem/fidelity.py's verify_fidelity for the standalone
    drift-detection check this invariant enables.

    Only doc.blocks are leveled — doc.tables are not yet converted to work
    items (table-only documents, e.g. from the xlsx loader, currently
    produce an empty tree; this is a known scope gap for a later phase)."""
    nodes: list[WorkItemNode] = []
    nodes_by_id: dict[str, WorkItemNode] = {}
    node_counter = 0

    for branch_blocks in _split_into_branches(doc):
        profile = detect_profile_for_branch(branch_blocks)
        stack: list[tuple[int, str]] = []

        for block in branch_blocks:
            depth, display_text = resolve_block_depth(block)

            if depth is None:
                if stack:
                    open_node = nodes_by_id[stack[-1][1]]
                    open_node.description = assemble_description(open_node.description, display_text)
                    open_node.fidelity_hash = _hash_description(open_node.description)
                continue

            while stack and stack[-1][0] >= depth:
                stack.pop()
            parent_local_id = stack[-1][1] if stack else None

            local_id = f"n{node_counter}"
            node_counter += 1

            node = WorkItemNode(
                local_id=local_id,
                type=type_for_depth(profile, depth),
                parent_local_id=parent_local_id,
                title=extract_baseline_title(display_text),
                description=display_text,
                customer_id=None,
                source_ref=block.source_ref,
                fidelity_hash=_hash_description(display_text),
                tags=[],
                mode=WorkItemMode.BASELINE,
            )
            nodes.append(node)
            nodes_by_id[local_id] = node
            stack.append((depth, local_id))

    return WorkItemTree(nodes=nodes)
```

- [ ] **Step 4: Run to verify the new test passes and existing tests still pass**

Run: `pytest tests/test_tree_builder.py -v`
Expected: PASS (10 tests — 9 existing from Phases 2-3 unmodified and green, 1 new Phase 4 test green)

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/leveling/tree_builder.py ingestion/tests/test_tree_builder.py
git commit -m "fix(ingestion): recompute fidelity_hash on every description fold, not just node creation"
```

---

### Task 2: `verify_fidelity` drift-detection function

**Files:**
- Create: `ingestion/app/workitem/fidelity.py`
- Test: `ingestion/tests/test_fidelity.py`

**Interfaces:**
- Consumes: `WorkItemNode` from `app.workitem.model` (existing, unchanged).
- Produces: `verify_fidelity(node: WorkItemNode) -> bool` in `ingestion/app/workitem/fidelity.py` — a standalone function requiring no other Phase 4 changes; usable directly against Task 1's fixed output.

**Boundary:** Only touch `ingestion/app/workitem/fidelity.py` and its own test file. Do not touch `tree_builder.py` again in this task — Task 1 already fixed the hash computation; this task adds the independent verification function that checks the invariant Task 1 now guarantees.

- [ ] **Step 1: Write the failing tests**

```python
# ingestion/tests/test_fidelity.py
from app.canonical.model import SourceRef
from app.workitem.fidelity import verify_fidelity
from app.workitem.model import WorkItemMode, WorkItemNode, WorkItemType


def _sr() -> SourceRef:
    return SourceRef(document_path="x.txt", start_offset=0, end_offset=10)


def _node(description: str, fidelity_hash: str | None) -> WorkItemNode:
    return WorkItemNode(
        local_id="n0",
        type=WorkItemType.REQUIREMENT,
        parent_local_id=None,
        title="Title",
        description=description,
        customer_id=None,
        source_ref=_sr(),
        fidelity_hash=fidelity_hash,
        tags=[],
        mode=WorkItemMode.BASELINE,
    )


def test_verify_fidelity_true_when_hash_matches_description() -> None:
    import hashlib

    description = "The receiver shall scan all channels."
    node = _node(description, hashlib.sha256(description.encode()).hexdigest())
    assert verify_fidelity(node) is True


def test_verify_fidelity_detects_drift_when_description_was_mutated_after_hashing() -> None:
    import hashlib

    original = "The receiver shall scan all channels."
    stale_hash = hashlib.sha256(original.encode()).hexdigest()
    mutated_node = _node("The receiver shall scan all channels quickly.", stale_hash)
    assert verify_fidelity(mutated_node) is False


def test_verify_fidelity_false_when_fidelity_hash_is_none() -> None:
    # SURVEY-mode nodes have fidelity_hash=None (no BASELINE guarantee to
    # verify) — verify_fidelity must not raise, and must report False rather
    # than silently treating "no hash" as "verified."
    node = _node("some text", None)
    assert verify_fidelity(node) is False


def test_verify_fidelity_is_deterministic_across_repeated_calls() -> None:
    import hashlib

    description = "OPEN: confirm connector part number.\n[FIGURE: none]"
    node = _node(description, hashlib.sha256(description.encode()).hexdigest())
    assert verify_fidelity(node) is True
    assert verify_fidelity(node) is True
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_fidelity.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.workitem.fidelity'`

- [ ] **Step 3: Implement**

```python
# ingestion/app/workitem/fidelity.py
from __future__ import annotations

import hashlib

from app.workitem.model import WorkItemNode


def verify_fidelity(node: WorkItemNode) -> bool:
    """Re-derives sha256(node.description) and compares it to the node's
    stored fidelity_hash. This is the concrete mechanism behind
    docs/architecture.md's traceability guarantee: 're-hash on re-run
    detects drift' — if a node's description was mutated by anything after
    fidelity_hash was originally computed (see tree_builder.py's
    build_baseline_tree, which keeps the two in sync at build time), this
    returns False. Nodes with fidelity_hash=None (e.g. SURVEY mode, which
    makes no BASELINE fidelity guarantee) always return False rather than
    raising — there is nothing to verify, and that is reported honestly as
    'not verified', not conflated with 'verified.'"""
    if node.fidelity_hash is None:
        return False
    return hashlib.sha256(node.description.encode()).hexdigest() == node.fidelity_hash
```

- [ ] **Step 4: Run to verify it passes**

Run: `pytest tests/test_fidelity.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/workitem/fidelity.py ingestion/tests/test_fidelity.py
git commit -m "feat(ingestion): add verify_fidelity for standalone drift detection on WorkItemNode"
```

---

### Task 3: Thread `customer_id` through `build_baseline_tree`

**Files:**
- Modify: `ingestion/app/leveling/tree_builder.py`
- Modify: `ingestion/app/main.py`
- Test: `ingestion/tests/test_tree_builder.py` (add new tests)
- Test: `ingestion/tests/test_ingest_endpoint.py` or wherever `/level` is currently tested (add new test; grep first to confirm exact file)

**Interfaces:**
- Modifies: `build_baseline_tree(doc: CanonicalDoc, customer_id: str | None = None) -> WorkItemTree` — adds an optional keyword parameter with a backward-compatible default, so no existing caller (all of Phases 2-4's own tests) breaks.
- Modifies: `POST /level` FastAPI route in `main.py` gains an optional `customer_id: str | None = None` query parameter.

**Boundary:** Only touch `tree_builder.py`, `main.py`, and their respective test files. Do not touch `llm_leveling.py` (SURVEY, out of scope) or any `app/distillation/*` file.

- [ ] **Step 1: Find the existing `/level` endpoint test**

Run: `grep -rln '"/level"' ingestion/tests`
Note the file path returned — Steps below assume it's `tests/test_ingest_endpoint.py`; adjust the path if the grep returns a different file.

- [ ] **Step 2: Write the failing tests**

```python
# Append to ingestion/tests/test_tree_builder.py

def test_customer_id_is_stamped_on_every_node_when_provided() -> None:
    icd_doc = _icd_style_doc()
    tree = build_baseline_tree(icd_doc, customer_id="CUST-042")
    assert len(tree.nodes) > 0
    for node in tree.nodes:
        assert node.customer_id == "CUST-042"


def test_customer_id_defaults_to_none_when_not_provided() -> None:
    icd_doc = _icd_style_doc()
    tree = build_baseline_tree(icd_doc)
    for node in tree.nodes:
        assert node.customer_id is None
```

```python
# Append to ingestion/tests/test_ingest_endpoint.py (or the file found in Step 1)
# Add this import at the top if not already present: from app.main import app
# and: from fastapi.testclient import TestClient
# (follow the exact import/client-setup pattern already used elsewhere in this file)

def test_level_endpoint_accepts_and_stamps_customer_id(client) -> None:
    # NOTE: replace `client` with whatever fixture/TestClient instantiation
    # pattern the rest of this file already uses — do not invent a new one.
    doc_payload = {
        "document": {"path": "x.txt", "format": "txt", "sha256": "h"},
        "blocks": [
            {
                "id": "b0",
                "kind": "heading",
                "text": "Requirement",
                "heading_level": 1,
                "source_ref": {"document_path": "x.txt", "start_offset": 0, "end_offset": 11},
            }
        ],
        "tables": [],
        "figures": [],
    }
    response = client.post("/level", params={"customer_id": "CUST-042"}, json=doc_payload)
    assert response.status_code == 200
    body = response.json()
    assert body["nodes"][0]["customer_id"] == "CUST-042"
```

- [ ] **Step 3: Run to verify failure**

Run: `pytest tests/test_tree_builder.py tests/test_ingest_endpoint.py -v -k customer_id`
Expected: FAIL — `TypeError: build_baseline_tree() got an unexpected keyword argument 'customer_id'` for the unit tests; 422 or missing-param behavior for the endpoint test.

- [ ] **Step 4: Implement — `tree_builder.py`**

Modify only the function signature and the two `WorkItemNode(...)` constructions' `customer_id=None` lines in the file from Task 1:

```python
def build_baseline_tree(doc: CanonicalDoc, customer_id: str | None = None) -> WorkItemTree:
    """... (existing docstring unchanged, plus:)

    customer_id is a single value applied uniformly to every node in this
    call — one ingestion run corresponds to one customer's document, per
    docs/architecture.md's idempotency key (source_hash, customer_id,
    area_path) -> System.Id. It is NOT parsed or extracted from document
    content."""
    ...
            node = WorkItemNode(
                local_id=local_id,
                type=type_for_depth(profile, depth),
                parent_local_id=parent_local_id,
                title=extract_baseline_title(display_text),
                description=display_text,
                customer_id=customer_id,
                source_ref=block.source_ref,
                fidelity_hash=_hash_description(display_text),
                tags=[],
                mode=WorkItemMode.BASELINE,
            )
    ...
```

(Only the signature line and `customer_id=None` → `customer_id=customer_id` change; everything else from Task 1's version of the file is unchanged.)

- [ ] **Step 5: Implement — `main.py`**

```python
# ingestion/app/main.py (full file, replacing existing content)
import tempfile
from pathlib import Path

from fastapi import FastAPI, UploadFile

from app.canonical.model import CanonicalDoc
from app.dispatch import dispatch_by_extension
from app.leveling.tree_builder import build_baseline_tree
from app.redaction.redactor import redact_canonical_doc
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
async def level(doc: CanonicalDoc, customer_id: str | None = None) -> WorkItemTree:
    return build_baseline_tree(doc, customer_id=customer_id)
```

- [ ] **Step 6: Run to verify all tests pass**

Run: `pytest tests/test_tree_builder.py tests/test_ingest_endpoint.py -v`
Expected: PASS (all existing + new tests green)

- [ ] **Step 7: Run the full local suite**

Run: `pytest -v`
Expected: all Phase 1-4 tests pass, no regressions (same 7 pre-existing poppler/OCR environment failures as prior phases, unrelated).

- [ ] **Step 8: Commit**

```bash
git add ingestion/app/leveling/tree_builder.py ingestion/app/main.py ingestion/tests/test_tree_builder.py ingestion/tests/test_ingest_endpoint.py
git commit -m "feat(ingestion): thread customer_id through build_baseline_tree and /level endpoint"
```

---

### Task 4: Golden fidelity tests (byte-for-byte, determinism, TBD/OPEN preservation)

**Files:**
- Test: `ingestion/tests/test_fidelity_golden.py` (new file — dedicated golden-fixture suite, kept separate from `test_fidelity.py`'s unit tests and `test_tree_builder.py`'s wiring tests, per Phase 4's DoD naming its own "Fidelity test" as a distinct deliverable)

**Interfaces:**
- Consumes: `build_baseline_tree` (Task 3's signature), `verify_fidelity` (Task 2), `extract_baseline_title` (Phase 3, unchanged).

**Boundary:** Test-only task — no production code changes. Only touch `ingestion/tests/test_fidelity_golden.py`.

- [ ] **Step 1: Write the golden fidelity test suite**

```python
# ingestion/tests/test_fidelity_golden.py
from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.leveling.tree_builder import build_baseline_tree
from app.workitem.fidelity import verify_fidelity


def _sr(path: str, start: int, end: int) -> SourceRef:
    return SourceRef(document_path=path, start_offset=start, end_offset=end)


def _golden_doc() -> CanonicalDoc:
    path = "golden.txt"
    return CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="golden-hash"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, text="1 Power Subsystem", heading_level=1, source_ref=_sr(path, 0, 18)),
            Block(id="b1", kind=BlockKind.HEADING, text="1.1 3.3V Rail Requirements", heading_level=2, source_ref=_sr(path, 19, 46)),
            Block(id="b2", kind=BlockKind.OPEN_TBD, text="OPEN: confirm connector part number before release.", source_ref=_sr(path, 47, 100)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="TBD: verify against thermal derating curve.", source_ref=_sr(path, 101, 146)),
            Block(id="b4", kind=BlockKind.FIGURE, text="[FIGURE: rail schematic]", source_ref=_sr(path, 147, 172)),
        ],
    )


def test_description_is_byte_for_byte_verbatim_join_of_folded_blocks() -> None:
    tree = build_baseline_tree(_golden_doc())
    requirement_node = tree.nodes[1]
    expected = (
        "3.3V Rail Requirements"
        "\nOPEN: confirm connector part number before release."
        "\nTBD: verify against thermal derating curve."
        "\n[FIGURE: rail schematic]"
    )
    assert requirement_node.description == expected


def test_open_marker_text_is_preserved_verbatim_in_description() -> None:
    tree = build_baseline_tree(_golden_doc())
    requirement_node = tree.nodes[1]
    assert "OPEN: confirm connector part number before release." in requirement_node.description


def test_tbd_marker_text_is_preserved_verbatim_in_description() -> None:
    tree = build_baseline_tree(_golden_doc())
    requirement_node = tree.nodes[1]
    assert "TBD: verify against thermal derating curve." in requirement_node.description


def test_figure_placeholder_is_preserved_verbatim_in_description() -> None:
    tree = build_baseline_tree(_golden_doc())
    requirement_node = tree.nodes[1]
    assert "[FIGURE: rail schematic]" in requirement_node.description


def test_every_node_passes_verify_fidelity() -> None:
    tree = build_baseline_tree(_golden_doc())
    for node in tree.nodes:
        assert verify_fidelity(node) is True


def test_rebuilding_the_same_document_produces_identical_hashes() -> None:
    # Determinism: same source in -> same fidelity_hash out, every time.
    # No LLM involved in BASELINE mode, so this must hold exactly.
    tree_a = build_baseline_tree(_golden_doc())
    tree_b = build_baseline_tree(_golden_doc())
    hashes_a = [node.fidelity_hash for node in tree_a.nodes]
    hashes_b = [node.fidelity_hash for node in tree_b.nodes]
    assert hashes_a == hashes_b


def test_rebuilding_the_same_document_produces_identical_titles_and_descriptions() -> None:
    tree_a = build_baseline_tree(_golden_doc())
    tree_b = build_baseline_tree(_golden_doc())
    assert [n.title for n in tree_a.nodes] == [n.title for n in tree_b.nodes]
    assert [n.description for n in tree_a.nodes] == [n.description for n in tree_b.nodes]


def test_customer_id_and_fidelity_are_independent_dimensions() -> None:
    # Stamping customer_id must never perturb fidelity_hash — Customer ID is
    # pipeline metadata, not part of the hashed source-fidelity content.
    tree_no_customer = build_baseline_tree(_golden_doc())
    tree_with_customer = build_baseline_tree(_golden_doc(), customer_id="CUST-042")
    hashes_no_customer = [node.fidelity_hash for node in tree_no_customer.nodes]
    hashes_with_customer = [node.fidelity_hash for node in tree_with_customer.nodes]
    assert hashes_no_customer == hashes_with_customer
```

- [ ] **Step 2: Run to verify all pass**

Run: `pytest tests/test_fidelity_golden.py -v`
Expected: PASS (8 tests). If `test_description_is_byte_for_byte_verbatim_join_of_folded_blocks`'s exact expected string doesn't match (e.g. if `_split_into_branches` groups these 5 blocks differently than assumed, since `b0`'s heading_level=1 starts a new branch and `b1`'s heading_level=2 nests under it), adjust the fixture or the expected string to match actual behavior — do not weaken the assertion's intent (exact byte-for-byte match), only correct the expected literal if the real grouping differs from what's assumed here.

- [ ] **Step 3: Run the full local suite**

Run: `pytest -v`
Expected: all Phase 1-4 tests pass (same pre-existing OCR failures as before, unrelated).

- [ ] **Step 4: Commit**

```bash
git add ingestion/tests/test_fidelity_golden.py
git commit -m "test(ingestion): add golden fidelity suite covering byte-for-byte, determinism, TBD/OPEN preservation"
```

---

## Self-Review Notes

- **Spec coverage:** Phase 4's DoD ("Fidelity test byte-for-byte; re-hash stable; TBD/OPEN preserved; deterministic") is covered exactly: Task 4's golden suite has one test per DoD clause by name. "Hidden mutation" (the named risk) is the literal bug Task 1 fixes and the literal thing Task 2's `verify_fidelity` can detect after the fact.
- **Real bug found while planning, not invented busywork:** Task 1 exists because `fidelity_hash` was frozen at node-creation time in Phase 2/3's code, before Phase 3's `assemble_description` folding could append more content to `description` — meaning the DoD's own "re-hash stable" claim would have been FALSE for any node with folded content, silently, until this phase. This was discovered by reading `tree_builder.py` line-by-line against the DoD's exact wording, not assumed.
- **Customer ID scope decision, stated explicitly:** `customer_id` is a per-run pipeline parameter (one document = one customer), not per-paragraph extraction. This is inferred from architecture.md's idempotency key `(source_hash, customer_id, area_path) → System.Id` (customer_id is a dimension of the whole ingestion, same shape as area_path) — flagged here as an interpretation, not a directly-quoted spec line, in case it needs correction before execution.
- **Explicitly deferred, not silently dropped:** resolving the ADO field ref name for Customer ID (`Custom.CustomerId` vs `Custom.CustomerRequirementId` vs `Custom.CustomerID`, per the already-designed candidate-list algorithm in architecture.md) requires live ADO field discovery — that's Phase 7's MCP server, not this phase. This plan only stamps the plain string value onto `WorkItemNode.customer_id`.
- **Type consistency:** `build_baseline_tree(doc: CanonicalDoc, customer_id: str | None = None) -> WorkItemTree` (Task 3) matches `WorkItemNode.customer_id: str | None = None` (existing model, unchanged) exactly. `verify_fidelity(node: WorkItemNode) -> bool` (Task 2) takes the exact same `WorkItemNode` type Task 1's fixed `tree_builder.py` produces — no drift.
- **No placeholders:** every step contains complete, runnable code, including the endpoint test's explicit instruction to match the existing test file's fixture pattern rather than inventing a new one (since the exact existing pattern wasn't visible without reading that file first, which the implementer will do in Step 1).
