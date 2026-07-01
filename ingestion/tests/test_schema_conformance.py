# ingestion/tests/test_schema_conformance.py
import json
from pathlib import Path

import jsonschema
import pytest

from app.loaders.docx_loader import load_docx
from app.loaders.pdf_loader import load_pdf
from app.loaders.text_loader import load_markdown, load_txt
from app.loaders.xlsx_loader import load_xlsx

FIXTURES = Path(__file__).parent / "fixtures"
SCHEMA_PATH = Path(__file__).parents[2] / "shared" / "schemas" / "canonical-doc.schema.json"


@pytest.fixture(scope="module")
def schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text())


@pytest.mark.parametrize(
    "loader,fixture_name",
    [
        (load_txt, "sample.txt"),
        (load_markdown, "sample.md"),
        (load_docx, "sample.docx"),
        (load_xlsx, "sample.xlsx"),
        (load_pdf, "sample.pdf"),
    ],
)
def test_loader_output_matches_canonical_schema(loader, fixture_name, schema) -> None:
    doc = loader(str(FIXTURES / fixture_name))
    jsonschema.validate(instance=doc.model_dump(mode="json"), schema=schema)
