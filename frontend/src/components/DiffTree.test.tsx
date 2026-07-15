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
});
