/* eslint-disable */
/**
 * This file was automatically generated from shared/schemas/work-item-tree.schema.json.
 * DO NOT EDIT — run `pnpm --filter @req2ado/shared-ts generate` instead.
 */

/**
 * Canonical hierarchy produced by the leveling engine, ready for distillation and MCP write-back. Single source of truth — generate TS types (shared/ts) and pydantic models (shared/py) from this file.
 */
export interface WorkItemTree {
  nodes: WorkItemNode[];
  /**
   * Non-fatal integrity signals surfaced to a human reviewer. Always [] for BASELINE.
   */
  warnings?: string[];
  kb_citations?: KbCitation[];
  trace_links?: TraceLink[];
}
export interface WorkItemNode {
  local_id: string;
  type: 'Epic' | 'Feature' | 'Requirement';
  parent_local_id: string | null;
  title: string;
  description: string;
  customer_id?: string | null;
  source_ref: {
    document_path: string;
    start_offset: number;
    end_offset: number;
    page?: number | null;
  };
  /**
   * sha256 over the normalized verbatim source span. Required in BASELINE mode, null in SURVEY.
   */
  fidelity_hash?: string | null;
  /**
   * Idempotency key input (orchestrator's sourceHash): description + this node's own fixed source position. Distinct from fidelity_hash (drift detection). Null for a node shape predating this field.
   */
  identity_hash?: string | null;
  tags?: (
    | 'functional'
    | 'non_functional'
    | 'interface'
    | 'performance'
    | 'regulatory'
    | 'safety'
    | 'security'
    | 'operation'
    | 'maintenance'
    | 'feature'
    | 'behavior'
  )[];
  /**
   * SURVEY-only: ids of this section's own candidate figures the LLM judged relevant to this node (see llm_leveling.render_section's figure id injection). Link-only today -- does not drive an ADO attachment (no upload capability exists yet).
   */
  figure_ids?: string[];
  /**
   * SURVEY-only: ids of this section's own candidate tables the LLM judged relevant to this node. A non-empty list means that table's HTML is already embedded into `description` (see _table_to_html).
   */
  table_ids?: string[];
  mode: 'BASELINE' | 'SURVEY';
  /**
   * Default work-item type for a new manual child added under this node. Null when ineligible or unresolvable.
   */
  child_type?: 'Epic' | 'Feature' | 'Requirement' | null;
  /**
   * SURVEY-only: how much of the generated description's vocabulary appears in its source block. Null for BASELINE (trivially fully grounded) or when scoring wasn't enabled.
   */
  grounding_score?: number | null;
  /**
   * SURVEY-only: 0-100 quality judgment of the final description. Null for BASELINE or when no scoring_client was supplied.
   */
  quality_score?: number | null;
  quality_issues?: (
    | 'ambiguous'
    | 'not_testable'
    | 'compound'
    | 'missing_acceptance_criteria'
    | 'vague_term'
    | 'passive_voice'
    | 'missing_rationale'
    | 'not_a_requirement'
    | 'fragment'
    | 'placeholder'
    | 'open_item_tbd'
    | 'rationale_as_requirement'
    | 'conflicting_value'
  )[];
  /**
   * Per-dimension 0-100 breakdown backing quality_score. Dynamic keys (KB-checklist-derived) or the 5-dimension fallback (clarity/testability/atomicity/style/rationale). Null whenever quality_score is null.
   */
  quality_category_scores?: {
    [k: string]: number;
  } | null;
}
export interface KbCitation {
  source_file: string;
  similarity: number;
  relevance?: 'relevant' | 'not_relevant' | 'unknown';
}
export interface TraceLink {
  source_local_id: string;
  reference_name: string;
  display_name: string;
  target_kind: 'intraJob' | 'crossJob';
  target_local_id?: string | null;
  target_customer_id?: string | null;
  resolution_status: 'resolved' | 'unresolved' | 'pending';
}
