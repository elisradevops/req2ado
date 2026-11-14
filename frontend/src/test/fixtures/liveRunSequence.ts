import type { JobStage, NarrationEvent } from '../../api/events';
import type { ProgressEvent } from '../../api/liveTypes';

// A recorded-shape replay of a SURVEY run's live events (modelled on the AirPro run QA watched, QA P2): the job stage,
// narration and counted-progress events in the order the page receives them, each step with the ONE stage name the rail
// and the banner card must both show after it. Field shapes match the real payloads (api/events.ts, api/liveTypes.ts).

const narration = (phase: NarrationEvent['phase'], extra: Partial<NarrationEvent> = {}): NarrationEvent => ({
  phase,
  branchIndex: null,
  branchCount: 0,
  blocksDone: 0,
  blocksTotal: 0,
  kbGrounded: false,
  kbCitations: [],
  message: `${phase} message`,
  ...extra,
});

let seq = 0;
const progress = (stage: ProgressEvent['stage'], pct: number, done: number, total: number): ProgressEvent => ({
  type: 'progress', seq: ++seq, pct, stage, unit: 'items', done, total, estimated: true, emittedAt: '2026-11-13T09:00:00Z',
});

export type LiveRunStep =
  | { kind: 'stage'; stage: JobStage; status?: 'running' | 'writing' }
  | { kind: 'narration'; event: NarrationEvent }
  | { kind: 'progress'; event: ProgressEvent };

export interface ExpectedStage {
  /** The one stage name (the rail's current row label, the card's headline). */
  label: string;
  /** The rail's line under the current row, which the card repeats under its headline; null when the rail has none. */
  line: string | null;
  /** Whether the counted "N of M in this step" bar may be drawn (its step is the current stage). */
  countedBar: boolean;
  /** Whether the deterministic_subtree chunk bar may be drawn. */
  chunkBar: boolean;
}

export const LIVE_RUN_SEQUENCE: { step: LiveRunStep; expect: ExpectedStage }[] = [
  { step: { kind: 'stage', stage: 'parse' }, expect: { label: 'Parse', line: null, countedBar: true, chunkBar: false } },
  {
    step: { kind: 'narration', event: narration('describe_figure', { figureIndex: 1, figureCount: 3, message: 'Describing figure 1 of 3' }) },
    expect: { label: 'Parse', line: 'figures 1/3', countedBar: true, chunkBar: false },
  },
  { step: { kind: 'progress', event: progress('parse', 1, 1, 3) }, expect: { label: 'Parse', line: 'figures 1/3', countedBar: true, chunkBar: false } },
  {
    step: { kind: 'narration', event: narration('parse_done', { blocksDone: 682, blocksTotal: 682 }) },
    expect: { label: 'Parse', line: null, countedBar: true, chunkBar: false },
  },
  // The stage moves on before any counted progress for the new step: the parse count must not sit under "Analyze".
  { step: { kind: 'stage', stage: 'infer_hierarchy_start' }, expect: { label: 'Analyze', line: null, countedBar: false, chunkBar: false } },
  {
    // The moment QA saw at 2%: card "Extracting deterministic hierarchy", rail "pass 1 of 2 · synthesizing text".
    step: {
      kind: 'narration',
      event: narration('deterministic_subtree', {
        blocksTotal: 150,
        subtreeLabel: 'synthesizing requirement text for 150 node(s) (chunk 1 of 1)',
        message: 'Synthesizing requirement text for 150 node(s) (chunk 1 of 1)',
      }),
    },
    expect: { label: 'Analyze', line: 'pass 1 of 2 · synthesizing text', countedBar: false, chunkBar: false },
  },
  {
    step: { kind: 'progress', event: progress('draft', 2, 0, 150) },
    expect: { label: 'Analyze', line: 'pass 1 of 2 · synthesizing text', countedBar: true, chunkBar: true },
  },
  {
    step: {
      kind: 'narration',
      event: narration('deterministic_subtree', {
        blocksTotal: 150,
        subtreeLabel: 'enhancing titles/tags for 150 node(s) (chunk 1 of 1)',
        message: 'Enhancing titles/tags for 150 node(s) (chunk 1 of 1)',
      }),
    },
    // The counted step is still "draft": the chunk bar for the title pass would count something else.
    expect: { label: 'Analyze', line: 'pass 2 of 2 · enhancing titles/tags', countedBar: true, chunkBar: false },
  },
  {
    step: { kind: 'progress', event: progress('improve', 12, 40, 150) },
    expect: { label: 'Analyze', line: 'pass 2 of 2 · enhancing titles/tags', countedBar: true, chunkBar: true },
  },
  {
    step: { kind: 'narration', event: narration('build_skeleton', { branchIndex: 0, branchCount: 2, blocksTotal: 10, sectionLabel: 'Airflow' }) },
    expect: { label: 'Analyze', line: null, countedBar: true, chunkBar: false },
  },
  {
    step: { kind: 'narration', event: narration('score_requirements', { blocksDone: 0, blocksTotal: 120, chunkIndex: 0, chunkCount: 3 }) },
    expect: { label: 'Score', line: null, countedBar: false, chunkBar: false },
  },
  { step: { kind: 'progress', event: progress('score', 40, 48, 120) }, expect: { label: 'Score', line: null, countedBar: true, chunkBar: false } },
  { step: { kind: 'stage', stage: 'dedup_check' }, expect: { label: 'Dedup check', line: null, countedBar: false, chunkBar: false } },
  {
    step: { kind: 'narration', event: narration('dedup_check', { blocksDone: 3, blocksTotal: 120 }) },
    expect: { label: 'Dedup check', line: null, countedBar: false, chunkBar: false },
  },
  { step: { kind: 'progress', event: progress('dedup', 90, 3, 120) }, expect: { label: 'Dedup check', line: null, countedBar: true, chunkBar: false } },
];

/** A narration for the idle tests: a Score batch that then reports nothing. */
export const SCORE_BATCH = narration('score_requirements', { blocksDone: 48, blocksTotal: 120, chunkIndex: 1, chunkCount: 3 });
export const NEXT_SCORE_BATCH = narration('score_requirements', { blocksDone: 96, blocksTotal: 120, chunkIndex: 2, chunkCount: 3 });
