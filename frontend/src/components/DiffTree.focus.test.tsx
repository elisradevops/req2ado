import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiffTree } from './DiffTree';
import type { DryRunDiffEntry } from './DiffTree';

// Uses the real react-window (DiffTree.test.tsx stubs it): a remount of the row is only visible with the real list,
// which treats its render function as a component type.
const entry = (localId: string, parentLocalId: string | null, type: string, title: string): DryRunDiffEntry =>
  ({ localId, parentLocalId, type, title, description: '', action: 'create', customerId: null }) as DryRunDiffEntry;

describe('DiffTree keyboard focus', () => {
  // jsdom measures every box as 0 high, which gives the real list no room to render rows; give the tree a viewport.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps focus on the same disclosure button after it is toggled from the keyboard', async () => {
    const entries = [
      entry('e1', null, 'Epic', 'Epic 1'),
      entry('f1', 'e1', 'Feature', 'Feature 1'),
      entry('r1', 'f1', 'Requirement', 'Req 1'),
      entry('f2', 'e1', 'Feature', 'Feature 2'),
      entry('r2', 'f2', 'Requirement', 'Req 2'),
    ];
    render(<DiffTree entries={entries} selectedId={null} onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);

    const toggle = screen.getByRole('button', { name: 'Expand Feature 2' });
    toggle.focus();
    expect(toggle).toHaveFocus();

    await userEvent.keyboard('{Enter}');

    const after = screen.getByRole('button', { name: 'Collapse Feature 2' });
    expect(after).toBe(toggle); // same element: the row was not remounted
    expect(after).toHaveFocus();
    expect(screen.getByText('Req 2')).toBeInTheDocument();
  });
  const treeEntries = [
    entry('e1', null, 'Epic', 'Epic 1'),
    entry('f1', 'e1', 'Feature', 'Feature 1'),
    entry('r1', 'f1', 'Requirement', 'Req 1'),
  ];
  const renderTree = (selectedId: string | null) =>
    render(<DiffTree entries={treeEntries} selectedId={selectedId} onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);

  it('points the tree at the selected row, so a screen reader hears the row the arrow keys moved to', () => {
    renderTree('r1');
    const tree = screen.getByRole('tree');
    const row = screen.getByText('Req 1').closest('[role="treeitem"]') as HTMLElement;
    expect(row.id).not.toBe('');
    expect(tree).toHaveAttribute('aria-activedescendant', row.id);
  });

  it('names no active row when nothing is selected', () => {
    renderTree(null);
    expect(screen.getByRole('tree')).not.toHaveAttribute('aria-activedescendant');
  });

  it('gives every row its own id', () => {
    renderTree('r1');
    const ids = screen.getAllByRole('treeitem').map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id !== '')).toBe(true);
  });

  it('keeps the universal focus ring on the tree: no focus:outline-none without a replacement (DESIGN.md section 7)', () => {
    renderTree(null);
    expect(screen.getByRole('tree').className).not.toMatch(/outline-none/);
  });
});
