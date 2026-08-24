import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddChildCard } from './AddChildCard';
import type { DryRunDiffEntry } from './DiffTree';

const PARENT: DryRunDiffEntry = {
  localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd',
  action: 'create', customerId: null, tags: [], childType: 'Requirement',
};

describe('AddChildCard', () => {
  it('renders nothing for a manually-added parent in a BASELINE job', () => {
    const { container } = render(<AddChildCard parentEntry={{ ...PARENT, isManual: true }} jobMode="baseline" allEntries={[PARENT]} onAdd={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  // CR: reparent -- BASELINE mode still can't add a child under a manual
  // parent (its childType is always null), but SURVEY mode now can, since
  // AddChildForm's own parent field lets the user point elsewhere entirely.
  // This is the plan's own headline scenario: a manually-created Epic
  // housing orphaned Features.
  it('renders the trigger for a manually-added parent in a SURVEY job', () => {
    render(<AddChildCard parentEntry={{ ...PARENT, isManual: true }} jobMode="survey" allEntries={[PARENT]} onAdd={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^add direct child wi$/i })).toBeInTheDocument();
  });

  it('is collapsed by default -- the form is not rendered until expanded', () => {
    render(<AddChildCard parentEntry={PARENT} jobMode="baseline" allEntries={[PARENT]} onAdd={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^add direct child wi$/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/title/i)).not.toBeInTheDocument();
  });

  it('expands to show the form on click, and calls onAdd + collapses again on submit', async () => {
    const onAdd = vi.fn();
    render(<AddChildCard parentEntry={PARENT} jobMode="baseline" allEntries={[PARENT]} onAdd={onAdd} />);

    await userEvent.click(screen.getByRole('button', { name: /^add direct child wi$/i }));
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/title/i), 'New Req');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(onAdd).toHaveBeenCalledWith({ parentLocalId: 'n0', type: 'Requirement', title: 'New Req', description: '' });
    expect(screen.queryByLabelText(/title/i)).not.toBeInTheDocument();
  });

  it('swaps to a cancel affordance while expanded, and collapses the form on click', async () => {
    render(<AddChildCard parentEntry={PARENT} jobMode="baseline" allEntries={[PARENT]} onAdd={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /^add direct child wi$/i }));
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByLabelText(/title/i)).not.toBeInTheDocument();
  });

  it('collapses back to the header when the parentEntry changes', async () => {
    const { rerender } = render(<AddChildCard parentEntry={PARENT} jobMode="baseline" allEntries={[PARENT]} onAdd={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^add direct child wi$/i }));
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();

    const otherParent: DryRunDiffEntry = { ...PARENT, localId: 'n1' };
    rerender(<AddChildCard parentEntry={otherParent} jobMode="baseline" allEntries={[PARENT]} onAdd={vi.fn()} />);
    expect(screen.queryByLabelText(/title/i)).not.toBeInTheDocument();
  });
});

// CR: reparent -- the tree toolbar's "+ New item" entry point has no
// anchor node at all (JobDetail.tsx passes no parentEntry).
describe('AddChildCard (no parentEntry -- toolbar "New item")', () => {
  it('shows "New item" as the trigger label instead of "Add direct child WI"', () => {
    render(<AddChildCard jobMode="survey" allEntries={[]} onAdd={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^new item$/i })).toBeInTheDocument();
  });

  it('expands to the anchor-less form and calls onAdd with parentLocalId: null on submit', async () => {
    const onAdd = vi.fn();
    render(<AddChildCard jobMode="survey" allEntries={[]} onAdd={onAdd} />);

    await userEvent.click(screen.getByRole('button', { name: /^new item$/i }));
    await userEvent.type(screen.getByLabelText(/title/i), 'New Epic');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(onAdd).toHaveBeenCalledWith({ parentLocalId: null, type: 'Epic', title: 'New Epic', description: '' });
  });
});
