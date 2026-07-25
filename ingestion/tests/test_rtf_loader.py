from pathlib import Path

from app.canonical.model import BlockKind
from app.loaders.rtf_loader import load_rtf

_SAMPLE_RTF = (
    r"{\rtf1\ansi\deff0"
    r"{\fonttbl{\f0 Times New Roman;}}"
    r"\f0\fs24 The widget subsystem shall meet all thermal requirements.\par"
    r"\par"
    r"A second paragraph describing the power budget.\par"
    r"}"
)


def _write_rtf(tmp_path: Path) -> str:
    path = tmp_path / "sample.rtf"
    path.write_text(_SAMPLE_RTF, encoding="utf-8")
    return str(path)


def test_load_rtf_produces_paragraph_blocks(tmp_path: Path) -> None:
    doc = load_rtf(_write_rtf(tmp_path))
    assert all(b.kind == BlockKind.PARAGRAPH for b in doc.blocks)
    assert any("thermal requirements" in b.text for b in doc.blocks)
    assert any("power budget" in b.text for b in doc.blocks)


def test_load_rtf_format_is_rtf(tmp_path: Path) -> None:
    doc = load_rtf(_write_rtf(tmp_path))
    assert doc.document.format.value == "rtf"
