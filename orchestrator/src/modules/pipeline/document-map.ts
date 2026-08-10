import type { Block } from '@req2ado/shared-ts';

// DESIGN.md §11.1 -- the wizard step-1 document map's "honest answer to
// 'what did it read'": one row per heading section, with real block/figure
// counts, not just the aggregate blockCount/figureCount preview() already
// returned. Kept as a pure function over the raw parse (not a class/service)
// since it has exactly one caller and no external dependency -- same
// convention as description-html.ts in this same directory.
export interface DocumentMapSection {
  // Block.number_label, e.g. "1.1.1" -- null for a heading the parser
  // couldn't assign a clause number to (rare, but real: not every document
  // uses numbered headings).
  number: string | null;
  title: string;
  blockCount: number;
  figureCount: number;
}

// One row per `kind === 'heading'` block, matching preview()'s own
// `sectionCount` (already `doc.blocks.filter(b => b.kind === 'heading')
// .length`) -- every heading becomes a section, not just top-level ones, so
// this stays consistent with the stat tile already shown beside it.
// Content before the first heading (rare, but a document can open with
// unstructured text) is dropped rather than attributed to a section that
// doesn't exist -- there is nothing here it could honestly belong to.
export function buildDocumentMap(blocks: Block[]): DocumentMapSection[] {
  const sections: DocumentMapSection[] = [];
  let current: DocumentMapSection | null = null;
  for (const block of blocks) {
    if (block.kind === 'heading') {
      current = { number: block.number_label ?? null, title: block.text, blockCount: 0, figureCount: 0 };
      sections.push(current);
    }
    if (!current) continue;
    current.blockCount += 1;
    if (block.kind === 'figure') current.figureCount += 1;
  }
  return sections;
}
