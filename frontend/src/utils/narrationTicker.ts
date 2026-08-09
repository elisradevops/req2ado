import type { JobStage, NarrationEvent } from '../api/events';

export interface TickerResult {
  // Never empty -- see sentenceFor's fallback chain. This is the whole
  // point: a bare spinner with no text is exactly the "2+ minutes and I
  // have no idea what's happening" complaint this exists to fix.
  sentence: string;
  counter: string | null;
  // A 0-100 progress value when a real N-of-M count exists for the current
  // phase (today: dedup_check, writing), undefined otherwise -- callers
  // render an indeterminate bar/spinner when this is undefined.
  determinate: number | undefined;
}

// 'writing' only -- confirm() is several sequential sub-phases, each with
// its own sentence, so the ticker stays truthful about which one is
// actually running instead of a single frozen "Writing to Azure DevOps..."
// for the whole multi-minute write (DESIGN.md Track B, phase B4/B5).
const WRITE_SUBPHASE_SENTENCES: Record<NonNullable<NarrationEvent['writeSubPhase']>, string> = {
  discover_types: 'Resolving work-item types and fields for this project.',
  create: 'Creating work items in Azure DevOps.',
  link_parents: 'Linking parent/child relations.',
  trace_links: 'Writing trace links.',
};

// Defensive non-empty fallback if a narration event's own `message` were
// ever blank -- every phase actually emitted always sets a real message
// today, but tickerFor must never render an empty sentence regardless.
const PHASE_FALLBACK_SENTENCES: Record<NarrationEvent['phase'], string> = {
  describe_figure: 'Describing an embedded figure.',
  parse_done: 'Finished parsing the document.',
  table_detected: 'Detected a table.',
  preparing_analysis: 'Preparing analysis.',
  deterministic_subtree: 'Extracting a deterministic hierarchy subtree.',
  analyze_section: 'Analyzing and synthesizing requirements.',
  infer_hierarchy: 'Analyzing structure.',
  generate_requirements: 'Generating requirements.',
  score_requirements: 'Scoring quality.',
  score_requirements_done: 'Scoring complete.',
  section_complete: 'Section complete.',
  detect_conflicts: 'Checking for conflicts.',
  regroup_roots: 'Grouping by topic.',
  infer_trace_links: 'Resolving trace links.',
  dedup_check: 'Checking for existing/duplicate work items.',
  writing: 'Writing to Azure DevOps.',
  job_failed: 'Job failed.',
  // Never actually looked up -- JobDetail.tsx deliberately excludes
  // chunk_warning from the `narrations` array tickerFor reads (see its own
  // comment), so it can never become `latest` here. Present only so this
  // Record stays exhaustive over NarrationEvent['phase'].
  chunk_warning: 'A chunk of work failed.',
};

// Used only when no narration has arrived yet for the job's current stage
// (e.g. right after the stage changes, before the first narration event).
const STAGE_FALLBACK_SENTENCES: Record<JobStage, string> = {
  parse: 'Parsing document...',
  infer_hierarchy_start: 'Analyzing structure...',
  infer_hierarchy_done: 'Structure analysis complete.',
  generate_requirements_start: 'Generating requirements...',
  generate_requirements_done: 'Finalizing...',
  diff_ready: 'Diff ready for your review.',
  dedup_check: 'Checking for existing/duplicate work items...',
  writing: 'Writing work items to Azure DevOps...',
  failed: 'Job failed.',
  cancelled: 'Job cancelled.',
};

// Used only when there is neither a narration event nor a stage yet --
// i.e. status alone is all that's known (pending, or a terminal status
// reached before any stage/narration was recorded).
const STATUS_FALLBACK_SENTENCES: Record<string, string> = {
  pending: 'Queued — waiting for a pipeline worker to pick this job up.',
  succeeded: 'Wrote the reviewed work items to Azure DevOps.',
  rejected: 'Rejected — nothing was written to Azure DevOps.',
  cancelled: 'Job cancelled.',
  failed: 'Job failed.',
};

function sentenceFor(status: string, stage: JobStage | null, latest: NarrationEvent | null): string {
  if (latest) {
    if (latest.phase === 'writing' && latest.writeSubPhase) {
      return WRITE_SUBPHASE_SENTENCES[latest.writeSubPhase] ?? PHASE_FALLBACK_SENTENCES.writing;
    }
    return latest.message || PHASE_FALLBACK_SENTENCES[latest.phase];
  }
  if (stage) return STAGE_FALLBACK_SENTENCES[stage];
  return STATUS_FALLBACK_SENTENCES[status] ?? 'Working…';
}

function counterFor(latest: NarrationEvent | null): string | null {
  if (!latest) return null;
  switch (latest.phase) {
    case 'describe_figure':
      return latest.figureIndex != null ? `Figure ${latest.figureIndex}` : null;
    case 'parse_done':
      return latest.blockCount != null
        ? `${latest.blockCount} blocks · ${latest.tableCount ?? 0} tables · ${latest.figureCount ?? 0} figures`
        : null;
    case 'table_detected':
      return latest.tableId ? `${latest.tableId} · ${latest.tableRowCount ?? 0} rows` : null;
    case 'deterministic_subtree':
      return latest.subtreeIndex != null && latest.subtreeCount != null
        ? `Subtree ${latest.subtreeIndex + 1} of ${latest.subtreeCount}`
        : null;
    case 'analyze_section': {
      const parts: string[] = [];
      if (latest.branchIndex != null && latest.branchCount > 0) {
        parts.push(`Section ${latest.branchIndex + 1} of ${latest.branchCount}`);
      }
      if (latest.model) parts.push(latest.model);
      return parts.length > 0 ? parts.join(' · ') : null;
    }
    case 'score_requirements':
      return latest.draftCount != null ? `${latest.draftCount} drafted` : null;
    case 'score_requirements_done':
      return latest.issuesFound != null ? `${latest.issuesFound} issues flagged` : null;
    case 'section_complete':
      return latest.sectionNodes ? `${latest.sectionNodes.length} item${latest.sectionNodes.length === 1 ? '' : 's'}` : null;
    case 'dedup_check':
      return latest.currentTitle ? latest.currentTitle : latest.blocksTotal > 0 ? `${latest.blocksDone} / ${latest.blocksTotal}` : null;
    case 'writing':
      return latest.blocksTotal > 0 ? `${latest.blocksDone} / ${latest.blocksTotal}` : null;
    case 'job_failed':
      return latest.lastPhase ? `Last phase: ${latest.lastPhase}` : null;
    default:
      return null;
  }
}

function determinateFor(latest: NarrationEvent | null): number | undefined {
  if (!latest) return undefined;
  if (latest.phase !== 'dedup_check' && latest.phase !== 'writing') return undefined;
  if (latest.blocksTotal <= 0) return undefined;
  return Math.min(100, Math.max(0, (100 * latest.blocksDone) / latest.blocksTotal));
}

export function tickerFor(input: { status: string; stage: JobStage | null; latest: NarrationEvent | null }): TickerResult {
  return {
    sentence: sentenceFor(input.status, input.stage, input.latest),
    counter: counterFor(input.latest),
    determinate: determinateFor(input.latest),
  };
}
