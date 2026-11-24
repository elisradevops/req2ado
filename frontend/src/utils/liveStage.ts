import type { JobStage, NarrationEvent } from '../api/events';
import type { ProgressEvent, StageName } from '../api/liveTypes';
import { lifecyclePhases, type LifecycleKey } from '../components/JobLifecycleSteps';
import { formatDeterministicSubtreePassSubLabel, parseDeterministicSubtreeChunk } from './deterministicSubtreeChunk';

// The ONE source of the running stage's name (DESIGN.md §11.3.5, QA P2). The phase rail's current row and the banner card
// both read it, so the page never names the same moment twice in two different words (seen live: the card said
// "Extracting deterministic hierarchy" while the rail said "pass 1 of 2 · synthesizing text").

/**
 * The finer position under a phase's name, from the latest narration: which figure, the whole-document read, or which of
 * deterministic_subtree's two chunked passes. Sourced only from data the backend already sends.
 */
export function stepSubLabelsFor(latest: NarrationEvent | null): Partial<Record<LifecycleKey, string>> {
  const labels: Partial<Record<LifecycleKey, string>> = {};
  if (latest?.phase === 'describe_figure' && latest.figureIndex != null && latest.figureCount != null) {
    labels.parse = `figures ${latest.figureIndex}/${latest.figureCount}`;
  }
  // The whole-document read is one long model call inside the Parse step; without a word under the step it looks like
  // a parser that has stopped.
  if (latest?.phase === 'primer') labels.parse = 'reading whole document';
  if (latest?.phase === 'deterministic_subtree') {
    const chunk = parseDeterministicSubtreeChunk(latest.subtreeLabel);
    if (chunk) labels.analyze = formatDeterministicSubtreePassSubLabel(chunk);
  }
  return labels;
}

export interface LiveStage {
  key: LifecycleKey;
  /** The phase's name, exactly as the rail shows it. */
  label: string;
  /** The rail's own line under the current phase, when it has a specific one. */
  line: string | null;
}

export function liveStageFor(
  mode: 'baseline' | 'survey',
  status: string,
  stage: JobStage | null,
  latest: NarrationEvent | null,
): LiveStage {
  const latestPhase = latest?.phase === 'job_failed' ? (latest.lastPhase ?? null) : (latest?.phase ?? null);
  const { liveKey, phases } = lifecyclePhases(mode, status, stage, latestPhase);
  const label = phases.find((phase) => phase.key === liveKey)?.label ?? liveKey;
  return { key: liveKey, label, line: stepSubLabelsFor(latest)[liveKey] ?? null };
}

const NARRATION_KEY: Record<NarrationEvent['phase'], LifecycleKey | null> = {
  describe_figure: 'parse',
  primer: 'parse',
  parse_done: 'parse',
  table_detected: 'parse',
  page_alignment: 'parse',
  study_window: 'parse',
  preparing_analysis: 'analyze',
  deterministic_subtree: 'analyze',
  build_skeleton: 'analyze',
  analyze_section: 'analyze',
  infer_hierarchy: 'analyze',
  generate_requirements: 'analyze',
  map_scope: 'analyze',
  section_complete: 'analyze',
  score_requirements: 'score',
  score_requirements_done: 'score',
  detect_conflicts: 'score',
  regroup_roots: 'score',
  infer_trace_links: 'score',
  dedup_check: 'dedupCheck',
  writing: 'write',
  job_failed: null,
  chunk_warning: null,
};

const COUNTED_KEY: Record<StageName, LifecycleKey> = {
  parse: 'parse',
  study: 'parse',
  draft: 'analyze',
  improve: 'analyze',
  summarize: 'analyze',
  skeleton: 'analyze',
  map: 'analyze',
  write: 'analyze',
  score: 'score',
  link: 'score',
  trace: 'score',
  criteria: 'score',
  dedup: 'dedupCheck',
  write_ado: 'write',
};

// BASELINE has no Analyze or Score phase (it runs no model), the same collapse lifecyclePhases makes.
const collapse = (mode: 'baseline' | 'survey', key: LifecycleKey): LifecycleKey =>
  mode === 'baseline' && (key === 'analyze' || key === 'score') ? 'parse' : key;

/** Which phase a narration belongs to, so a finer line is shown only under the phase it describes. */
export function phaseKeyOfNarration(mode: 'baseline' | 'survey', phase: NarrationEvent['phase']): LifecycleKey | null {
  const key = NARRATION_KEY[phase];
  return key ? collapse(mode, key) : null;
}

/**
 * A counted bar ("N of M items in this step") is drawn only when the step it counts is the phase the rail calls current;
 * otherwise its number would describe a different moment than the stage name above it.
 */
export function countedBarMatches(mode: 'baseline' | 'survey', liveKey: LifecycleKey, progress: ProgressEvent | null): boolean {
  return progress === null || collapse(mode, COUNTED_KEY[progress.stage]) === liveKey;
}
