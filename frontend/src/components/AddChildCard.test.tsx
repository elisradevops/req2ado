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
  it('renders nothing for a manually-added parent', () => {
    const { container } = render(<AddChildCard parentEntry={{ ...PARENT, isManual: true }} jobMode="baseline" onAdd={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is collapsed by default -- the form is not rendered until expanded', () => {
    render(<AddChildCard parentEntry={PARENT} jobMode="baseline" onAdd={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^add direct child wi$/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/title/i)).not.toBeInTheDocument();
  });

  it('expands to show the form on click, and calls onAdd + collapses again on submit', async () => {
    const onAdd = vi.fn();
    render(<AddChildCard parentEntry={PARENT} jobMode="baseline" onAdd={onAdd} />);

    await userEvent.click(screen.getByRole('button', { name: /^add direct child wi$/i }));
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/title/i), 'New Req');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(onAdd).toHaveBeenCalledWith({ type: 'Requirement', title: 'New Req', description: '' });
    expect(screen.queryByLabelText(/title/i)).not.toBeInTheDocument();
  });

  it('swaps to a cancel affordance while expanded, and collapses the form on click', async () => {
    render(<AddChildCard parentEntry={PARENT} jobMode="baseline" onAdd={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /^add direct child wi$/i }));
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByLabelText(/title/i)).not.toBeInTheDocument();
  });

  it('collapses back to the header when the parentEntry changes', async () => {
    const { rerender } = render(<AddChildCard parentEntry={PARENT} jobMode="baseline" onAdd={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^add direct child wi$/i }));
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();

    const otherParent: DryRunDiffEntry = { ...PARENT, localId: 'n1' };
    rerender(<AddChildCard parentEntry={otherParent} jobMode="baseline" onAdd={vi.fn()} />);
    expect(screen.queryByLabelText(/title/i)).not.toBeInTheDocument();
  });
});
