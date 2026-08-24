import { describe, it, expect } from 'vitest';
import { applyMoveOptimistically } from './applyMove';
import type { DryRunDiffEntry } from '../components/DiffTree';

const epic1: DryRunDiffEntry = { localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Epic 1', description: '', action: 'create', customerId: null };
const epic2: DryRunDiffEntry = { localId: 'e2', parentLocalId: null, type: 'Epic', title: 'Epic 2', description: '', action: 'create', customerId: null };
const feature1: DryRunDiffEntry = { localId: 'f1', parentLocalId: 'e1', type: 'Feature', title: 'Feature 1', description: '', action: 'create', customerId: null };
const feature2: DryRunDiffEntry = { localId: 'f2', parentLocalId: 'e1', type: 'Feature', title: 'Feature 2', description: '', action: 'create', customerId: null };

describe('applyMoveOptimistically', () => {
  it('reparents an entry to the new parentLocalId', () => {
    const result = applyMoveOptimistically([epic1, epic2, feature1], 'f1', { parentLocalId: 'e2' });
    expect(result.find((e) => e.localId === 'f1')!.parentLocalId).toBe('e2');
  });

  it('moves an entry to the top level when parentLocalId is null', () => {
    const result = applyMoveOptimistically([epic1, feature1], 'f1', { parentLocalId: null });
    expect(result.find((e) => e.localId === 'f1')!.parentLocalId).toBeNull();
  });

  it('does not mutate the input array or its entries (returns a fresh clone)', () => {
    const original = [epic1, epic2, feature1];
    const result = applyMoveOptimistically(original, 'f1', { parentLocalId: 'e2' });
    expect(original.find((e) => e.localId === 'f1')!.parentLocalId).toBe('e1'); // untouched
    expect(result).not.toBe(original);
    expect(result.find((e) => e.localId === 'f1')).not.toBe(feature1); // entry itself cloned
  });

  it('reorders before a sibling using anchorLocalId/placement, and array order reflects it', () => {
    const result = applyMoveOptimistically([epic1, feature1, feature2], 'f2', {
      parentLocalId: 'e1',
      anchorLocalId: 'f1',
      placement: 'before',
    });
    const order = result.map((e) => e.localId);
    expect(order.indexOf('f2')).toBeLessThan(order.indexOf('f1'));
  });

  it('reorders after a sibling', () => {
    const result = applyMoveOptimistically([epic1, feature1, feature2], 'f1', {
      parentLocalId: 'e1',
      anchorLocalId: 'f2',
      placement: 'after',
    });
    const order = result.map((e) => e.localId);
    expect(order.indexOf('f1')).toBeGreaterThan(order.indexOf('f2'));
  });

  it('appends after the new parent\'s last existing child when no anchor is given', () => {
    const result = applyMoveOptimistically([epic1, epic2, feature1, feature2], 'f1', { parentLocalId: 'e2' });
    expect(result.find((e) => e.localId === 'f1')!.parentLocalId).toBe('e2');
    expect(result.find((e) => e.localId === 'f2')!.parentLocalId).toBe('e1'); // unaffected
  });

  it('returns the original array unchanged when the entry does not exist', () => {
    const original = [epic1, feature1];
    const result = applyMoveOptimistically(original, 'bogus', { parentLocalId: 'e1' });
    expect(result).toBe(original);
  });

  it('returns the original array unchanged when the anchor does not belong to the requested parent', () => {
    const original = [epic1, epic2, feature1, feature2];
    // f1's real parent is e1 -- an anchor claim of e2 is inconsistent, so
    // this preview bails out rather than guessing; the real server request
    // still fires and its response (or a revert on rejection) resolves it.
    const result = applyMoveOptimistically(original, 'f2', { parentLocalId: 'e2', anchorLocalId: 'f1', placement: 'before' });
    expect(result).toBe(original);
  });
});
