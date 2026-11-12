import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NodeDetailDialog } from './NodeDetailDialog';
import { ToastProvider } from './ToastProvider';
import type { DryRunDiffEntry } from './DiffTree';
import * as chatApi from '../api/chat';
import * as jobsApi from '../api/jobs';

vi.mock('../api/chat');
vi.mock('../api/jobs');
vi.mock('../hooks/useChatSocket', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useChatSocket')>('../hooks/useChatSocket');
  return { ...actual, useChatSocket: vi.fn() };
});

const SKIPPED: DryRunDiffEntry = {
  localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body',
  action: 'dedup_skip', existingAdoId: 123, similarity: 0.93, customerId: null, tags: [],
};

function renderDialog(entry: DryRunDiffEntry, props: Partial<React.ComponentProps<typeof NodeDetailDialog>> = {}) {
  const handlers = { onOverrideDuplicate: vi.fn().mockResolvedValue(undefined), onUndoDuplicateOverride: vi.fn().mockResolvedValue(undefined) };
  render(
    <ToastProvider>
      <NodeDetailDialog open onOpenChange={vi.fn()} jobId="job-1" entry={entry} jobStatus="diff_ready" orgUrl="https://dev.azure.com/org" project="Proj" onAddChild={vi.fn()} {...handlers} {...props} />
    </ToastProvider>,
  );
  return handlers;
}

describe('NodeDetailDialog: a skipped near-duplicate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chatApi.getChatHistory).mockResolvedValue([]);
    vi.mocked(chatApi.listModels).mockResolvedValue([]);
    vi.mocked(jobsApi.getFigureFile).mockResolvedValue(null);
  });

  it('says it already exists and links to the existing item', async () => {
    renderDialog(SKIPPED);

    expect(await screen.findByText(/already exists in azure devops/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /work item 123/i })).toHaveAttribute('href', 'https://dev.azure.com/org/Proj/_workitems/edit/123');
  });

  it('creating it as a new item reports this entry and the reviewer\'s choices', async () => {
    const { onOverrideDuplicate } = renderDialog(SKIPPED);
    await userEvent.click(await screen.findByRole('button', { name: /create as new item/i }));
    const confirm = await screen.findByRole('dialog', { name: /create as a new item/i });

    await userEvent.click(within(confirm).getByRole('button', { name: /^create as new item$/i }));

    await waitFor(() => expect(onOverrideDuplicate).toHaveBeenCalledWith('e1', { linkTree: true, relateToExisting: false }));
  });

  it('offers no way to change it once the job is not in review', async () => {
    renderDialog(SKIPPED, { jobStatus: 'succeeded' });

    await screen.findByText(/already exists in azure devops/i);
    expect(screen.queryByRole('button', { name: /create as new item/i })).toBeNull();
  });

  it('an item created anyway offers to undo it', async () => {
    const created: DryRunDiffEntry = {
      ...SKIPPED, action: 'create', existingAdoId: null, similarity: null,
      duplicateOf: { existingAdoId: 123, similarity: 0.93 }, duplicateOverride: { linkTree: true, relateToExisting: false },
    };
    const { onUndoDuplicateOverride } = renderDialog(created);

    await userEvent.click(await screen.findByRole('button', { name: /undo/i }));

    await waitFor(() => expect(onUndoDuplicateOverride).toHaveBeenCalledWith('e1'));
  });
});
