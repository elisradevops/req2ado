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
  warnings?: IntegrityWarning[];
  kb_citations?: KbCitation[];
  trace_links?: TraceLink[];
  /**
   * Doc-wide (never per-node): figures SURVEY's figure/table mapping stage judged structurally irrelevant to every work item, or could not place because the mapping call failed. Never present in any node's figure_ids. Always [] for BASELINE.
   */
  excluded_figure_ids?: string[];
  /**
   * Doc-wide (never per-node): tables SURVEY's figure/table mapping stage judged structurally irrelevant to every work item, or could not place because the mapping call failed. Never present in any node's table_ids. Always [] for BASELINE.
   */
  excluded_table_ids?: string[];
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
    /**
     * Last page this node's folded content covers. Null means same as page, or unknown -- never set without page also being set.
     */
    page_end?: number | null;
    /**
     * Null when page/page_end came from the file's own real pagination (PDF, OCR, pptx slide index). 'rendered' when derived by re-rendering the source through a different layout engine (e.g. docx converted to PDF for pagination purposes). 'interpolated' when bracketed between confidently-matched anchors rather than directly matched.
     */
    page_provenance?: string | null;
    /**
     * Root-first heading/section labels for the section this ref was parsed from, e.g. ["3 Power", "3.2 Backplane"]. Empty when no heading ancestry applies.
     */
    section_path?: string[];
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
   * Ids of figures folded into/relevant to this node -- populated by all 4 node-building paths (BASELINE, deterministic heading/ID-tree, deterministic span-fold, SURVEY's LLM branch), not SURVEY-only. For SURVEY this is the LLM's own judged-relevant subset (see llm_leveling.render_section's figure id injection); for the deterministic paths it's every figure whose block folded into this node's span, no LLM judgment involved.
   */
  figure_ids?: string[];
  /**
   * Ids of tables folded into/relevant to this node -- populated by all 4 node-building paths, not SURVEY-only (see figure_ids' description for the same distinction). A non-empty list means that table's HTML is already embedded into `description` (see _table_to_html).
   */
  table_ids?: string[];
  /**
   * Figures that folded into this node's span but produced no caption (vision disabled, the vision call failed, or the model returned the no-technical-content sentinel) -- disjoint from figure_ids, a figure id appears in exactly one of the two lists.
   */
  uncaptioned_figure_ids?: string[];
  /**
   * SUBSET of uncaptioned_figure_ids -- the figures among that list whose Figure.caption_status is 'insignificant' (the vision model judged them decorative/non-technical, not a failed vision call). Only meaningful when vision was actually active for this run; an id present in uncaptioned_figure_ids but absent here is a genuine vision_failed case (or vision was off for the whole run -- see WarningKind.vision_captioning_disabled for that case instead).
   */
  insignificant_figure_ids?: string[];
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
  /**
   * Per-category citation text backing a subset of quality_category_scores' keys -- maps a category key to the org's own ingested quality-checklist document's stated definition for it, when one was found (see KbVectorStore.get_quality_checklist_definitions). Not all-or-nothing like quality_category_scores: a category absent from this map is a real, expected case (no KB standard at all, or the org's document states no separate definition for that one category), not a parse failure. Null when nothing matched.
   */
  quality_category_checklist?: {
    [k: string]: string;
  } | null;
}
export interface IntegrityWarning {
  /**
   * Closed vocabulary (app.workitem.model.WarningKind). ado_verification_failed is deliberately absent -- that kind is only ever added by the orchestrator's own post-processing, never by ingestion's /level response this schema describes.
   */
  kind:
    | 'reparented_to_feature'
    | 'group_reparented'
    | 'bridge_feature_synthesized'
    | 'roots_regrouped'
    | 'catchall_epic_wrap'
    | 'near_duplicate_conflict'
    | 'output_truncated'
    | 'no_model_title'
    | 'invalid_figure_ids'
    | 'invalid_table_ids'
    | 'invalid_node_type'
    | 'dangling_parent'
    | 'low_grounding'
    | 'zero_nodes'
    | 'dropped_blocks'
    | 'missing_table_group_coverage'
    | 'external_reference'
    | 'scoring_failed'
    | 'scoring_missing'
    | 'scoring_inconsistent_categories'
    | 'enhancement_call_failed'
    | 'enhancement_response_incomplete'
    | 'dropped_row'
    | 'front_matter_folded'
    | 'trace_link_inference_failed'
    | 'heading_id_offset_mismatch'
    | 'unsupported_content_note'
    | 'empty_table_content'
    | 'vision_captioning_disabled'
    | 'invalid_mapping_target'
    | 'mapping_call_failed';
  /**
   * auto_fixed: deterministic code already resolved it, no action needed. needs_review: an AI/heuristic judgment call a human should verify. pipeline_issue: something broke or was incomplete for this run.
   */
  severity: 'auto_fixed' | 'needs_review' | 'pipeline_issue';
  /**
   * Affected local ids, if any -- what a 'Review item' UI affordance iterates over. Empty when the warning describes content that never became a node (e.g. a dropped row/block).
   */
  node_ids: string[];
  /**
   * Kind-specific structured payload (e.g. targetFeatureId, threshold, rawType) -- see each WarningKind's own emission site for its shape.
   */
  detail: {};
  /**
   * The fully-formed human sentence -- always populated, so a client that doesn't recognize `kind` yet can still show something sane.
   */
  raw: string;
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
