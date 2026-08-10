import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { forwardRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { DiffTree } from './DiffTree';
import type { DryRunDiffEntry } from './DiffTree';

// Real react-window virtualizes by measured container height, which jsdom
// reports as 0 -- fine for every other test here (small fixtures still fit
// the FALLBACK_LIST_HEIGHT window), but scrollToItem is an imperative
// method on the real FixedSizeList instance with no observable DOM effect
// in jsdom, so the only way to assert DiffTree actually CALLS it (the bug
// this fixes: "Review item" never scrolled/highlighted its target) is to
// substitute a minimal stub exposing a spy-able scrollToItem and rendering
// every item unconditionally (no virtualization needed for these tiny
// fixtures). vi.hoisted is required here -- vi.mock factories are hoisted
// above regular imports/consts, so a plain outer `const` would throw a
// use-before-initialization error.
const { scrollToItem } = vi.hoisted(() => ({ scrollToItem: vi.fn() }));

vi.mock('react-window', () => ({
  FixedSizeList: forwardRef<
    { scrollToItem: typeof scrollToItem },
    { itemCount: number; children: (args: { index: number; style: CSSProperties }) => ReactNode }
  >((props, ref) => {
    if (typeof ref === 'function') ref({ scrollToItem });
    else if (ref) ref.current = { scrollToItem };
    return (
      <div>
        {Array.from({ length: props.itemCount }, (_, index) => (
          <div key={index}>{props.children({ index, style: {} })}</div>
        ))}
      </div>
    );
  }),
}));

const ENTRIES: DryRunDiffEntry[] = [
  { localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Root Epic', description: '', action: 'create', customerId: null, tags: [] },
  { localId: 'f1', parentLocalId: 'e1', type: 'Feature', title: 'Child Feature', description: '', action: 'create', customerId: null, tags: [] },
  { localId: 'orphan1', parentLocalId: 'missing-parent', type: 'Requirement', title: 'Orphan Req', description: '', action: 'create', customerId: null, tags: [] },
];

describe('DiffTree', () => {
  it('builds nesting from parentLocalId and renders orphans as their own roots', () => {
    render(
      <DiffTree entries={ENTRIES} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />,
    );
    expect(screen.getByText('Root Epic')).toBeInTheDocument();
    expect(screen.getByText('Child Feature')).toBeInTheDocument();
    expect(screen.getByText('Orphan Req')).toBeInTheDocument();
  });

  it('calls onSelect with the localId when a row is clicked', async () => {
    const onSelect = vi.fn();
    render(
      <DiffTree entries={ENTRIES} selectedId={null} onSelect={onSelect} filterAction={null} filterText="" onToggleExclude={vi.fn()} />,
    );
    screen.getByText('Root Epic').click();
    expect(onSelect).toHaveBeenCalledWith('e1');
  });

  it('filters by text', () => {
    render(
      <DiffTree
        entries={ENTRIES}
        selectedId={null}
        onSelect={vi.fn()}
        filterAction={null}
        filterText="Orphan"
        onToggleExclude={vi.fn()}
      />,
    );
    expect(screen.getByText('Orphan Req')).toBeInTheDocument();
    expect(screen.queryByText('Root Epic')).not.toBeInTheDocument();
  });

  it('renders an exclude toggle for every row and calls onToggleExclude with the flipped value', () => {
    const onToggleExclude = vi.fn();
    render(
      <DiffTree entries={ENTRIES} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={onToggleExclude} />,
    );
    const toggles = screen.getAllByRole('checkbox', { name: /exclude/i });
    expect(toggles).toHaveLength(ENTRIES.length);
    toggles[0].click();
    expect(onToggleExclude).toHaveBeenCalledWith('e1', true);
  });

  it('dims an excluded row', () => {
    const excludedEntries = [{ ...ENTRIES[0], excluded: true }, ...ENTRIES.slice(1)];
    render(
      <DiffTree entries={excludedEntries} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />,
    );
    expect(screen.getByText('Root Epic').closest('[data-excluded="true"]')).not.toBeNull();
  });

  it('renders a row with a long title without crashing (truncated single-line, not wrapped)', () => {
    const longEntry: DryRunDiffEntry = {
      localId: 'long1',
      parentLocalId: null,
      type: 'Requirement',
      title:
        'The system shall provide a comprehensive mechanism for handling multi-line wrapped titles that would previously overflow a fixed 56px row and overlap the row below it',
      description: '',
      action: 'create',
      customerId: null,
      tags: ['functional', 'interface', 'performance', 'regulatory'],
    };
    render(
      <DiffTree entries={[longEntry]} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />,
    );
    expect(screen.getByText(longEntry.title)).toBeInTheDocument();
  });

  it('re-renders correctly when a row is edited (title changes) and when a row is added', () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <DiffTree entries={ENTRIES} selectedId={null} onSelect={onSelect} filterAction={null} filterText="" onToggleExclude={vi.fn()} />,
    );
    expect(screen.getByText('Root Epic')).toBeInTheDocument();

    const editedEntries = [{ ...ENTRIES[0], title: 'Root Epic Edited' }, ...ENTRIES.slice(1)];
    rerender(
      <DiffTree entries={editedEntries} selectedId={null} onSelect={onSelect} filterAction={null} filterText="" onToggleExclude={vi.fn()} />,
    );
    expect(screen.getByText('Root Epic Edited')).toBeInTheDocument();
    expect(screen.queryByText('Root Epic')).not.toBeInTheDocument();

    const withAddedChild: DryRunDiffEntry[] = [
      ...editedEntries,
      { localId: 'new1', parentLocalId: 'e1', type: 'Requirement', title: 'New Added Requirement', description: '', action: 'create', customerId: null, tags: [] },
    ];
    rerender(
      <DiffTree entries={withAddedChild} selectedId={null} onSelect={onSelect} filterAction={null} filterText="" onToggleExclude={vi.fn()} />,
    );
    expect(screen.getByText('New Added Requirement')).toBeInTheDocument();
  });

  it('collapses a parent node, hiding its children, and expands it back on a second click', async () => {
    render(
      <DiffTree entries={ENTRIES} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />,
    );
    expect(screen.getByText('Child Feature')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /collapse root epic/i }));
    expect(screen.queryByText('Child Feature')).not.toBeInTheDocument();
    expect(screen.getByText('Root Epic')).toBeInTheDocument(); // the collapsed row itself stays visible

    await userEvent.click(screen.getByRole('button', { name: /expand root epic/i }));
    expect(screen.getByText('Child Feature')).toBeInTheDocument();
  });

  it('ignores collapse state while a filter is active, so a match under a collapsed parent still shows', async () => {
    const { rerender } = render(
      <DiffTree entries={ENTRIES} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /collapse root epic/i }));
    expect(screen.queryByText('Child Feature')).not.toBeInTheDocument();

    rerender(
      <DiffTree entries={ENTRIES} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="Child" onToggleExclude={vi.fn()} />,
    );
    expect(screen.getByText('Child Feature')).toBeInTheDocument();
  });

  it('ArrowDown/ArrowUp move selection between visible rows', async () => {
    const onSelect = vi.fn();
    render(
      <DiffTree entries={ENTRIES} selectedId="e1" onSelect={onSelect} filterAction={null} filterText="" onToggleExclude={vi.fn()} />,
    );
    const container = screen.getByText('Root Epic').closest('[tabindex]') as HTMLElement;
    container.focus();

    await userEvent.keyboard('{ArrowDown}');
    expect(onSelect).toHaveBeenCalledWith('f1');

    onSelect.mockClear();
    await userEvent.keyboard('{ArrowUp}');
    expect(onSelect).toHaveBeenCalledWith('e1');
  });
});

describe('DiffTree selectedId navigation (jump-to-node from outside the tree)', () => {
  beforeEach(() => {
    scrollToItem.mockClear();
  });

  // Real gap this closes (user-reported): CollapsibleWarnings' "Review
  // item ->" button only ever set selectedId -- if the target's ancestor
  // chain was collapsed, the row never rendered at all and the click
  // looked like it did nothing.
  it('auto-expands a collapsed ancestor when selectedId changes to one of its descendants, then scrolls it into view', async () => {
    const { rerender } = render(
      <DiffTree entries={ENTRIES} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /collapse root epic/i }));
    expect(screen.queryByText('Child Feature')).not.toBeInTheDocument();
    scrollToItem.mockClear(); // isolate the assertion below from any scroll the collapse click itself triggered

    rerender(<DiffTree entries={ENTRIES} selectedId="f1" onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />);

    expect(screen.getByText('Child Feature')).toBeInTheDocument(); // ancestor (e1) auto-expanded
    expect(scrollToItem).toHaveBeenCalledWith(1, 'center'); // e1=0, f1=1 once expanded
  });

  it('scrolls to the selected row even when no ancestor needs expanding', () => {
    render(<DiffTree entries={ENTRIES} selectedId="orphan1" onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />);

    expect(scrollToItem).toHaveBeenCalledWith(2, 'center'); // e1=0, f1=1, orphan1=2
  });

  it('does not scroll when selectedId is null', () => {
    render(<DiffTree entries={ENTRIES} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />);

    expect(scrollToItem).not.toHaveBeenCalled();
  });
});

const baseEntry: DryRunDiffEntry = {
  localId: 'n0',
  parentLocalId: null,
  type: 'Requirement',
  title: 'Sys Req',
  description: 'd',
  action: 'create',
  customerId: null,
};

describe('DiffTree signal counts', () => {
  // Trace link CHIPS (full displayName/target detail) moved to
  // NodeDetailPanel's own TraceLinkChips rendering (see its test file) --
  // DiffTree rows now show only a compact count, part of "pure information,
  // details live in the dialog" per the table redesign.
  it('shows a compact trace-link count badge, not the full chip detail', () => {
    const entries: DryRunDiffEntry[] = [
      {
        ...baseEntry,
        traceLinks: [
          { sourceLocalId: 'n0', referenceName: 'Elisra.CoveredBy-Forward', displayName: 'Covered by', targetKind: 'crossJob', targetCustomerId: 'REQ-SYS-012', resolvedAdoId: 555, resolutionStatus: 'resolved' },
        ],
      },
    ];

    render(<DiffTree entries={entries} selectedId={null} onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);

    expect(screen.getByTitle('1 trace link(s)')).toBeInTheDocument();
    expect(screen.queryByText(/Covered by/i)).not.toBeInTheDocument();
  });

  it('shows a compact quality-issue count badge, not the full chip detail', () => {
    const entries: DryRunDiffEntry[] = [
      { ...baseEntry, qualityIssues: ['ambiguous', 'vague_term'] },
    ];

    render(<DiffTree entries={entries} selectedId={null} onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);

    expect(screen.getByTitle('2 quality issue(s)')).toBeInTheDocument();
    expect(screen.queryByText(/Ambiguous/i)).not.toBeInTheDocument();
  });

  it('calls onOpenDetails (not just onSelect) when the details button is clicked', async () => {
    const onSelect = vi.fn();
    const onOpenDetails = vi.fn();
    render(
      <DiffTree entries={[baseEntry]} selectedId={null} onSelect={onSelect} onOpenDetails={onOpenDetails} filterAction={null} filterText="" onToggleExclude={() => {}} />,
    );

    await screen.getByRole('button', { name: /details for sys req/i }).click();
    expect(onSelect).toHaveBeenCalledWith('n0');
    expect(onOpenDetails).toHaveBeenCalledWith('n0');
  });

  it('falls back to onSelect when onOpenDetails is omitted', () => {
    const onSelect = vi.fn();
    render(<DiffTree entries={[baseEntry]} selectedId={null} onSelect={onSelect} filterAction={null} filterText="" onToggleExclude={() => {}} />);

    screen.getByText('Sys Req').click();
    expect(onSelect).toHaveBeenCalledWith('n0');
  });
});
