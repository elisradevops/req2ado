import { reviewProgressOf } from '../src/modules/pipeline/review-progress';

const entry = (localId: string, extra: Record<string, unknown> = {}) => ({ localId, parentLocalId: null, type: 'Requirement', action: 'create', ...extra });

describe('reviewProgressOf (the Jobs list mirror of the review page count)', () => {
  it('counts the new items still in the write, and how many of them are reviewed', () => {
    expect(reviewProgressOf([entry('a', { reviewed: true }), entry('b'), entry('c', { reviewed: true })])).toEqual({ reviewed: 2, reviewable: 3 });
  });

  it('leaves out items that are not written (reuse, near-duplicate), even when marked reviewed', () => {
    expect(reviewProgressOf([entry('a'), entry('r', { action: 'reuse', reviewed: true }), entry('d', { action: 'dedup_skip' })])).toEqual({
      reviewed: 0,
      reviewable: 1,
    });
  });

  it('leaves out an excluded item and everything under an excluded ancestor', () => {
    expect(
      reviewProgressOf([
        entry('epic', { type: 'Epic', excluded: true }),
        entry('feature', { type: 'Feature', parentLocalId: 'epic' }),
        entry('req', { parentLocalId: 'feature', reviewed: true }),
        entry('kept', { reviewed: true }),
      ]),
    ).toEqual({ reviewed: 1, reviewable: 1 });
  });

  it('is zero of zero for an empty diff, and null for a diff that is not an array', () => {
    expect(reviewProgressOf([])).toEqual({ reviewed: 0, reviewable: 0 });
    expect(reviewProgressOf(null)).toBeNull();
    expect(reviewProgressOf({ not: 'an array' })).toBeNull();
  });

  it('skips malformed entries rather than failing the list', () => {
    expect(reviewProgressOf([null, 'x', { action: 'create' }, entry('a', { reviewed: true })])).toEqual({ reviewed: 1, reviewable: 1 });
  });
});
