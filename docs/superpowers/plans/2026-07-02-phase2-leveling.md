# Phase 2 Hierarchy & Auto-Detect Leveling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the leveling engine that converts an already-parsed `CanonicalDoc` (from Phase 1's `ingestion` package) into a `WorkItemTree` — inferring Epic/Feature/Requirement hierarchy from numbering and heading depth, auto-detecting which of two leveling profiles applies **per top-level branch** (not once globally), deterministically in BASELINE mode with LLM off.

**Architecture:** A numbering parser + heading-depth resolver produce a single "effective depth" signal per block. A per-branch heuristic auto-detector picks `tv_style` (Epic/Epic/Feature/Requirement) or `icd_style` (Feature/Requirement) based on how deep that specific branch nests — this is what makes the same heading depth resolve to different types in different branches without needing an LLM. A stack-based tree builder walks blocks in order, assigning parent/child via depth, and folds unleveled body text (plain paragraphs, OPEN/TBD notes, inline figure placeholders) into the nearest open node's description. A separate, independent SURVEY/LLM leveling path is built as an injectable interface, proven with a hand-written fake client — no real Open WebUI integration in this phase (that infrastructure doesn't exist yet in `orchestrator`).

**Tech Stack:** Same as Phase 1 — Python 3.11+/pydantic v2/FastAPI/pytest. No new external dependencies. No Docker/Tesseract needed — this phase operates on already-parsed `CanonicalDoc` objects, not raw files, so every task is fully verifiable locally.

## Global Constraints

- Do NOT touch any loader (`text_loader.py`, `docx_loader.py`, `xlsx_loader.py`, `pdf_loader.py`, `ocr.py`) or the redaction pass (`redactor.py`) — this phase only adds new files under `app/leveling/` and `app/workitem/`, plus one new endpoint in `app/main.py`.
- `Block.number_label` is **never populated** by any Phase 1 loader (confirmed known gap) — the numbering parser in this phase must derive numbering by parsing `Block.text` directly via regex, not read `Block.number_label`.
- SURVEY-mode LLM leveling in this phase is an **injectable interface stub**, tested with a hand-written fake client — not a real Open WebUI call. The orchestrator's LLM proxy/redaction client does not exist yet; that is separate, future infrastructure.
- Output `WorkItemNode`/`WorkItemTree` must validate against `shared/schemas/work-item-tree.schema.json` exactly (field names, enum values, required/optional). Do not modify that schema file.
- Phase 2 does **not** do real title distillation (Phase 3's job) — `title` is a deterministic truncation (`display_text.strip()[:256]`) of the node's own text, just enough to satisfy the schema's non-null/`maxLength` constraint. Say so in code comments/docstrings, don't pretend it's final.
- `fidelity_hash` is computed as `sha256` of the block's own already-verbatim captured text (`display_text`), **not** a re-slice from the raw source file via `source_ref` offsets — Phase 1's final review documented that offset semantics are inconsistent across loaders (real offsets for txt/pdf, synthetic counter for docx, placeholder `(0,0)` for all tables), so hashing the block's own text is the correct, robust choice here.
- Type hints on every function signature; pydantic models, not raw dicts, for all `WorkItemTree`-shaped data; docstrings only where genuinely non-obvious (repo convention: no comments otherwise). This is the auto-detect heuristic's docstring in particular — it must honestly state it is a structural-depth heuristic, not semantic "infer intent from context" reasoning (that's SURVEY/LLM territory).

## Golden Reference Examples (source of truth for fixture content across tasks)

**TV-receiver example (`tv_style` profile):** a flat numbered spec — `1 Receiver` → `1.1 Broadcast & Inputs` → `1.1.1 Channel scan` → `1.1.1.1 <full requirement sentence>` — becomes `Epic: Receiver` → `Epic(sub): Broadcast & Inputs` → `Feature: Channel scan` → `Requirement: <title> | Description: <full sentence>`. Items may have child requirements via `.a`/`.b` sub-numbering (nested one level deeper, still type Requirement). One top-level branch may be deep (many Epics); another may go straight to Features — this is the context-dependent, per-branch behavior this phase's auto-detect heuristic approximates structurally.

**Backplane ICD example (`icd_style` profile):** deeply nested Markdown headings, heavy on tables/standards-references/`OPEN:`/`TBD` markers/figure placeholders. Convention: each **top-level heading = Feature**; everything nested below = Requirements (with occasional sub-requirements) — this differs from the TV example, which has explicit Epics.

---

### Task 1: WorkItemNode/WorkItemTree pydantic models

**Files:**
- Create: `ingestion/app/workitem/__init__.py`
- Create: `ingestion/app/workitem/model.py`
- Test: `ingestion/tests/test_workitem_model.py`

**Interfaces:**
- Consumes: `SourceRef` from `app.canonical.model` (already exists from Phase 1 — reuse it, do not redefine).
- Produces: `WorkItemType` (str enum: `EPIC="Epic"`, `FEATURE="Feature"`, `REQUIREMENT="Requirement"`), `WorkItemMode` (str enum: `BASELINE="BASELINE"`, `SURVEY="SURVEY"`), `RequirementTag` (str enum, 11 values matching the schema exactly), `WorkItemNode`, `WorkItemTree` (pydantic `BaseModel`s) in `ingestion/app/workitem/model.py` — every later task imports these exact names.

**Boundary:** This task only builds the pydantic models. No leveling logic yet. Do not modify `app/canonical/model.py`.

- [ ] **Step 1: Check for an existing venv, create one if absent**

Run: `cd ingestion && ls .venv 2>&1`
If it doesn't exist: `python3.13 -m venv .venv && source .venv/bin/activate && pip install -e ".[dev]"` (use whatever Python 3.11+ interpreter is available if `python3.13` isn't present — check `python3 --version` first). If it already exists (likely, since this worktree branched from a commit where Phase 1's venv may or may not have survived — check first), just `source .venv/bin/activate`.

- [ ] **Step 2: Write the failing test**

```python
# ingestion/tests/test_workitem_model.py
from app.canonical.model import SourceRef
from app.workitem.model import RequirementTag, WorkItemMode, WorkItemNode, WorkItemTree, WorkItemType


def _source_ref() -> SourceRef:
    return SourceRef(document_path="x.txt", start_offset=0, end_offset=10)


def test_work_item_node_matches_schema_shape() -> None:
    node = WorkItemNode(
        local_id="n0",
        type=WorkItemType.EPIC,
        parent_local_id=None,
        title="Receiver",
        description="1 Receiver",
        source_ref=_source_ref(),
        mode=WorkItemMode.BASELINE,
    )
    dumped = node.model_dump(mode="json")
    assert dumped["type"] == "Epic"
    assert dumped["mode"] == "BASELINE"
    assert dumped["customer_id"] is None
    assert dumped["fidelity_hash"] is None
    assert dumped["tags"] == []


def test_work_item_node_title_max_length_enforced() -> None:
    import pytest
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        WorkItemNode(
            local_id="n0",
            type=WorkItemType.REQUIREMENT,
            parent_local_id=None,
            title="x" * 257,
            description="too long",
            source_ref=_source_ref(),
            mode=WorkItemMode.BASELINE,
        )


def test_work_item_node_accepts_tags() -> None:
    node = WorkItemNode(
        local_id="n1",
        type=WorkItemType.REQUIREMENT,
        parent_local_id="n0",
        title="Shall support Hebrew",
        description="The system shall support Hebrew input.",
        source_ref=_source_ref(),
        mode=WorkItemMode.SURVEY,
        tags=[RequirementTag.FUNCTIONAL, RequirementTag.INTERFACE],
    )
    assert node.tags == [RequirementTag.FUNCTIONAL, RequirementTag.INTERFACE]


def test_work_item_tree_defaults_to_empty_nodes() -> None:
    tree = WorkItemTree()
    assert tree.nodes == []
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pytest tests/test_workitem_model.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.workitem'`

- [ ] **Step 4: Implement the models**

```python
# ingestion/app/workitem/__init__.py
```

```python
# ingestion/app/workitem/model.py
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field

from app.canonical.model import SourceRef


class WorkItemType(str, Enum):
    EPIC = "Epic"
    FEATURE = "Feature"
    REQUIREMENT = "Requirement"


class WorkItemMode(str, Enum):
    BASELINE = "BASELINE"
    SURVEY = "SURVEY"


class RequirementTag(str, Enum):
    FUNCTIONAL = "functional"
    NON_FUNCTIONAL = "non_functional"
    INTERFACE = "interface"
    PERFORMANCE = "performance"
    REGULATORY = "regulatory"
    SAFETY = "safety"
    SECURITY = "security"
    OPERATION = "operation"
    MAINTENANCE = "maintenance"
    FEATURE = "feature"
    BEHAVIOR = "behavior"


class WorkItemNode(BaseModel):
    local_id: str
    type: WorkItemType
    parent_local_id: str | None
    title: str = Field(max_length=256)
    description: str
    customer_id: str | None = None
    source_ref: SourceRef
    fidelity_hash: str | None = None
    tags: list[RequirementTag] = Field(default_factory=list)
    mode: WorkItemMode


class WorkItemTree(BaseModel):
    nodes: list[WorkItemNode] = Field(default_factory=list)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest tests/test_workitem_model.py -v`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/workitem/__init__.py ingestion/app/workitem/model.py ingestion/tests/test_workitem_model.py
git commit -m "feat(ingestion): add WorkItemNode/WorkItemTree pydantic models"
```

---

### Task 2: Numbering parser + effective depth resolution

**Files:**
- Create: `ingestion/app/leveling/__init__.py`
- Create: `ingestion/app/leveling/numbering.py`
- Create: `ingestion/app/leveling/depth.py`
- Test: `ingestion/tests/test_numbering.py`
- Test: `ingestion/tests/test_depth.py`

**Interfaces:**
- Consumes: `Block`, `BlockKind` from `app.canonical.model` (Phase 1, already exists).
- Produces: `parse_numbering(text: str) -> tuple[str | None, str]` and `numbering_depth(label: str) -> int` in `ingestion/app/leveling/numbering.py`; `resolve_block_depth(block: Block) -> tuple[int | None, str]` in `ingestion/app/leveling/depth.py` — Task 4 (autodetect) and Task 5 (tree builder) both import `resolve_block_depth` by this exact name and signature.

**Boundary:** Only touch `app/leveling/__init__.py`, `app/leveling/numbering.py`, `app/leveling/depth.py`, and this task's own tests. Do not create `profiles.py`, `autodetect.py`, or `tree_builder.py` yet — those are later tasks.

- [ ] **Step 1: Write the failing numbering tests**

```python
# ingestion/tests/test_numbering.py
from app.leveling.numbering import numbering_depth, parse_numbering


def test_parses_single_level_numbering() -> None:
    label, remainder = parse_numbering("1 Receiver")
    assert label == "1"
    assert remainder == "Receiver"


def test_parses_four_level_numbering() -> None:
    label, remainder = parse_numbering("1.1.1.1 The receiver shall scan all channels.")
    assert label == "1.1.1.1"
    assert remainder == "The receiver shall scan all channels."


def test_parses_lettered_sub_item_numbering() -> None:
    label, remainder = parse_numbering("1.1.1.1.a The receiver shall support terrestrial broadcast.")
    assert label == "1.1.1.1.a"
    assert remainder == "The receiver shall support terrestrial broadcast."


def test_returns_none_for_unnumbered_text() -> None:
    label, remainder = parse_numbering("The receiver shall scan all channels.")
    assert label is None
    assert remainder == "The receiver shall scan all channels."


def test_numbering_depth_counts_dot_separated_segments() -> None:
    assert numbering_depth("1") == 1
    assert numbering_depth("1.1") == 2
    assert numbering_depth("1.1.1.1") == 4
    assert numbering_depth("1.1.1.a") == 4
    assert numbering_depth("1.1.1.1.a") == 5
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_numbering.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.leveling'`

- [ ] **Step 3: Implement the numbering parser**

```python
# ingestion/app/leveling/__init__.py
```

```python
# ingestion/app/leveling/numbering.py
from __future__ import annotations

import re

_NUMBERING_PATTERN = re.compile(r"^(\d+(?:\.\d+)*(?:\.[a-z])?)\s+(.*)$", re.DOTALL)


def parse_numbering(text: str) -> tuple[str | None, str]:
    """Detects a leading numbering label like '1', '1.1', '1.1.1.1', or
    '1.1.1.a' at the start of the text and returns (label, remainder-with-
    label-stripped). Returns (None, text) if no numbering prefix is found."""
    match = _NUMBERING_PATTERN.match(text.strip())
    if not match:
        return None, text
    label, remainder = match.group(1), match.group(2)
    return label, remainder


def numbering_depth(label: str) -> int:
    return len(label.split("."))
```

- [ ] **Step 4: Run to verify numbering tests pass**

Run: `pytest tests/test_numbering.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Write the failing depth-resolution tests**

```python
# ingestion/tests/test_depth.py
from app.canonical.model import Block, BlockKind, SourceRef
from app.leveling.depth import resolve_block_depth


def _sr() -> SourceRef:
    return SourceRef(document_path="x", start_offset=0, end_offset=1)


def test_heading_block_uses_heading_level_as_depth() -> None:
    block = Block(id="b0", kind=BlockKind.HEADING, heading_level=2, text="Broadcast & Inputs", source_ref=_sr())
    depth, display_text = resolve_block_depth(block)
    assert depth == 2
    assert display_text == "Broadcast & Inputs"


def test_numbered_paragraph_block_uses_numbering_depth() -> None:
    block = Block(id="b1", kind=BlockKind.PARAGRAPH, text="1.1.1 Channel scan", source_ref=_sr())
    depth, display_text = resolve_block_depth(block)
    assert depth == 3
    assert display_text == "Channel scan"


def test_unleveled_block_returns_none_depth() -> None:
    block = Block(id="b2", kind=BlockKind.PARAGRAPH, text="This is plain body text.", source_ref=_sr())
    depth, display_text = resolve_block_depth(block)
    assert depth is None
    assert display_text == "This is plain body text."


def test_heading_block_without_heading_level_falls_back_to_numbering() -> None:
    # Defensive case: a HEADING-kind block that somehow has no heading_level
    # set should fall back to the numbering-parse path rather than crashing.
    block = Block(id="b3", kind=BlockKind.HEADING, text="1.1 Broadcast & Inputs", source_ref=_sr())
    depth, display_text = resolve_block_depth(block)
    assert depth == 2
    assert display_text == "Broadcast & Inputs"
```

- [ ] **Step 6: Run to verify failure**

Run: `pytest tests/test_depth.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.leveling.depth'`

- [ ] **Step 7: Implement depth resolution**

```python
# ingestion/app/leveling/depth.py
from __future__ import annotations

from app.canonical.model import Block, BlockKind
from app.leveling.numbering import numbering_depth, parse_numbering


def resolve_block_depth(block: Block) -> tuple[int | None, str]:
    """Resolves a block's effective hierarchy depth from whichever signal is
    present: an explicit heading_level (from md/docx heading markup), or a
    parsed numbering label (from plain numbered-text specs like '1.1.1.1').
    Returns (None, block.text) for unleveled body content (plain paragraphs,
    list items, notes, OPEN/TBD markers, inline figure placeholders)."""
    if block.kind == BlockKind.HEADING and block.heading_level is not None:
        return block.heading_level, block.text

    label, remainder = parse_numbering(block.text)
    if label is not None:
        return numbering_depth(label), remainder

    return None, block.text
```

- [ ] **Step 8: Run to verify depth tests pass, then the full local suite**

Run: `pytest tests/test_depth.py -v`
Expected: PASS (4 tests)

Run: `pytest -v`
Expected: all Phase 1 tests + this task's 9 new tests pass, no regressions.

- [ ] **Step 9: Commit**

```bash
git add ingestion/app/leveling/__init__.py ingestion/app/leveling/numbering.py ingestion/app/leveling/depth.py ingestion/tests/test_numbering.py ingestion/tests/test_depth.py
git commit -m "feat(ingestion): add numbering parser and effective depth resolution"
```

---

### Task 3: Leveling profiles (tv_style / icd_style type mapping)

**Files:**
- Create: `ingestion/app/leveling/profiles.py`
- Test: `ingestion/tests/test_profiles.py`

**Interfaces:**
- Consumes: `WorkItemType` from `app.workitem.model` (Task 1).
- Produces: `LevelingProfile` (a `Literal["tv_style", "icd_style"]` type alias) and `type_for_depth(profile: LevelingProfile, depth: int) -> WorkItemType` in `ingestion/app/leveling/profiles.py` — Task 4 (autodetect) imports `LevelingProfile`; Task 5 (tree builder) imports both.

**Boundary:** Only touch `ingestion/app/leveling/profiles.py` and this task's own test. Do not touch `numbering.py`, `depth.py`, or create `autodetect.py`/`tree_builder.py` yet.

- [ ] **Step 1: Write the failing test**

```python
# ingestion/tests/test_profiles.py
from app.leveling.profiles import type_for_depth
from app.workitem.model import WorkItemType


def test_tv_style_depth_1_and_2_are_epic() -> None:
    assert type_for_depth("tv_style", 1) == WorkItemType.EPIC
    assert type_for_depth("tv_style", 2) == WorkItemType.EPIC


def test_tv_style_depth_3_is_feature() -> None:
    assert type_for_depth("tv_style", 3) == WorkItemType.FEATURE


def test_tv_style_depth_4_and_beyond_is_requirement() -> None:
    assert type_for_depth("tv_style", 4) == WorkItemType.REQUIREMENT
    assert type_for_depth("tv_style", 5) == WorkItemType.REQUIREMENT


def test_icd_style_depth_1_is_feature() -> None:
    assert type_for_depth("icd_style", 1) == WorkItemType.FEATURE


def test_icd_style_depth_2_and_beyond_is_requirement() -> None:
    assert type_for_depth("icd_style", 2) == WorkItemType.REQUIREMENT
    assert type_for_depth("icd_style", 10) == WorkItemType.REQUIREMENT
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_profiles.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.leveling.profiles'`

- [ ] **Step 3: Implement**

```python
# ingestion/app/leveling/profiles.py
from __future__ import annotations

from typing import Literal

from app.workitem.model import WorkItemType

LevelingProfile = Literal["tv_style", "icd_style"]


def type_for_depth(profile: LevelingProfile, depth: int) -> WorkItemType:
    """Maps a resolved depth to a work-item type per the two golden-reference
    leveling profiles:
    - tv_style: depth 1-2 -> Epic, depth 3 -> Feature, depth >=4 -> Requirement.
    - icd_style: depth 1 -> Feature, depth >=2 -> Requirement."""
    if profile == "tv_style":
        if depth <= 2:
            return WorkItemType.EPIC
        if depth == 3:
            return WorkItemType.FEATURE
        return WorkItemType.REQUIREMENT
    if depth <= 1:
        return WorkItemType.FEATURE
    return WorkItemType.REQUIREMENT
```

- [ ] **Step 4: Run to verify it passes**

Run: `pytest tests/test_profiles.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/leveling/profiles.py ingestion/tests/test_profiles.py
git commit -m "feat(ingestion): add tv_style/icd_style depth-to-type profile mapping"
```

---

### Task 4: Per-branch heuristic auto-detect

**Files:**
- Create: `ingestion/app/leveling/autodetect.py`
- Test: `ingestion/tests/test_autodetect.py`

**Interfaces:**
- Consumes: `Block` from `app.canonical.model`; `resolve_block_depth` from `app.leveling.depth` (Task 2); `LevelingProfile` from `app.leveling.profiles` (Task 3).
- Produces: `detect_profile_for_branch(branch_blocks: list[Block]) -> LevelingProfile` in `ingestion/app/leveling/autodetect.py` — Task 5 (tree builder) imports this by exact name.

**Boundary:** Only touch `ingestion/app/leveling/autodetect.py` and this task's own test. This function must NOT do any semantic/LLM reasoning — it is a documented, honest structural-depth heuristic only (real "infer intent from context" reasoning is SURVEY/LLM territory, built separately in Task 6).

- [ ] **Step 1: Write the failing test**

```python
# ingestion/tests/test_autodetect.py
from app.canonical.model import Block, BlockKind, SourceRef
from app.leveling.autodetect import detect_profile_for_branch


def _sr() -> SourceRef:
    return SourceRef(document_path="x", start_offset=0, end_offset=1)


def test_shallow_branch_detected_as_icd_style() -> None:
    branch = [
        Block(id="c0", kind=BlockKind.HEADING, heading_level=1, text="Power Distribution", source_ref=_sr()),
        Block(id="c1", kind=BlockKind.HEADING, heading_level=2, text="3.3V Rail Requirements", source_ref=_sr()),
    ]
    assert detect_profile_for_branch(branch) == "icd_style"


def test_deep_branch_detected_as_tv_style() -> None:
    branch = [
        Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr()),
        Block(id="b1", kind=BlockKind.PARAGRAPH, text="1.1 Broadcast & Inputs", source_ref=_sr()),
        Block(id="b2", kind=BlockKind.PARAGRAPH, text="1.1.1 Channel scan", source_ref=_sr()),
        Block(id="b3", kind=BlockKind.PARAGRAPH, text="1.1.1.1 The receiver shall scan all channels.", source_ref=_sr()),
    ]
    assert detect_profile_for_branch(branch) == "tv_style"


def test_branch_with_only_unleveled_blocks_defaults_to_icd_style() -> None:
    branch = [Block(id="x0", kind=BlockKind.PARAGRAPH, text="Just plain text, no numbering or heading.", source_ref=_sr())]
    assert detect_profile_for_branch(branch) == "icd_style"
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_autodetect.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.leveling.autodetect'`

- [ ] **Step 3: Implement**

```python
# ingestion/app/leveling/autodetect.py
from __future__ import annotations

from app.canonical.model import Block
from app.leveling.depth import resolve_block_depth
from app.leveling.profiles import LevelingProfile


def detect_profile_for_branch(branch_blocks: list[Block]) -> LevelingProfile:
    """Heuristic, structural-depth-based auto-detect for BASELINE mode.

    This does NOT perform semantic "infer intent from context" reasoning —
    that is SURVEY/LLM territory (see llm_leveling.py). It only measures how
    deeply this branch nests (via resolve_block_depth) and classifies
    shallow branches (max depth <= 2) as icd_style (top heading = Feature,
    everything nested = Requirement) and deeper branches (max depth >= 3) as
    tv_style (Epic/Epic/Feature/Requirement ladder). Auto-detection runs
    PER TOP-LEVEL BRANCH, not once globally for the whole document — this is
    what allows the same nominal depth to resolve to different work-item
    types in different branches of the same document."""
    depths = [d for d, _ in (resolve_block_depth(b) for b in branch_blocks) if d is not None]
    max_depth = max(depths) if depths else 1
    return "icd_style" if max_depth <= 2 else "tv_style"
```

- [ ] **Step 4: Run to verify it passes**

Run: `pytest tests/test_autodetect.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/leveling/autodetect.py ingestion/tests/test_autodetect.py
git commit -m "feat(ingestion): add per-branch heuristic profile auto-detect"
```

---

### Task 5: Tree builder + golden fixture tests (the DoD-satisfying task)

**Files:**
- Create: `ingestion/app/leveling/tree_builder.py`
- Test: `ingestion/tests/test_tree_builder.py`

**Interfaces:**
- Consumes: `CanonicalDoc`, `Block`, `BlockKind`, `Document`, `DocumentFormat`, `SourceRef` from `app.canonical.model`; `resolve_block_depth` from `app.leveling.depth` (Task 2); `detect_profile_for_branch` from `app.leveling.autodetect` (Task 4); `type_for_depth` from `app.leveling.profiles` (Task 3); `WorkItemNode`, `WorkItemTree`, `WorkItemMode` from `app.workitem.model` (Task 1).
- Produces: `build_baseline_tree(doc: CanonicalDoc) -> WorkItemTree` in `ingestion/app/leveling/tree_builder.py` — Task 7 (FastAPI wiring) imports this by exact name.

**Boundary:** Only touch `ingestion/app/leveling/tree_builder.py` and this task's own test. Do not modify any of the Task 1-4 files — only import from them.

- [ ] **Step 1: Write the failing tests (this is the task that proves Phase 2's DoD literally)**

```python
# ingestion/tests/test_tree_builder.py
from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.leveling.tree_builder import build_baseline_tree
from app.workitem.model import WorkItemType


def _sr(path: str, start: int, end: int) -> SourceRef:
    return SourceRef(document_path=path, start_offset=start, end_offset=end)


def _tv_style_doc() -> CanonicalDoc:
    path = "tv_receiver.txt"
    return CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="tvhash"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr(path, 0, 10)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="1.1 Broadcast & Inputs", source_ref=_sr(path, 11, 33)),
            Block(id="b2", kind=BlockKind.PARAGRAPH, text="1.1.1 Channel scan", source_ref=_sr(path, 34, 52)),
            Block(
                id="b3",
                kind=BlockKind.PARAGRAPH,
                text="1.1.1.1 The receiver shall scan all available channels within 10 seconds of power-on.",
                source_ref=_sr(path, 53, 140),
            ),
            Block(
                id="b4",
                kind=BlockKind.PARAGRAPH,
                text="1.1.1.1.a The receiver shall support terrestrial broadcast input.",
                source_ref=_sr(path, 141, 207),
            ),
        ],
    )


def _icd_style_doc() -> CanonicalDoc:
    path = "backplane_icd.md"
    return CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.MD, sha256="icdhash"),
        blocks=[
            Block(id="c0", kind=BlockKind.HEADING, heading_level=1, text="Power Distribution", source_ref=_sr(path, 0, 19)),
            Block(
                id="c1",
                kind=BlockKind.HEADING,
                heading_level=2,
                text="3.3V Rail Requirements",
                source_ref=_sr(path, 20, 43),
            ),
            Block(
                id="c2",
                kind=BlockKind.OPEN_TBD,
                text="OPEN: confirm connector part number before release.",
                source_ref=_sr(path, 44, 96),
            ),
            Block(id="c3", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_sr(path, 97, 111)),
        ],
    )


def test_tv_style_branch_autodetects_and_builds_epic_epic_feature_requirement() -> None:
    tree = build_baseline_tree(_tv_style_doc())
    types = [n.type for n in tree.nodes]
    assert types == [
        WorkItemType.EPIC,
        WorkItemType.EPIC,
        WorkItemType.FEATURE,
        WorkItemType.REQUIREMENT,
        WorkItemType.REQUIREMENT,
    ]
    requirement_node = tree.nodes[3]
    sub_requirement_node = tree.nodes[4]
    assert sub_requirement_node.parent_local_id == requirement_node.local_id


def test_icd_style_branch_autodetects_and_builds_feature_requirement() -> None:
    tree = build_baseline_tree(_icd_style_doc())
    types = [n.type for n in tree.nodes]
    assert types == [WorkItemType.FEATURE, WorkItemType.REQUIREMENT]
    requirement_node = tree.nodes[1]
    assert "OPEN: confirm connector part number" in requirement_node.description
    assert "[FIGURE: none]" in requirement_node.description


def test_same_depth_produces_different_types_per_branch() -> None:
    # This is the literal DoD case: "same-depth->different-type case".
    tv_doc = _tv_style_doc()
    icd_doc = _icd_style_doc()
    combined = CanonicalDoc(
        document=Document(path="combined.txt", format=DocumentFormat.TXT, sha256="combinedhash"),
        blocks=tv_doc.blocks + icd_doc.blocks,
    )
    tree = build_baseline_tree(combined)

    tv_depth2_node = tree.nodes[1]  # "1.1 Broadcast & Inputs" — depth 2 in the tv_style branch
    assert tv_depth2_node.type == WorkItemType.EPIC

    icd_depth2_node = tree.nodes[6]  # 5 tv-branch nodes (indices 0-4) then icd's 2nd node (index 6)
    assert icd_depth2_node.type == WorkItemType.REQUIREMENT

    assert tv_depth2_node.type != icd_depth2_node.type


def test_build_baseline_tree_is_deterministic() -> None:
    doc = _tv_style_doc()
    tree1 = build_baseline_tree(doc)
    tree2 = build_baseline_tree(doc)
    assert tree1.model_dump() == tree2.model_dump()


def test_fidelity_hash_is_sha256_of_display_text() -> None:
    import hashlib

    tree = build_baseline_tree(_tv_style_doc())
    epic_node = tree.nodes[0]
    assert epic_node.fidelity_hash == hashlib.sha256("Receiver".encode()).hexdigest()


def test_title_is_truncated_to_256_chars() -> None:
    long_text_doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(
                id="b0",
                kind=BlockKind.PARAGRAPH,
                text="1 " + ("A" * 300),
                source_ref=_sr("x.txt", 0, 302),
            )
        ],
    )
    tree = build_baseline_tree(long_text_doc)
    assert len(tree.nodes[0].title) == 256
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_tree_builder.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.leveling.tree_builder'`

- [ ] **Step 3: Implement the tree builder**

```python
# ingestion/app/leveling/tree_builder.py
from __future__ import annotations

import hashlib

from app.canonical.model import Block, CanonicalDoc
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


def build_baseline_tree(doc: CanonicalDoc) -> WorkItemTree:
    """Deterministic BASELINE-mode leveling: no LLM involved. Splits the
    document into top-level branches, auto-detects a profile per branch
    (see autodetect.py), then walks each branch's blocks maintaining a
    depth stack to assign parent/child relationships. Unleveled blocks
    (plain paragraphs, list items, notes, OPEN/TBD markers, inline figure
    placeholders) extend the nearest currently-open node's description
    rather than becoming their own node."""
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
                    nodes_by_id[stack[-1][1]].description += "\n" + display_text
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
                title=display_text.strip()[:256],
                description=display_text,
                customer_id=None,
                source_ref=block.source_ref,
                fidelity_hash=hashlib.sha256(display_text.encode()).hexdigest(),
                tags=[],
                mode=WorkItemMode.BASELINE,
            )
            nodes.append(node)
            nodes_by_id[local_id] = node
            stack.append((depth, local_id))

    return WorkItemTree(nodes=nodes)
```

- [ ] **Step 4: Run to verify it passes**

Run: `pytest tests/test_tree_builder.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full local suite**

Run: `pytest -v`
Expected: all Phase 1 tests + all Phase 2 tests so far pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/leveling/tree_builder.py ingestion/tests/test_tree_builder.py
git commit -m "feat(ingestion): add BASELINE tree builder with golden fixture tests for both leveling profiles"
```

---

### Task 6: SURVEY/LLM leveling interface stub

**Files:**
- Create: `ingestion/app/leveling/llm_leveling.py`
- Test: `ingestion/tests/test_llm_leveling.py`

**Interfaces:**
- Consumes: `CanonicalDoc` from `app.canonical.model`; `resolve_block_depth` from `app.leveling.depth` (Task 2); `LevelingProfile` from `app.leveling.profiles` (Task 3); `WorkItemMode`, `WorkItemNode`, `WorkItemTree`, `WorkItemType` from `app.workitem.model` (Task 1).
- Produces: `LlmLevelingClient` (a `Protocol`) and `build_survey_tree(doc: CanonicalDoc, llm_client: LlmLevelingClient) -> WorkItemTree` in `ingestion/app/leveling/llm_leveling.py`.

**Boundary:** Only touch `ingestion/app/leveling/llm_leveling.py` and this task's own test. This task does NOT call any real LLM/Open WebUI endpoint — it proves the interface/wiring seam only, using a hand-written fake test double. Do not modify `tree_builder.py` (BASELINE path) — this is a fully separate function for SURVEY mode.

- [ ] **Step 1: Write the failing test**

```python
# ingestion/tests/test_llm_leveling.py
from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.leveling.llm_leveling import LlmLevelingClient, build_survey_tree
from app.workitem.model import WorkItemMode, WorkItemType


def _sr(path: str) -> SourceRef:
    return SourceRef(document_path=path, start_offset=0, end_offset=10)


def _small_doc() -> CanonicalDoc:
    path = "survey_input.txt"
    return CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="Display", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
        ],
    )


class FakeLlmLevelingClient:
    """Hand-written test double proving the LlmLevelingClient interface/wiring
    works end-to-end. No real Open WebUI call exists yet in this phase — the
    orchestrator's LLM proxy is separate, not-yet-built infrastructure."""

    def infer_hierarchy(self, outline: str, profile_hint: str | None) -> list[dict]:
        assert "Display" in outline
        assert "HDR" in outline
        return [
            {"node_id": "0", "type": "Feature", "parent_id": None},
            {"node_id": "1", "type": "Requirement", "parent_id": "0"},
        ]


def test_build_survey_tree_uses_injected_llm_client() -> None:
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient())
    assert len(tree.nodes) == 2
    assert tree.nodes[0].type == WorkItemType.FEATURE
    assert tree.nodes[0].parent_local_id is None
    assert tree.nodes[1].type == WorkItemType.REQUIREMENT
    assert tree.nodes[1].parent_local_id == "0"


def test_survey_tree_nodes_have_survey_mode_and_no_fidelity_hash() -> None:
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient())
    for node in tree.nodes:
        assert node.mode == WorkItemMode.SURVEY
        assert node.fidelity_hash is None


def test_llm_leveling_client_is_a_protocol_satisfied_by_the_fake() -> None:
    client: LlmLevelingClient = FakeLlmLevelingClient()
    result = client.infer_hierarchy("Display\nThe display shall support HDR.", None)
    assert isinstance(result, list)
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_llm_leveling.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.leveling.llm_leveling'`

- [ ] **Step 3: Implement**

```python
# ingestion/app/leveling/llm_leveling.py
from __future__ import annotations

from typing import Protocol

from app.canonical.model import CanonicalDoc
from app.leveling.depth import resolve_block_depth
from app.leveling.profiles import LevelingProfile
from app.workitem.model import WorkItemMode, WorkItemNode, WorkItemTree, WorkItemType


class LlmLevelingClient(Protocol):
    """Interface for SURVEY-mode hierarchy inference. No real implementation
    exists in this phase — the orchestrator's LLM proxy/redaction client
    (which would host the actual Open WebUI call) is separate, not-yet-built
    infrastructure. This Protocol lets tests and future callers inject any
    conforming client. Matches the runtime prompt contract documented in
    docs/architecture.md: strict JSON {node_id,type,parent_id}[]."""

    def infer_hierarchy(self, outline: str, profile_hint: LevelingProfile | None) -> list[dict]: ...


def _build_outline(doc: CanonicalDoc) -> str:
    lines = []
    for block in doc.blocks:
        _, display_text = resolve_block_depth(block)
        lines.append(display_text)
    return "\n".join(lines)


def build_survey_tree(doc: CanonicalDoc, llm_client: LlmLevelingClient) -> WorkItemTree:
    """SURVEY-mode leveling: node_id in the LLM's response corresponds to
    the block's index (as a string) in doc.blocks, in outline order. This
    phase only proves the LLM-hierarchy-inference seam — title/description
    are both set to the block's raw display_text for now; Phase 3 will
    replace title with real distillation and description with formalized
    SURVEY-mode text."""
    outline = _build_outline(doc)
    hierarchy = llm_client.infer_hierarchy(outline, profile_hint=None)

    block_by_index = {str(i): block for i, block in enumerate(doc.blocks)}
    nodes: list[WorkItemNode] = []
    for entry in hierarchy:
        node_id = entry["node_id"]
        block = block_by_index.get(node_id)
        if block is None:
            continue
        _, display_text = resolve_block_depth(block)
        nodes.append(
            WorkItemNode(
                local_id=node_id,
                type=WorkItemType(entry["type"]),
                parent_local_id=entry["parent_id"],
                title=display_text.strip()[:256],
                description=display_text,
                customer_id=None,
                source_ref=block.source_ref,
                fidelity_hash=None,
                tags=[],
                mode=WorkItemMode.SURVEY,
            )
        )
    return WorkItemTree(nodes=nodes)
```

- [ ] **Step 4: Run to verify it passes**

Run: `pytest tests/test_llm_leveling.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/leveling/llm_leveling.py ingestion/tests/test_llm_leveling.py
git commit -m "feat(ingestion): add injectable SURVEY/LLM leveling interface with fake-client test"
```

---

### Task 7: FastAPI `/level` endpoint

**Files:**
- Modify: `ingestion/app/main.py`
- Test: `ingestion/tests/test_level_endpoint.py`

**Interfaces:**
- Consumes: `build_baseline_tree` from `app.leveling.tree_builder` (Task 5); `WorkItemTree` from `app.workitem.model` (Task 1); `CanonicalDoc` from `app.canonical.model` (already imported in `main.py`).
- Produces: `POST /level` route accepting a `CanonicalDoc` JSON body directly (leveling is a separate pipeline stage from raw-file ingestion, so this does not go through `dispatch_by_extension` — it takes an already-parsed `CanonicalDoc`, not a file upload), returning the `WorkItemTree` as JSON.

**Boundary:** Only touch `ingestion/app/main.py` (adding the route) and this task's own test. Do not modify `app/dispatch.py` — this endpoint is a distinct pipeline stage, not a format-dispatch case.

- [ ] **Step 1: Write the failing test**

```python
# ingestion/tests/test_level_endpoint.py
from fastapi.testclient import TestClient

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.main import app

client = TestClient(app)


def _sr(path: str) -> SourceRef:
    return SourceRef(document_path=path, start_offset=0, end_offset=10)


def test_level_endpoint_returns_worktree_json() -> None:
    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr("x.txt")),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="1.1 Broadcast & Inputs", source_ref=_sr("x.txt")),
        ],
    )
    response = client.post("/level", json=doc.model_dump(mode="json"))
    assert response.status_code == 200
    body = response.json()
    assert len(body["nodes"]) == 2
    assert body["nodes"][0]["type"] == "Epic"
    assert body["nodes"][1]["type"] == "Epic"
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_level_endpoint.py -v`
Expected: FAIL — `404` (route doesn't exist yet)

- [ ] **Step 3: Add the route**

```python
# ingestion/app/main.py — add these imports and route to the existing file, do not remove anything
from app.leveling.tree_builder import build_baseline_tree
from app.workitem.model import WorkItemTree

# ... (existing /health and /ingest routes stay unchanged) ...

@app.post("/level", response_model=WorkItemTree)
async def level(doc: CanonicalDoc) -> WorkItemTree:
    return build_baseline_tree(doc)
```

- [ ] **Step 4: Run to verify it passes**

Run: `pytest tests/test_level_endpoint.py -v`
Expected: PASS (1 test)

- [ ] **Step 5: Run the full local suite to confirm no regressions**

Run: `pytest -v`
Expected: all Phase 1 + all Phase 2 tests pass (should be Phase 1's 51 + Task 1's 4 + Task 2's 9 + Task 3's 5 + Task 4's 3 + Task 5's 6 + Task 6's 3 + Task 7's 1 = 82 total — verify the actual count and report it, don't assume this arithmetic is exact).

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/main.py ingestion/tests/test_level_endpoint.py
git commit -m "feat(ingestion): wire POST /level endpoint for BASELINE hierarchy leveling"
```

---

## Self-Review Notes

- **Spec coverage:** Phase 2's DoD ("Golden trees for both profiles; same-depth->different-type case; BASELINE deterministic w/ LLM off") is covered exactly by Task 5's three named tests (`test_tv_style_branch_...`, `test_icd_style_branch_...`, `test_same_depth_produces_different_types_per_branch`, `test_build_baseline_tree_is_deterministic`). SURVEY/LLM leveling (Task 6) is explicitly scoped as an interface-proof, per the locked decision — not a DoD requirement for this phase.
- **Known, deliberate limitations carried forward (not silently missing, documented in code/plan):** title is a truncation placeholder, not real distillation (Phase 3's job); leading unleveled content before any heading in a document is dropped (no synthetic root node created) — acceptable for Phase 2, both golden fixtures in this plan start with a leveled block so this path isn't exercised by the golden tests, but it's a known, named gap for whoever revisits this later; the auto-detect heuristic is purely structural (branch max depth), not semantic — this is stated explicitly in `autodetect.py`'s docstring per the Global Constraints.
- **Type consistency:** `resolve_block_depth(block: Block) -> tuple[int | None, str]` (Task 2) is consumed identically by `detect_profile_for_branch` (Task 4), `build_baseline_tree` (Task 5), and `_build_outline` inside `build_survey_tree` (Task 6) — same signature, same tuple-unpacking pattern (`depth, display_text = resolve_block_depth(block)`) used consistently across all three call sites. `LevelingProfile` (Task 3) is a bare `Literal["tv_style", "icd_style"]`, consumed as plain string literals (`"tv_style"`, `"icd_style"`) in Task 4 and Task 5 — no enum wrapper mismatch.
- **No placeholders:** every step contains complete, runnable code; the plan explicitly does not use TBD/TODO — the ONE deliberate "Phase 3 will do X" note (title truncation) is a scoping statement about a LATER phase's future work, not a placeholder inside THIS phase's implementation.
