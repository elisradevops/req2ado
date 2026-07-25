import { IngestionHttpClient, IngestionHttpError } from '../src/modules/pipeline/ingestion-http.client';

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
    expect(url).toBe('http://ingestion.internal/ingest');
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
    expect(url).toBe('http://ingestion.internal/ingest?skip_vision=true');
  });

  it('omits skip_vision from /ingest when skipVision is not passed (real job submission)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ document: { path: 'x.docx' }, blocks: [], tables: [], figures: [] }),
    });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.ingest(Buffer.from('hello world'), 'x.docx');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/ingest');
  });

  it('throws on a non-ok /ingest response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 422 });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await expect(client.ingest(Buffer.from('bad'), 'x.txt')).rejects.toThrow(/ingest.*422/i);
  });

  it('POSTs the doc to /level with customer_id as a query param when provided', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level({ blocks: [] }, 'CUST-1');

    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/level?mode=baseline&customer_id=CUST-1');
    expect(JSON.parse(options.body)).toEqual({ blocks: [] });
  });

  it('omits the customer_id query param when null, but always includes mode', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level({ blocks: [] }, null);

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/level?mode=baseline');
  });

  it('defaults mode to baseline when not provided', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level({ blocks: [] }, null);

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toContain('mode=baseline');
  });

  it('passes mode=survey through as a query param when specified', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level({ blocks: [] }, 'CUST-1', 'survey');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/level?mode=survey&customer_id=CUST-1');
  });

  it('throws on a non-ok /level response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await expect(client.level({ blocks: [] }, null)).rejects.toThrow(/level.*500/i);
  });

  it('forwards user_id (KB scope) as a query param when provided', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level({ blocks: [] }, 'CUST-1', 'survey', 'user-descriptor-1');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/level?mode=survey&customer_id=CUST-1&user_id=user-descriptor-1');
  });

  it('omits user_id when not provided, matching pre-existing behavior', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level({ blocks: [] }, 'CUST-1', 'survey');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/level?mode=survey&customer_id=CUST-1');
  });

  it('forwards model as a query param when provided (per-job LLM model override)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level({ blocks: [] }, null, 'survey', undefined, undefined, 'qwen2.5:1.5b');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(new URL(url).searchParams.get('model')).toBe('qwen2.5:1.5b');
  });

  it('omits model when not provided, matching pre-model-selection behavior', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level({ blocks: [] }, null, 'survey');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(new URL(url).searchParams.has('model')).toBe(false);
  });

  it('forwards job_id as a query param when provided (SURVEY narration threading)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level({ blocks: [] }, null, 'survey', undefined, undefined, undefined, 'job-123');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(new URL(url).searchParams.get('job_id')).toBe('job-123');
  });

  it('omits job_id when not provided', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level({ blocks: [] }, null, 'survey');

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(new URL(url).searchParams.has('job_id')).toBe(false);
  });

  it('serializes link_type_catalog with snake_case keys (ingestion/Python is the wire contract, not this side\'s camelCase AdoLinkType)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level({ blocks: [] }, null, 'survey', 'Project\\Area1', [
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

  it('upsertDedupEntriesBatch POSTs all items to /dedup/upsert-batch in one call', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.upsertDedupEntriesBatch([
      { itemId: '1', text: 'a', areaPath: 'Proj\\Area' },
      { itemId: '2', text: 'b', areaPath: 'Proj\\Area' },
    ]);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/dedup/upsert-batch');
    expect(JSON.parse(options.body)).toEqual({
      items: [
        { item_id: '1', text: 'a', area_path: 'Proj\\Area' },
        { item_id: '2', text: 'b', area_path: 'Proj\\Area' },
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
      client.upsertDedupEntriesBatch([{ itemId: '1', text: 'a', areaPath: 'Proj\\Area' }]),
    ).rejects.toThrow(/upsert-batch.*502/i);
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
        body: JSON.stringify({ url: 'https://contoso.sharepoint.com/sites/s/folder', user_id: 'Project\\Area1', doc_type: 'SRD', recursive: false }),
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
        body: JSON.stringify({ url: 'https://contoso.sharepoint.com/sites/s/folder', user_id: 'Project\\Area1', doc_type: 'SRD', recursive: true }),
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
