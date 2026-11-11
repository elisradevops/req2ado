import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KbIngestQueue } from './KbIngestQueue';
import type { KbIngestBatch, KbIngestBatchStatus, KbIngestItem, KbIngestItemState } from '../api/kb';

function item(n: number, state: KbIngestItemState, overrides: Partial<KbIngestItem> = {}): KbIngestItem {
  return {
    id: `i${n}`, ordinal: n, itemId: `item-${n}`, name: `file${n}.pdf`, relativePath: `file${n}.pdf`, sizeBytes: 100, retrievalMode: 'retrieve', state,
    attempts: 0, errorKind: null, reason: null, chunksStored: null, chunksInStore: null, ingestedDocumentId: null, startedAt: null, finishedAt: null, ...overrides,
  };
}

function batch(status: KbIngestBatchStatus, items: KbIngestItem[], overrides: Partial<KbIngestBatch> = {}): KbIngestBatch {
  const count = (s: KbIngestItemState) => items.filter((i) => i.state === s).length;
  return {
    id: 'b1', status, pauseReason: null, cancelRequested: false, driveId: 'd', folderItemId: null, folderPath: '', docType: null, version: 1,
    createdAt: '2026-11-12T09:00:00Z', startedAt: null, finishedAt: ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(status) ? '2026-11-12T09:05:00Z' : null,
    counts: { total: items.length, queued: count('queued'), running: count('running'), added: count('added'), unchanged: count('unchanged'), failed: count('failed'), skipped: count('skipped'), cancelled: count('cancelled') },
    items, ...overrides,
  };
}

// The text a sighted user reads: the screen-reader status region repeats the headline on purpose, so it is left out.
const visibleText = (pattern: RegExp): HTMLElement => {
  const found = screen.getAllByText(pattern).filter((element) => element.getAttribute('role') !== 'status');
  expect(found).toHaveLength(1);
  return found[0];
};

function renderQueue(b: KbIngestBatch, props: Partial<React.ComponentProps<typeof KbIngestQueue>> = {}) {
  const handlers = { onCancel: vi.fn(), onRetryFailed: vi.fn(), onResume: vi.fn(), onDismiss: vi.fn(), onOpenReport: vi.fn() };
  render(<KbIngestQueue batch={b} error={null} busy={false} {...handlers} {...props} />);
  return handlers;
}

describe('KbIngestQueue', () => {
  describe('while it runs', () => {
    const running = () => batch('running', [item(1, 'added'), item(2, 'running'), item(3, 'queued'), item(4, 'queued')]);

    it('says how far it is, in words', () => {
      renderQueue(running());

      expect(screen.getByRole('heading', { name: /adding 2 of 4 files/i })).toBeInTheDocument();
    });

    it('shows a progress bar that names its reading', () => {
      renderQueue(running());

      const bar = screen.getByRole('progressbar');
      expect(bar).toHaveAccessibleName(/adding files to the knowledge base/i);
      expect(bar).toHaveAttribute('aria-valuetext', '1 of 4 files done');
      expect(bar).toHaveAttribute('aria-valuenow', '25');
    });

    it('lists every file with its state in words', () => {
      renderQueue(running());

      const list = screen.getByRole('list', { name: /files in this batch/i });
      expect(within(list).getByText('file1.pdf').closest('li')).toHaveTextContent(/added/i);
      expect(within(list).getByText('file2.pdf').closest('li')).toHaveTextContent(/adding/i);
      expect(within(list).getByText('file3.pdf').closest('li')).toHaveTextContent(/waiting/i);
    });

    it('offers Cancel, and no retry, resume or dismiss', async () => {
      const { onCancel } = renderQueue(running());

      await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

      expect(onCancel).toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /resume/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
    });

    it('once cancelling, says the current file is being finished and disables Cancel', () => {
      renderQueue({ ...running(), cancelRequested: true });

      expect(screen.getByRole('heading', { name: /finishing the current file/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /cancelling/i })).toBeDisabled();
    });

    it('disables the actions while one is on its way', () => {
      renderQueue(running(), { busy: true });

      expect(screen.getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    });

    it('shows a file being retried after a transient failure, with why', () => {
      renderQueue(batch('running', [item(1, 'queued', { attempts: 1, errorKind: 'transient', reason: 'bad gateway' })]));

      expect(screen.getByText('file1.pdf').closest('li')).toHaveTextContent(/retrying.*bad gateway/i);
    });
  });

  describe('when it is paused', () => {
    const paused = () => batch('paused', [item(1, 'added'), item(2, 'queued')], { pauseReason: 'sharepoint_token' });

    it('says why and what to do', () => {
      renderQueue(paused());

      expect(screen.getByRole('heading', { name: /paused/i })).toBeInTheDocument();
      expect(visibleText(/sharepoint token expired/i)).toHaveTextContent(/reconnect sharepoint/i);
    });

    it('offers Resume (and Cancel), but is not described as done', async () => {
      const { onResume } = renderQueue(paused());

      await userEvent.click(screen.getByRole('button', { name: /^resume$/i }));

      expect(onResume).toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();
    });
  });

  describe('when it has finished', () => {
    it('all added: says so plainly, and offers the report and Dismiss', async () => {
      const { onDismiss, onOpenReport } = renderQueue(batch('completed', [item(1, 'added', { chunksInStore: 5 }), item(2, 'unchanged', { chunksInStore: 7 })]));

      expect(screen.getByRole('heading', { name: /added 1 file/i })).toBeInTheDocument();
      expect(visibleText(/1 already up to date/i)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /view report/i }));
      await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
      expect(onOpenReport).toHaveBeenCalled();
      expect(onDismiss).toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: /^cancel$/i })).toBeNull();
    });

    it('with failures: counts them and offers to retry only those', async () => {
      const { onRetryFailed } = renderQueue(batch('completed_with_errors', [item(1, 'added'), item(2, 'failed', { reason: 'unsupported file type' }), item(3, 'failed', { reason: 'gone' })]));

      expect(screen.getByText(/1 added · 2 failed/i)).toBeInTheDocument();
      expect(screen.getByText('file2.pdf').closest('li')).toHaveTextContent(/failed.*unsupported file type/i);
      await userEvent.click(screen.getByRole('button', { name: /retry 2 failed/i }));

      expect(onRetryFailed).toHaveBeenCalled();
    });

    it('everything failed: says it failed, and can retry', () => {
      renderQueue(batch('failed', [item(1, 'failed', { reason: 'boom' })]));

      expect(screen.getByRole('heading', { name: /could not add any files/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /retry 1 failed/i })).toBeInTheDocument();
    });

    it('cancelled: says what got in before it stopped', () => {
      renderQueue(batch('cancelled', [item(1, 'added'), item(2, 'cancelled')]));

      expect(screen.getByRole('heading', { name: /cancelled/i })).toBeInTheDocument();
      expect(screen.getByText('file2.pdf').closest('li')).toHaveTextContent(/cancelled/i);
    });

    it('warns about a file that stored no text', () => {
      renderQueue(batch('completed', [item(1, 'added', { chunksInStore: 0, reason: 'no text could be stored (empty, or only images?)' })]));

      expect(screen.getByText('file1.pdf').closest('li')).toHaveTextContent(/no text could be stored/i);
    });

    it('shows how many chunks an added or unchanged file holds', () => {
      renderQueue(batch('completed', [item(1, 'added', { chunksInStore: 12 }), item(2, 'unchanged', { chunksInStore: 7 })]));

      expect(screen.getByText('file1.pdf').closest('li')).toHaveTextContent('12 chunks');
      expect(screen.getByText('file2.pdf').closest('li')).toHaveTextContent('7 chunks');
    });
  });

  it('shows a problem talking to the server without hiding the batch', () => {
    renderQueue(batch('running', [item(1, 'running')]), { error: 'Could not refresh the batch status. Retrying.' });

    expect(screen.getByText(/could not refresh the batch status/i)).toBeInTheDocument();
    expect(screen.getByText('file1.pdf')).toBeInTheDocument();
  });

  it('announces the start and the finish to a screen reader, in one status region', () => {
    renderQueue(batch('completed', [item(1, 'added')]));

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent(/finished/i);
  });

  it('shows a Hebrew file name bidirectionally safe', () => {
    renderQueue(batch('completed', [item(1, 'added', { name: 'מדריך.docx' })]));

    expect(document.querySelector('bdi[dir="auto"]')).toHaveTextContent('מדריך.docx');
  });

  it('does not offer a report when the page has none to open', () => {
    renderQueue(batch('completed', [item(1, 'added')]), { onOpenReport: undefined });

    expect(screen.queryByRole('button', { name: /view report/i })).toBeNull();
  });
});
