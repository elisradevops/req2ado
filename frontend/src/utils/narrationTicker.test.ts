import { describe, it, expect } from 'vitest';
import { tickerFor } from './narrationTicker';
import { INGESTION_NARRATION_PHASES, type NarrationEvent } from '../api/events';

function baseNarration(phase: NarrationEvent['phase'], overrides: Partial<NarrationEvent> = {}): NarrationEvent {
  return {
    phase,
    branchIndex: null,
    branchCount: 0,
    blocksDone: 0,
    blocksTotal: 0,
    kbGrounded: false,
    kbCitations: [],
    message: '',
    ...overrides,
  };
}

const WRITE_SUB_PHASES: NonNullable<NarrationEvent['writeSubPhase']>[] = ['discover_types', 'create', 'link_parents', 'trace_links'];

describe('tickerFor', () => {
  it('never returns an empty sentence for any ingestion narration phase, with or without a real message', () => {
    for (const phase of INGESTION_NARRATION_PHASES) {
      const withMessage = tickerFor({ status: 'running', stage: null, latest: baseNarration(phase, { message: 'real message' }) });
      expect(withMessage.sentence.length).toBeGreaterThan(0);

      // A blank message from a malformed/future backend event must still
      // fall through to a non-empty fallback -- see PHASE_FALLBACK_SENTENCES.
      const blankMessage = tickerFor({ status: 'running', stage: null, latest: baseNarration(phase, { message: '' }) });
      expect(blankMessage.sentence.length).toBeGreaterThan(0);
    }
  });

  it('never returns an empty sentence for the orchestrator-only phases (dedup_check, writing)', () => {
    for (const phase of ['dedup_check', 'writing'] as const) {
      const result = tickerFor({ status: 'running', stage: null, latest: baseNarration(phase, { message: '' }) });
      expect(result.sentence.length).toBeGreaterThan(0);
    }
  });

  it('never returns an empty sentence for every writeSubPhase', () => {
    for (const writeSubPhase of WRITE_SUB_PHASES) {
      const result = tickerFor({
        status: 'writing',
        stage: 'writing',
        latest: baseNarration('writing', { writeSubPhase, message: '' }),
      });
      expect(result.sentence.length).toBeGreaterThan(0);
    }
  });

  it('gives each writeSubPhase its own distinct sentence, not the generic "writing" message', () => {
    const sentences = WRITE_SUB_PHASES.map(
      (writeSubPhase) => tickerFor({ status: 'writing', stage: 'writing', latest: baseNarration('writing', { writeSubPhase }) }).sentence,
    );
    expect(new Set(sentences).size).toBe(WRITE_SUB_PHASES.length);
  });

  it('never returns an empty sentence with no narration at all, for any status/stage combination', () => {
    const statuses = ['pending', 'running', 'writing', 'diff_ready', 'succeeded', 'rejected', 'cancelled', 'failed'];
    for (const status of statuses) {
      expect(tickerFor({ status, stage: null, latest: null }).sentence.length).toBeGreaterThan(0);
      expect(tickerFor({ status, stage: 'parse', latest: null }).sentence.length).toBeGreaterThan(0);
    }
  });

  it('drives the dedup_check counter from blocksDone/blocksTotal, and marks it determinate', () => {
    const result = tickerFor({ status: 'running', stage: 'dedup_check', latest: baseNarration('dedup_check', { blocksDone: 12, blocksTotal: 40 }) });
    expect(result.counter).toBe('12 / 40');
    expect(result.determinate).toBe(30);
  });

  it('drives the writing counter from blocksDone/blocksTotal, and marks it determinate', () => {
    const result = tickerFor({
      status: 'writing',
      stage: 'writing',
      latest: baseNarration('writing', { writeSubPhase: 'create', blocksDone: 5, blocksTotal: 10 }),
    });
    expect(result.counter).toBe('5 / 10');
    expect(result.determinate).toBe(50);
  });

  it('leaves determinate undefined for phases with no real N-of-M count', () => {
    const result = tickerFor({ status: 'running', stage: null, latest: baseNarration('analyze_section', { blocksDone: 1, blocksTotal: 0 }) });
    expect(result.determinate).toBeUndefined();
  });

  it('surfaces parse_done block/table/figure counts as a real counter, not just buried in the message', () => {
    const result = tickerFor({
      status: 'running',
      stage: 'parse',
      latest: baseNarration('parse_done', { blockCount: 682, tableCount: 5, figureCount: 39, message: 'Finished parsing the document' }),
    });
    expect(result.counter).toBe('682 blocks · 5 tables · 39 figures');
  });
});
