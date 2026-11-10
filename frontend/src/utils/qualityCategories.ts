// DESIGN.md §11.4.3 point 3 / CR-7c -- maps each closed-vocabulary
// quality-issue code (QUALITY_ISSUE_LABELS in labels.ts) to the generic
// scoring category it's real evidence for, so a flag can render under the
// category bar it actually explains (QualityGauge's per-category
// disclosure) instead of only in an unranked chip cloud three components
// away with no link back to which metric it affected.
//
// Deliberately conservative, not exhaustive: only codes with an
// unambiguous, direct textual match to one of the 5 generic dimensions
// (clarity/testability/atomicity/style/rationale -- QualityGauge.tsx's
// KNOWN_CATEGORY_DESCRIPTIONS) are mapped here. The remaining codes
// (not_a_requirement, fragment, placeholder, open_item_tbd,
// rationale_as_requirement, conflicting_value) are about whether this is a
// requirement/reliable data point AT ALL, not about a single wording
// dimension -- forcing one onto e.g. "clarity" would be a guess this
// module exists specifically to avoid. Any code absent from this map (and
// every KB-derived category, which has no fixed vocabulary at all) belongs
// in an "Other flags" group instead -- never dropped, never guessed onto a
// category it doesn't actually support.
export const ISSUE_CODE_TO_CATEGORY: Record<string, string> = {
  ambiguous: 'clarity',
  vague_term: 'clarity',
  not_testable: 'testability',
  missing_acceptance_criteria: 'testability',
  compound: 'atomicity',
  passive_voice: 'style',
  missing_rationale: 'rationale',
};

export function categoryForIssueCode(code: string): string | null {
  return ISSUE_CODE_TO_CATEGORY[code] ?? null;
}

// The bar the chat aims a rewrite under; the same one as ingestion's chat prompt.
export const WEAK_CATEGORY_SCORE = 70;

export interface WeakestCategory {
  key: string;
  score: number;
  // Verbatim text from the org's own checklist for this category, when one was matched.
  checklistText: string | undefined;
}

// The lowest-scoring rubric category, so a reviewer sees where an item is weakest without
// opening the gauge. Scores are a dynamic key -> 0-100 map, so a real 0 is the weakest, not
// missing; a non-finite value is skipped. Ties go to the alphabetically first key, the same tie-break
// as ChatPanel's private weakestCategory (and ingestion's chat_service._weakest_categories), so the
// strip and the chat name the same category. They differ in one way on purpose: the chat only aims at a
// category below WEAK_CATEGORY_SCORE (pass `below`), while the evidence strip names the lowest for
// every scored item. One function, so the two cannot drift apart.
// Null when there is nothing to rank (BASELINE, a manual entry, a job saved before scoring).
export function weakestCategory(
  scores: Record<string, number> | null | undefined,
  checklist?: Record<string, string> | null,
  // When given, a lowest score at or above it is not weak, so nothing is returned.
  below?: number,
): WeakestCategory | null {
  let weakest: { key: string; score: number } | null = null;
  for (const [key, score] of Object.entries(scores ?? {})) {
    if (!Number.isFinite(score)) continue;
    if (weakest === null || score < weakest.score || (score === weakest.score && key < weakest.key)) weakest = { key, score };
  }
  if (weakest === null || (below !== undefined && weakest.score >= below)) return null;
  return { ...weakest, checklistText: checklist?.[weakest.key] };
}

// A KB-derived category key can be snake_case verbatim from the org's own ingested checklist
// document (e.g. "completeness_as_requirement"); splits on '_'/'-' and capitalizes every word.
export function categoryLabel(key: string): string {
  return key
    .split(/[_-]/)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}
