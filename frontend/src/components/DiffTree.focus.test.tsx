import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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

  it('opens and closes a parent from the keyboard on the row, without remounting it, and keeps focus on the tree', async () => {
    const entries = [
      entry('e1', null, 'Epic', 'Epic 1'),
      entry('f1', 'e1', 'Feature', 'Feature 1'),
      entry('r1', 'f1', 'Requirement', 'Req 1'),
      entry('f2', 'e1', 'Feature', 'Feature 2'),
      entry('r2', 'f2', 'Requirement', 'Req 2'),
    ];
    render(<DiffTree entries={entries} selectedId="f2" onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);

    const tree = screen.getByRole('tree');
    tree.focus();
    const row = screen.getByRole('treeitem', { name: 'Feature 2' });
    expect(row).toHaveAttribute('aria-expanded', 'false');

    await userEvent.keyboard('{ArrowRight}');

    const after = screen.getByRole('treeitem', { name: 'Feature 2' });
    expect(after).toBe(row); // same element: the row was not remounted
    expect(after).toHaveAttribute('aria-expanded', 'true');
    expect(tree).toHaveFocus();
    expect(screen.getByText('Req 2')).toBeInTheDocument();

    await userEvent.keyboard('{ArrowLeft}');
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Req 2')).not.toBeInTheDocument();
  });

  it('keeps the chevron a pointer control only: not a tab stop and hidden from assistive tech', () => {
    const entries = [entry('e1', null, 'Epic', 'Epic 1'), entry('f1', 'e1', 'Feature', 'Feature 1'), entry('r1', 'f1', 'Requirement', 'Req 1')];
    render(<DiffTree entries={entries} selectedId="f1" onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);
    const chevron = screen.getByLabelText('Collapse Feature 1');
    expect(chevron).toHaveAttribute('aria-hidden', 'true');
    expect(chevron).toHaveAttribute('tabindex', '-1');
    expect(chevron).not.toHaveAttribute('aria-expanded');
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
    expect(tabStops()).toEqual(['Exclude Feature 1', 'Details for Feature 1']);
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
  describe('the tree pattern (WAI-ARIA APG): names, sizes and keys', () => {
    const tree = [
      entry('e1', null, 'Epic', 'Epic 1'),
      entry('f1', 'e1', 'Feature', 'Feature 1'),
      { ...entry('r1', 'f1', 'Requirement', 'Req 1'), customerId: 'SRS-4' } as DryRunDiffEntry,
      entry('r2', 'f1', 'Requirement', 'Req 2'),
      entry('r3', 'f1', 'Requirement', 'Req 3'),
    ];
    const renderAt = (selectedId: string | null, onSelect = vi.fn()) => {
      render(<DiffTree entries={tree} selectedId={selectedId} onSelect={onSelect} filterAction={null} filterText="" onToggleExclude={() => {}} />);
      screen.getByRole('tree').focus();
      return onSelect;
    };

    it('names the tree', () => {
      renderAt(null);
      expect(screen.getByRole('tree')).toHaveAccessibleName('Proposed work items');
    });

    it('names each row by its title alone, said once, and describes it by type, customer id and what the write does', () => {
      renderAt('r1');
      const row = screen.getByRole('treeitem', { name: 'Req 1' });
      expect(row).toHaveAccessibleName('Req 1');
      expect(row).toHaveAccessibleDescription('Requirement, SRS-4, new');
    });

    it('says where a row sits among its visible siblings', () => {
      renderAt(null);
      const req2 = screen.getByRole('treeitem', { name: 'Req 2' });
      expect(req2).toHaveAttribute('aria-posinset', '2');
      expect(req2).toHaveAttribute('aria-setsize', '3');
      expect(screen.getByRole('treeitem', { name: 'Epic 1' })).toHaveAttribute('aria-setsize', '1');
    });

    it('puts aria-expanded on a parent row only', () => {
      renderAt(null);
      expect(screen.getByRole('treeitem', { name: 'Feature 1' })).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('treeitem', { name: 'Req 1' })).not.toHaveAttribute('aria-expanded');
    });

    it('ArrowRight on an open parent moves to its first child; on a leaf it does nothing', async () => {
      const onSelect = renderAt('f1');
      await userEvent.keyboard('{ArrowRight}');
      expect(onSelect).toHaveBeenLastCalledWith('r1');
      onSelect.mockClear();
      cleanup();
      const leaf = renderAt('r2');
      await userEvent.keyboard('{ArrowRight}');
      expect(leaf).not.toHaveBeenCalled();
    });

    it('ArrowLeft on a child moves to its parent', async () => {
      const onSelect = renderAt('r3');
      await userEvent.keyboard('{ArrowLeft}');
      expect(onSelect).toHaveBeenLastCalledWith('f1');
    });

    it('ArrowLeft on an open parent closes it and keeps the selection', async () => {
      const onSelect = renderAt('f1');
      await userEvent.keyboard('{ArrowLeft}');
      expect(onSelect).not.toHaveBeenCalled();
      expect(screen.getByRole('treeitem', { name: 'Feature 1' })).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('Req 1')).not.toBeInTheDocument();
    });

    it('Home and End move to the first and last visible row', async () => {
      const onSelect = renderAt('r2');
      await userEvent.keyboard('{End}');
      expect(onSelect).toHaveBeenLastCalledWith('r3');
      await userEvent.keyboard('{Home}');
      expect(onSelect).toHaveBeenLastCalledWith('e1');
    });

    it('still moves with ArrowUp and ArrowDown', async () => {
      const onSelect = renderAt('r2');
      await userEvent.keyboard('{ArrowDown}');
      expect(onSelect).toHaveBeenLastCalledWith('r3');
      await userEvent.keyboard('{ArrowUp}');
      expect(onSelect).toHaveBeenLastCalledWith('r1');
    });
  });

  it('takes the scrolling list itself out of the tab order (a browser makes a scrollable region a stop), so the tree stays one stop', () => {
    renderTree(null);
    const scroller = screen.getByRole('tree').firstElementChild as HTMLElement;
    expect(scroller).toBeInstanceOf(HTMLElement);
    expect(scroller.style.overflow || scroller.className).not.toBe('');
    expect(scroller).toHaveAttribute('tabindex', '-1');
  });
});
