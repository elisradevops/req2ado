import { categoryLabel, weakestCategory, WEAK_CATEGORY_SCORE } from './qualityCategories';
import { flaggedDiffEntryReason, isScoredType } from './diffFlagging';
import { missingValuesOf } from './proposal';

// One plain sentence per thing that needs the reviewer, in the order fix, review, info (DESIGN.md §11.4.5, §12). Pure: the dialog renders it.
export type IssueSeverity = 'fix' | 'review' | 'info';

export interface ItemIssue {
  id: string;
  severity: IssueSeverity;
  text: string;
  // The detail behind the sentence, shown under "Why".
  why?: string;
}

export interface IssueEntry {
  type?: string;
  action?: string;
  customerId?: string | null;
  qualityScore?: number | null;
  qualityConfidence?: string | null;
  qualityStale?: boolean;
  groundingScore?: number | null;
  qualityCategoryScores?: Record<string, number> | null;
  proposal?: { kind: string; html: string } | null;
  duplicateOf?: { existingAdoId?: number | null } | null;
}

const ORDER: Record<IssueSeverity, number> = { fix: 0, review: 1, info: 2 };

export function itemIssues(entry: IssueEntry): ItemIssue[] {
  const issues: ItemIssue[] = [];

  if (entry.proposal?.kind === 'needs-input') {
    const values = missingValuesOf(entry.proposal.html);
    issues.push({
      id: 'needs-input',
      severity: 'review',
      text:
        values.length > 0
          ? `Missing value in the source: ${values.join(', ')}. Ask the author.`
          : 'The source leaves a value open. Ask the author.',
    });
  }

  // Only Requirements are scored and checked against the source; an Epic or Feature never carries a score line or a "Check:" line.
  if (isScoredType(entry.type)) {
    if (entry.qualityStale) {
      issues.push({ id: 'stale', severity: 'review', text: 'Edited since it was scored. The score may be out of date.' });
    } else if (entry.qualityScore != null) {
      if (entry.qualityScore < 50) {
        const weakest = weakestCategory(entry.qualityCategoryScores);
        issues.push({
          id: 'quality-low',
          severity: 'review',
          text: `Quality ${Math.round(entry.qualityScore)} of 100.${weakest ? ` Weakest: ${categoryLabel(weakest.key).toLowerCase()} (${Math.round(weakest.score)}).` : ''}`,
        });
      }
      if (entry.qualityConfidence === 'low') {
        issues.push({ id: 'unsure', severity: 'review', text: 'The scorer was unsure about this score.' });
      }
    }
    const other = flaggedDiffEntryReason({ type: entry.type, groundingScore: entry.groundingScore, qualityScore: null, qualityConfidence: null });
    if (other) issues.push({ id: 'far-from-source', severity: 'review', text: 'The wording is far from the source text. Check it against the source.' });
  }

  return issues.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

// The weak categories the assistant can aim at, from the item's real scores (at most three), for its suggestions.
export function weakCategoryKeys(entry: IssueEntry): string[] {
  if (!isScoredType(entry.type) || entry.qualityStale) return [];
  return Object.entries(entry.qualityCategoryScores ?? {})
    .filter(([, score]) => Number.isFinite(score) && score < WEAK_CATEGORY_SCORE)
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 3)
    .map(([key]) => key);
}
