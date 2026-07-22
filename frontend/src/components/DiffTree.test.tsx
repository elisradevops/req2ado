import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DiffTree } from './DiffTree';
import type { DryRunDiffEntry } from './DiffTree';

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

  it('renders a row with a long title and multiple chips without crashing (variable row-height measurement)', () => {
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

describe('DiffTree trace link chips', () => {
  it('renders a resolved trace link chip with its display name and target', () => {
    const entries: DryRunDiffEntry[] = [
      {
        ...baseEntry,
        traceLinks: [
          { sourceLocalId: 'n0', referenceName: 'Elisra.CoveredBy-Forward', displayName: 'Covered by', targetKind: 'crossJob', targetCustomerId: 'REQ-SYS-012', resolvedAdoId: 555, resolutionStatus: 'resolved' },
        ],
      },
    ];

    render(<DiffTree entries={entries} selectedId={null} onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);

    expect(screen.getByText(/Covered by/i)).toBeInTheDocument();
  });

  it('renders an unresolved trace link chip distinctly', () => {
    const entries: DryRunDiffEntry[] = [
      {
        ...baseEntry,
        traceLinks: [
          { sourceLocalId: 'n0', referenceName: 'Elisra.CoveredBy-Forward', displayName: 'Covered by', targetKind: 'crossJob', targetCustomerId: 'REQ-MISSING', resolutionStatus: 'unresolved' },
        ],
      },
    ];

    render(<DiffTree entries={entries} selectedId={null} onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);

    const chip = screen.getByText(/Covered by/i);
    expect(chip.closest('[data-resolution-status]')).toHaveAttribute('data-resolution-status', 'unresolved');
  });
});
