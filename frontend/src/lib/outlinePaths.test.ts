import { describe, it, expect } from 'vitest';
import { buildOutlinePaths } from './outlinePaths';
import type { MapItem } from '../api/liveTypes';

const item = (ref: string, title: string, depth: number): MapItem => ({ ref, title, words: 1, depth, type: null });

describe('buildOutlinePaths', () => {
  const items = [
    item('s1', 'Subsystem 1', 0),
    item('f11', 'Function 1.1', 1),
    item('r1', 'Requirement one', 2),
    item('r2', 'Requirement two', 2),
    item('f12', 'Function 1.2', 1),
    item('r3', 'Requirement three', 2),
    item('s2', 'Subsystem 2', 0),
    item('r4', 'Requirement four', 1),
  ];

  it('names the headings above each item, outermost first', () => {
    const paths = buildOutlinePaths(items);
    expect(paths.get('r1')).toBe('Subsystem 1 › Function 1.1');
    expect(paths.get('r2')).toBe('Subsystem 1 › Function 1.1');
    expect(paths.get('r3')).toBe('Subsystem 1 › Function 1.2');
    expect(paths.get('f12')).toBe('Subsystem 1');
  });

  it('gives a top-level item no path', () => {
    const paths = buildOutlinePaths(items);
    expect(paths.has('s1')).toBe(false);
    expect(paths.has('s2')).toBe(false);
  });

  it('does not carry a sibling branch into the next top-level item', () => {
    expect(buildOutlinePaths(items).get('r4')).toBe('Subsystem 2');
  });

  it('copes with a jump of more than one level and with an empty outline', () => {
    const jumpy = [item('a', 'A', 0), item('c', 'C', 3), item('d', 'D', 1)];
    const paths = buildOutlinePaths(jumpy);
    expect(paths.get('c')).toBe('A');
    expect(paths.get('d')).toBe('A');
    expect(buildOutlinePaths([]).size).toBe(0);
  });

  it('copes with an item shallower than the one before it at the very start', () => {
    expect(buildOutlinePaths([item('x', 'X', 2), item('y', 'Y', 0)]).size).toBe(0);
  });
});
