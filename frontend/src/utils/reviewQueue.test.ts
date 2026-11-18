import { describe, it, expect } from 'vitest';
import type { WarningRecord } from './warnings';
import { buildKindGroups, kindMeta } from './warningKinds';
import {
  buildReviewQueue,
  isExcludedWithAncestors,
  nextInQueue,
  cleanApproval,
  groupReviewQueue,
  reviewGroupOf,
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
    // Requirements first (in tree order), then the structure tier (in tree order).
    expect(queue.map((item) => item.localId)).toEqual(['r1', 'r2', 'epic', 'f1', 'f2']);
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

  it('finishing ends a running queue and marks it done, but does nothing from any other mode (finish-from-off is no longer blessed; markDone covers it)', () => {
    expect(reviewQueueModeReducer(QUEUE, 'finish')).toEqual(DONE);
    expect(reviewQueueModeReducer(OFF, 'finish')).toBe(OFF);
    expect(reviewQueueModeReducer({ kind: 'spotCheck' }, 'finish')).toEqual({ kind: 'spotCheck' });
  });

  it('markDone shows the "done" row from off or done, and leaves a running queue or spot-check alone', () => {
    expect(reviewQueueModeReducer(OFF, 'markDone')).toEqual(DONE);
    expect(reviewQueueModeReducer(DONE, 'markDone')).toBe(DONE);
    expect(reviewQueueModeReducer(QUEUE, 'markDone')).toBe(QUEUE);
    const spot: ReviewQueueMode = { kind: 'spotCheck' };
    expect(reviewQueueModeReducer(spot, 'markDone')).toBe(spot);
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

describe('reviewQueueModeReducer: every action from every mode', () => {
  const MODES: Record<'off' | 'queue' | 'spotCheck' | 'done', ReviewQueueMode> = {
    off: { kind: 'off' },
    queue: { kind: 'queue' },
    spotCheck: { kind: 'spotCheck' },
    done: { kind: 'done' },
  };
  type Kind = keyof typeof MODES;
  const TABLE: Record<ReviewQueueModeAction, Record<Kind, Kind>> = {
    open: { off: 'queue', queue: 'queue', spotCheck: 'queue', done: 'queue' },
    close: { off: 'off', queue: 'off', spotCheck: 'spotCheck', done: 'done' },
    finish: { off: 'off', queue: 'done', spotCheck: 'spotCheck', done: 'done' },
    markDone: { off: 'done', queue: 'queue', spotCheck: 'spotCheck', done: 'done' },
    clearDone: { off: 'off', queue: 'queue', spotCheck: 'spotCheck', done: 'off' },
    startSpotCheck: { off: 'spotCheck', queue: 'spotCheck', spotCheck: 'spotCheck', done: 'spotCheck' },
    endSpotCheck: { off: 'off', queue: 'queue', spotCheck: 'off', done: 'done' },
  };
  const cases = (Object.keys(TABLE) as ReviewQueueModeAction[]).flatMap((action) =>
    (Object.keys(MODES) as Kind[]).map((from) => [action, from, TABLE[action][from]] as const),
  );

  it.each(cases)('%s from %s ends in %s', (action, from, expected) => {
    const result = reviewQueueModeReducer(MODES[from], action);
    expect(result.kind).toBe(expected);
    // A no-op returns the same object, so the dispatch does not re-render.
    if (expected === from) expect(result).toBe(MODES[from]);
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

  it.each([
    [1, 1],
    [3, 3],
    [10, 3],
    [11, 3],
    [30, 3],
    [31, 4],
    [100, 10],
  ])('a list of %i clean items gets a sample of %i', (total, size) => {
    expect(spotCheckSample(items(total))).toHaveLength(size);
  });

  it('is recomputed from what is left after an item is removed, and stays deterministic', () => {
    const all = items(31);
    expect(spotCheckSample(all)).toHaveLength(4);
    // One clean item is excluded: 30 are left, so the sample shrinks to 3 and is the one for the smaller list.
    const fewer = all.filter((item) => item.localId !== 'i7');
    const sample = ids(spotCheckSample(fewer));
    expect(sample).toHaveLength(3);
    expect(sample).toEqual(ids([0, 15, 29].map((index) => fewer[index])));
    expect(sample).not.toContain('i7');
    expect(ids(spotCheckSample(fewer))).toEqual(sample);
  });
});

describe('isExcludedWithAncestors', () => {
  it('is true for an excluded entry or one under an excluded ancestor, false otherwise, and survives a parent cycle', () => {
    const entries = [
      entry('root', { excluded: true }),
      entry('child', { parentLocalId: 'root' }),
      entry('free'),
      entry('loopA', { parentLocalId: 'loopB' }),
      entry('loopB', { parentLocalId: 'loopA' }),
    ];
    const byId = new Map(entries.map((e) => [e.localId, e]));
    expect(isExcludedWithAncestors(byId.get('root')!, byId)).toBe(true);
    expect(isExcludedWithAncestors(byId.get('child')!, byId)).toBe(true);
    expect(isExcludedWithAncestors(byId.get('free')!, byId)).toBe(false);
    expect(isExcludedWithAncestors(byId.get('loopA')!, byId)).toBe(false);
  });
});

describe('the structure tier (Epics and Features are not scored, so they never lead the queue)', () => {
  it('puts an Epic or Feature with a low score in the structure tier, not low_score', () => {
    expect(riskTier(entry('e', { type: 'Epic', qualityScore: 15 }), NO_WARNINGS)).toBe('structure');
    expect(riskTier(entry('f', { type: 'Feature', qualityScore: 25, qualityConfidence: 'low' }), NO_WARNINGS)).toBe('structure');
    expect(riskTier(entry('r', { qualityScore: 15 }), NO_WARNINGS)).toBe('low_score');
  });

  it('keeps a blocking or review warning on a parent: only the score is ignored', () => {
    const fix = buildKindGroups([warning('parent_title_collision', 'needs_review', ['e'])]);
    expect(riskTier(entry('e', { type: 'Epic', qualityScore: 15 }), fix)).toBe('blocking');
    const review = buildKindGroups([warning('low_grounding', 'needs_review', ['f'])]);
    expect(riskTier(entry('f', { type: 'Feature', qualityScore: 15 }), review)).toBe('flagged');
  });

  it('queues every Requirement before any Epic or Feature, however the scores compare', () => {
    const queue = buildReviewQueue(
      [
        entry('epic', { type: 'Epic', qualityScore: 5 }),
        entry('feature', { type: 'Feature', qualityScore: 10 }),
        entry('req-clean', { qualityScore: 90, groundingScore: 0.9 }),
        entry('req-low', { qualityScore: 40 }),
      ],
      NO_WARNINGS,
    );
    expect(queue.map((item) => item.localId)).toEqual(['req-low', 'req-clean', 'epic', 'feature']);
  });

  it('never offers an Epic or Feature for bulk approval, and counts it as unscored, not as flagged', () => {
    const result = cleanApproval(
      [entry('epic', { type: 'Epic', qualityScore: 80, groundingScore: 0.9 }), entry('req', { qualityScore: 80, groundingScore: 0.9 })],
      NO_WARNINGS,
    );
    expect(result.items.map((item) => item.localId)).toEqual(['req']);
    expect(result).toMatchObject({ flagged: 0, unscored: 1 });
  });

  it('explains a structure item as not scored, with no score claim', () => {
    const reason = riskReason(entry('e', { type: 'Epic', qualityScore: 15 }), NO_WARNINGS);
    expect(reason.title).toBe('Not scored');
    expect(reason.group).toBe('info');
    expect(reason.todo).not.toMatch(/quality score|\d/i);
  });

  it('stays linear: 20,000 entries order in well under a second', () => {
    const entries = Array.from({ length: 20000 }, (_, i) => entry(`n${i}`, { type: i % 10 === 0 ? 'Feature' : 'Requirement', qualityScore: i % 100 }));
    const started = performance.now();
    const queue = buildReviewQueue(entries, NO_WARNINGS);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(queue).toHaveLength(20000);
  });
});

describe('nextInQueue', () => {
  const q = ['a', 'b', 'c', 'd'].map((localId) => entry(localId));
  const ids = (list: ReviewQueueEntry[]) => list.map((item) => item.localId);

  it('steps to the first remaining item after the current one, not back to the top', () => {
    expect(nextInQueue(q, 'b', q.filter((item) => item.localId !== 'b'))?.localId).toBe('c');
  });

  it('skips items that left the queue with the current one (an excluded subtree)', () => {
    expect(nextInQueue(q, 'a', q.filter((item) => !['a', 'b', 'c'].includes(item.localId)))?.localId).toBe('d');
  });

  it('wraps to the top when the current item was last', () => {
    expect(nextInQueue(q, 'd', q.filter((item) => item.localId !== 'd'))?.localId).toBe('a');
  });

  it('falls back to the first remaining item when the current one is not in the queue', () => {
    expect(nextInQueue(q, 'zzz', q)?.localId).toBe('a');
  });

  it('is undefined when nothing remains', () => {
    expect(nextInQueue(q, 'a', [])).toBeUndefined();
  });

  it('does not mutate its inputs and stays linear on a long queue', () => {
    const big = Array.from({ length: 20000 }, (_, i) => entry(`n${i}`));
    const rest = big.filter((item) => item.localId !== 'n10000');
    const before = ids(big).join();
    const started = performance.now();
    expect(nextInQueue(big, 'n10000', rest)?.localId).toBe('n10001');
    expect(performance.now() - started).toBeLessThan(200);
    expect(ids(big).join()).toBe(before);
  });
});

describe('the four review groups', () => {
  it('maps the tiers onto Fix before writing, Check, Clean and Structure (Check is low score plus flagged)', () => {
    expect(reviewGroupOf('blocking')).toBe('fix');
    expect(reviewGroupOf('low_score')).toBe('check');
    expect(reviewGroupOf('flagged')).toBe('check');
    expect(reviewGroupOf('clean')).toBe('clean');
    expect(reviewGroupOf('structure')).toBe('structure');
  });

  it('groups what is still to review, in queue order, and leaves reviewed and excluded items out', () => {
    const groups = buildKindGroups([warning('missing_source_reference', 'needs_review', ['blocked'])]);
    const grouped = groupReviewQueue(
      [
        entry('clean', { qualityScore: 90, groundingScore: 0.9 }),
        entry('low', { qualityScore: 30 }),
        entry('flag', { qualityScore: 80, qualityConfidence: 'low' }),
        entry('blocked', { qualityScore: 99 }),
        entry('epic', { type: 'Epic' }),
        entry('done', { reviewed: true }),
        entry('out', { excluded: true }),
      ],
      groups,
    );
    expect(grouped.fix.map((item) => item.localId)).toEqual(['blocked']);
    expect(grouped.check.map((item) => item.localId)).toEqual(['low', 'flag']);
    expect(grouped.clean.map((item) => item.localId)).toEqual(['clean']);
    expect(grouped.structure.map((item) => item.localId)).toEqual(['epic']);
  });

  it('classifies 20,000 entries against a kind naming 10,000 of them in linear time (the warning sets are built once)', () => {
    const entries = Array.from({ length: 20000 }, (_, i) => entry(`n${i}`, { qualityScore: 80, groundingScore: 0.9 }));
    const groups = buildKindGroups([warning('missing_source_reference', 'needs_review', entries.slice(0, 10000).map((item) => item.localId))]);
    const started = performance.now();
    const grouped = groupReviewQueue(entries, groups);
    const approval = cleanApproval(entries, groups);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(grouped.fix).toHaveLength(10000);
    expect(grouped.clean).toHaveLength(10000);
    expect(approval.items).toHaveLength(10000);
    expect(approval.flagged).toBe(10000);
  });
});

describe('a kind the reviewer has accepted no longer blocks or ranks its items (one handled state)', () => {
  const acked = (kind: string, nodeIds: string[]): WarningRecord => ({ kind, severity: 'needs_review', nodeIds, detail: {}, raw: `${kind} raw`, acknowledged: true });

  it('moves the items of a fully acknowledged fix kind out of "blocking" into the tier their own signals give them', () => {
    const groups = buildKindGroups([acked('missing_source_reference', ['a', 'b'])]);
    expect(riskTier(entry('a', { qualityScore: 95, groundingScore: 0.9 }), groups)).toBe('clean');
    expect(riskTier(entry('b', { qualityScore: 30 }), groups)).toBe('low_score');
    const grouped = groupReviewQueue([entry('a', { qualityScore: 95, groundingScore: 0.9 }), entry('b', { qualityScore: 30 })], groups);
    expect(grouped.fix).toHaveLength(0);
  });

  it('keeps a kind that is only partly acknowledged blocking', () => {
    const open: WarningRecord = { kind: 'missing_source_reference', severity: 'needs_review', nodeIds: ['b'], detail: {}, raw: 'other raw' };
    const groups = buildKindGroups([acked('missing_source_reference', ['a']), open]);
    expect(riskTier(entry('b', { qualityScore: 95 }), groups)).toBe('blocking');
  });

  it('treats an acknowledged review kind the same way', () => {
    const groups = buildKindGroups([acked('low_grounding', ['a'])]);
    expect(riskTier(entry('a', { qualityScore: 95, groundingScore: 0.9 }), groups)).toBe('clean');
  });

  it('keeps the items of a per-item Fix kind blocking even when its records were acknowledged (only item decisions clear it)', () => {
    const groups = buildKindGroups([acked('duplicate_customer_id', ['a'])]);
    expect(riskTier(entry('a', { qualityScore: 95, groundingScore: 0.9 }), groups)).toBe('blocking');
    expect(riskReason(entry('a', { qualityScore: 95 }), groups).title).toContain('Blocking warning');
    expect(groupReviewQueue([entry('a', { qualityScore: 95 })], groups).fix).toHaveLength(1);
  });

  it('does not explain an item by a warning that was accepted', () => {
    const groups = buildKindGroups([acked('missing_source_reference', ['a'])]);
    expect(riskReason(entry('a', { qualityScore: 30 }), groups).title).toBe('Low quality score');
  });
});

describe('riskReason for a parent ignores its score, as the tier does', () => {
  it('does not give a flagged Epic or Feature a quality-score reason', () => {
    const groups = buildKindGroups([warning('low_grounding', 'needs_review', ['f'])]);
    const reason = riskReason(entry('f', { type: 'Feature', qualityScore: 15, qualityConfidence: 'low', groundingScore: 0.9 }), groups);
    expect(reason.title).not.toMatch(/quality|score|unsure/i);
  });

  it('does not flag a parent for loose wording either: only a review warning does', () => {
    const reason = riskReason(entry('f', { type: 'Feature', qualityScore: 15, groundingScore: 0.1 }), NO_WARNINGS);
    expect(reason.title).not.toMatch(/grounding|wording|source|quality score/i);
  });
});
