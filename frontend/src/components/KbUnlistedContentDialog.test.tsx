import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError } from 'axios';
import * as kbApi from '../api/kb';
import { KbUnlistedContentDialog } from './KbUnlistedContentDialog';

vi.mock('../api/kb');

const found: kbApi.KbReconcileResult = {
  dryRun: true,
  orphans: [
    { sourceId: 'item-old', fileNames: ['spec.docx'], chunks: 5 },
    { sourceId: null, fileNames: [], chunks: 3 },
  ],
  removed: 0,
  failed: [],
};

function renderDialog(onOpenChange = vi.fn()) {
  render(<KbUnlistedContentDialog open onOpenChange={onOpenChange} />);
  return onOpenChange;
}

describe('KbUnlistedContentDialog', () => {
  beforeEach(() => {
    vi.mocked(kbApi.reconcileKbOrphans).mockReset();
  });

  it('checks when opened without removing anything, and says so when nothing is unlisted', async () => {
    vi.mocked(kbApi.reconcileKbOrphans).mockResolvedValue({ dryRun: true, orphans: [], removed: 0, failed: [] });
    renderDialog();

    expect(await screen.findByText(/nothing unlisted found/i)).toBeInTheDocument();
    expect(kbApi.reconcileKbOrphans).toHaveBeenCalledTimes(1);
    expect(kbApi.reconcileKbOrphans).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('button', { name: /^remove/i })).not.toBeInTheDocument();
  });

  it('lists what it found with chunk counts, and removes nothing until the button is pressed', async () => {
    vi.mocked(kbApi.reconcileKbOrphans).mockResolvedValue(found);
    renderDialog();

    const list = await screen.findByRole('list', { name: 'Unlisted content' });
    expect(list).toHaveTextContent('spec.docx');
    expect(list).toHaveTextContent('5 chunks');
    expect(list).toHaveTextContent('Content with no file name recorded');
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(kbApi.reconcileKbOrphans).toHaveBeenCalledTimes(1);
    expect(kbApi.reconcileKbOrphans).not.toHaveBeenCalledWith(false);
  });

  it('removes on confirmation and reports how many were removed', async () => {
    vi.mocked(kbApi.reconcileKbOrphans).mockResolvedValueOnce(found).mockResolvedValueOnce({ ...found, dryRun: false, removed: 2 });
    renderDialog();

    await userEvent.click(await screen.findByRole('button', { name: 'Remove 2 items' }));

    expect(await screen.findByText('Removed 2 items.')).toBeInTheDocument();
    expect(kbApi.reconcileKbOrphans).toHaveBeenLastCalledWith(false);
  });

  it('names what could not be removed instead of hiding it', async () => {
    vi.mocked(kbApi.reconcileKbOrphans)
      .mockResolvedValueOnce(found)
      .mockResolvedValueOnce({ dryRun: false, orphans: found.orphans, removed: 1, failed: [{ sourceId: 'item-old', fileNames: ['spec.docx'] }] });
    renderDialog();

    await userEvent.click(await screen.findByRole('button', { name: 'Remove 2 items' }));

    expect(await screen.findByText('Removed 1 item.')).toBeInTheDocument();
    expect(screen.getByText(/1 item could not be removed/i)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Unlisted content' })).toHaveTextContent('spec.docx');
  });

  it('explains a refusal while files are still being added, in words', async () => {
    vi.mocked(kbApi.reconcileKbOrphans).mockRejectedValue(
      new AxiosError('conflict', 'ERR_BAD_REQUEST', undefined, undefined, { status: 409, data: { code: 'kb_batch_active' } } as never),
    );
    renderDialog();

    expect(await screen.findByText(/files are still being added/i)).toBeInTheDocument();
  });

  it('says the check failed when the request fails, and lets a failed removal be tried again', async () => {
    vi.mocked(kbApi.reconcileKbOrphans).mockRejectedValueOnce(new Error('down'));
    const { unmount } = render(<KbUnlistedContentDialog open onOpenChange={vi.fn()} />);
    expect(await screen.findByText(/couldn't check the knowledge base/i)).toBeInTheDocument();
    unmount();

    vi.mocked(kbApi.reconcileKbOrphans).mockResolvedValueOnce(found).mockRejectedValueOnce(new Error('down'));
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove 2 items' }));
    expect(await screen.findByText(/couldn't remove everything/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument());
  });

  it('cannot be closed while it is working', async () => {
    let finish: (value: kbApi.KbReconcileResult) => void = () => undefined;
    vi.mocked(kbApi.reconcileKbOrphans).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const onOpenChange = renderDialog();

    expect(await screen.findByText(/checking/i)).toBeInTheDocument();
    // Two buttons are named Close: the dialog's own X and the footer button. Neither may close it mid-request.
    const [cornerX, footerClose] = screen.getAllByRole('button', { name: 'Close' });
    expect(footerClose).toBeDisabled();
    await userEvent.click(cornerX);
    expect(onOpenChange).not.toHaveBeenCalled();
    finish({ dryRun: true, orphans: [], removed: 0, failed: [] });
    await screen.findByText(/nothing unlisted found/i);
  });
});
