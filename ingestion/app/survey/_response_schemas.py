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

IMPORTANT -- why there is no schema here for infer_hierarchy/
infer_trace_links/generate_requirements (single-block): all three would
need a TOP-LEVEL ARRAY schema sized to real branch content (up to
_MAX_SURVEY_BRANCH_BLOCK_COUNT=200 items). Observed live: Ollama's GBNF
grammar-constrained decoding (llama.cpp under the hood, confirmed NOT
XGrammar) compiles a bounded-repetition grammar from a maxItems-sized array
over a complex item shape whether or not the model actually emits that many
items -- the cost is schema-declared, not runtime-output-driven. On a
~200-item branch this wedged the ENTIRE Ollama server (single inference
slot, `-np 1`) for 10+ minutes, unresponsive to even unrelated requests,
matching the documented failure mode in ollama/ollama#1910 and the
"performance gotchas" llama.cpp's own grammar docs describe for bounded
repetition over complex items. A smaller maxItems doesn't meaningfully
help -- real branches legitimately need up to 200 entries, and any bound
tight enough to avoid the grammar-cost cliff would also truncate real
hierarchies. The three additionalProperties-object schemas below don't hit
this: `maxProperties` is silently ignored by Ollama's converter for
additionalProperties objects, so they compile to a cheap unbounded-star
grammar regardless -- which is exactly why they're safe to keep. DO NOT
re-add response_format to a top-level array schema without re-verifying
this against whatever Ollama version is in use at the time.
"""
from __future__ import annotations

from app.workitem.model import RequirementQualityIssue, RequirementTag, WorkItemType

_TAGS = [t.value for t in RequirementTag]
_ISSUES = [t.value for t in RequirementQualityIssue]
_TYPES = [t.value for t in WorkItemType]


def scores_schema() -> dict:
    """score_requirements_for_document: a dynamic node_id-keyed object --
    additionalProperties (not properties), since keys are runtime node_ids,
    not a fixed set. Constrains 'issues' to the closed RequirementQualityIssue
    vocabulary and 'score' to an integer 0-100.

    categoryScores gives a per-dimension breakdown backing the single
    overall 'score' -- see QualityCategoryScores' own docstring (app.
    workitem.model) for why a lone number + closed issue tags wasn't
    informative enough ("what exactly is wrong, what's actually fine").
    Its OWN keys are dynamic too (additionalProperties, not a fixed 5-key
    'properties' list) -- confirmed real gap fixed here: an org's ingested
    KB quality checklist can define its own category names (e.g. Necessary/
    Unambiguous/Verifiable/...), which a fixed 5-key schema could never
    accept regardless of what the prompt asked for. Same dynamic-key
    pattern this module's header docstring already established to dodge
    Ollama's bounded-array grammar-cost cliff -- a dynamic OBJECT schema,
    unlike a bounded ARRAY, has never shown that cost."""
    return {
        "name": "scores_by_node",
        "schema": {
            "type": "object",
            "additionalProperties": {
                "type": "object",
                "properties": {
                    "score": {"type": "integer", "minimum": 0, "maximum": 100},
                    "issues": {"type": "array", "items": {"type": "string", "enum": _ISSUES}},
                    "categoryScores": {
                        "type": "object",
                        "additionalProperties": {"type": "integer", "minimum": 0, "maximum": 100},
                    },
                },
                "required": ["score", "issues", "categoryScores"],
            },
        },
    }


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


def section_analysis_schema() -> dict:
    """analyze_section / analyze_section_agentic: the model returns a
    COMPLETE flat node set for one whole section in a single call --
    replacing the old infer_hierarchy + generate_requirements_for_document
    two-call, one-node-per-input-block contract. Wrapped in an object with
    one 'nodes' array (NOT a top-level array) and deliberately NO maxItems --
    see this module's header docstring: a maxItems-bounded top-level array
    compiles to Ollama's expensive bounded-repetition GBNF grammar and wedged
    the server for 10+ minutes; an unbounded array avoids that cliff the same
    way the additionalProperties objects above do. 'parent_temp_id' is a
    plain nullable string referencing another node's temp_id in the SAME
    array (or null for a section root) -- no recursive $ref needed.

    'figure_ids'/'table_ids' (added for known-issues item 20): which of the
    section's own candidate figure/table ids (rendered inline in the section
    text -- see llm_leveling.render_section) this node judges relevant.
    Deliberately NOT in `required` -- most nodes have no relevant
    figure/table at all, and requiring an always-empty array on every node
    would just be prompt-compliance noise for the common case. Plain
    unbounded string arrays, same shape as `tags` above -- no maxItems, no
    enum (ids are per-document, not a closed vocabulary) -- so this doesn't
    reintroduce the bounded-repetition grammar cliff this module's header
    docstring warns about."""
    return {
        "name": "section_analysis",
        "schema": {
            "type": "object",
            "properties": {
                "nodes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "temp_id": {"type": "string"},
                            "type": {"type": "string", "enum": _TYPES},
                            "parent_temp_id": {"type": ["string", "null"]},
                            "title": {"type": "string"},
                            "text": {"type": "string"},
                            "tags": {"type": "array", "items": {"type": "string", "enum": _TAGS}},
                            "figure_ids": {"type": "array", "items": {"type": "string"}},
                            "table_ids": {"type": "array", "items": {"type": "string"}},
                        },
                        "required": ["temp_id", "type", "parent_temp_id", "title", "text", "tags"],
                    },
                }
            },
            "required": ["nodes"],
        },
    }


def section_skeleton_schema() -> dict:
    """analyze_section_skeleton / analyze_section_skeleton_agentic: STAGE 1
    of the two-stage SURVEY generation split -- the structure half of what
    section_analysis_schema above used to ask for in one call. Same
    object-wrapped, deliberately unbounded 'nodes' array (see that schema's
    own docstring and this module's header for why a maxItems-bounded array
    is the expensive case for Ollama's GBNF grammar), minus every content
    field: no 'text', no 'tags', no 'figure_ids'/'table_ids'. A node here is
    purely 'which node exists, what type is it, whose child is it, what is
    it called' -- the content half is authored separately against this
    already-fixed skeleton (see content_authoring_schema below), and
    figure/table attachment is a separate whole-document mapping pass that
    runs between the two."""
    return {
        "name": "section_skeleton",
        "schema": {
            "type": "object",
            "properties": {
                "nodes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "temp_id": {"type": "string"},
                            "type": {"type": "string", "enum": _TYPES},
                            "parent_temp_id": {"type": ["string", "null"]},
                            "title": {"type": "string"},
                        },
                        "required": ["temp_id", "type", "parent_temp_id", "title"],
                    },
                }
            },
            "required": ["nodes"],
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


def figure_table_mapping_schema() -> dict:
    """map_figures_tables: STAGE 2 of the two-stage SURVEY generation split --
    which EXACT node (if any) each of the document's figures/tables belongs
    to. A dynamic ITEM-id-keyed object (additionalProperties, not properties
    -- keys are the runtime figure/table ids offered in this call), same
    shape family as content_authoring_schema/scores_schema, and the same
    reason this module's header docstring gives for preferring a dynamic
    object over a bounded array.

    Three distinct outcomes per item, deliberately expressed as two fields
    rather than one tri-state string (a nullable id plus a boolean is
    directly checkable; a magic 'NONE'/'ESCALATE' sentinel string would
    collide with the id space it shares): 'node_id' names a candidate offered
    in THIS call (validated against that real candidate set by the caller --
    see llm_leveling._map_figures_tables_to_nodes, which drops a hallucinated
    id with WarningKind.INVALID_MAPPING_TARGET); 'node_id': null with
    'escalate': false is the deliberate "belongs to no work item at all"
    (decorative) verdict; 'escalate': true is "this item's real home is
    somewhere else in the document, outside the candidates offered here",
    which sends it to the whole-document escalation tier."""
    return {
        "name": "figure_table_mapping",
        "schema": {
            "type": "object",
            "additionalProperties": {
                "type": "object",
                "properties": {
                    "node_id": {"type": ["string", "null"]},
                    "escalate": {"type": "boolean"},
                },
                "required": ["node_id", "escalate"],
            },
        },
    }


def requirements_by_node_schema() -> dict:
    """generate_requirements_for_document: a dynamic node_id-keyed object,
    same additionalProperties shape as scores_schema, each value a list of
    {text, tags} requirements for that node."""
    return {
        "name": "requirements_by_node",
        "schema": {
            "type": "object",
            "additionalProperties": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "text": {"type": "string"},
                        "tags": {"type": "array", "items": {"type": "string", "enum": _TAGS}},
                    },
                    "required": ["text"],
                },
            },
        },
    }


def checklist_extraction_schema() -> dict:
    """extract_quality_checklist (app.kb.checklist_extraction): a plain
    unbounded array of strings -- the document's own quality-checklist
    category/question names, or an empty array when none exists. No
    minItems/maxItems -- same "unbounded array avoids Ollama's expensive
    bounded-repetition GBNF grammar" reasoning as section_analysis_schema's
    own 'nodes' array (see this module's header docstring)."""
    return {
        "name": "quality_checklist",
        "schema": {"type": "array", "items": {"type": "string"}},
    }


def checklist_definitions_schema() -> dict:
    """extract_quality_checklist_definitions (app.kb.checklist_extraction):
    a plain object mapping each ALREADY-KNOWN category name (see that
    method's own docstring) to whatever definition/explanation text the
    document itself states for it. additionalProperties (not `properties`)
    since the concrete key set is per-document/per-call, the same dynamic-
    object shape family as scores_schema below -- an empty object is a
    valid, expected response (a checklist with no separate per-category
    prose, just bare names)."""
    return {
        "name": "quality_checklist_definitions",
        "schema": {"type": "object", "additionalProperties": {"type": "string"}},
    }


def epic_feature_scores_schema() -> dict:
    """score_epics_and_features_for_document: a dynamic node_id-keyed
    object -- additionalProperties (not properties), same shape family as
    scores_schema. No 'issues' field here -- RequirementQualityIssue's
    closed vocabulary (ambiguous, not_testable, compound, ...) describes
    atomic 'shall' statements, not what an Epic/Feature grouping IS (see
    llm_leveling.py's own comment on why quality scoring was originally
    scoped to Requirement-type nodes only); Epic/Feature review is
    score + categoryScores only."""
    return {
        "name": "epic_feature_scores_by_node",
        "schema": {
            "type": "object",
            "additionalProperties": {
                "type": "object",
                "properties": {
                    "score": {"type": "integer", "minimum": 0, "maximum": 100},
                    "categoryScores": {
                        "type": "object",
                        "additionalProperties": {"type": "integer", "minimum": 0, "maximum": 100},
                    },
                },
                "required": ["score", "categoryScores"],
            },
        },
    }


def title_tags_schema() -> dict:
    """title_and_tags_for_rows (OrchestratorLlmClient, backing
    TitleTagClient/id_tree_builder._apply_title_tag_pass): a dynamic
    row-id-keyed object, same additionalProperties shape family as
    scores_schema. 'tags' is constrained to the closed RequirementTag
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


def duplicate_cluster_verdict_schema() -> dict:
    """judge_duplicate_cluster (OrchestratorLlmClient): a FIXED-shape
    object, not a dynamic row-id-keyed one -- one verdict per cluster
    call, not one per node (see this method's own docstring for why:
    redundant/contradictory/distinct is a judgment about the CLUSTER as a
    whole, not any single member of it)."""
    return {
        "name": "duplicate_cluster_verdict",
        "schema": {
            "type": "object",
            "properties": {
                "verdict": {"type": "string", "enum": ["redundant", "contradictory", "distinct"]},
                "conflicting_values": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["verdict", "conflicting_values"],
        },
    }


def duplicate_pair_verdict_schema() -> dict:
    """judge_duplicate_pair (OrchestratorLlmClient, backing
    DuplicateJudgeClient/check_for_duplicates.py's dedup-accuracy pass): a
    fixed-shape object like duplicate_cluster_verdict_schema, but no
    'conflicting_values' -- this call only ever needs the verdict itself
    (is the candidate the SAME real-world requirement as the matched ADO
    item, or just topically similar), never the numeric-conflict detail
    that's specific to the within-job cluster judge."""
    return {
        "name": "duplicate_pair_verdict",
        "schema": {
            "type": "object",
            "properties": {
                "verdict": {"type": "string", "enum": ["redundant", "contradictory", "distinct"]},
            },
            "required": ["verdict"],
        },
    }


def distill_title_schema() -> dict:
    """distill_title (OrchestratorLlmClient, backing TitleDistillationClient/
    distill_survey_title -- 300553's smart-title fallback): the single
    field this call ever needs, a replacement title for a node whose
    stage-1 title was too generic/short. Length enforcement itself is NOT
    trusted to the model (distill_survey_title re-truncates defensively via
    extract_baseline_title) -- this schema only constrains the response
    shape, not the string's length."""
    return {
        "name": "distilled_title",
        "schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
            },
            "required": ["title"],
        },
    }


def root_grouping_schema() -> dict:
    """group_root_topics (OrchestratorLlmClient): a fixed 'groups' array,
    each item a title + member id list. Unbounded (no maxItems) on both
    the outer array and each group's member_ids -- see this module's own
    header docstring on why a BOUNDED array is the expensive case for
    Ollama's GBNF grammar compilation, not an unbounded one."""
    return {
        "name": "root_topic_groups",
        "schema": {
            "type": "object",
            "properties": {
                "groups": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "member_ids": {"type": "array", "items": {"type": "string"}},
                        },
                        "required": ["title", "member_ids"],
                    },
                },
            },
            "required": ["groups"],
        },
    }


def leftover_assignment_schema() -> dict:
    """assign_leftover_roots (OrchestratorLlmClient): a single free-form
    'assignments' object mapping a leftover node id to a group id --
    unbounded (no fixed property list), same "unbounded is the cheap case
    for Ollama's GBNF grammar compilation" reasoning as root_grouping_
    schema above, and the natural shape for "however many of these end up
    placed, could be zero"."""
    return {
        "name": "leftover_root_assignments",
        "schema": {
            "type": "object",
            "properties": {
                "assignments": {"type": "object"},
            },
            "required": ["assignments"],
        },
    }
