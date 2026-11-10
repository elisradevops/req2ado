import { describe, it, expect } from 'vitest';
import { groupByParent, orderLikeTree } from './diffTreeOrder';

function node(localId: string, parentLocalId: string | null = null) {
  return { localId, parentLocalId };
}

describe('groupByParent', () => {
  it('groups siblings under their parent in diff order', () => {
    const groups = groupByParent([node('a'), node('b', 'a'), node('c', 'a'), node('d')]);
    expect(groups.get(null)?.map((entry) => entry.localId)).toEqual(['a', 'd']);
    expect(groups.get('a')?.map((entry) => entry.localId)).toEqual(['b', 'c']);
  });

  it('treats an entry whose parent is not in the list as a root', () => {
    const groups = groupByParent([node('a', 'gone'), node('b')]);
    expect(groups.get(null)?.map((entry) => entry.localId)).toEqual(['a', 'b']);
    expect(groups.has('gone')).toBe(false);
  });
});

describe('orderLikeTree', () => {
  it('orders depth-first from the roots, however the diff lists them', () => {
    // The diff can list a wrapper Epic after its children; the tree still draws it first.
    const ordered = orderLikeTree([
      node('f1', 'epic'),
      node('r1', 'f1'),
      node('f2', 'epic'),
      node('r2', 'f2'),
      node('epic'),
    ]);
    expect(ordered.map((entry) => entry.localId)).toEqual(['epic', 'f1', 'r1', 'f2', 'r2']);
  });

  it('keeps sibling roots in diff order', () => {
    expect(orderLikeTree([node('b'), node('a')]).map((entry) => entry.localId)).toEqual(['b', 'a']);
  });

  it('never drops an entry: a parent cycle is appended after the reachable tree', () => {
    const ordered = orderLikeTree([node('x', 'y'), node('y', 'x'), node('root')]);
    expect(ordered.map((entry) => entry.localId)).toEqual(['root', 'x', 'y']);
  });

  it('returns the same entries, not copies, and leaves its input alone', () => {
    const input = [node('b', 'a'), node('a')];
    const ordered = orderLikeTree(input);
    expect(ordered[0]).toBe(input[1]);
    expect(input.map((entry) => entry.localId)).toEqual(['b', 'a']);
  });

  it('is empty for an empty list', () => {
    expect(orderLikeTree([])).toEqual([]);
  });
});
