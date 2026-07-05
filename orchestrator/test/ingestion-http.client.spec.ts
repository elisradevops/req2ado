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
    expect(url).toBe('http://ingestion.internal/level?customer_id=CUST-1');
    expect(JSON.parse(options.body)).toEqual({ blocks: [] });
  });

  it('omits the customer_id query param when null', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await client.level({ blocks: [] }, null);

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/level');
  });

  it('throws on a non-ok /level response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    const client = new IngestionHttpClient('http://ingestion.internal');
    await expect(client.level({ blocks: [] }, null)).rejects.toThrow(/level.*500/i);
  });
});
