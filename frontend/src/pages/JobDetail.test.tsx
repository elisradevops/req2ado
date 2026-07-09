import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { JobDetail } from './JobDetail';
import * as jobsApi from '../api/jobs';

vi.mock('../api/jobs');
vi.mock('../api/events', () => ({ subscribeToJobEvents: vi.fn(() => () => {}) }));

function renderAt(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/jobs/${id}`]}>
      <Routes>
        <Route path="/jobs/:id" element={<JobDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('JobDetail', () => {
  it('renders an explicit failure screen for a failed job, not a blank diff', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-1', status: 'failed', dryRunDiff: null } as any);
    renderAt('job-1');
    await waitFor(() => expect(screen.getByText(/job failed/i)).toBeInTheDocument());
    expect(screen.queryByText(/select a node/i)).not.toBeInTheDocument();
  });

  it('renders the split diff tree + detail panel for a diff_ready job', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-2',
      status: 'diff_ready',
      dryRunDiff: [{ localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Root', description: '', action: 'CREATE', customerId: null, tags: [] }],
    } as any);
    renderAt('job-2');
    await waitFor(() => expect(screen.getByText('Root')).toBeInTheDocument());
    expect(screen.getByText(/select a node/i)).toBeInTheDocument();
  });

  it('gates the Confirm button on diff_ready status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }),
    );
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-3', status: 'running', dryRunDiff: null } as any);
    renderAt('job-3');
    await waitFor(() => expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument());
  });
});
