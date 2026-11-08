import { describe, it, expect } from 'vitest';
import type { WarningRecord } from './warnings';
import { buildKindGroups, kindMeta } from './warningKinds';
import {
  buildReviewQueue,
  cleanApproval,
  reviewQueueModeReducer,
  riskReason,
  riskTier,
  spotCheckSample,
  type ReviewQueueEntry,
  type ReviewQueueMode,
} from './reviewQueue';

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

  it('does not claim an unscored item was checked for flags', () => {
    expect(riskReason(entry('a'), NO_WARNINGS)).toEqual({
      title: 'Not scored',
      todo: 'No score for this item. Read it against its source before you mark it reviewed.',
      group: 'info',
    });
    // A grounding score alone still counts as scored.
    expect(riskReason(entry('a', { groundingScore: 0.9 }), NO_WARNINGS).title).toBe('No flags');
  });
});

describe('reviewQueueModeReducer', () => {
  const OFF: ReviewQueueMode = { kind: 'off' };
  const QUEUE: ReviewQueueMode = { kind: 'queue' };
  const DONE: ReviewQueueMode = { kind: 'done' };

  it('opens the queue from any mode, replacing a "done" row', () => {
    expect(reviewQueueModeReducer(OFF, 'open')).toEqual(QUEUE);
    expect(reviewQueueModeReducer(DONE, 'open')).toEqual(QUEUE);
    expect(reviewQueueModeReducer(QUEUE, 'open')).toBe(QUEUE);
  });

  it('closing ends a running queue but keeps a finished one, so its "done" row survives the dialog closing', () => {
    expect(reviewQueueModeReducer(QUEUE, 'close')).toEqual(OFF);
    expect(reviewQueueModeReducer(DONE, 'close')).toBe(DONE);
    expect(reviewQueueModeReducer(OFF, 'close')).toBe(OFF);
  });

  it('finishing ends the queue and marks it done, from any mode', () => {
    expect(reviewQueueModeReducer(QUEUE, 'finish')).toEqual(DONE);
    expect(reviewQueueModeReducer(OFF, 'finish')).toEqual(DONE);
  });

  it('clearing the "done" row leaves a running queue alone', () => {
    expect(reviewQueueModeReducer(DONE, 'clearDone')).toEqual(OFF);
    expect(reviewQueueModeReducer(QUEUE, 'clearDone')).toBe(QUEUE);
    expect(reviewQueueModeReducer(OFF, 'clearDone')).toBe(OFF);
  });
});

describe('reviewQueueModeReducer: spot-check', () => {
  const OFF: ReviewQueueMode = { kind: 'off' };
  const SPOT: ReviewQueueMode = { kind: 'spotCheck' };

  it('starts a spot-check from any mode and ends it back to off', () => {
    expect(reviewQueueModeReducer(OFF, 'startSpotCheck')).toEqual(SPOT);
    expect(reviewQueueModeReducer({ kind: 'done' }, 'startSpotCheck')).toEqual(SPOT);
    expect(reviewQueueModeReducer(SPOT, 'startSpotCheck')).toBe(SPOT);
    expect(reviewQueueModeReducer(SPOT, 'endSpotCheck')).toEqual(OFF);
    expect(reviewQueueModeReducer(OFF, 'endSpotCheck')).toBe(OFF);
  });

  it('leaves the other modes alone when a spot-check ends, and a spot-check alone when the queue closes', () => {
    expect(reviewQueueModeReducer({ kind: 'queue' }, 'endSpotCheck')).toEqual({ kind: 'queue' });
    expect(reviewQueueModeReducer(SPOT, 'close')).toBe(SPOT);
    expect(reviewQueueModeReducer(SPOT, 'clearDone')).toBe(SPOT);
  });
});

describe('cleanApproval', () => {
  const CLEAN = { qualityScore: 80, groundingScore: 0.9 };

  it('lists the scored, unflagged, unreviewed new items, lowest score first', () => {
    const result = cleanApproval(
      [entry('hi', { ...CLEAN, qualityScore: 95 }), entry('lo', { ...CLEAN, qualityScore: 60 }), entry('mid', { ...CLEAN, qualityScore: 80 })],
      NO_WARNINGS,
    );
    expect(result.items.map((item) => item.localId)).toEqual(['lo', 'mid', 'hi']);
    expect(result.lowestScore).toBe(60);
    expect(result.highestScore).toBe(95);
  });

  it('leaves an item out for each reason, and counts why', () => {
    const groups = buildKindGroups([
      warning('missing_source_reference', 'needs_review', ['blocked']),
      warning('low_grounding', 'needs_review', ['warned']),
    ]);
    const result = cleanApproval(
      [
        entry('ok', CLEAN),
        entry('reviewed', { ...CLEAN, reviewed: true }),
        entry('excluded', { ...CLEAN, excluded: true }),
        entry('under', { ...CLEAN, parentLocalId: 'excluded' }),
        entry('reuse', { ...CLEAN, action: 'reuse' }),
        entry('dup', { ...CLEAN, action: 'dedup_skip' }),
        entry('lowscore', { qualityScore: 40 }),
        entry('lowground', { ...CLEAN, groundingScore: 0.05 }),
        entry('lowconf', { ...CLEAN, qualityConfidence: 'low' }),
        entry('blocked', CLEAN),
        entry('warned', CLEAN),
        entry('unscored', {}),
        entry('stale', { ...CLEAN, qualityStale: true } as Partial<ReviewQueueEntry>),
      ],
      groups,
    );
    expect(result.items.map((item) => item.localId)).toEqual(['ok']);
    // Reviewed, excluded and not-written items are not "left out": they were never up for review.
    expect(result).toMatchObject({ flagged: 5, unscored: 1, stale: 1 });
  });

  it('does not let an info-level warning disqualify an item', () => {
    const groups = buildKindGroups([warning('enhancement_call_failed', 'pipeline_issue', ['a'])]);
    expect(cleanApproval([entry('a', CLEAN)], groups).items).toHaveLength(1);
  });

  it('says nothing about scores when there is nothing to approve', () => {
    expect(cleanApproval([entry('u', {})], NO_WARNINGS)).toMatchObject({
      items: [],
      unscored: 1,
      lowestScore: null,
      highestScore: null,
    });
  });
});

describe('spotCheckSample', () => {
  const items = (count: number) => Array.from({ length: count }, (_, index) => ({ localId: `i${index}`, qualityScore: 50 + index }));
  const ids = (list: Array<{ localId: string }>) => list.map((item) => item.localId);

  it('takes everything when there are three or fewer', () => {
    expect(ids(spotCheckSample(items(2)))).toEqual(['i0', 'i1']);
    expect(ids(spotCheckSample(items(3)))).toEqual(['i0', 'i1', 'i2']);
    expect(spotCheckSample([])).toEqual([]);
  });

  it('takes max(3, ceil(N/10)) items, the lowest score first and then evenly spaced up to the highest', () => {
    expect(ids(spotCheckSample(items(10)))).toEqual(['i0', 'i5', 'i9']);
    expect(spotCheckSample(items(25))).toHaveLength(3);
    expect(spotCheckSample(items(31))).toHaveLength(4);
    const sample = ids(spotCheckSample(items(100)));
    expect(sample).toHaveLength(10);
    expect(sample[0]).toBe('i0');
    expect(sample[9]).toBe('i99');
    expect(new Set(sample).size).toBe(10);
  });

  it('is deterministic and never repeats an item', () => {
    for (const count of [4, 5, 7, 11, 29, 30, 64]) {
      const first = ids(spotCheckSample(items(count)));
      expect(ids(spotCheckSample(items(count)))).toEqual(first);
      expect(new Set(first).size).toBe(first.length);
    }
  });
});
