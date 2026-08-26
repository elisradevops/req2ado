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
from typing import Protocol

from app.canonical.model import SourceRef, Table
from app.distillation.description import assemble_description
from app.distillation.title import extract_baseline_title
from app.leveling.customer_id import extract_customer_requirement_code
from app.leveling.id_hierarchy import HierarchyRow
from app.leveling.narration_publisher import LevelingProgress, ProgressCallback
from app.leveling.tree_builder import _hash_description, _table_to_html
from app.workitem.model import IntegrityWarning, RequirementTag, WarningKind, WorkItemMode, WorkItemNode, WorkItemType

# Previously a second, independent copy of llm_leveling.py's own
# _significant_words/_grounding_score with an ASCII-only word pattern --
# confirmed real bug (NEW-04): it silently emptied the significant-word set
# (and made grounding_score trivially 1.0, "can't judge, assume fine") for
# Hebrew/Arabic/any non-Latin script content, reopening exactly the gap
# _apply_synthesis_pass's own grounding_score line below claims to have
# closed. Extracted to grounding.py instead (Phase 6) -- a leaf module with
# zero intra-package dependencies, so both this module and llm_leveling.py
# (which itself imports THIS module for pipeline plumbing) can import it
# without the circular import a direct cross-import between the two would
# create. Aliased under the original private names so every call site below
# needs no change.
from app.leveling.grounding import grounding_score as _grounding_score
from app.leveling.grounding import significant_words as _significant_words


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
    per-block source_ref and use the existing _hash_identity unchanged.

    `description` is accepted for call-site-shape symmetry but NOT hashed
    (see tree_builder._hash_identity's own docstring for why) -- id_text is
    already the real, stable, document-derived disambiguator this needs;
    description here is `row.label`, verbatim source text, so dropping it
    changes nothing about stability, only removes a redundant input."""
    return hashlib.sha256(
        f"{source_ref.document_path}\x00{source_ref.start_offset}\x00{source_ref.end_offset}\x00{id_text}".encode()
    ).hexdigest()


def _hash_identity(description: str, source_ref: SourceRef) -> str:
    """`description` is accepted for call-site-shape symmetry with
    _hash_identity_for_row but NOT hashed -- see
    tree_builder._hash_identity's own docstring. Every call site in this
    module already gives each node its own distinct source_ref."""
    return hashlib.sha256(
        f"{source_ref.document_path}\x00{source_ref.start_offset}\x00{source_ref.end_offset}".encode()
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
    warnings: list[IntegrityWarning],
    progress_callback: ProgressCallback | None = None,
    subtree_index: int | None = None,
    subtree_count: int | None = None,
    subtree_label_prefix: str | None = None,
) -> None:
    """Fail-open: any exception leaves every node's deterministic title
    and empty tags exactly as constructed -- the batched call is a pure
    enhancement, never a dependency. Chunked so a large document (e.g.
    hundreds of AirPro-style leaves) doesn't risk the same bounded-
    response-size problems this codebase's own schema module documents
    for large single calls.

    Real gap this closes (confirmed live, AirPro document): a subtree with
    enough leaves to need >1 chunk (or even just ONE genuinely slow chunk on
    a big model) previously had no narration between chunks at all --
    _detect_deterministic_subtrees's own kickoff event fires once per
    SUBTREE, before this loop even starts, and stays frozen for however long
    every chunk inside it takes. Firing here, per chunk, closes that."""
    if not leaf_node_ids:
        return
    by_id = {n.local_id: n for n in nodes}
    total_chunks = -(-len(leaf_node_ids) // _TITLE_TAG_CHUNK_SIZE)  # ceil division, no float rounding
    for start in range(0, len(leaf_node_ids), _TITLE_TAG_CHUNK_SIZE):
        chunk_ids = leaf_node_ids[start : start + _TITLE_TAG_CHUNK_SIZE]
        if progress_callback is not None:
            chunk_num = start // _TITLE_TAG_CHUNK_SIZE + 1
            label_prefix = f"{subtree_label_prefix} -- " if subtree_label_prefix else ""
            progress_callback(
                LevelingProgress(
                    phase="deterministic_subtree", branch_index=None, branch_count=0,
                    # blocks_done/blocks_total (not 0/0) -- chunk_num/total_chunks
                    # were already being computed for the narration TEXT below;
                    # feeding the same real fraction into these fields lets
                    # ProgressBanner.tsx's existing blocksTotal>0 percentage
                    # calculation render a real "~N% of this section" instead
                    # of always falling through to "no progress estimate for
                    # this step yet" for the whole duration of a multi-chunk
                    # pass (confirmed live: 2+ minutes with zero numeric signal
                    # on a real 682-block document).
                    blocks_done=start, blocks_total=len(leaf_node_ids), kb_grounded=False, kb_citations=[],
                    subtree_index=subtree_index, subtree_count=subtree_count,
                    subtree_label=(
                        f"{label_prefix}enhancing titles/tags for {len(chunk_ids)} node(s) "
                        f"(chunk {chunk_num} of {total_chunks})"
                    ),
                )
            )
        texts_by_id = {node_id: by_id[node_id].description for node_id in chunk_ids}
        try:
            result = title_tag_client.title_and_tags_for_rows(texts_by_id)
        except Exception as exc:
            message = (
                f"Title/tag enhancement call failed for {len(chunk_ids)} deterministic "
                f"leaf node(s) -- kept their deterministic titles and empty tags: {exc}"
            )
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.ENHANCEMENT_CALL_FAILED,
                    message,
                    node_ids=chunk_ids,
                    detail={"pass": "title_tag"},
                )
            )
            if progress_callback is not None:
                progress_callback(
                    LevelingProgress(
                        phase="chunk_warning", branch_index=None, branch_count=0,
                        blocks_done=0, blocks_total=0, kb_grounded=False, kb_citations=[],
                        warning_message=message,
                    )
                )
            continue

        missing = [node_id for node_id in chunk_ids if node_id not in result]
        if missing:
            message = (
                f"Title/tag enhancement response omitted {len(missing)} of {len(chunk_ids)} "
                "requested node(s) -- those kept their deterministic titles and empty tags."
            )
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.ENHANCEMENT_RESPONSE_INCOMPLETE,
                    message,
                    node_ids=missing,
                    detail={"pass": "title_tag"},
                )
            )
            if progress_callback is not None:
                progress_callback(
                    LevelingProgress(
                        phase="chunk_warning", branch_index=None, branch_count=0,
                        blocks_done=0, blocks_total=0, kb_grounded=False, kb_citations=[],
                        warning_message=message,
                    )
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


class ParentSummaryClient(Protocol):
    """Optional, narrow LLM capability for Epic/Feature (container) nodes --
    distinct from TitleTagClient above, which only ever touches Requirement
    leaves. Without this, an Epic/Feature's title AND description are both
    `extract_baseline_title(heading_text)` -- a VERBATIM copy of the
    source document's own section heading, identical to each other
    (confirmed real gap, live: "Controls:", "Over 28V VDC input" read as
    section titles, not ADO's own Epic/Feature framing -- a portfolio-level
    strategic goal / a capability delivering direct user value,
    respectively). Given every id -> {title, requirement_titles,
    requirement_descriptions} (see _apply_parent_summary_pass's own
    docstring for what those two lists actually contain -- NOT just direct
    children), returns a distinct, synthesized {title, description} per
    id. One batched call for every Epic/Feature in the document at once
    (not per node), same "one call per whole unit of work" principle as
    TitleTagClient."""

    def summarize_parent_nodes(self, nodes_by_id: dict[str, dict]) -> dict[str, dict]: ...


_PARENT_SUMMARY_CHUNK_SIZE = 150
# Same rough estimate this codebase already uses for its other token-budget
# gates (llm_leveling.py's own _CHARS_PER_TOKEN_ESTIMATE) -- kept as an
# independent constant here rather than imported, since llm_leveling.py
# imports FROM this module (id_tree_builder.py sits lower in the
# dependency graph); importing back would be circular.
_CHARS_PER_TOKEN_ESTIMATE = 4
# Real gap this closes: a parent's rollup payload (see
# _collect_descendant_requirement_texts) grows with its SUBTREE size, not
# a fixed per-item size like TitleTagClient/SynthesisClient's inputs --
# _PARENT_SUMMARY_CHUNK_SIZE alone (a plain node-COUNT cap) does nothing
# to bound that. Confirmed on a real 554-node AirPro job: 126 Epic/Feature
# nodes fit in one node-count chunk, but their combined rollup payload was
# ~184KB (~46K estimated tokens) -- a single call that size is a real
# latency/reliability risk (this codebase's own coverage_budget_tokens
# fix exists for the identical class of problem on the analyze_section
# path). Deliberately conservative for a local model's real context
# window, same order of magnitude as llm_leveling.py's own per-call
# budgets.
_PARENT_SUMMARY_TOKEN_BUDGET = 6_000


def _estimate_parent_payload_tokens(payload: dict) -> int:
    text = payload["title"] + "".join(payload["requirement_titles"]) + "".join(payload["requirement_descriptions"])
    return len(text) // _CHARS_PER_TOKEN_ESTIMATE


def _collect_descendant_requirement_texts(
    node_id: str,
    children_by_parent: dict[str, list[str]],
    by_id: dict[str, WorkItemNode],
) -> list[tuple[str, str]]:
    """Walks EVERY descendant of `node_id` (not just direct children) and
    returns (title, description) for each REQUIREMENT-type leaf found,
    document order. Real gap this closes: the spec's own hierarchy rule
    allows arbitrary nesting at every tier ("a Requirement MAY be a child
    of a Requirement (sub-Req)... an Epic child of an Epic (sub-Epic)",
    see id_hierarchy.classify_by_nesting's own docstring) -- an Epic whose
    direct child is a Requirement that ITSELF has nested sub-Requirement
    children would otherwise only ever see that one direct child's own
    text, never the grandchildren buried underneath it. Recursing through
    every descendant regardless of type (Epic/Feature/Requirement) and
    collecting only the REQUIREMENT leaves' real text is both correct
    (nothing nested is invisible) and gives every Epic/Feature a
    consistent payload built from raw leaf content, not from a sibling
    parent's own (possibly not-yet-summarized) title -- which is what
    lets every Epic/Feature in the whole document be summarized in ONE
    unordered pass, with no Feature-before-Epic (or nested-Epic depth)
    ordering dependency at all.

    `seen` guards against a cycle -- same defensive pattern as this
    module's own _nearest_producing_ancestor/_parent_chain_context,
    though build_hierarchy_subtree's construction never produces one."""
    results: list[tuple[str, str]] = []
    seen: set[str] = set()

    def _walk(current_id: str) -> None:
        if current_id in seen:
            return
        seen.add(current_id)
        for child_id in children_by_parent.get(current_id, []):
            child = by_id[child_id]
            if child.type == WorkItemType.REQUIREMENT:
                results.append((child.title, child.description))
            _walk(child_id)

    _walk(node_id)
    return results


def _apply_parent_summary_pass(
    nodes: list[WorkItemNode],
    parent_node_ids: list[str],
    client: ParentSummaryClient,
    warnings: list[IntegrityWarning],
    token_budget: int = _PARENT_SUMMARY_TOKEN_BUDGET,
    progress_callback: ProgressCallback | None = None,
    tables_by_id: dict[str, Table] | None = None,
) -> None:
    """Fail-open, same convention as `_apply_title_tag_pass`/
    `_apply_synthesis_pass`: any exception or missing/malformed response
    entry leaves that node's existing (verbatim heading) title/description
    exactly as constructed -- this is a pure enhancement, never a
    dependency of the deterministic path's own correctness.

    `parent_node_ids` (every Epic/Feature in the document, any order --
    see _collect_descendant_requirement_texts for why order doesn't
    matter here) gets `requirement_titles`/`requirement_descriptions`
    built from EVERY descendant Requirement leaf, however deeply nested,
    not just direct children -- correct for both real nesting shapes the
    spec allows: a Requirement with its own nested sub-Requirements
    (grandchildren an Epic would otherwise never see), and an Epic nested
    under another Epic (each gets its own full descendant rollup
    independently, so there is no dependency on a sibling/ancestor
    Epic/Feature having already been summarized).

    Chunked GREEDILY by running estimated token total against
    `token_budget` (default `_PARENT_SUMMARY_TOKEN_BUDGET`, a fixed
    conservative constant -- the caller may instead pass a real per-model
    derived budget, see llm_leveling._apply_det_parent_summary), not a
    fixed node-count slice -- a parent with a large subtree rollup can
    alone approach or exceed the budget; it still goes out whole, alone
    in its own chunk (never split, never truncated -- completeness over
    cost here), it just doesn't get to share a call with any other
    parent. Every parent is still sent exactly once; this only changes
    how many calls that takes, never what's covered.
    _PARENT_SUMMARY_CHUNK_SIZE (item count) still applies as a secondary
    ceiling, same "safety net regardless of token footprint" relationship
    _bound_branch_size has to coverage_budget_tokens's own budget-merge."""
    if not parent_node_ids:
        return
    by_id = {n.local_id: n for n in nodes}
    children_by_parent: dict[str, list[str]] = {}
    for n in nodes:
        if n.parent_local_id is not None:
            children_by_parent.setdefault(n.parent_local_id, []).append(n.local_id)

    payload_by_id: dict[str, dict] = {}
    for node_id in parent_node_ids:
        requirement_texts = _collect_descendant_requirement_texts(node_id, children_by_parent, by_id)
        payload_by_id[node_id] = {
            "title": by_id[node_id].title,
            "requirement_titles": [title for title, _ in requirement_texts],
            "requirement_descriptions": [description for _, description in requirement_texts],
        }

    chunks: list[list[str]] = []
    current: list[str] = []
    current_tokens = 0
    for node_id in parent_node_ids:
        node_tokens = _estimate_parent_payload_tokens(payload_by_id[node_id])
        would_exceed_budget = current and current_tokens + node_tokens > token_budget
        would_exceed_count = len(current) >= _PARENT_SUMMARY_CHUNK_SIZE
        if current and (would_exceed_budget or would_exceed_count):
            chunks.append(current)
            current = []
            current_tokens = 0
        current.append(node_id)
        current_tokens += node_tokens
    if current:
        chunks.append(current)

    for chunk_ids in chunks:
        nodes_by_id_payload = {node_id: payload_by_id[node_id] for node_id in chunk_ids}
        try:
            result = client.summarize_parent_nodes(nodes_by_id_payload)
        except Exception as exc:
            message = (
                f"Parent title/description enhancement call failed for {len(chunk_ids)} "
                f"deterministic Epic/Feature node(s) -- kept their verbatim heading title "
                f"and description: {exc}"
            )
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.ENHANCEMENT_CALL_FAILED,
                    message,
                    node_ids=chunk_ids,
                    detail={"pass": "parent_summary"},
                )
            )
            if progress_callback is not None:
                progress_callback(
                    LevelingProgress(
                        phase="chunk_warning", branch_index=None, branch_count=0,
                        blocks_done=0, blocks_total=0, kb_grounded=False, kb_citations=[],
                        warning_message=message,
                    )
                )
            continue

        missing = [node_id for node_id in chunk_ids if node_id not in result]
        if missing:
            message = (
                f"Parent title/description enhancement response omitted {len(missing)} of "
                f"{len(chunk_ids)} requested node(s) -- those kept their verbatim heading "
                "title and description."
            )
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.ENHANCEMENT_RESPONSE_INCOMPLETE,
                    message,
                    node_ids=missing,
                    detail={"pass": "parent_summary"},
                )
            )
            if progress_callback is not None:
                progress_callback(
                    LevelingProgress(
                        phase="chunk_warning", branch_index=None, branch_count=0,
                        blocks_done=0, blocks_total=0, kb_grounded=False, kb_citations=[],
                        warning_message=message,
                    )
                )
        for node_id in chunk_ids:
            entry = result.get(node_id)
            if not entry:
                continue
            node = by_id[node_id]
            raw_title = entry.get("title")
            raw_description = entry.get("description")
            if isinstance(raw_title, str) and raw_title.strip():
                node.title = raw_title.strip()
            if isinstance(raw_description, str) and raw_description.strip():
                description = raw_description.strip()
                # This pass replaces the whole description with a fresh
                # synthesized summary -- but any table already folded into
                # this node's span (see _detect_deterministic_subtrees'
                # heading-span-claiming loop, which runs BEFORE this pass)
                # embedded its real content into the OLD description via
                # assemble_description. Overwriting wholesale would silently
                # discard that content while node.table_ids (set by that
                # same earlier pass, untouched here) keeps pointing at it --
                # exactly the "chip with zero content" invariant violation
                # this codebase already fixed once for the LLM-authored path
                # (see _author_branch_content's own table_ids/html pairing).
                # Re-embed the same tables here so the invariant holds for
                # this path too. Figures need no equivalent re-embed: a
                # figure caption is never folded into description text in
                # the first place (see _detect_deterministic_subtrees'
                # identical figure-handling fix) -- node.figure_ids alone
                # drives the Figures UI section, independent of this text.
                for table_id in node.table_ids:
                    table = (tables_by_id or {}).get(table_id)
                    if table is None:
                        continue
                    table_html = _table_to_html(table)
                    if table_html:
                        description = assemble_description(description, table_html)
                node.description = description
                node.fidelity_hash = _hash_description(node.description)


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
    warnings: list[IntegrityWarning],
    progress_callback: ProgressCallback | None = None,
    subtree_index: int | None = None,
    subtree_count: int | None = None,
    subtree_label_prefix: str | None = None,
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

    total_chunks = -(-len(leaf_node_ids) // _SYNTHESIS_CHUNK_SIZE)  # ceil division, no float rounding
    for start in range(0, len(leaf_node_ids), _SYNTHESIS_CHUNK_SIZE):
        chunk_ids = leaf_node_ids[start : start + _SYNTHESIS_CHUNK_SIZE]
        if progress_callback is not None:
            chunk_num = start // _SYNTHESIS_CHUNK_SIZE + 1
            label_prefix = f"{subtree_label_prefix} -- " if subtree_label_prefix else ""
            progress_callback(
                LevelingProgress(
                    phase="deterministic_subtree", branch_index=None, branch_count=0,
                    # See _apply_title_tag_pass's identical comment above --
                    # same fix, same reasoning.
                    blocks_done=start, blocks_total=len(leaf_node_ids), kb_grounded=False, kb_citations=[],
                    subtree_index=subtree_index, subtree_count=subtree_count,
                    subtree_label=(
                        f"{label_prefix}synthesizing requirement text for {len(chunk_ids)} node(s) "
                        f"(chunk {chunk_num} of {total_chunks})"
                    ),
                )
            )
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
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.ENHANCEMENT_CALL_FAILED,
                    message,
                    node_ids=chunk_ids,
                    detail={"pass": "synthesis"},
                )
            )
            if progress_callback is not None:
                progress_callback(
                    LevelingProgress(
                        phase="chunk_warning", branch_index=None, branch_count=0,
                        blocks_done=0, blocks_total=0, kb_grounded=False, kb_citations=[],
                        warning_message=message,
                    )
                )
            continue

        missing = [node_id for node_id in chunk_ids if node_id not in result]
        if missing:
            message = (
                f"Requirement-text synthesis response omitted {len(missing)} of {len(chunk_ids)} "
                "requested node(s) -- those kept their verbatim source text exactly as extracted."
            )
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.ENHANCEMENT_RESPONSE_INCOMPLETE,
                    message,
                    node_ids=missing,
                    detail={"pass": "synthesis"},
                )
            )
            if progress_callback is not None:
                progress_callback(
                    LevelingProgress(
                        phase="chunk_warning", branch_index=None, branch_count=0,
                        blocks_done=0, blocks_total=0, kb_grounded=False, kb_citations=[],
                        warning_message=message,
                    )
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
            # Requirement-only -- gated explicitly here, not merely via this
            # pass's needs_synthesis-scoped caller: _repair_requirement_hierarchy
            # can re-type a synthesized leaf to FEATURE AFTER this pass runs,
            # so a check anywhere upstream of that repair wouldn't reflect the
            # node's final type. A fresh check right here, at assignment time
            # (before any such repair), is what actually needs to hold.
            if isinstance(raw_tags, list) and node.type == WorkItemType.REQUIREMENT:
                node.tags = [RequirementTag(t) for t in raw_tags if t in _VALID_TAGS]


def build_hierarchy_subtree(
    rows: list[HierarchyRow],
    node_id_prefix: str,
    title_tag_client: TitleTagClient | None = None,
    synthesis_client: SynthesisClient | None = None,
    progress_callback: ProgressCallback | None = None,
    subtree_index: int | None = None,
    subtree_count: int | None = None,
    subtree_label: str | None = None,
    # Prepended, root-most, to every node's own section_path in this
    # subtree -- used ONLY by the table-row convention's caller
    # (llm_leveling._detect_deterministic_subtrees), which seeds it with the
    # table's own identity (`table.caption or f"Table {table.id}"`), since a
    # table-row subtree's rows have no heading ancestor of their own to walk
    # via parent_index alone -- the table itself IS the top of that
    # hierarchy. None (the default) is correct for the heading conventions
    # (2/3): a heading's own row.parent_index chain already reaches all the
    # way to a true document root with nothing else to prepend.
    section_path_root: str | None = None,
) -> tuple[list[WorkItemNode], list[IntegrityWarning]]:
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
    warnings: list[IntegrityWarning] = []
    # First pass: construct every node-producing row's WorkItemNode, and
    # separately track, for every row (producing or not), which
    # node-producing row it should eventually attach to.
    node_index_by_row: dict[int, str] = {}  # row index -> local_id, producing rows only
    fold_target_by_row: dict[int, int | None] = {}  # row index -> nearest producing ancestor
    ancestor_labels_by_row: dict[int, list[str]] = {}  # row index -> root-first ancestor labels

    def _ancestor_labels(i: int) -> list[str]:
        """Root-first chain of row `i`'s own ANCESTOR labels (never
        including row `i`'s own label) -- becomes each producing row's
        node.source_ref.section_path (see SourceRef's own docstring for the
        `["3 Power", "3.2 Backplane"]`-shaped contract this must match).
        Walks the SAME `row.parent_index` chain `_nearest_producing_ancestor`
        walks above, but does NOT skip fold rows the way that function
        does: a fold row's own label is still real, human-authored section
        text (it just isn't node-worthy on its own), and belongs in a
        descendant's path exactly like a real heading would. Memoized the
        same way and for the same reason: a deeply-nested document would
        otherwise re-walk the same shared prefix chain once per descendant
        row, O(rows * depth) instead of O(rows)."""
        if i in ancestor_labels_by_row:
            return ancestor_labels_by_row[i]
        row = rows[i]
        if row.parent_index is None:
            result: list[str] = []
        else:
            result = _ancestor_labels(row.parent_index) + [rows[row.parent_index].label]
        ancestor_labels_by_row[i] = result
        return result

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
        # `.model_copy(update=...)`, never an in-place mutation of
        # `row.source_ref` -- pydantic v2 doesn't copy a nested BaseModel on
        # plain assignment, so `source_ref=row.source_ref` followed by a
        # later `node.source_ref.section_path = ...` would corrupt the
        # SAME SourceRef object `row` itself still holds (and that every
        # OTHER row derived from the same source might also reference).
        section_path = ([section_path_root] if section_path_root else []) + _ancestor_labels(i)
        node_type_enum = WorkItemType(row.node_type)
        # Customer ID is a per-Requirement, document-derived attribute --
        # never a job-level value applied uniformly (see WorkItemNode.
        # customer_id's own docstring). Only Requirement nodes ever carry
        # one, and only when this row's own source convention has a REAL id
        # concept to begin with (id_text_is_authored -- conventions 1/2
        # only; see HierarchyRow's own docstring). Convention 3 has no id
        # concept at all (see rows_from_heading_structure's own docstring:
        # "no id text at all") -- scanning its leaf text for anything
        # code-shaped risks matching an unrelated industry-standard
        # citation or cited component part number just as readily as a
        # genuine customer-assigned code, so it must stay gated out
        # entirely (see docs/handoff-heading-tier-detector-and-customer-id-fixes.md
        # for the confirmed live false-positive rate). A customer-assigned
        # code anywhere in this row's own text wins first when the
        # convention DOES have one; falls back to the real document-
        # authored numeric identifier (never convention 3's fabricated
        # running counter -- id_text_is_authored gates that too);
        # otherwise None, flagged by main.py's /level exit enforcement
        # pass, never invented.
        customer_id = (
            (extract_customer_requirement_code(row.label) or row.id_text)
            if node_type_enum == WorkItemType.REQUIREMENT and row.id_text_is_authored
            else None
        )
        node = WorkItemNode(
            local_id=local_id,
            type=node_type_enum,
            parent_local_id=None,  # resolved in the second pass, once every row has a local_id
            title=title,
            description=description,
            customer_id=customer_id,
            source_ref=row.source_ref.model_copy(update={"section_path": section_path}),
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
            message = (
                f"Row '{row.id_text}' ('{row.label[:60]}') had no node-producing ancestor to fold "
                "into -- its content is not represented anywhere in the proposed tree."
            )
            warnings.append(
                IntegrityWarning.make(
                    WarningKind.DROPPED_ROW,
                    message,
                    detail={"rowIdText": row.id_text, "rowLabel": row.label[:60]},
                )
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
        _apply_synthesis_pass(
            nodes, synthesis_leaf_ids, synthesis_client, warnings,
            progress_callback=progress_callback, subtree_index=subtree_index,
            subtree_count=subtree_count, subtree_label_prefix=subtree_label,
        )
        synthesized_ids = set(synthesis_leaf_ids)

    if title_tag_client is not None:
        leaf_node_ids = [node_id for node_id in requirement_leaf_ids if node_id not in synthesized_ids]
        _apply_title_tag_pass(
            nodes, leaf_node_ids, title_tag_client, warnings,
            progress_callback=progress_callback, subtree_index=subtree_index,
            subtree_count=subtree_count, subtree_label_prefix=subtree_label,
        )

    # parent_summary_client (Epic/Feature title+description enhancement) is
    # deliberately NOT run here -- the caller's own _repair_requirement_hierarchy
    # (run AFTER this function returns, per its own call-site comment) can
    # still re-parent a node, which would leave a parent's summary based on
    # a child set that's about to change. See _detect_deterministic_subtrees,
    # which runs _apply_parent_summary_pass once, after every subtree's own
    # repair has already settled the FINAL parent/child structure.

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
