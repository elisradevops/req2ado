"""The keyed passes' entry contracts (see app.survey.keyed_calls). One `KeyedSpec` per pass
that has been migrated to the keyed-result module."""

from __future__ import annotations

from app.leveling.score_levels import FINDINGS
from app.survey._response_schemas import (
    _TAGS,
    content_authoring_schema,
    kb_relevance_schema,
    parent_summary_schema,
    synthesis_schema,
    title_tags_schema,
)
from app.survey.keyed_calls import KeyedSpec

_TAG_ARRAY = {"type": "array", "items": {"type": "string", "enum": _TAGS}}

TITLE_TAGS_SPEC = KeyedSpec(
    name="title_tag",
    schema_name="title_tags_by_row",
    fields={"title": {"type": "string"}, "tags": _TAG_ARRAY},
    field_prompts={
        "title": "'title' (string)",
        "tags": "'tags' (array of zero or more of the tags above)",
    },
    id_noun="row id",
    legacy_schema=title_tags_schema,
)

SYNTHESIS_SPEC = KeyedSpec(
    name="synthesis",
    schema_name="synthesized_requirements_by_row",
    fields={"title": {"type": "string"}, "text": {"type": "string"}, "tags": _TAG_ARRAY},
    field_prompts={
        "title": "'title' (a short, scannable title)",
        "text": "'text' (the synthesized requirement statement)",
        "tags": f"'tags' (an array of zero or more of the closed set: {', '.join(_TAGS)})",
    },
    id_noun="row id",
    legacy_schema=synthesis_schema,
)

PARENT_SUMMARY_SPEC = KeyedSpec(
    name="parent_summary",
    schema_name="parent_summary_by_node",
    fields={"title": {"type": "string"}, "description": {"type": "string"}},
    field_prompts={"title": "'title' (string)", "description": "'description' (string)"},
    id_noun="node id",
    legacy_schema=parent_summary_schema,
)

# The legacy answer maps each snippet index to a bare verdict string; the module reads entries as objects,
# so the client wraps it as {"verdict": ...} on the way in and unwraps it on the way out.
KB_RELEVANCE_SPEC = KeyedSpec(
    name="kb_relevance",
    schema_name="kb_relevance_by_snippet",
    fields={"verdict": {"type": "string", "enum": ["relevant", "not_relevant"]}},
    field_prompts={"verdict": "'verdict' ('relevant' or 'not_relevant')"},
    id_noun="snippet index",
    legacy_schema=kb_relevance_schema,
    legacy_output="Return ONLY a JSON object with the SAME index keys, each mapped to 'relevant' or 'not_relevant'.",
)

AUTHOR_CONTENT_SPEC = KeyedSpec(
    name="author_content",
    schema_name="content_by_node",
    fields={
        "description": {"type": "string"},
        "tags": {"type": "array", "items": {"type": "string", "enum": _TAGS}},
    },
    field_prompts={"description": "'description' (string)", "tags": "'tags' (array of strings)"},
    id_noun="node id",
    legacy_schema=content_authoring_schema,
)


# Quality scoring. The model judges; code scores (app.leveling.score_levels). Each entry is a level per category with the words that
# support it, and the problems found, each with the words it concerns. Levels carry no minimum/maximum (neither vendor supports them):
# the 0-4 range is checked where they are read.
_CATEGORY_LEVELS = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "level": {"type": "integer"},
        },
        "required": ["name", "level"],
        "additionalProperties": False,
    },
}
_FINDINGS = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "issue": {"type": "string", "enum": list(FINDINGS)},
            "quote": {"type": "string"},
        },
        "required": ["issue", "quote"],
        "additionalProperties": False,
    },
}

def _levels_by_node_schema() -> dict:
    """The legacy_map form of the scoring answer: a node_id-keyed object (the keys are runtime ids), each entry the same two fields."""
    return {
        "name": "levels_by_node",
        "schema": {
            "type": "object",
            "additionalProperties": {
                "type": "object",
                "properties": {"categories": _CATEGORY_LEVELS, "findings": _FINDINGS},
                "required": ["categories", "findings"],
            },
        },
    }


SCORING_SPEC = KeyedSpec(
    name="scoring",
    schema_name="levels_by_node",
    fields={"categories": _CATEGORY_LEVELS, "findings": _FINDINGS},
    field_prompts={
        "categories": '\'categories\' (a list of {"name", "level"} objects)',
        "findings": '\'findings\' (a list of {"issue", "quote"} objects)',
    },
    id_noun="node_id",
    legacy_schema=_levels_by_node_schema,
)

# Within-job conflict detection (app.leveling.conflict_detection): per pair, is it the same parameter, and -- used only where code cannot
# compare the values itself -- do the two values agree. Either may be "uncertain".
PAIR_VERDICTS = ("yes", "no", "uncertain")
PARAMETER_PAIR_SPEC = KeyedSpec(
    name="parameter_pair",
    schema_name="parameter_pairs",
    fields={
        "same_parameter": {"type": "string", "enum": list(PAIR_VERDICTS)},
        "values_agree": {"type": "string", "enum": list(PAIR_VERDICTS)},
    },
    field_prompts={
        "same_parameter": "'same_parameter' ('yes', 'no' or 'uncertain')",
        "values_agree": "'values_agree' ('yes', 'no' or 'uncertain')",
    },
    id_noun="pair id",
)

# The hierarchy check (app.leveling.hierarchy_check): per item the ladder does not allow, one of the fixes code offered for it. The option ids
# differ per item, so the schema cannot enumerate them; the client accepts only an id offered for that item.
HIERARCHY_FIX_SPEC = KeyedSpec(
    name="hierarchy_fix",
    schema_name="hierarchy_fixes_by_item",
    fields={"option": {"type": "string"}, "reason": {"type": "string"}},
    field_prompts={
        "option": "'option' (exactly one of the option ids listed for that item)",
        "reason": "'reason' (one short sentence)",
    },
    id_noun="item id",
)
