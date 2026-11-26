import { describe, expect, it } from 'vitest';
import type { ReadingDecision, ReadingOutlineItem } from '../api/jobs';
import { applyDecisions, decisionPairs } from './buildPreview';

// The TV twin's shape: a generic root, a wrapper holding one section, and a generically named area.
const outline: ReadingOutlineItem[] = [
  { id: 'g_b1', parent: null, type: 'Epic', title: 'Requirements', headingId: 'b1', requirements: 10 },
  { id: 'g_b2', parent: 'g_b1', type: 'Epic', title: 'General', headingId: 'b2', requirements: 3 },
  { id: 'g_b3', parent: 'g_b2', type: 'Feature', title: 'Product family', headingId: 'b3', requirements: 3 },
  { id: 'g_b4', parent: 'g_b1', type: 'Epic', title: 'Design and construction', headingId: 'b4', requirements: 7 },
  { id: 'g_b5', parent: 'g_b4', type: 'Feature', title: 'Environmental conditions', headingId: 'b5', requirements: 7 },
];
const proposals: ReadingDecision[] = [
  { headingId: 'b1', action: 'rename', title: 'Requirements', newTitle: 'Vireo Television Set (VTS)', reason: 'Cover.', decision: null },
  { headingId: 'b2', action: 'drop_wrapper', title: 'General', newTitle: null, reason: 'Generic.', decision: null },
  { headingId: 'b4', action: 'rename', title: 'Design and construction', newTitle: 'Environment and safety', reason: 'Sections.', decision: null },
];

describe('applyDecisions', () => {
  it('keeps the file original while nothing is decided, and marks the open proposals', () => {
    const { rows, removed } = applyDecisions(outline, proposals, {});
    expect(rows.map((r) => [r.title, r.depth, r.open])).toEqual([
      ['Requirements', 0, true],
      ['General', 1, true],
      ['Product family', 2, false],
      ['Design and construction', 1, true],
      ['Environmental conditions', 2, false],
    ]);
    expect(removed).toEqual([]);
  });

  it('shows an accepted rename and moves the children of an accepted removal up a level', () => {
    const { rows, removed } = applyDecisions(outline, proposals, { b1: 'accept', b2: 'accept', b4: 'keep' });
    expect(rows.map((r) => [r.title, r.depth, r.was, r.open])).toEqual([
      ['Vireo Television Set (VTS)', 0, 'Requirements', false],
      ['Product family', 1, null, false],
      ['Design and construction', 1, null, false],
      ['Environmental conditions', 2, null, false],
    ]);
    expect(removed).toEqual(['General']);
  });
});

describe('decisionPairs', () => {
  it('stores only the decisions the user made, in a stable order', () => {
    expect(decisionPairs({ b4: 'keep', b1: 'accept', b2: undefined })).toEqual([
      ['b1', 'accept'],
      ['b4', 'keep'],
    ]);
  });
});
