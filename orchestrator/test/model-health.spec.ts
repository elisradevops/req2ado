import {
  FAILED_TTL_MS,
  OK_TTL_MS,
  isListed,
  needsProbe,
  parseVerdict,
  probeModel,
  type ModelVerdict,
  type ProbeClient,
} from '../src/modules/llm/model-health';
import { ModelHealthService, probeJobId, type ProbeJobData, type VerdictStore } from '../src/modules/llm/model-health.service';
import { LlmConnectionController } from '../src/modules/llm/llm-connection.controller';

const rowsAnswer = JSON.stringify({ rows: [{ id: 'a1', label: 'A1' }, { id: 'b2', label: 'B2' }, { id: 'c3', label: 'C3' }] });
const noSleep = async (): Promise<void> => undefined;

/** A client whose answers come from a function of the call (plain: 1st, structured: 2nd). */
function clientWith(answer: (callIndex: number) => string | Error): ProbeClient & { calls: number } {
  const client = {
    calls: 0,
    async chat() {
      const result = answer(client.calls++);
      if (result instanceof Error) throw result;
      return { content: result };
    },
  };
  return client;
}

const healthy = (call: number): string => (call % 2 === 0 ? 'QX7' : rowsAnswer);

describe('probeModel', () => {
  it('passes a model that follows the instruction and returns structured rows', async () => {
    const verdict = await probeModel(clientWith(healthy), 'm', { now: () => 5, sleep: noSleep });
    expect(verdict).toEqual({ status: 'ok', checkedAt: 5 });
  });

  it('fails a persona/agent preset that ignores our instruction, after one repeat', async () => {
    const client = clientWith(() => 'I am the contracts assistant. How can I help?');
    const verdict = await probeModel(client, 'persona', { now: () => 7, sleep: noSleep });
    expect(verdict).toEqual({ status: 'failed', checkedAt: 7, reason: 'ignored_instruction' });
    expect(client.calls).toBe(2);
  });

  it('fails a model whose structured answer is unusable', async () => {
    const verdict = await probeModel(clientWith((call) => (call % 2 === 0 ? 'QX7' : 'not json at all')), 'm', { sleep: noSleep });
    expect(verdict).toMatchObject({ status: 'failed', reason: 'structured_output_failed' });
  });

  it('accepts structured rows wrapped in a code fence (a prompt-only fallback answer)', async () => {
    const fenced = '```json\n' + rowsAnswer + '\n```';
    const verdict = await probeModel(clientWith((call) => (call % 2 === 0 ? 'QX7' : fenced)), 'm', { sleep: noSleep });
    expect(verdict.status).toBe('ok');
  });

  it('records the HTTP status of an upstream failure, as a code and never as text', async () => {
    const err = Object.assign(new Error('secret upstream text'), { status: 404 });
    const verdict = await probeModel(clientWith(() => err), 'retired', { sleep: noSleep });
    expect(verdict).toMatchObject({ status: 'failed', reason: 'status_404' });
    expect(JSON.stringify(verdict)).not.toContain('secret');
  });

  it('heals a single transient failure with its one repeat', async () => {
    let failedOnce = false;
    const client: ProbeClient = {
      async chat(_messages, opts) {
        if (!failedOnce) {
          failedOnce = true;
          throw Object.assign(new Error('boom'), { status: 502 });
        }
        return { content: opts?.responseSchema ? rowsAnswer : 'QX7' };
      },
    };
    expect((await probeModel(client, 'm', { sleep: noSleep })).status).toBe('ok');
  });

  it('is inconclusive, not failed, for a timeout or a rate limit (they say nothing about the model)', async () => {
    const hang: ProbeClient = { chat: () => new Promise(() => undefined) };
    expect(await probeModel(hang, 'slow', { sleep: noSleep, timeoutMs: 10 })).toMatchObject({ status: 'inconclusive', reason: 'timeout' });
    const limited = Object.assign(new Error('x'), { status: 429 });
    expect(await probeModel(clientWith(() => limited), 'busy', { sleep: noSleep })).toMatchObject({ status: 'inconclusive', reason: 'status_429' });
    const overloaded = Object.assign(new Error('x'), { status: 503 });
    expect(await probeModel(clientWith(() => overloaded), 'busy', { sleep: noSleep })).toMatchObject({ status: 'inconclusive' });
  });
});

describe('verdict lifetime', () => {
  const ok: ModelVerdict = { status: 'ok', checkedAt: 1000 };
  const failed: ModelVerdict = { status: 'failed', checkedAt: 1000, reason: 'x' };

  it('lists unknown and ok models, hides failed ones', () => {
    expect(isListed(undefined)).toBe(true);
    expect(isListed(ok)).toBe(true);
    expect(isListed(failed)).toBe(false);
  });

  it('re-checks an ok verdict after a day and a failed one after an hour', () => {
    expect(needsProbe(undefined, 0)).toBe(true);
    expect(needsProbe(ok, 1000 + OK_TTL_MS - 1)).toBe(false);
    expect(needsProbe(ok, 1000 + OK_TTL_MS)).toBe(true);
    expect(needsProbe(failed, 1000 + FAILED_TTL_MS - 1)).toBe(false);
    expect(needsProbe(failed, 1000 + FAILED_TTL_MS)).toBe(true);
  });

  it('treats a corrupt stored value as no verdict', () => {
    expect(parseVerdict('{nope')).toBeUndefined();
    expect(parseVerdict(JSON.stringify({ status: 'maybe', checkedAt: 1 }))).toBeUndefined();
    expect(parseVerdict(JSON.stringify(ok))).toEqual(ok);
  });
});

function makeService(opts: { enabled?: boolean; stored?: Record<string, ModelVerdict>; failStore?: boolean; now?: number; client?: ProbeClient } = {}) {
  const data = new Map(Object.entries(opts.stored ?? {}).map(([model, v]) => [`model-health:${model}`, JSON.stringify(v)]));
  const store: VerdictStore = {
    mget: jest.fn(async (...keys: string[]) => {
      if (opts.failStore) throw new Error('redis down');
      return keys.map((k) => data.get(k) ?? null);
    }),
    set: jest.fn(async (key: string, value: string) => {
      data.set(key, value);
      return 'OK';
    }),
  };
  const queue = { add: jest.fn(async (_name: string, _data: ProbeJobData, _opts: object): Promise<unknown> => undefined) };
  const clients = { getClientFor: jest.fn(async () => opts.client ?? clientWith(healthy)) };
  const service = new ModelHealthService({ enabled: opts.enabled ?? true, store, queue, clients, now: () => opts.now ?? 5000 });
  return { service, store, queue, clients, data };
}

describe('ModelHealthService', () => {
  const catalog = [{ id: 'good' }, { id: 'bad' }, { id: 'new' }, { id: 'old-ok' }];
  const stored = {
    good: { status: 'ok', checkedAt: 4000 } as ModelVerdict,
    bad: { status: 'failed', checkedAt: 4000, reason: 'status_404' } as ModelVerdict,
    'old-ok': { status: 'ok', checkedAt: 5000 - OK_TTL_MS - 1 } as ModelVerdict,
  };

  it('hides failed models, lists unknown ones, and queues a probe for unknown and stale verdicts only', async () => {
    const { service, queue } = makeService({ stored });
    const visible = await service.filterVisible('user-1', catalog);
    expect(visible.map((m) => m.id)).toEqual(['good', 'new', 'old-ok']);
    const queued = queue.add.mock.calls.map((c) => c[1].model).sort();
    expect(queued).toEqual(['new', 'old-ok']);
    expect(queue.add.mock.calls[0][2]).toMatchObject({ jobId: probeJobId('new'), removeOnComplete: true, removeOnFail: true });
  });

  it('keeps a stale failed verdict hidden while it is re-checked', async () => {
    const { service, queue } = makeService({ stored: { bad: { status: 'failed', checkedAt: 5000 - FAILED_TTL_MS - 1 } }, now: 5000 });
    expect((await service.filterVisible('u', [{ id: 'bad' }])).map((m) => m.id)).toEqual([]);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('lists every model when health is switched off, and touches nothing', async () => {
    const { service, store, queue } = makeService({ enabled: false, stored });
    expect(await service.filterVisible('u', catalog)).toEqual(catalog);
    expect(await service.isFailed('bad')).toBe(false);
    expect(store.mget).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('never breaks listing: a store error lists the catalog as it was', async () => {
    const { service } = makeService({ failStore: true });
    expect(await service.filterVisible('u', catalog)).toEqual(catalog);
    expect(await service.isFailed('bad')).toBe(false);
  });

  it('a queue error does not hide or break anything', async () => {
    const { service, queue } = makeService({ stored });
    queue.add.mockRejectedValue(new Error('queue down'));
    expect((await service.filterVisible('u', catalog)).map((m) => m.id)).toEqual(['good', 'new', 'old-ok']);
  });

  it('an inconclusive probe leaves a known verdict in place and lists an unknown model, retried after 10 minutes', async () => {
    const limited = Object.assign(new Error('x'), { status: 429 });
    const failedBefore = makeService({ stored: { bad: { status: 'failed', checkedAt: 1, reason: 'status_404' } }, now: 9000, client: clientWith(() => limited) });
    const kept = await failedBefore.service.runProbe({ userId: 'u', model: 'bad' });
    expect(kept).toEqual({ status: 'failed', checkedAt: 9000, reason: 'status_404' });

    const fresh = makeService({ now: 9000, client: clientWith(() => limited) });
    const unknown = await fresh.service.runProbe({ userId: 'u', model: 'new' });
    expect(unknown).toMatchObject({ status: 'unknown', checkedAt: 9000, reason: 'status_429' });
    expect((await fresh.service.filterVisible('u', [{ id: 'new' }])).map((m) => m.id)).toEqual(['new']);
    expect(fresh.queue.add).not.toHaveBeenCalled(); // not re-queued within the 10 minutes
  });

  it('says a model is failed only when its verdict is failed', async () => {
    const { service } = makeService({ stored });
    expect(await service.isFailed('bad')).toBe(true);
    expect(await service.isFailed('good')).toBe(false);
    expect(await service.isFailed('new')).toBe(false);
  });

  it('runs a probe with the triggering user\'s client and stores the verdict', async () => {
    const { service, clients, store } = makeService({ now: 9000 });
    const verdict = await service.runProbe({ userId: 'user-7', model: 'new' });
    expect(clients.getClientFor).toHaveBeenCalledWith('user-7');
    expect(verdict).toEqual({ status: 'ok', checkedAt: 9000 });
    expect(store.set).toHaveBeenCalledWith('model-health:new', JSON.stringify({ status: 'ok', checkedAt: 9000 }), 'EX', expect.any(Number));
  });

  it('skips the probe, storing nothing, when the user has no connection any more', async () => {
    const { service, clients, store } = makeService();
    clients.getClientFor.mockRejectedValue(new Error('no connection'));
    expect(await service.runProbe({ userId: 'gone', model: 'new' })).toBeUndefined();
    expect(store.set).not.toHaveBeenCalled();
  });

  it('builds a queue-safe job id (no colon) from a model name', () => {
    expect(probeJobId('azure_ai/mistral:latest')).toMatch(/^probe-[0-9a-f]{20}$/);
    expect(probeJobId('a')).toBe(probeJobId('a'));
    expect(probeJobId('a')).not.toBe(probeJobId('b'));
  });
});

describe('model pickers use the health filter', () => {
  it('the settings model list is filtered for a previewed token too', async () => {
    const clientFactory = { listModelsForToken: jest.fn(async () => [{ id: 'good', name: 'good', vision: false }, { id: 'bad', name: 'bad', vision: false }]) };
    const modelHealth = { filterVisible: jest.fn(async (_u: string, models: { id: string }[]) => models.filter((m) => m.id !== 'bad')) };
    const controller = new LlmConnectionController({} as never, {} as never, clientFactory as never, modelHealth as never);
    const result = await controller.getModels({ userId: 'u1' } as never, 'tok');
    expect(result.models.map((m) => m.id)).toEqual(['good']);
    expect(modelHealth.filterVisible).toHaveBeenCalledWith('u1', expect.any(Array));
  });
});
