import { describe, it, expect } from 'vitest';
import { appendNarration } from './narrationLog';
import type { NarrationEvent } from '../api/events';

const narration = (phase: NarrationEvent['phase'], extra: Partial<NarrationEvent> = {}): NarrationEvent => ({
  phase, branchIndex: null, branchCount: 0, blocksDone: 0, blocksTotal: 0, kbGrounded: false, kbCitations: [], message: phase, ...extra,
});

describe('appendNarration', () => {
  it('appends ordinary events and keeps only the newest 50', () => {
    let log: NarrationEvent[] = [];
    for (let i = 0; i < 60; i += 1) log = appendNarration(log, narration('analyze_section', { blocksDone: i }));
    expect(log).toHaveLength(50);
    expect(log[0].blocksDone).toBe(10);
    expect(log[49].blocksDone).toBe(59);
  });

  it('lets consecutive lines of the same overview step replace each other, so a long step is one row', () => {
    let log: NarrationEvent[] = [narration('parse_done')];
    for (const seconds of [0, 10, 20, 30]) log = appendNarration(log, narration('primer', { primerStep: 'reading', elapsedSeconds: seconds }));
    expect(log.map((n) => n.phase)).toEqual(['parse_done', 'primer']);
    expect(log[1].elapsedSeconds).toBe(30);
  });

  it('keeps a row per overview step: uploading, processing and reading are different rows', () => {
    let log: NarrationEvent[] = [];
    for (const step of ['uploading', 'processing', 'reading', 'done'] as const) log = appendNarration(log, narration('primer', { primerStep: step }));
    expect(log.map((n) => n.primerStep)).toEqual(['uploading', 'processing', 'reading', 'done']);
  });
});
