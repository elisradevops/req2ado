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
