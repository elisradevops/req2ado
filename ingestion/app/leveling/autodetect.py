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
