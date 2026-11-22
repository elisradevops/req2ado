# ingestion/app/survey/_response_schemas.py
"""JSON Schemas passed as `responseSchema` on OrchestratorLlmClient's calls,
constraining LLM output at the API/sampling level instead of relying solely
on prompt wording. Built FROM the actual enum classes in app.workitem.model
so a schema can never drift out of sync with the runtime validation/fallback
logic that already exists for each of these fields (see llm_leveling.py's
WorkItemType ValueError->REQUIREMENT fallback and its tag/issue filtering).

Best-effort, not a hard dependency: an Ollama version that rejects
response_format degrades to a schema-less retry (see
OpenWebUiClient.chat()'s degradation logic on the orchestrator side) --
these schemas tighten output, they do not gate it. Every consumer keeps its
existing defensive fallback as defense-in-depth.

IMPORTANT -- the maxItems grammar-cost cliff, and why `infer_hierarchy`
is still unschema'd. `generate_requirements` (single-block) used to be
named here too; it no longer exists at all (deleted with the rest of the
unreachable single-block SURVEY requirement path). What is real and still
worth avoiding is a maxItems-BOUNDED top-level array sized to real branch
content (up to _MAX_SURVEY_BRANCH_BLOCK_COUNT=200 items). Observed live:
Ollama's GBNF grammar-constrained decoding (llama.cpp under the hood,
confirmed NOT XGrammar) compiles a bounded-repetition grammar from a
maxItems-sized array over a complex item shape whether or not the model
actually emits that many items -- the cost is schema-declared, not
runtime-output-driven. On a ~200-item branch this wedged the ENTIRE Ollama
server (single inference slot, `-np 1`) for 10+ minutes, unresponsive to
even unrelated requests, matching the documented failure mode in
ollama/ollama#1910 and the "performance gotchas" llama.cpp's own grammar
docs describe for bounded repetition over complex items. A smaller
maxItems doesn't meaningfully help -- real branches legitimately need up
to 200 entries, and any bound tight enough to avoid the cliff would also
truncate real hierarchies.

The workaround that DOES apply: wrap the array inside an object and omit
maxItems entirely, which compiles to a cheap unbounded-star grammar.
section_analysis_schema() and trace_links_schema() below both do exactly
this, the latter over a whole-tree-sized array -- so an array being large
is NOT by itself a reason to leave a call unschema'd. `infer_hierarchy` is
a real remaining schema gap on those grounds, not a closed question;
it is tracked separately rather than fixed here. The
additionalProperties-object schemas below are safe for a different
reason: `maxProperties` is silently ignored by Ollama's converter for
additionalProperties objects, so they compile to the same cheap
unbounded-star grammar regardless. DO NOT add a maxItems-BOUNDED
top-level array schema without re-verifying the cliff against whatever
Ollama version is in use at the time.
"""

from __future__ import annotations

from app.workitem.model import (
    RequirementTag,
    WorkItemType,
)

_TAGS = [t.value for t in RequirementTag]
_TYPES = [t.value for t in WorkItemType]


def kb_relevance_schema() -> dict:
    """judge_kb_relevance: a dynamic index-keyed object (one key per
    retrieved KB snippet offered to the model), each mapped to a closed
    relevant/not_relevant verdict. additionalProperties, not properties --
    keys are runtime snippet indices, not a fixed set."""
    return {
        "name": "kb_relevance",
        "schema": {
            "type": "object",
            "additionalProperties": {"type": "string", "enum": ["relevant", "not_relevant"]},
        },
    }


def trace_links_schema(split_target: bool = True) -> dict:
    """infer_trace_links: whole-document trace/coverage link inference.
    Wrapped in an object with one 'links' array (NOT a top-level array) and
    deliberately NO maxItems -- see this module's header docstring: the
    same grammar-cost cliff section_analysis_schema() already dodges this
    way. 'evidence_quote' is required and validated by the caller
    (trace_links.py's _infer_trace_links_for_nodes) as a literal substring
    of the source node's own text -- this schema only constrains SHAPE
    (the field must exist and be a string), not content; the substring
    check is a real anti-hallucination guard this repo previously had none
    of for this call.

    `split_target` (infer_trace_links v5 on): the target is either a node of the request ('target_node_id') or an identifier the text
    cites ('target_external_id'), one of them empty; before v5 one 'target_ref' carried both."""
    targets = ["target_node_id", "target_external_id"] if split_target else ["target_ref"]
    return {
        "name": "trace_links",
        "schema": {
            "type": "object",
            "properties": {
                "links": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "source_node_id": {"type": "string"},
                            "reference_name": {"type": "string"},
                            **{name: {"type": "string"} for name in targets},
                            "evidence_quote": {"type": "string"},
                        },
                        "required": ["source_node_id", "reference_name", *targets, "evidence_quote"],
                        "additionalProperties": False,
                    },
                }
            },
            "required": ["links"],
            "additionalProperties": False,
        },
    }


def content_authoring_schema() -> dict:
    """author_content: STAGE 3 of the two-stage SURVEY generation split --
    the content half. A dynamic node-id-keyed object (additionalProperties,
    not properties -- keys are the skeleton's own runtime node ids), same
    shape family as parent_summary_schema/title_tags_schema, since the node
    SET is already fixed by stage 1 and this call only fills each one in.
    'tags' is constrained to the closed RequirementTag vocabulary exactly as
    section_analysis_schema constrained it on the old single call; the
    caller's own tag filtering stays as defense-in-depth."""
    return {
        "name": "content_by_node",
        "schema": {
            "type": "object",
            "additionalProperties": {
                "type": "object",
                "properties": {
                    "description": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string", "enum": _TAGS}},
                },
                "required": ["description", "tags"],
            },
        },
    }


def checklist_extraction_schema() -> dict:
    """extract_quality_checklist (app.kb.checklist_extraction): an object with one unbounded 'categories' array of
    strings -- the document's own quality-checklist category/question names, or an empty array when none exists.
    The array is wrapped because Azure OpenAI strict mode refuses a root that is not an object ("schema must be a
    JSON Schema of 'type: object', got 'type: array'" on every GPT call); the client unwraps it. No minItems/
    maxItems -- same "unbounded array avoids Ollama's expensive bounded-repetition GBNF grammar" reasoning as
    section_analysis_schema's own 'nodes' array (see this module's header docstring)."""
    return {
        "name": "quality_checklist",
        "schema": {
            "type": "object",
            "properties": {"categories": {"type": "array", "items": {"type": "string"}}},
            "required": ["categories"],
            "additionalProperties": False,
        },
    }


def checklist_definitions_schema() -> dict:
    """extract_quality_checklist_definitions (app.kb.checklist_extraction):
    a plain object mapping each ALREADY-KNOWN category name (see that
    method's own docstring) to whatever definition/explanation text the
    document itself states for it. additionalProperties (not `properties`)
    since the concrete key set is per-document/per-call, the same dynamic-
    object shape family as the scoring answer's legacy schema -- an empty object is a
    valid, expected response (a checklist with no separate per-category
    prose, just bare names)."""
    return {
        "name": "quality_checklist_definitions",
        "schema": {"type": "object", "additionalProperties": {"type": "string"}},
    }


def title_tags_schema() -> dict:
    """title_and_tags_for_rows (OrchestratorLlmClient, backing
    TitleTagClient/id_tree_builder._apply_title_tag_pass): a dynamic
    row-id-keyed object, same additionalProperties shape family as
    the scoring answer's legacy schema. 'tags' is constrained to the closed RequirementTag
    vocabulary the same way _apply_title_tag_pass's own runtime filter
    (`_VALID_TAGS`) already defends against -- this schema is the
    generation-time tightening, that filter stays as defense-in-depth."""
    return {
        "name": "title_tags_by_row",
        "schema": {
            "type": "object",
            "additionalProperties": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string", "enum": _TAGS}},
                },
                "required": ["title", "tags"],
            },
        },
    }


def parent_summary_schema() -> dict:
    """summarize_parent_nodes (OrchestratorLlmClient, backing
    ParentSummaryClient/id_tree_builder._apply_parent_summary_pass): a
    dynamic node-id-keyed object, same additionalProperties shape family
    as title_tags_schema -- but 'title' and 'description' here, not
    'title'/'tags', since an Epic/Feature has no requirement-tag concept."""
    return {
        "name": "parent_summary_by_node",
        "schema": {
            "type": "object",
            "additionalProperties": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                },
                "required": ["title", "description"],
            },
        },
    }


def synthesis_schema() -> dict:
    """synthesize_leaf_requirements (OrchestratorLlmClient, backing
    SynthesisClient/id_tree_builder._apply_synthesis_pass): a dynamic
    row-id-keyed object, same additionalProperties shape family as
    title_tags_schema, plus the synthesized requirement 'text' itself."""
    return {
        "name": "synthesized_requirements_by_row",
        "schema": {
            "type": "object",
            "additionalProperties": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "text": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string", "enum": _TAGS}},
                },
                "required": ["title", "text", "tags"],
            },
        },
    }


def duplicate_pair_verdict_schema() -> dict:
    """judge_duplicate_pair (OrchestratorLlmClient, backing
    DuplicateJudgeClient/check_for_duplicates.py's dedup-accuracy pass): a
    fixed-shape object: the verdict only (is the candidate the SAME
    real-world requirement as the matched ADO item, or just topically
    similar)."""
    return {
        "name": "duplicate_pair_verdict",
        "schema": {
            "type": "object",
            "properties": {
                "verdict": {"type": "string", "enum": ["redundant", "contradictory", "distinct"]},
            },
            "required": ["verdict"],
            "additionalProperties": False,
        },
    }


def root_group_names_schema() -> dict:
    """name_root_groups (OrchestratorLlmClient): one short title per already-decided group. An array of closed
    {group_id, title} objects (strict-schema compatible); the client folds it into {group_id: title}."""
    return {
        "name": "root_group_names",
        "schema": {
            "type": "object",
            "properties": {
                "names": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"group_id": {"type": "string"}, "title": {"type": "string"}},
                        "required": ["group_id", "title"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["names"],
            "additionalProperties": False,
        },
    }


def kb_document_relevance_schema() -> dict:
    """judge_kb_document_relevance: is this knowledge-base document about creating requirements and the Epic/Feature/
    Requirement hierarchy at all, with a one-sentence reason."""
    return {
        "name": "kb_document_relevance",
        "schema": {
            "type": "object",
            "properties": {"relevant": {"type": "boolean"}, "reason": {"type": "string"}},
            "required": ["relevant", "reason"],
            "additionalProperties": False,
        },
    }


def kb_document_profile_schema() -> dict:
    """extract_kb_document_profile: what one window of a knowledge-base document states about quality categories (with
    pass conditions), the Epic/Feature/Requirement definitions, mandatory writing rules and glossary terms."""
    return {
        "name": "kb_document_profile",
        "schema": {
            "type": "object",
            "properties": {
                "categories": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "pass_condition": {"type": "string"},
                        },
                        "required": ["name", "pass_condition"],
                        "additionalProperties": False,
                    },
                },
                "type_definitions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "item_type": {
                                "type": "string",
                                "enum": ["epic", "feature", "requirement"],
                            },
                            "text": {"type": "string"},
                        },
                        "required": ["item_type", "text"],
                        "additionalProperties": False,
                    },
                },
                "rules": {"type": "array", "items": {"type": "string"}},
                "glossary": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "term": {"type": "string"},
                            "definition": {"type": "string"},
                        },
                        "required": ["term", "definition"],
                        "additionalProperties": False,
                    },
                },
                "obligation_forms": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["categories", "type_definitions", "rules", "glossary", "obligation_forms"],
            "additionalProperties": False,
        },
    }


def sheet_study_schema() -> dict:
    """study_spreadsheet (sheet_study.py): how one sheet is laid out, as column and row numbers only. The caller checks every number
    against the sheet; the schema only fixes the shape, so a column the model cannot name is null and a list it cannot fill is empty."""
    column = {"type": ["integer", "null"]}
    columns = {"type": "array", "items": {"type": "integer"}}
    return {
        "name": "sheet_study",
        "schema": {
            "type": "object",
            "properties": {
                "kind": {"type": "string", "enum": ["requirements_list", "other"]},
                "summary": {"type": "string"},
                "header_rows": {"type": "integer"},
                "id_column": column,
                "title_column": column,
                "text_columns": columns,
                "group_columns": columns,
            },
            "required": ["kind", "summary", "header_rows", "id_column", "title_column", "text_columns", "group_columns"],
            "additionalProperties": False,
        },
    }


_LADDER_OR_UNKNOWN = ["Epic", "Feature", "Requirement", "not_imported", "unknown"]
_BASES = ["same_name", "translation", "hierarchy_position", "none"]


def file_rules_table_schema() -> dict:
    """study_file_rules_table (study/model_rules.py): how one table states its items, as column and row numbers, closed vocabularies and values
    copied from the table. The caller checks every number and value against the table; the schema only fixes the shape."""
    integer_or_null = {"type": ["integer", "null"]}
    return {
        "name": "file_rules_table",
        "schema": {
            "type": "object",
            "properties": {
                "sheet_kind": {"type": "string", "enum": ["work_items", "not_work_items", "unknown"]},
                "header_row": integer_or_null,
                "columns": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "column": {"type": "integer"},
                            "header": {"type": "string"},
                            "role": {
                                "type": "string",
                                "enum": [
                                    "type",
                                    "level_title",
                                    "level_number",
                                    "outline_number",
                                    "id",
                                    "parent_id",
                                    "title",
                                    "customer_id",
                                    "description",
                                    "metadata",
                                ],
                            },
                            "level": integer_or_null,
                        },
                        "required": ["column", "header", "role", "level"],
                        "additionalProperties": False,
                    },
                },
                "nesting": {
                    "type": "string",
                    "enum": ["level_columns", "level_number", "outline_number", "id_parent", "row_order", "unknown"],
                },
                "type_values": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "value": {"type": "string"},
                            "maps_to": {"type": "string", "enum": _LADDER_OR_UNKNOWN},
                            "basis": {"type": "string", "enum": _BASES},
                        },
                        "required": ["value", "maps_to", "basis"],
                        "additionalProperties": False,
                    },
                },
                "level_types": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "level": {"type": "integer"},
                            "maps_to": {"type": "string", "enum": _LADDER_OR_UNKNOWN},
                        },
                        "required": ["level", "maps_to"],
                        "additionalProperties": False,
                    },
                },
                "evidence_rows": {"type": "array", "items": {"type": "integer"}},
            },
            "required": ["sheet_kind", "header_row", "columns", "nesting", "type_values", "level_types", "evidence_rows"],
            "additionalProperties": False,
        },
    }


def file_rules_document_schema() -> dict:
    """study_file_rules_document (study/model_rules.py): how a document states its item types: label conventions copied from its headings and the
    type of each nesting depth. The caller recounts every label over every heading; the schema only fixes the shape."""
    return {
        "name": "file_rules_document",
        "schema": {
            "type": "object",
            "properties": {
                "type_source": {"type": "string", "enum": ["labels", "depth", "labels_and_depth", "none", "unknown"]},
                "labels": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string"},
                            "separator": {"type": "string", "enum": [":", "-", "–", "—", "."]},
                            "maps_to": {"type": "string", "enum": ["Epic", "Feature", "Requirement", "unknown"]},
                            "basis": {"type": "string", "enum": _BASES},
                            "example_headings": {"type": "array", "items": {"type": "integer"}},
                        },
                        "required": ["label", "separator", "maps_to", "basis", "example_headings"],
                        "additionalProperties": False,
                    },
                },
                "depth_types": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "depth": {"type": "integer"},
                            "maps_to": {"type": "string", "enum": ["Epic", "Feature", "Requirement", "unknown"]},
                        },
                        "required": ["depth", "maps_to"],
                        "additionalProperties": False,
                    },
                },
                "evidence_headings": {"type": "array", "items": {"type": "integer"}},
            },
            "required": ["type_source", "labels", "depth_types", "evidence_headings"],
            "additionalProperties": False,
        },
    }


def document_study_schema() -> dict:
    """study_document_window: what one window of the job's document states about its glossary, unresolved-value markers, verification
    wording, cited standards, table roles, list lead-ins and the sentences that state its purpose. Entries are checked against the window text by the caller."""
    strings = {"type": "array", "items": {"type": "string"}}
    return {
        "name": "document_study",
        "schema": {
            "type": "object",
            "properties": {
                "glossary": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "term": {"type": "string"},
                            "definition": {"type": "string"},
                        },
                        "required": ["term", "definition"],
                        "additionalProperties": False,
                    },
                },
                "placeholder_tokens": strings,
                "verification_statements": strings,
                "standards_cited": strings,
                "table_roles": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"table": {"type": "string"}, "role": {"type": "string"}},
                        "required": ["table", "role"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": [
                "glossary",
                "placeholder_tokens",
                "verification_statements",
                "standards_cited",
                "table_roles",
            ],
            "additionalProperties": False,
        },
    }


def acceptance_criteria_schema() -> dict:
    """propose_acceptance_criteria: one entry per requirement with proposed criteria, the assumptions behind them, and whether a value
    the criteria depend on is missing from the input."""
    return {
        "name": "acceptance_criteria",
        "schema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "criteria": {"type": "array", "items": {"type": "string"}},
                            "assumptions": {"type": "array", "items": {"type": "string"}},
                            "needs_author_input": {"type": "boolean"},
                            "missing": {"type": "array", "items": {"type": "string"}},
                        },
                        "required": ["id", "criteria", "assumptions", "needs_author_input", "missing"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["items"],
            "additionalProperties": False,
        },
    }


CONFORMANCE_VERDICTS = ("conforms", "violates", "not_applicable")


def rule_conformance_schema(not_applicable: bool = True) -> dict:
    """judge_rule_conformance: for each given item, whether its text follows one stated writing rule. `not_applicable`
    (judge_rule_conformance v2 on): a 'verdict' of conforms / violates / not_applicable; before v2 a boolean 'conforms', with a rule that
    does not apply counted as conforming."""
    verdict = (
        {"verdict": {"type": "string", "enum": list(CONFORMANCE_VERDICTS)}}
        if not_applicable
        else {"conforms": {"type": "boolean"}}
    )
    return {
        "name": "rule_conformance",
        "schema": {
            "type": "object",
            "properties": {
                "verdicts": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"id": {"type": "string"}, **verdict},
                        "required": ["id", *verdict],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["verdicts"],
            "additionalProperties": False,
        },
    }


def kb_category_consolidation_schema() -> dict:
    """consolidate_kb_categories: the knowledge base's quality categories merged by meaning into a short list, each with
    one pass condition and the names it replaces."""
    return {
        "name": "kb_category_consolidation",
        "schema": {
            "type": "object",
            "properties": {
                "categories": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "pass_condition": {"type": "string"},
                            "merged_from": {"type": "array", "items": {"type": "string"}},
                        },
                        "required": ["name", "pass_condition", "merged_from"],
                        "additionalProperties": False,
                    },
                }
            },
            "required": ["categories"],
            "additionalProperties": False,
        },
    }


def standard_requirements_schema() -> dict:
    """find_standard_requirements: whether the organization's material requires the active voice and a stated rationale, each with
    the words that say so."""
    answer = {
        "type": "object",
        "properties": {"required": {"type": "boolean"}, "quote": {"type": "string"}},
        "required": ["required", "quote"],
        "additionalProperties": False,
    }
    return {
        "name": "standard_requirements",
        "schema": {
            "type": "object",
            "properties": {"active_voice": answer, "rationale": answer},
            "required": ["active_voice", "rationale"],
            "additionalProperties": False,
        },
    }


def score_explanation_schema() -> dict:
    """explain_category_scores: one short reason per category the author asked about."""
    return {
        "name": "score_explanation",
        "schema": {
            "type": "object",
            "properties": {
                # First on purpose: naming the item's language before writing any reason keeps the model from drifting into another one.
                "language": {"type": "string"},
                "explanations": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "category": {"type": "string"},
                            "reason": {"type": "string"},
                        },
                        "required": ["category", "reason"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["language", "explanations"],
            "additionalProperties": False,
        },
    }


def obligation_forms_schema() -> dict:
    """find_obligation_forms: the phrases, copied from the document, its requirements use to state an obligation. The caller drops any
    the document does not contain."""
    return {
        "name": "obligation_forms",
        "schema": {
            "type": "object",
            "properties": {"obligation_forms": {"type": "array", "items": {"type": "string"}}},
            "required": ["obligation_forms"],
            "additionalProperties": False,
        },
    }
