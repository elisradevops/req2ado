import { categoryLabel, weakestCategory } from './qualityCategories';
import { isLowQualityEntry, isScoredType, LOW_GROUNDING_THRESHOLD } from './diffFlagging';
import { missingValuesOf } from './proposal';

// One plain sentence per thing that needs the reviewer, in the order fix, review, info (DESIGN.md §11.4.5, §12). Pure: the dialog renders it.
export type IssueSeverity = 'fix' | 'review' | 'info';

export interface ItemIssue {
  id: string;
  severity: IssueSeverity;
  text: string;
  // The detail behind the sentence, shown under "Why".
  why?: string;
  // The issue can be worked on with the assistant: the list offers a button when the caller can open it.
  askable?: boolean;
  // The issue is a suggestion waiting for a decision: the list offers "Review change" when the caller can open it.
  reviewable?: boolean;
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
  // The assistant's suggestion kept with the item: one nobody decided on is an issue until it is accepted, rejected or parked.
  suggestion?: { decision: string } | null;
}

const MAX_NAME_CHARS = 48;
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

  if (entry.suggestion?.decision === 'pending') {
    issues.push({ id: 'suggestion-waiting', severity: 'review', text: 'The assistant suggested a rewrite. Review it before moving on.', reviewable: true });
  }

  // Only Requirements are scored and checked against the source; an Epic or Feature never carries a score line or a "Check:" line.
  if (isScoredType(entry.type)) {
    if (entry.qualityStale) {
      issues.push({ id: 'stale', severity: 'review', text: 'Edited since it was scored. The score may be out of date.' });
    } else if (entry.qualityScore != null) {
      if (isLowQualityEntry(entry)) {
        const weakest = weakestCategory(entry.qualityCategoryScores);
        // An organisation's own check can be a whole sentence: the line keeps its start and the full text goes under "Why".
        const name = weakest ? categoryLabel(weakest.key).toLowerCase().replace(/[.?!。]+$/, '') : '';
        const shortName = name.length > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS - 1).trimEnd()}…` : name;
        issues.push({
          id: 'quality-low',
          severity: 'review',
          askable: true,
          text: `Quality ${Math.round(entry.qualityScore)} of 100.${weakest ? ` Weakest: ${shortName} (${Math.round(weakest.score)}).` : ''}`,
          ...(weakest && shortName !== name ? { why: `The weakest check is "${name}", at ${Math.round(weakest.score)} of 100.` } : {}),
        });
      }
      if (entry.qualityConfidence === 'low') {
        issues.push({ id: 'unsure', severity: 'review', text: 'The scorer was unsure about this score.' });
      }
    }
    if (entry.groundingScore != null && entry.groundingScore < LOW_GROUNDING_THRESHOLD) {
      issues.push({ id: 'far-from-source', severity: 'review', askable: true, text: 'The wording is far from the source text. Check it against the source.' });
    }
  }

  return issues.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}
