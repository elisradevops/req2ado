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
    render(<DiffTree entries={ENTRIES} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="" />);
    expect(screen.getByText('Root Epic')).toBeInTheDocument();
    expect(screen.getByText('Child Feature')).toBeInTheDocument();
    expect(screen.getByText('Orphan Req')).toBeInTheDocument();
  });

  it('calls onSelect with the localId when a row is clicked', async () => {
    const onSelect = vi.fn();
    render(<DiffTree entries={ENTRIES} selectedId={null} onSelect={onSelect} filterAction={null} filterText="" />);
    screen.getByText('Root Epic').click();
    expect(onSelect).toHaveBeenCalledWith('e1');
  });

  it('filters by text', () => {
    render(<DiffTree entries={ENTRIES} selectedId={null} onSelect={vi.fn()} filterAction={null} filterText="Orphan" />);
    expect(screen.getByText('Orphan Req')).toBeInTheDocument();
    expect(screen.queryByText('Root Epic')).not.toBeInTheDocument();
  });
});
