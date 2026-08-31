// One canonical extension extractor. Two divergent copies existed before
// this (SharePointFolderTree.tsx returned "docx" -- no dot, no
// lowercasing; MultiFileDropzone.tsx returned ".docx"), which forced a
// .replace('.', '') adapter at one call site that was itself redundant
// because FileTypeIcon already normalizes both forms. Leading-dot +
// lowercased is the canonical shape because MultiFileDropzone's
// ACCEPTED_EXTENSIONS list ('.txt,.md,.docx,.pdf,.xlsx') is already in it.
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}
