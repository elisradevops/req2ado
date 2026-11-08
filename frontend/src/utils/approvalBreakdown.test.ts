import { describe, expect, it } from 'vitest';
import { approvalBreakdown } from './approvalBreakdown';

const reviewed = (...ids: string[]) => new Set(ids);

describe('approvalBreakdown', () => {
  it('counts items by how they were reviewed in this session', () => {
    const result = approvalBreakdown({
      createdLocalIds: ['a', 'b', 'c', 'd'],
      reviewedIds: reviewed('a', 'b', 'c'),
      methods: new Map([['a', 'single'], ['b', 'bulk'], ['c', 'bulk']]),
      spotCheckedIds: new Set(['c']),
      editedIds: new Set(),
    });
    expect(result).toEqual({ edited: 0, single: 1, bulk: 1, bulkSpotChecked: 1, group: 0, earlier: 0, notReviewed: 1 });
  });

  it('counts an item edited in this session as edited, whichever way it was then approved', () => {
    const result = approvalBreakdown({
      createdLocalIds: ['a', 'b'],
      reviewedIds: reviewed('a', 'b'),
      methods: new Map([['a', 'single'], ['b', 'bulk']]),
      spotCheckedIds: new Set(),
      editedIds: new Set(['a', 'b']),
    });
    expect(result).toMatchObject({ edited: 2, single: 0, bulk: 0 });
  });

  it('counts an edited item that was never marked reviewed as not reviewed', () => {
    const result = approvalBreakdown({
      createdLocalIds: ['a'],
      reviewedIds: reviewed(),
      methods: new Map(),
      spotCheckedIds: new Set(),
      editedIds: new Set(['a']),
    });
    expect(result).toMatchObject({ edited: 0, notReviewed: 1 });
  });

  it('counts reviewed items with no recorded method as reviewed earlier, e.g. before the page was opened', () => {
    const result = approvalBreakdown({
      createdLocalIds: ['a'],
      reviewedIds: reviewed('a'),
      methods: new Map(),
      spotCheckedIds: new Set(),
      editedIds: new Set(),
    });
    expect(result).toMatchObject({ earlier: 1, notReviewed: 0 });
  });

  it('ignores items that will not be created', () => {
    const result = approvalBreakdown({
      createdLocalIds: ['a'],
      reviewedIds: reviewed('a', 'x'),
      methods: new Map([['a', 'single'], ['x', 'bulk']]),
      spotCheckedIds: new Set(),
      editedIds: new Set(['x']),
    });
    expect(result).toEqual({ edited: 0, single: 1, bulk: 0, bulkSpotChecked: 0, group: 0, earlier: 0, notReviewed: 0 });
  });

  it('counts items marked reviewed from a warning list as group, even if spot-checked, but edited still wins', () => {
    const result = approvalBreakdown({
      createdLocalIds: ['a', 'b', 'c'],
      reviewedIds: reviewed('a', 'b', 'c'),
      methods: new Map([['a', 'group'], ['b', 'group'], ['c', 'group']]),
      spotCheckedIds: new Set(['b']),
      editedIds: new Set(['c']),
    });
    expect(result).toEqual({ edited: 1, single: 0, bulk: 0, bulkSpotChecked: 0, group: 2, earlier: 0, notReviewed: 0 });
  });
});
