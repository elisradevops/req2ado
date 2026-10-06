import { describe, it, expect } from 'vitest';
import { STAGE_NAMES, type ProgressEvent } from '../api/liveTypes';
import {
  STAGE_COPY,
  describeCountedProgress,
  describeCountedValueText,
  describeStepCount,
  compareSideLabel,
  formatIdle,
  readableTitle,
  unitName,
} from './liveCopy';

const progress = (extra: Partial<ProgressEvent> = {}): ProgressEvent => ({
  type: 'progress', seq: 1, pct: 38, stage: 'improve', unit: 'items', done: 12, total: 36, estimated: true,
  emittedAt: 'x', ...extra,
});

describe('live run copy', () => {
  it('has a headline and a why-sentence for every stage', () => {
    for (const stage of STAGE_NAMES) {
      expect(STAGE_COPY[stage].headline.length).toBeGreaterThan(3);
      expect(STAGE_COPY[stage].why.endsWith('.')).toBe(true);
    }
  });

  it('keeps to the voice rules: sentence case, no exclamation marks, no internal names', () => {
    const banned = /(EARS|INCOSE|29148|dedup_check|subtree|LLM|!)/;
    for (const stage of STAGE_NAMES) {
      const { headline, why } = STAGE_COPY[stage];
      expect(`${headline} ${why}`).not.toMatch(banned);
      expect(headline[0]).toBe(headline[0].toUpperCase());
      // Sentence case: after the first letter, only the product name may be capitalised.
      const rest = headline.slice(1).replace('Azure DevOps', 'azure devops');
      expect(rest).toBe(rest.toLowerCase());
    }
  });

  it('pluralises unit names', () => {
    expect(unitName('items', 1)).toBe('item');
    expect(unitName('items', 36)).toBe('items');
    expect(unitName('passes', 3)).toBe('passes');
  });

  it('describes a counted step, and says nothing when there is no real total', () => {
    expect(describeStepCount(progress())).toBe('12 of 36 items');
    expect(describeStepCount(progress({ done: 5000, total: 12000 }))).toBe('5,000 of 12,000 items');
    expect(describeStepCount(progress({ total: 0 }))).toBeNull();
    expect(describeStepCount(progress({ done: 99, total: 10 }))).toBe('10 of 10 items');
  });

  it('labels the percentage as an estimate and names the step count', () => {
    expect(describeCountedProgress(progress())).toBe('38% of the run (est.) — 12 of 36 items in this step');
    expect(describeCountedProgress(progress({ total: 0 }))).toBe('38% of the run (est.)');
    expect(describeCountedProgress(progress({ estimated: false, pct: 100 }))).toContain('100% of the run —');
    expect(describeCountedValueText(progress())).toBe('38 percent of the run, estimated');
  });

  it('formats idle time', () => {
    expect(formatIdle(45)).toBe('45s');
    expect(formatIdle(60)).toBe('1m');
    expect(formatIdle(130)).toBe('2m 10s');
    expect(formatIdle(-3)).toBe('0s');
  });
});

describe('readable names (internal ids are never shown)', () => {
  const titles = new Map([['det0_1', 'Bus voltage']]);

  it('prefers the title the run sent, then the heading from the map, then nothing', () => {
    expect(readableTitle('Sent title', 'det0_1', titles)).toBe('Sent title');
    expect(readableTitle('  ', 'det0_1', titles)).toBe('Bus voltage');
    expect(readableTitle(null, 'det0_1', titles)).toBe('Bus voltage');
    expect(readableTitle(null, 'det0_9', titles)).toBeNull();
    expect(readableTitle(null, null, titles)).toBeNull();
    expect(readableTitle(undefined, 'det0_1')).toBeNull();
  });

  it('labels comparison sides without ever using a ref', () => {
    expect(compareSideLabel('conflict', 'a', 'det0_1', titles)).toEqual({ label: 'Bus voltage', name: 'Statement: Bus voltage' });
    expect(compareSideLabel('conflict', 'a', 'det0_9', titles)).toEqual({ label: 'First statement', name: 'First statement' });
    expect(compareSideLabel('conflict', 'b', 'det0_9')).toEqual({ label: 'Second statement', name: 'Second statement' });
    expect(compareSideLabel('duplicate', 'a', 'proposed').label).toBe('Proposed item');
    expect(compareSideLabel('duplicate', 'b', '2043').label).toBe('Existing work item 2043');
    expect(compareSideLabel('duplicate', 'b', 'vec-ab12').label).toBe('Existing work item');
  });
});
