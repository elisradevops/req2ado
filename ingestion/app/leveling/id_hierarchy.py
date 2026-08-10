# ingestion/app/leveling/id_hierarchy.py
"""Shared primitives for detecting a document's own deterministic Epic/
Feature/Requirement hierarchy from THREE possible source conventions:

1. A 2-column `Requirement ID | Text` table with a dotted numeric ID
   (see `rows_from_table` -- the original convention, formerly the whole
   of `table_groups.py`).
2. A native Word Heading hierarchy where the document's own author typed a
   dotted numeric ID directly into the heading text (see
   `rows_from_id_headings` in a later phase).
3. A native Word Heading hierarchy with NO id text at all -- structure
   comes purely from heading_level + document order (see
   `rows_from_heading_structure` in a later phase). Confirmed live: a real
   ICD-style document (AirPro) renders "3.2.1"-style numbers via Word's
   own auto-numbering (linked through the Heading style to
   `word/numbering.xml`), but those numbers never exist as literal text in
   the document -- so an ID-text detector finds nothing there. Structural
   nesting is the only signal available for this convention.

`qualifying_groups` is the CORE algorithm shared by conventions 1 and 2
(confirmed empirically source-agnostic -- feeding the same content through
either adapter into this one function produces identical
TableGroupInfo-equivalent output, field for field). Convention 3 has its
own typing policy (`classify_by_nesting`, factored from
`autodetect.classify_numbering_branch`) since it has no ID shape to derive
`suggested_type` from -- only real, directly-observable child nesting.

Every function here is a graceful no-op ([] / None) for input that doesn't
match its own convention -- see each function's own docstring for its
specific gates. Under-triggering (missing a real hierarchy) is the
accepted failure direction everywhere in this module, never
over-triggering (inventing structure that isn't there).
"""
from __future__ import annotations

import re
from collections.abc import Hashable
from typing import NamedTuple, TypeVar

from app.canonical.model import Block, BlockKind, SourceRef
from app.leveling.numbering import parse_numbering
from app.workitem.model import IntegrityWarning, WarningKind, WorkItemType

_K = TypeVar("_K", bound=Hashable)

# Dotted numeric ID, optionally with a single trailing ".letter" segment
# (some documents sub-letter a leaf as its own dotted segment, e.g.
# "1.2.2.4.a" -- confirmed live, NOT "1.2.2.4a" with no dot). Anchored
# full-match -- a literal header cell/heading ("Requirement ID" / "No.")
# simply never matches this, which is how such rows are excluded
# generically, by shape, never by matching their literal wording.
ID_PATTERN = re.compile(r"^\d+(?:\.\d+)*(?:\.[a-z])?$", re.IGNORECASE)

# Placeholder base for a sub-lettered final segment ("a" -> 1000, "b" ->
# 1001, ...) converted to an int purely so it can sit in the same
# tuple[int, ...] segments type as real numeric parts -- its exact value
# never matters for child-counting (only whether segments[:-1] collides
# with another row's segments), just that it's a stable, distinct int per
# letter and can never collide with a real numeric segment (documents in
# practice never have 1000+ sub-items at one level).
LETTER_SEGMENT_BASE = 1000

SHALL_PATTERN = re.compile(r"\bshall\b", re.IGNORECASE)

# A table/heading-outline must have at least this many ID-shaped rows,
# AND ID-shaped rows must be at least this fraction of all rows in that
# same bounded container, before it's treated as using this convention at
# all. Arbitrary but necessary gate to avoid false-positiving on an
# unrelated 2-column table (or an ordinarily-headed document) that
# coincidentally has one cell/heading that looks like a dotted ID (e.g. a
# version number "3.2") among mostly non-ID content. The denominator is
# source-specific -- see each adapter's own docstring.
MIN_ID_ROWS = 2
MIN_ID_ROW_FRACTION = 0.5

# A group must have at least this many DIRECT children to qualify --
# matches the already-shipped _SECTION_ANALYSIS_SYSTEM_PROMPT instruction
# ("that group has TWO OR MORE child items"); a group with 0-1 children is
# deliberately NOT counted (it's fine for it to stay flattened). Exception:
# a group with exactly ONE child still qualifies when that lone child is
# ITSELF a further-split group (not a leaf) -- confirmed live against a
# real reference structure ("System Description and Information" has only
# one child, "About Screen and Software Version", which itself splits
# further, and the reference still treats it as its own Epic-level domain).
# A lone LEAF child never qualifies on its own -- only lone GROUP children
# do. Applies to conventions 1 and 2 only -- a real Word heading is, by
# construction, a section the document's own author created, so convention
# 3 has no analogous filter (every candidate heading produces a node; see
# `rows_from_heading_structure`'s own docstring, measured: 36 lone-child
# groups on a real 682-block document, all real sections).
MIN_CHILDREN_TO_QUALIFY = 2

# Convention 3's gate (see `rows_from_heading_structure`): there is no ID
# shape to check, so qualification is instead about whether the heading
# outline's own LEAF content is itself requirement-shaped. Measured
# separation on real documents, not an assumed number: a genuine ICD-style
# document measured 0.51 (218/428) leaf headings containing "shall"; two
# unrelated headed documents (a golden BASELINE fixture and a generic
# sample) both measured 0.00. 0.25 sits mid-gap with 2x margin above the
# positive cluster and unbounded margin below the negative one -- not a
# round number chosen first, the midpoint of measured evidence. The
# absolute floor of 5 exists to reject a degenerate small document (e.g.
# 4 headings, 1 shall = 0.25) where the fraction alone would pass on
# coincidence; on every real document measured it is not load-bearing
# (218 and 38 respectively), so it's a floor, not a target.
MIN_SHALL_LEAF_FRACTION = 0.25
MIN_SHALL_LEAF_COUNT = 5

# Per-ROOT-SUBTREE gate (see rows_from_heading_structure's own docstring)
# -- replaces a single whole-document average with a check scoped to each
# top-level heading's own subtree. Confirmed real gap on a live document
# (AirPro): the whole-document average (0.51) passed the gate above, but
# that average blended genuinely prose subtrees with genuinely fragment/
# spec-table subtrees (e.g. slot-profile tables authored as headings) --
# 48% of the resulting "Requirements" had no requirement-shaped content at
# all. A subtree at or above this fraction keeps the deterministic fast
# path; one below it keeps the deterministic STRUCTURE but its leaf TEXT
# is routed to synthesis instead of emitted verbatim (see this module's
# caller, llm_leveling._detect_deterministic_subtrees).
MIN_REQUIREMENT_SHAPED_LEAF_FRACTION = 0.7

# Word count alone is insufficient -- a spec-table line like "Zodiac: 3.3V
# 494uF, 12V 352uF" is 6+ words but still not a requirement. A genuine
# modal/descriptive verb must also be present, AND the text must not be a
# bare "Label: value" cell (colon near the start, no requirement shape) or
# a trailing-colon section label with nothing else ("Voltage Distribution:").
_REQUIREMENT_SHAPE_MIN_WORDS = 6
_REQUIREMENT_SHAPE_MODAL_PATTERN = re.compile(
    r"\b(shall|should|must|will|is|are|provides|supports|complies)\b", re.IGNORECASE,
)
# A short label followed by a colon then a value, e.g. "Size: 3U 1\"" or
# "Zodiac: 3.3V 494uF" -- deliberately generous (up to 40 chars before the
# colon) since a real requirement sentence essentially never opens with a
# 1-4-word label immediately followed by ": value".
_SPEC_CELL_LABEL_PATTERN = re.compile(r"^[^:]{1,40}:\s*\S")


def _is_requirement_shaped(text: str) -> bool:
    """Per-leaf predicate backing MIN_REQUIREMENT_SHAPED_LEAF_FRACTION (see
    its own docstring for the real fragment-vs-prose gap this closes).
    Deliberately conservative (false negatives -- real short prose
    misclassified as a fragment -- degrade gracefully into synthesis
    rather than being lost; see the caller's own routing)."""
    stripped = text.strip()
    if len(stripped.split()) < _REQUIREMENT_SHAPE_MIN_WORDS:
        return False
    if stripped.endswith(":"):
        return False
    if _SPEC_CELL_LABEL_PATTERN.match(stripped):
        return False
    return bool(_REQUIREMENT_SHAPE_MODAL_PATTERN.search(stripped))

EPIC = "Epic"
FEATURE = "Feature"
REQUIREMENT = "Requirement"

# A literal "SUB-" marker prefix -- one of two textual spellings (the other
# being a lettered numbering suffix, e.g. "...4.a") this codebase uses for
# "this repeats its parent's tier rather than advancing" (see
# `classify_by_nesting`'s own docstring). Shared here (not left private to
# autodetect.py) so convention 3's structural heading detector can reuse
# the identical override signal on plain heading text.
SUB_MARKER_PATTERN = re.compile(r"^SUB-\s*[-–—]?\s*")


def strip_sub_marker(text: str) -> tuple[bool, str]:
    match = SUB_MARKER_PATTERN.match(text)
    if match:
        return True, text[match.end() :]
    return False, text


class TableGroupInfo(NamedTuple):
    label: str
    child_count: int
    id_text: str
    suggested_type: str  # one of EPIC, FEATURE, REQUIREMENT
    # True when this group's own ID is a single segment (e.g. "1", not
    # "1.1") -- i.e. it has no parent row in the table's own ID hierarchy,
    # confirmed live as the concrete signal for "this is an independent
    # top-level domain" (e.g. "Television Receiver" / "Remote Control" in a
    # real document, each its own root Epic with no common ancestor).
    is_top_level: bool = False
    # The label of THIS group's own parent row, when that parent row is
    # ITSELF a qualifying group (None when this group is_top_level, or when
    # its parent row exists but didn't qualify as a group in its own
    # right -- e.g. a parent with only one leaf child). This is the real,
    # deterministic parent/child fact already implicit in the source's own
    # ID hierarchy -- see llm_leveling._repair_group_attachment's docstring
    # for why this is surfaced as a POST-HOC REPAIR input rather than
    # threaded into the generation prompt as more text: a confirmed live
    # regression (see orchestrator_llm_client._root_count_clause's
    # docstring) showed that adding MORE prompt emphasis for one structural
    # fact can silently starve the model's attention elsewhere.
    parent_label: str | None = None


class HierarchyRow(NamedTuple):
    """One node-worthy (or fold-worthy) row/heading from ANY of the three
    source conventions, after that source's own adapter has fully resolved
    its hierarchy and typing -- the shared construction core
    (`id_tree_builder.build_hierarchy_subtree`) does no hierarchy or typing
    logic of its own, it only ever consumes this already-resolved shape.
    This is what keeps "one builder, three sources" literally true instead
    of aspirational: each adapter's job ends exactly at producing a
    correct `list[HierarchyRow]`."""
    label: str  # ID-stripped text (or the group's own label) -- becomes description/title source
    has_shall: bool
    source_ref: SourceRef
    # One of EPIC, FEATURE, REQUIREMENT if this row should become its own
    # node, or None if it should FOLD into the nearest node-producing
    # ancestor's description instead (id_tree_builder's job, not the
    # adapter's -- the adapter only decides WHETHER to fold, via the same
    # qualifying_groups-or-has_shall rule table_groups.py always used).
    # Convention 3 (structural headings) never sets this to None: every
    # real Word heading the author created becomes its own node, per that
    # adapter's own docstring.
    node_type: str | None
    parent_index: int | None  # index into the SAME list this row came from; None = root
    id_text: str  # load-bearing for conventions 1/2 (real doc ID); cosmetic for convention 3
    # True only for convention 1 (table rows): every row from one Table
    # shares that Table's single source_ref, so identity_hash needs the
    # row's own id_text folded in to avoid collision. Conventions 2/3 get
    # a real per-block source_ref and don't need this (see
    # id_tree_builder._hash_identity_for_row's own docstring).
    id_disambiguator_needed: bool = False
    # True for a LEAF row whose text failed the per-root-subtree
    # requirement-shaped gate (see MIN_REQUIREMENT_SHAPED_LEAF_FRACTION,
    # convention 3 only -- conventions 1/2 don't set this) -- signals the
    # caller (id_tree_builder.build_hierarchy_subtree) that this node's
    # `description` is real, source-derived text but should NOT be treated
    # as finished requirement prose without a synthesis pass.
    needs_synthesis: bool = False


def is_letter_segment(segment: int) -> bool:
    return segment >= LETTER_SEGMENT_BASE


def parse_id_segments(id_cell: str) -> tuple[int, ...] | None:
    """Parses a dotted numeric ID (optionally with one trailing letter
    segment) into a tuple of ints, or None if it isn't ID_PATTERN-shaped or
    is malformed despite matching (shouldn't normally happen -- defensive,
    not raised)."""
    id_cell = id_cell.strip()
    if not ID_PATTERN.match(id_cell):
        return None
    segments_list: list[int] = []
    try:
        for part in id_cell.split("."):
            if part.isalpha():
                # A sub-lettered final segment (e.g. the "a" in
                # "1.2.2.4.a") -- converted to a placeholder int so
                # "1.2.2.4.a" and "1.2.2.4.b" both correctly compute
                # parent=(1,2,2,4) via segments[:-1], same as any other
                # multi-part ID, without needing separate letter-vs-digit
                # handling downstream.
                segments_list.append(LETTER_SEGMENT_BASE + (ord(part.lower()) - ord("a")))
            else:
                segments_list.append(int(part))
    except ValueError:
        return None
    return tuple(segments_list)


def id_text_from_segments(segments: tuple[int, ...]) -> str:
    return ".".join(
        chr(ord("a") + (s - LETTER_SEGMENT_BASE)) if is_letter_segment(s) else str(s)
        for s in segments
    )


def qualifying_groups(parsed: list[tuple[tuple[int, ...], str]]) -> list[TableGroupInfo]:
    """The core group-detection/typing algorithm, shared by conventions 1
    (table rows) and 2 (ID-bearing headings) -- confirmed empirically
    source-agnostic: feeding the same real document's content through
    either adapter into this function produces IDENTICAL output, field for
    field (labels, child_count, id_text, suggested_type, is_top_level,
    parent_label), including the group-of-groups -> Epic and
    all-lettered-children -> Requirement determinations.

    `parsed` is already-scoped (one table's rows, or one document's ID-
    bearing headings) -- IDs from two unrelated sources are never mixed in
    one call; the caller (rows_from_table / rows_from_id_headings) is
    responsible for that scoping. Returns [] for an empty/malformed input;
    this function does NOT itself apply the MIN_ID_ROWS/MIN_ID_ROW_FRACTION
    gate -- that's the caller's job (the denominator differs per source,
    see each adapter's own docstring)."""
    if not parsed:
        return []

    children_by_parent: dict[tuple[int, ...], list[tuple[int, ...]]] = {}
    for segments, _label in parsed:
        if len(segments) > 1:
            parent = segments[:-1]
            children_by_parent.setdefault(parent, []).append(segments)

    shall_rows = {segments for segments, label in parsed if SHALL_PATTERN.search(label)}

    def _is_leaf(segments: tuple[int, ...]) -> bool:
        # A row with no children of its own is structurally a leaf
        # regardless of whether it happens to contain "shall" -- used only
        # for the group-of-groups/Epic determination below, not for the
        # leaf/group-candidate exclusion above (that stays "shall"-based,
        # per this module's own documented heuristic).
        return segments not in children_by_parent

    # Two-pass: a group's parent row can appear anywhere else in the
    # source (in practice always earlier, numeric IDs being what they are,
    # but this doesn't rely on that) -- so `parent_label` can only be
    # resolved once every row's own qualification is known, which isn't
    # decided until the single loop below finishes. First pass builds
    # every qualifying entry; second pass patches in `parent_label` by
    # looking up each entry's own parent segments against the now-complete
    # qualifying set.
    entries: list[tuple[tuple[int, ...], TableGroupInfo]] = []

    for segments, label in parsed:
        if segments in shall_rows:
            continue  # a leaf requirement row, not a group candidate
        children = children_by_parent.get(segments, [])
        child_count = len(children)
        qualifies = child_count >= MIN_CHILDREN_TO_QUALIFY or (
            child_count == 1 and not _is_leaf(children[0])
        )
        if not qualifies:
            continue

        if children and all(not _is_leaf(child) for child in children):
            # Group-of-groups: every direct child is itself further
            # split -- a large functional domain, not a flat list of
            # requirements. Nested Epic, per the reference structure.
            suggested_type = EPIC
        elif children and all(is_letter_segment(child[-1]) for child in children):
            # Every direct child is a lettered sub-ID (e.g. "...4.a",
            # "...4.b") -- the reference document's own convention for a
            # general requirement's exceptions/conditions, not distinct
            # sub-topics. Parent Requirement, not a Feature.
            suggested_type = REQUIREMENT
        else:
            suggested_type = FEATURE

        entries.append((
            segments,
            TableGroupInfo(
                label=label, child_count=child_count,
                id_text=id_text_from_segments(segments), suggested_type=suggested_type,
                is_top_level=len(segments) == 1,
            ),
        ))

    qualifying_label_by_segments = {segments: entry.label for segments, entry in entries}
    results: list[TableGroupInfo] = []
    for segments, entry in entries:
        parent_segments = segments[:-1] if len(segments) > 1 else None
        parent_label = (
            qualifying_label_by_segments.get(parent_segments) if parent_segments else None
        )
        results.append(entry._replace(parent_label=parent_label) if parent_label else entry)
    return results


def _parse_id_hierarchy_table_rows(rows: list[list[str]]) -> list[tuple[tuple[int, ...], str]]:
    """Returns (id_segments, label) for every row that fits the dotted-ID
    convention. Returns [] entirely (not a partial list) if the table
    isn't strictly 2 columns per row, or doesn't clear the ID-row
    qualification gate -- a table either uses this convention or it
    doesn't; there is no "half-parsed" state."""
    if not rows or any(len(row) != 2 for row in rows):
        return []

    parsed: list[tuple[tuple[int, ...], str]] = []
    for id_cell, text_cell in rows:
        segments = parse_id_segments(id_cell)
        if segments is None:
            continue  # not ID-shaped -- this is how a literal header row
            # ("Requirement ID" / "No.") gets excluded generically, by
            # shape, never by matching its literal wording.
        parsed.append((segments, text_cell.strip()))

    if len(parsed) < MIN_ID_ROWS or len(parsed) < len(rows) * MIN_ID_ROW_FRACTION:
        return []
    return parsed


def parsed_id_rows_from_table(table) -> list[tuple[tuple[int, ...], str]]:
    """Public wrapper over the table-row parse -- returns [] gracefully
    for a non-conforming table (wrong column count, insufficient ID-shaped
    rows). Used both by `table_groups.qualifying_table_groups` (the
    existing LLM-hint/repair consumer) and by the new deterministic
    builder path."""
    return _parse_id_hierarchy_table_rows(table.rows)


def _resolve_hierarchy_rows(
    parsed: list[tuple[tuple[int, ...], str]],
    source_refs: list[SourceRef],
    id_disambiguator_needed: bool,
) -> list[HierarchyRow]:
    """Shared resolver for conventions 1 (table rows) and 2 (ID-bearing
    headings): given already-gated, already-ID-parsed `parsed` rows (one
    per `source_refs` entry, same order), decides per row whether it
    produces its own node (a qualifying group, per `qualifying_groups` --
    or a leaf row containing "shall") or folds into its nearest ancestor,
    and resolves each row's immediate parent by walking its own ID
    segments' prefix -- NOT `TableGroupInfo.parent_label`, which is `None`
    whenever the immediate parent row didn't itself qualify as a group
    (see `TableGroupInfo.parent_label`'s own docstring); a fold row is
    still a valid, real parent to point at, and `id_tree_builder` walks
    `parent_index` chains through fold rows until it reaches a
    node-producing one."""
    groups = qualifying_groups(parsed)
    group_type_by_segments = {
        parse_id_segments(g.id_text): g.suggested_type for g in groups
    }
    index_by_segments = {segments: i for i, (segments, _label) in enumerate(parsed)}

    rows: list[HierarchyRow] = []
    for i, (segments, label) in enumerate(parsed):
        has_shall = bool(SHALL_PATTERN.search(label))
        group_type = group_type_by_segments.get(segments)
        if group_type is not None:
            node_type: str | None = group_type
        elif has_shall:
            node_type = REQUIREMENT
        else:
            node_type = None  # fold into nearest node-producing ancestor

        parent_segments = segments[:-1] if len(segments) > 1 else None
        parent_index = index_by_segments.get(parent_segments) if parent_segments else None

        rows.append(HierarchyRow(
            label=label, has_shall=has_shall, source_ref=source_refs[i],
            node_type=node_type, parent_index=parent_index,
            id_text=id_text_from_segments(segments),
            id_disambiguator_needed=id_disambiguator_needed,
        ))
    return rows


def rows_from_table(table) -> list[HierarchyRow]:
    """Convention 1: a 2-column `Requirement ID | Text` table with a
    dotted numeric ID. Returns [] for a non-conforming table (see
    `parsed_id_rows_from_table`'s own gate). Every row shares the Table's
    own single `source_ref` (no finer granularity exists in the canonical
    model for a Table), so `id_disambiguator_needed=True` -- two
    byte-identical leaf texts at different requirement IDs would otherwise
    hash-collide (see `id_tree_builder`'s identity-hash docstring)."""
    parsed = parsed_id_rows_from_table(table)
    if not parsed:
        return []
    source_refs = [table.source_ref] * len(parsed)
    return _resolve_hierarchy_rows(parsed, source_refs, id_disambiguator_needed=True)


class _NestNode:
    __slots__ = ("key", "level", "is_override", "children", "type", "child_type")

    def __init__(self, key: Hashable, level: int, is_override: bool) -> None:
        self.key = key
        self.level = level
        self.is_override = is_override
        self.children: list[_NestNode] = []
        self.type: WorkItemType | None = None
        self.child_type: WorkItemType | None = None


def classify_by_nesting(
    items: list[tuple[_K, int, bool]],
) -> dict[_K, tuple[WorkItemType, WorkItemType]]:
    """Bottom-up, tree-shape-derived Epic/Feature/Requirement classification
    for ANY source that can express its content as (key, level, is_override)
    triples in document order -- factored out of
    `autodetect.classify_numbering_branch` (which now calls this) so
    convention 3 (structural heading nesting, no ID text at all -- see
    module docstring) can reuse the exact same ladder that convention 2's
    numbering-label branches already use, without depending on numbering
    labels existing at all.

    Per the spec's own hierarchy rule ("a Requirement MAY be a child of a
    Requirement (sub-Req), a Feature child of a Feature (sub-Feature), an
    Epic child of an Epic (sub-Epic)"), a node either advances one tier
    below its parent or repeats its parent's tier -- what decides which,
    for an unmarked (non-override) node, is whether promoting it would
    still leave room for its own descendants to reach Requirement.

    An "override" item repeats its parent's tier instead of advancing: its
    type is its parent's already-computed type, and it is excluded from
    its parent's own children-classification (it does not count toward
    "did this parent's children all resolve to Requirement"). The caller
    decides what "override" means for its own source (a lettered numbering
    suffix, a literal "SUB-" marker, or nothing at all for a source with no
    such convention).

    A non-override item's type, given its non-override children's
    (already-classified) types:
    - zero non-override children (a true leaf, or every child was an
      override) -> Requirement.
    - every non-override child is Requirement -> Feature.
    - otherwise (at least one non-override child already promoted past
      Requirement) -> Epic. Strict two-way split: the ladder only ever
      moves downward, so any child needing its own further breakdown
      forces this parent to sit at or above Feature; a parent at exactly
      Feature is only valid when every real child is a leaf-level
      Requirement.

    `items` must already be in document order; parenting is derived
    purely from `level` via a stack walk (`while stack and
    stack[-1].level >= level: stack.pop()`), which handles a skipped
    intermediate level (e.g. a level-5 item directly after a level-3 one)
    by attaching to the nearest shallower-or-equal ancestor, same as a
    real Word outline would nest it.

    Returns a dict keyed by each item's own `key` -> (type, child_type),
    covering every item passed in."""
    stack: list[_NestNode] = []
    roots: list[_NestNode] = []
    all_nodes: list[_NestNode] = []

    for key, level, is_override in items:
        node = _NestNode(key, level, is_override)
        while stack and stack[-1].level >= level:
            stack.pop()
        if stack:
            stack[-1].children.append(node)
        else:
            roots.append(node)
        stack.append(node)
        all_nodes.append(node)

    def classify(node: _NestNode) -> WorkItemType:
        non_override_types = []
        for child in node.children:
            child_type = classify(child)
            if not child.is_override:
                non_override_types.append(child_type)
        if not non_override_types:
            node.type = WorkItemType.REQUIREMENT
        elif all(t == WorkItemType.REQUIREMENT for t in non_override_types):
            node.type = WorkItemType.FEATURE
        else:
            node.type = WorkItemType.EPIC
        return node.type

    for root in roots:
        classify(root)

    # Override nodes inherit their parent's FINAL type -- must run as a
    # second, top-down pass after every node's own intrinsic (bottom-up)
    # type has been computed, since a strict post-order walk visits a node
    # before its parent's own type is known. Root-level override nodes (no
    # parent to inherit from) keep their intrinsic classification.
    def apply_overrides(node: _NestNode, parent: _NestNode | None) -> None:
        if node.is_override and parent is not None:
            node.type = parent.type
        for child in node.children:
            apply_overrides(child, node)

    for root in roots:
        apply_overrides(root, None)

    def compute_child_type(node: _NestNode) -> WorkItemType:
        if node.type == WorkItemType.REQUIREMENT:
            return WorkItemType.REQUIREMENT
        non_override_child_types = {c.type for c in node.children if not c.is_override}
        if len(non_override_child_types) == 1:
            return next(iter(non_override_child_types))
        return WorkItemType.FEATURE if node.type == WorkItemType.EPIC else WorkItemType.REQUIREMENT

    for node in all_nodes:
        node.child_type = compute_child_type(node)

    return {node.key: (node.type, node.child_type) for node in all_nodes}


def rows_from_id_headings(
    blocks: list[Block],
) -> tuple[list[HierarchyRow], list[IntegrityWarning], list[str]]:
    """Convention 2: a native Word Heading hierarchy where the document's
    own author typed a dotted numeric ID directly into the heading text
    (e.g. "1.1.2.2.a  If multiple active sources are available..."), so
    the ID is real, parseable text -- unlike convention 3 (see
    `rows_from_heading_structure`), which exists specifically because most
    real documents do NOT do this (Word's own auto-numbering renders
    "3.2.1"-style numbers that never appear as literal text at all).

    Restricted to `BlockKind.HEADING` blocks with a non-None
    `heading_level` -- NOT every block `parse_numbering` could resolve a
    label for. Confirmed live: the plain-paragraph front matter of a real
    2-column-table document contains "1. Purpose and Scope" ... "4. Review
    and Approval", numbered PARAGRAPHS whose labels 1-4 collide head-on
    with that same document's table's own top-level IDs 1/2 -- a detector
    keyed on any numbering-resolvable block would find a bogus hierarchy
    in that front matter. Restricting to real Word headings also avoids
    silently re-routing `mock_tv_remote.docx` (a golden BASELINE fixture
    that is ENTIRELY flat numbered paragraphs with dotted IDs, by design)
    into this new deterministic path as a side effect of an unrelated
    feature.

    Level-to-ID reconciliation is a DOMINANT CONSTANT OFFSET
    (`heading_level - len(segments)`), not strict equality: a template
    that reserves Heading 1 for the document title (confirmed live
    production bug, see tree_builder._split_into_branches's own docstring)
    means "1" sits at Heading 2, "1.1" at Heading 3, etc -- offset 1
    throughout, not 0. Rows whose own offset disagrees with the document's
    dominant offset are EXCLUDED (not force-fit either direction) and
    reported in `warnings`; trusting the ID over a contradicting level
    would assert a hierarchy the document's own formatting visibly
    denies (the same fabrication class the reverted Epic-synthesis
    mechanism was rejected for), and trusting the level over the ID is
    worse since the ID is what carries parent identity.

    Gate (whole-document, not per-branch -- a real document's own top-level
    IDs can land in SEPARATE branches once split, so detection must run
    before any branch splitting): at least MIN_ID_ROWS confirmed rows AND
    confirmed rows are at least MIN_ID_ROW_FRACTION of ALL heading blocks
    (the heading OUTLINE is the bounded container here, not the whole
    document -- prose paragraphs vastly outnumber headings in any real
    spec for reasons unrelated to whether this convention is in use), AND
    at least 2 distinct confirmed heading levels (a flat run of same-level
    headings encodes no hierarchy), AND at least 1 qualifying group.
    Returns `([], [], set())` -- never a partial row list -- on any gate
    failure, matching `_parse_id_hierarchy_table_rows`'s own
    "no half-parsed state" contract.

    Returns (rows, warnings, claimed_block_ids) -- `claimed_block_ids` is
    just the confirmed headings' own block ids; span-claiming (folding the
    non-heading blocks that follow a claimed heading, and any Table
    objects in its span) is the caller's job in `llm_leveling.py`, not
    this detector's."""
    candidates: list[tuple[Block, tuple[int, ...], str]] = []
    for block in blocks:
        if block.kind != BlockKind.HEADING or block.heading_level is None:
            continue
        label, remainder = parse_numbering(block.text)
        if label is None:
            continue
        segments = parse_id_segments(label)
        if segments is None:
            continue  # numbering.py's label shape and ID_PATTERN diverge
            # on the lettered-suffix case only (see this module's own
            # docstring on that divergence) -- under-triggers, never
            # over-triggers.
        candidates.append((block, segments, remainder.strip()))

    heading_block_count = sum(
        1 for b in blocks if b.kind == BlockKind.HEADING and b.heading_level is not None
    )
    if not candidates:
        return [], [], []

    offsets = [block.heading_level - len(segments) for block, segments, _label in candidates]
    offset_counts: dict[int, int] = {}
    for offset in offsets:
        offset_counts[offset] = offset_counts.get(offset, 0) + 1
    max_count = max(offset_counts.values())
    dominant_offset = min(o for o, c in offset_counts.items() if c == max_count)

    confirmed: list[tuple[Block, tuple[int, ...], str]] = []
    deviants: list[tuple[Block, tuple[int, ...], str]] = []
    for (block, segments, label), offset in zip(candidates, offsets):
        if offset == dominant_offset:
            confirmed.append((block, segments, label))
        else:
            deviants.append((block, segments, label))

    warnings: list[IntegrityWarning] = []
    if deviants:
        previews = "; ".join(
            f"'{b.text[:60]}' (heading level {b.heading_level}, expected "
            f"{len(segs) + dominant_offset} for ID '{id_text_from_segments(segs)}')"
            for b, segs, _label in deviants[:10]
        )
        warnings.append(
            IntegrityWarning.make(
                WarningKind.HEADING_ID_OFFSET_MISMATCH,
                f"{len(deviants)} heading(s) had an ID that doesn't match this document's dominant "
                "heading-level offset and were excluded from deterministic structure detection: "
                f"{previews}",
                detail={"deviantCount": len(deviants)},
            )
        )

    parsed = [(segments, label) for _block, segments, label in confirmed]
    if (
        len(parsed) < MIN_ID_ROWS
        or len(parsed) < heading_block_count * MIN_ID_ROW_FRACTION
        or len({b.heading_level for b, _s, _l in confirmed}) < 2
        or not qualifying_groups(parsed)
    ):
        return [], [], []

    rows = _resolve_hierarchy_rows(
        parsed, [block.source_ref for block, _s, _l in confirmed], id_disambiguator_needed=False,
    )
    claimed_block_ids = [block.id for block, _s, _l in confirmed]
    return rows, warnings, claimed_block_ids


def rows_from_heading_structure(
    blocks: list[Block],
) -> tuple[list[HierarchyRow], list[IntegrityWarning], list[str]]:
    """Convention 3: a native Word Heading hierarchy with NO id text at
    all. Confirmed live against a real ICD-style document (AirPro): Word
    renders "3.2.1"-style numbers for its headings, but those numbers are
    computed by Word's own auto-numbering (linked through the Heading
    style to `word/numbering.xml`) and never exist as literal text in the
    document -- `rows_from_id_headings` (convention 2) finds essentially
    nothing there (measured: 5 of 543 headings, all false positives of
    "shall"-adjacent digits like "3.3 V_AUX..."). Structural nesting is
    the ONLY signal available: `heading_level` + document order.

    Differs from conventions 1/2 in three structural ways, each a
    deliberate divergence from `qualifying_groups`, not an oversight:
    - **Group-vs-leaf is child COUNT, never "shall".** `qualifying_groups`
      excludes any "shall"-bearing row from group candidacy -- a
      documented, accepted limitation for ID-shaped rows/labels. Measured
      on AirPro, that limitation is NOT marginal for real heading prose:
      8 group headings (7% of 115) contain "shall" and have real children
      (e.g. "Backplane shall include the following modules:", 7
      children). Excluding them would orphan those children onto a
      grandparent -- measurably wrong structure. A heading's CHILDREN are
      directly observable from nesting; there's no reason to infer
      group-ness from prose when the structure already states it.
    - **Every candidate heading produces a node** -- no
      MIN_CHILDREN_TO_QUALIFY floor, no lone-child exclusion. That floor
      exists to filter TABLE rows (a header row, a stray version number
      coincidentally ID-shaped); a Word heading is, by construction, a
      real section the document's own author created. Measured: 36 of
      AirPro's 115 groups have exactly one child -- excluding them would
      delete 36 real sections.
    - **Typing is the bottom-up nesting ladder** (`classify_by_nesting`,
      shared with convention 2's numbering-label branches), not
      `suggested_type`'s ID-shape rules (group-of-groups -> Epic,
      all-lettered-children -> Requirement) -- there is no ID shape here
      to derive those rules from.

    Gate: this has no ID pattern to check, so qualification is about
    whether the heading outline's own LEAF content is itself requirement-
    shaped, not about ID shape. Gate A (≥2 distinct heading levels) is
    necessary but NOT sufficient on its own -- every headed document
    passes it. Gate B (leaf-heading "shall" fraction, see
    MIN_SHALL_LEAF_FRACTION/MIN_SHALL_LEAF_COUNT's own module-level
    docstrings) is the gate that actually separates "the heading outline
    IS the requirement hierarchy" (AirPro: 0.51) from "an ordinary headed
    document whose requirements live in body prose, not heading text"
    (two unrelated negative-control fixtures: 0.00 each). The risk
    calculus here is inverted relative to `qualifying_groups`'s: over-
    triggering here means building a tree from the document's REAL,
    observable heading nesting with verbatim descriptions and computed
    (not asserted) grounding scores -- a bounded, inspectable downside,
    unlike inventing a group that isn't one. Under-triggering means
    silently no-op'ing on exactly the document class this convention
    exists for.

    `is_override` reuses `SUB_MARKER_PATTERN` (the literal-marker half of
    the same override signal `classify_numbering_branch` uses) -- the
    lettered-suffix half doesn't apply here (there's no ID at all).

    Returns `([], [], set())` on any gate failure. Returns
    (rows, warnings, claimed_block_ids) on success -- `warnings` is always
    `[]` here (there's no ID to be inconsistent about); kept for a
    consistent 3-tuple return shape across all three adapters."""
    candidates = [b for b in blocks if b.kind == BlockKind.HEADING and b.heading_level is not None]
    if len({b.heading_level for b in candidates}) < 2:
        return [], [], []

    levels = [b.heading_level for b in candidates]
    is_leaf = [True] * len(candidates)
    # A candidate is a leaf iff no OTHER candidate immediately nests under
    # it -- i.e. no later candidate exists before the next same-or-shallower
    # level. Single forward pass using the same stack shape classify_by_nesting
    # uses, just to detect "has any child" rather than to classify yet.
    stack_idx: list[int] = []
    for i, level in enumerate(levels):
        while stack_idx and levels[stack_idx[-1]] >= level:
            stack_idx.pop()
        if stack_idx:
            is_leaf[stack_idx[-1]] = False
        stack_idx.append(i)

    leaf_shall_flags = [
        bool(SHALL_PATTERN.search(candidates[i].text)) for i in range(len(candidates)) if is_leaf[i]
    ]
    leaf_count = len(leaf_shall_flags)
    shall_leaf_count = sum(leaf_shall_flags)
    if (
        leaf_count == 0
        or shall_leaf_count < MIN_SHALL_LEAF_COUNT
        or shall_leaf_count < leaf_count * MIN_SHALL_LEAF_FRACTION
    ):
        return [], [], []

    is_override = [strip_sub_marker(b.text)[0] for b in candidates]
    types_by_index = classify_by_nesting(list(zip(range(len(candidates)), levels, is_override)))

    # Parent index resolved the same way classify_by_nesting derives
    # parenting internally -- recomputed here (rather than threaded out of
    # that function, which only returns per-key types) since HierarchyRow
    # needs it directly.
    parent_index: list[int | None] = [None] * len(candidates)
    stack_idx = []
    for i, level in enumerate(levels):
        while stack_idx and levels[stack_idx[-1]] >= level:
            stack_idx.pop()
        parent_index[i] = stack_idx[-1] if stack_idx else None
        stack_idx.append(i)

    # Per-root-subtree requirement-shaped gate (see
    # MIN_REQUIREMENT_SHAPED_LEAF_FRACTION's own docstring) -- a FINER
    # check than the whole-document shall-fraction gate above, which only
    # decides whether this convention applies to the document AT ALL. Once
    # a document IS confirmed requirements-shaped overall, each root
    # heading's own subtree gets judged separately: a subtree whose leaves
    # are mostly genuine requirement prose keeps the deterministic fast
    # path (needs_synthesis=False), one whose leaves are mostly spec-table
    # fragments/labels is flagged needs_synthesis=True on those leaves --
    # structure is still kept (this document's own real heading nesting),
    # only the leaf TEXT is untrusted verbatim.
    root_of_index: list[int | None] = [None] * len(candidates)
    current_root: int | None = None
    for i in range(len(candidates)):
        if parent_index[i] is None:
            current_root = i
        root_of_index[i] = current_root
    shaped_leaf_count_by_root: dict[int, int] = {}
    total_leaf_count_by_root: dict[int, int] = {}
    for i in range(len(candidates)):
        if not is_leaf[i]:
            continue
        root = root_of_index[i]
        total_leaf_count_by_root[root] = total_leaf_count_by_root.get(root, 0) + 1
        if _is_requirement_shaped(candidates[i].text):
            shaped_leaf_count_by_root[root] = shaped_leaf_count_by_root.get(root, 0) + 1
    needs_synthesis_by_root: dict[int, bool] = {}
    for root, total in total_leaf_count_by_root.items():
        shaped_fraction = shaped_leaf_count_by_root.get(root, 0) / total
        needs_synthesis_by_root[root] = shaped_fraction < MIN_REQUIREMENT_SHAPED_LEAF_FRACTION

    # Cosmetic id_text only -- reconstructs the SAME running-counter
    # numbering Word's auto-numbering algorithm would compute from
    # structure alone, but cannot be guaranteed to match what Word
    # actually renders (a level can be bound to a non-zero starting ilvl,
    # and numbered-but-empty heading paragraphs still consume a Word
    # auto-number while never reaching this candidate list at all -- both
    # confirmed live against a real document). Marked with a structural
    # "h" prefix specifically so it is never mistaken for the document's
    # own printed requirement number.
    counters: dict[int, int] = {}
    id_texts: list[str] = []
    for level in levels:
        counters[level] = counters.get(level, 0) + 1
        for deeper in [lvl for lvl in counters if lvl > level]:
            del counters[deeper]
        path = sorted(counters.items())
        id_texts.append("h" + ".".join(str(c) for _lvl, c in path))

    rows: list[HierarchyRow] = []
    for i, block in enumerate(candidates):
        node_type, _child_type = types_by_index[i]
        root = root_of_index[i]
        rows.append(HierarchyRow(
            label=block.text, has_shall=bool(SHALL_PATTERN.search(block.text)),
            source_ref=block.source_ref, node_type=node_type.value,
            parent_index=parent_index[i], id_text=id_texts[i],
            id_disambiguator_needed=False,
            # Only meaningful for LEAF rows (group/Epic/Feature headings
            # are already just short descriptive labels, never claimed as
            # full requirement text) -- a leaf in a root subtree below
            # MIN_REQUIREMENT_SHAPED_LEAF_FRACTION needs its text
            # synthesized rather than trusted verbatim.
            needs_synthesis=(
                is_leaf[i] and root is not None and needs_synthesis_by_root.get(root, False)
            ),
        ))

    claimed_block_ids = [b.id for b in candidates]
    return rows, [], claimed_block_ids
