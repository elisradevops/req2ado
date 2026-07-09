import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { JobsList } from './JobsList';
import * as jobsApi from '../api/jobs';

vi.mock('../api/jobs');

describe('JobsList', () => {
  it('renders a row per job with mode badge, status chip, item count, area path', async () => {
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([
      { id: 'j1', mode: 'survey', status: 'diff_ready', areaPath: 'Proj\\A', itemCount: 12, createdAt: '2026-07-09T00:00:00Z' },
    ]);
    render(<MemoryRouter><JobsList /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Proj\\A')).toBeInTheDocument());
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('renders an empty-state CTA when there are no jobs', async () => {
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([]);
    render(<MemoryRouter><JobsList /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/create your first job/i)).toBeInTheDocument());
  });
});
