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
}
export interface Table {
  id: string;
  rows: string[][];
  caption?: string | null;
  source_ref: SourceRef;
}
export interface Figure {
  id: string;
  caption?: string | null;
  source_ref: SourceRef;
}
