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

  it('passes the abort signal to the /ingest request, so a cancelled job stops the parse and its figure calls', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ blocks: [] }) });
    const controller = new AbortController();
    await new IngestionHttpClient('http://ingestion.internal').ingest(
      Buffer.from('x'), 'x.txt', false, 'survey', 'job-1', undefined, undefined, 'user-1', undefined, undefined, controller.signal,
    );
    expect((global.fetch as jest.Mock).mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('sends no signal when none is given (preview and every earlier call site)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ blocks: [] }) });
    await new IngestionHttpClient('http://ingestion.internal').ingest(Buffer.from('x'), 'x.txt');
    expect((global.fetch as jest.Mock).mock.calls[0][1].signal).toBeUndefined();
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

  it('publishDocumentMap POSTs the document to /document-map for the job and never throws', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ published: true }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await expect(client.publishDocumentMap(MINIMAL_DOC, 'job-1')).resolves.toBe(true);
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/document-map?job_id=job-1');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual(MINIMAL_DOC);

    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    await expect(client.publishDocumentMap(MINIMAL_DOC, 'job-1')).resolves.toBe(false);
    (global.fetch as jest.Mock).mockRejectedValue(new Error('down'));
    await expect(client.publishDocumentMap(MINIMAL_DOC, 'job-1')).resolves.toBe(false);
  });

  it('sourceExcerpt POSTs the original and the span to /source-excerpt and returns the wording', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ text: 'The unit shall start.', truncated: false, kind: 'table' }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    const signal = new AbortController().signal;

    const result = await client.sourceExcerpt(
      Buffer.from('docx'),
      'spec.docx',
      { startOffset: 80, endOffset: 81, page: 2, extent: 'section', rowHint: 'PWR-7', languages: 'heb+eng' },
      signal,
    );

    expect(result).toEqual({ text: 'The unit shall start.', truncated: false, kind: 'table' });
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/source-excerpt?start_offset=80&end_offset=81&extent=section&page=2&row_hint=PWR-7&languages=heb%2Beng');
    expect(options.method).toBe('POST');
    expect(options.body).toBeInstanceOf(FormData);
    expect(options.signal).toBe(signal);
  });

  it('sourceExcerpt leaves out what is not set, and throws on a failed request', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ text: '', truncated: false, kind: 'unavailable' }) });
    const client = new IngestionHttpClient('http://ingestion.internal');

    await client.sourceExcerpt(Buffer.from('x'), 'x.txt', { startOffset: 0, endOffset: 5, page: null, extent: 'span', rowHint: null });
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('http://ingestion.internal/source-excerpt?start_offset=0&end_offset=5&extent=span');

    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    await expect(client.sourceExcerpt(Buffer.from('x'), 'x.txt', { startOffset: 0, endOffset: 5, page: null, extent: 'span', rowHint: null })).rejects.toThrow(
      /source-excerpt/,
    );
  });

  it('checkDuplicate POSTs text, title, and area_path to /dedup/check', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ is_duplicate: true, matched_item_id: '649', similarity: 0.92 }),
    });
    const client = new IngestionHttpClient('http://ingestion.internal');
    const result = await client.checkDuplicate('a description', 'a title', 'Proj\\Area');

    expect(result).toEqual({ isDuplicate: true, matchedItemId: '649', similarity: 0.92, judgeVerdict: null, matchedText: null });
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/dedup/check');
    expect(JSON.parse(options.body)).toEqual({ text: 'a description', title: 'a title', area_path: 'Proj\\Area' });
  });

  it('checkDuplicate passes on the judge verdict and the matched item text, for the decision log', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ is_duplicate: false, matched_item_id: '649', similarity: 0.93, judge_verdict: 'distinct', matched_text: 'The existing requirement.' }),
    });
    const client = new IngestionHttpClient('http://ingestion.internal');

    const result = await client.checkDuplicate('a description', 'a title', 'Proj\\Area');

    expect(result).toEqual({ isDuplicate: false, matchedItemId: '649', similarity: 0.93, judgeVerdict: 'distinct', matchedText: 'The existing requirement.' });
  });

  it('checkDuplicate says what kind of item it is and how wide to search, and leaves both out when not given', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ is_duplicate: false, matched_item_id: null, similarity: null }) }) as any;
    const client = new IngestionHttpClient('http://ingestion:8000');

    await client.checkDuplicate('d', 't', 'Proj\\Area', undefined, undefined, undefined, { typeCategory: 'Requirement', scope: 'project' });
    await client.checkDuplicate('d', 't', 'Proj\\Area');

    const [first, second] = (global.fetch as jest.Mock).mock.calls.map((call) => JSON.parse(call[1].body));
    expect(first).toMatchObject({ type_category: 'Requirement', scope: 'project' });
    expect(second).not.toHaveProperty('type_category');
    expect(second).not.toHaveProperty('scope');
  });

  it('upsertDedupEntry and the batch carry the kind of each item', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }) as any;
    const client = new IngestionHttpClient('http://ingestion:8000');

    await client.upsertDedupEntry('1', 'a', 'A', 'Proj\\Area', undefined, 'Feature');
    await client.upsertDedupEntriesBatch([{ itemId: '2', text: 'b', title: 'B', areaPath: 'Proj\\Area', typeCategory: 'Epic' }, { itemId: '3', text: 'c', title: 'C', areaPath: 'Proj\\Area' }]);

    const [single, batch] = (global.fetch as jest.Mock).mock.calls.map((call) => JSON.parse(call[1].body));
    expect(single.type_category).toBe('Feature');
    expect(batch.items[0].type_category).toBe('Epic');
    expect(batch.items[1]).not.toHaveProperty('type_category');
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
    // the destructive route needs the exact user id repeated as a confirmation
    expect(options.headers['X-Req2Ado-Confirm-Purge']).toBe('vstfs:///Framework/Identity/old-user');
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
        chunks_in_store: 3,
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
      chunksInStore: 3,
      skippedUnchanged: false,
    });
  });

  it('maps the drive a file is in, for a single url and for each file of a folder, and leaves it out when not sent', async () => {
    const body = { document_name: 'd.pdf', driveitem_id: 'item-1', mime_type: null, size_bytes: 1, chunks_stored: 1, skipped_unchanged: false };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...body, drive_id: 'drive-9' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => body })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [{ file: 'a.docx', status: 'ingested', chunks_stored: 1, driveitem_id: 'd', mime_type: null, size_bytes: 1, reason: null, relative_path: 'a.docx', drive_id: 'drive-9' }] }),
      }) as any;

    const client = new IngestionHttpClient('http://ingestion:8000');
    expect((await client.ingestUrl('https://x/d.pdf', 'u', null)).driveId).toBe('drive-9');
    expect((await client.ingestUrl('https://x/d.pdf', 'u', null)).driveId).toBeUndefined();
    expect((await client.ingestFolderUrl('https://x/folder', 'u', null)).files[0].driveId).toBe('drive-9');
  });

  it('maps chunks_in_store, and null when an older ingestion service omits it (count unknown, not 0)', async () => {
    const body = { document_name: 'd.pdf', driveitem_id: 'drive-1', mime_type: null, size_bytes: 1, chunks_stored: 0, skipped_unchanged: true };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...body, chunks_in_store: 32 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => body })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...body, chunks_in_store: 5 }) }) as any;

    const client = new IngestionHttpClient('http://ingestion:8000');
    expect((await client.ingestUrl('https://x/d.pdf', 'u', null)).chunksInStore).toBe(32);
    expect((await client.ingestUrl('https://x/d.pdf', 'u', null)).chunksInStore).toBeNull();
    expect((await client.ingestItem('d.pdf', 'drive-1', 'https://dl', 'u', null)).chunksInStore).toBe(5);

    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => body }) as any;
    expect((await client.ingestItem('d.pdf', 'drive-1', 'https://dl', 'u', null)).chunksInStore).toBeNull();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ files: [{ file: 'a.docx', status: 'skipped_unchanged', chunks_stored: 0, driveitem_id: 'd', mime_type: null, size_bytes: 1, reason: null, relative_path: 'a.docx' }] }),
    }) as any;
    expect((await client.ingestFolderUrl('https://x/folder', 'u', null)).files[0].chunksInStore).toBeNull();
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
          { file: 'a.docx', status: 'ingested', chunks_stored: 2, chunks_in_store: 2, driveitem_id: 'drive-a', mime_type: 'application/a', size_bytes: 100, reason: null, relative_path: 'a.docx' },
          { file: 'bad.docx', status: 'failed', chunks_stored: 0, chunks_in_store: 0, driveitem_id: null, mime_type: null, size_bytes: null, reason: 'corrupt', relative_path: null },
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
        { file: 'a.docx', status: 'ingested', chunksStored: 2, chunksInStore: 2, driveitemId: 'drive-a', mimeType: 'application/a', sizeBytes: 100, reason: null, relativePath: 'a.docx' },
        { file: 'bad.docx', status: 'failed', chunksStored: 0, chunksInStore: 0, driveitemId: null, mimeType: null, sizeBytes: null, reason: 'corrupt', relativePath: null },
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

describe('IngestionHttpClient.compareRewrite', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });
  const comparison = {
    before: { score: 64, issues: [], categoryScores: { Testable: 60 }, confidence: 'high' },
    after: { score: 71, issues: [], categoryScores: { Testable: 80 }, confidence: 'high' },
    delta: 7,
    categoryDeltas: { Testable: 20 },
    warnings: [{ code: 'title_changed', severity: 'notice', detail: 'x' }],
  };

  it('posts both texts with the item categories and the user, and returns the comparison as ingestion answers it', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => comparison });
    const result = await new IngestionHttpClient('http://ingestion.internal').compareRewrite(
      { title: 'T', description: 'old' },
      { title: null, description: 'new' },
      ['Testable'],
      'user-1',
      'claude-opus-4-8',
    );
    expect(result).toEqual(comparison);
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/rewrite/compare');
    expect(JSON.parse(options.body)).toEqual({
      original_title: 'T',
      original_description: 'old',
      proposed_title: null,
      proposed_description: 'new',
      category_checklist: ['Testable'],
      user_id: 'user-1',
      model: 'claude-opus-4-8',
    });
  });

  it('asks for the warnings only when told to, so they come back without waiting for a model call', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => comparison });
    await new IngestionHttpClient('http://ingestion.internal').compareRewrite(
      { title: 'T', description: 'old' },
      { title: null, description: 'new' },
      null,
      'user-1',
      undefined,
      { warningsOnly: true },
    );
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).warnings_only).toBe(true);
  });

  it('throws the ingestion error on a non-2xx answer (the 502 for "the model did not score both texts")', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      text: async () => JSON.stringify({ detail: 'the model did not score both texts' }),
      json: async () => ({ detail: 'the model did not score both texts' }),
    });
    await expect(
      new IngestionHttpClient('http://ingestion.internal').compareRewrite({ title: 'T', description: 'a' }, { title: null, description: 'b' }, null),
    ).rejects.toBeInstanceOf(IngestionHttpError);
  });
});


describe('IngestionHttpClient.cacheScope', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('reads the ingestion build and the user\'s stored profile version', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ ingestion: '0.3.15', profile: 'p1' }) });
    expect(await new IngestionHttpClient('http://ingestion.internal').cacheScope('user-1')).toEqual({ ingestion: '0.3.15', profile: 'p1' });
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/cache-scope'); // the user is not in the URL (access logs record URLs)
    expect(options.headers['X-Req2Ado-User-Id']).toBe('user-1');
  });

  it('is null when it cannot be read, so nothing is cached on a guess', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500, text: async () => '', json: async () => ({}) });
    expect(await new IngestionHttpClient('http://ingestion.internal').cacheScope('user-1')).toBeNull();
    (global.fetch as jest.Mock).mockRejectedValue(new Error('down'));
    expect(await new IngestionHttpClient('http://ingestion.internal').cacheScope('user-1')).toBeNull();
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nonsense: true }) });
    expect(await new IngestionHttpClient('http://ingestion.internal').cacheScope('user-1')).toBeNull();
  });
});


describe('IngestionHttpClient.prestudy', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ source: 'none' }) });
  });

  it('asks for a fresh study only when told to ("Read again"), and names the attached file in a header', async () => {
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.prestudy(MINIMAL_DOC, { userId: 'user-1', fileId: 'file-1' });
    await client.prestudy(MINIMAL_DOC, { userId: 'user-1', fresh: true });
    const [first, second] = (global.fetch as jest.Mock).mock.calls.map(([, options]) => options);
    expect(JSON.parse(first.body)).not.toHaveProperty('fresh');
    expect(first.headers['X-Req2Ado-File-Id']).toBe('file-1');
    expect(JSON.parse(second.body).fresh).toBe(true);
    expect(second.headers).not.toHaveProperty('X-Req2Ado-File-Id');
  });

  it('returns the breakdown of the file as ingestion gave it', async () => {
    const details = { approximate: false, tables: [], document: null };
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ source: 'model', details }) });
    expect((await new IngestionHttpClient('http://ingestion.internal').prestudy(MINIMAL_DOC, { userId: 'user-1' })).details).toEqual(details);
  });

  it('uses the long-running dispatcher, so its own 15-minute limit applies instead of fetch\'s default 300 s cut (seen live, 2026-11-26)', async () => {
    await new IngestionHttpClient('http://ingestion.internal').prestudy(MINIMAL_DOC, { userId: 'user-1' });
    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(options.dispatcher).toBeDefined();
  });
});


describe('IngestionHttpClient.level: which rubric the job was scored with', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });
  const call = (headers: Record<string, string>, scored?: { rubricVersion?: string | null; degraded?: boolean }) => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }, json: async () => ({ nodes: [] }) });
    return new IngestionHttpClient('http://ingestion.internal').level(MINIMAL_DOC, 'survey', 'user-1', undefined, 'm', 'job-1', undefined, scored);
  };

  it('reads the rubric version and the degraded flag from the response headers into the out parameter', async () => {
    const scored: { rubricVersion?: string | null; degraded?: boolean } = {};
    await call({ 'x-req2ado-rubric-version': 'p-built', 'x-req2ado-rubric-degraded': '1' }, scored);
    expect(scored).toEqual({ rubricVersion: 'p-built', degraded: true });
  });

  it('an empty version (no rubric: profile scoring is off) is null, and an older ingestion without the headers leaves it unknown', async () => {
    const empty: { rubricVersion?: string | null; degraded?: boolean } = {};
    await call({ 'x-req2ado-rubric-version': '' }, empty);
    expect(empty).toEqual({ rubricVersion: null, degraded: false });
    const unknown: { rubricVersion?: string | null; degraded?: boolean } = {};
    await call({}, unknown);
    expect(unknown.rubricVersion).toBeUndefined();
  });

  it('works without the out parameter and with a response that has no headers object (every older caller and test)', async () => {
    await expect(call({})).resolves.toEqual({ nodes: [] });
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    await expect(new IngestionHttpClient('http://ingestion.internal').level(MINIMAL_DOC, 'survey')).resolves.toEqual({ nodes: [] });
  });


  describe('ingestDriveItem()', () => {
    const body = { document_name: 'guide.pptx', driveitem_id: 'item-1', mime_type: 'application/pdf', size_bytes: 10, chunks_stored: 3, chunks_in_store: 3, skipped_unchanged: false };

    it('POSTs the drive and item ids (not a download URL) to /kb/ingest-drive-item and maps the result', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => body });
      const client = new IngestionHttpClient('http://ingestion:8000');

      const result = await client.ingestDriveItem('drive-1', 'item-1', 'user-1', 'SRD', 'vault-token', 'always_include');

      const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe('http://ingestion:8000/kb/ingest-drive-item');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual({
        drive_id: 'drive-1',
        item_id: 'item-1',
        user_id: 'user-1',
        doc_type: 'SRD',
        graph_token: 'vault-token',
        retrieval_mode: 'always_include',
      });
      expect(result).toEqual({
        documentName: 'guide.pptx',
        driveitemId: 'item-1',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        chunksStored: 3,
        chunksInStore: 3,
        skippedUnchanged: false,
      });
    });

    it('sends nulls for an absent token, mode and doc type', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => body });

      await new IngestionHttpClient('http://ingestion:8000').ingestDriveItem('drive-1', 'item-1', 'user-1', null);

      expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toMatchObject({ doc_type: null, graph_token: null, retrieval_mode: null });
    });

    it('passes the abort signal, so a caller can stop waiting for a slow file', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => body });
      const controller = new AbortController();

      await new IngestionHttpClient('http://ingestion:8000').ingestDriveItem('d', 'i', 'u', null, null, null, controller.signal);

      expect((global.fetch as jest.Mock).mock.calls[0][1].signal).toBe(controller.signal);
    });

    it('maps chunks_in_store to null when an older ingestion service omits it', async () => {
      const { chunks_in_store: _omitted, ...withoutCount } = body;
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => withoutCount });

      const result = await new IngestionHttpClient('http://ingestion:8000').ingestDriveItem('d', 'i', 'u', null);

      expect(result.chunksInStore).toBeNull();
    });

    it.each([401, 404, 400, 502])('throws an IngestionHttpError carrying the status %s', async (status) => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status, json: async () => ({ detail: 'nope' }), text: async () => '{"detail":"nope"}' });

      await expect(new IngestionHttpClient('http://ingestion:8000').ingestDriveItem('d', 'i', 'u', null)).rejects.toMatchObject({ status });
    });
  });

  describe('browsing: the drive each child lives in', () => {
    const child = (overrides: Record<string, unknown> = {}) => ({
      id: 'f1', name: 'a.pdf', mime_type: 'application/pdf', size_bytes: 5, is_folder: false, drive_id: null, parent_drive_id: 'drive-1', download_url: 'https://dl', ...overrides,
    });

    it('browseFolder() maps parent_drive_id to parentDriveId for files and folders alike', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => [child(), child({ id: 'd1', is_folder: true, drive_id: 'drive-1', download_url: null })],
      });

      const children = await new IngestionHttpClient('http://ingestion:8000').browseFolder('https://contoso.sharepoint.com/folder');

      expect(children.map((c) => [c.id, c.driveId, c.parentDriveId])).toEqual([
        ['f1', null, 'drive-1'],
        ['d1', 'drive-1', 'drive-1'],
      ]);
    });

    it('browseChildren() does too', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => [child({ parent_drive_id: 'drive-9' })] });

      const children = await new IngestionHttpClient('http://ingestion:8000').browseChildren('drive-9', 'folder-1');

      expect(children[0].parentDriveId).toBe('drive-9');
    });

    it('is null when an older ingestion service does not send it', async () => {
      const { parent_drive_id: _omitted, ...older } = child();
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => [older] });

      const children = await new IngestionHttpClient('http://ingestion:8000').browseFolder('https://contoso.sharepoint.com/folder');

      expect(children[0].parentDriveId).toBeNull();
    });
  });

  describe('getKbProfile()', () => {
    const stored = {
      version: 'v1', builtWith: 'm', docsInKb: 2, docsContributing: 1,
      profile: {
        built_at: '2026-11-11T10:00:00Z', truncated: false,
        docs: [{ file: 'a.pptx', status: 'contributed', reason: null, categories: 3, rules: 5, type_definitions: 1, glossary: 2 }],
        conflicts: [{ kind: 'type_definition', key: 'requirement', variants: [{ text: 'x', sources: ['a'] }, { text: 'y', sources: ['b'] }] }],
        categories: [], rules: [], glossary: [], type_definitions: [],
      },
    };

    it('GETs the stored profile for the user, encoding the id', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200, json: async () => stored });

      const result = await new IngestionHttpClient('http://ingestion:8000').getKbProfile('Project\\Area 1');

      expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('http://ingestion:8000/kb/profile?user_id=Project%5CArea+1');
      expect(result).toEqual(stored);
    });

    it('is null when no profile is stored yet', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 404, json: async () => ({}), text: async () => '' });

      expect(await new IngestionHttpClient('http://ingestion:8000').getKbProfile('u')).toBeNull();
    });

    it('throws an IngestionHttpError for any other failure', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500, json: async () => ({ detail: 'boom' }), text: async () => '{"detail":"boom"}' });

      await expect(new IngestionHttpClient('http://ingestion:8000').getKbProfile('u')).rejects.toMatchObject({ status: 500 });
    });
  });
});

describe('IngestionHttpClient: model-backed item calls', () => {
  it('send scoring, score explanation, rewrite comparison and item enhancement through the long-running dispatcher (no 300 s cut)', async () => {
    const seen: Record<string, unknown> = {};
    global.fetch = jest.fn(async (url: string, init?: { dispatcher?: unknown }) => {
      seen[new URL(url).pathname] = init?.dispatcher;
      throw new Error('stop here: only the request is checked');
    }) as unknown as typeof fetch;
    const client = new IngestionHttpClient('http://ingestion.internal') as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const call of ['scoreItem', 'explainScores', 'compareRewrite', 'enhanceItems']) {
      await client[call]({}, {}, {}).catch(() => undefined);
    }
    for (const path of ['/score-item', '/score-explain', '/rewrite/compare', '/enhance-items']) {
      expect(seen[path]).toBeDefined();
    }
  });
});
