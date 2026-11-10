import { OpenWebUiClient, UpstreamHttpError } from '../src/modules/llm/openwebui.client';
import { createFakeEmbedProxy, fakeVector, proxyTokens, type EmbedProxyBehavior, type FakeEmbedProxyOptions } from './support/fake-embed-proxy';

const LEGACY = '/openai/embeddings';
const V1 = '/api/v1/embeddings';
const API = '/api/embeddings';
const SMALL = 'OpenAI/text-embedding-3-small';

const baseConfig = {
  LLM_BASE_URL: 'http://localhost:3000/api/v1',
  LLM_API_KEY: 'sk-secret-key',
  LLM_CHAT_MODEL: 'llama3.1',
  LLM_TRUSTED_LOCAL: false,
  EMBED_TRANSPORT: 'openai' as const,
  EMBED_BASE_URL: undefined,
  EMBED_MODEL: SMALL,
  EMBED_PATH: '/api/embed',
  EMBED_OPENAI_PATH: LEGACY,
  EMBED_OPENAI_FALLBACK_ROUTES: [V1, API],
  SHOW_PATH: '/api/show',
  FILES_UPLOAD_PATH: '/api/v1/files/',
  FILES_STATUS_PATH: '/api/v1/files',
  LLM_REQUEST_TIMEOUT_MS: 600_000,
  LLM_SEND_SEED: false,
  LLM_SEND_REASONING_EFFORT: false,
};

function setup(behavior: EmbedProxyBehavior, opts: FakeEmbedProxyOptions = {}, config: Partial<typeof baseConfig> & Record<string, unknown> = {}) {
  const proxy = createFakeEmbedProxy(behavior, opts);
  global.fetch = proxy.fetch as unknown as typeof fetch;
  const client = new OpenWebUiClient({ ...baseConfig, ...config } as never);
  return { proxy, client };
}

const paths = (proxy: ReturnType<typeof createFakeEmbedProxy>) => proxy.embeddingPosts.map((c) => c.path);
const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];
const prose = (seed: number, chars: number) => {
  let s = '';
  for (let i = seed; s.length < chars; i++) s += `${words[i % words.length]}${(i * 7919) % 1000} `;
  return s.slice(0, chars);
};

describe('OpenWebUiClient.embed batching', () => {
  let info: jest.SpyInstance;
  beforeEach(() => { info = jest.spyOn(console, 'info').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());

  it('5,000 texts embed in order and batches stay within 2,048 inputs', async () => {
    const { proxy, client } = setup('azure-limits', { rateLimitFirstCall: false });
    const texts = Array.from({ length: 5000 }, (_, i) => `text number ${i}`);
    const out = await client.embed(texts);
    expect(out).toEqual(texts.map((t) => fakeVector(t)));
    expect(proxy.embeddingPosts.map((c) => c.inputs!.length)).toEqual([2048, 2048, 904]);
  });

  it('summed tokens per request stay under the cap', async () => {
    const { proxy, client } = setup('azure-limits', { rateLimitFirstCall: false });
    const texts = Array.from({ length: 700 }, (_, i) => prose(i, 3000));
    const out = await client.embed(texts);
    expect(out).toHaveLength(700);
    expect(proxy.embeddingPosts.length).toBeGreaterThan(1);
    for (const c of proxy.embeddingPosts) {
      expect(c.inputs!.reduce((s, t) => s + proxyTokens(t), 0)).toBeLessThanOrEqual(300_000);
    }
    expect(proxy.calls.filter((c) => c.method === 'POST')).toHaveLength(proxy.embeddingPosts.length);
  });

  it('chunks of one oversized text spanning two batches average correctly', async () => {
    const { proxy, client } = setup('azure-limits', { rateLimitFirstCall: false }, { EMBED_MAX_INPUTS_PER_REQUEST: 2 });
    const big = prose(3, 60_000); // well over 7,500 tokens: split into several chunks
    const out = await client.embed(['small', big, 'tail']);
    const sent = proxy.sentInputs();
    expect(proxy.embeddingPosts.every((c) => c.inputs!.length <= 2)).toBe(true);
    const bigChunks = sent.slice(1, sent.length - 1);
    expect(bigChunks.length).toBeGreaterThan(1);
    // the first batch is [small, chunk0]; the rest of the chunks are in later batches
    expect(proxy.embeddingPosts[0].inputs).toEqual(['small', bigChunks[0]]);
    const expected = [0, 1].map((k) => bigChunks.reduce((s, c) => s + fakeVector(c)[k], 0) / bigChunks.length);
    expect(out[1][0]).toBeCloseTo(expected[0], 6);
    expect(out[1][1]).toBeCloseTo(expected[1], 6);
    expect(out[0]).toEqual(fakeVector('small'));
    expect(out[2]).toEqual(fakeVector('tail'));
  });

  it('shuffled response indexes map to the right text', async () => {
    const { client } = setup('azure-limits', { rateLimitFirstCall: false });
    const texts = ['a one', 'b two', 'c three', 'd four', 'e five'];
    expect(await client.embed(texts)).toEqual(texts.map((t) => fakeVector(t)));
  });

  it('a request within limits is a single request identical to the old body', async () => {
    const { proxy, client } = setup('owui-0.8', {}, { EMBED_OPENAI_FALLBACK_ROUTES: [] });
    await client.embed(['The unit shall survive a drop.', 'second']);
    expect(proxy.embeddingPosts).toHaveLength(1);
    expect(proxy.embeddingPosts[0].rawBody).toBe(JSON.stringify({ model: SMALL, input: ['The unit shall survive a drop.', 'second'] }));
  });

  it('the OpenAI/ prefix is sent unchanged', async () => {
    const { proxy, client } = setup('owui-0.8');
    await client.embed(['x']);
    expect(JSON.parse(proxy.embeddingPosts[0].rawBody!).model).toBe(SMALL);
  });

  it('opaque deployment learns the cap from a 400 and halves, then remembers it', async () => {
    const { proxy, client } = setup('azure-limits', { rateLimitFirstCall: false, maxInputs: 100 }, { EMBED_MODEL: 'emb-prod-01' });
    const texts = Array.from({ length: 300 }, (_, i) => `row ${i}`);
    expect(await client.embed(texts)).toEqual(texts.map((t) => fakeVector(t)));
    const firstRun = proxy.embeddingPosts.length;
    expect(proxy.embeddingPosts[0].inputs!.length).toBe(256); // default limits for an unidentified model
    expect(proxy.embeddingPosts.some((c) => c.inputs!.length === 128)).toBe(true);
    expect(info.mock.calls.map((c) => String(c[0])).some((l) => /halvings=[1-9]/.test(l))).toBe(true);
    // second call starts from what was learned: no request above 100 inputs
    expect(await client.embed(texts)).toEqual(texts.map((t) => fakeVector(t)));
    expect(proxy.embeddingPosts.slice(firstRun).every((c) => c.inputs!.length <= 100)).toBe(true);
  });

  const halvingsLogged = () => info.mock.calls.map((c) => String(c[0])).map((l) => /halvings=(\d+)/.exec(l)).filter(Boolean).map((m) => Number(m![1]));
  const memoryOf = (c: OpenWebUiClient) => (c as unknown as { embedLimitMemory: { get(m: string): { inputs?: number } | undefined } }).embedLimitMemory.get('emb-prod-01');

  it('a lower real cap with several initial batches halves once, then re-plans the remaining batches', async () => {
    const { proxy, client } = setup('azure-limits', { rateLimitFirstCall: false, maxInputs: 128 }, { EMBED_MODEL: 'emb-prod-01' });
    const texts = Array.from({ length: 3072 }, (_, i) => `row ${i}`); // 12 batches of 256 under the default limits
    expect(await client.embed(texts)).toEqual(texts.map((t) => fakeVector(t)));
    expect(halvingsLogged()).toEqual([1]);
    // one rejected 256, then everything (that range and the rest of the queue) is sent under the learned limits, no more rejections
    const sizes = proxy.embeddingPosts.map((c) => c.inputs!.length);
    expect(sizes[0]).toBe(256);
    expect(sizes.slice(1).every((n) => n <= 128)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(3072 + 256);
    expect(sizes.length).toBeLessThanOrEqual(32);
  });

  it('the remembered limit is the smallest working limit, not a cascade', async () => {
    const { client } = setup('azure-limits', { rateLimitFirstCall: false, maxInputs: 100 }, { EMBED_MODEL: 'emb-prod-01' });
    await client.embed(Array.from({ length: 3072 }, (_, i) => `row ${i}`));
    expect(memoryOf(client)).toMatchObject({ inputs: 64 });
  });

  it('no more than ceil(log2(...)) halvings for a 12-batch plan with a real cap of 100 inputs', async () => {
    const { client } = setup('azure-limits', { rateLimitFirstCall: false, maxInputs: 100 }, { EMBED_MODEL: 'emb-prod-01' });
    await client.embed(Array.from({ length: 3072 }, (_, i) => `row ${i}`));
    expect(halvingsLogged()[0]).toBeLessThanOrEqual(Math.ceil(Math.log2(256)));
    expect(halvingsLogged()[0]).toBe(2);
  });

  it('5,000 inputs with a real cap of 100 finish in under 120 requests', async () => {
    const { proxy, client } = setup('azure-limits', { rateLimitFirstCall: false, maxInputs: 100 }, { EMBED_MODEL: 'emb-prod-01' });
    const texts = Array.from({ length: 5000 }, (_, i) => `row ${i}`);
    expect(await client.embed(texts)).toEqual(texts.map((t) => fakeVector(t)));
    expect(proxy.embeddingPosts.length).toBeLessThan(120);
  });

  it('a single input that keeps failing throws the upstream error', async () => {
    const { proxy, client } = setup('azure-limits', { rateLimitFirstCall: false, alwaysSizeReject: true }, { EMBED_MODEL: 'emb-prod-01' });
    const err = await client.embed(['a', 'b', 'c']).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamHttpError);
    expect((err as UpstreamHttpError).upstreamStatus).toBe(400);
    expect(proxy.embeddingPosts.length).toBeLessThanOrEqual(12);
    expect(proxy.embeddingPosts[proxy.embeddingPosts.length - 1].inputs).toHaveLength(1);
  });

  it('one oversized input in a batch does not shrink the remembered limits', async () => {
    const { proxy, client } = setup('azure-limits', { rateLimitFirstCall: false, contextLimitTokens: 50 });
    const big = 'x'.repeat(400);
    const err = await client.embed(['a', 'b', 'c', big]).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamHttpError);
    expect((client as unknown as { embedLimitMemory: { get(m: string): unknown } }).embedLimitMemory.get(SMALL)).toBeUndefined();
    const before = proxy.embeddingPosts.length;
    await client.embed(['a', 'b', 'c']);
    expect(proxy.embeddingPosts.slice(before).map((c) => c.inputs!.length)).toEqual([3]);
  });

  it('learned limits are remembered only after the halved range succeeds', async () => {
    const memory = (c: OpenWebUiClient) => (c as unknown as { embedLimitMemory: { get(m: string): unknown } }).embedLimitMemory.get('emb-prod-01');
    const failing = setup('azure-limits', { rateLimitFirstCall: false, alwaysSizeReject: true }, { EMBED_MODEL: 'emb-prod-01' });
    await failing.client.embed(['a', 'b', 'c']).catch(() => undefined);
    expect(memory(failing.client)).toBeUndefined();
    const ok = setup('azure-limits', { rateLimitFirstCall: false, maxInputs: 2 }, { EMBED_MODEL: 'emb-prod-01' });
    await ok.client.embed(['a', 'b', 'c', 'd']);
    expect(memory(ok.client)).toMatchObject({ inputs: 2 });
  });

  it('a context-length rejection of a single input throws without further halving', async () => {
    const { proxy, client } = setup('azure-limits', { rateLimitFirstCall: false, contextLimitTokens: 50 });
    const err = await client.embed(['y'.repeat(400), 'a']).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamHttpError);
    expect(proxy.embeddingPosts.map((c) => c.inputs!.length)).toEqual([2, 1]);
    expect((client as unknown as { embedLimitMemory: { get(m: string): unknown } }).embedLimitMemory.get(SMALL)).toBeUndefined();
  });

  it('429 retry-after-ms is honoured and capped at 20 s', async () => {
    const real = global.setTimeout;
    const delays: number[] = [];
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (typeof ms === 'number') delays.push(ms);
      return real(fn, 0);
    }) as never);
    const a = setup('azure-limits'); // 429 with retry-after-ms: 50
    await a.client.embed(['x']);
    expect(delays).toContain(50);
    delays.length = 0;
    const b = setup('azure-limits', { rateLimitFirstCall: { retryAfterMs: '60000' } });
    await b.client.embed(['x']);
    expect(Math.max(...delays)).toBe(20_000);
    expect(delays).not.toContain(60_000);
  });

  it('ollama transport batches 64 per call and keeps order', async () => {
    const { proxy, client } = setup('ollama', {}, { LLM_BASE_URL: 'http://localhost:3000/v1', EMBED_TRANSPORT: 'ollama' as never, EMBED_MODEL: 'nomic-embed-text' });
    const texts = Array.from({ length: 150 }, (_, i) => `t${i}`);
    expect(await client.embed(texts)).toEqual(texts.map((t) => fakeVector(t)));
    expect(proxy.embeddingPosts.map((c) => c.inputs!.length)).toEqual([64, 64, 22]);
    expect(proxy.embeddingPosts.every((c) => c.path === '/api/embed')).toBe(true);
  });
});

describe('OpenWebUiClient.embed route strategy', () => {
  beforeEach(() => { jest.spyOn(console, 'info').mockImplementation(() => undefined); jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());

  it('owui-0.8 uses the legacy route first with no extra calls', async () => {
    const { proxy, client } = setup('owui-0.8');
    await client.embed(['x']);
    expect(paths(proxy)).toEqual([LEGACY]);
    expect(proxy.calls.map((c) => c.path)).toEqual(['/api/version', LEGACY]);
  });

  it('owui-0.9-passthrough-off falls back from the 403 and remembers the working route', async () => {
    const { proxy, client } = setup('owui-0.9-passthrough-off', { versionFails: true });
    expect(await client.embed(['x'])).toEqual([fakeVector('x')]);
    expect(paths(proxy)).toEqual([LEGACY, V1]);
    await client.embed(['y']);
    expect(paths(proxy)).toEqual([LEGACY, V1, V1]);
  });

  it('rediscovers when the remembered route starts failing', async () => {
    const { proxy, client } = setup('owui-0.8');
    await client.embed(['x']);
    proxy.behavior = 'owui-0.9-passthrough-off';
    expect(await client.embed(['y'])).toEqual([fakeVector('y')]);
    expect(paths(proxy)).toEqual([LEGACY, LEGACY, V1]);
    await client.embed(['z']);
    expect(paths(proxy)).toEqual([LEGACY, LEGACY, V1, V1]);
  });

  it('SPA html response moves to the next route', async () => {
    const { proxy, client } = setup('owui-0.13-spa');
    // the version route answers html too, so the order stays default (legacy first)
    // the SPA proxy also serves the documented route, so only the model matters
    expect(await client.embed(['x'])).toEqual([fakeVector('x')]);
    expect(paths(proxy)).toEqual([LEGACY, V1]);
  });

  it('owui-0.9-hidden-model ends in the clear terminal error naming both remedies', async () => {
    const { proxy, client } = setup('owui-0.9-hidden-model', { versionFails: true });
    const err = await client.embed(['x']).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamHttpError);
    expect((err as UpstreamHttpError).upstreamStatus).toBe(404);
    expect((err as Error).message).toBe(
      `Open WebUI refused every embeddings route (${LEGACY}, ${V1}, ${API}); the first, ${LEGACY}, answered 403: {\"detail\":\"Direct API passthrough is disabled\"}. Set ENABLE_OPENAI_API_PASSTHROUGH=True on Open WebUI, or make the embedding model visible to this account so /api/v1/embeddings accepts it.`,
    );
    expect(paths(proxy)).toEqual([LEGACY, V1, API]);
  });

  it('a 404 DeploymentNotFound on the legacy route is terminal and keeps its upstream message', async () => {
    const { proxy, client } = setup('azure-deployment-missing', { versionFails: true });
    const err = await client.embed(['x']).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamHttpError);
    expect((err as UpstreamHttpError).upstreamStatus).toBe(404);
    expect((err as Error).message).toContain('DeploymentNotFound');
    expect((err as Error).message).not.toContain('ENABLE_OPENAI_API_PASSTHROUGH');
    expect(paths(proxy)).toEqual([LEGACY]);
  });

  it('a 404 catch-all Not Found still moves on', async () => {
    const { proxy, client } = setup('legacy-not-found', { versionFails: true });
    expect(await client.embed(['x'])).toEqual([fakeVector('x')]);
    expect(paths(proxy)).toEqual([LEGACY, V1]);
  });

  it('the terminal error names the passthrough remedy only when a 403 passthrough was seen', async () => {
    const noRoutes = setup('no-routes', { versionFails: true });
    const a = await noRoutes.client.embed(['x']).catch((e) => e);
    expect(a).toBeInstanceOf(UpstreamHttpError);
    expect((a as Error).message).not.toContain('ENABLE_OPENAI_API_PASSTHROUGH');
    expect((a as Error).message).toContain(`the first, ${LEGACY}, answered 404`);
    expect((a as Error).message).toContain('Not Found');
    expect((a as Error).message).toMatch(/model|route/i);
    const off = setup('owui-0.9-hidden-model', { versionFails: true });
    const b = await off.client.embed(['x']).catch((e) => e);
    expect((b as Error).message).toContain('ENABLE_OPENAI_API_PASSTHROUGH=True');
    expect((b as Error).message).toContain(`the first, ${LEGACY}, answered 403`);
    expect((b as Error).message).toContain('Direct API passthrough is disabled');
  });

  it('owui-0.9 with the passthrough flag on and a hidden model falls back from the documented route to the legacy route', async () => {
    const { proxy, client } = setup('owui-0.9-hidden-model-passthrough-on');
    expect(await client.embed(['x'])).toEqual([fakeVector('x')]);
    expect(paths(proxy)).toEqual([V1, API, LEGACY]);
  });

  it('fallback disabled keeps a 403 terminal', async () => {
    const { proxy, client } = setup('owui-0.9-passthrough-off', {}, { EMBED_OPENAI_FALLBACK_ROUTES: [] });
    const err = await client.embed(['x']).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamHttpError);
    expect((err as UpstreamHttpError).upstreamStatus).toBe(403);
    expect((err as Error).message).toMatch(/openai\/embeddings.*403/);
    expect(paths(proxy)).toEqual([LEGACY]);
    expect(proxy.versionCalls).toHaveLength(0);
  });

  it('version >= 0.9.0 orders documented routes first', async () => {
    const { proxy, client } = setup('owui-0.9-passthrough-off');
    await client.embed(['x']);
    expect(paths(proxy)).toEqual([V1]);
    expect(proxy.versionCalls).toHaveLength(1);
    await client.embed(['y']);
    expect(proxy.versionCalls).toHaveLength(1); // asked once per client
  });

  const withOverride = (proxy: ReturnType<typeof createFakeEmbedProxy>, override: (path: string) => Response | undefined) => {
    global.fetch = (async (url: string, init?: never) => {
      const hit = (init as { method?: string } | undefined)?.method === 'POST' ? override(new URL(url).pathname) : undefined;
      if (hit) { await proxy.fetch(url, init); return hit; }
      return proxy.fetch(url, init);
    }) as unknown as typeof fetch;
  };
  const envelope = () => new Response(JSON.stringify({ error: { message: 'not an embeddings reply' } }), { status: 200, headers: { 'content-type': 'application/json' } });

  it('a 200 with an error envelope does not poison the remembered route and moves on', async () => {
    const { proxy, client } = setup('owui-0.9-passthrough-off', { versionFails: true });
    withOverride(proxy, (p) => (p === LEGACY ? envelope() : undefined));
    expect(await client.embed(['x'])).toEqual([fakeVector('x')]);
    expect((client as unknown as { embedRoute?: string }).embedRoute).toBe(V1);
    await client.embed(['y']);
    expect(paths(proxy).slice(-1)).toEqual([V1]);
  });

  it('a last-candidate non-embeddings body throws an UpstreamHttpError 502', async () => {
    const { proxy, client } = setup('owui-0.8', { versionFails: true }, { EMBED_OPENAI_FALLBACK_ROUTES: [] });
    withOverride(proxy, () => envelope());
    const err = await client.embed(['x']).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamHttpError);
    expect((err as UpstreamHttpError).upstreamStatus).toBe(502);
    expect((err as Error).message).toMatch(/embeddings/i);
    expect((client as unknown as { embedRoute?: string }).embedRoute).toBeUndefined();
  });

  it('a WAF 403 account disabled on the primary route is terminal', async () => {
    const { proxy, client } = setup('owui-0.8', { versionFails: true });
    withOverride(proxy, (p) => (p === LEGACY ? new Response('Your account is disabled', { status: 403 }) : undefined));
    const err = await client.embed(['x']).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamHttpError);
    expect((err as UpstreamHttpError).upstreamStatus).toBe(403);
    expect(paths(proxy)).toEqual([LEGACY]);
  });

  it('owui-0.9-hidden-model-403 moves from the documented routes (403 no access) to the legacy route', async () => {
    const { proxy, client } = setup('owui-0.9-hidden-model-403');
    expect(await client.embed(['x'])).toEqual([fakeVector('x')]);
    expect(paths(proxy)).toEqual([V1, API, LEGACY]);
  });

  it('a version lookup that never answers does not block the first embed past the timeout', async () => {
    const proxy = createFakeEmbedProxy('owui-0.8');
    global.fetch = ((url: string, init?: { signal?: AbortSignal }) => {
      if (new URL(url).pathname === '/api/version') {
        return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      return proxy.fetch(url, init as never);
    }) as unknown as typeof fetch;
    const original = (OpenWebUiClient as unknown as { VERSION_TIMEOUT_MS: number }).VERSION_TIMEOUT_MS;
    (OpenWebUiClient as unknown as { VERSION_TIMEOUT_MS: number }).VERSION_TIMEOUT_MS = 30;
    try {
      const client = new OpenWebUiClient({ ...baseConfig } as never);
      expect(await client.embed(['x'])).toEqual([fakeVector('x')]);
      expect(paths(proxy)).toEqual([LEGACY]);
    } finally {
      (OpenWebUiClient as unknown as { VERSION_TIMEOUT_MS: number }).VERSION_TIMEOUT_MS = original;
    }
  }, 2000);

  it('a non-OK version response has its body cancelled', async () => {
    const proxy = createFakeEmbedProxy('owui-0.8');
    const cancel = jest.fn(async () => undefined);
    global.fetch = (async (url: string, init?: never) => {
      if (new URL(url).pathname === '/api/version') return { ok: false, status: 500, body: { cancel } } as unknown as Response;
      return proxy.fetch(url, init);
    }) as unknown as typeof fetch;
    const client = new OpenWebUiClient({ ...baseConfig } as never);
    expect(await client.embed(['x'])).toEqual([fakeVector('x')]);
    expect(cancel).toHaveBeenCalled();
  });

  it('version lookup failure never breaks embedding', async () => {
    const { proxy, client } = setup('owui-0.8', { versionFails: true });
    expect(await client.embed(['x'])).toEqual([fakeVector('x')]);
    expect(paths(proxy)).toEqual([LEGACY]);
  });

  it('logs contain counts and version only (no text, no key)', async () => {
    const lines: string[] = [];
    for (const m of ['info', 'log', 'warn', 'error'] as const) jest.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    const { client } = setup('owui-0.8');
    await client.embed(['TOP-SECRET-PAYLOAD']);
    const all = lines.join('\n');
    expect(all).not.toContain('TOP-SECRET-PAYLOAD');
    expect(all).not.toContain('sk-secret-key');
    expect(all).toContain('[OpenWebUiClient] open webui version=0.8.12 embed route order=/openai/embeddings,/api/v1/embeddings,/api/embeddings');
    expect(all).toMatch(/embed batches=1 inputs=1 tokens=\d+ attempts=1 halvings=0 route=\/openai\/embeddings ms=\d+/);
  });
});
