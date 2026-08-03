# ingestion/app/leveling/id_tree_builder.py
"""Shared node-construction core for ALL THREE deterministic hierarchy
sources (`app.leveling.id_hierarchy`'s table-row, ID-bearing-heading, and
structural-heading adapters). This module does NO hierarchy or typing
logic of its own -- every `HierarchyRow` it consumes already carries its
resolved `node_type`/`parent_index` from its own adapter (see
`id_hierarchy.HierarchyRow`'s own docstring for why that split exists).
Its only job is construction: `local_id` assignment, folding non-node rows
into their nearest node-producing ancestor's description, both hashes,
`grounding_score`, `title`, `tags`, and (optionally) one batched LLM title/
tag improvement pass.

This is the module that keeps the deterministic path honest against the
concern that got the FIRST version of this feature (an Epic-synthesis
mechanism) reverted: every node built here traces to a REAL row/heading
the document's own author wrote, `grounding_score` is COMPUTED (via the
same `_grounding_score` every other SURVEY node uses), never a hardcoded
constant, and nothing here ever invents a node that has no real source
row backing it."""
from __future__ import annotations

import hashlib
import re
from typing import Protocol

from app.canonical.model import SourceRef
from app.distillation.description import assemble_description
from app.distillation.title import extract_baseline_title
from app.leveling.id_hierarchy import HierarchyRow
from app.leveling.tree_builder import _hash_description
from app.workitem.model import RequirementTag, WorkItemMode, WorkItemNode, WorkItemType

# Duplicated from llm_leveling.py's own _significant_words/_grounding_score
# (that module cannot be imported here: llm_leveling.py itself imports
# THIS module for the pipeline plumbing, and a two-way import would be
# circular). A description compared against ITSELF always yields 1.0
# regardless of the exact stopword set -- every one of a text's own
# significant words trivially appears in that same text -- so this is
# genuinely computed (not a hardcoded literal, per this module's own
# fabrication-avoidance rationale), just via a self-contained
# implementation rather than a cross-module call.
_GROUNDING_STOPWORDS = {
    "a", "an", "the", "shall", "system", "is", "are", "of", "to", "and", "or",
    "in", "on", "for", "with", "be", "will", "this", "that", "it", "its",
}
_WORD_PATTERN = re.compile(r"[a-z0-9]+")


def _significant_words(text: str) -> set[str]:
    words = _WORD_PATTERN.findall(text.lower())
    return {word for word in words if word not in _GROUNDING_STOPWORDS}


def _grounding_score(generated_text: str, source_text: str) -> float:
    generated_words = _significant_words(generated_text)
    if not generated_words:
        return 1.0
    source_words = _significant_words(source_text)
    return len(generated_words & source_words) / len(generated_words)


def _hash_identity_for_row(description: str, source_ref: SourceRef, id_text: str) -> str:
    """Table-row variant of tree_builder._hash_identity -- every row from
    ONE Table shares that Table's single source_ref (see SourceRef's own
    docstring), so two byte-identical leaf texts at different requirement
    IDs would otherwise hash-collide and wrongly collapse into one work
    item on first ingest. Folding in the row's own dotted id_text (a real,
    stable, document-derived disambiguator) fixes this without touching
    tree_builder._hash_identity itself, which BASELINE's golden fidelity
    tests pin. Only used when HierarchyRow.id_disambiguator_needed is True
    (table rows) -- heading-sourced rows already get a real, unique
    per-block source_ref and use the existing _hash_identity unchanged."""
    return hashlib.sha256(
        f"{description}\x00{source_ref.document_path}\x00{source_ref.start_offset}\x00{id_text}".encode()
    ).hexdigest()


def _hash_identity(description: str, source_ref: SourceRef) -> str:
    return hashlib.sha256(
        f"{description}\x00{source_ref.document_path}\x00{source_ref.start_offset}".encode()
    ).hexdigest()


class TitleTagClient(Protocol):
    """Optional, narrow LLM capability: given every deterministic leaf's
    own id -> text, return a short scannable title and a tag list per id.
    Omitting this entirely (the default) is byte-identical to the pure-
    deterministic path -- structure, typing and description NEVER depend
    on this call succeeding. One batched call per document (not per row),
    matching this codebase's own repeatedly-stated principle that a one-
    call-per-node design is both slower and worse than one call per whole
    unit of work (see SectionAnalysisClient's own docstring history)."""

    def title_and_tags_for_rows(self, texts_by_row_id: dict[str, str]) -> dict[str, dict]: ...


_TITLE_TAG_CHUNK_SIZE = 150
_VALID_TAGS = {t.value for t in RequirementTag}


def _apply_title_tag_pass(
    nodes: list[WorkItemNode],
    leaf_node_ids: list[str],
    title_tag_client: TitleTagClient,
    warnings: list[str],
) -> None:
    """Fail-open: any exception leaves every node's deterministic title
    and empty tags exactly as constructed -- the batched call is a pure
    enhancement, never a dependency. Chunked so a large document (e.g.
    hundreds of AirPro-style leaves) doesn't risk the same bounded-
    response-size problems this codebase's own schema module documents
    for large single calls."""
    if not leaf_node_ids:
        return
    by_id = {n.local_id: n for n in nodes}
    for start in range(0, len(leaf_node_ids), _TITLE_TAG_CHUNK_SIZE):
        chunk_ids = leaf_node_ids[start : start + _TITLE_TAG_CHUNK_SIZE]
        texts_by_id = {node_id: by_id[node_id].description for node_id in chunk_ids}
        try:
            result = title_tag_client.title_and_tags_for_rows(texts_by_id)
        except Exception as exc:
            message = (
                f"Title/tag enhancement call failed for {len(chunk_ids)} deterministic "
                f"leaf node(s) -- kept their deterministic titles and empty tags: {exc}"
            )
            warnings.append(message)
            continue

        missing = [node_id for node_id in chunk_ids if node_id not in result]
        if missing:
            warnings.append(
                f"Title/tag enhancement response omitted {len(missing)} of {len(chunk_ids)} "
                "requested node(s) -- those kept their deterministic titles and empty tags."
            )
        for node_id in chunk_ids:
            entry = result.get(node_id)
            if not entry:
                continue
            node = by_id[node_id]
            raw_title = entry.get("title")
            if isinstance(raw_title, str) and raw_title.strip():
                node.title = extract_baseline_title(raw_title)
            raw_tags = entry.get("tags")
            if isinstance(raw_tags, list):
                node.tags = [RequirementTag(t) for t in raw_tags if t in _VALID_TAGS]


class SynthesisClient(Protocol):
    """Optional, narrow LLM capability for the per-root-subtree fragment
    gate (see id_hierarchy.HierarchyRow.needs_synthesis's own docstring):
    given each flagged leaf's own verbatim source text plus its parent
    chain's labels as context, return a synthesized, properly-formed
    requirement statement -- e.g. "Size: 3U 1\"" under a "Power Supply"
    parent chain becomes "The COTS power supply shall have a 3U, 1-inch
    form factor." Omitting this entirely (the default) is byte-identical
    to before this capability existed: a flagged leaf keeps its raw,
    verbatim source text exactly as constructed."""

    def synthesize_leaf_requirements(self, items_by_id: dict[str, dict]) -> dict[str, dict]: ...


_SYNTHESIS_CHUNK_SIZE = 150


def _apply_synthesis_pass(
    nodes: list[WorkItemNode],
    leaf_node_ids: list[str],
    synthesis_client: SynthesisClient,
    warnings: list[str],
) -> None:
    """Fail-open, same convention as `_apply_title_tag_pass`: any exception
    or malformed/partial response leaves a flagged node's verbatim
    deterministic text exactly as constructed -- this is a pure quality
    enhancement, never a dependency of the deterministic path's own
    correctness.

    Each item sent to `synthesis_client` carries the node's own verbatim
    text plus a `context` string built from its CURRENT parent chain
    (root-to-immediate-parent titles, informational only -- not itself
    load-bearing for the tree's real structure, which stays exactly as
    already built regardless of what this pass does).

    `grounding_score` is recomputed against the ORIGINAL verbatim text
    (captured before this pass overwrites `description`), not a
    self-comparison -- fixes a real pre-existing gap where this field was
    always 1.0 by construction (`_grounding_score(description,
    description)`) and carried no information for these nodes."""
    if not leaf_node_ids:
        return
    by_id = {n.local_id: n for n in nodes}
    original_text_by_id = {node_id: by_id[node_id].description for node_id in leaf_node_ids}

    def _parent_chain_context(node: WorkItemNode) -> str:
        labels: list[str] = []
        current = node.parent_local_id
        seen: set[str] = set()
        while current and current not in seen:
            seen.add(current)
            ancestor = by_id.get(current)
            if ancestor is None:
                break
            labels.append(ancestor.title)
            current = ancestor.parent_local_id
        return " > ".join(reversed(labels))

    for start in range(0, len(leaf_node_ids), _SYNTHESIS_CHUNK_SIZE):
        chunk_ids = leaf_node_ids[start : start + _SYNTHESIS_CHUNK_SIZE]
        items_by_id = {
            node_id: {
                "text": original_text_by_id[node_id],
                "context": _parent_chain_context(by_id[node_id]),
            }
            for node_id in chunk_ids
        }
        try:
            result = synthesis_client.synthesize_leaf_requirements(items_by_id)
        except Exception as exc:
            message = (
                f"Requirement-text synthesis call failed for {len(chunk_ids)} flagged fragment "
                f"leaf node(s) -- kept their verbatim source text exactly as extracted: {exc}"
            )
            warnings.append(message)
            continue

        missing = [node_id for node_id in chunk_ids if node_id not in result]
        if missing:
            warnings.append(
                f"Requirement-text synthesis response omitted {len(missing)} of {len(chunk_ids)} "
                "requested node(s) -- those kept their verbatim source text exactly as extracted."
            )
        for node_id in chunk_ids:
            entry = result.get(node_id)
            if not entry:
                continue
            node = by_id[node_id]
            raw_text = entry.get("text")
            if isinstance(raw_text, str) and raw_text.strip():
                node.description = raw_text.strip()
                node.fidelity_hash = _hash_description(node.description)
                original_text = original_text_by_id[node_id]
                node.grounding_score = _grounding_score(node.description, original_text)
            raw_title = entry.get("title")
            if isinstance(raw_title, str) and raw_title.strip():
                node.title = extract_baseline_title(raw_title)
            raw_tags = entry.get("tags")
            if isinstance(raw_tags, list):
                node.tags = [RequirementTag(t) for t in raw_tags if t in _VALID_TAGS]


def build_hierarchy_subtree(
    rows: list[HierarchyRow],
    node_id_prefix: str,
    customer_id: str | None,
    title_tag_client: TitleTagClient | None = None,
    synthesis_client: SynthesisClient | None = None,
) -> tuple[list[WorkItemNode], list[str]]:
    """Constructs real WorkItemNodes from an already-hierarchy-resolved
    `rows` list (see `id_hierarchy.HierarchyRow`'s own docstring -- every
    row's `node_type`/`parent_index` is already decided by its own
    adapter; this function does no hierarchy or typing logic of its own).

    A row with `node_type is None` FOLDS into the nearest node-producing
    ancestor's description (walking `parent_index` chains through any
    other fold rows in between) via `assemble_description`, recomputing
    BOTH hashes -- the exact pattern `build_baseline_tree` already uses
    for a depth-None block/table. A `warnings` entry fires when a fold row
    has no node-producing ancestor at all (its own root chain is entirely
    fold rows) -- content is never silently dropped.

    `local_id` = f"{prefix}{id_text with dots->underscores}" -- stable
    across re-runs, traceable back to the source row/heading, and
    structurally distinct from the LLM path's `br{N}_`/bare temp ids.

    Epic->Feature demotion: an EPIC-typed row with at least one direct
    `has_shall` REQUIREMENT-typed child node gets re-typed FEATURE here --
    a CMMI-validity invariant (never letting a Requirement sit directly
    under an Epic), applied in the CORE rather than per-adapter policy,
    since it keeps this deterministic path from ever needing
    `_repair_requirement_hierarchy`'s `ensure_bridge_feature` fallback,
    which fabricates a node in the same class the reverted Epic-synthesis
    mechanism was rejected for. Convention 3's own nesting ladder is
    already CMMI-valid by construction, so this is a no-op there -- stated
    rather than hidden."""
    warnings: list[str] = []
    # First pass: construct every node-producing row's WorkItemNode, and
    # separately track, for every row (producing or not), which
    # node-producing row it should eventually attach to.
    node_index_by_row: dict[int, str] = {}  # row index -> local_id, producing rows only
    fold_target_by_row: dict[int, int | None] = {}  # row index -> nearest producing ancestor

    def _nearest_producing_ancestor(i: int) -> int | None:
        if i in fold_target_by_row:
            return fold_target_by_row[i]
        row = rows[i]
        if row.node_type is not None:
            fold_target_by_row[i] = i
            return i
        result = (
            _nearest_producing_ancestor(row.parent_index) if row.parent_index is not None else None
        )
        fold_target_by_row[i] = result
        return result

    nodes: list[WorkItemNode] = []
    for i, row in enumerate(rows):
        if row.node_type is None:
            continue
        local_id = f"{node_id_prefix}{row.id_text.replace('.', '_')}"
        description = row.label
        title = extract_baseline_title(description)
        identity_hash = (
            _hash_identity_for_row(description, row.source_ref, row.id_text)
            if row.id_disambiguator_needed
            else _hash_identity(description, row.source_ref)
        )
        node = WorkItemNode(
            local_id=local_id,
            type=WorkItemType(row.node_type),
            parent_local_id=None,  # resolved in the second pass, once every row has a local_id
            title=title,
            description=description,
            customer_id=customer_id,
            source_ref=row.source_ref,
            fidelity_hash=_hash_description(description),
            identity_hash=identity_hash,
            tags=[],
            mode=WorkItemMode.SURVEY,
            grounding_score=_grounding_score(description, description),
            needs_synthesis=row.needs_synthesis,
        )
        nodes.append(node)
        node_index_by_row[i] = local_id

    # Second pass: resolve parent_local_id for every producing row by
    # walking to the nearest producing ANCESTOR (which may itself require
    # walking through one or more fold rows).
    by_local_id = {n.local_id: n for n in nodes}
    for i, row in enumerate(rows):
        if row.node_type is None or row.parent_index is None:
            continue
        ancestor_row_index = _nearest_producing_ancestor(row.parent_index)
        if ancestor_row_index is not None:
            node = by_local_id[node_index_by_row[i]]
            node.parent_local_id = node_index_by_row[ancestor_row_index]

    # Third pass: fold every non-producing row into its nearest producing
    # ancestor's description, recomputing both hashes -- or warn if none
    # exists anywhere in its own chain.
    for i, row in enumerate(rows):
        if row.node_type is not None:
            continue
        ancestor_row_index = _nearest_producing_ancestor(i)
        if ancestor_row_index is None:
            warnings.append(
                f"Row '{row.id_text}' ('{row.label[:60]}') had no node-producing ancestor to fold "
                "into -- its content is not represented anywhere in the proposed tree."
            )
            continue
        target = by_local_id[node_index_by_row[ancestor_row_index]]
        target.description = assemble_description(target.description, row.label)
        target.fidelity_hash = _hash_description(target.description)
        ancestor_row = rows[ancestor_row_index]
        target.identity_hash = (
            _hash_identity_for_row(target.description, target.source_ref, ancestor_row.id_text)
            if ancestor_row.id_disambiguator_needed
            else _hash_identity(target.description, target.source_ref)
        )

    # NOTE: an Epic-with-a-direct-Requirement-child invariant violation is
    # NOT fixed here. An earlier version of this function demoted any EPIC
    # node with a direct has_shall Requirement child straight to FEATURE --
    # confirmed live (real job, real screenshot) that this is WRONG when
    # the same node ALSO has an Epic/Feature-typed child from elsewhere in
    # its own subtree (a mixed-children case, e.g. a heading whose
    # sub-items include both a deep sub-domain AND a short direct
    # requirement): blindly demoting the parent to FEATURE then leaves
    # that Epic child parented under a Feature -- a WORSE CMMI violation
    # than the one being fixed. The caller (llm_leveling._detect_deterministic_subtrees)
    # runs the same `_repair_requirement_hierarchy` post-hoc repair already
    # proven correct for the LLM-analysis path over these nodes too --
    # it re-parents the specific offending Requirement to the nearest real
    # Feature ancestor (walking up, or the branch's first Feature, or a
    # synthesized bridge as an absolute last resort) instead of changing
    # any other node's own type, which is safe regardless of how many
    # other child types a node has.

    # child_type is deliberately NOT computed here -- it depends on the
    # FINAL parent/child structure, which isn't settled until the caller
    # runs `_repair_requirement_hierarchy` afterward (see the NOTE above:
    # that repair can re-parent a node, which changes both its old and new
    # parent's real children). Call `recompute_child_types(nodes)` after
    # that repair runs -- see this module's own function for why.

    requirement_leaf_ids = [
        node_index_by_row[i]
        for i, row in enumerate(rows)
        if row.node_type == "Requirement" and i in node_index_by_row
    ]
    # Synthesis runs BEFORE the title/tag pass, and title/tag skips every
    # already-synthesized node -- synthesize_leaf_requirements returns its
    # OWN title/tags alongside the corrected text (see SynthesisClient's
    # own docstring), so re-running the generic title/tag enhancement on
    # top would just redo the same work and risk overwriting a synthesized
    # title with a lower-quality one derived from the (now-improved, but
    # still generically re-processed) text.
    synthesized_ids: set[str] = set()
    if synthesis_client is not None:
        synthesis_leaf_ids = [
            node_index_by_row[i]
            for i, row in enumerate(rows)
            if row.needs_synthesis and i in node_index_by_row
        ]
        _apply_synthesis_pass(nodes, synthesis_leaf_ids, synthesis_client, warnings)
        synthesized_ids = set(synthesis_leaf_ids)

    if title_tag_client is not None:
        leaf_node_ids = [node_id for node_id in requirement_leaf_ids if node_id not in synthesized_ids]
        _apply_title_tag_pass(nodes, leaf_node_ids, title_tag_client, warnings)

    return nodes, warnings


def recompute_child_types(nodes: list[WorkItemNode]) -> None:
    """`child_type` (the type a NEW manual child entry under this node
    should default to) is deterministically known once the tree's real
    parent/child structure is FINAL -- call this after any post-hoc
    structural repair (e.g. `llm_leveling._repair_requirement_hierarchy`,
    which can re-parent a node onto a different Feature ancestor,
    changing both its old and new parent's real children) has already run
    on `nodes`, not before. Mutates `nodes` in place.

    For a REQUIREMENT-typed node, child_type is always REQUIREMENT
    (matching `autodetect.compute_child_type`'s own convention). For an
    EPIC/FEATURE-typed node, it's the single uniform type of its real
    children when they all agree, else the natural next tier down from
    the node's own (possibly repair-adjusted) type."""
    children_by_parent: dict[str, list[WorkItemNode]] = {}
    for node in nodes:
        if node.parent_local_id:
            children_by_parent.setdefault(node.parent_local_id, []).append(node)

    for node in nodes:
        if node.type == WorkItemType.REQUIREMENT:
            node.child_type = WorkItemType.REQUIREMENT
            continue
        children = children_by_parent.get(node.local_id, [])
        child_types = {c.type for c in children}
        if len(child_types) == 1:
            node.child_type = next(iter(child_types))
        else:
            node.child_type = (
                WorkItemType.FEATURE if node.type == WorkItemType.EPIC else WorkItemType.REQUIREMENT
            )
