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
    vocabulary and 'score' to an integer 0-100."""
    return {
        "name": "scores_by_node",
        "schema": {
            "type": "object",
            "additionalProperties": {
                "type": "object",
                "properties": {
                    "score": {"type": "integer", "minimum": 0, "maximum": 100},
                    "issues": {"type": "array", "items": {"type": "string", "enum": _ISSUES}},
                },
                "required": ["score", "issues"],
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
    array (or null for a section root) -- no recursive $ref needed."""
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
                        },
                        "required": ["temp_id", "type", "parent_temp_id", "title", "text", "tags"],
                    },
                }
            },
            "required": ["nodes"],
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
