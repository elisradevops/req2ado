import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { useAuthStore } from '../store/authStore';
import { MemoryRouter } from 'react-router-dom';
import * as React from 'react';
import { JobsList, computeTileCounts } from './JobsList';
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
    await waitFor(() => expect(screen.getByText('A')).toBeInTheDocument());
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('fades the table body in once and gives no row its own animation (DESIGN.md section 8.3)', async () => {
    const jobs = Array.from({ length: 12 }, (_, i) => ({
      id: `j${i}`, mode: 'baseline', status: 'succeeded', areaPath: `Proj\\A${i}`, originalFilename: `f${i}.docx`, itemCount: 1, createdItemCount: 1, createdAt: '2026-07-09T00:00:00Z',
    }));
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue(jobs as never);
    render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
    await waitFor(() => expect(screen.getByText('f0.docx')).toBeInTheDocument());

    const rows = screen.getAllByRole('link', { name: /View job/i });
    expect(rows).toHaveLength(12);
    expect(rows[0].closest('tbody')!.className).toContain('fadeIn');
    for (const row of rows) {
      expect(row.className).not.toContain('animate-');
      expect(row.style.animationDelay).toBe('');
      // row hover is the most frequent feedback in the app: 50 ms
      expect(row.className).toMatch(/(^| )duration-micro( |$)/);
    }
  });

  it('keeps the load-error banner on screen while a retry is in flight, and drops it once the list loads', async () => {
    let resolveRetry: (v: never) => void = () => undefined;
    vi.spyOn(jobsApi, 'listJobs')
      .mockRejectedValueOnce(new Error('offline'))
      .mockReturnValueOnce(new Promise<never>((resolve) => { resolveRetry = resolve; }));
    render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
    await waitFor(() => expect(screen.getByText(/couldn't load jobs/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(screen.getByText(/couldn't load jobs/i)).toBeInTheDocument();

    resolveRetry([] as never);
    await waitFor(() => expect(screen.queryByText(/couldn't load jobs/i)).toBeNull());
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
    await waitFor(() => expect(screen.getByText('A')).toBeInTheDocument());
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
    await waitFor(() => expect(screen.getAllByText(/^diff ready$/i).length).toBeGreaterThan(0));

    expect(screen.getAllByText('Running').length).toBeGreaterThan(0);
    const itemsWrittenLabel = screen.getByText('Items written');
    expect(itemsWrittenLabel).toBeInTheDocument();
    expect(itemsWrittenLabel.previousElementSibling).toHaveTextContent('4'); // items written total
    expect(screen.getAllByText('Rejected').length).toBeGreaterThan(0);
  });

  it('filters to Diff ready via the curated status filter, not the raw enum', async () => {
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([
      { id: 'j1', mode: 'survey', status: 'diff_ready', areaPath: 'Proj\\A', originalFilename: 'a.docx', itemCount: 5, createdItemCount: 0, createdAt: '2026-07-09T00:00:00Z' },
      { id: 'j2', mode: 'baseline', status: 'succeeded', areaPath: 'Proj\\B', originalFilename: 'b.docx', itemCount: 4, createdItemCount: 4, createdAt: '2026-07-09T00:00:00Z' },
    ]);
    render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
    await waitFor(() => expect(screen.getByText('a.docx')).toBeInTheDocument());
    expect(screen.getByText('b.docx')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Diff ready' }));

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

  it('does not lift stat tiles on hover: they are not clickable, so a lift would promise an action that is not there', async () => {
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([
      { id: 'j1', mode: 'survey', status: 'diff_ready', areaPath: 'Proj\\A', originalFilename: 'a.docx', itemCount: 5, createdItemCount: 0, createdAt: '2026-07-09T00:00:00Z' },
    ]);
    render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
    await waitFor(() => expect(screen.getByText('a.docx')).toBeInTheDocument());
    for (const label of ['Running', 'Items written', 'Rejected']) {
      // "Running"/"Rejected" also match the segmented status filter's own buttons; none of the matches may sit
      // inside a `.liftable` ancestor (DESIGN.md section 8.3, hover feedback only on clickable cards).
      const matches = screen.getAllByText(label);
      expect(matches.every((el) => el.closest('.liftable') === null)).toBe(true);
    }
  });

  it('reveals row actions only via the hover/focus opacity class, keeping them in the DOM (never removed from the tab order)', async () => {
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([
      { id: 'j1', mode: 'survey', status: 'diff_ready', areaPath: 'Proj\\A', originalFilename: 'a.docx', itemCount: 5, createdItemCount: 0, createdAt: '2026-07-09T00:00:00Z' },
    ]);
    render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
    await waitFor(() => expect(screen.getByText('a.docx')).toBeInTheDocument());
    const deleteButton = screen.getByRole('button', { name: /delete job j1/i });
    // The reveal sits on the actions wrapper (the icon button adds its own tooltip wrapper inside it).
    const reveal = deleteButton.closest('[class*="opacity-0"]');
    expect(reveal).not.toBeNull();
    expect(reveal!.className).toContain('group-hover:opacity-100');
  });

  it('New batch button navigates to the batch wizard (NEW-05)', async () => {
    const mockNavigate = vi.fn();
    vi.mocked(reactRouterDom.useNavigate).mockReturnValue(mockNavigate);
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([]);
    render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: /new batch/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /new batch/i }));

    expect(mockNavigate).toHaveBeenCalledWith('/jobs/batch/new');
  });

  it('renders a Batch chip for a job tagged with batchId, which navigates to the batch page without also navigating to the job (NEW-05)', async () => {
    const mockNavigate = vi.fn();
    vi.mocked(reactRouterDom.useNavigate).mockReturnValue(mockNavigate);
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([
      { id: 'j1', mode: 'baseline', status: 'diff_ready', areaPath: 'Proj\\A', originalFilename: 'a.docx', itemCount: 1, createdItemCount: 0, createdAt: '2026-07-09T00:00:00Z', batchId: 'batch-1' },
      { id: 'j2', mode: 'baseline', status: 'diff_ready', areaPath: 'Proj\\A', originalFilename: 'b.docx', itemCount: 1, createdItemCount: 0, createdAt: '2026-07-09T00:00:00Z' },
    ]);
    render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
    await waitFor(() => expect(screen.getByText('a.docx')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Batch'));

    expect(mockNavigate).toHaveBeenCalledWith('/jobs/batch/batch-1');
    expect(mockNavigate).not.toHaveBeenCalledWith('/jobs/j1');
  });

  describe('findability and type (DESIGN.md §0.1)', () => {
    const jobAt = (id: string, name: string, createdAt: string) => ({
      id, mode: 'survey', status: 'diff_ready', areaPath: `Proj\\${id}`, originalFilename: name, itemCount: 3, createdItemCount: 0, createdAt,
    });

    it('finds a job by its file name, not only by area path or id', async () => {
      vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([
        jobAt('j1', 'radar-icd.docx', new Date().toISOString()),
        jobAt('j2', 'power-spec.docx', new Date().toISOString()),
      ] as never);
      render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
      await waitFor(() => expect(screen.getByText('radar-icd.docx')).toBeInTheDocument());
      fireEvent.change(screen.getByRole('textbox', { name: /search/i }), { target: { value: 'POWER' } });
      expect(screen.getByText('power-spec.docx')).toBeInTheDocument();
      expect(screen.queryByText('radar-icd.docx')).not.toBeInTheDocument();
    });

    it('names the page in the browser tab (WCAG 2.4.2)', async () => {
      vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([jobAt('j1', 'a.docx', new Date().toISOString())] as never);
      render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
      await waitFor(() => expect(screen.getByText('a.docx')).toBeInTheDocument());
      expect(document.title).toBe('Jobs - req2ado');
    });

    it('says what the search covers', async () => {
      vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([jobAt('j1', 'a.docx', new Date().toISOString())] as never);
      render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
      await waitFor(() => expect(screen.getByText('a.docx')).toBeInTheDocument());
      expect(screen.getByRole('textbox', { name: /search/i })).toHaveAttribute('placeholder', 'File name, area path or job id…');
    });

    it('makes the row actions 32 px icon buttons, not 22 px text-size buttons (WCAG 2.5.8, DESIGN.md §13)', async () => {
      vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([jobAt('j1', 'a.docx', new Date().toISOString())] as never);
      render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
      await waitFor(() => expect(screen.getByText('a.docx')).toBeInTheDocument());
      for (const name of ['Resubmit job j1', 'Delete job j1']) {
        const button = screen.getByRole('button', { name });
        expect(button.className).toMatch(/(?<![\w-])h-8(?![\w-])/);
        expect(button.className).toMatch(/(?<![\w-])w-8(?![\w-])/);
      }
    });

    it('does not open the job when a row action is clicked', async () => {
      const navigate = vi.fn();
      vi.spyOn(reactRouterDom, 'useNavigate').mockReturnValue(navigate);
      vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([jobAt('j1', 'a.docx', new Date().toISOString())] as never);
      render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
      await waitFor(() => expect(screen.getByText('a.docx')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Delete job j1' }));
      expect(navigate).not.toHaveBeenCalled();
    });

    it('sets the created time in the proportional face: only identifiers are mono', async () => {
      vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([jobAt('j1', 'a.docx', new Date(Date.now() - 3 * 3600_000).toISOString())] as never);
      render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
      const when = await screen.findByText(/hour/i);
      expect(when.closest('td')!.className).not.toMatch(/(?<![\w-])font-mono(?![\w-])/);
    });
  });
  describe('grouping, ids and stale labels (DESIGN.md §11.1b)', () => {
    const NOW = new Date(2026, 10, 13, 10, 0, 0);
    const at = (daysBack: number, hour = 9) => new Date(2026, 10, 13 - daysBack, hour, 0, 0).toISOString();
    const row = (id: string, status: string, createdAt: string, name = `${id}.docx`) => ({
      id, mode: 'survey', status, areaPath: 'Proj\\A', originalFilename: name, itemCount: 3, createdItemCount: status === 'succeeded' ? 3 : 0, createdAt,
    });
    function renderAtNow(jobs: unknown[]) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
      vi.spyOn(jobsApi, 'listJobs').mockResolvedValue(jobs as never);
      render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
    }
    afterEach(() => vi.useRealTimers());

    it('puts jobs that need the user first, then the rest by day, each group headed with its count', async () => {
      renderAtNow([
        row('aaaaaaaa-1', 'diff_ready', at(0)),
        row('bbbbbbbb-2', 'failed', at(1)),
        row('cccccccc-3', 'succeeded', at(0, 8)),
        row('dddddddd-4', 'succeeded', at(1, 8)),
        row('eeeeeeee-5', 'rejected', at(4)),
        row('ffffffff-6', 'succeeded', at(30)),
      ]);
      await waitFor(() => expect(screen.getByText('aaaaaaaa-1.docx')).toBeInTheDocument());
      const headings = screen.getAllByRole('rowheader').map((h) => h.textContent);
      expect(headings).toEqual(['Needs you · 2', 'Today · 1', 'Yesterday · 1', 'This week · 1', 'Earlier · 1']);
    });

    it('says why a failed run stopped, in plain words, from the stored failure class', async () => {
      renderAtNow([
        { ...row('bbbbbbbb-2', 'failed', at(1)), failureClass: 'connection_reset' },
        { ...row('cccccccc-3', 'failed', at(1)), failureClass: null },
        row('dddddddd-4', 'succeeded', at(0)),
      ]);
      await waitFor(() => expect(screen.getByText('bbbbbbbb-2.docx')).toBeInTheDocument());
      expect(screen.getAllByText('The connection was cut during the run.')).toHaveLength(1);
      expect(screen.queryByText('The run stopped with an error.')).toBeNull();
    });

    it('shows the short job id in mono, the text the job page address starts with', async () => {
      renderAtNow([row('129e4ca3-8973-4887-b4e9-d7c16dbb7fae', 'succeeded', at(0))]);
      await waitFor(() => expect(screen.getByText('129e4ca3')).toBeInTheDocument());
      expect(screen.getByText('129e4ca3')).toHaveClass('font-mono');
      expect(screen.getByRole('columnheader', { name: 'Job' })).toBeInTheDocument();
    });

    it('labels a proposal left waiting for over a week as stale, and keeps it out of "Needs you"', async () => {
      renderAtNow([row('fresh111-1', 'diff_ready', at(0)), row('stale222-2', 'diff_ready', at(14))]);
      await waitFor(() => expect(screen.getByText('stale222-2.docx')).toBeInTheDocument());
      expect(screen.getByText('Stale · 14 days')).toBeInTheDocument();
      expect(screen.getAllByText(/^Stale/)).toHaveLength(1);
      expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Needs you · 1', 'Earlier · 1']);
    });

    it('labels a run that has not finished in 12 hours as stalled, with the hours, and not a run that just started', async () => {
      renderAtNow([row('fresh111-1', 'running', at(0)), row('hung2222-2', 'running', at(1)), row('slow3333-3', 'succeeded', at(1))]);
      await waitFor(() => expect(screen.getByText('hung2222-2.docx')).toBeInTheDocument());
      expect(screen.getAllByText(/^Stalled/)).toHaveLength(1);
      expect(screen.getByText(/^Stalled · \d+ h$/)).toBeInTheDocument();
    });

    it('says "Diff ready" for the state everywhere: the tile, the filter and the chip', async () => {
      renderAtNow([row('fresh111-1', 'diff_ready', at(0))]);
      await waitFor(() => expect(screen.getByText('fresh111-1.docx')).toBeInTheDocument());
      expect(screen.queryByText(/awaiting review/i)).not.toBeInTheDocument();
      expect(screen.getAllByText('Diff ready').length).toBeGreaterThanOrEqual(3);
    });

    it('caps the document and area path cells so the table fits its card (auto layout cannot shrink a truncated cell with no cap)', async () => {
      renderAtNow([row('fresh111-1', 'diff_ready', at(0))]);
      await waitFor(() => expect(screen.getByText('fresh111-1.docx')).toBeInTheDocument());
      expect(screen.getByText('A').className).toMatch(/max-w-/);
      expect(screen.getByText('fresh111-1.docx').className).toMatch(/max-w-/);
      // On a phone only Document and Status remain, and both must fit a 354 px card: the filename gets a much tighter cap there.
      expect(screen.getByText('fresh111-1.docx').className).toContain('max-md:max-w-[7rem]');
    });

    it('offers "Hide stale" only when some proposal is stale, off by default, and hides them without deleting anything (F4)', async () => {
      vi.mocked(jobsApi.deleteJob).mockClear();
      renderAtNow([row('fresh111-1', 'diff_ready', at(0)), row('stale222-2', 'diff_ready', at(14)), row('stale333-3', 'diff_ready', at(20))]);
      await waitFor(() => expect(screen.getByText('stale222-2.docx')).toBeInTheDocument());
      const toggle = screen.getByRole('checkbox', { name: /hide stale \(2\)/i });
      expect(toggle).not.toBeChecked();

      fireEvent.click(toggle);
      expect(screen.queryByText('stale222-2.docx')).not.toBeInTheDocument();
      expect(screen.queryByText('stale333-3.docx')).not.toBeInTheDocument();
      expect(screen.getByText('fresh111-1.docx')).toBeInTheDocument();
      expect(screen.getByText('2 stale hidden')).toBeInTheDocument();
      // Hidden from the list, never removed: nothing was sent to the server.
      expect(jobsApi.deleteJob).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('checkbox', { name: /hide stale \(2\)/i }));
      expect(screen.getByText('stale222-2.docx')).toBeInTheDocument();
    });

    it('offers no "Hide stale" when nothing is stale', async () => {
      renderAtNow([row('fresh111-1', 'diff_ready', at(0)), row('done2222-2', 'succeeded', at(30))]);
      await waitFor(() => expect(screen.getByText('fresh111-1.docx')).toBeInTheDocument());
      expect(screen.queryByRole('checkbox', { name: /hide stale/i })).not.toBeInTheDocument();
    });

    it('remembers the choice for the signed-in user, and not for another', async () => {
      localStorage.clear();
      useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
      renderAtNow([row('fresh111-1', 'diff_ready', at(0)), row('stale222-2', 'diff_ready', at(14))]);
      await waitFor(() => expect(screen.getByText('stale222-2.docx')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('checkbox', { name: /hide stale/i }));
      expect(localStorage.getItem('req2ado-hide-stale-jobs:user-descriptor-1')).toBe('true');
      cleanup();

      renderAtNow([row('fresh111-1', 'diff_ready', at(0)), row('stale222-2', 'diff_ready', at(14))]);
      await waitFor(() => expect(screen.getByText('fresh111-1.docx')).toBeInTheDocument());
      expect(screen.queryByText('stale222-2.docx')).not.toBeInTheDocument();
      cleanup();

      useAuthStore.getState().login('https://ado.example', 'Joe', 'someone-else');
      renderAtNow([row('fresh111-1', 'diff_ready', at(0)), row('stale222-2', 'diff_ready', at(14))]);
      await waitFor(() => expect(screen.getByText('stale222-2.docx')).toBeInTheDocument());
      useAuthStore.getState().logout();
    });

    it('drops columns as the width shrinks so Status and Created stay reachable: area below 1400 px, mode and items below 1100 px, id/created/actions below md', async () => {
      renderAtNow([row('fresh111-1', 'diff_ready', at(0))]);
      await waitFor(() => expect(screen.getByText('fresh111-1.docx')).toBeInTheDocument());
      const header = (name: string) => screen.getByRole('columnheader', { name }).className;
      expect(header('Area Path')).toContain('max-[1399px]:hidden');
      expect(header('Mode')).toContain('max-[1099px]:hidden');
      expect(header('Items')).toContain('max-[1099px]:hidden');
      expect(header('Job')).toContain('max-md:hidden');
      expect(header('Created')).toContain('max-md:hidden');
      // The two columns that answer "what is it and what state" never drop.
      expect(header('Document')).not.toMatch(/hidden/);
      expect(header('Status')).not.toMatch(/hidden/);
      // Cells follow their headers.
      const statusCell = screen.getByText('fresh111-1.docx').closest('tr')!.querySelectorAll('td');
      expect(statusCell[0].className).toContain('max-md:hidden'); // job id
      expect(statusCell[5].className).toContain('max-[1399px]:hidden'); // area path
    });

    it('shows only the leaf of the area path, with the whole path in the tooltip, so the part that tells areas apart is not the part cut off', async () => {
      renderAtNow([{ ...row('fresh111-1', 'diff_ready', at(0)), areaPath: 'elisradevops-project\\Customer Requirements' }]);
      await waitFor(() => expect(screen.getByText('fresh111-1.docx')).toBeInTheDocument());
      expect(screen.getByText('Customer Requirements')).toBeInTheDocument();
      expect(screen.queryByText('elisradevops-project\\Customer Requirements')).not.toBeInTheDocument();
    });

    it('offers "Hide stale" for the stale jobs the other filters would show, and not under a filter that shows none of them', async () => {
      renderAtNow([row('fresh111-1', 'diff_ready', at(0)), row('stale222-2', 'diff_ready', at(14)), row('done3333-3', 'succeeded', at(0, 8))]);
      await waitFor(() => expect(screen.getByText('stale222-2.docx')).toBeInTheDocument());
      expect(screen.getByRole('checkbox', { name: /hide stale \(1\)/i })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(screen.queryByRole('checkbox', { name: /hide stale/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/stale hidden/)).not.toBeInTheDocument();
    });

    it('counts only the proposals that still need review in the "Diff ready" tile, matching "Needs you"', () => {
      const now = new Date(2026, 10, 13, 10, 0, 0);
      const mk = (id: string, status: string, daysBack: number) => ({ id, status, createdAt: new Date(2026, 10, 13 - daysBack, 9, 0, 0).toISOString(), itemCount: 1, createdItemCount: 0 }) as any;
      const counts = computeTileCounts([mk('a', 'diff_ready', 0), mk('b', 'diff_ready', 14), mk('c', 'diff_ready', 30), mk('d', 'running', 0), mk('e', 'rejected', 0)], now);
      expect(counts.awaitingReview).toBe(1);
      expect(counts.running).toBe(1);
      expect(counts.rejected).toBe(1);
    });

    it('heads each day group as a row group, and names each row by its job, file and state for a screen reader', async () => {
      renderAtNow([row('fresh111-1', 'diff_ready', at(0))]);
      await waitFor(() => expect(screen.getByText('fresh111-1.docx')).toBeInTheDocument());
      expect(document.querySelectorAll('th[scope="rowgroup"]')).toHaveLength(1);
      expect(screen.getByRole('link', { name: /View job fresh111-1.*fresh111-1\.docx.*Diff ready/i })).toBeInTheDocument();
    });

    it('still filters, and groups only what the filter leaves', async () => {
      renderAtNow([row('fresh111-1', 'diff_ready', at(0)), row('done2222-2', 'succeeded', at(0, 8))]);
      await waitFor(() => expect(screen.getByText('fresh111-1.docx')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Today · 1']);
    });
  });
});


describe('JobsList background refresh', () => {
  const row = (id: string, name: string) => ({
    id, mode: 'survey', status: 'succeeded', areaPath: 'Proj\\A', originalFilename: name, itemCount: 1, createdItemCount: 1, createdAt: new Date().toISOString(),
  });

  // The page refreshes on a 20 s interval. Capture that callback and call it by hand: no fake timers, so waitFor keeps working.
  function captureRefresh(): () => void {
    const spy = vi.spyOn(window, 'setInterval');
    render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
    const call = spy.mock.calls.find((args) => args[1] === 20_000);
    if (!call) throw new Error('the page did not start its 20 s refresh');
    return call[0] as () => void;
  }

  afterEach(() => vi.restoreAllMocks());

  it('says once that the list could not be refreshed, not on every failing refresh, and again after it recovers', async () => {
    const list = vi.spyOn(jobsApi, 'listJobs').mockResolvedValueOnce([row('a1', 'first.docx')] as never);
    const refresh = captureRefresh();
    await waitFor(() => expect(screen.getByText('first.docx')).toBeInTheDocument());

    list.mockRejectedValue(new Error('down'));
    refresh();
    await waitFor(() => expect(screen.getAllByText('Failed to load jobs.')).toHaveLength(1));
    refresh();
    refresh();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(4));
    expect(screen.getAllByText('Failed to load jobs.')).toHaveLength(1);

    list.mockResolvedValue([row('a1', 'first.docx')] as never);
    refresh();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(5));
    list.mockRejectedValue(new Error('down again'));
    refresh();
    await waitFor(() => expect(screen.getAllByText('Failed to load jobs.').length).toBeGreaterThanOrEqual(1));
    expect(list).toHaveBeenCalledTimes(6);
  });

  it('pins a running job above "Needs you", and marks a re-run of the same file with the earlier job\'s id', async () => {
    const now = Date.now();
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([
      { ...row('aaaaaaaa-1', 'AirPro.docx'), status: 'diff_ready', createdAt: new Date(now - 3_600_000).toISOString() },
      { ...row('bbbbbbbb-2', 'AirPro.docx'), status: 'running', createdAt: new Date(now - 60_000).toISOString() },
    ] as never);
    render(<ToastProvider><MemoryRouter><JobsList /></MemoryRouter></ToastProvider>);
    await waitFor(() => expect(screen.getAllByText('AirPro.docx')).toHaveLength(2));
    expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Running now · 1', 'Needs you · 1']);
    expect(screen.getByText('Re-run of aaaaaaaa')).toBeInTheDocument();
    expect(screen.getAllByText(/^Re-run of /)).toHaveLength(1);
  });

  it('does not let a slow, older response overwrite a newer one', async () => {
    let releaseOld: (value: unknown) => void = () => {};
    const list = vi.spyOn(jobsApi, 'listJobs').mockResolvedValueOnce([row('a1', 'first.docx')] as never);
    const refresh = captureRefresh();
    await waitFor(() => expect(screen.getByText('first.docx')).toBeInTheDocument());

    list.mockImplementationOnce(() => new Promise((resolve) => { releaseOld = resolve; }) as never);
    refresh(); // the slow one, started first
    list.mockResolvedValueOnce([row('a2', 'newer.docx')] as never);
    refresh(); // the fast one, started second
    await waitFor(() => expect(screen.getByText('newer.docx')).toBeInTheDocument());

    releaseOld([row('a3', 'older.docx')]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByText('newer.docx')).toBeInTheDocument();
    expect(screen.queryByText('older.docx')).not.toBeInTheDocument();
  });
});
