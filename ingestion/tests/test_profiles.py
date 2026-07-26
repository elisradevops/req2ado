from app.leveling.profiles import heading_style_type_for_depth
from app.workitem.model import WorkItemType


def test_heading_style_depth_1_is_feature() -> None:
    assert heading_style_type_for_depth(1) == WorkItemType.FEATURE


def test_heading_style_depth_2_and_beyond_is_requirement() -> None:
    assert heading_style_type_for_depth(2) == WorkItemType.REQUIREMENT
    assert heading_style_type_for_depth(10) == WorkItemType.REQUIREMENT


def test_heading_style_has_no_ceiling_stays_flat_at_any_depth() -> None:
    # Regression: the old tv_style/icd_style depth-threshold heuristic would
    # flip a heading-styled branch to an Epic-bearing ladder once it reached
    # depth 4 -- there is no real reference document (mock or real) proving
    # a heading-styled ICD should ever grow an Epic tier just by nesting one
    # level deeper. The rule is unconditional: only depth 1 is ever Feature,
    # everything else is Requirement, at any depth.
    for depth in range(2, 8):
        assert heading_style_type_for_depth(depth) == WorkItemType.REQUIREMENT
