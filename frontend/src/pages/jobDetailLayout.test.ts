import { describe, it, expect } from 'vitest';
import { isRunDetailStatus, shouldShowTiles, shouldShowTabs, shouldShowFilterBar, shouldShowNothingWrittenLine } from './jobDetailLayout';

describe('isRunDetailStatus', () => {
  it('is true only for running and writing', () => {
    expect(isRunDetailStatus('running')).toBe(true);
    expect(isRunDetailStatus('writing')).toBe(true);
    for (const status of ['pending', 'diff_ready', 'succeeded', 'rejected', 'cancelled', 'failed', null]) {
      expect(isRunDetailStatus(status)).toBe(false);
    }
  });
});

describe('shouldShowTiles', () => {
  it('is true only for diff_ready and succeeded', () => {
    expect(shouldShowTiles('diff_ready')).toBe(true);
    expect(shouldShowTiles('succeeded')).toBe(true);
    for (const status of ['pending', 'running', 'writing', 'rejected', 'cancelled', 'failed', null]) {
      expect(shouldShowTiles(status)).toBe(false);
    }
  });
});

describe('shouldShowTabs', () => {
  it.each(['writing', 'diff_ready', 'succeeded', 'rejected'])(
    'is always true for %s, even with an empty diff and no audit (a real, computed, zero-item result)',
    (status) => {
      expect(shouldShowTabs(status, 0, 0)).toBe(true);
    },
  );

  it.each(['pending', 'running', 'cancelled', 'failed', null])(
    'is false for %s when both diff and audit are empty (no computed diff exists yet)',
    (status) => {
      expect(shouldShowTabs(status, 0, 0)).toBe(false);
    },
  );

  it('is true for cancelled/failed if diff or audit somehow already has content', () => {
    expect(shouldShowTabs('cancelled', 1, 0)).toBe(true);
    expect(shouldShowTabs('failed', 0, 1)).toBe(true);
  });
});

describe('shouldShowFilterBar', () => {
  it('follows diff length alone, independent of audit', () => {
    expect(shouldShowFilterBar(0)).toBe(false);
    expect(shouldShowFilterBar(1)).toBe(true);
  });
});

describe('shouldShowNothingWrittenLine', () => {
  it('is true only while nothing can have been written yet', () => {
    for (const status of ['pending', 'running', 'diff_ready']) expect(shouldShowNothingWrittenLine(status)).toBe(true);
  });

  it('is false once a write has begun or ended, and for an unknown status', () => {
    // writing, succeeded, and failed/cancelled (which can follow a partial write) make "nothing has been written" untrue or unknown.
    for (const status of ['writing', 'succeeded', 'rejected', 'cancelled', 'failed', null]) {
      expect(shouldShowNothingWrittenLine(status)).toBe(false);
    }
  });
});

describe('shouldShowNothingWrittenLine and a partial write', () => {
  it('is false when anything has already been written, even though the status went back to diff_ready', () => {
    // A failed confirm reverts the job to diff_ready after a partial write (runbook, "P4b"); "nothing has been written" is then false.
    expect(shouldShowNothingWrittenLine('diff_ready', 3)).toBe(false);
    expect(shouldShowNothingWrittenLine('diff_ready', 0)).toBe(true);
    expect(shouldShowNothingWrittenLine('diff_ready')).toBe(true);
  });
});
