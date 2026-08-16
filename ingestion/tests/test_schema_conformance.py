# ingestion/tests/test_schema_conformance.py
import json
from pathlib import Path

import jsonschema
import pytest

from app.loaders.csv_loader import load_csv
from app.loaders.docx_loader import load_docx
from app.loaders.image_loader import load_image
from app.loaders.pdf_loader import load_pdf
from app.loaders.pptx_loader import load_pptx
from app.loaders.rtf_loader import load_rtf
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
        # csv/pptx/rtf/image were previously untested here even though their
        # DocumentFormat enum values (pptx/csv/rtf/image) were already
        # missing from the checked-in schema's document.format enum -- found
        # while building S10's TS codegen off this schema: a real CanonicalDoc
        # from any of these 4 loaders would have failed jsonschema.validate
        # against the schema as it stood before this fix, and codegen would
        # have produced a `format` union type silently missing 4 real values.
        (load_csv, "sample.csv"),
        (load_pptx, "sample.pptx"),
        (load_rtf, "sample.rtf"),
        (load_image, "sample.png"),
    ],
)
def test_loader_output_matches_canonical_schema(loader, fixture_name, schema) -> None:
    doc = loader(str(FIXTURES / fixture_name))
    jsonschema.validate(instance=doc.model_dump(mode="json"), schema=schema)


def test_schema_rejects_a_stray_field_on_the_document(schema) -> None:
    doc = load_txt(str(FIXTURES / "sample.txt")).model_dump(mode="json")
    doc["document"]["extra_field"] = "unexpected"
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=doc, schema=schema)


def test_schema_rejects_a_stray_top_level_field(schema) -> None:
    doc = load_txt(str(FIXTURES / "sample.txt")).model_dump(mode="json")
    doc["extra_field"] = "unexpected"
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=doc, schema=schema)


def test_schema_rejects_a_stray_field_on_a_block(schema) -> None:
    doc = load_txt(str(FIXTURES / "sample.txt")).model_dump(mode="json")
    assert doc["blocks"], "fixture must produce at least one block for this test to be meaningful"
    doc["blocks"][0]["extra_field"] = "unexpected"
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=doc, schema=schema)


def test_schema_accepts_a_populated_failed_figure_storage_ids(schema) -> None:
    # Populated on a real /ingest response only when main.py's store() call
    # raises for one or more figures (see test_ingest_figure_storage.py) --
    # asserted here so the schema (additionalProperties: false) actually
    # recognizes the field rather than only ever seeing it as [].
    doc = load_txt(str(FIXTURES / "sample.txt")).model_dump(mode="json")
    doc["failed_figure_storage_ids"] = ["f0", "f3"]
    jsonschema.validate(instance=doc, schema=schema)


def test_schema_rejects_a_non_string_failed_figure_storage_id(schema) -> None:
    doc = load_txt(str(FIXTURES / "sample.txt")).model_dump(mode="json")
    doc["failed_figure_storage_ids"] = [123]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=doc, schema=schema)


def test_schema_accepts_vision_active_true_and_false(schema) -> None:
    # Task 4b sub-fix (i): CanonicalDoc.vision_active, set once by /ingest
    # and round-tripped through /level's request body (see main.py's
    # _append_vision_disabled_warning).
    doc = load_txt(str(FIXTURES / "sample.txt")).model_dump(mode="json")
    doc["vision_active"] = True
    jsonschema.validate(instance=doc, schema=schema)
    doc["vision_active"] = False
    jsonschema.validate(instance=doc, schema=schema)


def test_schema_rejects_a_non_boolean_vision_active(schema) -> None:
    doc = load_txt(str(FIXTURES / "sample.txt")).model_dump(mode="json")
    doc["vision_active"] = "yes"
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=doc, schema=schema)


def test_schema_accepts_each_real_figure_caption_status_value(schema) -> None:
    # Task 4b sub-fix (ii): Figure.caption_status, closed to "insignificant"/
    # "vision_failed"/null (additionalProperties: false on Figure, so this
    # also proves the schema actually recognizes the field).
    doc = load_txt(str(FIXTURES / "sample.txt")).model_dump(mode="json")
    doc["figures"] = [
        {"id": "f0", "caption": None, "source_ref": {"document_path": "x", "start_offset": 0, "end_offset": 1}, "caption_status": "insignificant"},
        {"id": "f1", "caption": None, "source_ref": {"document_path": "x", "start_offset": 0, "end_offset": 1}, "caption_status": "vision_failed"},
        {"id": "f2", "caption": "real caption", "source_ref": {"document_path": "x", "start_offset": 0, "end_offset": 1}, "caption_status": None},
    ]
    jsonschema.validate(instance=doc, schema=schema)


def test_schema_rejects_an_out_of_vocabulary_figure_caption_status(schema) -> None:
    doc = load_txt(str(FIXTURES / "sample.txt")).model_dump(mode="json")
    doc["figures"] = [
        {"id": "f0", "caption": None, "source_ref": {"document_path": "x", "start_offset": 0, "end_offset": 1}, "caption_status": "vision_disabled"},
    ]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=doc, schema=schema)


def test_schema_accepts_an_ocr_recovered_table_cell(schema) -> None:
    doc = load_txt(str(FIXTURES / "sample.txt")).model_dump(mode="json")
    doc["tables"] = [
        {
            "id": "t0",
            "cells": [[{"text": "Label", "ocr_recovered": True}, {"text": "Alpha", "ocr_recovered": False}]],
            "source_ref": {"document_path": "x", "start_offset": 0, "end_offset": 1},
        }
    ]
    jsonschema.validate(instance=doc, schema=schema)


def test_schema_rejects_a_non_boolean_ocr_recovered(schema) -> None:
    doc = load_txt(str(FIXTURES / "sample.txt")).model_dump(mode="json")
    doc["tables"] = [
        {
            "id": "t0",
            "cells": [[{"text": "Label", "ocr_recovered": "yes"}]],
            "source_ref": {"document_path": "x", "start_offset": 0, "end_offset": 1},
        }
    ]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=doc, schema=schema)
