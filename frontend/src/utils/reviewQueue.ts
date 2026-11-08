import { flaggedDiffEntryReason, isFlaggedDiffEntry, isLowQualityEntry } from './diffFlagging';
import { orderLikeTree } from './diffTreeOrder';
import type { WarningGroup, WarningKindGroup } from './warningKinds';

// The risk-ordered review queue (P17): what a reviewer should look at first.
// Pure, so the ordering is testable apart from the page. "Flagged" and "low
// score" reuse diffFlagging's own definitions -- there is deliberately no
// second threshold here.

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
