import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
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
const { scrollToItem, itemKeyCalls } = vi.hoisted(() => ({ scrollToItem: vi.fn(), itemKeyCalls: [] as string[] }));

vi.mock('react-window', () => ({
  FixedSizeList: forwardRef<
    { scrollToItem: typeof scrollToItem },
    {
      itemCount: number;
      children: (args: { index: number; style: CSSProperties }) => ReactNode;
      itemKey?: (index: number) => string;
    }
  >((props, ref) => {
    if (typeof ref === 'function') ref({ scrollToItem });
    else if (ref) ref.current = { scrollToItem };
    return (
      <div>
        {Array.from({ length: props.itemCount }, (_, index) => {
          if (props.itemKey) itemKeyCalls.push(props.itemKey(index));
          return <div key={index}>{props.children({ index, style: {} })}</div>;
        })}
      </div>
    );
  }),
}));

// Stubs getBoundingClientRect on a row so @dnd-kit/core's own rect
// measurement (the active row's initial rect, and every droppable row's
// rect at drag start) is deterministic -- jsdom otherwise reports every
// element's rect as all-zero, which would make every row's collision
// distance identical.
function stubRowRect(el: HTMLElement, top = 0, height = 40): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    top,
    height,
    bottom: top + height,
    left: 0,
    right: 600,
    width: 600,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect);
}

function rowFor(title: string): HTMLElement {
  return screen.getByText(title).closest('[role="treeitem"]') as HTMLElement;
}

// @dnd-kit/core's MouseSensor drives a drag from real mousedown/mousemove/
// mouseup events -- jsdom fully supports the real MouseEvent constructor
// (unlike PointerEvent, which jsdom does not implement at all: an early
// attempt at this test file using PointerSensor + pointer events found
// `typeof PointerEvent === 'undefined'` in this project's jsdom version, so
// isPrimary/button never reached the sensor's activator and no drag ever
// started -- MouseSensor sidesteps that gap entirely, in tests and in every
// real desktop browser alike). move/end listeners attach to `document`, not
// the row itself (MouseSensor's own choice, so a row that unmounts
// mid-drag doesn't strand the gesture), so those two fire on `document`.
function fireMouseDown(el: HTMLElement, clientY: number, clientX = 100): void {
  fireEvent.mouseDown(el, { button: 0, clientX, clientY });
}
function fireMouseMove(clientY: number, clientX = 100): void {
  fireEvent.mouseMove(document, { clientX, clientY });
}
function fireMouseUp(clientY: number, clientX = 100): void {
  fireEvent.mouseUp(document, { clientX, clientY });
}

// A full drag gesture: mousedown, then a small move past the 4px
// activation-distance constraint (this is the move that fires dnd-kit's own
// onDragStart -- it does NOT also report the final position), then a second
// move to the real target position (this is the one that runs collision
// detection and updates `over`), then mouseup.
function dragRow(source: HTMLElement, opts: { fromY: number; toY: number; fromX?: number; toX?: number }): void {
  const fromX = opts.fromX ?? 100;
  const toX = opts.toX ?? 100;
  fireMouseDown(source, opts.fromY, fromX);
  fireMouseMove(opts.fromY + 10, fromX);
  fireMouseMove(opts.toY, toX);
  fireMouseUp(opts.toY, toX);
}

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

  it('renders a generic hierarchical index for every row, regardless of type, computed purely from tree position', () => {
    render(
      <DiffTree entries={ENTRIES} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />,
    );
    // e1 (root Epic) -> "1"; f1 (its only child Feature) -> "1.1"; orphan1
    // (its declared parent doesn't exist, so it becomes a second root
    // Requirement) -> "2" -- purely structural, unrelated to entry.type or
    // any document-derived customerId (all null in this fixture).
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('1.1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders customerId as a separate badge next to the title, distinct from the row index', () => {
    const withCustomerId: DryRunDiffEntry[] = [
      { localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Root Epic', description: '', action: 'create', customerId: null, tags: [] },
      { localId: 'f1', parentLocalId: 'e1', type: 'Feature', title: 'Child Feature', description: '', action: 'create', customerId: null, tags: [] },
      { localId: 'r1', parentLocalId: 'f1', type: 'Requirement', title: 'A Requirement', description: '', action: 'create', customerId: 'REQ-AV-014', tags: [] },
    ];
    render(
      <DiffTree entries={withCustomerId} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />,
    );
    // Child Feature starts collapsed by default -- expand it to reach its
    // Requirement child.
    fireEvent.click(screen.getByRole('button', { name: /expand child feature/i }));
    // The Requirement's own index (root Epic -> child Feature -> child
    // Requirement, all only children) is "1.1.1" -- present AND distinct
    // from its customerId badge "REQ-AV-014", both rendered simultaneously.
    expect(screen.getByText('1.1.1')).toBeInTheDocument();
    expect(screen.getByText('REQ-AV-014')).toBeInTheDocument();
    // Epic/Feature never render a customerId badge (both are null here) --
    // only their own index cells ("1", "1.1") appear.
    expect(screen.queryAllByText('null')).toHaveLength(0);
  });

  it('filters to a row by an exact index match, in addition to the existing title substring match', () => {
    const { rerender } = render(
      <DiffTree entries={ENTRIES} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />,
    );
    expect(screen.getByText('Child Feature')).toBeInTheDocument();
    expect(screen.getByText('Orphan Req')).toBeInTheDocument();

    // "1.1" is Child Feature's own index -- filtering to it hides every
    // other row, including the unrelated second-root Orphan Req.
    rerender(
      <DiffTree entries={ENTRIES} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="1.1" onToggleExclude={vi.fn()} />,
    );
    expect(screen.getByText('Child Feature')).toBeInTheDocument();
    expect(screen.queryByText('Orphan Req')).not.toBeInTheDocument();
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

  it('loads with every Feature collapsed by default, hiding its Requirements', () => {
    const entries: DryRunDiffEntry[] = [
      { localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Epic 1', description: '', action: 'create', customerId: null },
      { localId: 'f1', parentLocalId: 'e1', type: 'Feature', title: 'Feature 1', description: '', action: 'create', customerId: null },
      { localId: 'r1', parentLocalId: 'f1', type: 'Requirement', title: 'Req 1', description: '', action: 'create', customerId: null },
    ];
    render(<DiffTree entries={entries} selectedId={null} onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);

    expect(screen.getByText('Epic 1')).toBeInTheDocument();
    expect(screen.getByText('Feature 1')).toBeInTheDocument();
    expect(screen.queryByText('Req 1')).not.toBeInTheDocument();
  });

  it('shows a review chip on a flagged entry, not on a healthy one', () => {
    const entries: DryRunDiffEntry[] = [
      { localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Epic 1', description: '', action: 'create', customerId: null },
      { localId: 'f1', parentLocalId: 'e1', type: 'Feature', title: 'Feature 1', description: '', action: 'create', customerId: null },
      { localId: 'r1', parentLocalId: 'f1', type: 'Requirement', title: 'Flagged req', description: '', action: 'create', customerId: null, groundingScore: 0.1 },
      { localId: 'r2', parentLocalId: 'f1', type: 'Requirement', title: 'Healthy req', description: '', action: 'create', customerId: null, groundingScore: 0.9 },
    ];
    render(<DiffTree entries={entries} selectedId={null} onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);

    // Feature 1 starts collapsed (see the test above) -- expand it to reach the Requirements.
    fireEvent.click(screen.getByRole('button', { name: /expand feature 1/i }));

    // The flagged signal is an icon (title attribute), not chip text -- see
    // the Flags cell's own comment in DiffTree.tsx for why a text chip was
    // replaced with a fixed-size icon.
    const flaggedRow = screen.getByText('Flagged req').closest('[role="row"], div')?.parentElement as HTMLElement;
    const healthyRow = screen.getByText('Healthy req').closest('[role="row"], div')?.parentElement as HTMLElement;
    expect(within(flaggedRow).getByTitle(/low grounding/i)).toBeInTheDocument();
    expect(within(healthyRow).queryByTitle(/review/i)).not.toBeInTheDocument();
    // The icon's title must name the actual reason (low grounding here), not
    // a generic message -- distinguishes this from the low-confidence-only
    // case below, which gets a different title from the same icon element.
    expect(screen.getByTitle(/low grounding/i)).toBeInTheDocument();
  });

  it('renders BOTH the flagged icon and the full action badge text when a row is flagged and reuses an existing item -- neither clips the other', () => {
    // Regression guard, two bugs deep on this same cell:
    // 1. The flagged signal used to render as a right-aligned text chip
    //    ("⚠ Review") in the Status track, sharing it with ActionBadge --
    //    whenever the combined width exceeded the track, its LEFT edge
    //    (the ⚠ glyph and the pill's rounded corner) clipped off, confirmed
    //    live. Replaced with a fixed-size icon for exactly this reason.
    // 2. The icon was then moved INTO the Status track (still sharing it
    //    with ActionBadge) -- confirmed live this doesn't clip, but
    //    useStatusColumnWidth measures one GLOBAL width from every row's
    //    action label, so reserving icon space there widened the Status
    //    column for every row, including unflagged ones, producing a
    //    visible gap before "New" on rows with no icon at all. The icon
    //    belongs in the Flags/Signals track instead (see that cell's own
    //    comment in DiffTree.tsx) -- a per-item quality signal, not part of
    //    what Confirm will do with the item, and a track ActionBadge never
    //    shares width with.
    const entries: DryRunDiffEntry[] = [
      { localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Epic 1', description: '', action: 'create', customerId: null },
      { localId: 'f1', parentLocalId: 'e1', type: 'Feature', title: 'Feature 1', description: '', action: 'create', customerId: null },
      {
        localId: 'r1',
        parentLocalId: 'f1',
        type: 'Requirement',
        title: 'Flagged reused req',
        description: '',
        action: 'reuse',
        existingAdoId: 12345,
        customerId: null,
        groundingScore: 0.1,
      },
    ];
    render(<DiffTree entries={entries} selectedId={null} onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /expand feature 1/i }));

    const row = screen.getByText('Flagged reused req').closest('[role="row"], div')?.parentElement as HTMLElement;
    // The flagged icon (title carries the reason) and the action badge's
    // full, untruncated text both present in the same row -- not a clipped
    // fragment of either.
    const flagIcon = within(row).getByTitle(/low grounding/i);
    const statusChip = within(row).getByText('Links to WI-12345');
    expect(flagIcon).toBeInTheDocument();
    expect(statusChip).toBeInTheDocument();
    // The two are in DIFFERENT top-level grid cells (Status vs Flags) --
    // sharing one is what forced the global Status-column-width regression
    // above.
    const cells = Array.from(row.children);
    const statusCellIndex = cells.findIndex((c) => c.contains(statusChip));
    const flagsCellIndex = cells.findIndex((c) => c.contains(flagIcon));
    expect(statusCellIndex).toBeGreaterThanOrEqual(0);
    expect(flagsCellIndex).toBeGreaterThanOrEqual(0);
    expect(statusCellIndex).not.toBe(flagsCellIndex);
  });

  it('shows a review chip on a low-confidence row with otherwise healthy scores', () => {
    // SWEEP.md section 7: the whole point of the UX decision -- low
    // confidence reuses the EXISTING review chip rather than getting its
    // own badge.
    const entries: DryRunDiffEntry[] = [
      { localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Epic 1', description: '', action: 'create', customerId: null },
      { localId: 'f1', parentLocalId: 'e1', type: 'Feature', title: 'Feature 1', description: '', action: 'create', customerId: null },
      { localId: 'r1', parentLocalId: 'f1', type: 'Requirement', title: 'Unsure req', description: '', action: 'create', customerId: null, groundingScore: 0.9, qualityScore: 95, qualityConfidence: 'low' },
    ];
    render(<DiffTree entries={entries} selectedId={null} onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /expand feature 1/i }));

    const row = screen.getByText('Unsure req').closest('[role="row"], div')?.parentElement as HTMLElement;
    // Grounding and quality are both healthy here -- the icon's title must
    // name the confidence-specific reason, not the low-grounding/low-quality
    // wording the other flagged case gets from the same icon element.
    expect(within(row).getByTitle(/model was unsure/i)).toBeInTheDocument();
  });

  it('filterFlaggedOnly shows only flagged entries, hiding unflagged rows including ancestors', () => {
    const entries: DryRunDiffEntry[] = [
      { localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Epic 1', description: '', action: 'create', customerId: null },
      { localId: 'f1', parentLocalId: 'e1', type: 'Feature', title: 'Feature 1', description: '', action: 'create', customerId: null },
      { localId: 'r1', parentLocalId: 'f1', type: 'Requirement', title: 'Flagged req', description: '', action: 'create', customerId: null, groundingScore: 0.1 },
      { localId: 'r2', parentLocalId: 'f1', type: 'Requirement', title: 'Healthy req', description: '', action: 'create', customerId: null, groundingScore: 0.9 },
    ];
    render(
      <DiffTree
        entries={entries}
        selectedId={null}
        onSelect={() => {}}
        filterAction={null}
        filterText=""
        filterFlaggedOnly
        onToggleExclude={() => {}}
      />,
    );

    expect(screen.getByText('Flagged req')).toBeInTheDocument();
    expect(screen.queryByText('Healthy req')).not.toBeInTheDocument();
    // Ancestors are unflagged themselves -- the filter hides them too,
    // it does not expand a collapsed-but-matching subtree into view.
    expect(screen.queryByText('Epic 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Feature 1')).not.toBeInTheDocument();
  });

  describe('warning focus', () => {
    const FOCUS_ENTRIES: DryRunDiffEntry[] = [
      { localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Epic 1', description: '', action: 'create', customerId: null },
      { localId: 'f1', parentLocalId: 'e1', type: 'Feature', title: 'Feature 1', description: '', action: 'create', customerId: null },
      { localId: 'r1', parentLocalId: 'f1', type: 'Requirement', title: 'Affected req', description: '', action: 'create', customerId: null },
      { localId: 'r2', parentLocalId: 'f1', type: 'Requirement', title: 'Unaffected req', description: '', action: 'create', customerId: null },
    ];

    it('focusNodeIds shows only the focused items, even under a collapsed ancestor', () => {
      render(
        <DiffTree
          entries={FOCUS_ENTRIES}
          selectedId={null}
          onSelect={() => {}}
          filterAction={null}
          filterText=""
          focusNodeIds={new Set(['r1'])}
          onToggleExclude={() => {}}
        />,
      );

      // Features start collapsed, but a filter in progress auto-expands.
      expect(screen.getByText('Affected req')).toBeInTheDocument();
      expect(screen.queryByText('Unaffected req')).not.toBeInTheDocument();
      expect(screen.queryByText('Feature 1')).not.toBeInTheDocument();
    });

    it('shows each focused row\'s reason as a chip, and no chip on any row when nothing is focused', () => {
      const { rerender } = render(
        <DiffTree
          entries={FOCUS_ENTRIES}
          selectedId={null}
          onSelect={() => {}}
          filterAction={null}
          filterText=""
          focusNodeIds={new Set(['r1'])}
          reasonByLocalId={{ r1: { chip: 'Original wording', tip: 'Text enhancement failed.', group: 'info' } }}
          onToggleExclude={() => {}}
        />,
      );
      expect(screen.getByText('Original wording')).toBeInTheDocument();

      rerender(
        <DiffTree entries={FOCUS_ENTRIES} selectedId={null} onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />,
      );
      expect(screen.queryByText('Original wording')).not.toBeInTheDocument();
    });
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

  // Real gap this closes (user-reported): "collapse/expand an Epic jumps
  // the viewport to another item below". Root cause was this same
  // scroll-into-view effect re-firing on every `rows` identity change --
  // and `rows` changes identity on EVERY collapse/expand toggle (collapsed
  // state is one of its own memo deps), not just on a real selection
  // change. Collapsing "Root Epic" here only hides "Child Feature";
  // "orphan1" (the selected row) stays visible throughout, so a fixed
  // implementation must not re-scroll to it at all.
  it('does not re-scroll to the already-selected row when an unrelated node is collapsed', async () => {
    render(
      <DiffTree entries={ENTRIES} selectedId="orphan1" onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />,
    );
    scrollToItem.mockClear(); // isolate from the initial-mount scroll

    await userEvent.click(screen.getByRole('button', { name: /collapse root epic/i }));

    expect(screen.queryByText('Child Feature')).not.toBeInTheDocument(); // the collapse itself did happen
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

  it('shows a compact table-count badge when tableIds is present', () => {
    const entries: DryRunDiffEntry[] = [{ ...baseEntry, tableIds: ['t3', 't7'] }];

    render(<DiffTree entries={entries} selectedId={null} onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);

    expect(screen.getByTitle('2 table(s)')).toBeInTheDocument();
  });

  it('shows a single combined figure-count badge (captioned + uncaptioned), neutral-tinted when every figure has a caption', () => {
    const entries: DryRunDiffEntry[] = [{ ...baseEntry, figureIds: ['f0', 'f1'] }];

    render(<DiffTree entries={entries} selectedId={null} onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);

    const badge = screen.getByTitle('2 figure(s)');
    expect(badge).toBeInTheDocument();
    expect(badge.className).not.toContain('text-warning');
  });

  it('tints the figure-count badge amber and gives a breakdown tooltip when at least one figure is uncaptioned', () => {
    const entries: DryRunDiffEntry[] = [{ ...baseEntry, figureIds: ['f0'], uncaptionedFigureIds: ['f1'] }];

    render(<DiffTree entries={entries} selectedId={null} onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);

    const badge = screen.getByTitle('2 figure(s), 1 without a description');
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain('text-warning');
  });

  it('excludes insignificant figures from the figure-count badge -- they are hidden from the item detail view entirely, so counting them here would overstate what a reviewer can actually find', () => {
    const entries: DryRunDiffEntry[] = [
      { ...baseEntry, figureIds: ['f0'], uncaptionedFigureIds: ['f1', 'f2', 'f3'], insignificantFigureIds: ['f2', 'f3'] },
    ];

    render(<DiffTree entries={entries} selectedId={null} onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);

    // 1 captioned (f0) + 1 genuinely-uncaptioned (f1) = 2, NOT 4 (which
    // would include the 2 insignificant figures nobody will ever see).
    const badge = screen.getByTitle('2 figure(s), 1 without a description');
    expect(badge).toBeInTheDocument();
  });

  it('hides the figure-count badge entirely when every uncaptioned figure is insignificant and none are captioned', () => {
    const entries: DryRunDiffEntry[] = [
      { ...baseEntry, uncaptionedFigureIds: ['f1', 'f2'], insignificantFigureIds: ['f1', 'f2'] },
    ];

    render(<DiffTree entries={entries} selectedId={null} onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);

    expect(screen.queryByTitle(/figure\(s\)/)).not.toBeInTheDocument();
  });

  it('shows no table/figure badges when neither tableIds nor figureIds/uncaptionedFigureIds is present', () => {
    render(<DiffTree entries={[baseEntry]} selectedId={null} onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);

    expect(screen.queryByTitle(/table\(s\)/)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/figure\(s\)/)).not.toBeInTheDocument();
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

// DESIGN.md §11.5 -- reparent/reorder via @dnd-kit/core.
const MOVE_ENTRIES: DryRunDiffEntry[] = [
  { localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Epic 1', description: '', action: 'create', customerId: null },
  { localId: 'e2', parentLocalId: null, type: 'Epic', title: 'Epic 2', description: '', action: 'create', customerId: null },
  { localId: 'f1', parentLocalId: 'e1', type: 'Feature', title: 'Feature 1', description: '', action: 'create', customerId: null },
  { localId: 'f2', parentLocalId: 'e1', type: 'Feature', title: 'Feature 2', description: '', action: 'create', customerId: null },
  { localId: 'r1', parentLocalId: 'f1', type: 'Requirement', title: 'Req 1', description: '', action: 'create', customerId: null },
];

// Matches buildFlatRows' real visual order for MOVE_ENTRIES (see the
// itemKey test below): e1, f1, r1, f2, e2. Stubs every row's rect at its
// real stacked position (ROW_HEIGHT=40 apart) -- @dnd-kit/core's
// closestCenter collision detection needs the SOURCE row's rect (its
// initial, pre-drag position) as well as every candidate droppable's, not
// just the one row native HTML5 drag's own offset math used.
function stubMoveEntryRects(): void {
  stubRowRect(rowFor('Epic 1'), 0);
  stubRowRect(rowFor('Feature 1'), 40);
  stubRowRect(rowFor('Req 1'), 80);
  stubRowRect(rowFor('Feature 2'), 120);
  stubRowRect(rowFor('Epic 2'), 160);
}

describe('DiffTree drag-and-drop (reparent/reorder)', () => {
  beforeEach(async () => {
    itemKeyCalls.length = 0;
    // A completed real drag in an EARLIER test schedules a document-level
    // click-stopPropagation listener that @dnd-kit/core's own detach() only
    // removes 50ms later (see the "does not swallow a click on an
    // UNRELATED row" test's own comment on this same mechanism) -- and
    // jsdom's `document` is shared across every test in this file, not
    // reset per test. Several tests in this block now click a Feature's
    // own expand toggle (Feature starts collapsed by default) as their
    // FIRST interaction, which otherwise risks landing inside a still-live
    // leftover window from the previous test's drag and being silently
    // swallowed. Waiting it out here, once per test, keeps every test's
    // assertions about ITS OWN click from depending on dnd-kit's internal
    // cleanup timing.
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  it('does not render draggable rows or the grip column when canMove is false/omitted', () => {
    render(
      <DiffTree entries={MOVE_ENTRIES} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />,
    );
    // canMove omitted -> useDraggable's attributes are never spread at all.
    expect(rowFor('Epic 1')).not.toHaveAttribute('aria-roledescription');
    // Epic 1 has children, so a chevron <svg> legitimately renders --
    // check specifically for the grip's own title, not "any svg".
    expect(rowFor('Epic 1').querySelector('[title="Drag to move"]')).toBeNull();
  });

  it('renders draggable rows when canMove is true', () => {
    render(
      <DiffTree
        entries={MOVE_ENTRIES}
        selectedId={null}
        onSelect={vi.fn()}
        filterAction={null}
        filterText=""
        onToggleExclude={vi.fn()}
        canMove
        onMove={vi.fn()}
      />,
    );
    // @dnd-kit/core's useDraggable attributes, not a native draggable="true"
    // -- see the module comment on computeDropPosition for why this
    // replaced native HTML5 DnD.
    expect(rowFor('Epic 1')).toHaveAttribute('aria-roledescription', 'draggable');
  });

  // Real bug this guarded against under native HTML5 drag (kept as a
  // regression test -- harmless, and still true, under @dnd-kit/core):
  // dragging over selectable text without opting out of selection first is
  // unreliable in some browsers. select-none costs nothing to keep.
  it('disables text selection on draggable rows (select-none)', () => {
    render(
      <DiffTree entries={MOVE_ENTRIES} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} canMove onMove={vi.fn()} />,
    );
    expect(rowFor('Epic 1').className).toContain('select-none');
  });

  it('does not disable text selection when canMove is false -- rows are read-only, not draggable', () => {
    render(
      <DiffTree entries={MOVE_ENTRIES} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />,
    );
    expect(rowFor('Epic 1').className).not.toContain('select-none');
  });

  it('reparents on a valid drop in the middle of a target row (inside)', () => {
    const onMove = vi.fn();
    render(
      <DiffTree
        entries={MOVE_ENTRIES}
        selectedId={null}
        onSelect={vi.fn()}
        filterAction={null}
        filterText=""
        onToggleExclude={vi.fn()}
        canMove
        onMove={onMove}
      />,
    );
    // Feature 1 starts collapsed by default -- expand it so Req 1 (used by
    // stubMoveEntryRects' own row-position stubbing) actually renders.
    fireEvent.click(screen.getByRole('button', { name: /expand feature 1/i }));
    stubMoveEntryRects();
    const source = rowFor('Feature 1'); // top=40, center=60
    // Feature 1's center (60) moved to Epic 2's own center (top=160,
    // height=40 -> center=180) -> dead center of the target -> 'inside'.
    dragRow(source, { fromY: 0, toY: 180 - 60 });

    expect(onMove).toHaveBeenCalledWith('f1', { parentLocalId: 'e2' });
  });

  it('reorders (before) when dropped in the top quarter of a sibling row', () => {
    const onMove = vi.fn();
    render(
      <DiffTree
        entries={MOVE_ENTRIES}
        selectedId={null}
        onSelect={vi.fn()}
        filterAction={null}
        filterText=""
        onToggleExclude={vi.fn()}
        canMove
        onMove={onMove}
      />,
    );
    // Feature 1 starts collapsed by default -- expand it so Req 1 (used by
    // stubMoveEntryRects' own row-position stubbing) actually renders.
    fireEvent.click(screen.getByRole('button', { name: /expand feature 1/i }));
    stubMoveEntryRects();
    const source = rowFor('Feature 2'); // top=120, center=140
    // Feature 2's center (140) moved to y=42 -- Feature 1 spans
    // top=40..80, so 42 sits at relative 0.05 of its height -> 'before'.
    dragRow(source, { fromY: 0, toY: 42 - 140 });

    expect(onMove).toHaveBeenCalledWith('f2', { parentLocalId: 'e1', anchorLocalId: 'f1', placement: 'before' });
  });

  it('rejects a tier violation client-side -- no onMove call', () => {
    const onMove = vi.fn();
    render(
      <DiffTree
        entries={MOVE_ENTRIES}
        selectedId={null}
        onSelect={vi.fn()}
        filterAction={null}
        filterText=""
        onToggleExclude={vi.fn()}
        canMove
        onMove={onMove}
      />,
    );
    // Feature 1 starts collapsed by default -- expand it so Req 1 (the drop
    // target this test needs) actually renders.
    fireEvent.click(screen.getByRole('button', { name: /expand feature 1/i }));
    stubMoveEntryRects();
    const source = rowFor('Epic 1'); // Epic cannot nest under a Requirement, top=0, center=20
    // Req 1 spans top=80..120 -> center=100.
    dragRow(source, { fromY: 0, toY: 100 - 20 });

    expect(onMove).not.toHaveBeenCalled();
  });

  it('rejects moving a node into its own descendant -- no onMove call', () => {
    const onMove = vi.fn();
    render(
      <DiffTree
        entries={MOVE_ENTRIES}
        selectedId={null}
        onSelect={vi.fn()}
        filterAction={null}
        filterText=""
        onToggleExclude={vi.fn()}
        canMove
        onMove={onMove}
      />,
    );
    // Feature 1 starts collapsed by default -- expand it so Req 1 (the
    // descendant this test drags onto) actually renders.
    fireEvent.click(screen.getByRole('button', { name: /expand feature 1/i }));
    stubMoveEntryRects();
    const source = rowFor('Epic 1'); // top=0, center=20
    // Req 1 (top=80..120, center=100) is a descendant of Epic 1 via Feature 1.
    dragRow(source, { fromY: 0, toY: 100 - 20 });

    expect(onMove).not.toHaveBeenCalled();
  });

  it('does not open the details dialog after a completed drag-drop', () => {
    const onMove = vi.fn();
    const onOpenDetails = vi.fn();
    render(
      <DiffTree
        entries={MOVE_ENTRIES}
        selectedId={null}
        onSelect={vi.fn()}
        onOpenDetails={onOpenDetails}
        filterAction={null}
        filterText=""
        onToggleExclude={vi.fn()}
        canMove
        onMove={onMove}
      />,
    );
    // Feature 1 starts collapsed by default -- expand it so Req 1 (used by
    // stubMoveEntryRects' own row-position stubbing) actually renders.
    fireEvent.click(screen.getByRole('button', { name: /expand feature 1/i }));
    stubMoveEntryRects();
    const source = rowFor('Feature 1'); // top=40, center=60
    dragRow(source, { fromY: 0, toY: 180 - 60 }); // onto Epic 2's center -> 'inside'
    // A completed cross-row drag does not naturally fire a click in a real
    // browser (mousedown/mouseup land on different elements), and
    // @dnd-kit/core's own MouseSensor (via the shared AbstractPointerSensor
    // base class both it and PointerSensor extend) additionally swallows a
    // trailing click once a real drag has activated -- this asserts the
    // row's own defensive guard on top of that, by firing one anyway.
    fireEvent.click(rowFor('Epic 2'));

    expect(onOpenDetails).not.toHaveBeenCalled();
  });

  // CR: reparent review fix -- the drag-completion click guard was
  // previously a single shared boolean, not scoped to the dropped-on row.
  // That meant the NEXT click on ANY row anywhere in the tree (not just
  // the one that received the drop) was silently swallowed -- a reviewer
  // dragging an item, then clicking a completely different row to inspect
  // it, would find the first click did nothing.
  it('does not swallow a click on an UNRELATED row after a completed drag-drop elsewhere', async () => {
    const onSelect = vi.fn();
    const onOpenDetails = vi.fn();
    render(
      <DiffTree
        entries={MOVE_ENTRIES}
        selectedId={null}
        onSelect={onSelect}
        onOpenDetails={onOpenDetails}
        filterAction={null}
        filterText=""
        onToggleExclude={vi.fn()}
        canMove
        onMove={vi.fn()}
      />,
    );
    // Feature 1 starts collapsed by default -- expand it so Req 1 (the
    // unrelated row clicked below) actually renders.
    fireEvent.click(screen.getByRole('button', { name: /expand feature 1/i }));
    stubMoveEntryRects();
    const source = rowFor('Feature 1'); // top=40, center=60
    dragRow(source, { fromY: 0, toY: 180 - 60 }); // onto Epic 2's center -> 'inside'

    // @dnd-kit/core's own MouseSensor additionally installs a document-level
    // capture-phase click suppressor for ~50ms after a real drag activates
    // (its own fix for the same "drag ends, browser still fires a trailing
    // click" problem this row's justCompletedDragRef guards against) --
    // waiting it out here isolates THIS test to this row's own guard,
    // rather than asserting on dnd-kit's internal timing.
    await new Promise((resolve) => setTimeout(resolve, 60));

    // A click on a DIFFERENT row (not the one the drop landed on) right
    // after the drag must behave like a normal click.
    fireEvent.click(rowFor('Req 1'));

    expect(onSelect).toHaveBeenCalledWith('r1');
    expect(onOpenDetails).toHaveBeenCalledWith('r1');
  });

  it('uses localId (not row index) as the FixedSizeList itemKey', () => {
    render(
      <DiffTree entries={MOVE_ENTRIES} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} canMove onMove={vi.fn()} />,
    );
    // Feature 1 starts collapsed by default -- expand it so Req 1 renders
    // (this test asserts on its real visual-order itemKey). Clear the calls
    // recorded by the pre-expand mount renders first, so the dedup below
    // reflects only the fully-expanded order, not the initial collapsed one.
    itemKeyCalls.length = 0;
    fireEvent.click(screen.getByRole('button', { name: /expand feature 1/i }));
    // useContainerHeight's mount effect calls setHeight once (jsdom's
    // getBoundingClientRect always reports 0), so the list legitimately
    // renders twice -- dedupe rather than assert an exact render count,
    // which isn't what this test is about.
    expect(Array.from(new Set(itemKeyCalls))).toEqual(['e1', 'f1', 'r1', 'f2', 'e2']);
  });

  it('shows a "same tier" badge when a node\'s parent shares its own category', () => {
    const sameTier = [...MOVE_ENTRIES, { localId: 'e3', parentLocalId: 'e1', type: 'Epic', title: 'Epic 3', description: '', action: 'create' as const, customerId: null }];
    render(<DiffTree entries={sameTier} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />);

    expect(screen.getByText('same tier')).toBeInTheDocument();
  });

  it('does not show a "same tier" badge when the parent is a different category', () => {
    render(<DiffTree entries={MOVE_ENTRIES} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />);

    expect(screen.queryByText('same tier')).not.toBeInTheDocument();
  });

  it('warns when a non-excluded node has an excluded ancestor', () => {
    const withExcludedAncestor = MOVE_ENTRIES.map((entry) => (entry.localId === 'e1' ? { ...entry, excluded: true } : entry));
    render(
      <DiffTree entries={withExcludedAncestor} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />,
    );
    // Feature 1 starts collapsed by default -- expand it so r1 (one of the
    // three descendants this test counts) actually renders.
    fireEvent.click(screen.getByRole('button', { name: /expand feature 1/i }));

    // f1/f2/r1 are all descendants of the excluded e1 -- each gets the warning.
    expect(screen.getAllByTitle(/ancestor of this item is excluded/i)).toHaveLength(3);
  });

  it('does not warn on the excluded node itself (only its non-excluded descendants)', () => {
    const withExcludedAncestor = MOVE_ENTRIES.map((entry) => (entry.localId === 'e1' ? { ...entry, excluded: true } : entry));
    render(
      <DiffTree entries={withExcludedAncestor} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />,
    );

    expect(rowFor('Epic 1').querySelector('[title*="ancestor of this item is excluded"]')).toBeNull();
  });

  // Investigation finding: dragging a reuse/dedup_skip row to a new parent
  // persists with the same accepted-move feedback as any other row, but
  // confirm() never actually re-parents it in ADO (JobsService's toLink
  // filter). Nothing previously told a reviewer that -- this badge does.
  it('shows an "already in ADO" badge on a reuse-matched row, naming its real WI id', () => {
    const reuseEntries = [{ ...MOVE_ENTRIES[0] }, { ...MOVE_ENTRIES[2], action: 'reuse' as const, existingAdoId: 777 }];
    render(<DiffTree entries={reuseEntries} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />);

    expect(rowFor('Feature 1').querySelector('[title*="Already exists in ADO as WI-777"]')).not.toBeNull();
  });

  it('shows an "already in ADO" badge on a dedup_skip row, worded as a probable match rather than a certainty', () => {
    const dedupEntries = [{ ...MOVE_ENTRIES[0] }, { ...MOVE_ENTRIES[2], action: 'dedup_skip' as const, existingAdoId: 888 }];
    render(<DiffTree entries={dedupEntries} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />);

    expect(rowFor('Feature 1').querySelector('[title*="Matched to a probable duplicate in ADO (WI-888)"]')).not.toBeNull();
  });

  it('does not show the "already in ADO" badge on a create row', () => {
    render(<DiffTree entries={MOVE_ENTRIES} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" onToggleExclude={vi.fn()} />);

    expect(rowFor('Feature 1').querySelector('[title*="Already exists in ADO"]')).toBeNull();
    expect(rowFor('Feature 1').querySelector('[title*="Matched to a probable duplicate"]')).toBeNull();
  });
});
