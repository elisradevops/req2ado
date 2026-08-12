export interface SourceRefLike {
  documentPath: string;
  startOffset: number;
  endOffset: number;
  page: number | null;
  // Root-first heading ancestry (e.g. ["3 Power", "3.2 Backplane"]) -- empty/
  // absent when the source node has no heading ancestry (e.g. a document
  // with no heading structure, or a manually-added entry). Optional so every
  // entry that predates this field (Phases 1-4, and any stale cached data)
  // renders exactly as before.
  sectionPath?: string[];
  // Last page this node's content spans -- null/absent/equal-to-`page` all
  // mean "same page" (existing single-page `p. N` rendering). Only a value
  // strictly greater than `page` renders as a range.
  pageEnd?: number | null;
  // null = real pagination from the file itself. "rendered"/"interpolated"
  // mean the page number is a best-effort derivation, not a direct match --
  // rendered via formatSourceRef as a bare "(approx.)" qualifier, never the
  // raw provenance string, so a reviewer gets an honest heads-up without
  // jargon they'd need to look up.
  pageProvenance?: string | null;
}

// Human-readable provenance string for a diff entry's sourceRef -- distinct
// from the server's own wire format (JobsService.formatSourceRef, e.g.
// "path#page=12&offset=3400-3820", used for the ADO custom field, not for
// display). Only the filename, not the full path, since documentPath can be
// a long SharePoint-relative path a reviewer doesn't need to see in full.
export function formatSourceRef(ref: SourceRefLike): string {
  const filename = ref.documentPath.split(/[/\\]/).pop() || ref.documentPath;
  const parts = [filename];
  if (ref.sectionPath && ref.sectionPath.length > 0) {
    parts.push(`§ ${ref.sectionPath.join(' › ')}`);
  }
  if (ref.page != null) {
    // A page RANGE only when pageEnd is a real page strictly after `page` --
    // pageEnd == page (or null/absent) is still a single page, unchanged
    // from the pre-Phase-5 rendering.
    const isRange = ref.pageEnd != null && ref.pageEnd > ref.page;
    let pageSegment = isRange ? `pp. ${ref.page}–${ref.pageEnd}` : `p. ${ref.page}`;
    // "(approx.)" on the page segment ONLY -- never surfaces the raw
    // "rendered"/"interpolated" value itself. A reviewer who catches even
    // one confidently-wrong page number (e.g. this said p.12, the real
    // document has it on p.13) stops trusting every other signal in the
    // panel, so an approximate page must say so.
    if (ref.pageProvenance != null) pageSegment += ' (approx.)';
    parts.push(pageSegment);
  }
  parts.push(`chars ${ref.startOffset}–${ref.endOffset}`);
  return parts.join(' · ');
}
