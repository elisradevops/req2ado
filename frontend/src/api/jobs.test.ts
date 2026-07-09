import { describe, it, expect, vi } from 'vitest';
import { httpClient } from './httpClient';
import { listJobs, submitJob, confirmJob } from './jobs';

vi.mock('./httpClient');

describe('jobs api', () => {
  it('listJobs calls GET /jobs', async () => {
    (httpClient.get as any).mockResolvedValue({ data: [{ id: 'j1' }] });
    const result = await listJobs();
    expect(httpClient.get).toHaveBeenCalledWith('/jobs');
    expect(result).toEqual([{ id: 'j1' }]);
  });

  it('confirmJob sends PAT headers when a credential is provided', async () => {
    (httpClient.post as any).mockResolvedValue({ data: { status: 'succeeded', createdCount: 3 } });
    await confirmJob('job-1', { orgUrl: 'https://ado.example', pat: 'pat-1' });
    expect(httpClient.post).toHaveBeenCalledWith('/jobs/job-1/confirm', undefined, {
      headers: { 'X-Ado-Org-Url': 'https://ado.example', 'X-Ado-Pat': 'pat-1' },
    });
  });
});
