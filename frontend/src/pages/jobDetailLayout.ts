// Pure layout predicates for the state-driven Job Detail page (DESIGN.md
// Track B, phase B7) -- extracted so "which sections render for which
// status" is unit-testable without mounting the whole page.

export function isRunDetailStatus(status: string | null): boolean {
  // The only statuses with a live pipeline actually doing work right now --
  // ProgressBanner's own phase-dispatched RunDetail (phase B6) only makes
  // sense while something is genuinely in flight server-side.
  return status === 'running' || status === 'writing';
}

export function shouldShowTiles(status: string | null): boolean {
  // Stat tiles summarize a real, computed diff -- diff_ready is their
  // natural home, succeeded keeps showing the same numbers as a record of
  // what was actually written. rejected/cancelled/failed never had a
  // completed diff worth summarizing this way, even if a stale `summary`
  // value from an earlier diff_ready fetch is still sitting in state.
  return status === 'diff_ready' || status === 'succeeded';
}

// Statuses that always have a real, computed diff behind them -- even the
// edge case of a genuinely empty one (a document that produced zero work
// items) is still a real result worth showing as "Proposed items (0)", not dead
// space, since the run itself did complete. Every other status either
// hasn't reached diff_ready yet (pending/running) or never produced a diff
// at all (cancelled pre-diff_ready per jobs.service's own cancel rule;
// failed).
const STATUSES_WITH_A_COMPUTED_DIFF = new Set(['writing', 'diff_ready', 'succeeded', 'rejected']);

export function shouldShowTabs(status: string | null, diffLength: number, auditLength: number): boolean {
  if (status && STATUSES_WITH_A_COMPUTED_DIFF.has(status)) return true;
  // Only reachable by cancelled/failed -- if either somehow already has
  // real diff/audit content, show it rather than hiding real data.
  return diffLength > 0 || auditLength > 0;
}

export function shouldShowFilterBar(diffLength: number): boolean {
  return diffLength > 0;
}

// DESIGN.md §0: "Nothing has been written to Azure DevOps" is only true until a write begins. failed and cancelled can
// follow a partial write, so the line is not claimed for them either. A failed confirm also sends the job back to
// diff_ready with some items already written, so `writtenCount` (items known to exist in Azure DevOps) must be zero.
export function shouldShowNothingWrittenLine(status: string | null, writtenCount = 0): boolean {
  if (writtenCount > 0) return false;
  return status === 'pending' || status === 'running' || status === 'diff_ready';
}

/** The headline of the Review phase view (DESIGN.md §11.3.5): what this job's main view is about, by state. */
export function reviewHeadline(status: string | null): string {
  switch (status) {
    case 'diff_ready':
      return 'Review the proposed items';
    case 'succeeded':
      return 'Written to Azure DevOps';
    case 'rejected':
      return 'Rejected: nothing was written';
    case 'failed':
      return 'The run failed';
    case 'cancelled':
      return 'The run was cancelled';
    default:
      return 'Items';
  }
}

/** The phase rail runs beside the view only while the run is live; once the run is over it is a strip above the review (DESIGN.md §11.3.5). */
export function phaseRailOrientation(status: string | null): 'vertical' | 'horizontal' {
  return status === 'pending' || status === 'running' || status === 'writing' ? 'vertical' : 'horizontal';
}
