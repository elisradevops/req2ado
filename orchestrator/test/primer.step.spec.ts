import { runPrimerStep, type PrimerNarration, type PrimerStepClient } from '../src/modules/pipeline/primer.step';

// The whole-document primer is the first long step of a SURVEY job. These tests pin what the user sees (named steps with a
// timer), that it can never run unbounded (a budget), that a cancel stops it, and that its failures stay fail-open.

const job = { id: 'job-1', filename: 'x.docx', fileBuffer: Buffer.from('document bytes') };
const options = { budgetSeconds: 180, heartbeatSeconds: 10, skipMemorySeconds: 3600 };

function setup(overrides: Partial<PrimerStepClient> = {}) {
  const client: PrimerStepClient = {
    chatModel: 'gemma4:12b',
    uploadFile: jest.fn().mockResolvedValue('file-1'),
    pollFileProcessed: jest.fn().mockResolvedValue(true),
    chatWithFullFileContext: jest.fn().mockResolvedValue({ content: '  This is an avionics ICD.  ' }),
    deleteFile: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const store = new Map<string, string>();
  const cache = {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
  };
  const narrations: PrimerNarration[] = [];
  const narrate = jest.fn(async (n: PrimerNarration) => {
    narrations.push(n);
  });
  const run = (extra: { signal?: AbortSignal; options?: Partial<typeof options> } = {}) =>
    runPrimerStep({ job, model: 'gemma4:12b', getClient: async () => client, cache, narrate, options: { ...options, ...extra.options }, signal: extra.signal });
  return { client, cache, store, narrations, narrate, run };
}
const steps = (narrations: PrimerNarration[]) => narrations.map((n) => n.primerStep);

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('primer step: what the user sees', () => {
  it('names each step in order with an elapsed time, and returns the trimmed primer', async () => {
    const { run, narrations, client, cache } = setup();
    const result = await run();
    expect(result.primerContext).toBe('This is an avionics ICD.');
    expect(result.warnings).toEqual([]);
    expect(steps(narrations)).toEqual(['uploading', 'processing', 'reading', 'done']);
    expect(narrations.every((n) => typeof n.message === 'string' && n.message.length > 0 && n.elapsedSeconds >= 0)).toBe(true);
    expect(client.deleteFile).toHaveBeenCalledWith('file-1');
    expect(cache.set).toHaveBeenCalledWith(expect.stringContaining('primer:gemma4:12b:'), 'This is an avionics ICD.', 'EX', 86_400);
  });

  it('says it reused a saved overview and uploads nothing on a cache hit', async () => {
    const { run, narrations, client, cache } = setup();
    cache.get.mockResolvedValueOnce('saved overview');
    const result = await run();
    expect(result.primerContext).toBe('saved overview');
    expect(steps(narrations)).toEqual(['cached']);
    expect(client.uploadFile).not.toHaveBeenCalled();
  });

  it('keeps the timer moving while the model reads: a heartbeat every few seconds with a growing elapsed time', async () => {
    let finish!: (v: { content: string }) => void;
    const { run, narrations } = setup({ chatWithFullFileContext: jest.fn(() => new Promise((resolve) => (finish = resolve as typeof finish))) });
    const pending = run();
    await jest.advanceTimersByTimeAsync(35_000);
    const reading = narrations.filter((n) => n.primerStep === 'reading');
    expect(reading.length).toBeGreaterThanOrEqual(4); // the start plus a beat every 10 s
    const elapsed = reading.map((n) => n.elapsedSeconds);
    expect([...elapsed].sort((a, b) => a - b)).toEqual(elapsed);
    expect(elapsed[elapsed.length - 1]).toBeGreaterThanOrEqual(30);
    finish({ content: 'done' });
    await pending;
    // no heartbeat after the step ended
    const before = narrations.length;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(narrations.length).toBe(before);
  });
});

describe('primer step: it cannot run unbounded', () => {
  const hangUntilAborted = (opts: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => opts.signal?.addEventListener('abort', () => reject(new Error('aborted'))));

  it('gives up at the budget, carries on without a primer, and says why', async () => {
    const { run, narrations, client, cache } = setup({ chatWithFullFileContext: jest.fn((_c, _f, opts) => hangUntilAborted(opts)) as any });
    const pending = run();
    await jest.advanceTimersByTimeAsync(181_000);
    const result = await pending;
    expect(result.primerContext).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ kind: 'primer_unavailable', severity: 'pipeline_issue', detail: { reason: 'timeout', budgetSeconds: 180 } });
    expect(steps(narrations)[steps(narrations).length - 1]).toBe('timed_out');
    expect(client.deleteFile).toHaveBeenCalledWith('file-1'); // the uploaded file is still cleaned up
    expect(cache.set).not.toHaveBeenCalledWith(expect.stringContaining('primer:'), expect.anything(), expect.anything(), expect.anything());
  });

  it('remembers the timeout for an hour so the same document is not waited on again', async () => {
    const { run, cache, store } = setup({ chatWithFullFileContext: jest.fn((_c, _f, opts) => hangUntilAborted(opts)) as any });
    const pending = run();
    await jest.advanceTimersByTimeAsync(181_000);
    await pending;
    const skipKey = [...store.keys()].find((k) => k.startsWith('primer-skip:gemma4:12b:'));
    expect(skipKey).toBeDefined();
    expect(cache.set).toHaveBeenCalledWith(skipKey, expect.any(String), 'EX', 3600);

    const second = setup();
    second.cache.get.mockImplementation(async (key: string) => (key.startsWith('primer-skip:') ? '1' : null));
    const result = await second.run();
    expect(result.primerContext).toBeUndefined();
    expect(result.warnings[0]).toMatchObject({ detail: { reason: 'recent_timeout' } });
    expect(steps(second.narrations)).toEqual(['skipped']);
    expect(second.client.uploadFile).not.toHaveBeenCalled();
  });

  it('with the budget off (0) nothing is aborted however long it takes', async () => {
    let seen: AbortSignal | undefined;
    const { run } = setup({
      chatWithFullFileContext: jest.fn(async (_c, _f, opts) => {
        seen = opts.signal;
        await new Promise((resolve) => setTimeout(resolve, 900_000));
        return { content: 'late but fine' };
      }) as any,
    });
    const pending = run({ options: { budgetSeconds: 0 } });
    await jest.advanceTimersByTimeAsync(901_000);
    expect((await pending).primerContext).toBe('late but fine');
    expect(seen?.aborted).toBeFalsy();
  });

  it('a slow upload or processing step counts against the same budget', async () => {
    const { run, client, narrations } = setup({ pollFileProcessed: jest.fn((_id, _ms, signal) => hangUntilAborted({ signal })) as any });
    const pending = run();
    await jest.advanceTimersByTimeAsync(181_000);
    const result = await pending;
    expect(result.warnings[0]).toMatchObject({ detail: { reason: 'timeout' } });
    expect(client.chatWithFullFileContext).not.toHaveBeenCalled();
    expect(steps(narrations)).toContain('processing');
  });
});

describe('primer step: cancel and failures', () => {
  it('a cancelled job aborts the step and the error reaches the caller (no warning, file cleaned up)', async () => {
    const controller = new AbortController();
    const { run, client } = setup({
      chatWithFullFileContext: jest.fn((_c, _f, opts) => new Promise((_r, reject) => opts.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as any,
    });
    const pending = run({ signal: controller.signal });
    const settled = pending.then(() => 'resolved', (e) => e);
    await jest.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await jest.advanceTimersByTimeAsync(10);
    expect(await settled).toBeInstanceOf(Error);
    expect(client.deleteFile).toHaveBeenCalledWith('file-1');
  });

  it('stays fail-open on an ordinary failure: no primer, a warning with the reason, nothing cached', async () => {
    const { run, narrations, cache } = setup({ uploadFile: jest.fn().mockRejectedValue(new Error('no /api/v1/files')) });
    const result = await run();
    expect(result.primerContext).toBeUndefined();
    expect(result.warnings[0]).toMatchObject({ kind: 'primer_unavailable', detail: { reason: 'error' } });
    expect(steps(narrations)[steps(narrations).length - 1]).toBe('failed');
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('a model the file-context route refuses falls back once to the client model, as before', async () => {
    const chat = jest.fn().mockRejectedValueOnce(new Error('Model not found')).mockResolvedValueOnce({ content: 'ok' });
    const { run, client } = setup({ chatModel: 'llama3', chatWithFullFileContext: chat });
    const result = await run();
    expect(result.primerContext).toBe('ok');
    expect(chat.mock.calls[0][2].model).toBe('gemma4:12b');
    expect(chat.mock.calls[1][2].model).toBe('llama3');
    expect(client.deleteFile).toHaveBeenCalledTimes(1);
  });

  it('a processing failure (not completed) ends without a primer and without a warning about a timeout', async () => {
    const { run } = setup({ pollFileProcessed: jest.fn().mockResolvedValue(false) });
    const result = await run();
    expect(result.primerContext).toBeUndefined();
    expect(result.warnings.every((w) => (w.detail as any)?.reason !== 'timeout')).toBe(true);
  });
});


describe('primer step: review follow-ups', () => {
  it('a deleteFile that rejects never fails the step (the clean-up is best effort)', async () => {
    const { run } = setup({ deleteFile: jest.fn().mockRejectedValue(new Error('delete refused')) });
    const result = await run();
    expect(result.primerContext).toBe('This is an avionics ICD.');
  });

  it('a deleteFile that throws synchronously or returns no promise never fails the step either', async () => {
    const throwing = setup({ deleteFile: jest.fn(() => { throw new Error('boom'); }) as any });
    expect((await throwing.run()).primerContext).toBe('This is an avionics ICD.');
    const plain = setup({ deleteFile: jest.fn(() => undefined) as any });
    expect((await plain.run()).primerContext).toBe('This is an avionics ICD.');
  });

  it('a deleteFile that never answers cannot hold the job past the step', async () => {
    const { run } = setup({ deleteFile: jest.fn(() => new Promise<void>(() => undefined)) });
    const pending = run();
    await jest.advanceTimersByTimeAsync(20_000);
    expect((await pending).primerContext).toBe('This is an avionics ICD.');
  });

  it('the budget also ends a step stuck before any upload (a hung cache or client lookup)', async () => {
    const { run, cache } = setup();
    cache.get.mockImplementation(() => new Promise<string | null>(() => undefined));
    const pending = run();
    await jest.advanceTimersByTimeAsync(181_000);
    const result = await pending;
    expect(result.primerContext).toBeUndefined();
    expect(result.warnings[0]).toMatchObject({ detail: { reason: 'timeout' } });
  });

  it('a cancel ends a step stuck before any upload', async () => {
    const controller = new AbortController();
    const { run, cache } = setup();
    cache.get.mockImplementation(() => new Promise<string | null>(() => undefined));
    const settled = run({ signal: controller.signal }).then(() => 'resolved', (e) => e);
    await jest.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await jest.advanceTimersByTimeAsync(10);
    expect(await settled).toBeDefined();
    expect(await settled).not.toBe('resolved');
  });

  it('a slow skip-key write does not delay the end of a timed-out step', async () => {
    const { run, cache } = setup({ chatWithFullFileContext: jest.fn((_c, _f, opts) => new Promise((_r, reject) => opts.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as any });
    cache.set.mockImplementation(() => new Promise(() => undefined));
    const pending = run();
    await jest.advanceTimersByTimeAsync(181_000);
    const result = await pending;
    expect(result.warnings[0]).toMatchObject({ detail: { reason: 'timeout' } });
  });
});
