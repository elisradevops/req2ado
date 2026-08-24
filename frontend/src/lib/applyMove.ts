import type { DryRunDiffEntry } from '../components/DiffTree';
import type { MoveDiffEntryInput } from '../api/jobs';

// Client-side PREVIEW of JobsService.moveDiffEntry's own splice algorithm
// (jobs.service.ts) -- applied to local state immediately on drop/reorder,
// before the network round-trip resolves, so a move reads as instant
// instead of waiting on a full request/response cycle. This is a rendering
// optimization only, never a source of truth: the real move already passed
// DiffTree's own client-side canNest/cycle validation before onMove was
// ever called (the exact same rules this mirrors), and the server's
// response always overwrites this preview once it arrives -- a stale or
// slightly-off preview self-corrects within one round trip, and a
// rejected move (an already-linked entry, a mismatched anchor -- both
// invisible to client-side validation) is reverted by the caller.
//
// Deliberately NOT deduplicated against orchestrator's copy the way
// canNest.ts is (with a drift guard) -- that duplication exists because
// canNest is a VALIDATION RULE that must never disagree between client and
// server. This is a DISPLAY PREVIEW that the server's own response always
// overrides moments later, so a drift here degrades to "briefly shows the
// wrong order," never a correctness bug.
export function applyMoveOptimistically(diff: DryRunDiffEntry[], localId: string, input: MoveDiffEntryInput): DryRunDiffEntry[] {
  const next = diff.map((entry) => ({ ...entry }));
  const entry = next.find((e) => e.localId === localId);
  if (!entry) return diff;

  const fromIndex = next.indexOf(entry);
  next.splice(fromIndex, 1);
  entry.parentLocalId = input.parentLocalId;

  let insertAt: number;
  if (input.anchorLocalId) {
    const anchorIndex = next.findIndex((e) => e.localId === input.anchorLocalId);
    if (anchorIndex === -1 || next[anchorIndex].parentLocalId !== input.parentLocalId) return diff;
    insertAt = input.placement === 'before' ? anchorIndex : anchorIndex + 1;
  } else {
    let lastSiblingIndex = -1;
    next.forEach((e, i) => {
      if (e.parentLocalId === input.parentLocalId) lastSiblingIndex = i;
    });
    insertAt = lastSiblingIndex === -1 ? next.length : lastSiblingIndex + 1;
  }
  next.splice(insertAt, 0, entry);
  return next;
}
