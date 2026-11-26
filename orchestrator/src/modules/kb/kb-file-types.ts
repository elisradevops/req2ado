// What the knowledge base can read, and what each recorded file is (owner finding, 2026-11-26): files the folder tree cannot reach kept
// grounding scoring with no way to remove them. The list labels them so the Knowledge base page can offer to remove them from its own list.

/** Every extension ingestion reads (dispatch.py's _SUPPORTED_EXTENSIONS, images included). Kept equal by allowed-extensions.drift-guard. */
export const KB_SUPPORTED_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.docx',
  '.doc',
  '.pdf',
  '.xlsx',
  '.xls',
  '.csv',
  '.pptx',
  '.rtf',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.webp',
  '.tiff',
  '.tif',
]);

/**
 * `unsupported`: a type ingestion does not read (any more). `legacy`: recorded before its SharePoint library was, so the folder tree
 * cannot find it. `current`: neither. An unsupported file is unsupported whether or not its library is known.
 */
export type KbFileStatus = 'current' | 'legacy' | 'unsupported';

export function kbFileStatus(document: { name: string; driveId: string | null }): KbFileStatus {
  const base = document.name.split('/').pop() ?? document.name;
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 ? base.slice(dot).toLowerCase() : '';
  if (!KB_SUPPORTED_EXTENSIONS.has(extension)) return 'unsupported';
  return document.driveId ? 'current' : 'legacy';
}
