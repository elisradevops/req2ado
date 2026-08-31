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

export function isFlaggedDiffEntry(entry: {
  type?: string;
  groundingScore?: number | null;
  qualityScore?: number | null;
}): boolean {
  const groundingThreshold = entry.type === 'Epic' || entry.type === 'Feature'
    ? PARENT_LOW_GROUNDING_THRESHOLD
    : LOW_GROUNDING_THRESHOLD;
  return (
    (entry.groundingScore != null && entry.groundingScore < groundingThreshold) ||
    (entry.qualityScore != null && entry.qualityScore < LOW_QUALITY_THRESHOLD)
  );
}
