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
  it('is hidden when the entry has no discussion', () => {
    renderPanel(base);
    expect(screen.queryByText(/to be discussed/i)).not.toBeInTheDocument();
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
