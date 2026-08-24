/* eslint-disable */
/**
 * This file was automatically generated from shared/schemas/canonical-doc.schema.json.
 * DO NOT EDIT — run `pnpm --filter @req2ado/shared-ts generate` instead.
 */

/**
 * Normalized representation of an ingested source document. Single source of truth — generate TS types (shared/ts) and pydantic models (shared/py) from this file; never hand-edit the generated code.
 */
export interface CanonicalDoc {
  document: {
    path: string;
    format: 'txt' | 'md' | 'docx' | 'pdf' | 'pdf_scanned' | 'xlsx' | 'pptx' | 'csv' | 'rtf' | 'image';
    sha256: string;
  };
  blocks: Block[];
  tables: Table[];
  figures: Figure[];
  /**
   * Figure ids whose storage (during /ingest) failed -- still captioned, but not viewable/attachable later. Never populated by /level; ado_verification_failed's own WarningKind precedent applies -- the orchestrator, not ingestion, turns a non-empty list here into its own synthesized WarningRecord.
   */
  failed_figure_storage_ids?: string[];
  /**
   * Whether /ingest actually opened the vision-LLM gate for this document (False for BASELINE, a preview call, or no vision model configured). Round-tripped from /ingest's response through /level's own `doc` request body -- consumed there to emit a single tree-level WarningKind.vision_captioning_disabled warning when False and figures is non-empty.
   */
  vision_active?: boolean;
}
export interface Block {
  id: string;
  kind: 'heading' | 'paragraph' | 'list_item' | 'table' | 'figure' | 'note' | 'open_tbd';
  text: string;
  heading_level?: number | null;
  /**
   * e.g. '1.1.1', '1.1.1.a'
   */
  number_label?: string | null;
  source_ref: SourceRef;
}
export interface SourceRef {
  document_path: string;
  start_offset: number;
  end_offset: number;
  page?: number | null;
  /**
   * Last page this ref's content covers. Null means same as page, or unknown.
   */
  page_end?: number | null;
  /**
   * Null = real pagination from the file itself. 'rendered' = derived via a re-render (e.g. docx->PDF for pagination). 'interpolated' = bracketed between anchors, not directly matched.
   */
  page_provenance?: string | null;
  /**
   * Root-first heading/section labels for the section this ref was parsed from. Empty when no heading ancestry applies.
   */
  section_path?: string[];
}
export interface Table {
  id: string;
  /**
   * Row-major grid. null at a position means it's SPANNED (absorbed by a preceding cell's colspan/rowspan) -- render no <td> there. A real TableCell with text:"" at a position is a genuine GAP (e.g. an empty PDF-detected cell) -- render an empty <td>. Every row has the same length (validated) -- a merge/gridBefore/gridAfter mismatch is a bug, not a valid shape.
   */
  cells: (TableCell | null)[][];
  /**
   * Fractions of table width (never source units like twips/EMU/chars/points) -- must sum to ~1.0 when present.
   */
  column_widths?: number[] | null;
  /**
   * Deliberately coarse -- not a full per-side border spec.
   */
  border_style?: 'none' | 'grid' | 'outer' | null;
  /**
   * Null = read from explicit source markup. 'heuristic' = geometrically/heuristically inferred (PDF only). Mirrors SourceRef.page_provenance's precedent.
   */
  style_provenance?: string | null;
  caption?: string | null;
  source_ref: SourceRef;
}
export interface TableCell {
  text: string;
  colspan?: number;
  rowspan?: number;
  is_header?: boolean;
  bold?: boolean;
  /**
   * Normalized #rrggbb, contrast-adapted for dual light/dark theme safety. 'No fill' (auto/white/near-white) is normalized to null, not a literal white.
   */
  background_color?: string | null;
  /**
   * Normalized #rrggbb, contrast-adapted -- see background_color.
   */
  text_color?: string | null;
  align?: 'left' | 'center' | 'right' | 'justify' | null;
  /**
   * Set when this cell's text could not be extracted directly and was recovered via OCR on a rendered crop -- see TableCell.ocr_recovered's own docstring in canonical/model.py.
   */
  ocr_recovered?: boolean;
}
export interface Figure {
  id: string;
  caption?: string | null;
  /**
   * The author's own short title for this figure, parsed from a 'Figure N: Title' caption line in the source document itself, or an LLM-generated short title when the document provides no caption line of its own. Distinct from `caption` (the vision model's prose description): `name` is a short noun phrase meant for display (UI label, ADO attachment filename).
   */
  name?: string | null;
  source_ref: SourceRef;
  /**
   * Why `caption` is null, when it is. 'insignificant': the vision model judged the figure decorative/non-technical. 'vision_failed': the vision call itself errored/timed out or returned an unparseable response. Null both when a real caption was produced AND when vision never ran for this figure at all (disabled for the whole run, or BASELINE mode) -- the latter is deliberately not distinguished here; see CanonicalDoc.vision_active and WarningKind.vision_captioning_disabled for that case instead.
   */
  caption_status?: 'insignificant' | 'vision_failed' | null;
}
