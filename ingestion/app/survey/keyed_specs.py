"""The keyed passes' entry contracts (see app.survey.keyed_calls). One `KeyedSpec` per pass
that has been migrated to the keyed-result module."""
from __future__ import annotations

from app.survey._response_schemas import _TAGS, title_tags_schema
from app.survey.keyed_calls import KeyedSpec

TITLE_TAGS_SPEC = KeyedSpec(
    name="title_tag",
    schema_name="title_tags_by_row",
    fields={
        "title": {"type": "string"},
        "tags": {"type": "array", "items": {"type": "string", "enum": _TAGS}},
    },
    field_prompts={
        "title": "'title' (string)",
        "tags": "'tags' (array of zero or more of the tags above)",
    },
    id_noun="row id",
    legacy_schema=title_tags_schema,
)
