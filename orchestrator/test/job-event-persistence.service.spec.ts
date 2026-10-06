import { JobEventPersistenceService } from '../src/modules/pipeline/job-event-persistence.service';

function makeSubscriber() {
  const handlers: Record<string, (...args: any[]) => void> = {};
  return {
    on: jest.fn((event: string, handler: (...args: any[]) => void) => {
      handlers[event] = handler;
    }),
    psubscribe: jest.fn().mockResolvedValue(1),
    __handlers: handlers,
  };
}

// backfillMissedEvents() now scans via ioredis's own cursor-based
// scanStream() (KEYS blocks the whole Redis instance for a full-keyspace
// scan -- see job-event-persistence.service.ts's own comment), so every
// fake commandClient below needs a scanStream() double instead of keys().
// Emits its matching keys as one 'data' batch then 'end', deferred a tick
// so all three .on() registrations (data/end/error) land first -- the
// same event order the real ioredis stream guarantees.
function fakeScanStream(keysForPattern: (pattern: string) => string[]) {
  return jest.fn().mockImplementation((opts: { match: string }) => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const stream = {
      on: (event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler;
        return stream;
      },
    };
    process.nextTick(() => {
      const keys = keysForPattern(opts.match);
      if (keys.length > 0) handlers.data?.(keys);
      handlers.end?.();
    });
    return stream;
  });
}

// backfillMissedEvents() runs unconditionally in onModuleInit -- every test
// below that doesn't care about backfill still needs a commandClient that
// resolves cleanly (no keys found), or it'd throw inside that fire-and-
// forget call and spam console.error for no reason relevant to the test.
function makeEmptyCommandClient() {
  return { on: jest.fn(), scanStream: fakeScanStream(() => []), lrange: jest.fn(), get: jest.fn() };
}

// The real 'pmessage' handler fires `void this.persist(...)` -- a
// fire-and-forget call, same as any other ioredis event listener in this
// codebase (see job-events.controller.ts's own 'message' handler). The
// handler itself returns undefined synchronously, so awaiting its call
// directly resolves before persist()'s internal `await
// this.prisma.jobEvent.create(...)` has actually settled. Flushing a real
// macrotask (not just a microtask -- covers both the mocked promise
// resolution and the try/catch around it) after invoking it is what makes
// these assertions deterministic.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('JobEventPersistenceService', () => {
  it('psubscribes to every job-events channel on module init', () => {
    const subscriber = makeSubscriber();
    const prisma = { jobEvent: { create: jest.fn() } };
    const service = new JobEventPersistenceService(subscriber as any, makeEmptyCommandClient() as any, prisma as any);

    service.onModuleInit();

    expect(subscriber.psubscribe).toHaveBeenCalledWith('job-events:*');
  });

  it('persists a typed notice as phase notice with its kind as the message and the payload as detail', async () => {
    const subscriber = makeSubscriber();
    const prisma = { jobEvent: { create: jest.fn().mockResolvedValue(undefined) } };
    const service = new JobEventPersistenceService(subscriber as any, makeEmptyCommandClient() as any, prisma as any);
    service.onModuleInit();

    const payload = {
      type: 'notice',
      id: 'n1',
      kind: 'output_limit_reached',
      severity: 'warning',
      count: 1,
      facts: { step: 'write', lastRef: 'det0_3' },
      emittedAt: '2026-10-06T10:00:00.000Z',
    };
    subscriber.__handlers.pmessage('job-events:*', 'job-events:job-1', JSON.stringify(payload));
    await flush();

    expect(prisma.jobEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jobId: 'job-1',
        phase: 'notice',
        message: 'output_limit_reached',
        detail: payload,
        severity: 'info',
        createdAt: new Date('2026-10-06T10:00:00.000Z'),
      }),
    });
  });

  it('persists a narration event with its full payload as detail', async () => {
    const subscriber = makeSubscriber();
    const prisma = { jobEvent: { create: jest.fn().mockResolvedValue(undefined) } };
    const service = new JobEventPersistenceService(subscriber as any, makeEmptyCommandClient() as any, prisma as any);
    service.onModuleInit();

    const payload = { type: 'narration', phase: 'score_requirements', message: 'Scoring 150 drafted requirement(s)' };
    subscriber.__handlers.pmessage('job-events:*', 'job-events:job-1', JSON.stringify(payload));
    await flush();

    expect(prisma.jobEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jobId: 'job-1',
        phase: 'score_requirements',
        message: 'Scoring 150 drafted requirement(s)',
        detail: payload,
        severity: 'info',
        createdAt: expect.any(Date), // no emittedAt in this payload -- falls back to "now"
      }),
    });
  });

  it('uses the payload\'s own emittedAt as createdAt, not the insertion time', async () => {
    // Real gap this closes (live-caught): a job that sat with a dead
    // BullMQ lock for a long time, then had its own past events replayed
    // via backfillMissedEvents() (or, live, published from an unrelated
    // slow path), must NOT have its staleness clock reset just because
    // Postgres happened to insert the row late.
    const subscriber = makeSubscriber();
    const prisma = { jobEvent: { create: jest.fn().mockResolvedValue(undefined) } };
    const service = new JobEventPersistenceService(subscriber as any, makeEmptyCommandClient() as any, prisma as any);
    service.onModuleInit();

    const payload = {
      type: 'narration',
      phase: 'describe_figure',
      message: 'Figure 2 so far',
      emittedAt: '2026-08-05T05:56:53.800Z',
    };
    subscriber.__handlers.pmessage('job-events:*', 'job-events:job-emitted-at', JSON.stringify(payload));
    await flush();

    expect(prisma.jobEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ createdAt: new Date('2026-08-05T05:56:53.800Z') }),
    });
  });

  it('falls back to "now" when emittedAt is missing, malformed, or not a string', async () => {
    const subscriber = makeSubscriber();
    const prisma = { jobEvent: { create: jest.fn().mockResolvedValue(undefined) } };
    const service = new JobEventPersistenceService(subscriber as any, makeEmptyCommandClient() as any, prisma as any);
    service.onModuleInit();

    const before = Date.now();
    subscriber.__handlers.pmessage(
      'job-events:*',
      'job-events:job-bad-emitted-at',
      JSON.stringify({ type: 'narration', phase: 'parse_done', message: 'x', emittedAt: 'not-a-date' }),
    );
    await flush();

    const createdAt = (prisma.jobEvent.create as jest.Mock).mock.calls[0][0].data.createdAt as Date;
    expect(createdAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('persists a plain stage transition (no type field) using the stage as both phase and message fallback', async () => {
    const subscriber = makeSubscriber();
    const prisma = { jobEvent: { create: jest.fn().mockResolvedValue(undefined) } };
    const service = new JobEventPersistenceService(subscriber as any, makeEmptyCommandClient() as any, prisma as any);
    service.onModuleInit();

    const payload = { stage: 'diff_ready' };
    subscriber.__handlers.pmessage('job-events:*', 'job-events:job-2', JSON.stringify(payload));
    await flush();

    expect(prisma.jobEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jobId: 'job-2',
        phase: 'diff_ready',
        message: 'diff_ready',
        detail: payload,
        severity: 'info',
      }),
    });
  });

  it('marks job_failed/failed narration as severity error', async () => {
    const subscriber = makeSubscriber();
    const prisma = { jobEvent: { create: jest.fn().mockResolvedValue(undefined) } };
    const service = new JobEventPersistenceService(subscriber as any, makeEmptyCommandClient() as any, prisma as any);
    service.onModuleInit();

    subscriber.__handlers.pmessage(
      'job-events:*',
      'job-events:job-3',
      JSON.stringify({ type: 'narration', phase: 'job_failed', message: 'Job failed: timed out' }),
    );
    await flush();

    expect(prisma.jobEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ severity: 'error' }) }),
    );
  });

  it('never throws on a malformed payload -- a long-lived subscriber must survive garbage on the channel', async () => {
    const subscriber = makeSubscriber();
    const prisma = { jobEvent: { create: jest.fn() } };
    const service = new JobEventPersistenceService(subscriber as any, makeEmptyCommandClient() as any, prisma as any);
    service.onModuleInit();

    expect(() => subscriber.__handlers.pmessage('job-events:*', 'job-events:job-4', 'not json')).not.toThrow();
    await flush();

    expect(prisma.jobEvent.create).not.toHaveBeenCalled();
  });

  it('never throws when prisma.create rejects -- a deleted job or a DB blip must not kill the subscriber', async () => {
    const subscriber = makeSubscriber();
    const prisma = { jobEvent: { create: jest.fn().mockRejectedValue(new Error('FK violation')) } };
    const service = new JobEventPersistenceService(subscriber as any, makeEmptyCommandClient() as any, prisma as any);
    service.onModuleInit();

    expect(() =>
      subscriber.__handlers.pmessage('job-events:*', 'job-events:job-5', JSON.stringify({ stage: 'failed' })),
    ).not.toThrow();
    await flush();
  });
});

describe('JobEventPersistenceService.backfillMissedEvents', () => {
  // Real gap this closes (live-caught): pub/sub only reaches a subscriber
  // connected AT THE MOMENT of publish -- if this service's own connection
  // was down (e.g. the orchestrator container mid-restart for an unrelated
  // deploy) exactly when an event published, it's durably lost forever even
  // though the SAME payload also landed in Redis's own bounded
  // narration-log LIST and `:current` key, written directly by the
  // publisher regardless of whether anyone was subscribed.

  it('persists narration-log entries that are missing from Postgres', async () => {
    const subscriber = makeSubscriber();
    const missed = JSON.stringify({ type: 'narration', phase: 'describe_figure', message: 'Figure 1: no useful caption returned' });
    const commandClient = {
      on: jest.fn(),
      scanStream: fakeScanStream((pattern) => (pattern.endsWith('narration-log') ? ['job-events:job-1:narration-log'] : [])),
      lrange: jest.fn().mockResolvedValue([missed]),
      get: jest.fn(),
    };
    const prisma = {
      jobEvent: {
        create: jest.fn().mockResolvedValue(undefined),
        findMany: jest.fn().mockResolvedValue([]), // nothing already persisted for this job
      },
    };
    const service = new JobEventPersistenceService(subscriber as any, commandClient as any, prisma as any);

    await service.backfillMissedEvents();

    expect(commandClient.lrange).toHaveBeenCalledWith('job-events:job-1:narration-log', 0, -1);
    expect(prisma.jobEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jobId: 'job-1',
        phase: 'describe_figure',
        message: 'Figure 1: no useful caption returned',
        detail: JSON.parse(missed),
        severity: 'info',
      }),
    });
  });

  it('does not re-persist an entry that is already in Postgres -- the common case for a job with no downtime overlap', async () => {
    const subscriber = makeSubscriber();
    const already = JSON.stringify({ type: 'narration', phase: 'parse_done', message: 'Finished parsing the document' });
    const commandClient = {
      on: jest.fn(),
      scanStream: fakeScanStream((pattern) => (pattern.endsWith('narration-log') ? ['job-events:job-2:narration-log'] : [])),
      lrange: jest.fn().mockResolvedValue([already]),
      get: jest.fn(),
    };
    const prisma = {
      jobEvent: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([{ phase: 'parse_done', message: 'Finished parsing the document' }]),
      },
    };
    const service = new JobEventPersistenceService(subscriber as any, commandClient as any, prisma as any);

    await service.backfillMissedEvents();

    expect(prisma.jobEvent.create).not.toHaveBeenCalled();
  });

  it('backfills the :current stage key when it is missing from Postgres', async () => {
    const subscriber = makeSubscriber();
    const commandClient = {
      on: jest.fn(),
      scanStream: fakeScanStream((pattern) => (pattern.endsWith(':current') ? ['job-events:job-3:current'] : [])),
      lrange: jest.fn(),
      get: jest.fn().mockResolvedValue(JSON.stringify({ stage: 'diff_ready' })),
    };
    const prisma = {
      jobEvent: { create: jest.fn().mockResolvedValue(undefined), findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new JobEventPersistenceService(subscriber as any, commandClient as any, prisma as any);

    await service.backfillMissedEvents();

    expect(prisma.jobEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jobId: 'job-3',
        phase: 'diff_ready',
        message: 'diff_ready',
        detail: { stage: 'diff_ready' },
        severity: 'info',
      }),
    });
  });

  it('backfills the :current stage key using its own emittedAt, not the backfill sweep\'s run time', async () => {
    const subscriber = makeSubscriber();
    const commandClient = {
      on: jest.fn(),
      scanStream: fakeScanStream((pattern) => (pattern.endsWith(':current') ? ['job-events:job-current-emitted-at:current'] : [])),
      lrange: jest.fn(),
      get: jest.fn().mockResolvedValue(JSON.stringify({ stage: 'running', emittedAt: '2026-08-04 14:21:34.187' })),
    };
    const prisma = {
      jobEvent: { create: jest.fn().mockResolvedValue(undefined), findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new JobEventPersistenceService(subscriber as any, commandClient as any, prisma as any);

    await service.backfillMissedEvents();

    expect(prisma.jobEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ createdAt: new Date('2026-08-04 14:21:34.187') }),
    });
  });

  it('never inserts the same entry twice when the same message repeats within one narration-log', async () => {
    // A figure-heavy document produces many structurally-similar entries --
    // dedup must key on the exact (phase, message) pair, not silently
    // collapse everything past the first duplicate found.
    const subscriber = makeSubscriber();
    const dup = JSON.stringify({ type: 'narration', phase: 'describe_figure', message: 'Figure 1: no useful caption returned' });
    const commandClient = {
      on: jest.fn(),
      scanStream: fakeScanStream((pattern) => (pattern.endsWith('narration-log') ? ['job-events:job-4:narration-log'] : [])),
      lrange: jest.fn().mockResolvedValue([dup, dup]),
      get: jest.fn(),
    };
    const prisma = {
      jobEvent: { create: jest.fn().mockResolvedValue(undefined), findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new JobEventPersistenceService(subscriber as any, commandClient as any, prisma as any);

    await service.backfillMissedEvents();

    expect(prisma.jobEvent.create).toHaveBeenCalledTimes(1);
  });
});
