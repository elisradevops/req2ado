import { describe, it, expect, vi } from 'vitest';
import axios from 'axios';
import { httpClient } from './httpClient';
import { listJobs, submitJob, confirmJob, editDiffEntry, setDiffEntryExcluded, addDiffEntry, rescoreDiffEntry, getFigureFile, attachFigureToAdo } from './jobs';

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

  it('rescoreDiffEntry POSTs to the rescore sub-route with no body', async () => {
    (httpClient.post as any).mockResolvedValue({ data: { dryRunDiff: [] } });
    await rescoreDiffEntry('job-1', 'n0');
    expect(httpClient.post).toHaveBeenCalledWith('/jobs/job-1/diff/n0/rescore');
  });

  it('getFigureFile GETs the figure route as a blob', async () => {
    const blob = new Blob(['png bytes'], { type: 'image/png' });
    (httpClient.get as any).mockResolvedValue({ data: blob });
    const result = await getFigureFile('job-1', 'f0');
    expect(httpClient.get).toHaveBeenCalledWith('/jobs/job-1/figures/f0', { responseType: 'blob' });
    expect(result).toBe(blob);
  });

  it('getFigureFile returns null (not a throw) on a 404 -- the figure was never stored or already attached', async () => {
    const notFound = Object.assign(new Error('Request failed with status code 404'), {
      isAxiosError: true,
      response: { status: 404 },
    });
    (httpClient.get as any).mockRejectedValue(notFound);
    // Sanity-check the fixture actually satisfies axios.isAxiosError's real
    // runtime check (not just this test's own assumption about its shape).
    expect(axios.isAxiosError(notFound)).toBe(true);

    const result = await getFigureFile('job-1', 'f0');

    expect(result).toBeNull();
  });

  it('getFigureFile rethrows a non-404 error', async () => {
    const serverError = Object.assign(new Error('Request failed with status code 500'), {
      isAxiosError: true,
      response: { status: 500 },
    });
    (httpClient.get as any).mockRejectedValue(serverError);

    await expect(getFigureFile('job-1', 'f0')).rejects.toBe(serverError);
  });

  it('attachFigureToAdo POSTs to the per-figure attach sub-route with no body', async () => {
    (httpClient.post as any).mockResolvedValue({ data: { attached: true, adoId: 555 } });
    const result = await attachFigureToAdo('job-1', 'n0', 'f0');
    expect(httpClient.post).toHaveBeenCalledWith('/jobs/job-1/diff/n0/figures/f0/attach');
    expect(result).toEqual({ attached: true, adoId: 555 });
  });
});
