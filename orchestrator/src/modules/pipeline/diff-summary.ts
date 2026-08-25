// Extracted verbatim from JobsService.getSummary's own filters (see that
// method, which now delegates here) so a batch-level rollup (BatchService,
// NEW-05) can sum the exact same create/reuse/dedup_skip/flagged vocabulary
// per file instead of re-implementing it and risking drift between the two.

// Mirrors frontend/src/pages/JobStatus.tsx's needsReview() thresholds --
// duplicated (not imported) because frontend and orchestrator are separate
// deployables with no shared package for these constants, same as that
// file's own comment mirroring ingestion's llm_leveling thresholds.
const LOW_GROUNDING_THRESHOLD = 0.2;
const LOW_QUALITY_THRESHOLD = 50;

export interface DiffSummary {
  created: number;
  reused: number;
  dedupSkipped: number;
  flagged: number;
}

export function isFlaggedDiffEntry(entry: { groundingScore?: number | null; qualityScore?: number | null }): boolean {
  return (
    (entry.groundingScore != null && entry.groundingScore < LOW_GROUNDING_THRESHOLD) ||
    (entry.qualityScore != null && entry.qualityScore < LOW_QUALITY_THRESHOLD)
  );
}

export function summarizeDiffEntries(
  diff: { action: string; groundingScore?: number | null; qualityScore?: number | null }[],
): DiffSummary {
  return {
    created: diff.filter((e) => e.action === 'create').length,
    reused: diff.filter((e) => e.action === 'reuse').length,
    dedupSkipped: diff.filter((e) => e.action === 'dedup_skip').length,
    flagged: diff.filter((e) => isFlaggedDiffEntry(e)).length,
  };
}
