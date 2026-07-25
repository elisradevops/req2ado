"""Run once to (re)generate sample.rtf: `python build_rtf_fixture.py`."""
from pathlib import Path

content = (
    r"{\rtf1\ansi\deff0"
    r"{\fonttbl{\f0 Times New Roman;}}"
    r"\f0\fs24 The widget subsystem shall meet all thermal requirements.\par"
    r"\par"
    r"A second paragraph describing the power budget.\par"
    r"}"
)

out_path = Path(__file__).parent / "sample.rtf"
out_path.write_text(content, encoding="utf-8")
print(f"wrote {out_path}")
