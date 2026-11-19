import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NodeDetailPanel } from './NodeDetailPanel';
import { ToastProvider } from './ToastProvider';
import type { DryRunDiffEntry } from './DiffTree';

const base: DryRunDiffEntry = {
  localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req', description: 'The unit shall boot.', action: 'create', customerId: null,
};
const discussion = [
  { id: 'd1', proposedTitle: 'Better title', proposedDescription: 'Better **desc**', createdAt: '2026-11-02T10:00:00.000Z' },
  { id: 'd2', proposedDescription: 'Only a description', createdAt: '2026-11-02T11:00:00.000Z' },
];

function renderPanel(entry: DryRunDiffEntry, props: Partial<React.ComponentProps<typeof NodeDetailPanel>> = {}) {
  return render(
    <ToastProvider>
      <NodeDetailPanel entry={entry} jobStatus="diff_ready" {...props} />
    </ToastProvider>,
  );
}

describe('NodeDetailPanel discussion list', () => {
  it('is hidden when the entry has no discussion and notes cannot be added (a read-only view)', () => {
    renderPanel(base);
    expect(screen.queryByText(/to be discussed/i)).not.toBeInTheDocument();
  });

  it('is always there for a new item under review, with an empty state and a box to add a note', () => {
    renderPanel(base, { onAddDiscussion: vi.fn() });
    expect(screen.getByRole('region', { name: /to be discussed/i })).toBeInTheDocument();
    expect(screen.getByText('Nothing parked for this item yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to discussion' })).toBeInTheDocument();
  });

  it('adds the typed note as a description entry, clears the box, and ignores an empty note', async () => {
    const onAddDiscussion = vi.fn().mockResolvedValue(undefined);
    renderPanel(base, { onAddDiscussion });
    await userEvent.click(screen.getByRole('button', { name: 'Add to discussion' }));
    expect(onAddDiscussion).not.toHaveBeenCalled();
    const box = screen.getByLabelText('Add a question or note for the author');
    await userEvent.type(box, 'Please confirm the value of N.');
    await userEvent.click(screen.getByRole('button', { name: 'Add to discussion' }));
    expect(onAddDiscussion).toHaveBeenCalledWith('e1', { proposedDescription: 'Please confirm the value of N.' });
    await vi.waitFor(() => expect(box).toHaveValue(''));
  });

  it('does not clear the next item\'s draft when a save for the previous item finishes after stepping on', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onAddDiscussion = vi.fn().mockReturnValue(pending);
    const { rerender } = renderPanel(base, { onAddDiscussion });
    await userEvent.type(screen.getByLabelText('Add a question or note for the author'), 'for A');
    await userEvent.click(screen.getByRole('button', { name: 'Add to discussion' }));
    rerender(
      <ToastProvider>
        <NodeDetailPanel entry={{ ...base, localId: 'e2', title: 'Other' }} jobStatus="diff_ready" onAddDiscussion={onAddDiscussion} />
      </ToastProvider>,
    );
    const box = screen.getByLabelText('Add a question or note for the author');
    await userEvent.type(box, 'for B');
    finish();
    await vi.waitFor(() => expect(box).toHaveValue('for B'));
  });

  it('keeps the typed note when adding it fails', async () => {
    renderPanel(base, { onAddDiscussion: vi.fn().mockRejectedValue(new Error('refused')) });
    const box = screen.getByLabelText('Add a question or note for the author');
    await userEvent.type(box, 'Keep me');
    await userEvent.click(screen.getByRole('button', { name: 'Add to discussion' }));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Add to discussion' })).not.toHaveAttribute('aria-busy', 'true'));
    expect(box).toHaveValue('Keep me');
  });

  it('offers no box for an item that is not a new item or once the job left review', () => {
    const { unmount } = renderPanel({ ...base, action: 'reuse', existingAdoId: 5 }, { onAddDiscussion: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Add to discussion' })).not.toBeInTheDocument();
    unmount();
    renderPanel(base, { onAddDiscussion: vi.fn(), jobStatus: 'succeeded' });
    expect(screen.queryByRole('button', { name: 'Add to discussion' })).not.toBeInTheDocument();
  });

  it('lists each entry and removes one by id', async () => {
    const onRemoveDiscussion = vi.fn().mockResolvedValue(undefined);
    renderPanel({ ...base, discussion }, { onRemoveDiscussion });
    expect(screen.getByText(/to be discussed/i)).toBeInTheDocument();
    expect(screen.getByText('Better title')).toBeInTheDocument();
    expect(screen.getByText('Only a description')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: /remove from discussion/i });
    expect(buttons).toHaveLength(2);
    await userEvent.setup().click(buttons[0]);
    expect(onRemoveDiscussion).toHaveBeenCalledWith('e1', 'd1');
  });

  it('shows the entries but offers no delete once the entry is written or the job left review', () => {
    const { unmount } = renderPanel({ ...base, discussion }, { onRemoveDiscussion: vi.fn(), written: true });
    expect(screen.getByText('Better title')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove from discussion/i })).not.toBeInTheDocument();
    unmount();
    renderPanel({ ...base, discussion }, { onRemoveDiscussion: vi.fn(), jobStatus: 'succeeded' });
    expect(screen.queryByRole('button', { name: /remove from discussion/i })).not.toBeInTheDocument();
  });
});
