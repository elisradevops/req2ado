import { describe, it, expect, vi } from 'vitest';
import { httpClient } from './httpClient';
import { listJobs, submitJob, confirmJob, editDiffEntry, setDiffEntryExcluded, addDiffEntry } from './jobs';

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

  it('editDiffEntry PATCHes title/description to the right URL', async () => {
    (httpClient.patch as any).mockResolvedValue({ data: { dryRunDiff: [] } });
    await editDiffEntry('job-1', 'n0', { title: 'New', description: 'New desc' });
    expect(httpClient.patch).toHaveBeenCalledWith('/jobs/job-1/diff/n0', { title: 'New', description: 'New desc' });
  });

  it('setDiffEntryExcluded PATCHes the exclude sub-route', async () => {
    (httpClient.patch as any).mockResolvedValue({ data: { dryRunDiff: [] } });
    await setDiffEntryExcluded('job-1', 'n0', true);
    expect(httpClient.patch).toHaveBeenCalledWith('/jobs/job-1/diff/n0/exclude', { excluded: true });
  });

  it('addDiffEntry POSTs to the diff collection route', async () => {
    (httpClient.post as any).mockResolvedValue({ data: { dryRunDiff: [] } });
    await addDiffEntry('job-1', { parentLocalId: 'n0', type: 'Requirement', title: 'T', description: 'D' });
    expect(httpClient.post).toHaveBeenCalledWith('/jobs/job-1/diff', { parentLocalId: 'n0', type: 'Requirement', title: 'T', description: 'D' });
  });
});
