"""The keyed passes' entry contracts (see app.survey.keyed_calls). One `KeyedSpec` per pass
that has been migrated to the keyed-result module."""
from __future__ import annotations

from app.survey._response_schemas import (
    _TAGS,
    _CONFIDENCE,
    _ISSUES,
    content_authoring_schema,
    epic_feature_scores_schema,
    figure_table_mapping_schema,
    kb_relevance_schema,
    parent_summary_schema,
    scores_schema,
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
    fields={"description": {"type": "string"}, "tags": {"type": "array", "items": {"type": "string", "enum": _TAGS}}},
    field_prompts={"description": "'description' (string)", "tags": "'tags' (array of strings)"},
    id_noun="node id",
    legacy_schema=content_authoring_schema,
)

# `node_id` is null for "belongs to no work item" and for "escalate"; a union with null is accepted by
# both Anthropic and OpenAI/Azure strict structured output when written as anyOf.
FIGURE_TABLE_MAPPING_SPEC = KeyedSpec(
    name="figure_table_mapping",
    schema_name="figure_table_mapping",
    fields={
        "node_id": {"anyOf": [{"type": "string"}, {"type": "null"}]},
        "escalate": {"type": "boolean"},
    },
    field_prompts={
        "node_id": "'node_id' (a candidate id from the input, or null)",
        "escalate": "'escalate' (boolean)",
    },
    id_noun="item id",
    legacy_schema=figure_table_mapping_schema,
)

# Quality scoring. `categoryScores` was an open map (category name -> score), which is not valid strict
# JSON Schema; on the wire it is an array of {"name", "score"} entries and the client turns it back
# into the same dict the scoring code reads. `score` carries no minimum/maximum (neither vendor
# supports them) -- the 0-100 range is checked where the score is read (leveling/scoring.py).
_CATEGORY_SCORES = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {"name": {"type": "string"}, "score": {"type": "integer"}},
        "required": ["name", "score"],
        "additionalProperties": False,
    },
}

SCORING_SPEC = KeyedSpec(
    name="scoring",
    schema_name="scores_by_node",
    fields={
        "score": {"type": "integer"},
        "issues": {"type": "array", "items": {"type": "string", "enum": _ISSUES}},
        "categoryScores": _CATEGORY_SCORES,
        "confidence": {"type": "string", "enum": _CONFIDENCE},
    },
    field_prompts={
        "score": "'score' (an integer 0-100)",
        "issues": "'issues' (a list of zero or more issue tags)",
        "categoryScores": "'categoryScores' (a list of {\"name\", \"score\"} objects)",
        "confidence": "'confidence' (one of 'high', 'medium', 'low')",
    },
    id_noun="node_id",
    legacy_schema=scores_schema,
)

EPIC_FEATURE_SCORING_SPEC = KeyedSpec(
    name="epic_feature_scoring",
    schema_name="epic_feature_scores_by_node",
    fields={"score": {"type": "integer"}, "categoryScores": _CATEGORY_SCORES},
    field_prompts={
        "score": "'score' (an integer 0-100)",
        "categoryScores": "'categoryScores' (a list of {\"name\", \"score\"} objects)",
    },
    id_noun="node_id",
    legacy_schema=epic_feature_scores_schema,
)
