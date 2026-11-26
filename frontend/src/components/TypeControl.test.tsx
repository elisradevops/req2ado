import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TypeControl, allowedTypesFor } from './NodeDetailDialog';
import type { DryRunDiffEntry } from './DiffTree';

const entry = (localId: string, type: string, parentLocalId: string | null, extra: Partial<DryRunDiffEntry> = {}): DryRunDiffEntry =>
  ({ localId, type, parentLocalId, title: localId, description: '', action: 'create', ...extra }) as DryRunDiffEntry;

// An Epic holding a Feature that holds a requirement, and a Feature with nothing under it.
const tree = [entry('e1', 'Epic', null), entry('f1', 'Feature', 'e1'), entry('r1', 'Requirement', 'f1'), entry('f2', 'Feature', 'e1')];

describe('allowedTypesFor (the ladder, owner decision 2026-11-25)', () => {
  it('offers only the types the parent allows and that allow the items underneath', () => {
    expect(allowedTypesFor(tree[3], tree)).toEqual(['Epic', 'Feature']); // under an Epic, nothing under it
    expect(allowedTypesFor(tree[1], tree)).toEqual(['Feature']); // it holds a requirement: never an Epic
    expect(allowedTypesFor(tree[2], tree)).toEqual(['Feature', 'Requirement']); // under a Feature
    expect(allowedTypesFor(tree[0], tree)).toEqual(['Epic']); // the only root
  });
});

describe('TypeControl', () => {
  it('changes the type to one allowed here, and offers Undo back to the type it had', () => {
    const onChangeType = vi.fn();
    const { rerender } = render(<TypeControl entry={tree[3]} allEntries={tree} onChangeType={onChangeType} />);
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'Epic' } });
    expect(onChangeType).toHaveBeenCalledWith('f2', 'Epic');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    const retyped = entry('f2', 'Epic', 'e1', { retypedFrom: 'Feature' });
    rerender(<TypeControl entry={retyped} allEntries={[...tree.slice(0, 3), retyped]} onChangeType={onChangeType} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onChangeType).toHaveBeenLastCalledWith('f2', 'Feature');
  });

  it('shows nothing for an existing work item, or where only one type fits', () => {
    const { container, rerender } = render(<TypeControl entry={{ ...tree[3], action: 'reuse' }} allEntries={tree} onChangeType={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<TypeControl entry={tree[1]} allEntries={tree} onChangeType={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
