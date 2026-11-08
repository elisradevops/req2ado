import { flaggedDiffEntryReason, isFlaggedDiffEntry, isLowQualityEntry } from './diffFlagging';
import { orderLikeTree } from './diffTreeOrder';
import type { WarningGroup, WarningKindGroup } from './warningKinds';

// The risk-ordered review queue (P17): what a reviewer should look at first.
// Pure, so the ordering is testable apart from the page. "Flagged" and "low
// score" reuse diffFlagging's own definitions -- there is deliberately no
// second threshold here.

// Where the review queue stands. `done` is the queue worked through to its end: the page shows a
// "Review queue done." row until the queue refills, since the button it was opened from is gone.
// `spotCheck` is the mandatory sample look before "approve clean items" (P17c): the dialog steps
// through the sample instead of the queue, and the bulk confirmation comes back when it ends.
export type ReviewQueueMode = { kind: 'off' } | { kind: 'queue' } | { kind: 'done' } | { kind: 'spotCheck' };
export type ReviewQueueModeAction = 'open' | 'close' | 'finish' | 'clearDone' | 'startSpotCheck' | 'endSpotCheck';

// Returns the same object when nothing changes, so a dispatch that does nothing does not re-render.
export function reviewQueueModeReducer(mode: ReviewQueueMode, action: ReviewQueueModeAction): ReviewQueueMode {
  switch (action) {
    case 'open':
      return mode.kind === 'queue' ? mode : { kind: 'queue' };
    // Leaving the dialog ends a running queue, but not a finished one: its "done" row stays.
    case 'close':
      return mode.kind === 'queue' ? { kind: 'off' } : mode;
    case 'finish':
      return mode.kind === 'done' ? mode : { kind: 'done' };
    case 'clearDone':
      return mode.kind === 'done' ? { kind: 'off' } : mode;
    case 'startSpotCheck':
      return mode.kind === 'spotCheck' ? mode : { kind: 'spotCheck' };
    case 'endSpotCheck':
      return mode.kind === 'spotCheck' ? { kind: 'off' } : mode;
  }
}

export type RiskTier = 'blocking' | 'low_score' | 'flagged' | 'clean';

const TIER_RANK: Record<RiskTier, number> = { blocking: 0, low_score: 1, flagged: 2, clean: 3 };

export interface ReviewQueueEntry {
  localId: string;
  parentLocalId: string | null;
  type: string;
  action: string;
  reviewed?: boolean;
  excluded?: boolean;
  qualityScore?: number | null;
  groundingScore?: number | null;
  qualityConfidence?: string | null;
}

function nodeIdsInGroup(kindGroups: WarningKindGroup[], group: WarningKindGroup['group']): Set<string> {
  return new Set(kindGroups.filter((entry) => entry.group === group).flatMap((entry) => entry.nodeIds));
}

// Blocking = named by a "fix before confirming" warning. A "review" warning is
// a judgment call, so it ranks with the flagged items. Info warnings never count.
export function riskTier(entry: ReviewQueueEntry, kindGroups: WarningKindGroup[]): RiskTier {
  return tierOf(entry, nodeIdsInGroup(kindGroups, 'fix'), nodeIdsInGroup(kindGroups, 'review'));
}

function tierOf(entry: ReviewQueueEntry, blockingIds: ReadonlySet<string>, reviewIds: ReadonlySet<string>): RiskTier {
  if (blockingIds.has(entry.localId)) return 'blocking';
  if (isLowQualityEntry(entry)) return 'low_score';
  if (isFlaggedDiffEntry(entry) || reviewIds.has(entry.localId)) return 'flagged';
  return 'clean';
}

// Items still to review, riskiest first. Within a tier the lowest quality score
// comes first (unscored last) and ties keep the order the tree is drawn in. Left out: items already
// reviewed, excluded (or under an excluded ancestor, which confirm drops too) and
// items that are not written (reuse / near-duplicate).
export function buildReviewQueue<T extends ReviewQueueEntry>(entries: T[], kindGroups: WarningKindGroup[]): T[] {
  const blockingIds = nodeIdsInGroup(kindGroups, 'fix');
  const reviewIds = nodeIdsInGroup(kindGroups, 'review');
  const byId = new Map(entries.map((entry) => [entry.localId, entry]));

  const excludedByAncestor = new Map<string, boolean>();
  function isExcluded(entry: ReviewQueueEntry): boolean {
    const cached = excludedByAncestor.get(entry.localId);
    if (cached !== undefined) return cached;
    // Set before recursing so a malformed parent cycle terminates.
    excludedByAncestor.set(entry.localId, false);
    const parent = entry.parentLocalId ? byId.get(entry.parentLocalId) : undefined;
    const result = !!entry.excluded || (parent ? isExcluded(parent) : false);
    excludedByAncestor.set(entry.localId, result);
    return result;
  }

  const displayPosition = new Map(orderLikeTree(entries).map((entry, position) => [entry.localId, position]));

  return entries
    .map((entry) => ({ entry, index: displayPosition.get(entry.localId) ?? 0 }))
    .filter(({ entry }) => !entry.reviewed && entry.action === 'create' && !isExcluded(entry))
    .map((item) => ({ ...item, tier: TIER_RANK[tierOf(item.entry, blockingIds, reviewIds)] }))
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      const aScore = a.entry.qualityScore ?? Number.POSITIVE_INFINITY;
      const bScore = b.entry.qualityScore ?? Number.POSITIVE_INFINITY;
      if (aScore !== bScore) return aScore - bScore;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}

export interface CleanApproval<T> {
  // Lowest quality score first, so the sample always starts with the weakest of them.
  items: T[];
  // Still up for review but left out: blocking, low-score, flagged or warned items.
  flagged: number;
  unscored: number;
  stale: number;
  lowestScore: number | null;
  highestScore: number | null;
}

// What "approve clean items" would mark reviewed. "Clean" means "not flagged", never "verified":
// the queue's clean tier (no flag, no fix/review warning; info warnings do not count) restricted
// to items that carry a current score, since the queue's clean tier also holds unscored ones.
// There is deliberately no score threshold of its own.
export function cleanApproval<T extends ReviewQueueEntry & { qualityStale?: boolean }>(
  entries: T[],
  kindGroups: WarningKindGroup[],
): CleanApproval<T> {
  const items: T[] = [];
  let flagged = 0;
  let unscored = 0;
  let stale = 0;
  for (const entry of buildReviewQueue(entries, kindGroups)) {
    if (riskTier(entry, kindGroups) !== 'clean') flagged += 1;
    else if (entry.qualityScore == null) unscored += 1;
    else if (entry.qualityStale) stale += 1;
    else items.push(entry);
  }
  const scores = items.map((item) => item.qualityScore as number);
  return {
    items,
    flagged,
    unscored,
    stale,
    lowestScore: scores.length > 0 ? scores[0] : null,
    highestScore: scores.length > 0 ? scores[scores.length - 1] : null,
  };
}

// The items the reviewer must look at before approving the rest: max(3, ceil(N / 10)) of them,
// capped at N. Input is lowest score first (as cleanApproval returns it); the sample starts at the
// lowest and is evenly spaced up to the highest. No randomness, so it is the same every time.
export function spotCheckSample<T>(items: T[]): T[] {
  const total = items.length;
  const size = Math.min(total, Math.max(3, Math.ceil(total / 10)));
  if (size <= 1) return items.slice(0, size);
  const step = (total - 1) / (size - 1);
  return Array.from({ length: size }, (_, index) => items[Math.round(index * step)]);
}

// Why the item is where it is in the queue -- the dialog's note above the item, in the same
// shape its warning-focus review uses. A warning's own title and guidance are reused as is.
export function riskReason(
  entry: ReviewQueueEntry,
  kindGroups: WarningKindGroup[],
): { title: string; todo: string; group: WarningGroup } {
  const firstKind = (group: WarningGroup): WarningKindGroup | undefined =>
    kindGroups.find((kind) => kind.group === group && kind.nodeIds.includes(entry.localId));
  const check = 'Check it against its source, then mark it reviewed.';
  switch (riskTier(entry, kindGroups)) {
    case 'blocking': {
      const kind = firstKind('fix');
      return {
        title: `Blocking warning: ${kind?.meta.title ?? 'needs a fix'}`,
        todo: kind?.meta.todo ?? 'Fix this before you confirm.',
        group: 'fix',
      };
    }
    case 'low_score':
      return { title: 'Low quality score', todo: check, group: 'review' };
    case 'flagged': {
      const flagReason = flaggedDiffEntryReason(entry);
      const kind = firstKind('review');
      return {
        title: flagReason ?? kind?.meta.title ?? 'Flagged for review',
        todo: flagReason ? check : (kind?.meta.todo ?? check),
        group: 'review',
      };
    }
    default:
      // Epics, Features and BASELINE items carry no score at all; "nothing was
      // flagged" would imply they were scored and passed.
      if (entry.qualityScore == null && entry.groundingScore == null) {
        return {
          title: 'Not scored',
          todo: 'No score for this item. Read it against its source before you mark it reviewed.',
          group: 'info',
        };
      }
      return { title: 'No flags', todo: 'Nothing was flagged. Still read it before you mark it reviewed.', group: 'info' };
  }
}
