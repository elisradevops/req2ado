# ingestion/app/leveling/heading_outline.py
"""Detects the document's own real heading outline and the Epic/Feature/
Requirement type each heading should become, so SURVEY mode's skeleton
stage can be told this directly instead of leaving it entirely to the
model's own qualitative scope test, which this codebase has repeatedly
found does not reliably track heading depth on its own (see
orchestrator_llm_client._whole_document_hint's own docstring).

Full live-bug history, rejected approaches, and before/after verification
for every rule below: docs/handoff-heading-tier-detector-and-customer-id-fixes.md.

**No absolute heading level is ever used.** Word's literal "Heading 1"/
"Heading 2" numbers do not reliably map to Epic/Feature tiers -- a
document's own top tier can start at any level, and PDF's font-size-rank
heading_level fallback (pdf_loader.py, Tier 2) is document-relative by
construction (it ranks only the distinct sizes observed in that one
document), not comparable across documents or guaranteed to align with a
DOCX Heading-1 style. Every rule below therefore compares heading levels
only RELATIVE to each other, within one document's own observed level
set -- the same principle tree_builder._split_into_branches's
`top_level_depth = min(known_depths)` and depth.resolve_block_depth
already rely on elsewhere in this codebase.

**Typing reuses `id_hierarchy.classify_by_nesting` (the same bottom-up,
tree-shape-derived ladder `rows_from_heading_structure` already uses for
convention 3), unmodified.** That function's own leaf rule -- a leaf
heading has no non-override children, so it becomes a Requirement -- is
right when a leaf heading's own text IS the requirement statement, but
wrong when a heading is a pure grouping label with the real requirements
living below it (a table's rows, or LLM-authored content later). Both
shapes occur in real documents and can't be told apart by heading level
alone.

The two shapes are reconciled as DATA, not as two competing algorithms:
for a leaf heading with real obligation content directly below it (>= 2
distinct requirement-shaped table rows or paragraphs in its own span --
see `_obligation_count`), a synthetic "phantom child" one level deeper is
added before classification. `classify_by_nesting` then resolves that
leaf to Feature (it now has a Requirement-tier child) and its own parent
to Epic, mirroring the section_skeleton prompt's own stated convention
("a table of N identified rows under one heading is N Requirement nodes
-- normally plus one Feature node for the heading that groups them",
section_skeleton.v1.txt). A leaf with 0-1 obligations keeps convention
3's original behavior: its own text IS the requirement, so it stays a
Requirement, and gets no hint (Phase 1 -- see below). The threshold of 2
mirrors this codebase's own existing container rule
(`id_hierarchy.MIN_CHILDREN_TO_QUALIFY`) -- a single obligation under a
heading means the heading simply IS that one requirement, not a container
for several.

**Phase 1 (current): only Epic/Feature-typed headings are ever surfaced to
the model.** A Requirement-typed heading is computed here and returned
honestly, but the caller (orchestrator_llm_client._heading_outline_hint)
drops it before naming anything -- deliberate, not an oversight: there is
no live evidence today that any document reaching this hint (as opposed
to being claimed deterministically first) needs every Requirement-typed
heading individually named. The model still sees every heading's own text
rendered in its section (`render_section`), so it isn't blind to unhinted
headings -- it simply falls back to its own judgment for them, same as
before this module existed.

A heading with a genuinely EMPTY span (no table, no paragraph, no deeper
heading before the next same-or-shallower heading) is typed Requirement by
the same ladder (a true leaf with nothing under it) and, since Requirement
entries aren't named in Phase 1, is simply never surfaced.

**Title/wrapper suppression (S1/S2 below).** docx_loader.py's own
`_heading_level_for_paragraph` maps Word's built-in "Title" style to
heading_level=1, indistinguishable from a real Heading 1 -- `Block` itself
carries no separate style-name signal after loading (deferred: a
cross-service schema change with no current need). Two structural tells
handle the two ways a Title's "children" can look like a real section's:
- S1: the Title is followed by short metadata paragraphs before the
  document's real first heading -- its span has content, but no table and
  no deeper heading. A real top-tier section in this document convention
  always nests at least one deeper heading or table; a bare document
  title never does.
- S2: no OTHER heading exists at the Title's own (shallowest) level at
  all -- every other heading in the document is deeper than it, so S1
  alone fails (the Title's span extends to the end of the document and
  legitimately contains tables and deeper headings). Confirmed live
  defect this rule exists to prevent: without it, the Title gets named as
  its own Epic, producing one Epic that wraps the entire document.
Neither rule is a tree edit -- classify_by_nesting's types don't depend on
suppression (bottom-up types never depend on an ancestor), so excluding an
entry from the OUTPUT cannot change any other entry's computed type.

**Deliberately not handled here: inventing an Epic tier for a flat,
single-level document** (every real heading sits at the exact same level,
with no grouping tier above it at all). This module emits Feature hints
only for that shape and zero Epic hints -- see
`root_regrouping._ensure_root_features_have_epic_parent`'s own docstring
for why a uniformly Feature-topped tree is an explicitly legitimate,
already-tested shape, and `_regroup_disconnected_roots` for the
purpose-built LLM pass that decides, from ALL root titles at once,
whether a topical Epic grouping is actually warranted -- a strictly
better-informed place for that judgment than this per-heading detector."""
from __future__ import annotations

from typing import NamedTuple

from app.canonical.model import Block, BlockKind, Table, plain_text_rows
from app.leveling.id_hierarchy import classify_by_nesting, is_requirement_shaped
from app.leveling.requirement_rows import qualifying_requirement_rows
from app.leveling.tree_builder import _order_key

# See module docstring's "typing reuses classify_by_nesting" section.
MIN_CHILD_OBLIGATIONS_FOR_CONTAINER = 2


class HeadingOutlineEntry(NamedTuple):
    block_id: str
    title: str
    suggested_type: str  # "Epic" | "Feature" | "Requirement" -- see module docstring, Phase 1
    level: int  # this heading's own source heading_level -- diagnostics/tests ONLY,
    # never compared across documents or loaders (see module docstring)


class _MergedEntry(NamedTuple):
    order_key: tuple[int, int]
    block: Block | None  # None for a table entry
    table: Table | None  # None for a block entry


def _merged_entries(blocks: list[Block], tables: list[Table] | None) -> list[_MergedEntry]:
    entries = [_MergedEntry(_order_key(b.source_ref), b, None) for b in blocks]
    entries.extend(_MergedEntry(_order_key(t.source_ref), None, t) for t in (tables or []))
    entries.sort(key=lambda e: e.order_key)
    return entries


def _is_heading_candidate(entry: _MergedEntry) -> bool:
    return entry.block is not None and entry.block.kind == BlockKind.HEADING and entry.block.heading_level is not None


def _obligation_count(span: list[_MergedEntry]) -> int:
    """How many separately-identifiable obligations sit in this span --
    see module docstring's "typing reuses classify_by_nesting" section for
    why this, not "any content at all", is the phantom-child trigger. A
    table with its own qualifying id column (requirement_rows.py) counts
    each such row; a table with no id column falls back to counting
    requirement-shaped rows by their own longest cell (a values/spec table
    correctly contributes 0 here); a non-table, non-heading block counts
    once if its own text is requirement-shaped. Never raises."""
    count = 0
    for entry in span:
        if entry.table is not None:
            id_rows = qualifying_requirement_rows([entry.table])
            if id_rows:
                count += len(id_rows)
                continue
            for row in plain_text_rows(entry.table):
                non_empty = [cell.strip() for cell in row if cell.strip()]
                if not non_empty:
                    continue
                if is_requirement_shaped(max(non_empty, key=len)):
                    count += 1
        elif entry.block is not None and entry.block.kind != BlockKind.HEADING:
            if is_requirement_shaped(entry.block.text):
                count += 1
    return count


def heading_outline_entries(blocks: list[Block] | None, tables: list[Table] | None = None) -> list[HeadingOutlineEntry]:
    """Every real heading in `blocks`, typed Epic/Feature/Requirement from
    its own document's observed nesting shape (see module docstring), minus
    a suppressed Title/wrapper heading (S1/S2) and a blank-text heading
    (S3). Never raises; `[]` for `None`/empty `blocks`, or a section with
    no heading at all."""
    if not blocks:
        return []
    merged = _merged_entries(blocks, tables)
    candidate_positions = [i for i, e in enumerate(merged) if _is_heading_candidate(e)]
    if not candidate_positions:
        return []

    levels = [merged[i].block.heading_level for i in candidate_positions]  # type: ignore[union-attr]

    # Heading-only leaf detection -- mirrors rows_from_heading_structure's
    # own stack walk exactly: a candidate is a leaf iff no OTHER heading
    # candidate nests immediately under it (tables/paragraphs never affect
    # this -- they're accounted for separately, via _obligation_count).
    is_leaf = [True] * len(candidate_positions)
    stack: list[int] = []
    for pos, level in enumerate(levels):
        while stack and levels[stack[-1]] >= level:
            stack.pop()
        if stack:
            is_leaf[stack[-1]] = False
        stack.append(pos)

    def _span(pos: int) -> list[_MergedEntry]:
        start = candidate_positions[pos] + 1
        end = len(merged)
        for later in range(pos + 1, len(candidate_positions)):
            if levels[later] <= levels[pos]:
                end = candidate_positions[later]
                break
        return merged[start:end]

    items: list[tuple[tuple[str, int], int, bool]] = []
    for pos, level in enumerate(levels):
        items.append((("h", pos), level, False))
        if is_leaf[pos] and _obligation_count(_span(pos)) >= MIN_CHILD_OBLIGATIONS_FOR_CONTAINER:
            # Phantom child one level deeper -- see module docstring. Never
            # itself emitted; dropped immediately after classification.
            items.append((("p", pos), level + 1, False))
    types_by_key = classify_by_nesting(items)

    min_level = min(levels)
    at_min_level = sum(1 for level in levels if level == min_level)

    def _is_suppressed(pos: int) -> bool:
        # Both S1 and S2 only make sense when there is at least one OTHER
        # heading in this unit -- their whole premise is "the real content
        # is in a section that comes after this one", which is meaningless
        # for the unit's only heading (a genuine AirPro-shaped leaf whose
        # own text is the complete requirement, with nothing else in the
        # document, must never be suppressed).
        if levels[pos] != min_level or len(levels) < 2:
            return False
        span = _span(pos)
        s1 = pos == 0 and not any(
            e.table is not None or (e.block is not None and e.block.kind == BlockKind.HEADING) for e in span
        )
        s2 = pos == 0 and at_min_level == 1 and all(levels[p] > levels[pos] for p in range(1, len(levels)))
        return s1 or s2

    entries: list[HeadingOutlineEntry] = []
    for pos in range(len(candidate_positions)):
        if _is_suppressed(pos):
            continue
        block = merged[candidate_positions[pos]].block
        assert block is not None  # candidate_positions only ever indexes heading blocks
        title = block.text.strip()
        if not title:
            continue
        suggested_type = types_by_key[("h", pos)][0].value
        entries.append(HeadingOutlineEntry(block_id=block.id, title=title, suggested_type=suggested_type, level=levels[pos]))
    return entries


def entries_for_blocks(entries: list[HeadingOutlineEntry] | None, blocks: list[Block] | None) -> list[HeadingOutlineEntry]:
    """Filters a document-wide `heading_outline_entries` result down to
    just the entries whose block is a member of `blocks`, preserving
    order -- see llm_leveling.build_survey_tree's own call sites for why
    this outline must be computed ONCE over the whole document and then
    filtered per branch, never recomputed per branch. `classify_by_nesting`
    itself is subset-invariant (a node's type depends only on its own
    descendants, never its ancestors or siblings), so recomputing from a
    branch's own block subset would NOT retype anything wrong on its own
    -- the real risk is S1/S2 above: a branch that isolates one Epic's
    entire subtree makes that Epic look, from inside the branch alone,
    exactly like S2's "lone top-tier heading, everything else deeper"
    shape, and get wrongly suppressed as a possible Title even though the
    full document has other siblings at that same level."""
    if not entries or not blocks:
        return []
    member_ids = {b.id for b in blocks}
    return [entry for entry in entries if entry.block_id in member_ids]
