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

  it('renders a quiet placeholder (not a broken image) when the figure was never stored or already attached', async () => {
    vi.spyOn(jobsApi, 'getFigureFile').mockResolvedValue(null);
    render(<FigureImage jobId="job-1" figureId="f0" active alt="Figure 1" />);
    await waitFor(() => expect(screen.getByText(/image no longer available/i)).toBeInTheDocument());
    expect(screen.queryByAltText('Figure 1')).not.toBeInTheDocument();
  });

  it('renders a distinct error placeholder when the fetch itself rejects', async () => {
    vi.spyOn(jobsApi, 'getFigureFile').mockRejectedValue(new Error('network error'));
    render(<FigureImage jobId="job-1" figureId="f0" active alt="Figure 1" />);
    await waitFor(() => expect(screen.getByText(/failed to load image/i)).toBeInTheDocument());
  });

  it('does not re-fetch on a re-render once already resolved', async () => {
    const getFigureFile = vi.spyOn(jobsApi, 'getFigureFile').mockResolvedValue(null);
    const { rerender } = render(<FigureImage jobId="job-1" figureId="f0" active alt="Figure 1" />);
    await waitFor(() => expect(screen.getByText(/image no longer available/i)).toBeInTheDocument());
    rerender(<FigureImage jobId="job-1" figureId="f0" active alt="Figure 1" />);
    expect(getFigureFile).toHaveBeenCalledTimes(1);
  });
});
