import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as React from 'react';
import { JobsList } from './JobsList';
import { ToastProvider } from '../components/ToastProvider';
import * as jobsApi from '../api/jobs';
import * as reactRouterDom from 'react-router-dom';

vi.mock('../api/jobs');
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: vi.fn(),
  };
});

describe('JobsList', () => {
  it('renders a row per job with mode badge, status chip, item count, area path', async () => {
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([
      { id: 'j1', mode: 'survey', status: 'diff_ready', areaPath: 'Proj\\A', originalFilename: 'spec.docx', itemCount: 12, createdItemCount: 0, createdAt: '2026-07-09T00:00:00Z' },
    ]);
    render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
    await waitFor(() => expect(screen.getByText('Proj\\A')).toBeInTheDocument());
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('renders an empty-state CTA when there are no jobs', async () => {
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([]);
    render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
    await waitFor(() => expect(screen.getByText(/create your first job/i)).toBeInTheDocument());
  });

  it('navigates to job detail when Enter key is pressed on a focused row', async () => {
    const mockNavigate = vi.fn();
    vi.mocked(reactRouterDom.useNavigate).mockReturnValue(mockNavigate);
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([
      { id: 'j1', mode: 'survey', status: 'diff_ready', areaPath: 'Proj\\A', originalFilename: 'spec.docx', itemCount: 12, createdItemCount: 0, createdAt: '2026-07-09T00:00:00Z' },
    ]);
    render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
    await waitFor(() => expect(screen.getByText('Proj\\A')).toBeInTheDocument());
    const row = screen.getByRole('link', { name: /View job j1/i });
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(mockNavigate).toHaveBeenCalledWith('/jobs/j1');
  });

  it('shows the source document filename as its own column', async () => {
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([
      { id: 'j1', mode: 'survey', status: 'diff_ready', areaPath: 'Proj\\A', originalFilename: 'SRD-EW-2100.docx', itemCount: 12, createdItemCount: 0, createdAt: '2026-07-09T00:00:00Z' },
    ]);
    render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
    await waitFor(() => expect(screen.getByText('SRD-EW-2100.docx')).toBeInTheDocument());
  });

  it('shows stat tiles summarizing awaiting-review, running, items-written, and rejected counts', async () => {
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([
      { id: 'j1', mode: 'survey', status: 'diff_ready', areaPath: 'Proj\\A', originalFilename: 'a.docx', itemCount: 5, createdItemCount: 0, createdAt: '2026-07-09T00:00:00Z' },
      { id: 'j2', mode: 'baseline', status: 'running', areaPath: 'Proj\\B', originalFilename: 'b.docx', itemCount: 0, createdItemCount: 0, createdAt: '2026-07-09T00:00:00Z' },
      { id: 'j3', mode: 'baseline', status: 'succeeded', areaPath: 'Proj\\C', originalFilename: 'c.docx', itemCount: 4, createdItemCount: 4, createdAt: '2026-07-09T00:00:00Z' },
      { id: 'j4', mode: 'baseline', status: 'rejected', areaPath: 'Proj\\D', originalFilename: 'd.docx', itemCount: 2, createdItemCount: 0, createdAt: '2026-07-09T00:00:00Z' },
    ]);
    render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
    await waitFor(() => expect(screen.getAllByText(/awaiting review/i).length).toBeGreaterThan(0));

    expect(screen.getAllByText('Running').length).toBeGreaterThan(0);
    const itemsWrittenLabel = screen.getByText('Items written');
    expect(itemsWrittenLabel).toBeInTheDocument();
    expect(itemsWrittenLabel.previousElementSibling).toHaveTextContent('4'); // items written total
    expect(screen.getAllByText('Rejected').length).toBeGreaterThan(0);
  });

  it('filters to Awaiting review via the curated status filter, not the raw enum', async () => {
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([
      { id: 'j1', mode: 'survey', status: 'diff_ready', areaPath: 'Proj\\A', originalFilename: 'a.docx', itemCount: 5, createdItemCount: 0, createdAt: '2026-07-09T00:00:00Z' },
      { id: 'j2', mode: 'baseline', status: 'succeeded', areaPath: 'Proj\\B', originalFilename: 'b.docx', itemCount: 4, createdItemCount: 4, createdAt: '2026-07-09T00:00:00Z' },
    ]);
    render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
    await waitFor(() => expect(screen.getByText('a.docx')).toBeInTheDocument());
    expect(screen.getByText('b.docx')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Awaiting review' }));

    expect(screen.getByText('a.docx')).toBeInTheDocument();
    expect(screen.queryByText('b.docx')).not.toBeInTheDocument();
  });

  it('deletes a job via the row action without navigating, then refreshes the list', async () => {
    const mockNavigate = vi.fn();
    vi.mocked(reactRouterDom.useNavigate).mockReturnValue(mockNavigate);
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([
      { id: 'j1', mode: 'survey', status: 'diff_ready', areaPath: 'Proj\\A', originalFilename: 'a.docx', itemCount: 5, createdItemCount: 0, createdAt: '2026-07-09T00:00:00Z' },
    ]);
    const deleteSpy = vi.spyOn(jobsApi, 'deleteJob').mockResolvedValue({ deleted: true });

    render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
    await waitFor(() => expect(screen.getByText('a.docx')).toBeInTheDocument());

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /delete job j1/i }));
    expect(mockNavigate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /^delete job$/i }));
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('j1'));
    // Refetches after a successful delete.
    await waitFor(() => expect(jobsApi.listJobs).toHaveBeenCalledTimes(2));
  });

  it('resubmits a job via the row action without navigating', async () => {
    const mockNavigate = vi.fn();
    vi.mocked(reactRouterDom.useNavigate).mockReturnValue(mockNavigate);
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([
      { id: 'j1', mode: 'survey', status: 'diff_ready', areaPath: 'Proj\\A', originalFilename: 'a.docx', itemCount: 5, createdItemCount: 0, createdAt: '2026-07-09T00:00:00Z' },
    ]);
    const resubmitSpy = vi.spyOn(jobsApi, 'resubmitJob').mockResolvedValue({ jobId: 'j2' });

    render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
    await waitFor(() => expect(screen.getByText('a.docx')).toBeInTheDocument());

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /resubmit job j1/i }));
    expect(mockNavigate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /^resubmit$/i }));
    await waitFor(() => expect(resubmitSpy).toHaveBeenCalledWith('j1'));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/jobs/j2'));
  });

  it('does not offer a resubmit or delete action for a running job', async () => {
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([
      { id: 'j1', mode: 'survey', status: 'running', areaPath: 'Proj\\A', originalFilename: 'a.docx', itemCount: 0, createdItemCount: 0, createdAt: '2026-07-09T00:00:00Z' },
    ]);
    render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
    await waitFor(() => expect(screen.getByText('a.docx')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /resubmit job j1/i })).not.toBeInTheDocument();
  });

  it('does not offer a delete action for a running job', async () => {
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([
      { id: 'j1', mode: 'survey', status: 'running', areaPath: 'Proj\\A', originalFilename: 'a.docx', itemCount: 0, createdItemCount: 0, createdAt: '2026-07-09T00:00:00Z' },
    ]);
    render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
    await waitFor(() => expect(screen.getByText('a.docx')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /delete job j1/i })).not.toBeInTheDocument();
  });

  it('shows an error toast and keeps the row when delete fails', async () => {
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([
      { id: 'j1', mode: 'survey', status: 'diff_ready', areaPath: 'Proj\\A', originalFilename: 'a.docx', itemCount: 5, createdItemCount: 0, createdAt: '2026-07-09T00:00:00Z' },
    ]);
    vi.spyOn(jobsApi, 'deleteJob').mockRejectedValue(new Error('network error'));

    render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
    await waitFor(() => expect(screen.getByText('a.docx')).toBeInTheDocument());

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /delete job j1/i }));
    await userEvent.click(screen.getByRole('button', { name: /^delete job$/i }));

    await waitFor(() => expect(screen.getByText(/failed to delete job/i)).toBeInTheDocument());
    expect(screen.getByText('a.docx')).toBeInTheDocument();
  });
});
