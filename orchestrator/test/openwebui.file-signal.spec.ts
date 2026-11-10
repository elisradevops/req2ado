import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenWebUiClient, type OpenWebUiClientConfig } from '../src/modules/llm/openwebui.client';

// The primer's file calls (upload, processing poll, whole-document chat) used to have no way to be stopped: a cancelled or
// timed-out step left them running. Against a real server that never answers, an abort must end each call and close the
// connection.

let server: Server;
let baseUrl: string;
const closedPaths: string[] = [];
const seen: string[] = [];

const clientFor = (): OpenWebUiClient =>
  new OpenWebUiClient({
    LLM_BASE_URL: `${baseUrl}/ollama/v1`,
    LLM_API_KEY: 'k',
    LLM_CHAT_MODEL: 'm',
    LLM_TRUSTED_LOCAL: true,
    EMBED_TRANSPORT: 'ollama',
    EMBED_MODEL: 'e',
    EMBED_PATH: '/api/embed',
    SHOW_PATH: '/api/show',
    FILES_UPLOAD_PATH: '/api/v1/files/',
    FILES_STATUS_PATH: '/api/v1/files',
    LLM_REQUEST_TIMEOUT_MS: 30_000,
    LLM_SEND_SEED: false,
    LLM_SEND_REASONING_EFFORT: false,
  } as OpenWebUiClientConfig);

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    // Never answers: the status poll answers "pending" so it keeps polling.
    if (request.url?.includes('/process/status')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'pending' }));
      return;
    }
    response.on('close', () => {
      if (!response.writableEnded) closedPaths.push(request.url ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  closedPaths.length = 0;
  seen.length = 0;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

// Polls instead of sleeping a fixed time: the server notices a closed connection a moment after the client aborts, and on a loaded
// machine that moment is longer.
async function eventually(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

const abortAfter = (ms: number): AbortSignal => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
};

describe('Open WebUI file calls can be stopped', () => {
  it('uploadFile: an abort ends the call and closes the connection', async () => {
    const started = Date.now();
    await expect(clientFor().uploadFile(Buffer.from('x'), 'x.docx', abortAfter(150))).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(10_000); // far below the 30 s request timeout: it ended because of the abort
    expect(await eventually(() => closedPaths.some((p) => p.includes('/api/v1/files/')))).toBe(true);
  });

  it('pollFileProcessed: an abort ends the wait at once, long before its own timeout', async () => {
    const started = Date.now();
    await expect(clientFor().pollFileProcessed('f1', 60_000, abortAfter(200))).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(10_000); // its own deadline is 60 s
  });

  it('chatWithFullFileContext: an abort ends the call, is not retried, and closes the connection', async () => {
    const started = Date.now();
    await expect(clientFor().chatWithFullFileContext('read it', 'f1', { signal: abortAfter(150) })).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await eventually(() => closedPaths.some((p) => p.includes('/api/chat/completions')))).toBe(true);
    expect(seen.filter((s) => s.includes('/api/chat/completions'))).toHaveLength(1); // an abort is never retried
  });

  it('pollFileProcessed does not pile up abort listeners while it polls', async () => {
    // fetch itself (undici) adds its own listeners to a signal it is given, so it is replaced here: only this client's are counted.
    jest.spyOn(global, 'fetch').mockImplementation(async () => ({ ok: true, json: async () => ({ status: 'pending' }) }) as Response);
    const controller = new AbortController();
    const added = jest.spyOn(controller.signal, 'addEventListener');
    const removed = jest.spyOn(controller.signal, 'removeEventListener');
    await expect(clientFor().pollFileProcessed('f1', 3_500, controller.signal)).resolves.toBe(false);
    const addedAbort = added.mock.calls.filter(([type]) => type === 'abort').length;
    const removedAbort = removed.mock.calls.filter(([type]) => type === 'abort').length;
    expect(addedAbort).toBeGreaterThanOrEqual(3);
    expect(removedAbort).toBe(addedAbort); // every sleep took its listener away again
  });

  it('without a signal the calls behave as before (a quick answer still resolves)', async () => {
    await expect(clientFor().pollFileProcessed('f1', 50)).resolves.toBe(false); // pending until its own short timeout
  });
});
