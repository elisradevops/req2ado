// Mirrors orchestrator/src/modules/pipeline/diff-summary.ts's own
// isFlaggedDiffEntry thresholds exactly. Duplicated deliberately, not
// imported -- frontend and orchestrator are separate deployables with no
// shared package for a ~4-line pure function, same precedent as
// frontend/src/lib/canNest.ts (see that file's own doc comment for the
// "five build-infrastructure changes for a ~10-line pure function" reasoning).
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
// Deliberately does NOT exclude the item from any count: the score is still
// the model's best answer and is still displayed, same as a low-grounding or
// low-quality item already is.
const LOW_CONFIDENCE = 'low';

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

// Explains WHY isFlaggedDiffEntry returned true, for the existing "⚠ Review"
// chip's native `title` tooltip -- a row can be flagged purely on a low
// qualityConfidence while grounding and quality both look healthy, and
// without this the chip gives a reviewer no visible reason. Mirrors
// isFlaggedDiffEntry's own OR'd conditions exactly (same thresholds, same
// per-type grounding cutoff) so the tooltip can never disagree with why the
// chip is actually showing. Returns null when the entry isn't flagged.
export function flaggedDiffEntryReason(entry: {
  type?: string;
  groundingScore?: number | null;
  qualityScore?: number | null;
  qualityConfidence?: string | null;
}): string | null {
  const groundingThreshold = entry.type === 'Epic' || entry.type === 'Feature'
    ? PARENT_LOW_GROUNDING_THRESHOLD
    : LOW_GROUNDING_THRESHOLD;
  const reasons: string[] = [];
  if (entry.groundingScore != null && entry.groundingScore < groundingThreshold) {
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
