from app.leveling.profiles import type_for_depth
from app.workitem.model import WorkItemType


def test_tv_style_depth_1_and_2_are_epic() -> None:
    assert type_for_depth("tv_style", 1) == WorkItemType.EPIC
    assert type_for_depth("tv_style", 2) == WorkItemType.EPIC


def test_tv_style_depth_3_is_feature() -> None:
    assert type_for_depth("tv_style", 3) == WorkItemType.FEATURE


def test_tv_style_depth_4_and_beyond_is_requirement() -> None:
    assert type_for_depth("tv_style", 4) == WorkItemType.REQUIREMENT
    assert type_for_depth("tv_style", 5) == WorkItemType.REQUIREMENT


def test_icd_style_depth_1_is_feature() -> None:
    assert type_for_depth("icd_style", 1) == WorkItemType.FEATURE


def test_icd_style_depth_2_and_beyond_is_requirement() -> None:
    assert type_for_depth("icd_style", 2) == WorkItemType.REQUIREMENT
    assert type_for_depth("icd_style", 10) == WorkItemType.REQUIREMENT
