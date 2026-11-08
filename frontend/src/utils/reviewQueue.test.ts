import { describe, it, expect } from 'vitest';
import type { WarningRecord } from './warnings';
import { buildKindGroups, kindMeta } from './warningKinds';
import { buildReviewQueue, riskReason, riskTier, type ReviewQueueEntry } from './reviewQueue';

function entry(localId: string, overrides: Partial<ReviewQueueEntry> = {}): ReviewQueueEntry {
  return { localId, parentLocalId: null, type: 'Requirement', action: 'create', ...overrides };
}

function warning(kind: string, severity: WarningRecord['severity'], nodeIds: string[]): WarningRecord {
  return { kind, severity, nodeIds, detail: {}, raw: `${kind} raw` };
}

const NO_WARNINGS = buildKindGroups([]);

describe('riskTier', () => {
  it('puts an item with a fix-group warning first', () => {
    const groups = buildKindGroups([warning('missing_source_reference', 'needs_review', ['a'])]);
    expect(riskTier(entry('a', { qualityScore: 95 }), groups)).toBe('blocking');
  });

  it('ranks a low quality score above other flags', () => {
    expect(riskTier(entry('a', { qualityScore: 40 }), NO_WARNINGS)).toBe('low_score');
  });

  it('treats low grounding, low model confidence and a review-group warning as flagged', () => {
    expect(riskTier(entry('a', { qualityScore: 90, groundingScore: 0.05 }), NO_WARNINGS)).toBe('flagged');
    expect(riskTier(entry('a', { qualityScore: 90, qualityConfidence: 'low' }), NO_WARNINGS)).toBe('flagged');
    const groups = buildKindGroups([warning('low_grounding', 'needs_review', ['a'])]);
    expect(riskTier(entry('a', { qualityScore: 90 }), groups)).toBe('flagged');
  });

  it('calls an unflagged, warning-free item clean, scored or not', () => {
    expect(riskTier(entry('a', { qualityScore: 90, groundingScore: 0.9 }), NO_WARNINGS)).toBe('clean');
    expect(riskTier(entry('a'), NO_WARNINGS)).toBe('clean');
  });

  it('does not let an info-group warning change the tier', () => {
    const groups = buildKindGroups([warning('enhancement_call_failed', 'pipeline_issue', ['a'])]);
    expect(riskTier(entry('a', { qualityScore: 90 }), groups)).toBe('clean');
  });
});

describe('buildReviewQueue', () => {
  it('orders blocking, then low score, then flagged, then clean', () => {
    const groups = buildKindGroups([warning('missing_source_reference', 'needs_review', ['blocked'])]);
    const queue = buildReviewQueue(
      [
        entry('clean', { qualityScore: 95 }),
        entry('flagged', { qualityScore: 80, qualityConfidence: 'low' }),
        entry('low', { qualityScore: 30 }),
        entry('blocked', { qualityScore: 99 }),
      ],
      groups,
    );
    expect(queue.map((item) => item.localId)).toEqual(['blocked', 'low', 'flagged', 'clean']);
  });

  it('orders low scores worst first and keeps tree order for ties', () => {
    const queue = buildReviewQueue(
      [entry('a', { qualityScore: 45 }), entry('b', { qualityScore: 10 }), entry('c', { qualityScore: 45 }), entry('d')],
      NO_WARNINGS,
    );
    expect(queue.map((item) => item.localId)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('leaves out reviewed, excluded and not-to-be-written items', () => {
    const queue = buildReviewQueue(
      [
        entry('done', { reviewed: true }),
        entry('out', { excluded: true }),
        entry('existing', { action: 'reuse' }),
        entry('near', { action: 'dedup_skip' }),
        entry('keep'),
      ],
      NO_WARNINGS,
    );
    expect(queue.map((item) => item.localId)).toEqual(['keep']);
  });

  it('leaves out the descendants of an excluded item, however deep', () => {
    const queue = buildReviewQueue(
      [
        entry('epic', { type: 'Epic', excluded: true }),
        entry('feature', { type: 'Feature', parentLocalId: 'epic' }),
        entry('req', { parentLocalId: 'feature' }),
        entry('other'),
      ],
      NO_WARNINGS,
    );
    expect(queue.map((item) => item.localId)).toEqual(['other']);
  });

  it('keeps the order the tree is drawn in for ties, even when the diff lists a parent after its children', () => {
    // The diff array can list a wrapper Epic last; the tree still draws it first, then its subtree.
    const queue = buildReviewQueue(
      [
        entry('f1', { type: 'Feature', parentLocalId: 'epic' }),
        entry('r1', { parentLocalId: 'f1' }),
        entry('f2', { type: 'Feature', parentLocalId: 'epic' }),
        entry('r2', { parentLocalId: 'f2' }),
        entry('epic', { type: 'Epic' }),
      ],
      NO_WARNINGS,
    );
    expect(queue.map((item) => item.localId)).toEqual(['epic', 'f1', 'r1', 'f2', 'r2']);
  });

  it('is empty when nothing is left to review', () => {
    expect(buildReviewQueue([entry('a', { reviewed: true })], NO_WARNINGS)).toEqual([]);
    expect(buildReviewQueue([], NO_WARNINGS)).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = [entry('b', { qualityScore: 90 }), entry('a', { qualityScore: 10 })];
    buildReviewQueue(input, NO_WARNINGS);
    expect(input.map((item) => item.localId)).toEqual(['b', 'a']);
  });
});

describe('riskReason', () => {
  it('names the blocking warning and marks it as a fix', () => {
    const groups = buildKindGroups([warning('missing_source_reference', 'needs_review', ['a'])]);
    const reason = riskReason(entry('a'), groups);
    expect(reason.group).toBe('fix');
    expect(reason.title).toMatch(/^Blocking warning: /);
    // The warning kind's own guidance, the same text the warning-focus review shows.
    expect(reason.todo).toBe(kindMeta('missing_source_reference').todo);
  });

  it('says why a low score or a flag put the item in the queue', () => {
    expect(riskReason(entry('a', { qualityScore: 30 }), NO_WARNINGS)).toMatchObject({ group: 'review', title: 'Low quality score' });
    const flagged = riskReason(entry('a', { qualityScore: 90, qualityConfidence: 'low' }), NO_WARNINGS);
    expect(flagged.group).toBe('review');
    expect(flagged.title).toBe('Model was unsure about this score');
  });

  it('names a review-group warning when nothing else explains the item', () => {
    const groups = buildKindGroups([warning('low_grounding', 'needs_review', ['a'])]);
    const reason = riskReason(entry('a', { qualityScore: 90 }), groups);
    expect(reason.group).toBe('review');
    expect(reason.title).toBe(kindMeta('low_grounding').title);
    expect(reason.todo).toBe(kindMeta('low_grounding').todo);
  });

  it('says a clean item has no flags and still needs a look', () => {
    expect(riskReason(entry('a', { qualityScore: 95 }), NO_WARNINGS)).toMatchObject({ group: 'info', title: 'No flags' });
  });
});
