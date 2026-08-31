import { buildExclusionChecker, filterExcludedDiffEntries, isFlaggedDiffEntry, summarizeDiffEntries } from '../src/modules/pipeline/diff-summary';

describe('summarizeDiffEntries', () => {
  it('aggregates create/reuse/dedup_skip counts', () => {
    const summary = summarizeDiffEntries([
      { action: 'create', type: 'Requirement', groundingScore: null, qualityScore: null },
      { action: 'create', type: 'Requirement', groundingScore: null, qualityScore: null },
      { action: 'reuse', type: 'Requirement', groundingScore: null, qualityScore: null },
      { action: 'dedup_skip', type: 'Requirement', groundingScore: null, qualityScore: null },
    ]);

    expect(summary).toEqual({ created: 2, reused: 1, dedupSkipped: 1, flagged: 0 });
  });

  it('counts an entry as flagged when groundingScore is below 0.2 or qualityScore is below 50', () => {
    const summary = summarizeDiffEntries([
      { action: 'create', type: 'Requirement', groundingScore: 0.1, qualityScore: null },
      { action: 'create', type: 'Requirement', groundingScore: null, qualityScore: 30 },
      { action: 'create', type: 'Requirement', groundingScore: 0.9, qualityScore: 95 },
    ]);

    expect(summary.flagged).toBe(2);
  });

  it('returns all zeros for an empty diff', () => {
    expect(summarizeDiffEntries([])).toEqual({ created: 0, reused: 0, dedupSkipped: 0, flagged: 0 });
  });

  it('ignores an unrecognized action value rather than miscounting it', () => {
    const summary = summarizeDiffEntries([
      { action: 'something_else', type: 'Requirement', groundingScore: null, qualityScore: null },
    ]);

    expect(summary).toEqual({ created: 0, reused: 0, dedupSkipped: 0, flagged: 0 });
  });

  it('counts a low-confidence entry in the flagged summary total', () => {
    const summary = summarizeDiffEntries([
      { action: 'create', type: 'Requirement', groundingScore: 0.9, qualityScore: 95, qualityConfidence: 'low' },
      { action: 'create', type: 'Requirement', groundingScore: 0.9, qualityScore: 95, qualityConfidence: 'high' },
    ]);

    // Flagged, but still fully counted as created -- low confidence flags for
    // review, it never excludes an item from an aggregate.
    expect(summary.flagged).toBe(1);
    expect(summary.created).toBe(2);
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

  it('flags an Epic with a grounding score below the higher parent threshold but above the base threshold', () => {
    expect(isFlaggedDiffEntry({ type: 'Epic', groundingScore: 0.3, qualityScore: 100 })).toBe(true);
  });

  it('does not flag a Requirement with the same grounding score that would flag an Epic', () => {
    expect(isFlaggedDiffEntry({ type: 'Requirement', groundingScore: 0.3, qualityScore: 100 })).toBe(false);
  });

  it('flags a low-confidence entry whose scores are otherwise fine', () => {
    // SWEEP.md section 7: a low-confidence score is another condition that
    // sets the EXISTING flagged bit, not a new UI surface -- so an item the
    // model scored 95 with grounding 0.9 but told us it wasn't sure about
    // still reaches the reviewer's "Needs review" filter.
    expect(isFlaggedDiffEntry({ type: 'Requirement', groundingScore: 0.9, qualityScore: 95, qualityConfidence: 'low' })).toBe(true);
  });

  it('does not flag high or medium confidence, nor an absent value', () => {
    expect(isFlaggedDiffEntry({ type: 'Requirement', groundingScore: 0.9, qualityScore: 95, qualityConfidence: 'high' })).toBe(false);
    expect(isFlaggedDiffEntry({ type: 'Requirement', groundingScore: 0.9, qualityScore: 95, qualityConfidence: 'medium' })).toBe(false);
    expect(isFlaggedDiffEntry({ type: 'Requirement', groundingScore: 0.9, qualityScore: 95, qualityConfidence: null })).toBe(false);
    // An older persisted diff entry has no key at all -- Job.dryRunDiff is a
    // JSON column with no migration, so this is the common real shape.
    expect(isFlaggedDiffEntry({ type: 'Requirement', groundingScore: 0.9, qualityScore: 95 })).toBe(false);
  });
});

describe('buildExclusionChecker / filterExcludedDiffEntries', () => {
  const requirement = { localId: 'req-1', parentLocalId: 'feat-1', action: 'create' };
  const feature = { localId: 'feat-1', parentLocalId: null, action: 'create', excluded: true };
  const unrelated = { localId: 'req-2', parentLocalId: null, action: 'create' };

  it('excludes a directly-excluded entry', () => {
    const isExcluded = buildExclusionChecker([feature]);
    expect(isExcluded(feature)).toBe(true);
  });

  it('excludes a descendant of an excluded ancestor, even though the descendant itself is not marked excluded', () => {
    const diff = [feature, requirement];
    const isExcluded = buildExclusionChecker(diff);
    expect(isExcluded(requirement)).toBe(true);
  });

  it('does not exclude an unrelated entry with no excluded ancestor', () => {
    const diff = [feature, requirement, unrelated];
    const isExcluded = buildExclusionChecker(diff);
    expect(isExcluded(unrelated)).toBe(false);
  });

  it('does not infinite-loop on a cyclic parentLocalId chain -- same cycle guard as confirm()\'s own isExcluded', () => {
    const a = { localId: 'a', parentLocalId: 'b', action: 'create' };
    const b = { localId: 'b', parentLocalId: 'a', action: 'create' };
    const isExcluded = buildExclusionChecker([a, b]);
    expect(isExcluded(a)).toBe(false);
  });

  it('treats an entry with no excluded field and no matching parent as not excluded (back-compat: entries predating the exclude feature)', () => {
    const legacy = { localId: 'n0', parentLocalId: null, action: 'create' };
    const isExcluded = buildExclusionChecker([legacy]);
    expect(isExcluded(legacy)).toBe(false);
  });

  it('filterExcludedDiffEntries removes an excluded entry and its whole subtree, keeping unrelated entries', () => {
    const diff = [feature, requirement, unrelated];
    const result = filterExcludedDiffEntries(diff);
    expect(result).toEqual([unrelated]);
  });

  it('filterExcludedDiffEntries returns every entry unchanged when nothing is excluded', () => {
    const diff = [
      { localId: 'n0', parentLocalId: null, action: 'create' },
      { localId: 'n1', parentLocalId: 'n0', action: 'reuse' },
    ];
    expect(filterExcludedDiffEntries(diff)).toEqual(diff);
  });
});
