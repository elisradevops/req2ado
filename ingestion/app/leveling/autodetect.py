from __future__ import annotations

from app.canonical.model import Block
from app.leveling.depth import resolve_block_depth
from app.leveling.profiles import LevelingProfile


def detect_profile_for_branch(branch_blocks: list[Block]) -> LevelingProfile:
    """Heuristic, structural-depth-based auto-detect for BASELINE mode.

    This does NOT perform semantic "infer intent from context" reasoning —
    that is SURVEY/LLM territory (see llm_leveling.py). It only measures how
    deeply this branch nests (via resolve_block_depth) and classifies
    shallow branches (max depth <= 3) as icd_style (top heading = Feature,
    everything nested = Requirement) and deeper branches (max depth >= 4) as
    tv_style (Epic/Epic/Feature/Requirement ladder). Auto-detection runs
    PER TOP-LEVEL BRANCH, not once globally for the whole document — this is
    what allows the same nominal depth to resolve to different work-item
    types in different branches of the same document.

    The icd_style ceiling is 3, not 2 (docs/architecture.md 1g): a genuine
    ICD sub-requirement one level below the normal Feature/Requirement pair
    reaches depth 3 without the branch actually being tv_style. Distinguishing
    signal, proven against the golden mock_tv_remote.docx reference: a real
    tv_style branch there reaches depth 5, well past 3 -- reaching exactly 3
    and stopping is characteristic of "icd_style plus one extra sub-requirement
    level", not of the deeper Epic/Epic/Feature/Requirement ladder. Known,
    accepted tradeoff: a tv_style branch that stops exactly at depth 3 with no
    depth-4 child (e.g. Epic/Epic/Feature, no individual Requirement written
    for that Feature) will misclassify as icd_style — this is the same
    "cannot be checked against the real ICD document from within this repo"
    limitation the architecture doc already flags, not fully eliminated by
    this fix, only narrowed to a rarer, still-not-materially-worse case."""
    depths = [d for d, _ in (resolve_block_depth(b) for b in branch_blocks) if d is not None]
    max_depth = max(depths) if depths else 1
    return "icd_style" if max_depth <= 3 else "tv_style"
