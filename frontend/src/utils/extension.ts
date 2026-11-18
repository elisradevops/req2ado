// One canonical extension extractor. Two divergent copies existed before
// this (SharePointFolderTree.tsx returned "docx" -- no dot, no
// lowercasing; MultiFileDropzone.tsx returned ".docx"), which forced a
// .replace('.', '') adapter at one call site that was itself redundant
// because FileTypeIcon already normalizes both forms. Leading-dot +
// lowercased is the canonical shape because MultiFileDropzone's
// JOB_FILE_EXTENSIONS list ('.txt,.md,.docx,.doc,.pdf,.xlsx,.xls,.csv') is already in it.
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

// The file types a job can be made from: the ONE list both upload dropzones use (it had been copied into each, and copies drift). The server's
// own allow-list is ALLOWED_EXTENSIONS in the orchestrator's jobs.controller.ts; a test there keeps it inside what ingestion can read.
export const JOB_FILE_EXTENSIONS = '.txt,.md,.docx,.doc,.pdf,.xlsx,.xls,.csv';
// The chips under the dropzone: the modern formats, then the older ones people still have.
export const JOB_FILE_TYPE_LABELS = ['docx', 'doc', 'pdf', 'xlsx', 'xls', 'csv', 'txt', 'md'];
