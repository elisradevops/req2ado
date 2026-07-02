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
