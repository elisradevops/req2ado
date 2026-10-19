import { KbProfileScheduler, profileJobId, type ProfileQueue } from '../src/modules/kb/kb-profile.scheduler';
import { KbService } from '../src/modules/kb/kb.service';
import { IngestionHttpClient } from '../src/modules/pipeline/ingestion-http.client';

const queue = () => ({ add: jest.fn(async (..._args: unknown[]) => undefined), close: jest.fn(async () => undefined) }) satisfies ProfileQueue;
const resolver = (chatModel: string | null) => ({ resolve: jest.fn(async () => (chatModel ? { apiKey: 'k', chatModel } : null)) });

describe('KbProfileScheduler', () => {
  it('queues one debounced job per user, so several ingests in a row cause one build', async () => {
    const q = queue();
    const scheduler = new KbProfileScheduler({ queue: q, ingestion: {} as never, resolver: resolver('m') as never, profileModel: '' });
    await scheduler.schedule('user-1');
    await scheduler.schedule('user-1');
    expect(q.add).toHaveBeenCalledTimes(2);
    const [name, data, opts] = q.add.mock.calls[0] as [string, { userId: string }, { jobId: string; delay: number; removeOnComplete: boolean }];
    expect(name).toBe('build');
    expect(data).toEqual({ userId: 'user-1' });
    expect(opts.jobId).toBe(profileJobId('user-1'));
    expect(opts.delay).toBeGreaterThan(0);
    expect(opts.removeOnComplete).toBe(true);
    expect(profileJobId('user-1')).not.toBe(profileJobId('user-2'));
    expect(profileJobId('vstfs:///Framework/Identity/a')).toMatch(/^kb-profile-[0-9a-f]+$/); // no ':' (BullMQ ids)
  });

  it('never breaks the KB action that triggered it: a queue error is swallowed', async () => {
    const q = queue();
    q.add.mockRejectedValue(new Error('redis down'));
    const scheduler = new KbProfileScheduler({ queue: q, ingestion: {} as never, resolver: resolver('m') as never, profileModel: '' });
    await expect(scheduler.schedule('user-1')).resolves.toBeUndefined();
  });

  it('a KB change that arrives while a build runs is built afterwards, not dropped by the fixed job id', async () => {
    const q = queue();
    let release: () => void = () => undefined;
    const ingestion = { buildKbProfile: jest.fn(() => new Promise((resolve) => { release = () => resolve({ docsInKb: 1, docsContributing: 1, builtWith: 'm' }); })) };
    const scheduler = new KbProfileScheduler({ queue: q, ingestion: ingestion as never, resolver: resolver('m') as never, profileModel: '' });
    const running = scheduler.run({ userId: 'user-1' });
    await new Promise((r) => setImmediate(r));
    await scheduler.schedule('user-1'); // arrives mid-build
    expect(q.add).not.toHaveBeenCalled(); // same job id is active: a queue add would be ignored
    release();
    await running;
    expect(q.add).toHaveBeenCalledTimes(1);
  });

  it('builds with the configured profile model, else the user\'s own default chat model', async () => {
    const ingestion = { buildKbProfile: jest.fn(async () => ({ docsInKb: 3, docsContributing: 3 })) };
    await new KbProfileScheduler({ queue: queue(), ingestion: ingestion as never, resolver: resolver('user-default') as never, profileModel: '' }).run({ userId: 'u1' });
    expect(ingestion.buildKbProfile).toHaveBeenLastCalledWith('u1', 'user-default');
    await new KbProfileScheduler({ queue: queue(), ingestion: ingestion as never, resolver: resolver('user-default') as never, profileModel: 'pinned' }).run({ userId: 'u1' });
    expect(ingestion.buildKbProfile).toHaveBeenLastCalledWith('u1', 'pinned');
  });

  it('skips quietly when the user has no model connection, has no KB (404) or the build fails', async () => {
    const ingestion = { buildKbProfile: jest.fn() };
    const none = new KbProfileScheduler({ queue: queue(), ingestion: ingestion as never, resolver: resolver(null) as never, profileModel: '' });
    expect(await none.run({ userId: 'u1' })).toBeUndefined();
    expect(ingestion.buildKbProfile).not.toHaveBeenCalled();

    ingestion.buildKbProfile.mockResolvedValueOnce(null);
    const noKb = new KbProfileScheduler({ queue: queue(), ingestion: ingestion as never, resolver: resolver('m') as never, profileModel: '' });
    expect(await noKb.run({ userId: 'u1' })).toBeUndefined();

    ingestion.buildKbProfile.mockRejectedValueOnce(new Error('ingestion down'));
    await expect(noKb.run({ userId: 'u1' })).resolves.toBeUndefined();
  });
});

describe('IngestionHttpClient.buildKbProfile', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('posts the user and model, returns the summary, and maps "no documents" (404) to null', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ docsInKb: 3, docsContributing: 2, builtWith: 'm' }) });
    const client = new IngestionHttpClient('http://ingestion.internal');
    expect(await client.buildKbProfile('u1', 'm')).toMatchObject({ docsInKb: 3, docsContributing: 2 });
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/kb/profile');
    expect(JSON.parse(options.body)).toEqual({ user_id: 'u1', model: 'm' });

    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'none', json: async () => ({}) });
    expect(await client.buildKbProfile('u1', 'm')).toBeNull();
  });
});

describe('KbService schedules a profile rebuild after a change of the knowledge base', () => {
  const vault = { get: jest.fn(async () => null) } as never;

  it('after an ingest and after a delete, never for another user', async () => {
    const scheduler = { schedule: jest.fn(async () => undefined) };
    const prisma = {
      ingestedDocument: {
        upsert: jest.fn(async () => ({ id: 'row-1' })),
        findUnique: jest.fn(async () => ({ id: 'row-1', userId: 'u1', name: 'a.pptx', driveItemId: 'd1' })),
        delete: jest.fn(async () => undefined),
      },
    };
    const ingestion = {
      ingestUrl: jest.fn(async () => ({ driveitemId: 'd1', documentName: 'a.pptx', sizeBytes: 1, mimeType: null, chunksStored: 1, skippedUnchanged: false })),
      deleteDocument: jest.fn(async () => undefined),
    };
    const service = new KbService(prisma as never, ingestion as never, vault, scheduler as never);
    await service.ingestUrl('https://x/y', 'u1', null);
    expect(scheduler.schedule).toHaveBeenCalledWith('u1');
    scheduler.schedule.mockClear();
    await service.deleteDocument('row-1', 'someone-else');
    expect(scheduler.schedule).not.toHaveBeenCalled();
    await service.deleteDocument('row-1', 'u1');
    expect(scheduler.schedule).toHaveBeenCalledWith('u1');
  });
});


describe('KbService audit trail', () => {
  it('logs a removed document by file name and a hashed user, never the user identity', async () => {
    const { Logger } = await import('@nestjs/common');
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const prisma = {
      ingestedDocument: {
        findUnique: jest.fn(async () => ({ id: 'row-1', userId: 'vstfs:///Framework/Identity/abc', name: 'a.pptx', driveItemId: 'd1' })),
        delete: jest.fn(async () => undefined),
      },
    };
    const service = new KbService(prisma as never, { deleteDocument: jest.fn() } as never, { get: jest.fn() } as never);
    await service.deleteDocument('row-1', 'vstfs:///Framework/Identity/abc');
    const line = String(log.mock.calls.map((c) => c[0]).find((m) => String(m).includes('KB document removed')));
    expect(line).toContain('a.pptx');
    expect(line).not.toContain('Identity/abc');
    log.mockRestore();
  });
});
