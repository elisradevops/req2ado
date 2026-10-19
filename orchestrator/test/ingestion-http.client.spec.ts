import { IngestionHttpClient, IngestionHttpError } from '../src/modules/pipeline/ingestion-http.client';
import type { CanonicalDoc } from '@req2ado/shared-ts';

// level()'s doc param is now typed CanonicalDoc (S10) -- these tests only
// care about pass-through serialization to /level's body, not real document
// content, so a minimal-but-complete fixture (every required field present)
// replaces the previous `{ blocks: [] }` shorthand that no longer satisfies
// the stricter, generated type.
const MINIMAL_DOC: CanonicalDoc = { document: { path: 'x.txt', format: 'txt', sha256: 'h' }, blocks: [], tables: [], figures: [] };

describe('IngestionHttpClient', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('POSTs a multipart file to /ingest and returns the parsed CanonicalDoc', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ document: { path: 'x.txt' }, blocks: [], tables: [], figures: [] }),
    });
    const client = new IngestionHttpClient('http://ingestion.internal');
    const result = await client.ingest(Buffer.from('hello world'), 'x.txt');

    expect(result).toEqual({ document: { path: 'x.txt' }, blocks: [], tables: [], figures: [] });
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/ingest?mode=baseline');
    expect(options.method).toBe('POST');
    expect(options.body).toBeInstanceOf(FormData);
  });

  it('uses the long-running dispatcher for /ingest, same as /level', async () => {
    // Regression: /ingest previously used the plain default-timeout fetch --
    // fine when it was pure CPU-bound parsing, but real job submission's
    // vision captioning (one sequential LLM call per figure, same
    // cold-start-latency profile as /level's calls) can exceed undici's
    // default 300s headersTimeout. Confirmed live: a real 36-figure docx
    // failed with HeadersTimeoutError at exactly 5:04 after submit.
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ document: { path: 'x.docx' }, blocks: [], tables: [], figures: [] }),
    });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.ingest(Buffer.from('hello world'), 'x.docx');

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(options.dispatcher).toBeDefined();
  });

  it('appends skip_vision=true to /ingest when skipVision is passed', async () => {
    // Regression: /jobs/preview only needs blockCount/sectionCount/fileType,
    // never figure captions -- without this a merely-previewed document's
    // images paid the full per-image vision-LLM cost (confirmed live: 28s
    // instead of ~30ms for one small embedded image).
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ document: { path: 'x.docx' }, blocks: [], tables: [], figures: [] }),
    });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.ingest(Buffer.from('hello world'), 'x.docx', true);

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/ingest?mode=baseline&skip_vision=true');
  });

  it('omits skip_vision from /ingest when skipVision is not passed (real job submission)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ document: { path: 'x.docx' }, blocks: [], tables: [], figures: [] }),
    });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.ingest(Buffer.from('hello world'), 'x.docx');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/ingest?mode=baseline');
  });

  it('threads mode=survey through to /ingest so BASELINE never opens the vision gate for a SURVEY job either way', async () => {
    // Regression guard for the mode gate itself (main.py's /ingest): BASELINE
    // is contractually verbatim/no-AI, so a figure caption must never be
    // model-authored there. mode defaults to 'baseline' (matching /ingest's
    // own default) and pipeline.worker.ts must thread the real job.mode
    // through -- this proves the client-side plumbing for that.
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ document: { path: 'x.docx' }, blocks: [], tables: [], figures: [] }),
    });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.ingest(Buffer.from('hello world'), 'x.docx', false, 'survey');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/ingest?mode=survey');
  });

  it('forwards primerContext as a primer_context query param when provided', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => MINIMAL_DOC });
    const client = new IngestionHttpClient('http://ingestion.internal');

    await client.ingest(Buffer.from('file'), 'doc.pdf', false, 'survey', 'job-1', 'This is an avionics ICD.');

    // The overview is model-written text about the customer's document: it travels in a header (base64 of the UTF-8
    // text, any language), never in the URL, because the server's access log records the whole URL.
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(new URL(url).searchParams.has('primer_context')).toBe(false);
    expect(options.headers['X-Req2Ado-Primer-Context']).toBe(Buffer.from('This is an avionics ICD.', 'utf8').toString('base64'));
  });

  it('omits primer_context from the query string when not provided -- unchanged from pre-Task-4 behavior', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => MINIMAL_DOC });
    const client = new IngestionHttpClient('http://ingestion.internal');

    await client.ingest(Buffer.from('file'), 'doc.pdf', false, 'survey', 'job-1');

    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).not.toContain('primer_context');
    expect(options.headers?.['X-Req2Ado-Primer-Context']).toBeUndefined();
  });

  it('sends the user id and a non-ASCII primer in headers, never in the URL, on /ingest', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => MINIMAL_DOC });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.ingest(Buffer.from('file'), 'doc.pdf', false, 'survey', 'job-1', 'מסמך דרישות', undefined, 'user-1');

    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).not.toContain('user-1');
    expect(url).not.toContain('primer');
    expect(options.headers['X-Req2Ado-User-Id']).toBe('user-1');
    expect(Buffer.from(options.headers['X-Req2Ado-Primer-Context'], 'base64').toString('utf8')).toBe('מסמך דרישות');
  });

  it('forwards visionModel and visionSkipReason as vision_model / vision_skip_reason when provided', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => MINIMAL_DOC });
    const client = new IngestionHttpClient('http://ingestion.internal');

    await client.ingest(Buffer.from('file'), 'doc.pdf', true, 'survey', 'job-1', undefined, undefined, 'user-1', 'claude-opus-4-8', 'model_not_vision_capable');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    const params = new URL(url).searchParams;
    expect(params.get('vision_model')).toBe('claude-opus-4-8');
    expect(params.get('vision_skip_reason')).toBe('model_not_vision_capable');
  });

  it('omits vision_model and vision_skip_reason when not provided', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => MINIMAL_DOC });
    const client = new IngestionHttpClient('http://ingestion.internal');

    await client.ingest(Buffer.from('file'), 'doc.pdf', false, 'survey', 'job-1');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).not.toContain('vision_model');
    expect(url).not.toContain('vision_skip_reason');
  });

  it('forwards languages as an OCR-language query param when provided (NEW-04)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => MINIMAL_DOC });
    const client = new IngestionHttpClient('http://ingestion.internal');

    await client.ingest(Buffer.from('file'), 'doc.pdf', false, 'baseline', undefined, undefined, 'heb+eng');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(new URL(url).searchParams.get('languages')).toBe('heb+eng');
  });

  it('omits languages from the query string when not provided -- ingestion keeps its own "eng" default', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => MINIMAL_DOC });
    const client = new IngestionHttpClient('http://ingestion.internal');

    await client.ingest(Buffer.from('file'), 'doc.pdf', false, 'baseline');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).not.toContain('languages');
  });

  it('throws on a non-ok /ingest response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 422 });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await expect(client.ingest(Buffer.from('bad'), 'x.txt')).rejects.toThrow(/ingest.*422/i);
  });

  it('POSTs the doc to /level with mode as a query param', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level(MINIMAL_DOC);

    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/level?mode=baseline');
    expect(JSON.parse(options.body)).toEqual(MINIMAL_DOC);
  });

  it('defaults mode to baseline when not provided', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level(MINIMAL_DOC);

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toContain('mode=baseline');
  });

  it('passes mode=survey through as a query param when specified', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level(MINIMAL_DOC, 'survey');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/level?mode=survey');
  });

  it('throws on a non-ok /level response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await expect(client.level(MINIMAL_DOC)).rejects.toThrow(/level.*500/i);
  });

  it('forwards user_id (KB scope) as a query param when provided', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level(MINIMAL_DOC, 'survey', 'user-descriptor-1');

    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/level?mode=survey');
    expect(options.headers['X-Req2Ado-User-Id']).toBe('user-descriptor-1');
  });

  it('omits user_id when not provided, matching pre-existing behavior', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level(MINIMAL_DOC, 'survey');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/level?mode=survey');
  });

  it('forwards model as a query param when provided (per-job LLM model override)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level(MINIMAL_DOC, 'survey', undefined, undefined, 'qwen2.5:1.5b');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(new URL(url).searchParams.get('model')).toBe('qwen2.5:1.5b');
  });

  it('omits model when not provided, matching pre-model-selection behavior', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level(MINIMAL_DOC, 'survey');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(new URL(url).searchParams.has('model')).toBe(false);
  });

  it('forwards job_id as a query param when provided (SURVEY narration threading)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level(MINIMAL_DOC, 'survey', undefined, undefined, undefined, 'job-123');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(new URL(url).searchParams.get('job_id')).toBe('job-123');
  });

  it('omits job_id when not provided', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level(MINIMAL_DOC, 'survey');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(new URL(url).searchParams.has('job_id')).toBe(false);
  });

  it('forwards primerContext as a primer_context query param when provided (Phase 6c whole-document primer)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level(MINIMAL_DOC, 'survey', undefined, undefined, undefined, undefined, 'This is an avionics ICD.');

    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(new URL(url).searchParams.has('primer_context')).toBe(false);
    expect(options.headers['X-Req2Ado-Primer-Context']).toBe(Buffer.from('This is an avionics ICD.', 'utf8').toString('base64'));
  });

  it('omits primer_context when not provided, matching pre-Phase-6c behavior', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level(MINIMAL_DOC, 'survey');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(new URL(url).searchParams.has('primer_context')).toBe(false);
  });

  it('serializes link_type_catalog with snake_case keys (ingestion/Python is the wire contract, not this side\'s camelCase AdoLinkType)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level(MINIMAL_DOC, 'survey', 'Project\\Area1', [
      { referenceName: 'Elisra.CoveredBy-Forward', name: 'Covers', semanticHint: 'source covers target' },
      { referenceName: 'System.LinkTypes.Related', name: 'Related' },
    ]);

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    const catalogParam = new URL(url).searchParams.get('link_type_catalog');
    expect(JSON.parse(catalogParam!)).toEqual([
      { reference_name: 'Elisra.CoveredBy-Forward', name: 'Covers', semantic_hint: 'source covers target' },
      { reference_name: 'System.LinkTypes.Related', name: 'Related', semantic_hint: null },
    ]);
  });

  it('upsertDedupEntriesBatch POSTs all items (including title) to /dedup/upsert-batch in one call', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.upsertDedupEntriesBatch([
      { itemId: '1', text: 'a', title: 'Title A', areaPath: 'Proj\\Area' },
      { itemId: '2', text: 'b', title: 'Title B', areaPath: 'Proj\\Area' },
    ]);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/dedup/upsert-batch');
    expect(JSON.parse(options.body)).toEqual({
      items: [
        { item_id: '1', text: 'a', title: 'Title A', area_path: 'Proj\\Area' },
        { item_id: '2', text: 'b', title: 'Title B', area_path: 'Proj\\Area' },
      ],
    });
  });

  it('upsertDedupEntriesBatch makes no HTTP call at all for an empty list', async () => {
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.upsertDedupEntriesBatch([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws on a non-ok /dedup/upsert-batch response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 502 });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await expect(
      client.upsertDedupEntriesBatch([{ itemId: '1', text: 'a', title: 'Title A', areaPath: 'Proj\\Area' }]),
    ).rejects.toThrow(/upsert-batch.*502/i);
  });

  it('checkDuplicate POSTs text, title, and area_path to /dedup/check', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ is_duplicate: true, matched_item_id: '649', similarity: 0.92 }),
    });
    const client = new IngestionHttpClient('http://ingestion.internal');
    const result = await client.checkDuplicate('a description', 'a title', 'Proj\\Area');

    expect(result).toEqual({ isDuplicate: true, matchedItemId: '649', similarity: 0.92 });
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/dedup/check');
    expect(JSON.parse(options.body)).toEqual({ text: 'a description', title: 'a title', area_path: 'Proj\\Area' });
  });

  it('checkDuplicate includes threshold in the request body when provided', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ is_duplicate: false, matched_item_id: null, similarity: null }),
    });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.checkDuplicate('a description', 'a title', 'Proj\\Area', 0.75);

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      text: 'a description',
      title: 'a title',
      area_path: 'Proj\\Area',
      threshold: 0.75,
    });
  });

  it('checkDuplicate omits threshold from the request body when not provided', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ is_duplicate: false, matched_item_id: null, similarity: null }),
    });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.checkDuplicate('a description', 'a title', 'Proj\\Area');

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ text: 'a description', title: 'a title', area_path: 'Proj\\Area' });
  });

  it('checkDuplicate sends job_id only when a job id is given (job transparency B9b)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ is_duplicate: false, matched_item_id: null, similarity: null }),
    });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.checkDuplicate('a description', 'a title', 'Proj\\Area', undefined, 'user-1', 'job-7');

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      text: 'a description',
      title: 'a title',
      area_path: 'Proj\\Area',
      user_id: 'user-1',
      job_id: 'job-7',
    });
  });

  it('throws on a non-ok /dedup/check response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 502 });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await expect(client.checkDuplicate('text', 'title', 'Proj\\Area')).rejects.toThrow(/dedup\/check.*502/i);
  });

  it('upsertDedupEntry POSTs item_id, text, title, and area_path to /dedup/upsert', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.upsertDedupEntry('1', 'a description', 'a title', 'Proj\\Area');

    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/dedup/upsert');
    expect(JSON.parse(options.body)).toEqual({ item_id: '1', text: 'a description', title: 'a title', area_path: 'Proj\\Area' });
  });

  it('purgeUserKb sends a DELETE to /kb/collection with user_id as a query param', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.purgeUserKb('vstfs:///Framework/Identity/old-user');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/kb/collection?user_id=vstfs%3A%2F%2F%2FFramework%2FIdentity%2Fold-user');
    expect(options.method).toBe('DELETE');
  });

  it('throws on a non-ok purgeUserKb response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await expect(client.purgeUserKb('some-user')).rejects.toThrow(/kb\/collection.*500/i);
  });
});

describe('IngestionHttpClient.ingestUrl', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('posts snake_case fields to /kb/ingest-url and maps the snake_case response to camelCase', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        document_name: 'doc.pdf',
        driveitem_id: 'drive-1',
        mime_type: 'application/pdf',
        size_bytes: 1024,
        chunks_stored: 3,
        skipped_unchanged: false,
      }),
    });
    global.fetch = mockFetch as any;

    const client = new IngestionHttpClient('http://ingestion:8000');
    const result = await client.ingestUrl('https://contoso.sharepoint.com/sites/s/doc.pdf', 'Project\\Area1', 'SRD');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://ingestion:8000/kb/ingest-url',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          url: 'https://contoso.sharepoint.com/sites/s/doc.pdf',
          user_id: 'Project\\Area1',
          doc_type: 'SRD',
          graph_token: null,
          retrieval_mode: null,
        }),
      }),
    );
    expect(result).toEqual({
      documentName: 'doc.pdf',
      driveitemId: 'drive-1',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      chunksStored: 3,
      skippedUnchanged: false,
    });
  });

  it('forwards retrievalMode as retrieval_mode in the request body', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        document_name: 'standards.docx', driveitem_id: 'drive-2', mime_type: null,
        size_bytes: 10, chunks_stored: 1, skipped_unchanged: false,
      }),
    });
    global.fetch = mockFetch as any;

    const client = new IngestionHttpClient('http://ingestion:8000');
    await client.ingestUrl('https://contoso.sharepoint.com/sites/s/standards.docx', 'Project\\Area1', null, null, 'always_include');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://ingestion:8000/kb/ingest-url',
      expect.objectContaining({
        body: JSON.stringify({
          url: 'https://contoso.sharepoint.com/sites/s/standards.docx',
          user_id: 'Project\\Area1',
          doc_type: null,
          graph_token: null,
          retrieval_mode: 'always_include',
        }),
      }),
    );
  });

  it('throws an IngestionHttpError carrying the status on a non-ok response', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400 }) as any;
    const client = new IngestionHttpClient('http://ingestion:8000');
    await expect(
      client.ingestUrl('https://contoso.sharepoint.com/sites/s/doc.pdf', 'Project\\Area1', null),
    ).rejects.toThrow(IngestionHttpError);

    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400 }) as any;
    try {
      await client.ingestUrl('https://contoso.sharepoint.com/sites/s/doc.pdf', 'Project\\Area1', null);
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IngestionHttpError);
      expect((err as IngestionHttpError).status).toBe(400);
    }
  });
});

describe('IngestionHttpClient.ingestFolderUrl', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('posts snake_case fields to /kb/ingest-folder-url and maps the file list to camelCase', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        files: [
          { file: 'a.docx', status: 'ingested', chunks_stored: 2, driveitem_id: 'drive-a', mime_type: 'application/a', size_bytes: 100, reason: null, relative_path: 'a.docx' },
          { file: 'bad.docx', status: 'failed', chunks_stored: 0, driveitem_id: null, mime_type: null, size_bytes: null, reason: 'corrupt', relative_path: null },
        ],
      }),
    });
    global.fetch = mockFetch as any;

    const client = new IngestionHttpClient('http://ingestion:8000');
    const result = await client.ingestFolderUrl('https://contoso.sharepoint.com/sites/s/folder', 'Project\\Area1', 'SRD');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://ingestion:8000/kb/ingest-folder-url',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ url: 'https://contoso.sharepoint.com/sites/s/folder', user_id: 'Project\\Area1', doc_type: 'SRD', recursive: false, graph_token: null }),
      }),
    );
    expect(result).toEqual({
      files: [
        { file: 'a.docx', status: 'ingested', chunksStored: 2, driveitemId: 'drive-a', mimeType: 'application/a', sizeBytes: 100, reason: null, relativePath: 'a.docx' },
        { file: 'bad.docx', status: 'failed', chunksStored: 0, driveitemId: null, mimeType: null, sizeBytes: null, reason: 'corrupt', relativePath: null },
      ],
    });
  });

  it('sends recursive:true when requested', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ files: [] }) });
    global.fetch = mockFetch as any;

    const client = new IngestionHttpClient('http://ingestion:8000');
    await client.ingestFolderUrl('https://contoso.sharepoint.com/sites/s/folder', 'Project\\Area1', 'SRD', true);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://ingestion:8000/kb/ingest-folder-url',
      expect.objectContaining({
        body: JSON.stringify({ url: 'https://contoso.sharepoint.com/sites/s/folder', user_id: 'Project\\Area1', doc_type: 'SRD', recursive: true, graph_token: null }),
      }),
    );
  });

  it('throws an IngestionHttpError carrying the status on a non-ok response', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 }) as any;
    const client = new IngestionHttpClient('http://ingestion:8000');
    await expect(
      client.ingestFolderUrl('https://contoso.sharepoint.com/sites/s/folder', 'Project\\Area1', null),
    ).rejects.toThrow(IngestionHttpError);
  });
});

describe('IngestionHttpClient.getSharePointStatus', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('posts the optional override token and maps the snake_case response', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'valid', expires_in_seconds: 2820 }),
    });
    global.fetch = mockFetch as any;

    const client = new IngestionHttpClient('http://ingestion:8000');
    const result = await client.getSharePointStatus('override-token');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://ingestion:8000/kb/sharepoint/status',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ graph_token: 'override-token' }),
      }),
    );
    expect(result).toEqual({ status: 'valid', expiresInSeconds: 2820 });
  });

  it('sends graph_token: null when no override is given', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'not_configured', expires_in_seconds: null }),
    });
    global.fetch = mockFetch as any;

    const client = new IngestionHttpClient('http://ingestion:8000');
    await client.getSharePointStatus();

    expect(mockFetch).toHaveBeenCalledWith(
      'http://ingestion:8000/kb/sharepoint/status',
      expect.objectContaining({ body: JSON.stringify({ graph_token: null }) }),
    );
  });

  it('throws an IngestionHttpError on a non-ok response', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 502 }) as any;
    const client = new IngestionHttpClient('http://ingestion:8000');
    await expect(client.getSharePointStatus()).rejects.toThrow(IngestionHttpError);
  });
});
