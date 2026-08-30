// Mirrors orchestrator/src/modules/pipeline/diff-summary.ts's own
// isFlaggedDiffEntry thresholds exactly. Duplicated deliberately, not
// imported -- frontend and orchestrator are separate deployables with no
// shared package for a ~4-line pure function, same precedent as
// frontend/src/lib/canNest.ts (see that file's own doc comment for the
// "five build-infrastructure changes for a ~10-line pure function" reasoning).
const LOW_GROUNDING_THRESHOLD = 0.2;
const LOW_QUALITY_THRESHOLD = 50;

export function isFlaggedDiffEntry(entry: { groundingScore?: number | null; qualityScore?: number | null }): boolean {
  return (
    (entry.groundingScore != null && entry.groundingScore < LOW_GROUNDING_THRESHOLD) ||
    (entry.qualityScore != null && entry.qualityScore < LOW_QUALITY_THRESHOLD)
  );
}
