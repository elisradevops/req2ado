from __future__ import annotations

from app.workitem.model import WorkItemType


def heading_style_type_for_depth(depth: int) -> WorkItemType:
    """Real-ICD convention (Word Heading styles, see
    tests/fixtures/build_mock_icd_docx.py): a top heading is a flat
    container -- depth 1 -> Feature, depth >=2 -> Requirement, at ANY depth,
    unconditionally. No Epic tier exists for this convention; a real
    engineering ICD's own nested "sub-requirement" headings are still
    Requirements, however deep they nest (confirmed against mock_icd.docx's
    "3.3V Rail Requirements" -> "Ripple Sub-Requirement" chain).

    Deliberately has no ceiling/threshold: an earlier version of this
    function (and its sibling detect_profile_for_branch) flipped a
    heading-styled branch to an Epic-bearing ladder once it reached depth 4
    -- there was never a real reference document (mock or real) proving a
    heading-styled ICD should ever grow an Epic tier just by nesting one
    level deeper, so that behavior was retired rather than extended. See
    autodetect.py's is_heading_style_branch for which branches use this rule
    versus the numbering-label bottom-up classifier (classify_numbering_branch)."""
    return WorkItemType.FEATURE if depth <= 1 else WorkItemType.REQUIREMENT
