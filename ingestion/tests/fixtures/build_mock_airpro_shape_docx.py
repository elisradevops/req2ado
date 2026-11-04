"""Run once to (re)generate mock_airpro_shape.docx: `python build_mock_airpro_shape_docx.py`.

Synthetic stand-in for the shape of a real ICD whose requirements ARE its headings: no Heading 1 anywhere, section
headings at levels 2-4, requirement statements as headings (one of them with sub-requirements below it), a section that
mixes a loose requirement with a sub-section, and a deeper section chain. All text is invented."""
from pathlib import Path

from docx import Document as DocxDocument

doc = DocxDocument()

doc.add_heading("Power Interface", level=2)
doc.add_heading("Input Voltage", level=3)
doc.add_heading("The unit shall accept 24V DC input.", level=4)
doc.add_heading("The unit shall tolerate reverse polarity.", level=4)
doc.add_heading("The unit must report an undervoltage fault.", level=3)
doc.add_heading("Ripple limit applies", level=4)
doc.add_heading("Ripple shall stay below 50 mV.", level=5)

doc.add_heading("Data Interface", level=2)
doc.add_heading("Serial Link", level=3)
doc.add_heading("Framing", level=4)
doc.add_heading("Each frame shall start with a sync byte.", level=5)
doc.add_heading("The baud rate shall be 115200.", level=4)
doc.add_heading("Loose requirement directly under a section of sections.", level=3)

doc.add_heading("Environment", level=2)
doc.add_heading("The unit shall operate from -20 to 60 C.", level=3)

out_path = Path(__file__).parent / "mock_airpro_shape.docx"
doc.save(str(out_path))
