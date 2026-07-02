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
