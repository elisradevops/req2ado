// Mirrors orchestrator/src/modules/pipeline/diff-summary.ts's own
// isFlaggedDiffEntry thresholds exactly. Duplicated deliberately, not
// imported -- frontend and orchestrator are separate deployables with no
// shared package for a ~4-line pure function, same precedent as
// frontend/src/lib/canNest.ts (see that file's own doc comment for the
// "five build-infrastructure changes for a ~10-line pure function" reasoning).
export const LOW_GROUNDING_THRESHOLD = 0.2;
const LOW_QUALITY_THRESHOLD = 50;
// SWEEP.md section 7: the scoring model's own abstain channel (see
// ingestion's QualityConfidence docstring, app/workitem/model.py). A 'low'
// value means the model told us it couldn't really judge this item -- which
// is exactly a "a human should look at this" signal, so it piggybacks on the
// existing flagged mechanism rather than getting a UI surface of its own.
// Deliberately does NOT exclude the item from any count: the score is still
// the model's best answer and is still displayed, same as a low-grounding or
// low-quality item already is.
const LOW_CONFIDENCE = 'low';

// Only Requirements are scored and checked against the source. An Epic or Feature is a summary the tool wrote, so a score, the model's
// confidence in it and its word overlap with the source are never a reason to flag it (DESIGN.md §11.4.1, §11.4.5). Every flag below reads
// this one rule, so the tree, the review queue, the dialog and the server's summary cannot disagree.
export function isScoredType(type?: string): boolean {
  return type !== 'Epic' && type !== 'Feature';
}

// The "low score" half of isFlaggedDiffEntry on its own, for callers that
// rank a low quality score above the other flags (the risk-ordered review queue).
export function isLowQualityEntry(entry: { type?: string; qualityScore?: number | null }): boolean {
  return isScoredType(entry.type) && entry.qualityScore != null && entry.qualityScore < LOW_QUALITY_THRESHOLD;
}

export function isFlaggedDiffEntry(entry: {
  type?: string;
  groundingScore?: number | null;
  qualityScore?: number | null;
  qualityConfidence?: string | null;
}): boolean {
  if (!isScoredType(entry.type)) return false;
  return (
    (entry.groundingScore != null && entry.groundingScore < LOW_GROUNDING_THRESHOLD) ||
    isLowQualityEntry(entry) ||
    entry.qualityConfidence === LOW_CONFIDENCE
  );
}

// Explains WHY isFlaggedDiffEntry returned true, for the existing "⚠ Review"
// chip's native `title` tooltip -- a row can be flagged purely on a low
// qualityConfidence while grounding and quality both look healthy, and
// without this the chip gives a reviewer no visible reason. Mirrors
// isFlaggedDiffEntry's own OR'd conditions exactly (same thresholds, same
// Requirement-only rule) so the tooltip can never disagree with why the
// chip is actually showing. Returns null when the entry isn't flagged.
export function flaggedDiffEntryReason(entry: {
  type?: string;
  groundingScore?: number | null;
  qualityScore?: number | null;
  qualityConfidence?: string | null;
}): string | null {
  if (!isScoredType(entry.type)) return null;
  const reasons: string[] = [];
  if (entry.groundingScore != null && entry.groundingScore < LOW_GROUNDING_THRESHOLD) {
    reasons.push('Low grounding: little overlap with the source text');
  }
  if (entry.qualityScore != null && entry.qualityScore < LOW_QUALITY_THRESHOLD) {
    reasons.push('Low quality score');
  }
  if (entry.qualityConfidence === LOW_CONFIDENCE) {
    reasons.push('Model was unsure about this score');
  }
  return reasons.length > 0 ? reasons.join('; ') : null;
}
