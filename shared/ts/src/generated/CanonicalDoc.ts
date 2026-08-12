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
}
export interface Figure {
  id: string;
  caption?: string | null;
  source_ref: SourceRef;
}
