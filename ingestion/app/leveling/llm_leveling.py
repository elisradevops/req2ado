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
