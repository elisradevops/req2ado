// Extracted verbatim from JobsService.getSummary's own filters (see that
// method, which now delegates here) so a batch-level rollup (BatchService,
// NEW-05) can sum the exact same create/reuse/dedup_skip/flagged vocabulary
// per file instead of re-implementing it and risking drift between the two.

// Mirrors frontend/src/pages/JobStatus.tsx's needsReview() thresholds --
// duplicated (not imported) because frontend and orchestrator are separate
// deployables with no shared package for these constants, same as that
// file's own comment mirroring ingestion's llm_leveling thresholds.
const LOW_GROUNDING_THRESHOLD = 0.2;
// A synthesized Epic/Feature summary is scored against a much larger
// concatenated multi-descendant corpus than a single source block, which
// inflates the natural word-overlap baseline (more source vocabulary
// available to match by chance) -- the flat 0.2 cutoff calibrated for one-
// block-vs-one-generation is too lenient for a synthesized parent and
// would under-flag real fabrication there (SWEEP.md section 7, item 2).
const PARENT_LOW_GROUNDING_THRESHOLD = 0.35;
const LOW_QUALITY_THRESHOLD = 50;
// SWEEP.md section 7: the scoring model's own abstain channel (see
// ingestion's QualityConfidence docstring, app/workitem/model.py). A 'low'
// value means the model told us it couldn't really judge this item -- which
// is exactly a "a human should look at this" signal, so it piggybacks on the
// existing flagged mechanism rather than getting a UI surface of its own.
// Deliberately does NOT exclude the item from any count below: the score is
// still the model's best answer and is still displayed, same as a
// low-grounding or low-quality item already is.
const LOW_CONFIDENCE = 'low';

export interface DiffSummary {
  created: number;
  reused: number;
  dedupSkipped: number;
  flagged: number;
}

export interface DiffEntryForExclusion {
  localId: string;
  parentLocalId: string | null;
  excluded?: boolean;
}

// Same ancestry-walk exclusion rule as JobsService.confirm()'s own local
// isExcluded() (jobs.service.ts) -- excluding a parent excludes its whole
// subtree too, even when a descendant isn't itself marked excluded. Kept
// as a separate, pure copy rather than refactoring confirm() (a large,
// heavily-tested method with 4 existing call sites) to use it -- if
// confirm()'s own exclusion semantics ever change, this copy needs the
// same update. Generic over T so both getSummary()'s narrower diff shape
// and BatchService's per-job diff shape can use it without widening
// either to match the other.
export function buildExclusionChecker<T extends DiffEntryForExclusion>(diff: T[]): (entry: T) => boolean {
  const diffById = new Map(diff.map((entry) => [entry.localId, entry] as const));
  return function isExcluded(entry: T): boolean {
    let current: T | undefined = entry;
    const visited = new Set<string>();
    while (current) {
      if (current.excluded) return true;
      if (visited.has(current.localId)) return false;
      visited.add(current.localId);
      current = current.parentLocalId ? diffById.get(current.parentLocalId) : undefined;
    }
    return false;
  };
}

// Excludes both directly-excluded entries and any entry whose ancestor is
// excluded (see buildExclusionChecker) -- summarizeDiffEntries alone has
// no exclusion awareness at all, so a caller that needs its counts to
// match what a real confirm() write would actually create/reuse/skip
// must filter through this first.
export function filterExcludedDiffEntries<T extends DiffEntryForExclusion>(diff: T[]): T[] {
  const isExcluded = buildExclusionChecker(diff);
  return diff.filter((entry) => !isExcluded(entry));
}

export function isFlaggedDiffEntry(entry: {
  type?: string;
  groundingScore?: number | null;
  qualityScore?: number | null;
  qualityConfidence?: string | null;
}): boolean {
  const groundingThreshold = entry.type === 'Epic' || entry.type === 'Feature'
    ? PARENT_LOW_GROUNDING_THRESHOLD
    : LOW_GROUNDING_THRESHOLD;
  return (
    (entry.groundingScore != null && entry.groundingScore < groundingThreshold) ||
    (entry.qualityScore != null && entry.qualityScore < LOW_QUALITY_THRESHOLD) ||
    entry.qualityConfidence === LOW_CONFIDENCE
  );
}

export function summarizeDiffEntries(
  diff: { action: string; type: string; groundingScore?: number | null; qualityScore?: number | null; qualityConfidence?: string | null }[],
): DiffSummary {
  return {
    created: diff.filter((e) => e.action === 'create').length,
    reused: diff.filter((e) => e.action === 'reuse').length,
    dedupSkipped: diff.filter((e) => e.action === 'dedup_skip').length,
    flagged: diff.filter((e) => isFlaggedDiffEntry(e)).length,
  };
}
