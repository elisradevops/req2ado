export interface SourceRefLike {
  documentPath: string;
  startOffset: number;
  endOffset: number;
  page: number | null;
  // Root-first heading ancestry (e.g. ["3 Power", "3.2 Backplane"]) -- empty/
  // absent when the source node has no heading ancestry (e.g. a document
  // with no heading structure, or a manually-added entry).
  sectionPath?: string[];
  // Last page this node's content spans -- null/absent/equal-to-`page` all
  // mean "same page" (a single Page/Slide row). Only a value strictly
  // greater than `page` renders as a range.
  pageEnd?: number | null;
  // null = real pagination from the file itself. Any non-null value
  // ("rendered"/"interpolated") renders as a bare "(approx.)" qualifier,
  // never the raw provenance string, so a reviewer gets an honest heads-up
  // without jargon they'd need to look up.
  pageProvenance?: string | null;
}

export interface SourceRefRow {
  label: string;
  value: string;
}

// Loaders only ever write their own format's extension into document_path
// (ingestion/app/loaders/*.py) -- checking the extension is a reliable,
// backend-change-free way to tell a pptx-sourced ref apart from a pdf/docx
// one. Matched against the whole path, case-insensitively: 'pptx' and the
// legacy 'ppt' both count.
const PPTX_EXTENSION_PATTERN = /\.pptx?$/i;

function isPptxSource(documentPath: string): boolean {
  return PPTX_EXTENSION_PATTERN.test(documentPath);
}

// Only the filename, not the full path, since documentPath can be a long
// SharePoint-relative path a reviewer doesn't need to see in full.
export function basenameOf(documentPath: string): string {
  return documentPath.split(/[/\\]/).pop() || documentPath;
}

// Human-readable provenance rows for a diff entry's sourceRef -- distinct
// from the server's own wire format (JobsService.formatSourceRef, e.g.
// "path#page=12&offset=3400-3820", used for the ADO custom field, not for
// display). Deliberately drops startOffset/endOffset (nobody reading this
// panel needs a character range) and never emits a non-ASCII typographic
// character -- section breadcrumbs join with a literal '>', page ranges
// with a literal '-'. Each row is independently conditional; returns []
// when neither sectionPath nor page applies (e.g. an XLSX-sourced entry
// today, which carries neither).
export function sourceRefRows(ref: SourceRefLike): SourceRefRow[] {
  const rows: SourceRefRow[] = [];
  if (ref.sectionPath && ref.sectionPath.length > 0) {
    rows.push({ label: 'Section', value: ref.sectionPath.join(' > ') });
  }
  if (ref.page != null) {
    const isRange = ref.pageEnd != null && ref.pageEnd > ref.page;
    const isSlide = isPptxSource(ref.documentPath);
    const label = isSlide ? (isRange ? 'Slides' : 'Slide') : isRange ? 'Pages' : 'Page';
    let value = isRange ? `${ref.page}-${ref.pageEnd}` : `${ref.page}`;
    if (ref.pageProvenance != null) value += ' (approx.)';
    rows.push({ label, value });
  }
  return rows;
}
