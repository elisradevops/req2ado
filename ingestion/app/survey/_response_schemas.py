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

from app.config import settings
from app.workitem.model import QualityConfidence, RequirementQualityIssue, RequirementTag, WorkItemType

_TAGS = [t.value for t in RequirementTag]
_ISSUES = [t.value for t in RequirementQualityIssue]
_TYPES = [t.value for t in WorkItemType]
_CONFIDENCE = [c.value for c in QualityConfidence]


def keyed_schema(response_schema: dict) -> dict | None:
    """The `responseSchema` to send for one of this module's id-keyed
    (`additionalProperties` map) schemas, per `settings.keyed_schema_mode`:
    None ("none", the default) means send no strict schema at all.

    Why not the open map by default: it is not valid strict JSON Schema on
    Anthropic or OpenAI/Azure (both require `additionalProperties: false`), and
    where it is accepted it collapses to `{}` -- confirmed in prod against
    claude-opus-4-8 (every keyed pass reported "omitted N of N"). Why not
    per-call explicit keys: grammar size (>= 50 keys is rejected as "compiled
    grammar is too large") and Azure's 100-property cap. The prompts already
    state the exact output shape, so these passes run prompt-only until the
    fixed array-of-entries schema replaces them."""
    return response_schema if settings.keyed_schema_mode == "legacy_map" else None


def keyed_schema_field(response_schema: dict) -> dict:
    """`keyed_schema` as a payload fragment: {"responseSchema": ...} or {}, for
    call sites that build their request dict inline."""
    schema = keyed_schema(response_schema)
    return {"responseSchema": schema} if schema is not None else {}


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
    unlike a bounded ARRAY, has never shown that cost.

    'confidence' is the abstain channel added for SWEEP.md section 7 -- see
    QualityConfidence's own docstring (app.workitem.model) for why a closed
    3-value enum rather than a second number, and why a 'low' value flags an
    item for review without excluding it from any aggregate."""
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
                    # SWEEP.md section 7's abstain channel: a closed 3-value
                    # enum (see QualityConfidence, app.workitem.model), in
                    # `required` on purpose -- an optional field on a call
                    # whose prompt already demands exactly N entries would
                    # just be omitted every time. A scalar enum inside an
                    # existing additionalProperties object adds no bounded
                    # repetition, so this does NOT reintroduce the grammar-
                    # cost cliff this module's header docstring documents.
                    "confidence": {"type": "string", "enum": _CONFIDENCE},
                },
                "required": ["score", "issues", "categoryScores", "confidence"],
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


def trace_links_schema() -> dict:
    """infer_trace_links: whole-document trace/coverage link inference.
    Wrapped in an object with one 'links' array (NOT a top-level array) and
    deliberately NO maxItems -- see this module's header docstring: the
    same grammar-cost cliff section_analysis_schema() already dodges this
    way. 'evidence_quote' is required and validated by the caller
    (trace_links.py's _infer_trace_links_for_nodes) as a literal substring
    of the source node's own text -- this schema only constrains SHAPE
    (the field must exist and be a string), not content; the substring
    check is a real anti-hallucination guard this repo previously had none
    of for this call."""
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
                            "target_ref": {"type": "string"},
                            "evidence_quote": {"type": "string"},
                        },
                        "required": ["source_node_id", "reference_name", "target_ref", "evidence_quote"],
                        "additionalProperties": False,
                    },
                }
            },
            "required": ["links"],
            "additionalProperties": False,
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
    runs between the two.

    'customer_id' is the one deliberate exception to "no content fields":
    it is structural, not content -- the source document's OWN identity for
    the row/item this node came from, which is precisely the evidence that
    a row-splitting decision (see section_skeleton.v1.txt's table-
    classification paragraph) was made correctly, and it is only available
    to the pass that makes that decision. Nullable-string, not required --
    most nodes (every Epic/Feature, and any un-numbered Requirement) have
    none, and forcing an always-null field onto every node is prompt-
    compliance noise for no benefit; null is a real, distinct value from an
    absent/empty string, same shape as 'parent_temp_id' above."""
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
                            "customer_id": {"type": ["string", "null"]},
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
            "additionalProperties": False,
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
            "additionalProperties": False,
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
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["groups"],
            "additionalProperties": False,
        },
    }


def leftover_assignment_schema() -> dict:
    """assign_leftover_roots (OrchestratorLlmClient): an 'assignments' ARRAY of {id, group_id} pairs (the client
    folds it back into the {leftover_id: group_id} map callers read). A free-form object has no fixed property
    list, which strict-schema providers refuse; an array of closed objects is accepted everywhere. Unbounded (no
    maxItems) -- "however many end up placed, could be zero" -- see this module's header on why a bounded array is
    the costly case."""
    return {
        "name": "leftover_root_assignments",
        "schema": {
            "type": "object",
            "properties": {
                "assignments": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"id": {"type": "string"}, "group_id": {"type": "string"}},
                        "required": ["id", "group_id"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["assignments"],
            "additionalProperties": False,
        },
    }
