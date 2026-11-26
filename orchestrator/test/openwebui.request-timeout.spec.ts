import { Agent } from 'undici';
import { OpenWebUiClient, type OpenWebUiClientConfig } from '../src/modules/llm/openwebui.client';

// A model call that does not stream sends no response headers until its whole answer is ready. Node's built-in fetch cuts such a call at its
// own default (headersTimeout, 300 s) whatever LLM_REQUEST_TIMEOUT_MS says: a local model studying a file was cut at 301 s with "fetch failed"
// (browser walk, 2026-11-26). The file calls go through a dispatcher whose header and body timeouts are the configured request timeout.

const config = {
  LLM_BASE_URL: 'http://openwebui.test/ollama/v1',
  LLM_API_KEY: 'k',
  LLM_CHAT_MODEL: 'm',
  LLM_TRUSTED_LOCAL: true,
  EMBED_TRANSPORT: 'ollama',
  EMBED_MODEL: 'e',
  EMBED_PATH: '/api/embed',
  SHOW_PATH: '/api/show',
  FILES_UPLOAD_PATH: '/api/v1/files/',
  FILES_STATUS_PATH: '/api/v1/files',
  LLM_REQUEST_TIMEOUT_MS: 900_000,
  LLM_SEND_SEED: false,
  LLM_SEND_REASONING_EFFORT: false,
} as OpenWebUiClientConfig;

describe('OpenWebUiClient: the configured request timeout reaches the file calls', () => {
  const originalFetch = global.fetch;
  let inits: RequestInit[];

  beforeEach(() => {
    inits = [];
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      inits.push(init ?? {});
      throw new Error('stop here: only the request is checked');
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends the whole-file chat through a dispatcher of its own, not the default one with its 300 s cut', async () => {
    await expect(new OpenWebUiClient(config).chatWithFullFileContext('read it', 'f1', {})).rejects.toBeDefined();
    expect(inits.length).toBeGreaterThan(0);
    expect((inits[0] as { dispatcher?: unknown }).dispatcher).toBeInstanceOf(Agent);
  });

  it('sends the file-context chat (the file study\'s call) through the same dispatcher', async () => {
    const client = new OpenWebUiClient(config) as unknown as {
      chatWithFileContext: (messages: { role: string; content: string }[], fileId: string, opts: object) => Promise<unknown>;
    };
    await expect(client.chatWithFileContext([{ role: 'user', content: 'study it' }], 'f1', {})).rejects.toBeDefined();
    expect(inits.length).toBeGreaterThan(0);
    expect((inits[0] as { dispatcher?: unknown }).dispatcher).toBeInstanceOf(Agent);
  });
});
