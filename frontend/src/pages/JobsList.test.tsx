import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as React from 'react';
import { JobsList } from './JobsList';
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

  it('navigates to job detail when Enter key is pressed on a focused row', async () => {
    const mockNavigate = vi.fn();
    vi.mocked(reactRouterDom.useNavigate).mockReturnValue(mockNavigate);
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([
      { id: 'j1', mode: 'survey', status: 'diff_ready', areaPath: 'Proj\\A', itemCount: 12, createdAt: '2026-07-09T00:00:00Z' },
    ]);
    render(<MemoryRouter><JobsList /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Proj\\A')).toBeInTheDocument());
    const row = screen.getByRole('link', { name: /View job j1/i });
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(mockNavigate).toHaveBeenCalledWith('/jobs/j1');
  });
});
