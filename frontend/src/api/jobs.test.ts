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

  it('submitJob appends followUp="true"/"false" to the form data (never omitted)', async () => {
    (httpClient.post as any).mockResolvedValue({ data: { jobId: 'job-1' } });

    await submitJob({ file: new File(['x'], 'req.docx'), areaPath: 'Project\\Area1', mode: 'baseline', followUp: true });
    let form = (httpClient.post as any).mock.calls[0][1] as FormData;
    expect(form.get('followUp')).toBe('true');

    await submitJob({ file: new File(['x'], 'req.docx'), areaPath: 'Project\\Area1', mode: 'baseline' });
    form = (httpClient.post as any).mock.calls[1][1] as FormData;
    expect(form.get('followUp')).toBe('false');
  });

  it('confirmJob posts with no credential -- the orchestrator resolves the PAT server-side from the vault', async () => {
    (httpClient.post as any).mockResolvedValue({ data: { status: 'succeeded', createdCount: 3 } });
    await confirmJob('job-1');
    expect(httpClient.post).toHaveBeenCalledWith('/jobs/job-1/confirm');
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
