import { buildExclusionChecker } from './diff-summary';

export interface ReviewProgress {
  reviewed: number;
  reviewable: number;
}

interface ProgressEntry {
  localId: string;
  parentLocalId: string | null;
  action?: string;
  excluded?: boolean;
  reviewed?: boolean;
}

function isProgressEntry(value: unknown): value is ProgressEntry {
  return typeof value === 'object' && value !== null && typeof (value as { localId?: unknown }).localId === 'string';
}

// "N of M reviewed" for the Jobs list. The same rule as the review page's Write bar (frontend/src/utils/reviewQueue.ts reviewProgress),
// mirrored because the two are separate deployables, so the list and the page agree. Reviewable = a new item (action 'create') that is not
// excluded, itself or through an excluded ancestor (the one exclusion rule confirm() uses); reviewed = of those, the ones marked reviewed.
// Reuse and near-duplicate entries are not written, so they are never counted. null when the stored diff is not an array.
export function reviewProgressOf(dryRunDiff: unknown): ReviewProgress | null {
  if (!Array.isArray(dryRunDiff)) return null;
  const entries = dryRunDiff.filter(isProgressEntry).map((entry) => ({ ...entry, parentLocalId: entry.parentLocalId ?? null }));
  const isExcluded = buildExclusionChecker(entries);
  let reviewed = 0;
  let reviewable = 0;
  for (const entry of entries) {
    if (entry.action !== 'create' || isExcluded(entry)) continue;
    reviewable += 1;
    if (entry.reviewed) reviewed += 1;
  }
  return { reviewed, reviewable };
}
