import { isFlaggedDiffEntry, summarizeDiffEntries } from '../src/modules/pipeline/diff-summary';

describe('summarizeDiffEntries', () => {
  it('aggregates create/reuse/dedup_skip counts', () => {
    const summary = summarizeDiffEntries([
      { action: 'create', groundingScore: null, qualityScore: null },
      { action: 'create', groundingScore: null, qualityScore: null },
      { action: 'reuse', groundingScore: null, qualityScore: null },
      { action: 'dedup_skip', groundingScore: null, qualityScore: null },
    ]);

    expect(summary).toEqual({ created: 2, reused: 1, dedupSkipped: 1, flagged: 0 });
  });

  it('counts an entry as flagged when groundingScore is below 0.2 or qualityScore is below 50', () => {
    const summary = summarizeDiffEntries([
      { action: 'create', groundingScore: 0.1, qualityScore: null },
      { action: 'create', groundingScore: null, qualityScore: 30 },
      { action: 'create', groundingScore: 0.9, qualityScore: 95 },
    ]);

    expect(summary.flagged).toBe(2);
  });

  it('returns all zeros for an empty diff', () => {
    expect(summarizeDiffEntries([])).toEqual({ created: 0, reused: 0, dedupSkipped: 0, flagged: 0 });
  });

  it('ignores an unrecognized action value rather than miscounting it', () => {
    const summary = summarizeDiffEntries([{ action: 'something_else', groundingScore: null, qualityScore: null }]);

    expect(summary).toEqual({ created: 0, reused: 0, dedupSkipped: 0, flagged: 0 });
  });
});

describe('isFlaggedDiffEntry', () => {
  it('is false when both scores are null', () => {
    expect(isFlaggedDiffEntry({ groundingScore: null, qualityScore: null })).toBe(false);
  });

  it('is true exactly at the grounding threshold boundary (< 0.2)', () => {
    expect(isFlaggedDiffEntry({ groundingScore: 0.19, qualityScore: null })).toBe(true);
    expect(isFlaggedDiffEntry({ groundingScore: 0.2, qualityScore: null })).toBe(false);
  });

  it('is true exactly at the quality threshold boundary (< 50)', () => {
    expect(isFlaggedDiffEntry({ groundingScore: null, qualityScore: 49 })).toBe(true);
    expect(isFlaggedDiffEntry({ groundingScore: null, qualityScore: 50 })).toBe(false);
  });
});
