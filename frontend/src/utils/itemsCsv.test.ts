import { describe, expect, it } from 'vitest';
import type { DryRunDiffEntry } from '../components/DiffTree';
import { itemsCsv } from './itemsCsv';

const entry = (localId: string, parentLocalId: string | null, type: string, title: string, over: Partial<DryRunDiffEntry> = {}): DryRunDiffEntry =>
  ({ localId, parentLocalId, type, title, description: '', action: 'create', customerId: null, ...over }) as DryRunDiffEntry;

const rows = (csv: string): string[] => csv.replace(/^﻿/, '').trimEnd().split('\r\n');

describe('itemsCsv', () => {
  it('writes an Azure DevOps tree export: tree order, each title in the column of its depth, with the source page and section', () => {
    const csv = itemsCsv([
      entry('r1', 'f11', 'Requirement', 'The unit shall heat water.', {
        customerId: 'CFM-014',
        description: 'CFM-014: The unit shall heat water, "fast".',
        sourceRef: { documentPath: 'x.pdf', startOffset: 0, endOffset: 1, page: 4, pageEnd: 5, sectionPath: ['3 Operation', '3.2 Brewing'] },
      }),
      entry('e1', null, 'Epic', 'Coffee Unit Specification'),
      entry('f1', 'e1', 'Feature', '3 Operation'),
      entry('f11', 'f1', 'Feature', '3.2 Brewing'),
      entry('r2', 'f11', 'Requirement', 'Old item', { excluded: true }),
    ]);
    expect(csv.startsWith('﻿')).toBe(true); // Excel opens UTF-8 (Hebrew) correctly
    expect(rows(csv)).toEqual([
      'ID,Work Item Type,Title 1,Title 2,Title 3,Title 4,Customer ID,Description,Page,Section,Excluded',
      ',Epic,Coffee Unit Specification,,,,,,,,',
      ',Feature,,3 Operation,,,,,,,',
      ',Feature,,,3.2 Brewing,,,,,,',
      ',Requirement,,,,The unit shall heat water.,CFM-014,"CFM-014: The unit shall heat water, ""fast"".",4-5,3 Operation > 3.2 Brewing,',
      ',Requirement,,,,Old item,,,,,yes',
    ]);
  });

  it('never drops an item: a missing parent makes it a root, and a parent cycle is written once, from its first item', () => {
    const csv = itemsCsv([entry('a', 'missing', 'Feature', 'Orphan'), entry('b', 'c', 'Feature', 'B'), entry('c', 'b', 'Feature', 'C')]);
    expect(rows(csv)).toEqual([
      'ID,Work Item Type,Title 1,Title 2,Customer ID,Description,Page,Section,Excluded',
      ',Feature,Orphan,,,,,,',
      ',Feature,B,,,,,,',
      ',Feature,,C,,,,,',
    ]);
  });
});
