import { render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { JobStatus } from './JobStatus';
import { httpClient } from '../api/httpClient';

vi.mock('../api/httpClient');

describe('JobStatus', () => {
  it('renders the dry-run diff table once status is diff_ready', async () => {
    (httpClient.get as any).mockResolvedValue({
      data: {
        id: 'job-1',
        status: 'diff_ready',
        dryRunDiff: [{ localId: 'n0', action: 'create', existingAdoId: null }],
      },
    });
    render(<JobStatus jobId="job-1" />);

    await waitFor(() => expect(screen.getByText('n0')).toBeInTheDocument());
    expect(screen.getByText('create')).toBeInTheDocument();
  });

  it('shows a pending message while status is pending', async () => {
    (httpClient.get as any).mockResolvedValue({ data: { id: 'job-1', status: 'pending', dryRunDiff: null } });
    render(<JobStatus jobId="job-1" />);

    await waitFor(() => expect(screen.getByText(/processing/i)).toBeInTheDocument());
  });

  it('calls confirm and shows success on button click', async () => {
    (httpClient.get as any).mockResolvedValue({
      data: { id: 'job-1', status: 'diff_ready', dryRunDiff: [{ localId: 'n0', action: 'create', existingAdoId: null }] },
    });
    (httpClient.post as any).mockResolvedValue({ data: { status: 'succeeded', createdCount: 1 } });
    render(<JobStatus jobId="job-1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: /confirm write/i })).toBeInTheDocument());
    screen.getByRole('button', { name: /confirm write/i }).click();

    await waitFor(() =>
      expect(httpClient.post).toHaveBeenCalledWith('/jobs/job-1/confirm', undefined, { headers: undefined }),
    );
    await waitFor(() => expect(screen.getByText(/1 item.*written/i)).toBeInTheDocument());
  });

  it('renders a dedup_skip entry with its similarity score, distinct from reuse/create', async () => {
    (httpClient.get as any).mockResolvedValue({
      data: {
        id: 'job-1',
        status: 'diff_ready',
        dryRunDiff: [
          { localId: 'n0', action: 'create', existingAdoId: null, similarity: null },
          { localId: 'n1', action: 'dedup_skip', existingAdoId: 42, similarity: 0.95 },
        ],
      },
    });
    render(<JobStatus jobId="job-1" />);

    await waitFor(() => expect(screen.getByText('dedup_skip')).toBeInTheDocument());
    expect(screen.getByText('95% match')).toBeInTheDocument();
    expect(screen.getByText(/1 probable duplicate skipped/i)).toBeInTheDocument();
  });

  it('sends X-Ado-Org-Url / X-Ado-Pat headers on confirm when a credential is provided', async () => {
    (httpClient.get as any).mockResolvedValue({
      data: { id: 'job-1', status: 'diff_ready', dryRunDiff: [{ localId: 'n0', action: 'create', existingAdoId: null }] },
    });
    (httpClient.post as any).mockResolvedValue({ data: { status: 'succeeded', createdCount: 1 } });
    render(<JobStatus jobId="job-1" credential={{ orgUrl: 'https://tfs.internal/tfs/Collection', pat: 'fake-pat' }} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /confirm write/i })).toBeInTheDocument());
    screen.getByRole('button', { name: /confirm write/i }).click();

    await waitFor(() =>
      expect(httpClient.post).toHaveBeenCalledWith('/jobs/job-1/confirm', undefined, {
        headers: { 'X-Ado-Org-Url': 'https://tfs.internal/tfs/Collection', 'X-Ado-Pat': 'fake-pat' },
      }),
    );
  });
});
