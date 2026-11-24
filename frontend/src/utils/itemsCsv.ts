import type { DryRunDiffEntry } from '../components/DiffTree';

/**
 * The job's proposed items as an Azure DevOps tree export: one row per item in tree order, its title in the column of its depth (Title 1
 * for an Epic, Title 2 for the Feature under it, ...), the same shape as a CSV exported from Azure DevOps (and the one req2ado reads back).
 * Adds where each item came from in the source (page and section), so a reviewer can check it against the document.
 */
export function itemsCsv(entries: DryRunDiffEntry[]): string {
  const byParent = new Map<string | null, DryRunDiffEntry[]>();
  const ids = new Set(entries.map((entry) => entry.localId));
  for (const entry of entries) {
    // A parent the list does not hold is a root, so no item is ever dropped from the export.
    const parent = entry.parentLocalId && ids.has(entry.parentLocalId) ? entry.parentLocalId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), entry]);
  }
  const rows: { entry: DryRunDiffEntry; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number): void => {
    for (const entry of byParent.get(parent) ?? []) {
      if (seen.has(entry.localId)) continue; // a parent cycle is written once, never looped
      seen.add(entry.localId);
      rows.push({ entry, depth });
      walk(entry.localId, depth + 1);
    }
  };
  walk(null, 1);
  // Items no root reaches (a parent cycle) are written too, as roots: the export never drops an item.
  for (const entry of entries) {
    if (seen.has(entry.localId)) continue;
    seen.add(entry.localId);
    rows.push({ entry, depth: 1 });
    walk(entry.localId, 2);
  }
  const depth = rows.reduce((most, row) => Math.max(most, row.depth), 1);
  const titles = Array.from({ length: depth }, (_, i) => `Title ${i + 1}`);
  const header = ['ID', 'Work Item Type', ...titles, 'Customer ID', 'Description', 'Page', 'Section', 'Excluded'];
  const lines = rows.map(({ entry, depth: level }) => {
    const ref = entry.sourceRef;
    const page = ref?.page == null ? '' : ref.pageEnd != null && ref.pageEnd !== ref.page ? `${ref.page}-${ref.pageEnd}` : String(ref.page);
    return [
      '',
      entry.type,
      ...titles.map((_, i) => (i + 1 === level ? entry.title : '')),
      entry.customerId ?? '',
      entry.description,
      page,
      (ref?.sectionPath ?? []).join(' > '),
      entry.excluded ? 'yes' : '',
    ];
  });
  return '﻿' + [header, ...lines].map((cells) => cells.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
