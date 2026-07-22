from app.canonical.model import Block, BlockKind, SourceRef
from app.leveling.autodetect import detect_profile_for_branch


def _sr() -> SourceRef:
    return SourceRef(document_path="x", start_offset=0, end_offset=1)


def test_shallow_branch_detected_as_icd_style() -> None:
    branch = [
        Block(id="c0", kind=BlockKind.HEADING, heading_level=1, text="Power Distribution", source_ref=_sr()),
        Block(id="c1", kind=BlockKind.HEADING, heading_level=2, text="3.3V Rail Requirements", source_ref=_sr()),
    ]
    assert detect_profile_for_branch(branch) == "icd_style"


def test_deep_branch_detected_as_tv_style() -> None:
    branch = [
        Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr()),
        Block(id="b1", kind=BlockKind.PARAGRAPH, text="1.1 Broadcast & Inputs", source_ref=_sr()),
        Block(id="b2", kind=BlockKind.PARAGRAPH, text="1.1.1 Channel scan", source_ref=_sr()),
        Block(id="b3", kind=BlockKind.PARAGRAPH, text="1.1.1.1 The receiver shall scan all channels.", source_ref=_sr()),
    ]
    assert detect_profile_for_branch(branch) == "tv_style"


def test_branch_with_only_unleveled_blocks_defaults_to_icd_style() -> None:
    branch = [Block(id="x0", kind=BlockKind.PARAGRAPH, text="Just plain text, no numbering or heading.", source_ref=_sr())]
    assert detect_profile_for_branch(branch) == "icd_style"


def test_branch_reaching_depth_3_is_still_icd_style_not_flipped_to_tv_style() -> None:
    """The docs/architecture.md 1g fix: a genuine ICD sub-requirement one
    level below the normal Feature/Requirement pair reaches depth 3 without
    the whole branch flipping to tv_style (which would misclassify the
    Feature/Requirement pair above it as Epic/Epic)."""
    branch = [
        Block(id="c0", kind=BlockKind.HEADING, heading_level=1, text="Power Distribution", source_ref=_sr()),
        Block(id="c1", kind=BlockKind.HEADING, heading_level=2, text="3.3V Rail Requirements", source_ref=_sr()),
        Block(id="c2", kind=BlockKind.HEADING, heading_level=3, text="Ripple sub-requirement", source_ref=_sr()),
    ]
    assert detect_profile_for_branch(branch) == "icd_style"


def test_branch_reaching_depth_4_is_tv_style_not_icd_style() -> None:
    """One level deeper than the depth-3 ICD sub-requirement case above is
    still classified as tv_style -- the ceiling narrows the gap, it does not
    remove the tv_style/icd_style distinction entirely."""
    branch = [
        Block(id="c0", kind=BlockKind.HEADING, heading_level=1, text="Power Distribution", source_ref=_sr()),
        Block(id="c1", kind=BlockKind.HEADING, heading_level=2, text="3.3V Rail Requirements", source_ref=_sr()),
        Block(id="c2", kind=BlockKind.HEADING, heading_level=3, text="Ripple sub-requirement", source_ref=_sr()),
        Block(id="c3", kind=BlockKind.HEADING, heading_level=4, text="Ripple sub-sub-requirement", source_ref=_sr()),
    ]
    assert detect_profile_for_branch(branch) == "tv_style"
