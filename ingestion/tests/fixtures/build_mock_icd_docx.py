"""Run once to (re)generate mock_icd.docx: `python build_mock_icd_docx.py`.

Mock stand-in for the real engineering ICD reference document (unavailable
here — lives in a production environment). Embodies the real ICD convention
named in the original request: EACH top-level heading = Feature, everything
nested below it = Requirement. Uses real Word Heading styles (python-docx),
matching how the real ICD is actually authored, unlike the plain-numbered-
text style used for mock_tv_remote.docx.

Deliberately kept to 2 heading levels (Feature/Requirement) per branch, not
3 (Feature/Requirement/sub-Requirement): `detect_profile_for_branch`
(ingestion/app/leveling/autodetect.py) classifies a branch as icd_style only
when its max structural depth is <=2 — any depth-3 heading flips the WHOLE
branch to tv_style instead (Epic/Epic/Feature), which is not the ICD
convention at all. A genuine icd_style sub-requirement is therefore not
reachable under the current heuristic; this mock reflects what the code
actually supports rather than papering over the gap. See CR3 in the work
plan for the follow-up decision on whether that's an acceptable BASELINE
limitation or needs a dedicated fix.
"""
from pathlib import Path

from docx import Document as DocxDocument

doc = DocxDocument()

doc.add_heading("Power Distribution", level=1)
doc.add_heading("3.3V Rail Requirements", level=2)
doc.add_paragraph(
    "The 3.3V rail shall maintain output regulation within +/-2% under full "
    "rated load, verified per test procedure TP-114."
)
doc.add_heading("Rail Sequencing Requirements", level=2)
doc.add_paragraph(
    "Rail sequencing shall enforce 3.3V rising before 1.2V to avoid latch-up "
    "on the FPGA power rail."
)

doc.add_heading("Thermal Management", level=1)
doc.add_heading("Fan Control", level=2)
doc.add_paragraph(
    "The system shall activate the chassis fan when the internal ambient "
    "temperature exceeds 45C, and deactivate it once the temperature falls "
    "below 40C."
)

out_path = Path(__file__).parent / "mock_icd.docx"
doc.save(str(out_path))
print(f"wrote {out_path}")
