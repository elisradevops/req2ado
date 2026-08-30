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


def test_load_rtf_surfaces_a_warning_instead_of_silently_corrupting_non_utf8_bytes(tmp_path: Path) -> None:
    # Real regression: this loader always decoded as UTF-8 with
    # errors="replace" -- never raised, but a Hebrew CP1255 file's text
    # silently corrupted into replacement characters with no signal at all.
    path = tmp_path / "hebrew.rtf"
    body = "שלום עולם".encode("cp1255")
    raw = (
        rb"{\rtf1\ansi\deff0{\fonttbl{\f0 Times New Roman;}}\f0\fs24 " + body + rb"\par}"
    )
    path.write_bytes(raw)
    doc = load_rtf(str(path))  # must not raise
    note_blocks = [b for b in doc.blocks if b.kind == BlockKind.NOTE]
    assert len(note_blocks) == 1
    assert note_blocks[0].text.startswith("[UNSUPPORTED:")
