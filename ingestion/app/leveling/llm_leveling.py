from __future__ import annotations

import hashlib
from typing import Protocol

from app.canonical.model import CanonicalDoc
from app.distillation.title import extract_baseline_title
from app.leveling.depth import resolve_block_depth
from app.leveling.profiles import LevelingProfile
from app.workitem.model import RequirementTag, WorkItemMode, WorkItemNode, WorkItemTree, WorkItemType


class LlmLevelingClient(Protocol):
    """Interface for SURVEY-mode hierarchy inference. No real implementation
    exists in this phase — the orchestrator's LLM proxy/redaction client
    (which would host the actual Open WebUI call) is separate, not-yet-built
    infrastructure. This Protocol lets tests and future callers inject any
    conforming client. Matches the runtime prompt contract documented in
    docs/architecture.md: strict JSON {node_id,type,parent_id}[]."""

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
