// A fetch stub standing in for the embeddings side of Open WebUI (and the Azure OpenAI limits behind it, and a bare
// Ollama), for the client's batching and route-strategy tests. No socket is opened: tests install `proxy.fetch` as
// global.fetch and read `proxy.calls`. Behaviours are named after the deployments they model; the status codes and error
// wordings come from the verified Open WebUI 0.8.12 probes, the Open WebUI 0.9 source, and the Azure OpenAI limits page.

export type EmbedProxyBehavior =
  | 'owui-0.8'
  | 'owui-0.9-passthrough-off'
  | 'owui-0.9-hidden-model'
  | 'owui-0.9-hidden-model-passthrough-on'
  | 'owui-0.9-hidden-model-403'
  | 'owui-0.13-spa'
  | 'azure-deployment-missing'
  | 'legacy-not-found'
  | 'no-routes'
  | 'azure-limits'
  | 'ollama';

export interface FakeEmbedProxyOptions {
  /** Hard caps the working route enforces (azure-limits defaults to 2,048 inputs and 300,000 tokens). */
  maxInputs?: number;
  maxTokens?: number;
  /** A single input above this many (proxy-counted) tokens is refused with the OpenAI "maximum context length" wording. */
  contextLimitTokens?: number;
  /** Every embeddings request is refused as too large (a single input that never fits). */
  alwaysSizeReject?: boolean;
  /** azure-limits answers 429 with retry-after-ms to the first embeddings POST (default true for azure-limits). */
  rateLimitFirstCall?: boolean | { retryAfterMs: string };
  /** GET /api/version answers 500. */
  versionFails?: boolean;
  /** Vector length (default 2). */
  dim?: number;
}

export interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  rawBody: string | undefined;
  /** The `input` array of an embeddings POST. */
  inputs: string[] | undefined;
}

const VERSIONS: Record<EmbedProxyBehavior, string | null> = {
  'owui-0.8': '0.8.12',
  'owui-0.9-passthrough-off': '0.9.2',
  'owui-0.9-hidden-model': '0.9.2',
  'owui-0.9-hidden-model-passthrough-on': '0.9.2',
  'owui-0.9-hidden-model-403': '0.9.2',
  'owui-0.13-spa': null,
  'azure-deployment-missing': '0.8.12',
  'legacy-not-found': '0.8.12',
  'no-routes': '0.8.12',
  'azure-limits': '0.8.12',
  ollama: null,
};

const LEGACY = '/openai/embeddings';
const DOCUMENTED = ['/api/v1/embeddings', '/api/embeddings'];

/** The deterministic vector the proxy returns for a text; tests compute their expectations with it. */
export function fakeVector(text: string, dim = 2): number[] {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  const v = [h % 100_000, text.length];
  while (v.length < dim) v.push(v.length);
  return v.slice(0, dim);
}

/** What the proxy counts: ceil(chars / 4) per input. */
export const proxyTokens = (text: string): number => Math.ceil(text.length / 4);

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const html = (): Response =>
  new Response('<!doctype html><html><body><div id="app"></div></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });

export class FakeEmbedProxy {
  readonly calls: RecordedCall[] = [];
  /** Mutable, so a test can change the deployment between two embed() calls. */
  behavior: EmbedProxyBehavior;
  private embedPosts = 0;

  constructor(behavior: EmbedProxyBehavior, private readonly opts: FakeEmbedProxyOptions = {}) {
    this.behavior = behavior;
  }

  get embeddingPosts(): RecordedCall[] {
    return this.calls.filter((c) => c.method === 'POST');
  }
  get versionCalls(): RecordedCall[] {
    return this.calls.filter((c) => c.path === '/api/version');
  }
  /** Every input of every embeddings POST, in call order (what actually crossed the wire). */
  sentInputs(): string[] {
    return this.embeddingPosts.flatMap((c) => c.inputs ?? []);
  }

  readonly fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response> => {
    const path = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    let inputs: string[] | undefined;
    try { inputs = (JSON.parse(init?.body ?? 'null') as { input?: string[] } | null)?.input; } catch { /* not JSON */ }
    this.calls.push({ method, path, headers: init?.headers ?? {}, rawBody: init?.body, inputs });
    if (method === 'GET' && path === '/api/version') return this.version();
    if (method !== 'POST') return json(404, { detail: 'Not Found' });
    return this.embed(path, inputs ?? [], init?.body ?? '');
  };

  private version(): Response {
    if (this.opts.versionFails) return json(500, { detail: 'boom' });
    const v = VERSIONS[this.behavior];
    if (v) return json(200, { version: v, deployment_id: 'fake-deployment' });
    return this.behavior === 'owui-0.13-spa' ? html() : json(404, { detail: 'Not Found' });
  }

  private embed(path: string, inputs: string[], rawBody: string): Response {
    const b = this.behavior;
    const isLegacy = path === LEGACY;
    const isDocumented = DOCUMENTED.includes(path);
    if (b === 'ollama') {
      if (path !== '/api/embed') return json(404, { detail: 'Not Found' });
      if (inputs.length > 64) return json(400, { error: 'tokenize EOF' });
      return json(200, { embeddings: inputs.map((t) => fakeVector(t, this.opts.dim)) });
    }
    if (b === 'owui-0.13-spa' && isLegacy) return html();
    // Wrong model / missing deployment: the legacy route relays Azure's own 404; the documented routes are not served.
    if (b === 'azure-deployment-missing') {
      if (isLegacy) return json(404, { error: { code: 'DeploymentNotFound', message: 'The API deployment for this resource does not exist.' } });
      return json(404, { detail: 'Not Found' });
    }
    if (b === 'no-routes') return json(404, { detail: 'Not Found' });
    if (b === 'legacy-not-found' && isLegacy) return json(404, { detail: 'Not Found' });
    // Open WebUI 0.9 with ENABLE_OPENAI_API_PASSTHROUGH=True and a model hidden from the account: documented routes 400.
    if (b === 'owui-0.9-hidden-model-passthrough-on' && isDocumented) return json(400, { detail: 'Model not found' });
    // Same, but the documented routes refuse a model hidden from the account with 403 instead of 400/404.
    if (b === 'owui-0.9-hidden-model-403' && isDocumented) return json(403, { detail: 'You do not have access to this model' });
    if (b === 'owui-0.9-passthrough-off' || b === 'owui-0.9-hidden-model') {
      if (isLegacy) return json(403, { detail: 'Direct API passthrough is disabled' });
      if (isDocumented && b === 'owui-0.9-hidden-model') return json(404, { detail: 'Model not found' });
    }
    if (b === 'owui-0.8' && isDocumented) return json(404, { detail: 'Model not found' });
    if (b === 'azure-limits' && !isLegacy) return json(404, { detail: 'Not Found' });
    if (!isLegacy && !isDocumented) return json(404, { detail: 'Not Found' });

    const model = (JSON.parse(rawBody) as { model: string }).model;
    if (b !== 'azure-limits' && model !== 'OpenAI/text-embedding-3-small') return json(400, { detail: `Model not found: ${model}` });

    this.embedPosts += 1;
    const rl = this.opts.rateLimitFirstCall ?? b === 'azure-limits';
    if (b === 'azure-limits' && rl && this.embedPosts === 1) {
      const ms = typeof rl === 'object' ? rl.retryAfterMs : '50';
      return json(429, { error: { message: 'Rate limit exceeded' } }, { 'retry-after-ms': ms });
    }
    const maxInputs = this.opts.maxInputs ?? (b === 'azure-limits' ? 2048 : undefined);
    const maxTokens = this.opts.maxTokens ?? (b === 'azure-limits' ? 300_000 : undefined);
    if (this.opts.contextLimitTokens !== undefined) {
      const over = inputs.map(proxyTokens).find((t) => t > this.opts.contextLimitTokens!);
      if (over !== undefined) {
        return json(400, { error: { message: `This model's maximum context length is ${this.opts.contextLimitTokens} tokens, however you requested ${over} tokens (${over} in your prompt). Please reduce your prompt.` } });
      }
    }
    if (this.opts.alwaysSizeReject) {
      return json(400, { error: { message: "'$.input' is invalid. Please check the API reference: maximum number of inputs is 2048." } });
    }
    if (maxInputs !== undefined && inputs.length > maxInputs) {
      return json(400, { error: { message: `Invalid 'input': array too long. Expected an array with maximum length ${maxInputs}, but got an array with length ${inputs.length}. The maximum number of inputs is 2048` } });
    }
    const sum = inputs.reduce((s, t) => s + proxyTokens(t), 0);
    if (maxTokens !== undefined && sum > maxTokens) {
      return json(400, { error: { message: `Requested ${sum} tokens, max 300,000 tokens per request` } });
    }
    const data = inputs.map((t, index) => ({ object: 'embedding', index, embedding: fakeVector(t, this.opts.dim) }));
    // Azure/OpenAI only promise each entry's own `index`: answer in reverse order to prove the client honours it.
    if (b === 'azure-limits') data.reverse();
    return json(200, { object: 'list', data, model, usage: { prompt_tokens: sum, total_tokens: sum } });
  }
}

export const createFakeEmbedProxy = (behavior: EmbedProxyBehavior, opts?: FakeEmbedProxyOptions): FakeEmbedProxy => new FakeEmbedProxy(behavior, opts);
