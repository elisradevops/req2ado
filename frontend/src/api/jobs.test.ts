import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { httpClient } from './httpClient';
import { explainScore, listJobs, submitJob, confirmJob, editDiffEntry, setDiffEntryExcluded, setProposalAccepted, setDiffEntriesReviewed, setWarningsAcknowledged, retryEnhancement, addDiffEntry, rescoreDiffEntry, getFigureFile, attachFigureToAdo, retryTraceLinkWrite, validateCreatedTree, previewExposition } from './jobs';

vi.mock('./httpClient');
vi.mock('./config', () => ({ loadRuntimeConfig: vi.fn().mockResolvedValue({ apiBaseUrl: '/api' }) }));

describe('jobs api', () => {
  it('listJobs calls GET /jobs', async () => {
    (httpClient.get as any).mockResolvedValue({ data: [{ id: 'j1' }] });
    const result = await listJobs();
    expect(httpClient.get).toHaveBeenCalledWith('/jobs');
    expect(result).toEqual([{ id: 'j1' }]);
  });

  it('submitJob appends file/areaPath/mode to the form data', async () => {
    (httpClient.post as any).mockResolvedValue({ data: { jobId: 'job-1' } });

    await submitJob({ file: new File(['x'], 'req.docx'), areaPath: 'Project\\Area1', mode: 'baseline' });
    const form = (httpClient.post as any).mock.calls[0][1] as FormData;
    expect(form.get('areaPath')).toBe('Project\\Area1');
    expect(form.get('mode')).toBe('baseline');
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

  it('setProposalAccepted PATCHes the proposal sub-route with the accepted flag', async () => {
    (httpClient.patch as any).mockResolvedValue({ data: { dryRunDiff: [] } });
    await setProposalAccepted('job-1', 'n0', true);
    expect(httpClient.patch).toHaveBeenCalledWith('/jobs/job-1/diff/n0/proposal', { accepted: true });
  });

  it('setDiffEntriesReviewed PATCHes the bulk reviewed route with every id in one body', async () => {
    (httpClient.patch as any).mockResolvedValue({ data: { dryRunDiff: [] } });
    await setDiffEntriesReviewed('job-1', ['n0', 'n1'], true);
    expect(httpClient.patch).toHaveBeenCalledWith('/jobs/job-1/diff/reviewed', { localIds: ['n0', 'n1'], reviewed: true });
  });

  it('setWarningsAcknowledged PATCHes the warnings sub-route with kind and optional raws', async () => {
    (httpClient.patch as any).mockResolvedValue({ data: { warnings: [] } });
    await setWarningsAcknowledged('job-1', { kind: 'dropped_blocks', raws: ['a'], acknowledged: true });
    expect(httpClient.patch).toHaveBeenCalledWith('/jobs/job-1/warnings/acknowledged', { kind: 'dropped_blocks', raws: ['a'], acknowledged: true });
  });

  it('retryEnhancement POSTs one batch to the retry-enhancement sub-route', async () => {
    (httpClient.post as any).mockResolvedValue({ data: { enhanced: ['n0'], failed: [], skipped: [] } });
    const result = await retryEnhancement('job-1', { kind: 'enhancement_call_failed', pass: 'synthesis', localIds: ['n0'] });
    expect(httpClient.post).toHaveBeenCalledWith('/jobs/job-1/warnings/retry-enhancement', { kind: 'enhancement_call_failed', pass: 'synthesis', localIds: ['n0'] });
    expect(result.enhanced).toEqual(['n0']);
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

  it('retryTraceLinkWrite POSTs to the trace-link retry sub-route with no body', async () => {
    (httpClient.post as any).mockResolvedValue({ data: { written: true, sourceAdoId: 100, targetAdoId: 200 } });
    const result = await retryTraceLinkWrite('job-1', 'failure-1');
    expect(httpClient.post).toHaveBeenCalledWith('/jobs/job-1/trace-links/failure-1/retry');
    expect(result).toEqual({ written: true, sourceAdoId: 100, targetAdoId: 200 });
  });

  it('validateCreatedTree GETs the validate sub-route', async () => {
    const validationResult = { valid: false, checkedCount: 2, mismatches: [{ localId: 'n0', adoWorkItemId: 42, field: 'System.Title', expected: 'T', actual: 'T2' }] };
    (httpClient.get as any).mockResolvedValue({ data: validationResult });
    const result = await validateCreatedTree('job-1');
    expect(httpClient.get).toHaveBeenCalledWith('/jobs/job-1/validate');
    expect(result).toEqual(validationResult);
  });

  // The overview is a study of the document and a long one takes minutes, so the answer streams: progress and heartbeat lines while it works,
  // then one result (or error) line. The wizard shows them so the wait does not look stuck.
  describe('previewExposition', () => {
    const documentMap = [{ number: null, title: 'Intro', blockCount: 5, figureCount: 0 }];
    const params = { file: new File(['doc'], 'spec.docx'), documentMap, sectionCount: 1, depth: 2 };

    function ndjson(lines: object[], chunk = (text: string) => [text]): Response {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const piece of chunk(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')) controller.enqueue(encoder.encode(piece));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
    }

    beforeEach(() => {
      vi.clearAllMocks();
      vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    it('posts the document as multipart asking for a stream, and resolves with the overview', async () => {
      vi.mocked(fetch).mockResolvedValue(ndjson([{ type: 'result', overview: { synopsis: 'Defines 2 terms.', caveat: null } }]));

      const result = await previewExposition({ ...params, model: 'gemma4:12b' });

      expect(result).toEqual({ synopsis: 'Defines 2 terms.', caveat: null });
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/jobs/preview/exposition/stream');
      expect(init.method).toBe('POST');
      expect(init.credentials).toBe('include');
      expect((init.headers as Record<string, string>).Accept).toBe('application/x-ndjson');
      const form = init.body as FormData;
      expect((form.get('file') as File).name).toBe('spec.docx');
      expect(form.get('documentMap')).toBe(JSON.stringify(documentMap));
      expect(form.get('sectionCount')).toBe('1');
      expect(form.get('depth')).toBe('2');
      expect(form.get('model')).toBe('gemma4:12b');
    });

    it('sends no model field when none was chosen', async () => {
      vi.mocked(fetch).mockResolvedValue(ndjson([{ type: 'result', overview: null }]));
      await previewExposition(params);
      const form = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as FormData;
      expect(form.get('model')).toBeNull();
    });

    it('reports progress and heartbeats as they arrive, even when a line is split across chunks', async () => {
      const lines = [
        { type: 'progress', done: 0, total: 3, elapsed: 0 },
        { type: 'heartbeat', elapsed: 5 },
        { type: 'progress', done: 2, total: 3, elapsed: 9 },
        { type: 'result', overview: null },
      ];
      vi.mocked(fetch).mockResolvedValue(ndjson(lines, (text) => [text.slice(0, 17), text.slice(17, 60), text.slice(60)]));
      const seen: unknown[] = [];

      await previewExposition(params, (progress) => seen.push(progress));

      expect(seen).toEqual([{ done: 0, total: 3, elapsed: 0 }, { elapsed: 5 }, { done: 2, total: 3, elapsed: 9 }]);
    });

    it('resolves null when the study produced no overview', async () => {
      vi.mocked(fetch).mockResolvedValue(ndjson([{ type: 'result', overview: null }]));
      expect(await previewExposition(params)).toBeNull();
    });

    it('rejects with the reason when the stream ends in an error line', async () => {
      vi.mocked(fetch).mockResolvedValue(ndjson([{ type: 'error', status: 502, detail: 'ingestion unavailable' }]));
      await expect(previewExposition(params)).rejects.toThrow('ingestion unavailable');
    });

    it('rejects when the stream ends without a result (the connection was lost)', async () => {
      vi.mocked(fetch).mockResolvedValue(ndjson([{ type: 'progress', done: 1, total: 3, elapsed: 4 }]));
      await expect(previewExposition(params)).rejects.toThrow(/connection/i);
    });

    it('rejects on an HTTP error status', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('nope', { status: 500 }));
      await expect(previewExposition(params)).rejects.toThrow(/500/);
    });
  });

  describe('submitJob with documentOverview', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('appends documentOverview to the form data when provided', async () => {
      vi.mocked(httpClient.post).mockResolvedValue({ data: { jobId: 'job-1' } } as any);

      await submitJob({
        file: new File(['x'], 'doc.docx'),
        areaPath: 'Project\\Area1',
        mode: 'survey',
        documentOverview: { synopsis: 'About a backplane.', caveat: null },
      });

      const calls = vi.mocked(httpClient.post).mock.calls;
      const formData = calls[calls.length - 1][1] as FormData;
      expect(formData.get('documentOverview')).toBe(JSON.stringify({ synopsis: 'About a backplane.', caveat: null }));
    });

    it('omits documentOverview from the form data when not provided', async () => {
      vi.mocked(httpClient.post).mockResolvedValue({ data: { jobId: 'job-1' } } as any);

      await submitJob({ file: new File(['x'], 'doc.docx'), areaPath: 'Project\\Area1', mode: 'baseline' });

      const calls = vi.mocked(httpClient.post).mock.calls;
      const formData = calls[calls.length - 1][1] as FormData;
      expect(formData.get('documentOverview')).toBeNull();
    });
  });

  it('explainScore POSTs to the score-explain sub-route, with the chosen categories only when there are some', async () => {
    (httpClient.post as any).mockResolvedValue({ data: { explanations: [], basis: 'built_in', rubric: { source: 'default', version: 'v' } } });
    await explainScore('job-1', 'n0');
    expect(httpClient.post).toHaveBeenLastCalledWith('/jobs/job-1/diff/n0/score-explain', {});
    await explainScore('job-1', 'n0', ['Verifiable']);
    expect(httpClient.post).toHaveBeenLastCalledWith('/jobs/job-1/diff/n0/score-explain', { categories: ['Verifiable'] });
  });
});
