# Phase 3 Title/Description Distillation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Phase 2's naive `display_text.strip()[:256]` title placeholder with real title-extraction logic (BASELINE: word-boundary-aware truncation, never mid-word/mid-codepoint) and formalize description assembly into a testable pure function — satisfying Phase 3's DoD ("255/256/257 + multibyte tests; BASELINE title = extracted substring; description verbatim"). Also builds the SURVEY-mode title-distillation seam as an injectable client interface with a fake test double, consistent with Phase 2's `LlmLevelingClient` pattern — no real LLM call yet, since the orchestrator's redaction-proxy (the required routing point for all LLM calls) doesn't exist.

**Architecture:** `app/distillation/title.py` holds the real, deterministic BASELINE extraction algorithm. `app/distillation/description.py` holds the verbatim-joining pure function, pulled out of `tree_builder.py`'s inline string concatenation. `app/distillation/survey_title.py` holds the SURVEY-mode `TitleDistillationClient` Protocol + a defensively-truncating wrapper, mirroring `llm_leveling.py`'s existing `LlmLevelingClient` pattern. Both `tree_builder.py` (BASELINE) and `llm_leveling.py` (SURVEY) get wired to import and use these new modules instead of their current inline placeholders.

**Tech Stack:** Same as Phase 1/2 — Python 3.11+/pydantic v2/FastAPI/pytest. No new dependencies. No Docker needed — pure Python logic, fully verifiable locally.

## Global Constraints

- BASELINE title extraction must NEVER summarize or paraphrase — only extract/truncate the existing verbatim text. This is a hard architectural rule (see architecture.md: "in BASELINE mode you must extract, not summarize").
- BASELINE truncation must never split mid-word when a word boundary exists within the truncation window, and must never exceed `WorkItemNode.title`'s `max_length=256` pydantic constraint (already enforced by the model — the extraction function must independently guarantee this too, not rely solely on the model to catch violations).
- Multibyte safety: truncation must operate on Unicode codepoints (Python's native `str` semantics), not bytes — must not raise, corrupt, or produce an invalid string when truncating multi-codepoint content (e.g. repeated emoji). Full extended-grapheme-cluster awareness (e.g. not splitting an emoji+skin-tone-modifier pair) is explicitly OUT OF SCOPE for this phase — say so honestly in the module's docstring rather than overclaiming.
- SURVEY-mode title distillation remains a pure interface-and-stub exercise this phase — no real HTTP/LLM call, no new dependency for an HTTP client. The fake client test double proves the wiring only.
- Do not modify `app/leveling/depth.py`, `app/leveling/profiles.py`, `app/leveling/autodetect.py`, `app/workitem/model.py`, or any loader/redaction file — only `app/leveling/tree_builder.py` and `app/leveling/llm_leveling.py` get modified (to wire in the new distillation modules), plus the new `app/distillation/` package.
- Do not break any existing Phase 1/2 test. The existing `test_title_is_truncated_to_256_chars` test (input: `"1 " + "A"*300`, a single unbroken run of characters with no whitespace) must still pass unmodified — the new extraction algorithm's fallback-to-hard-cut behavior for word-boundary-free input produces the same `len(title) == 256` result as the old naive slice.
- Type hints on every function signature; docstrings only where genuinely non-obvious; pytest; existing repo conventions (no comments explaining WHAT, only WHY where non-obvious).

---

### Task 1: BASELINE title extraction (`app/distillation/title.py`)

**Files:**
- Create: `ingestion/app/distillation/__init__.py`
- Create: `ingestion/app/distillation/title.py`
- Test: `ingestion/tests/test_title.py`

**Interfaces:**
- Produces: `extract_baseline_title(text: str, max_length: int = 256) -> str` in `ingestion/app/distillation/title.py` — Task 3 (tree_builder wiring) and Task 4 (survey_title's defensive re-truncation) both import this by exact name.

**Boundary:** Only touch `ingestion/app/distillation/__init__.py`, `ingestion/app/distillation/title.py`, and this task's own test. Do not touch `tree_builder.py` or any other file yet — that's Task 3.

- [ ] **Step 1: Check for an existing venv, create one if absent**

Run: `cd ingestion && ls .venv 2>&1`
If absent: `python3.14 -m venv .venv && source .venv/bin/activate && pip install -e ".[dev]"` (use whatever Python 3.11+ interpreter is available if `python3.14` isn't present). If present, `source .venv/bin/activate`.

- [ ] **Step 2: Write the failing tests**

```python
# ingestion/tests/test_title.py
from app.distillation.title import extract_baseline_title


def test_returns_text_unchanged_when_under_the_limit() -> None:
    assert extract_baseline_title("Channel scan") == "Channel scan"


def test_strips_leading_and_trailing_whitespace() -> None:
    assert extract_baseline_title("  Channel scan  ") == "Channel scan"


def test_boundary_255_chars_unchanged() -> None:
    text = "A" * 255
    result = extract_baseline_title(text)
    assert result == text
    assert len(result) == 255


def test_boundary_exactly_256_chars_unchanged() -> None:
    text = "A" * 256
    result = extract_baseline_title(text)
    assert result == text
    assert len(result) == 256


def test_boundary_257_chars_truncated_to_256() -> None:
    text = "A" * 257
    result = extract_baseline_title(text)
    assert len(result) == 256


def test_truncates_at_last_word_boundary_when_one_exists_within_the_window() -> None:
    # "word " repeated so a whitespace boundary exists well before char 256;
    # the function must trim back to that boundary rather than hard-cutting
    # mid-word, and must never exceed max_length.
    text = ("word " * 60).strip()  # 299 chars, many boundaries before 256
    result = extract_baseline_title(text)
    assert len(result) <= 256
    assert not result.endswith("wor")  # not a mid-word hard cut
    assert text.startswith(result)  # result is a genuine prefix, not paraphrased


def test_hard_cuts_when_no_word_boundary_exists_in_window() -> None:
    # No whitespace anywhere — no boundary to trim to, must hard-cut at
    # exactly max_length. This exact case (a numbering-stripped run of "A"s)
    # matches the existing Phase 2 golden test in test_tree_builder.py, which
    # must keep passing unmodified after this function is wired in.
    text = "A" * 300
    result = extract_baseline_title(text)
    assert len(result) == 256


def test_never_summarizes_or_paraphrases_short_text() -> None:
    # BASELINE must extract, never summarize — the full sentence is used
    # verbatim as the title when it already fits within the limit.
    text = "The receiver shall scan all available channels within 10 seconds of power-on."
    assert extract_baseline_title(text) == text


def test_multibyte_codepoints_truncate_safely_without_corruption() -> None:
    # Python str slicing operates on Unicode codepoints, not bytes, so a
    # 300-codepoint emoji string truncates to exactly max_length codepoints
    # without raising or producing invalid output. Full extended-grapheme-
    # cluster awareness (e.g. not splitting an emoji+modifier sequence) is
    # explicitly out of scope for this phase.
    text = "\U0001f600" * 300  # 😀 repeated 300 times, no whitespace
    result = extract_baseline_title(text)
    assert len(result) == 256
    assert isinstance(result, str)


def test_multibyte_text_with_word_boundaries_trims_correctly() -> None:
    text = ("שלום " * 60).strip()  # Hebrew "hello" repeated, many boundaries
    result = extract_baseline_title(text)
    assert len(result) <= 256
    assert text.startswith(result)


def test_respects_a_custom_max_length() -> None:
    assert extract_baseline_title("Channel scan test", max_length=7) == "Channel"
```

- [ ] **Step 3: Run to verify failure**

Run: `pytest tests/test_title.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.distillation'`

- [ ] **Step 4: Implement**

```python
# ingestion/app/distillation/__init__.py
```

```python
# ingestion/app/distillation/title.py
from __future__ import annotations


def extract_baseline_title(text: str, max_length: int = 256) -> str:
    """BASELINE-mode title extraction: never summarizes or paraphrases, only
    extracts/truncates the existing verbatim text. If the (stripped) text
    already fits within max_length, it is returned unchanged. Otherwise,
    truncates at the last whitespace boundary at or before max_length so
    words aren't split mid-way; if no whitespace exists within the window
    (a single unbroken run of characters), hard-cuts at exactly max_length.

    Operates on Unicode codepoints (Python's native str semantics), so
    multi-codepoint content (e.g. emoji) truncates safely without raising or
    corrupting individual codepoints. Full extended-grapheme-cluster
    awareness (e.g. not splitting an emoji+skin-tone-modifier sequence) is
    out of scope."""
    stripped = text.strip()
    if len(stripped) <= max_length:
        return stripped

    window = stripped[:max_length]
    last_space = window.rfind(" ")
    if last_space == -1:
        return window
    return window[:last_space].rstrip()
```

- [ ] **Step 5: Run to verify it passes**

Run: `pytest tests/test_title.py -v`
Expected: PASS (11 tests)

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/distillation/__init__.py ingestion/app/distillation/title.py ingestion/tests/test_title.py
git commit -m "feat(ingestion): add BASELINE title extraction with word-boundary-aware truncation"
```

---

### Task 2: Description assembly (`app/distillation/description.py`)

**Files:**
- Create: `ingestion/app/distillation/description.py`
- Test: `ingestion/tests/test_description.py`

**Interfaces:**
- Produces: `assemble_description(existing: str, addition: str) -> str` in `ingestion/app/distillation/description.py` — Task 3 (tree_builder wiring) imports this by exact name.

**Boundary:** Only touch `ingestion/app/distillation/description.py` and this task's own test. Do not touch `tree_builder.py` yet.

- [ ] **Step 1: Write the failing tests**

```python
# ingestion/tests/test_description.py
from app.distillation.description import assemble_description


def test_joins_existing_and_addition_with_a_newline() -> None:
    assert assemble_description("First paragraph.", "Second paragraph.") == "First paragraph.\nSecond paragraph."


def test_preserves_text_verbatim_no_mutation_or_normalization() -> None:
    existing = "OPEN: confirm connector part number before release."
    addition = "  extra whitespace preserved  "
    result = assemble_description(existing, addition)
    assert result == "OPEN: confirm connector part number before release.\n  extra whitespace preserved  "


def test_does_not_mutate_the_input_strings() -> None:
    existing = "unchanged"
    addition = "also unchanged"
    assemble_description(existing, addition)
    assert existing == "unchanged"
    assert addition == "also unchanged"


def test_handles_empty_addition() -> None:
    assert assemble_description("existing", "") == "existing\n"


def test_multiple_sequential_assemblies_accumulate_in_order() -> None:
    result = assemble_description("first", "second")
    result = assemble_description(result, "third")
    assert result == "first\nsecond\nthird"
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_description.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.distillation.description'`

- [ ] **Step 3: Implement**

```python
# ingestion/app/distillation/description.py
from __future__ import annotations


def assemble_description(existing: str, addition: str) -> str:
    """BASELINE-mode description assembly: joins verbatim text with a
    newline, never mutating or normalizing either input. Str is immutable in
    Python, so 'no mutation' here just means the function is pure — it
    returns a new string, never alters existing/addition in place (which
    plain str concatenation already guarantees, but is worth stating
    explicitly since this mirrors the fidelity guarantees the redaction pass
    (Phase 1) and BASELINE hashing (Phase 4) both depend on)."""
    return existing + "\n" + addition
```

- [ ] **Step 4: Run to verify it passes**

Run: `pytest tests/test_description.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/distillation/description.py ingestion/tests/test_description.py
git commit -m "feat(ingestion): add pure description-assembly function for verbatim joining"
```

---

### Task 3: Wire Tasks 1-2 into `tree_builder.py` (BASELINE)

**Files:**
- Modify: `ingestion/app/leveling/tree_builder.py`
- Test: `ingestion/tests/test_tree_builder.py` (add new tests, do not remove/modify existing ones)

**Interfaces:**
- Consumes: `extract_baseline_title` from `app.distillation.title` (Task 1); `assemble_description` from `app.distillation.description` (Task 2).
- Modifies: `build_baseline_tree`'s internals only — its own signature `build_baseline_tree(doc: CanonicalDoc) -> WorkItemTree` is UNCHANGED, so no caller (Task 7's endpoint, Phase 2's existing tests) needs updating.

**Boundary:** Only touch `ingestion/app/leveling/tree_builder.py` and add NEW tests to `tests/test_tree_builder.py` — do not remove or modify any of Phase 2's existing tests in that file (they must keep passing unmodified, proving this wiring is a pure internal refactor).

- [ ] **Step 1: Run the existing tree_builder tests to confirm the CURRENT baseline (before touching anything)**

Run: `pytest tests/test_tree_builder.py -v`
Expected: PASS (6 tests — Phase 2's existing golden fixture tests, currently green against the naive placeholder logic)

- [ ] **Step 2: Write new failing tests proving the wiring (append to the existing test file)**

```python
# Add to ingestion/tests/test_tree_builder.py (append — do not touch existing tests above)

def test_long_unbroken_title_matches_extract_baseline_title_hard_cut_behavior() -> None:
    # Same fixture as the existing test_title_is_truncated_to_256_chars, but
    # asserting the actual word-boundary-aware algorithm is now in use (not
    # just a coincidentally-identical result from naive slicing).
    from app.distillation.title import extract_baseline_title

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
    expected = extract_baseline_title("A" * 300)
    assert tree.nodes[0].title == expected


def test_long_title_with_word_boundaries_is_trimmed_not_hard_cut() -> None:
    # A long block whose text has word boundaries before char 256 — proves
    # the new algorithm's boundary-aware behavior is actually wired in (the
    # OLD naive display_text.strip()[:256] slice would hard-cut mid-word
    # here; the new extract_baseline_title must not).
    long_sentence = ("The receiver shall support " + "channel " * 40).strip()
    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 " + long_sentence, source_ref=_sr("x.txt", 0, 10)),
        ],
    )
    tree = build_baseline_tree(doc)
    assert len(tree.nodes[0].title) <= 256
    assert not tree.nodes[0].title.endswith("chann")  # not a mid-word hard cut


def test_description_assembly_is_used_for_unleveled_block_folding() -> None:
    # ICD-style fixture already proves OPEN:/[FIGURE:] text lands in the
    # description (Phase 2's test_icd_style_branch_... test) — this test
    # additionally proves the exact newline-joined shape matches
    # assemble_description's contract precisely (not just "contains").
    from app.distillation.description import assemble_description

    icd_doc = _icd_style_doc()
    tree = build_baseline_tree(icd_doc)
    requirement_node = tree.nodes[1]
    expected = assemble_description(
        assemble_description("3.3V Rail Requirements", "OPEN: confirm connector part number before release."),
        "[FIGURE: none]",
    )
    assert requirement_node.description == expected
```

- [ ] **Step 3: Run to verify the new tests fail (old logic still in place) and existing tests still pass**

Run: `pytest tests/test_tree_builder.py -v`
Expected: the 3 new tests FAIL (old naive-slice/inline-concat logic doesn't match `extract_baseline_title`/`assemble_description`'s exact contract yet); the 6 existing tests still PASS.

- [ ] **Step 4: Wire the new modules into `tree_builder.py`**

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


def build_baseline_tree(doc: CanonicalDoc) -> WorkItemTree:
    """Deterministic BASELINE-mode leveling: no LLM involved. Splits the
    document into top-level branches, auto-detects a profile per branch
    (see autodetect.py), then walks each branch's blocks maintaining a
    depth stack to assign parent/child relationships. Unleveled blocks
    (plain paragraphs, list items, notes, OPEN/TBD markers, inline figure
    placeholders) extend the nearest currently-open node's description
    rather than becoming their own node.

    Title extraction (extract_baseline_title) and description assembly
    (assemble_description) are real, tested BASELINE-mode logic as of
    Phase 3 — never summarizes/paraphrases, only extracts/truncates and
    verbatim-joins.

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
                fidelity_hash=hashlib.sha256(display_text.encode()).hexdigest(),
                tags=[],
                mode=WorkItemMode.BASELINE,
            )
            nodes.append(node)
            nodes_by_id[local_id] = node
            stack.append((depth, local_id))

    return WorkItemTree(nodes=nodes)
```

- [ ] **Step 5: Run to verify all tests pass**

Run: `pytest tests/test_tree_builder.py -v`
Expected: PASS (9 tests — 6 existing Phase 2 tests unmodified and green, 3 new Phase 3 tests green)

- [ ] **Step 6: Run the full local suite**

Run: `pytest -v`
Expected: all Phase 1 + Phase 2 + this phase's tests pass, no regressions.

- [ ] **Step 7: Commit**

```bash
git add ingestion/app/leveling/tree_builder.py ingestion/tests/test_tree_builder.py
git commit -m "feat(ingestion): wire real title extraction and description assembly into BASELINE tree builder"
```

---

### Task 4: SURVEY-mode title distillation interface + fake client

**Files:**
- Create: `ingestion/app/distillation/survey_title.py`
- Test: `ingestion/tests/test_survey_title.py`

**Interfaces:**
- Consumes: `extract_baseline_title` from `app.distillation.title` (Task 1) — reused as the defensive re-truncation guard, NOT reimplemented.
- Produces: `TitleDistillationClient` (a `Protocol`) and `distill_survey_title(text: str, client: TitleDistillationClient, max_length: int = 256) -> str` in `ingestion/app/distillation/survey_title.py` — Task 5 (llm_leveling.py wiring) imports both by exact name.

**Boundary:** Only touch `ingestion/app/distillation/survey_title.py` and this task's own test. This task does NOT call any real LLM/HTTP endpoint — it proves the interface/wiring seam only, using a hand-written fake test double, matching Phase 2's `LlmLevelingClient`/`FakeLlmLevelingClient` pattern exactly. Do not modify `llm_leveling.py` yet — that's Task 5.

- [ ] **Step 1: Write the failing test**

```python
# ingestion/tests/test_survey_title.py
from app.distillation.survey_title import TitleDistillationClient, distill_survey_title


class FakeTitleDistillationClient:
    """Hand-written test double proving the TitleDistillationClient
    interface/wiring works end-to-end. No real Open WebUI call exists yet —
    the orchestrator's LLM redaction-proxy is separate, not-yet-built
    infrastructure (same scope boundary as llm_leveling.py's
    FakeLlmLevelingClient from Phase 2)."""

    def distill_title(self, text: str, max_length: int) -> str:
        assert max_length == 256
        return "Physical robustness"


class MisbehavingTitleDistillationClient:
    """Simulates an LLM that ignores the max_length instruction — proves
    distill_survey_title's defensive re-truncation actually protects the
    schema's title max_length=256 constraint regardless of client behavior."""

    def distill_title(self, text: str, max_length: int) -> str:
        return "A" * 500


def test_distill_survey_title_uses_the_injected_client() -> None:
    result = distill_survey_title("The unit shall survive a 1m drop onto concrete.", FakeTitleDistillationClient())
    assert result == "Physical robustness"


def test_distill_survey_title_enforces_max_length_even_if_client_ignores_it() -> None:
    result = distill_survey_title("some text", MisbehavingTitleDistillationClient())
    assert len(result) <= 256


def test_distill_survey_title_respects_a_custom_max_length() -> None:
    class ShortClient:
        def distill_title(self, text: str, max_length: int) -> str:
            assert max_length == 50
            return "A" * 100

    result = distill_survey_title("some text", ShortClient(), max_length=50)
    assert len(result) <= 50


def test_title_distillation_client_is_a_protocol_satisfied_by_the_fake() -> None:
    client: TitleDistillationClient = FakeTitleDistillationClient()
    result = client.distill_title("some text", 256)
    assert isinstance(result, str)
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_survey_title.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.distillation.survey_title'`

- [ ] **Step 3: Implement**

```python
# ingestion/app/distillation/survey_title.py
from __future__ import annotations

from typing import Protocol

from app.distillation.title import extract_baseline_title


class TitleDistillationClient(Protocol):
    """Interface for SURVEY-mode title distillation. No real implementation
    exists in this phase — the orchestrator's LLM redaction-proxy (which
    would host the actual Open WebUI/Ollama call) is separate, not-yet-built
    infrastructure. Matches the runtime prompt contract documented in
    docs/architecture.md: 'item text + 256 limit -> single-line title (first
    sentence if descriptive, else concise summary/paraphrase); enforce
    <=256.' Mirrors llm_leveling.py's LlmLevelingClient pattern (Phase 2)."""

    def distill_title(self, text: str, max_length: int) -> str: ...


def distill_survey_title(text: str, client: TitleDistillationClient, max_length: int = 256) -> str:
    """SURVEY-mode title distillation: delegates to the injected client (a
    real LLM chat call, once the orchestrator's redaction-proxy exists), then
    defensively re-truncates the result via extract_baseline_title. This
    guarantees the schema's title max_length constraint holds even if the
    client ignores the max_length it was given — never trust an external
    (eventually LLM-backed) response to self-enforce a hard limit."""
    distilled = client.distill_title(text, max_length)
    return extract_baseline_title(distilled, max_length)
```

- [ ] **Step 4: Run to verify it passes**

Run: `pytest tests/test_survey_title.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/distillation/survey_title.py ingestion/tests/test_survey_title.py
git commit -m "feat(ingestion): add injectable SURVEY title-distillation interface with fake-client test"
```

---

### Task 5: Wire Task 4 into `llm_leveling.py` (SURVEY)

**Files:**
- Modify: `ingestion/app/leveling/llm_leveling.py`
- Test: `ingestion/tests/test_llm_leveling.py` (add new tests, do not remove/modify existing ones)

**Interfaces:**
- Consumes: `TitleDistillationClient`, `distill_survey_title` from `app.distillation.survey_title` (Task 4).
- Modifies: `build_survey_tree`'s SIGNATURE changes — adds a new required parameter `title_client: TitleDistillationClient`. This is a breaking signature change to an existing Phase 2 function; the plan's existing test file's calls must be updated to pass a fake title client (Step 2 below handles this explicitly).

**Boundary:** Only touch `ingestion/app/leveling/llm_leveling.py` and `tests/test_llm_leveling.py`. Do not touch `tree_builder.py` (Task 3 already handled BASELINE) or `app/distillation/*` (Tasks 1-4 already built those).

- [ ] **Step 1: Run the existing llm_leveling tests to confirm the CURRENT baseline**

Run: `pytest tests/test_llm_leveling.py -v`
Expected: PASS (3 tests — Phase 2's existing tests, currently calling `build_survey_tree(doc, llm_client)` with 2 positional args)

- [ ] **Step 2: Update the existing tests' call sites for the new required parameter, and add new tests (full file replacement)**

```python
# ingestion/tests/test_llm_leveling.py (full file, replacing existing content)
from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.distillation.survey_title import TitleDistillationClient
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


class FakeTitleDistillationClient:
    """Hand-written test double for title distillation, matching Task 4's
    survey_title.py pattern — no real LLM call, proves wiring only."""

    def distill_title(self, text: str, max_length: int) -> str:
        if "Display" == text:
            return "Display"
        return "HDR support"


def test_build_survey_tree_uses_injected_llm_client() -> None:
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeTitleDistillationClient())
    assert len(tree.nodes) == 2
    assert tree.nodes[0].type == WorkItemType.FEATURE
    assert tree.nodes[0].parent_local_id is None
    assert tree.nodes[1].type == WorkItemType.REQUIREMENT
    assert tree.nodes[1].parent_local_id == "0"


def test_survey_tree_nodes_have_survey_mode_and_no_fidelity_hash() -> None:
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeTitleDistillationClient())
    for node in tree.nodes:
        assert node.mode == WorkItemMode.SURVEY
        assert node.fidelity_hash is None


def test_llm_leveling_client_is_a_protocol_satisfied_by_the_fake() -> None:
    client: LlmLevelingClient = FakeLlmLevelingClient()
    result = client.infer_hierarchy("Display\nThe display shall support HDR.", None)
    assert isinstance(result, list)


def test_build_survey_tree_uses_distilled_titles_not_raw_display_text() -> None:
    # Phase 2's placeholder set title = raw display_text; Phase 3 must use
    # the injected title_client's real (here: fake) distillation instead.
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeTitleDistillationClient())
    assert tree.nodes[0].title == "Display"
    assert tree.nodes[1].title == "HDR support"
    assert tree.nodes[1].title != "The display shall support HDR."


def test_build_survey_tree_title_client_is_a_protocol_satisfied_by_the_fake() -> None:
    client: TitleDistillationClient = FakeTitleDistillationClient()
    result = client.distill_title("Display", 256)
    assert isinstance(result, str)
```

- [ ] **Step 3: Run to verify failure**

Run: `pytest tests/test_llm_leveling.py -v`
Expected: FAIL — `TypeError: build_survey_tree() missing 1 required positional argument: 'title_client'` (the existing calls now pass 3 args, but `build_survey_tree` still only accepts 2)

- [ ] **Step 4: Wire the new module into `llm_leveling.py`**

```python
# ingestion/app/leveling/llm_leveling.py (full file, replacing existing content)
from __future__ import annotations

from typing import Protocol

from app.canonical.model import CanonicalDoc
from app.distillation.survey_title import TitleDistillationClient, distill_survey_title
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


def build_survey_tree(
    doc: CanonicalDoc, llm_client: LlmLevelingClient, title_client: TitleDistillationClient
) -> WorkItemTree:
    """SURVEY-mode leveling: node_id in the LLM's response corresponds to
    the block's index (as a string) in doc.blocks, in outline order. Title
    is real distilled text as of Phase 3 (via title_client + defensive
    re-truncation, see distillation/survey_title.py) — description remains
    the block's raw display_text for now; a later phase will formalize
    SURVEY-mode description into generative 'shall'-style requirement text
    (see docs/architecture.md Phase 5)."""
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
                title=distill_survey_title(display_text, title_client),
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

- [ ] **Step 5: Run to verify it passes**

Run: `pytest tests/test_llm_leveling.py -v`
Expected: PASS (6 tests)

- [ ] **Step 6: Check for and update any OTHER caller of `build_survey_tree`**

Run: `grep -rn "build_survey_tree" ingestion/app ingestion/tests --include="*.py"`
Expected: only `llm_leveling.py` (definition) and `test_llm_leveling.py` (calls) — no FastAPI endpoint or other module calls this yet (Phase 2 never wired a `/survey` endpoint, only `/level` for BASELINE). If the grep finds an unexpected caller, update its call site to pass a `title_client` argument and report this in your task report — do not silently skip it.

- [ ] **Step 7: Run the full local suite**

Run: `pytest -v`
Expected: all Phase 1 + Phase 2 + this phase's tests pass, no regressions.

- [ ] **Step 8: Commit**

```bash
git add ingestion/app/leveling/llm_leveling.py ingestion/tests/test_llm_leveling.py
git commit -m "feat(ingestion): wire real title distillation into SURVEY tree builder"
```

---

## Self-Review Notes

- **Spec coverage:** Phase 3's DoD ("255/256/257 + multibyte tests; BASELINE title = extracted substring; description verbatim") is covered exactly by Task 1's boundary/multibyte tests and Task 3's wiring-proof tests. The "LLM: Chat (SURVEY only)" phase-table column is honored as an interface-and-stub (consistent with the user's explicit decision this session to keep the redaction-proxy security boundary intact rather than build a real client early) — not a real chat call.
- **Known, deliberate limitation (not a gap):** `extract_baseline_title`'s multibyte handling is codepoint-safe (Python's native str semantics) but NOT extended-grapheme-cluster-safe (could theoretically split an emoji+modifier sequence or a Hebrew base+combining-diacritic pair at a truncation boundary). This is stated explicitly in the module's docstring and the plan's Global Constraints — full grapheme-cluster awareness would need a library like `regex` or ICU bindings, out of scope for this phase's DoD.
- **Breaking change, deliberately scoped:** Task 5 changes `build_survey_tree`'s signature (adds required `title_client` param). This is a clean, contained breaking change since Phase 2 never wired `build_survey_tree` into any FastAPI endpoint — only its own test file calls it, and that test file is updated in the same task. Step 6 of Task 5 explicitly checks for any other caller to avoid silently missing one.
- **Type consistency:** `extract_baseline_title(text: str, max_length: int = 256) -> str` (Task 1) is called identically by `tree_builder.py` (Task 3, default max_length) and `survey_title.py` (Task 4, explicit max_length passthrough) — same signature, same semantics. `TitleDistillationClient.distill_title(self, text: str, max_length: int) -> str` (Task 4) matches `LlmLevelingClient.infer_hierarchy`'s Protocol pattern exactly (Phase 2 precedent), and `build_survey_tree`'s new `title_client: TitleDistillationClient` parameter (Task 5) is the same type Task 4 defines — no drift.
- **No placeholders:** every step contains complete, runnable code. The "later phase will formalize SURVEY-mode description" docstring note in `llm_leveling.py` is a forward-looking scope statement (matching Phase 2's own precedent of documenting what's NOT yet built), not a TBD/TODO inside working code.
