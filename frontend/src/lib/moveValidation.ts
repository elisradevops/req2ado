import { canNest, canBeRoot } from './canNest';
import type { DryRunDiffEntry } from '../components/DiffTree';

// Extracted from DiffTree.tsx so the keyboard-accessible "Move to..." control
// (NodeDetailPanel, via MoveToPicker) and the drag-and-drop path share the
// exact same validity rule instead of two independently-drifting copies --
// DESIGN.md §11.5 already makes this exact promise for the drag path's own
// mirror of JobsService.moveDiffEntry's server-side checks; this just extends
// "one rule, several callers" to the second UI entry point.

export type MoveRejectionReason = 'self' | 'cycle' | 'tier' | 'root-tier';

export function isDescendantOf(byLocalId: Map<string, DryRunDiffEntry>, candidateId: string, ofId: string): boolean {
  let cursor = byLocalId.get(candidateId);
  while (cursor && cursor.parentLocalId) {
    if (cursor.parentLocalId === ofId) return true;
    cursor = byLocalId.get(cursor.parentLocalId);
  }
  return false;
}

// Mirrors JobsService.moveDiffEntry's own validation exactly (same
// canNest/canBeRoot import) so a rejection here and a rejection on the
// server are always the same rejection -- this is a client-side preview,
// not an independent rule set.
export function moveValidationReason(
  entries: DryRunDiffEntry[],
  byLocalId: Map<string, DryRunDiffEntry>,
  dragId: string,
  targetParentId: string | null,
): MoveRejectionReason | null {
  const dragEntry = byLocalId.get(dragId);
  if (!dragEntry) return null;
  if (targetParentId !== null) {
    if (targetParentId === dragId) return 'self';
    if (isDescendantOf(byLocalId, targetParentId, dragId)) return 'cycle';
    const parentEntry = byLocalId.get(targetParentId);
    if (!parentEntry || !canNest(dragEntry.type, parentEntry.type)) return 'tier';
    return null;
  }
  const anyEpicExists = entries.some((entry) => entry.type === 'Epic');
  return canBeRoot(dragEntry.type, anyEpicExists) ? null : 'root-tier';
}

// Every OTHER entry that `localId` could legally be reparented under --
// backs the "Move to..." picker (NodeDetailPanel) the same way
// AddChildForm's own validParentsFor backs its parent picker, but with the
// cycle exclusion a brand-new entry never needs (it can't be anyone's
// ancestor yet; an EXISTING entry being reparented can be).
export function validNewParentsFor(
  entries: DryRunDiffEntry[],
  byLocalId: Map<string, DryRunDiffEntry>,
  localId: string,
): DryRunDiffEntry[] {
  return entries.filter((candidate) => moveValidationReason(entries, byLocalId, localId, candidate.localId) === null);
}
