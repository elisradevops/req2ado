import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { IngestionHttpClient, IngestionHttpError } from '../src/modules/pipeline/ingestion-http.client';
import type { CanonicalDoc } from '@req2ado/shared-ts';

const DOC: CanonicalDoc = { document: { path: 'x.txt', format: 'txt', sha256: 'h' }, blocks: [], tables: [], figures: [] };
const TREE = { nodes: [{ localId: 'n1', title: 'מסמך' }], warnings: [] };
const NDJSON = 'application/x-ndjson';

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const result = (rubric = { version: 'rubric-7', degraded: false }) => line({ type: 'result', tree: TREE, rubric });

function streamOf(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': NDJSON } });
}
const bytes = (text: string) => new TextEncoder().encode(text);

describe('IngestionHttpClient.level reading the streamed answer', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  function answer(response: Response) {
    global.fetch = jest.fn().mockResolvedValue(response);
    return new IngestionHttpClient('http://ingestion.internal');
  }

  it('asks for the stream, skips heartbeats, returns the tree and says which rubric scored it', async () => {
    const client = answer(streamOf([bytes(line({ type: 'heartbeat', elapsed: 15 })), bytes(line({ type: 'heartbeat', elapsed: 30 })), bytes(result())]));
    const scored: { rubricVersion?: string | null; degraded?: boolean } = {};
    const tree = await client.level(DOC, 'survey', 'u1', undefined, 'm', 'j1', undefined, scored);
    expect(tree).toEqual(TREE);
    expect(scored).toEqual({ rubricVersion: 'rubric-7', degraded: false });
    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(options.headers.Accept).toContain(NDJSON);
  });

  it('reports a degraded rubric and a missing one (null) the way the headers did', async () => {
    const degraded = answer(streamOf([bytes(result({ version: 'stored-3', degraded: true }))]));
    const a: { rubricVersion?: string | null; degraded?: boolean } = {};
    await degraded.level(DOC, 'survey', 'u1', undefined, 'm', 'j1', undefined, a);
    expect(a).toEqual({ rubricVersion: 'stored-3', degraded: true });

    const none = answer(streamOf([bytes(line({ type: 'result', tree: TREE, rubric: { version: null, degraded: false } }))]));
    const b: { rubricVersion?: string | null; degraded?: boolean } = {};
    await none.level(DOC, 'survey', 'u1', undefined, 'm', 'j1', undefined, b);
    expect(b).toEqual({ rubricVersion: null, degraded: false });
  });

  it('reads a line that arrives in pieces, even one cut in the middle of a character', async () => {
    const whole = bytes(result());
    const cut = whole.indexOf(0xd7) + 1; // between the two bytes of the first Hebrew letter
    const client = answer(streamOf([whole.slice(0, cut), whole.slice(cut, cut + 7), whole.slice(cut + 7)]));
    expect(await client.level(DOC, 'survey')).toEqual(TREE);
  });

  it('turns an error line into the failure ingestion would have answered with a status', async () => {
    const client = answer(streamOf([bytes(line({ type: 'heartbeat', elapsed: 15 })), bytes(line({ type: 'error', status: 502, detail: 'the model said no' }))]));
    const failure = await client.level(DOC, 'survey').catch((e) => e);
    expect(failure).toBeInstanceOf(IngestionHttpError);
    expect(failure.status).toBe(502);
    expect(failure.message).toBe('Ingestion /level request failed: the model said no');
  });

  it('fails when the stream ends without a result', async () => {
    const client = answer(streamOf([bytes(line({ type: 'heartbeat', elapsed: 15 }))]));
    await expect(client.level(DOC, 'survey')).rejects.toThrow(/ended without a result/i);
  });

  it('still reads a plain JSON answer and its rubric headers (an ingestion that does not stream)', async () => {
    const client = answer(
      new Response(JSON.stringify(TREE), { status: 200, headers: { 'content-type': 'application/json', 'x-req2ado-rubric-version': 'p-built', 'x-req2ado-rubric-degraded': '1' } }),
    );
    const scored: { rubricVersion?: string | null; degraded?: boolean } = {};
    expect(await client.level(DOC, 'survey', 'u1', undefined, 'm', 'j1', undefined, scored)).toEqual(TREE);
    expect(scored).toEqual({ rubricVersion: 'p-built', degraded: true });
  });
});

describe('IngestionHttpClient.level against a real socket: the limit is silence, not total time', () => {
  let server: http.Server;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  let baseUrl: string;

  beforeEach(async () => {
    server = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const start = (res: http.ServerResponse) => res.writeHead(200, { 'content-type': NDJSON });

  it('a run far longer than the idle limit finishes while heartbeats keep coming', async () => {
    handler = (req, res) => {
      req.resume();
      start(res);
      let beats = 0;
      const timer = setInterval(() => {
        res.write(line({ type: 'heartbeat', elapsed: beats }));
        if (++beats === 12) {
          clearInterval(timer);
          res.end(result());
        }
      }, 60);
    };
    const client = new IngestionHttpClient(baseUrl, 250, { idleTimeoutMs: 250, maxDurationMs: 10_000 });
    const began = Date.now();
    expect(await client.level(DOC, 'survey')).toEqual(TREE);
    expect(Date.now() - began).toBeGreaterThan(600); // longer than both the request and the idle limits
  });

  it('fails with a message of its own when ingestion goes silent', async () => {
    handler = (req, res) => {
      req.resume();
      start(res);
      res.write(line({ type: 'heartbeat', elapsed: 0 })); // then nothing
    };
    const client = new IngestionHttpClient(baseUrl, 60_000, { idleTimeoutMs: 200, maxDurationMs: 10_000 });
    const began = Date.now();
    await expect(client.level(DOC, 'survey')).rejects.toThrow(/went silent for 0\.2 s/);
    expect(Date.now() - began).toBeLessThan(3000);
  });

  it('stops a run that exceeds the maximum duration and closes the connection, so ingestion cancels it', async () => {
    let closed: () => void;
    const connectionClosed = new Promise<void>((resolve) => (closed = resolve));
    handler = (req, res) => {
      req.resume();
      start(res);
      const timer = setInterval(() => res.write(line({ type: 'heartbeat', elapsed: 1 })), 50);
      res.on('close', () => {
        clearInterval(timer);
        closed();
      });
    };
    const client = new IngestionHttpClient(baseUrl, 60_000, { idleTimeoutMs: 5_000, maxDurationMs: 400 });
    await expect(client.level(DOC, 'survey')).rejects.toThrow(/longer than 0\.4 s/);
    await Promise.race([connectionClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('the connection stayed open')), 2000))]);
  });
});
