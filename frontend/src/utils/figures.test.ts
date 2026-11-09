import { describe, expect, it } from 'vitest';
import type { DryRunDiffEntry } from '../components/DiffTree';
import { attachFigureIdsOf } from './figures';

const entry = (patch: Partial<DryRunDiffEntry> = {}): DryRunDiffEntry => ({
  localId: 'n0', parentLocalId: null, type: 'Requirement', title: 't', description: 'd', action: 'create', customerId: null, ...patch,
});

describe('attachFigureIdsOf', () => {
  it('attachFigureIdsOf prefers the server field', () => {
    const e = entry({ figureIds: ['f0'], uncaptionedFigureIds: ['f1'], attachFigureIds: ['f9'] });
    expect(attachFigureIdsOf(e)).toEqual(['f9']);
    expect(attachFigureIdsOf(entry({ figureIds: ['f0'], attachFigureIds: [] }))).toEqual([]);
  });

  it('attachFigureIdsOf falls back for entries without the field', () => {
    const e = entry({ figureIds: ['f0'], uncaptionedFigureIds: ['f1', 'f2'], insignificantFigureIds: ['f2'] });
    expect(attachFigureIdsOf(e)).toEqual(['f0', 'f1']);
    expect(attachFigureIdsOf(entry({ action: 'reuse', figureIds: ['f0'] }))).toEqual([]);
    expect(attachFigureIdsOf(entry())).toEqual([]);
  });

  it('figures fallback excludes detached ids', () => {
    const e = entry({ figureIds: ['f0', 'f3'], uncaptionedFigureIds: ['f1', 'f2'], detachedFigureIds: ['f3', 'f1'] });
    expect(attachFigureIdsOf(e)).toEqual(['f0', 'f2']);
  });
});
