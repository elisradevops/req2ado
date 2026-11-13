import { kindProgress, type AckPolicy, type WarningKindGroup } from './warningKinds';

// The write gate: Write stays disabled while any "Fix before writing" kind is open. Pure, so the header, the sticky bar, the
// confirm dialog and the tests all read the same answer. One pass over the kinds; a kind's items are checked against a Set.
export interface WriteBlocker {
  kind: string;
  title: string;
  ackPolicy: AckPolicy;
  // Affected items that still need a decision (not reviewed, not excluded). Empty for a kind counted by its records.
  nodeIds: string[];
  // Items (or, for a kind without items, records) still to decide, and the kind's total.
  remaining: number;
  total: number;
}

export interface WriteGate {
  blocked: boolean;
  // Sum of `remaining` over the blockers: the number shown next to Write.
  remaining: number;
  blockers: WriteBlocker[];
  firstBlocker: WriteBlocker | null;
}

// `handledIds`: items the reviewer has decided on: marked reviewed, or excluded (an excluded item is not written, so its warning
// no longer reaches Azure DevOps).
export function computeWriteGate(kindGroups: WarningKindGroup[], handledIds: ReadonlySet<string>): WriteGate {
  const blockers: WriteBlocker[] = [];
  let remaining = 0;
  for (const entry of kindGroups) {
    if (entry.group !== 'fix') continue;
    const progress = kindProgress(entry, handledIds);
    if (!progress.trackable || progress.complete) continue;
    const open = entry.nodeIds.length > 0 ? entry.nodeIds.filter((nodeId) => !handledIds.has(nodeId)) : [];
    const left = entry.nodeIds.length > 0 ? open.length : progress.total - progress.reviewed;
    blockers.push({
      kind: entry.kind,
      title: entry.meta.title,
      ackPolicy: entry.meta.ackPolicy ?? 'per_item',
      nodeIds: open,
      remaining: left,
      total: progress.total,
    });
    remaining += left;
  }
  return { blocked: blockers.length > 0, remaining, blockers, firstBlocker: blockers[0] ?? null };
}

// Records of "Check" kinds the reviewer has not finished: the dialog's "N to check", read from the same progress the page banner uses, so
// deciding every item of a kind clears it in both places (a record's own `acknowledged` flag is only set by "Mark handled").
export function openReviewRecordCount(groups: ReadonlyArray<WarningKindGroup>, handledIds: ReadonlySet<string>): number {
  let open = 0;
  for (const group of groups) {
    if (group.group === 'review' && !kindProgress(group, handledIds).complete) open += group.records.length;
  }
  return open;
}
