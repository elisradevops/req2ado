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
  // Tab stops inside the tree: a control is a stop unless it is taken out of the tab order with tabindex -1.
  const tabStops = (): string[] =>
    [...screen.getByRole('tree').querySelectorAll<HTMLElement>('a[href], button, [tabindex]')]
      .filter((el) => el.getAttribute('tabindex') !== '-1')
      .map((el) => el.getAttribute('aria-label') ?? el.textContent ?? '');

  it('makes only the selected row\'s controls tab stops, so the tree is not seventy stops long', () => {
    renderTree('f1');
    expect(tabStops()).toEqual(['Exclude Feature 1', 'Collapse Feature 1', 'Details for Feature 1']);
  });

  it('has no row stop at all while nothing is selected: the tree itself is the one stop', () => {
    renderTree(null);
    expect(tabStops()).toEqual([]);
  });

  it('moves the stop with the selection', () => {
    const { rerender } = renderTree('f1');
    rerender(<DiffTree entries={treeEntries} selectedId="r1" onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);
    expect(tabStops()).toEqual(['Exclude Req 1', 'Details for Req 1']);
  });

  it('treats the work-item link in a row the same way: a stop only on the selected row', () => {
    const linked = [
      entry('e1', null, 'Epic', 'Epic 1'),
      { ...entry('r1', 'e1', 'Requirement', 'Req 1'), action: 'reuse', existingAdoId: 77 } as DryRunDiffEntry,
    ];
    const view = (selectedId: string) => (
      <DiffTree entries={linked} selectedId={selectedId} onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} orgUrl="https://ado.example" project="P" />
    );
    const { rerender } = render(view('e1'));
    expect(screen.getByRole('link')).toHaveAttribute('tabindex', '-1');
    rerender(view('r1'));
    expect(screen.getByRole('link')).not.toHaveAttribute('tabindex', '-1');
  });
  it('takes the scrolling list itself out of the tab order (a browser makes a scrollable region a stop), so the tree stays one stop', () => {
    renderTree(null);
    const scroller = screen.getByRole('tree').firstElementChild as HTMLElement;
    expect(scroller).toBeInstanceOf(HTMLElement);
    expect(scroller.style.overflow || scroller.className).not.toBe('');
    expect(scroller).toHaveAttribute('tabindex', '-1');
  });
});
