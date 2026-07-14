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
          area_path: 'Project\\Area1',
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
        body: JSON.stringify({ url: 'https://contoso.sharepoint.com/sites/s/folder', area_path: 'Project\\Area1', doc_type: 'SRD', recursive: false }),
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
        body: JSON.stringify({ url: 'https://contoso.sharepoint.com/sites/s/folder', area_path: 'Project\\Area1', doc_type: 'SRD', recursive: true }),
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
