import json
from pathlib import Path

import pytest

from app.survey.portable_schema import portable_schema_violations

VECTORS = json.loads((Path(__file__).parents[2] / "shared" / "test-vectors" / "portable-schema.json").read_text())["vectors"]


@pytest.mark.parametrize("vector", VECTORS, ids=[v["name"] for v in VECTORS])
def test_the_validator_agrees_with_the_shared_vectors(vector: dict) -> None:
    assert portable_schema_violations(vector["schema"]) == sorted(vector["violations"])


# --- every response schema the app sends -------------------------------------------------------------------------
import inspect

from app.survey import _response_schemas as response_schemas
from app.survey import keyed_calls, keyed_specs

# Schemas that are portable today MUST stay portable. The rest are legacy shapes with a free-form map or open node objects;
# each is listed with exactly the violations it has now, so fixing one makes this test fail until the entry is removed
# (a ratchet: the list can only shrink). The keyed passes replace the free-form maps in array mode (KEYED_SCHEMA_PASSES).
KNOWN_NOT_PORTABLE: dict[str, list[str]] = {
    "checklist_definitions_schema": ["/:free_form_object"],
    "content_authoring_schema": ["/:free_form_object"],
    "epic_feature_scores_schema": ["/:free_form_object"],
    "figure_table_mapping_schema": ["/:free_form_object"],
    "kb_relevance_schema": ["/:free_form_object"],
    "parent_summary_schema": ["/:free_form_object"],
    "scores_schema": ["/:free_form_object"],
    "synthesis_schema": ["/:free_form_object"],
    "title_tags_schema": ["/:free_form_object"],
    "section_analysis_schema": ["/:object_not_closed", "/properties/nodes/items:not_all_required", "/properties/nodes/items:object_not_closed"],
    "section_skeleton_schema": ["/:object_not_closed", "/properties/nodes/items:not_all_required", "/properties/nodes/items:object_not_closed"],
}


def _response_schema_functions() -> dict[str, object]:
    return {
        name: fn
        for name, fn in inspect.getmembers(response_schemas, inspect.isfunction)
        if name.endswith("_schema") and not inspect.signature(fn).parameters
    }


@pytest.mark.parametrize("name", sorted(_response_schema_functions()))
def test_every_response_schema_is_portable_or_a_listed_legacy_shape(name: str) -> None:
    built = _response_schema_functions()[name]()
    schema = built["schema"] if "schema" in built else built
    assert portable_schema_violations(schema) == KNOWN_NOT_PORTABLE.get(name, [])


@pytest.mark.parametrize(
    "spec_name", [n for n, o in inspect.getmembers(keyed_specs) if isinstance(o, keyed_calls.KeyedSpec)],
)
def test_every_keyed_pass_is_portable_in_array_mode(spec_name: str) -> None:
    spec = getattr(keyed_specs, spec_name)
    built = keyed_calls.schema_for(spec, "array")
    assert built is not None and portable_schema_violations(built["schema"]) == []
