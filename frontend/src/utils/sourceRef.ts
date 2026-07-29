export interface SourceRefLike {
  documentPath: string;
  startOffset: number;
  endOffset: number;
  page: number | null;
}

// Human-readable provenance string for a diff entry's sourceRef -- distinct
// from the server's own wire format (JobsService.formatSourceRef, e.g.
// "path#page=12&offset=3400-3820", used for the ADO custom field, not for
// display). Only the filename, not the full path, since documentPath can be
// a long SharePoint-relative path a reviewer doesn't need to see in full.
export function formatSourceRef(ref: SourceRefLike): string {
  const filename = ref.documentPath.split(/[/\\]/).pop() || ref.documentPath;
  const parts = [filename];
  if (ref.page != null) parts.push(`p. ${ref.page}`);
  parts.push(`chars ${ref.startOffset}–${ref.endOffset}`);
  return parts.join(' · ');
}
