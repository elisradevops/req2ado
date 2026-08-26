# Golden-fixture regression coverage for heading_outline.py running through
# the REAL docx_loader.py parsing path (not synthetic Block construction,
# unlike test_heading_outline.py's own unit tests) -- mirrors this
# repo's own mock_icd.docx precedent (see build_mock_icd_docx.py's own
# docstring: real customer documents cannot be committed here, so a
# built-from-scratch mock stand-in reproducing the exact same shape is the
# substitute). Pins the two real document shapes that motivated this
# module's design: a Word "Title" + 4 real Heading-1-grouped sections
# (mock_prd_sensor.docx), and the SAME logical content with Heading 1
# never used at all (mock_prd_flat.docx) -- the shape that exposed a
# confirmed live defect in an earlier version of this module (see
# build_mock_prd_flat_docx.py's own docstring).
from pathlib import Path

from app.loaders.docx_loader import load_docx
from app.leveling.heading_outline import heading_outline_entries

FIXTURES = Path(__file__).parent / "fixtures"


def test_mock_prd_sensor_golden_produces_four_epics_and_five_features() -> None:
    doc = load_docx(str(FIXTURES / "mock_prd_sensor.docx"))
    entries = heading_outline_entries(doc.blocks, doc.tables)
    assert [(e.title, e.suggested_type) for e in entries] == [
        ("Functional and Performance", "Epic"),
        ("Synchronization", "Feature"),
        ("Target Data report", "Feature"),
        ("Target Handling", "Epic"),
        ("Target tracking", "Feature"),
        ("Software", "Epic"),
        ("SW Safety", "Feature"),
        ("Hardware Interfaces", "Epic"),
        ("Connectors", "Feature"),
    ]
    assert "Product Requirements Document" not in {e.title for e in entries}  # the Title, correctly excluded


def test_mock_prd_flat_golden_produces_features_only_no_epic() -> None:
    doc = load_docx(str(FIXTURES / "mock_prd_flat.docx"))
    entries = heading_outline_entries(doc.blocks, doc.tables)
    assert [(e.title, e.suggested_type) for e in entries] == [
        ("Synchronization", "Feature"),
        ("Target Data report", "Feature"),
        ("Target tracking", "Feature"),
        ("SW Safety", "Feature"),
        ("Connectors", "Feature"),
    ]
    titles = {e.title for e in entries}
    assert "Product Requirements Document" not in titles  # the confirmed live defect this fixture guards against
    assert "Epic" not in {e.suggested_type for e in entries}
