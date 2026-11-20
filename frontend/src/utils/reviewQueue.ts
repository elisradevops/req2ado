import { flaggedDiffEntryReason, isFlaggedDiffEntry, isLowQualityEntry } from './diffFlagging';
import { orderLikeTree } from './diffTreeOrder';
import { acknowledgementClears, kindProgress, type WarningGroup, type WarningKindGroup } from './warningKinds';

// The risk-ordered review queue (P17): what a reviewer should look at first.
// Pure, so the ordering is testable apart from the page. "Flagged" and "low
// score" reuse diffFlagging's own definitions -- there is deliberately no
// second threshold here.

// Where the review queue stands. `done` is the queue worked through to its end: the page shows a
// "Review queue done." row until the queue refills, since the button it was opened from is gone.
// `spotCheck` is the mandatory sample look before "approve clean items" (P17c): the dialog steps
// through the sample instead of the queue, and the bulk confirmation comes back when it ends.
export type ReviewQueueMode = { kind: 'off' } | { kind: 'queue' } | { kind: 'done' } | { kind: 'spotCheck' };
export type ReviewQueueModeAction = 'open' | 'close' | 'finish' | 'markDone' | 'clearDone' | 'startSpotCheck' | 'endSpotCheck';

// Returns the same object when nothing changes, so a dispatch that does nothing does not re-render.
export function reviewQueueModeReducer(mode: ReviewQueueMode, action: ReviewQueueModeAction): ReviewQueueMode {
  switch (action) {
    case 'open':
      return mode.kind === 'queue' ? mode : { kind: 'queue' };
    // Leaving the dialog ends a running queue, but not a finished one: its "done" row stays.
    case 'close':
      return mode.kind === 'queue' ? { kind: 'off' } : mode;
    // The running queue was worked through to its end. Only a running queue can finish.
    case 'finish':
      return mode.kind === 'queue' ? { kind: 'done' } : mode;
    // Shows the "done" row without a running queue (a bulk approve emptied a queue that was never
    // opened). A running queue or spot-check is left alone: those end through their own actions.
    case 'markDone':
      return mode.kind === 'off' ? { kind: 'done' } : mode;
    case 'clearDone':
      return mode.kind === 'done' ? { kind: 'off' } : mode;
    case 'startSpotCheck':
      return mode.kind === 'spotCheck' ? mode : { kind: 'spotCheck' };
    case 'endSpotCheck':
      return mode.kind === 'spotCheck' ? { kind: 'off' } : mode;
  }
}

// `structure`: an Epic or Feature with nothing blocking or flagged. Quality scoring judges how a requirement is worded, not what a
// parent contains, so a parent's score is never a reason to review it first. They queue last.
export type RiskTier = 'blocking' | 'low_score' | 'flagged' | 'clean' | 'structure';

const TIER_RANK: Record<RiskTier, number> = { blocking: 0, low_score: 1, flagged: 2, clean: 3, structure: 4 };

// The same Epic/Feature test diffFlagging uses for its per-type grounding cutoff.
function isStructureEntry(entry: { type?: string }): boolean {
  return entry.type === 'Epic' || entry.type === 'Feature';
}

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

// A kind the reviewer has accepted (every record acknowledged) no longer ranks or blocks its items: the queue, the group chips, the
// write gate and the warning rows all read the same handled state. A per-item Fix kind is never accepted this way, even with
// acknowledged records (§11.3.6): its items stay blocking until each is decided.
function isAcknowledgedKind(entry: WarningKindGroup): boolean {
  return kindProgress(entry).allAcknowledged && acknowledgementClears(entry);
}

function nodeIdsInGroup(kindGroups: WarningKindGroup[], group: WarningKindGroup['group']): Set<string> {
  return new Set(kindGroups.filter((entry) => entry.group === group && !isAcknowledgedKind(entry)).flatMap((entry) => entry.nodeIds));
}

// Blocking = named by a "Fix before writing" warning. A "review" warning is
// a judgment call, so it ranks with the flagged items. Info warnings never count.
export function riskTier(entry: ReviewQueueEntry, kindGroups: WarningKindGroup[]): RiskTier {
  return tierOf(entry, nodeIdsInGroup(kindGroups, 'fix'), nodeIdsInGroup(kindGroups, 'review'));
}

function tierOf(entry: ReviewQueueEntry, blockingIds: ReadonlySet<string>, reviewIds: ReadonlySet<string>): RiskTier {
  if (blockingIds.has(entry.localId)) return 'blocking';
  if (isStructureEntry(entry)) {
    // A parent keeps its review warnings only; a score or word overlap is never a reason for it (diffFlagging's one rule).
    return reviewIds.has(entry.localId) ? 'flagged' : 'structure';
  }
  if (isLowQualityEntry(entry)) return 'low_score';
  if (isFlaggedDiffEntry(entry) || reviewIds.has(entry.localId)) return 'flagged';
  return 'clean';
}

/**
 * How many of a kind's items still need a check once that kind is accepted. An accepted kind stops ranking its items, so each falls into the
 * tier its own other signals give it (a low score, a review warning); this counts the ones that are not clean. Said after an acceptance, so the
 * Check count growing is not a surprise.
 */
export function countStillToCheck<T extends ReviewQueueEntry>(entries: T[], kindGroups: WarningKindGroup[], kind: string): number {
  const accepted = kindGroups.map((group) =>
    group.kind === kind ? { ...group, records: group.records.map((record) => ({ ...record, acknowledged: true })) } : group,
  );
  const ids = new Set(kindGroups.find((group) => group.kind === kind)?.nodeIds ?? []);
  return entries.filter((entry) => ids.has(entry.localId) && !entry.excluded).filter((entry) => {
    const tier = riskTier(entry, accepted);
    return tier === 'blocking' || tier === 'low_score' || tier === 'flagged';
  }).length;
}

// Whether an entry is excluded itself or sits under an excluded ancestor (confirm drops those too). `cache` lets a caller share results across many entries.
export function isExcludedWithAncestors(
  entry: ReviewQueueEntry,
  byId: Map<string, ReviewQueueEntry>,
  cache: Map<string, boolean> = new Map(),
): boolean {
  const cached = cache.get(entry.localId);
  if (cached !== undefined) return cached;
  // Set before recursing so a malformed parent cycle terminates.
  cache.set(entry.localId, false);
  const parent = entry.parentLocalId ? byId.get(entry.parentLocalId) : undefined;
  const result = !!entry.excluded || (parent ? isExcludedWithAncestors(parent, byId, cache) : false);
  cache.set(entry.localId, result);
  return result;
}

// Items still to review, riskiest first. Within a tier the lowest quality score
// comes first (unscored last) and ties keep the order the tree is drawn in. Left out: items already
// reviewed, excluded (or under an excluded ancestor, which confirm drops too) and
// items that are not written (reuse / near-duplicate).
export function buildReviewQueue<T extends ReviewQueueEntry>(entries: T[], kindGroups: WarningKindGroup[]): T[] {
  return buildTieredQueue(entries, kindGroups).map(({ entry }) => entry);
}

// The queue with each item's tier, computed in the same pass that orders it: the warning sets are built once, so classifying N items
// against kinds naming M of them costs O(N + M), not O(N x M) as calling riskTier() per item would.
function buildTieredQueue<T extends ReviewQueueEntry>(entries: T[], kindGroups: WarningKindGroup[]): Array<{ entry: T; tier: RiskTier }> {
  const blockingIds = nodeIdsInGroup(kindGroups, 'fix');
  const reviewIds = nodeIdsInGroup(kindGroups, 'review');
  const byId = new Map(entries.map((entry) => [entry.localId, entry]));

  const excludedByAncestor = new Map<string, boolean>();
  const isExcluded = (entry: ReviewQueueEntry): boolean => isExcludedWithAncestors(entry, byId, excludedByAncestor);

  const displayPosition = new Map(orderLikeTree(entries).map((entry, position) => [entry.localId, position]));

  return entries
    .map((entry) => ({ entry, index: displayPosition.get(entry.localId) ?? 0 }))
    .filter(({ entry }) => !entry.reviewed && entry.action === 'create' && !isExcluded(entry))
    .map((item) => {
      const tier = tierOf(item.entry, blockingIds, reviewIds);
      return { ...item, tier, rank: TIER_RANK[tier] };
    })
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      const aScore = a.entry.qualityScore ?? Number.POSITIVE_INFINITY;
      const bScore = b.entry.qualityScore ?? Number.POSITIVE_INFINITY;
      if (aScore !== bScore) return aScore - bScore;
      return a.index - b.index;
    })
    .map(({ entry, tier }) => ({ entry, tier }));
}

// The owner's four review groups (2026-11-12): Fix before writing, Check, Clean, Structure. Check is the low-score and flagged tiers.
export type ReviewGroup = 'fix' | 'check' | 'clean' | 'structure';
export const REVIEW_GROUP_ORDER: ReviewGroup[] = ['fix', 'check', 'clean', 'structure'];

export function reviewGroupOf(tier: RiskTier): ReviewGroup {
  switch (tier) {
    case 'blocking':
      return 'fix';
    case 'low_score':
    case 'flagged':
      return 'check';
    case 'clean':
      return 'clean';
    case 'structure':
      return 'structure';
  }
}

// What is still to review, by group, each in queue order.
export function groupReviewQueue<T extends ReviewQueueEntry>(entries: T[], kindGroups: WarningKindGroup[]): Record<ReviewGroup, T[]> {
  const grouped: Record<ReviewGroup, T[]> = { fix: [], check: [], clean: [], structure: [] };
  for (const { entry, tier } of buildTieredQueue(entries, kindGroups)) grouped[reviewGroupOf(tier)].push(entry);
  return grouped;
}

// Where the queue steps after the current item is dealt with: the first item still in the queue that came AFTER it, wrapping to the
// top only when it was the last. (The first of what is left would send a reviewer who stepped on with J back to the start.) One
// pass: a Set of what remains, then a forward scan from the current position.
export function nextInQueue<T extends { localId: string }>(before: T[], currentId: string, rest: T[]): T | undefined {
  if (rest.length === 0) return undefined;
  const currentIndex = before.findIndex((entry) => entry.localId === currentId);
  if (currentIndex === -1) return rest[0];
  const remaining = new Map(rest.map((entry) => [entry.localId, entry]));
  for (let index = currentIndex + 1; index < before.length; index += 1) {
    const found = remaining.get(before[index].localId);
    if (found) return found;
  }
  return rest[0];
}

// "N of M reviewed" for the write bar (the Jobs list's count is the same rule, mirrored in the orchestrator's review-progress.ts).
// Reviewable = a new item (action 'create') that is not excluded, itself or through an excluded ancestor (confirm drops those too);
// reviewed = of those, the ones marked reviewed. Reuse and near-duplicate entries are not written, so they are not counted.
export function reviewProgress(entries: ReviewQueueEntry[]): { reviewed: number; reviewable: number } {
  const byId = new Map(entries.map((entry) => [entry.localId, entry]));
  const cache = new Map<string, boolean>();
  let reviewed = 0;
  let reviewable = 0;
  for (const entry of entries) {
    if (entry.action !== 'create' || isExcludedWithAncestors(entry, byId, cache)) continue;
    reviewable += 1;
    if (entry.reviewed) reviewed += 1;
  }
  return { reviewed, reviewable };
}

export interface CleanApproval<T> {
  // Lowest quality score first, so the sample always starts with the weakest of them (BASELINE: tree order, nothing is scored).
  items: T[];
  // Still up for review but left out: blocking, low-score, flagged or warned items.
  flagged: number;
  unscored: number;
  stale: number;
  // BASELINE only: Epics and Features, never offered (they are checked one by one, DESIGN.md §11.5.1). SURVEY counts them as unscored.
  structure: number;
  lowestScore: number | null;
  highestScore: number | null;
}

// What "approve clean items" would mark reviewed. "Clean" means "not flagged", never "verified":
// the queue's clean tier (no flag, no fix/review warning; info warnings do not count). In SURVEY it is
// restricted to items that carry a current score, since the queue's clean tier also holds unscored ones.
// BASELINE scores nothing (its text is verbatim), so there clean means only "no warning": score and
// staleness are not looked at. There is deliberately no score threshold of its own.
export function cleanApproval<T extends ReviewQueueEntry & { qualityStale?: boolean }>(
  entries: T[],
  kindGroups: WarningKindGroup[],
  mode: 'survey' | 'baseline' = 'survey',
): CleanApproval<T> {
  const items: T[] = [];
  let flagged = 0;
  let unscored = 0;
  let stale = 0;
  let structure = 0;
  for (const { entry, tier } of buildTieredQueue(entries, kindGroups)) {
    if (tier === 'structure') {
      if (mode === 'baseline') structure += 1;
      else unscored += 1;
    } else if (tier !== 'clean') flagged += 1;
    else if (mode === 'baseline') items.push(entry);
    else if (entry.qualityScore == null) unscored += 1;
    else if (entry.qualityStale) stale += 1;
    else items.push(entry);
  }
  const scores = mode === 'baseline' ? [] : items.map((item) => item.qualityScore as number);
  return {
    items,
    flagged,
    unscored,
    stale,
    structure,
    lowestScore: scores.length > 0 ? scores[0] : null,
    highestScore: scores.length > 0 ? scores[scores.length - 1] : null,
  };
}

// The items the reviewer must look at before approving the rest: max(3, ceil(N / 10)) of them,
// capped at N. Input is lowest score first (as cleanApproval returns it; tree order in BASELINE); the sample starts at the
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
    kindGroups.find((kind) => kind.group === group && !isAcknowledgedKind(kind) && kind.nodeIds.includes(entry.localId));
  const check = 'Check it against its source, then mark it reviewed.';
  switch (riskTier(entry, kindGroups)) {
    case 'blocking': {
      const kind = firstKind('fix');
      return {
        title: `Blocking warning: ${kind?.meta.title ?? 'needs a fix'}`,
        todo: kind?.meta.todo ?? 'Fix this before you write.',
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
    case 'structure':
      return {
        title: 'Not scored',
        todo: 'Epics and Features are not scored. Check the title and where it sits in the tree, then mark it reviewed.',
        group: 'info',
      };
    default:
      // BASELINE items carry no score at all; "nothing was
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
