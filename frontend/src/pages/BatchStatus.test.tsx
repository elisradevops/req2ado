import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { BatchStatus } from './BatchStatus';
import { ToastProvider } from '../components/ToastProvider';
import * as batchesApi from '../api/batches';

vi.mock('../api/batches');

function renderAt(batchId: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[`/jobs/batch/${batchId}`]}>
        <Routes>
          <Route path="/jobs/batch/:batchId" element={<BatchStatus />} />
          <Route path="/jobs/:id" element={<div>job detail page</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

const BASE_SUMMARY = {
  filesTotal: 2,
  filesQueued: 0,
  filesRunning: 0,
  filesAwaitingReview: 1,
  filesSucceeded: 1,
  filesFailed: 0,
  filesRejected: 0,
  filesPending: 0,
  created: 1,
  reused: 0,
  dedupSkipped: 0,
  flagged: 0,
  itemsWritten: 3,
  warningCount: 0,
  warningKinds: {},
};

describe('BatchStatus', () => {
  it('renders per-file rows with status and a link to the job detail page', async () => {
    vi.spyOn(batchesApi, 'getBatch').mockResolvedValue({
      id: 'batch-1',
      createdAt: '2026-08-25T00:00:00Z',
      areaPath: 'Project\\Area1',
      customerId: null,
      mode: 'baseline',
      state: null,
      iterationPath: null,
      model: null,
      files: [
        { id: 'f1', ordinal: 0, filename: 'a.docx', sizeBytes: 1024, status: 'diff_ready', jobId: 'job-1', error: null, queuePosition: null },
        { id: 'f2', ordinal: 1, filename: 'b.docx', sizeBytes: 2048, status: 'succeeded', jobId: 'job-2', error: null, queuePosition: null },
      ],
      summary: BASE_SUMMARY,
      notes: [{ kind: 'cross_file_dedup_deferred', severity: 'info', message: 'Duplicate detection note.' }],
    });

    renderAt('batch-1');

    await waitFor(() => expect(screen.getByText('a.docx')).toBeInTheDocument());
    expect(screen.getByText('b.docx')).toBeInTheDocument();
    expect(screen.getAllByText('View job')).toHaveLength(2);
    expect(screen.getByText(/duplicate detection note/i)).toBeInTheDocument();
  });

  it('renders aggregate stat tiles from the summary', async () => {
    vi.spyOn(batchesApi, 'getBatch').mockResolvedValue({
      id: 'batch-1',
      createdAt: '2026-08-25T00:00:00Z',
      areaPath: 'Project\\Area1',
      customerId: null,
      mode: 'baseline',
      state: null,
      iterationPath: null,
      model: null,
      files: [],
      summary: BASE_SUMMARY,
      notes: [],
    });

    renderAt('batch-1');

    await waitFor(() => expect(screen.getByText('2')).toBeInTheDocument()); // filesTotal
    expect(screen.getAllByText('1')).toHaveLength(2); // filesAwaitingReview and filesSucceeded both 1
  });

  it('shows the "stop queueing" control only when files are still queued, and calls the API on click', async () => {
    vi.spyOn(batchesApi, 'getBatch').mockResolvedValue({
      id: 'batch-1',
      createdAt: '2026-08-25T00:00:00Z',
      areaPath: 'Project\\Area1',
      customerId: null,
      mode: 'survey',
      state: null,
      iterationPath: null,
      model: null,
      files: [{ id: 'f1', ordinal: 0, filename: 'a.docx', sizeBytes: 100, status: 'queued', jobId: null, error: null, queuePosition: 1 }],
      summary: { ...BASE_SUMMARY, filesQueued: 1, filesPending: 1 },
      notes: [],
    });
    vi.spyOn(batchesApi, 'cancelQueuedFiles').mockResolvedValue({ cancelled: 1 });

    renderAt('batch-1');

    const button = await screen.findByRole('button', { name: /stop queueing remaining files/i });
    await userEvent.click(button);

    expect(batchesApi.cancelQueuedFiles).toHaveBeenCalledWith('batch-1');
  });

  it('does not show the "stop queueing" control when nothing is queued', async () => {
    vi.spyOn(batchesApi, 'getBatch').mockResolvedValue({
      id: 'batch-1',
      createdAt: '2026-08-25T00:00:00Z',
      areaPath: 'Project\\Area1',
      customerId: null,
      mode: 'baseline',
      state: null,
      iterationPath: null,
      model: null,
      files: [{ id: 'f1', ordinal: 0, filename: 'a.docx', sizeBytes: 100, status: 'succeeded', jobId: 'job-1', error: null, queuePosition: null }],
      summary: BASE_SUMMARY,
      notes: [],
    });

    renderAt('batch-1');

    await waitFor(() => expect(screen.getByText('a.docx')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /stop queueing/i })).not.toBeInTheDocument();
  });

  it('shows an error state with a retry button when the initial load fails', async () => {
    vi.spyOn(batchesApi, 'getBatch').mockRejectedValue(new Error('network error'));

    renderAt('batch-1');

    await waitFor(() => expect(screen.getByText(/couldn't load this batch/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});

describe('BatchStatus polling', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps polling while a file is not yet settled, and stops once every file is settled', async () => {
    const unsettled = {
      id: 'batch-1',
      createdAt: '2026-08-25T00:00:00Z',
      areaPath: 'Project\\Area1',
      customerId: null,
      mode: 'baseline' as const,
      state: null,
      iterationPath: null,
      model: null,
      files: [{ id: 'f1', ordinal: 0, filename: 'a.docx', sizeBytes: 100, status: 'running', jobId: 'job-1', error: null, queuePosition: null }],
      summary: BASE_SUMMARY,
      notes: [],
    };
    const settled = { ...unsettled, files: [{ ...unsettled.files[0], status: 'succeeded' }] };
    const getBatch = vi.spyOn(batchesApi, 'getBatch').mockResolvedValueOnce(unsettled).mockResolvedValueOnce(settled).mockResolvedValue(settled);

    renderAt('batch-1');
    // Flushes the initial load()'s pending getBatch().then(...) -- fake
    // timers don't affect microtask (Promise) resolution, only
    // setTimeout/setInterval, but the resulting setState still needs an
    // act() boundary to apply and schedule the *next* interval tick off of
    // the now-`loaded` state.
    await act(async () => {});
    expect(getBatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(getBatch).toHaveBeenCalledTimes(2);

    // Now settled -- the interval that would have fired the 3rd call must
    // have been cleared, not merely resolved to the same settled state.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(getBatch).toHaveBeenCalledTimes(2);
  });

  it('never polls at all when every file is already settled on first load', async () => {
    const settled = {
      id: 'batch-1',
      createdAt: '2026-08-25T00:00:00Z',
      areaPath: 'Project\\Area1',
      customerId: null,
      mode: 'baseline' as const,
      state: null,
      iterationPath: null,
      model: null,
      files: [{ id: 'f1', ordinal: 0, filename: 'a.docx', sizeBytes: 100, status: 'succeeded', jobId: 'job-1', error: null, queuePosition: null }],
      summary: BASE_SUMMARY,
      notes: [],
    };
    const getBatch = vi.spyOn(batchesApi, 'getBatch').mockResolvedValue(settled);

    renderAt('batch-1');
    await act(async () => {});
    expect(getBatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(getBatch).toHaveBeenCalledTimes(1);
  });
});
