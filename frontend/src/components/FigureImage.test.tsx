import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FigureImage } from './FigureImage';
import * as jobsApi from '../api/jobs';

vi.mock('../api/jobs');

describe('FigureImage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not fetch at all while inactive', async () => {
    const getFigureFile = vi.spyOn(jobsApi, 'getFigureFile').mockResolvedValue(null);
    render(<FigureImage jobId="job-1" figureId="f0" active={false} alt="Figure 1" />);
    // Give any errant effect a tick to fire before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getFigureFile).not.toHaveBeenCalled();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('fetches once active becomes true and renders the resulting image', async () => {
    const blob = new Blob(['png bytes'], { type: 'image/png' });
    vi.spyOn(jobsApi, 'getFigureFile').mockResolvedValue(blob);
    // jsdom has no real URL.createObjectURL -- stub it so the component's
    // object-URL plumbing can be exercised without a real Blob backing.
    const createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() });

    render(<FigureImage jobId="job-1" figureId="f0" active alt="Figure 1" />);

    const img = await screen.findByAltText('Figure 1');
    expect(img).toHaveAttribute('src', 'blob:mock-url');
    expect(jobsApi.getFigureFile).toHaveBeenCalledWith('job-1', 'f0');
  });

  it(
    'renders a quiet placeholder (not a broken image) once every retry is exhausted',
    async () => {
      const getFigureFile = vi.spyOn(jobsApi, 'getFigureFile').mockResolvedValue(null);
      render(<FigureImage jobId="job-1" figureId="f0" active alt="Figure 1" />);
      // Real timers, real waits -- fake timers don't reliably interleave
      // with React's own effect scheduling under jsdom for a loop that
      // awaits both a real Promise (the mocked fetch) and a timer on every
      // iteration (confirmed by hand: advanceTimersByTimeAsync repeatedly
      // left the component stuck mid-loop). 4 real attempts at ~1.5s apart
      // is slow but simple and trustworthy; the per-test timeout below
      // gives it enough real wall-clock room.
      await waitFor(() => expect(screen.getByText(/image no longer available/i)).toBeInTheDocument(), { timeout: 8000 });
      expect(screen.queryByAltText('Figure 1')).not.toBeInTheDocument();
      expect(getFigureFile).toHaveBeenCalledTimes(4);
    },
    10000,
  );

  it(
    'self-heals from a transient null WITHOUT a remount -- the real bug this retry loop exists to fix',
    async () => {
      // Confirmed real race, reported live: ingestion publishes a figure's
      // SSE narration (which is what flips `active` true) BEFORE its own
      // separate HTTP call finishes storing that figure's bytes on
      // orchestrator -- a fetch firing the instant `active` turns true can
      // get an honest 404 for a figure that exists a moment later.
      // Previously this required a full page refresh to recover; this test
      // proves the SAME component instance now recovers on its own, no
      // remount/rerender needed.
      const blob = new Blob(['png bytes'], { type: 'image/png' });
      const getFigureFile = vi
        .spyOn(jobsApi, 'getFigureFile')
        .mockResolvedValueOnce(null) // first attempt: storage hasn't landed yet
        .mockResolvedValueOnce(blob); // retry: storage has now caught up
      const createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
      vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() });

      render(<FigureImage jobId="job-1" figureId="f0" active alt="Figure 1" />);

      const img = await screen.findByAltText('Figure 1', {}, { timeout: 5000 });
      expect(img).toHaveAttribute('src', 'blob:mock-url');
      expect(getFigureFile).toHaveBeenCalledTimes(2);
      expect(screen.queryByText(/image no longer available/i)).not.toBeInTheDocument();
    },
    7000,
  );

  it('renders a distinct error placeholder when the fetch itself rejects (no retry on a real error)', async () => {
    const getFigureFile = vi.spyOn(jobsApi, 'getFigureFile').mockRejectedValue(new Error('network error'));
    render(<FigureImage jobId="job-1" figureId="f0" active alt="Figure 1" />);
    await waitFor(() => expect(screen.getByText(/failed to load image/i)).toBeInTheDocument());
    // A real network/server error is NOT the same ambiguous case a null
    // result is -- it must surface immediately, not be masked behind
    // several retries meant only for the storage-write-race window.
    expect(getFigureFile).toHaveBeenCalledTimes(1);
  });

  it('does not re-fetch on a re-render once already resolved', async () => {
    const blob = new Blob(['png bytes'], { type: 'image/png' });
    const getFigureFile = vi.spyOn(jobsApi, 'getFigureFile').mockResolvedValue(blob);
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn().mockReturnValue('blob:mock-url'), revokeObjectURL: vi.fn() });
    const { rerender } = render(<FigureImage jobId="job-1" figureId="f0" active alt="Figure 1" />);
    await screen.findByAltText('Figure 1');
    rerender(<FigureImage jobId="job-1" figureId="f0" active alt="Figure 1" />);
    expect(getFigureFile).toHaveBeenCalledTimes(1);
  });
});
