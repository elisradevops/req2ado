"""Run once to (re)generate mock_prd_sensor.docx: `python build_mock_prd_sensor_docx.py`.

Mock stand-in for the real customer document Mock_PRD_Sensor (1).docx
(not committed here). Embodies the real convention that fix targets: a
Word "Title" paragraph (indistinguishable from a real Heading 1 at the
Block level) followed by short metadata prose, then FOUR real Heading 1
sections, each grouping one Heading 2 sub-section whose own obligations
live in a requirements-list TABLE with its own literal id column -- not
in the heading text itself, unlike mock_icd.docx's own convention. See
app.leveling.heading_outline's own module docstring for why this shape
needs a different typing rule than mock_icd.docx's.
"""
from pathlib import Path

from docx import Document as DocxDocument

doc = DocxDocument()

doc.add_heading("Product Requirements Document", level=0)  # python-docx's "Title" style
doc.add_paragraph("Mock / Anonymized Test Data")
doc.add_paragraph("Customer ID: 000")


def _add_requirements_table(doc: DocxDocument, prefix: str, rows: list[tuple[str, str]]) -> None:
    table = doc.add_table(rows=1, cols=3)
    header = table.rows[0].cells
    header[0].text, header[1].text, header[2].text = "#", "Parameter", "Requirement / Value"
    for i, (parameter, requirement) in enumerate(rows):
        cells = table.add_row().cells
        cells[0].text = f"{prefix}-{i:03d}#"
        cells[1].text = parameter
        cells[2].text = requirement


doc.add_heading("Functional and Performance", level=1)
doc.add_heading("Synchronization", level=2)
_add_requirements_table(doc, "P-SENSOR", [
    ("Time sync source", "The system shall synchronize to Standard-XX within N ms."),
    ("Sync accuracy", "Timing accuracy shall be better than X microseconds."),
    ("Sync interval", "Re-synchronization shall occur every N seconds."),
])
doc.add_heading("Target Data report", level=2)
_add_requirements_table(doc, "P-TGT", [
    ("Report rate", "The system shall report target data at a rate of N Hz."),
    ("Report latency", "Report latency shall not exceed N ms end to end."),
])

doc.add_heading("Target Handling", level=1)
doc.add_heading("Target tracking", level=2)
_add_requirements_table(doc, "P-TRK", [
    ("Target tracking count", "The system shall track up to N simultaneous targets."),
    ("Track update rate", "Track updates shall occur at a rate of N Hz."),
])

doc.add_heading("Software", level=1)
doc.add_heading("SW Safety", level=2)
_add_requirements_table(doc, "P-SAF", [
    ("Safety standard compliance", "The software shall comply with safety standard XYZ."),
    ("Watchdog reset time", "The watchdog shall reset the system within N ms of a fault."),
])

doc.add_heading("Hardware Interfaces", level=1)
doc.add_heading("Connectors", level=2)
_add_requirements_table(doc, "P-CON", [
    ("Power connector type", "The power connector shall be of type XYZ."),
    ("Main connector pin count", "The main connector shall have N pins."),
])

out_path = Path(__file__).parent / "mock_prd_sensor.docx"
doc.save(str(out_path))
print(f"wrote {out_path}")
