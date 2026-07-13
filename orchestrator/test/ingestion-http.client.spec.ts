import { IngestionHttpClient } from '../src/modules/pipeline/ingestion-http.client';

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

describe('IngestionHttpClient.syncKb', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('posts snake_case fields to /kb/sync and maps the snake_case response to camelCase', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        files_processed: 2,
        files_skipped: 1,
        files_failed: [{ file: 'bad.txt', reason: 'corrupt' }],
        chunks_stored: 5,
      }),
    });
    global.fetch = mockFetch as any;

    const client = new IngestionHttpClient('http://ingestion:8000');
    const result = await client.syncKb('https://contoso.sharepoint.com/sites/s', 'Lib', 'Folder', 'Project\\Area1', 'kb-1', 'tok-1');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://ingestion:8000/kb/sync',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          site_url: 'https://contoso.sharepoint.com/sites/s',
          library: 'Lib',
          folder: 'Folder',
          area_path: 'Project\\Area1',
          source_id: 'kb-1',
          bearer_token: 'tok-1',
        }),
      }),
    );
    expect(result).toEqual({
      filesProcessed: 2,
      filesSkipped: 1,
      filesFailed: [{ file: 'bad.txt', reason: 'corrupt' }],
      chunksStored: 5,
    });
  });

  it('throws when ingestion responds with a non-ok status', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 502 }) as any;
    const client = new IngestionHttpClient('http://ingestion:8000');
    await expect(
      client.syncKb('https://contoso.sharepoint.com/sites/s', 'Lib', 'Folder', 'Project\\Area1', 'kb-1', 'tok-1'),
    ).rejects.toThrow('Ingestion /kb/sync request failed: 502');
  });
});
