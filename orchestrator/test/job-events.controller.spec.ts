import { JobEventsController } from '../src/modules/pipeline/job-events.controller';
import type { SessionUser } from '../src/modules/auth/session.service';

const TEST_USER: SessionUser = { userId: 'test-user-descriptor', displayName: 'Test User' };
// Every test below streams a job owned by TEST_USER -- the ownership check
// itself (job-events.controller.ts's own private helper) is covered
// separately; this fixture just needs to pass it so the rest of the
// existing SSE-behavior assertions are unaffected.
const fakeJobsService = { getById: jest.fn().mockResolvedValue({ userId: TEST_USER.userId }) };
// getEventHistory's own fakePrisma -- never touched by any existing
// streamEvents test, only present so the constructor's now-required third
// param resolves.
const fakePrisma = { jobEvent: { findMany: jest.fn().mockResolvedValue([]) } };

// JobEventsController streams a raw Response over an open connection — a
// real end-to-end check needs a running docker-compose stack (worker +
// Redis + orchestrator) and is documented as a manual `curl -N` step in
// task-7-report.md. This spec covers what is unit-testable in isolation:
// SSE headers, subscribing to the job-scoped channel, forwarding a
// published message as an `event: stage` frame, and closing the stream +
// releasing the subscriber connection on a terminal stage.
describe('JobEventsController', () => {
  function makeRes() {
    const handlers: Record<string, (...args: any[]) => void> = {};
    return {
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      on: jest.fn((event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler;
      }),
      __handlers: handlers,
    };
  }

  function makeSubscriber() {
    const handlers: Record<string, (...args: any[]) => void> = {};
    return {
      get: jest.fn().mockResolvedValue(null),
      lrange: jest.fn().mockResolvedValue([]),
      subscribe: jest.fn().mockResolvedValue(1),
      unsubscribe: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue(undefined),
      on: jest.fn((event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler;
      }),
      __handlers: handlers,
    };
  }

  it('sets SSE headers and subscribes to the job-scoped Redis channel', async () => {
    const subscriber = makeSubscriber();
    const factory = jest.fn().mockReturnValue(subscriber);
    const controller = new JobEventsController(factory as any, fakeJobsService as any, fakePrisma as any);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any, TEST_USER);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(res.flushHeaders).toHaveBeenCalled();
    expect(factory).toHaveBeenCalled();
    expect(subscriber.subscribe).toHaveBeenCalledWith('job-events:job-1');
  });

  it('forwards a published message as an SSE stage frame', async () => {
    const subscriber = makeSubscriber();
    const factory = jest.fn().mockReturnValue(subscriber);
    const controller = new JobEventsController(factory as any, fakeJobsService as any, fakePrisma as any);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any, TEST_USER);
    subscriber.__handlers.message('job-events:job-1', JSON.stringify({ stage: 'parse' }));

    expect(res.write).toHaveBeenCalledWith('event: stage\ndata: {"stage":"parse"}\n\n');
    expect(res.end).not.toHaveBeenCalled();
    expect(subscriber.quit).not.toHaveBeenCalled();
  });

  it('closes the stream and releases the subscriber on a terminal stage', async () => {
    const subscriber = makeSubscriber();
    const factory = jest.fn().mockReturnValue(subscriber);
    const controller = new JobEventsController(factory as any, fakeJobsService as any, fakePrisma as any);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any, TEST_USER);
    subscriber.__handlers.message('job-events:job-1', JSON.stringify({ stage: 'diff_ready' }));

    expect(res.end).toHaveBeenCalled();
    expect(subscriber.unsubscribe).toHaveBeenCalled();
    expect(subscriber.quit).toHaveBeenCalled();
  });

  it('closes the stream and releases the subscriber on a cancelled stage -- a cancel() must not leave the SSE connection dangling', async () => {
    const subscriber = makeSubscriber();
    const factory = jest.fn().mockReturnValue(subscriber);
    const controller = new JobEventsController(factory as any, fakeJobsService as any, fakePrisma as any);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any, TEST_USER);
    subscriber.__handlers.message('job-events:job-1', JSON.stringify({ stage: 'cancelled' }));

    expect(res.end).toHaveBeenCalled();
    expect(subscriber.unsubscribe).toHaveBeenCalled();
    expect(subscriber.quit).toHaveBeenCalled();
  });

  it('releases the subscriber when the client closes the connection', async () => {
    const subscriber = makeSubscriber();
    const factory = jest.fn().mockReturnValue(subscriber);
    const controller = new JobEventsController(factory as any, fakeJobsService as any, fakePrisma as any);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any, TEST_USER);
    res.__handlers.close();

    expect(subscriber.unsubscribe).toHaveBeenCalled();
    expect(subscriber.quit).toHaveBeenCalled();
  });

  it('registers an error listener on the subscriber to avoid unhandled EventEmitter throws', async () => {
    const subscriber = makeSubscriber();
    const factory = jest.fn().mockReturnValue(subscriber);
    const controller = new JobEventsController(factory as any, fakeJobsService as any, fakePrisma as any);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any, TEST_USER);

    expect(subscriber.__handlers.error).toBeInstanceOf(Function);
    // Should not throw when invoked.
    expect(() => subscriber.__handlers.error(new Error('boom'))).not.toThrow();
  });

  it('runs cleanup exactly once even when the terminal-stage message and the close event both fire', async () => {
    const subscriber = makeSubscriber();
    const factory = jest.fn().mockReturnValue(subscriber);
    const controller = new JobEventsController(factory as any, fakeJobsService as any, fakePrisma as any);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any, TEST_USER);
    // Terminal-stage branch fires cleanup + res.end(), which in a real
    // response triggers res.on('close') asynchronously afterwards — both
    // paths race to clean up the same subscriber connection.
    subscriber.__handlers.message('job-events:job-1', JSON.stringify({ stage: 'diff_ready' }));
    res.__handlers.close();

    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscriber.quit).toHaveBeenCalledTimes(1);
  });

  it('replays the last-known stage immediately when the client (re)connects mid-run', async () => {
    const subscriber = makeSubscriber();
    subscriber.get.mockResolvedValue(JSON.stringify({ stage: 'infer_hierarchy_start' }));
    const factory = jest.fn().mockReturnValue(subscriber);
    const controller = new JobEventsController(factory as any, fakeJobsService as any, fakePrisma as any);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any, TEST_USER);

    expect(subscriber.get).toHaveBeenCalledWith('job-events:job-1:current');
    expect(res.write).toHaveBeenCalledWith('event: stage\ndata: {"stage":"infer_hierarchy_start"}\n\n');
  });

  it('writes no replay frame when no stage has been recorded yet', async () => {
    const subscriber = makeSubscriber();
    const factory = jest.fn().mockReturnValue(subscriber);
    const controller = new JobEventsController(factory as any, fakeJobsService as any, fakePrisma as any);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any, TEST_USER);

    expect(res.write).not.toHaveBeenCalled();
  });

  it('forwards a narration-typed message as an SSE narration frame, without ending the stream', async () => {
    const subscriber = makeSubscriber();
    const factory = jest.fn().mockReturnValue(subscriber);
    const controller = new JobEventsController(factory as any, fakeJobsService as any, fakePrisma as any);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any, TEST_USER);
    const narrationPayload = JSON.stringify({ type: 'narration', phase: 'infer_hierarchy', message: 'Analyzing structure' });
    subscriber.__handlers.message('job-events:job-1', narrationPayload);

    expect(res.write).toHaveBeenCalledWith(`event: narration\ndata: ${narrationPayload}\n\n`);
    expect(res.end).not.toHaveBeenCalled();
    expect(subscriber.quit).not.toHaveBeenCalled();
  });

  it('replays the last-known narration on connect, from a separate Redis key than stage', async () => {
    const subscriber = makeSubscriber();
    const narrationPayload = JSON.stringify({ type: 'narration', phase: 'infer_hierarchy', message: 'Analyzing structure' });
    subscriber.lrange.mockImplementation((key: string) => {
      if (key === 'job-events:job-1:narration-log') return Promise.resolve([narrationPayload]);
      return Promise.resolve([]);
    });
    const factory = jest.fn().mockReturnValue(subscriber);
    const controller = new JobEventsController(factory as any, fakeJobsService as any, fakePrisma as any);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any, TEST_USER);

    expect(subscriber.lrange).toHaveBeenCalledWith('job-events:job-1:narration-log', 0, -1);
    expect(res.write).toHaveBeenCalledWith(`event: narration\ndata: ${narrationPayload}\n\n`);
  });

  it('replays the whole bounded narration history in order, not just the latest entry', async () => {
    // Real gap this closes: previously a reconnecting client only ever saw
    // the single most recent narration event -- a page reload silently
    // lost all prior activity-log history even though the job kept
    // progressing server-side.
    const subscriber = makeSubscriber();
    const first = JSON.stringify({ type: 'narration', phase: 'parse_done', message: 'Finished parsing' });
    const second = JSON.stringify({ type: 'narration', phase: 'analyze_section', message: 'Analyzing section 1' });
    subscriber.lrange.mockResolvedValue([first, second]);
    const factory = jest.fn().mockReturnValue(subscriber);
    const controller = new JobEventsController(factory as any, fakeJobsService as any, fakePrisma as any);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any, TEST_USER);

    const writeCalls = res.write.mock.calls.map((call: unknown[]) => call[0]);
    expect(writeCalls).toContain(`event: narration\ndata: ${first}\n\n`);
    expect(writeCalls).toContain(`event: narration\ndata: ${second}\n\n`);
    expect(writeCalls.indexOf(`event: narration\ndata: ${first}\n\n`)).toBeLessThan(
      writeCalls.indexOf(`event: narration\ndata: ${second}\n\n`),
    );
  });

  it('quits the leaked subscriber connection when subscribe() rejects', async () => {
    const subscriber = makeSubscriber();
    subscriber.subscribe.mockRejectedValue(new Error('connection refused'));
    const factory = jest.fn().mockReturnValue(subscriber);
    const controller = new JobEventsController(factory as any, fakeJobsService as any, fakePrisma as any);
    const res = makeRes();

    await expect(controller.streamEvents('job-1', res as any, TEST_USER)).rejects.toThrow('connection refused');

    expect(subscriber.quit).toHaveBeenCalledTimes(1);
    // res.on('close') should never have been registered — streamEvents
    // threw before reaching that point.
    expect(res.__handlers.close).toBeUndefined();
  });

  describe('getEventHistory', () => {
    it('returns the persisted event history ordered oldest-first', async () => {
      const rows = [{ id: 'e1', phase: 'parse_done', message: 'Finished parsing', createdAt: new Date('2026-08-04T11:32:00Z') }];
      const prisma = { jobEvent: { findMany: jest.fn().mockResolvedValue(rows) } };
      const factory = jest.fn();
      const controller = new JobEventsController(factory as any, fakeJobsService as any, prisma as any);

      const result = await controller.getEventHistory('job-1', TEST_USER);

      expect(prisma.jobEvent.findMany).toHaveBeenCalledWith({ where: { jobId: 'job-1' }, orderBy: { createdAt: 'asc' } });
      expect(result).toBe(rows);
    });

    it('404s for a job the user does not own -- same convention as streamEvents', async () => {
      const otherUserJobsService = { getById: jest.fn().mockResolvedValue({ userId: 'someone-else' }) };
      const controller = new JobEventsController(jest.fn() as any, otherUserJobsService as any, fakePrisma as any);

      await expect(controller.getEventHistory('job-1', TEST_USER)).rejects.toThrow('Job job-1 not found');
    });
  });
});
