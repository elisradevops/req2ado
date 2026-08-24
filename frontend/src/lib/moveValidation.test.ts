import { describe, it, expect } from 'vitest';
import { isDescendantOf, moveValidationReason, validNewParentsFor } from './moveValidation';
import type { DryRunDiffEntry } from '../components/DiffTree';

function entry(localId: string, parentLocalId: string | null, type: string): DryRunDiffEntry {
  return { localId, parentLocalId, type, title: localId, description: '', action: 'create', customerId: null };
}

const epic1 = entry('e1', null, 'Epic');
const epic2 = entry('e2', null, 'Epic');
const feature1 = entry('f1', 'e1', 'Feature');
const feature2 = entry('f2', 'e1', 'Feature');
const requirement1 = entry('r1', 'f1', 'Requirement');
const ENTRIES = [epic1, epic2, feature1, feature2, requirement1];
const byLocalId = new Map(ENTRIES.map((e) => [e.localId, e]));

describe('isDescendantOf', () => {
  it('is true for a direct child', () => {
    expect(isDescendantOf(byLocalId, 'f1', 'e1')).toBe(true);
  });

  it('is true for a transitive descendant', () => {
    expect(isDescendantOf(byLocalId, 'r1', 'e1')).toBe(true);
  });

  it('is false for a sibling', () => {
    expect(isDescendantOf(byLocalId, 'f2', 'f1')).toBe(false);
  });

  it('is false for an unrelated root', () => {
    expect(isDescendantOf(byLocalId, 'e2', 'e1')).toBe(false);
  });
});

describe('moveValidationReason', () => {
  it('allows a valid reparent (one tier down)', () => {
    expect(moveValidationReason(ENTRIES, byLocalId, 'f1', 'e2')).toBeNull();
  });

  it('allows a same-tier move (flagged client-side elsewhere, not rejected here)', () => {
    expect(moveValidationReason(ENTRIES, byLocalId, 'e2', 'e1')).toBeNull();
  });

  it('rejects moving a node onto itself', () => {
    expect(moveValidationReason(ENTRIES, byLocalId, 'e1', 'e1')).toBe('self');
  });

  it('rejects moving a node into its own descendant (cycle)', () => {
    expect(moveValidationReason(ENTRIES, byLocalId, 'e1', 'r1')).toBe('cycle');
  });

  it('rejects a tier violation (skipping a tier)', () => {
    expect(moveValidationReason(ENTRIES, byLocalId, 'r1', 'e2')).toBe('tier');
  });

  it('rejects root placement for a category that cannot be a root (Requirement)', () => {
    expect(moveValidationReason(ENTRIES, byLocalId, 'r1', null)).toBe('root-tier');
  });

  it('allows root placement for the top category', () => {
    expect(moveValidationReason(ENTRIES, byLocalId, 'e1', null)).toBeNull();
  });

  it('allows root placement for a Feature when no Epic exists', () => {
    const noEpics = [{ ...feature1, parentLocalId: null }];
    const map = new Map(noEpics.map((e) => [e.localId, e]));
    expect(moveValidationReason(noEpics, map, 'f1', null)).toBeNull();
  });
});

describe('validNewParentsFor', () => {
  it('excludes the entry itself, its descendants, and tier-invalid candidates', () => {
    const candidates = validNewParentsFor(ENTRIES, byLocalId, 'f1').map((e) => e.localId);
    // f1 (self) and r1 (its own descendant) must never appear.
    expect(candidates).not.toContain('f1');
    expect(candidates).not.toContain('r1');
    // e1 (current parent, repeat-tier-valid against itself), e2 (another
    // Epic), and f2 (a sibling Feature, same-tier valid) are all legal.
    expect(candidates.sort()).toEqual(['e1', 'e2', 'f2']);
  });

  // moveValidationReason's own guard (`if (!dragEntry) return null`) treats
  // a nonexistent drag entry as unvalidatable rather than definitively
  // invalid -- matches the original DiffTree.tsx behavior this was
  // extracted from verbatim (never reachable via the UI: nothing can drag
  // an entry that isn't rendered in the first place).
  it('returns every entry for an unknown localId -- no drag entry to validate against', () => {
    expect(validNewParentsFor(ENTRIES, byLocalId, 'bogus')).toEqual(ENTRIES);
  });
});
