import { describe, it, expect } from 'vitest';
import { figureTally, outcomeLine, outcomeOf, outcomesFromHistory, reasonOf, reasonsFromHistory } from './figureOutcomes';
import type { NarrationEvent } from '../api/events';

const event = (extra: Partial<NarrationEvent>): NarrationEvent => ({
  phase: 'describe_figure', branchIndex: null, branchCount: 0, blocksDone: 0, blocksTotal: 0, kbGrounded: false, kbCitations: [], message: 'm', ...extra,
});

describe('outcomeOf', () => {
  it('reads a figure the model judged not significant, and one it failed on', () => {
    expect(outcomeOf(event({ figureIndex: 2, figureCaptionStatus: 'insignificant' }))).toEqual([2, 'insignificant']);
    expect(outcomeOf(event({ figureIndex: 4, figureCaptionStatus: 'vision_failed' }))).toEqual([4, 'vision_failed']);
  });

  it('ignores described figures, figures still being worked on, and other phases', () => {
    expect(outcomeOf(event({ figureIndex: 1, figureCaption: 'a caption' }))).toBeNull();
    expect(outcomeOf(event({ figureIndex: 3 }))).toBeNull();
    expect(outcomeOf(event({ phase: 'parse_done', figureIndex: 2, figureCaptionStatus: 'vision_failed' }))).toBeNull();
    expect(outcomeOf(event({ figureCaptionStatus: 'vision_failed' }))).toBeNull();
  });
});

describe('outcomesFromHistory', () => {
  it('rebuilds every outcome from the stored event history, so a reloaded page shows them too', () => {
    const history = [
      { detail: event({ figureIndex: 2, figureCaptionStatus: 'insignificant' }) },
      { detail: event({ figureIndex: 1, figureCaption: 'ok' }) },
      { detail: { not: 'a narration' } },
      { detail: event({ figureIndex: 4, figureCaptionStatus: 'vision_failed' }) },
      { detail: null },
    ];
    expect(outcomesFromHistory(history)).toEqual({ 2: 'insignificant', 4: 'vision_failed' });
  });
});

describe('figureTally', () => {
  it('says how many were described, not significant and failed, leaving out the zeros', () => {
    expect(figureTally(3, { 2: 'insignificant', 4: 'vision_failed', 5: 'vision_failed' })).toBe('3 described · 1 not significant · 2 failed');
    expect(figureTally(2, {})).toBe('2 described');
    expect(figureTally(0, { 4: 'vision_failed' })).toBe('1 failed');
    expect(figureTally(0, {})).toBe('');
  });
});


describe('the reason the model gave for a not-significant verdict', () => {
  it('reads it from the event of that figure only', () => {
    expect(reasonOf(event({ figureIndex: 2, figureCaptionStatus: 'insignificant', figureCaptionReason: 'A company logo.' }))).toEqual([2, 'A company logo.']);
    expect(reasonOf(event({ figureIndex: 2, figureCaptionStatus: 'insignificant' }))).toBeNull();
    expect(reasonOf(event({ figureIndex: 2, figureCaptionStatus: 'insignificant', figureCaptionReason: '   ' }))).toBeNull();
    expect(reasonOf(event({ figureIndex: 4, figureCaptionStatus: 'vision_failed', figureCaptionReason: 'ignored' }))).toBeNull();
  });

  it('rebuilds the reasons from the stored history, so a reloaded page keeps them', () => {
    const history = [
      { detail: event({ figureIndex: 1, figureCaptionStatus: 'insignificant', figureCaptionReason: 'A divider line.' }) },
      { detail: event({ figureIndex: 6, figureCaptionStatus: 'insignificant' }) },
      { detail: { not: 'a narration' } },
    ];
    expect(reasonsFromHistory(history)).toEqual({ 1: 'A divider line.' });
  });

  it('is one short line that names who judged, with or without a reason', () => {
    expect(outcomeLine('insignificant', 'A company logo.')).toBe('Judged by the vision model: A company logo.');
    expect(outcomeLine('insignificant', undefined)).toBe('Judged by the vision model; it gave no reason.');
    expect(outcomeLine('vision_failed', 'x')).toBeNull();
  });
});
