import { JobEventsController } from '../src/modules/pipeline/job-events.controller';
import type { SessionUser } from '../src/modules/auth/session.service';

const TEST_USER: SessionUser = { userId: 'test-user-descriptor', displayName: 'Test User' };
// Every test below streams a job owned by TEST_USER -- the ownership check
// itself (job-events.controller.ts's own private helper) is covered
// separately; this fixture just needs to pass it so the rest of the
// existing SSE-behavior assertions are unaffected.
const fakeJobsService = { getById: jest.fn().mockResolvedValue({ userId: TEST_USER.userId }) };
// getEventHistory's own fakePrisma -- never touched by any existing
// streamEvents test, only present so the constructor's now-required prisma
// param resolves.
const fakePrisma = { jobEvent: { findMany: jest.fn().mockResolvedValue([]) } };

// JobEventsController streams a raw Response over an open connection — a
// real end-to-end check needs a running docker-compose stack (worker +
// Redis + orchestrator) and is documented as a manual `curl -N` step in
// task-7-report.md. This spec covers what is unit-testable in isolation:
// SSE headers, subscribing to the job-scoped channel, forwarding a
// published message as an `event: stage` frame, closing the stream +
// releasing the subscriber connection on a terminal stage, and (SWEEP.md
// section 8a) the replay/subscribe race window.
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

  // The per-SSE-connection subscriber. `subscribe` accepts an optional
  // `onSubscribe` hook so a test can publish a message from INSIDE the
  // subscribe round trip -- one of the two halves of the race window this
  // fix targets.
  function makeSubscriber(onSubscribe?: (fire: (raw: string) => void) => void) {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const fire = (raw: string) => handlers.message?.('job-events:job-1', raw);
    return {
      // Present but never used for replay any more: the replay reads moved
      // to the shared command client, because this connection is
      // .subscribe()'d first and an ioredis client in subscriber mode can't
      // issue GET/LRANGE. Kept on the fake so a regression that reads from
      // the wrong client is caught by an explicit not.toHaveBeenCalled()
      // assertion rather than a confusing "is not a function".
      get: jest.fn().mockResolvedValue(null),
      lrange: jest.fn().mockResolvedValue([]),
      subscribe: jest.fn(async () => {
        onSubscribe?.(fire);
        return 1;
      }),
      unsubscribe: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue(undefined),
      on: jest.fn((event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler;
      }),
      __handlers: handlers,
      __fire: fire,
    };
  }

  // The shared, never-subscribed command client the replay reads now run on.
  // `onLrange` fires while the replay read is in flight -- the OTHER half of
  // the race window (under the old ordering this was after the reads and
  // before subscribe, i.e. delivered to nobody).
  function makeCommandClient(opts: { current?: string | null; narrationLog?: string[]; onLrange?: () => void } = {}) {
    return {
      get: jest.fn().mockResolvedValue(opts.current ?? null),
      lrange: jest.fn(async () => {
        opts.onLrange?.();
        return opts.narrationLog ?? [];
      }),
      quit: jest.fn().mockResolvedValue(undefined),
      unsubscribe: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };
  }

  function makeController(subscriber: unknown, commandClient: unknown = makeCommandClient(), prisma: unknown = fakePrisma) {
    const factory = jest.fn().mockReturnValue(subscriber);
    const controller = new JobEventsController(factory as any, commandClient as any, fakeJobsService as any, prisma as any);
    return { controller, factory };
  }

  it('sets SSE headers and subscribes to the job-scoped Redis channel', async () => {
    const subscriber = makeSubscriber();
    const { controller, factory } = makeController(subscriber);
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
    const { controller } = makeController(subscriber);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any, TEST_USER);
    subscriber.__handlers.message('job-events:job-1', JSON.stringify({ stage: 'parse' }));

    expect(res.write).toHaveBeenCalledWith('event: stage\ndata: {"stage":"parse"}\n\n');
    expect(res.end).not.toHaveBeenCalled();
    expect(subscriber.quit).not.toHaveBeenCalled();
  });

  it('closes the stream and releases the subscriber on a terminal stage', async () => {
    const subscriber = makeSubscriber();
    const { controller } = makeController(subscriber);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any, TEST_USER);
    subscriber.__handlers.message('job-events:job-1', JSON.stringify({ stage: 'diff_ready' }));

    expect(res.end).toHaveBeenCalled();
    expect(subscriber.unsubscribe).toHaveBeenCalled();
    expect(subscriber.quit).toHaveBeenCalled();
  });

  it('closes the stream and releases the subscriber on a cancelled stage -- a cancel() must not leave the SSE connection dangling', async () => {
    const subscriber = makeSubscriber();
    const { controller } = makeController(subscriber);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any, TEST_USER);
    subscriber.__handlers.message('job-events:job-1', JSON.stringify({ stage: 'cancelled' }));

    expect(res.end).toHaveBeenCalled();
    expect(subscriber.unsubscribe).toHaveBeenCalled();
    expect(subscriber.quit).toHaveBeenCalled();
  });

  it('releases the subscriber when the client closes the connection', async () => {
    const subscriber = makeSubscriber();
    const { controller } = makeController(subscriber);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any, TEST_USER);
    res.__handlers.close();

    expect(subscriber.unsubscribe).toHaveBeenCalled();
    expect(subscriber.quit).toHaveBeenCalled();
  });

  it('registers an error listener on the subscriber to avoid unhandled EventEmitter throws', async () => {
    const subscriber = makeSubscriber();
    const { controller } = makeController(subscriber);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any, TEST_USER);

    expect(subscriber.__handlers.error).toBeInstanceOf(Function);
    // Should not throw when invoked.
    expect(() => subscriber.__handlers.error(new Error('boom'))).not.toThrow();
  });

  it('runs cleanup exactly once even when the terminal-stage message and the close event both fire', async () => {
    const subscriber = makeSubscriber();
    const { controller } = makeController(subscriber);
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
    const commandClient = makeCommandClient({ current: JSON.stringify({ stage: 'infer_hierarchy_start' }) });
    const { controller } = makeController(subscriber, commandClient);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any, TEST_USER);

    expect(commandClient.get).toHaveBeenCalledWith('job-events:job-1:current');
    expect(res.write).toHaveBeenCalledWith('event: stage\ndata: {"stage":"infer_hierarchy_start"}\n\n');
  });

  it('writes no replay frame when no stage has been recorded yet', async () => {
    const subscriber = makeSubscriber();
    const { controller } = makeController(subscriber);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any, TEST_USER);

    expect(res.write).not.toHaveBeenCalled();
  });

  it('forwards a narration-typed message as an SSE narration frame, without ending the stream', async () => {
    const subscriber = makeSubscriber();
    const { controller } = makeController(subscriber);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any, TEST_USER);
    const narrationPayload = JSON.stringify({ type: 'narration', phase: 'infer_hierarchy', message: 'Analyzing structure' });
    subscriber.__handlers.message('job-events:job-1', narrationPayload);

    expect(res.write).toHaveBeenCalledWith(`event: narration\ndata: ${narrationPayload}\n\n`);
    expect(res.end).not.toHaveBeenCalled();
    expect(subscriber.quit).not.toHaveBeenCalled();
  });

  it('replays the last-known narration on connect, from a separate Redis key than stage', async () => {
    const narrationPayload = JSON.stringify({ type: 'narration', phase: 'infer_hierarchy', message: 'Analyzing structure' });
    const subscriber = makeSubscriber();
    const commandClient = makeCommandClient({ narrationLog: [narrationPayload] });
    const { controller } = makeController(subscriber, commandClient);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any, TEST_USER);

    expect(commandClient.lrange).toHaveBeenCalledWith('job-events:job-1:narration-log', 0, -1);
    expect(res.write).toHaveBeenCalledWith(`event: narration\ndata: ${narrationPayload}\n\n`);
  });

  it('replays the whole bounded narration history in order, not just the latest entry', async () => {
    // Real gap this closes: previously a reconnecting client only ever saw
    // the single most recent narration event -- a page reload silently
    // lost all prior activity-log history even though the job kept
    // progressing server-side.
    const first = JSON.stringify({ type: 'narration', phase: 'parse_done', message: 'Finished parsing' });
    const second = JSON.stringify({ type: 'narration', phase: 'analyze_section', message: 'Analyzing section 1' });
    const subscriber = makeSubscriber();
    const { controller } = makeController(subscriber, makeCommandClient({ narrationLog: [first, second] }));
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
    const { controller } = makeController(subscriber);
    const res = makeRes();

    await expect(controller.streamEvents('job-1', res as any, TEST_USER)).rejects.toThrow('connection refused');

    expect(subscriber.quit).toHaveBeenCalledTimes(1);
    // res.on('close') should never have been registered — streamEvents
    // threw before reaching that point.
    expect(res.__handlers.close).toBeUndefined();
  });

  // SWEEP.md section 8a: an event published in the window between the replay
  // read and the subscribe call used to be delivered to nobody, and a
  // terminal one left the client stalled on "running" until reload. The fix
  // subscribes first and buffers the window; these tests pin down that the
  // buffered event arrives EXACTLY once -- the old bug was zero times, and a
  // naive reorder would make narration arrive twice.
  describe('replay/subscribe race window', () => {
    const framesFor = (res: ReturnType<typeof makeRes>, raw: string, event: 'stage' | 'narration') =>
      (res.write.mock.calls.map((call: unknown[]) => call[0]) as string[]).filter((w) => w === `event: ${event}\ndata: ${raw}\n\n`);

    it('subscribes BEFORE issuing the replay reads', async () => {
      // The whole ordering premise. If the reads ran first, everything below
      // would be untestable and the bug would still be live.
      const order: string[] = [];
      const subscriber = makeSubscriber(() => order.push('subscribe'));
      const commandClient = makeCommandClient({ onLrange: () => order.push('lrange') });
      commandClient.get.mockImplementation(async () => {
        order.push('get');
        return null;
      });
      const { controller } = makeController(subscriber, commandClient);

      await controller.streamEvents('job-1', makeRes() as any, TEST_USER);

      expect(order).toEqual(['subscribe', 'get', 'lrange']);
    });

    it('runs the replay reads on the shared command client, never on the subscribed connection', async () => {
      // A .subscribe()'d ioredis connection cannot issue GET/LRANGE at all --
      // reading from it after the reorder would fail at runtime against a
      // real Redis while passing silently against a permissive fake.
      const subscriber = makeSubscriber();
      const commandClient = makeCommandClient();
      const { controller } = makeController(subscriber, commandClient);

      await controller.streamEvents('job-1', makeRes() as any, TEST_USER);

      expect(commandClient.get).toHaveBeenCalledWith('job-events:job-1:current');
      expect(commandClient.lrange).toHaveBeenCalledWith('job-events:job-1:narration-log', 0, -1);
      expect(subscriber.get).not.toHaveBeenCalled();
      expect(subscriber.lrange).not.toHaveBeenCalled();
    });

    it('delivers a narration published DURING the replay read exactly once when it is not in the snapshot', async () => {
      // The exact old race window: published after the snapshot was taken,
      // before the subscription would have been armed. Old behaviour: lost.
      const raced = JSON.stringify({ type: 'narration', phase: 'analyze_section', message: 'Analyzing section 7', emittedAt: '2026-08-31T09:00:01.000Z' });
      const subscriber = makeSubscriber();
      const commandClient = makeCommandClient({ onLrange: () => subscriber.__fire(raced) });
      const { controller } = makeController(subscriber, commandClient);
      const res = makeRes();

      await controller.streamEvents('job-1', res as any, TEST_USER);

      expect(framesFor(res, raced, 'narration')).toHaveLength(1);
    });

    it('delivers a narration published during the replay read exactly once when it ALSO landed in the LRANGE snapshot', async () => {
      // The mirror-image bug a naive reorder introduces: the producer RPUSHes
      // and PUBLISHes the SAME string, so an event racing the read can be in
      // both places. Two identical activity-log lines is the double-narration
      // bug SWEEP.md's item names explicitly.
      const raced = JSON.stringify({ type: 'narration', phase: 'analyze_section', message: 'Analyzing section 7', emittedAt: '2026-08-31T09:00:01.000Z' });
      const subscriber = makeSubscriber();
      const commandClient = makeCommandClient({ narrationLog: [raced], onLrange: () => subscriber.__fire(raced) });
      const { controller } = makeController(subscriber, commandClient);
      const res = makeRes();

      await controller.streamEvents('job-1', res as any, TEST_USER);

      expect(framesFor(res, raced, 'narration')).toHaveLength(1);
    });

    it('delivers a narration published during the SUBSCRIBE round trip exactly once', async () => {
      // The other half of the window -- a message landing while subscribe()
      // itself is still in flight, before the reads even start.
      const raced = JSON.stringify({ type: 'narration', phase: 'parse_done', message: 'Finished parsing', emittedAt: '2026-08-31T09:00:01.000Z' });
      const subscriber = makeSubscriber((fire) => fire(raced));
      const { controller } = makeController(subscriber, makeCommandClient());
      const res = makeRes();

      await controller.streamEvents('job-1', res as any, TEST_USER);

      expect(framesFor(res, raced, 'narration')).toHaveLength(1);
    });

    it('keeps two genuinely distinct same-text narrations that differ only in emittedAt', async () => {
      // Dedup must not collapse a real repeat. `emittedAt` is the de-facto
      // nonce that keeps full-string identity honest here.
      const earlier = JSON.stringify({ type: 'narration', phase: 'describe_figure', message: 'Describing figure', emittedAt: '2026-08-31T09:00:00.000Z' });
      const later = JSON.stringify({ type: 'narration', phase: 'describe_figure', message: 'Describing figure', emittedAt: '2026-08-31T09:00:00.001Z' });
      const subscriber = makeSubscriber();
      const commandClient = makeCommandClient({ narrationLog: [earlier], onLrange: () => subscriber.__fire(later) });
      const { controller } = makeController(subscriber, commandClient);
      const res = makeRes();

      await controller.streamEvents('job-1', res as any, TEST_USER);

      expect(framesFor(res, earlier, 'narration')).toHaveLength(1);
      expect(framesFor(res, later, 'narration')).toHaveLength(1);
    });

    it('ends the stream when the event published during the replay read is a TERMINAL stage -- the stall this item is actually about', async () => {
      // Old behaviour: this diff_ready reached nobody, the client sat on
      // "running" indefinitely until the user reloaded the page.
      const terminal = JSON.stringify({ stage: 'diff_ready', emittedAt: '2026-08-31T09:00:01.000Z' });
      const subscriber = makeSubscriber();
      const commandClient = makeCommandClient({ onLrange: () => subscriber.__fire(terminal) });
      const { controller } = makeController(subscriber, commandClient);
      const res = makeRes();

      await controller.streamEvents('job-1', res as any, TEST_USER);

      expect(framesFor(res, terminal, 'stage')).toHaveLength(1);
      expect(res.end).toHaveBeenCalled();
      expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
      expect(subscriber.quit).toHaveBeenCalledTimes(1);
    });

    it('stops flushing after a buffered terminal stage, so nothing is written to an already-ended response', async () => {
      const terminal = JSON.stringify({ stage: 'failed', emittedAt: '2026-08-31T09:00:01.000Z' });
      const trailing = JSON.stringify({ type: 'narration', phase: 'job_failed', message: 'should not be written', emittedAt: '2026-08-31T09:00:02.000Z' });
      const subscriber = makeSubscriber();
      const commandClient = makeCommandClient({
        onLrange: () => {
          subscriber.__fire(terminal);
          subscriber.__fire(trailing);
        },
      });
      const { controller } = makeController(subscriber, commandClient);
      const res = makeRes();

      await controller.streamEvents('job-1', res as any, TEST_USER);

      expect(framesFor(res, terminal, 'stage')).toHaveLength(1);
      expect(framesFor(res, trailing, 'narration')).toHaveLength(0);
    });

    it('never quits or unsubscribes the SHARED command client on per-connection cleanup', async () => {
      // It serves every other open SSE stream in this process; quitting it
      // here would break replay for all of them.
      const subscriber = makeSubscriber();
      const commandClient = makeCommandClient();
      const { controller } = makeController(subscriber, commandClient);
      const res = makeRes();

      await controller.streamEvents('job-1', res as any, TEST_USER);
      res.__handlers.close();

      expect(subscriber.quit).toHaveBeenCalledTimes(1);
      expect(commandClient.quit).not.toHaveBeenCalled();
      expect(commandClient.unsubscribe).not.toHaveBeenCalled();
    });

    it('releases the subscribed connection when a replay read rejects', async () => {
      // The reads now run AFTER subscribe, so a rejection here would leak an
      // open, subscribed connection -- res.on('close') is not registered
      // until the flush completes.
      const subscriber = makeSubscriber();
      const commandClient = makeCommandClient();
      commandClient.lrange.mockRejectedValue(new Error('connection reset'));
      const { controller } = makeController(subscriber, commandClient);
      const res = makeRes();

      await expect(controller.streamEvents('job-1', res as any, TEST_USER)).rejects.toThrow('connection reset');

      expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
      expect(subscriber.quit).toHaveBeenCalledTimes(1);
    });

    it('delivers a normal, non-racing message exactly once -- no regression from the buffering path', async () => {
      // The buffer must be disarmed once the flush is done; a message
      // arriving normally afterwards goes straight through, once.
      const later = JSON.stringify({ type: 'narration', phase: 'analyze_section', message: 'Analyzing section 9', emittedAt: '2026-08-31T09:05:00.000Z' });
      const subscriber = makeSubscriber();
      const { controller } = makeController(subscriber, makeCommandClient());
      const res = makeRes();

      await controller.streamEvents('job-1', res as any, TEST_USER);
      subscriber.__fire(later);

      expect(framesFor(res, later, 'narration')).toHaveLength(1);
    });

    it('does not dedupe a post-flush message against the replay snapshot -- the seen-set is window-scoped', async () => {
      // A narration whose text and shape match a replayed one, published
      // long after the flush, is a real new event. A long-lived seen-set
      // would silently swallow it.
      const replayed = JSON.stringify({ type: 'narration', phase: 'describe_figure', message: 'Describing figure', emittedAt: '2026-08-31T09:00:00.000Z' });
      const subscriber = makeSubscriber();
      const { controller } = makeController(subscriber, makeCommandClient({ narrationLog: [replayed] }));
      const res = makeRes();

      await controller.streamEvents('job-1', res as any, TEST_USER);
      subscriber.__fire(replayed);

      expect(framesFor(res, replayed, 'narration')).toHaveLength(2);
    });

    it('ignores a malformed payload buffered during the replay window without crashing the stream', async () => {
      // Same fail-open convention the live path already follows.
      const subscriber = makeSubscriber();
      const commandClient = makeCommandClient({ onLrange: () => subscriber.__fire('not json at all') });
      const { controller } = makeController(subscriber, commandClient);
      const res = makeRes();

      await expect(controller.streamEvents('job-1', res as any, TEST_USER)).resolves.toBeUndefined();

      expect(res.write).not.toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();
    });
  });

  describe('getEventHistory', () => {
    it('returns the persisted event history ordered oldest-first', async () => {
      const rows = [{ id: 'e1', phase: 'parse_done', message: 'Finished parsing', createdAt: new Date('2026-08-04T11:32:00Z') }];
      const prisma = { jobEvent: { findMany: jest.fn().mockResolvedValue(rows) } };
      const { controller } = makeController(undefined, makeCommandClient(), prisma);

      const result = await controller.getEventHistory('job-1', TEST_USER);

      expect(prisma.jobEvent.findMany).toHaveBeenCalledWith({ where: { jobId: 'job-1' }, orderBy: { createdAt: 'asc' } });
      expect(result).toBe(rows);
    });

    it('404s for a job the user does not own -- same convention as streamEvents', async () => {
      const otherUserJobsService = { getById: jest.fn().mockResolvedValue({ userId: 'someone-else' }) };
      const controller = new JobEventsController(
        jest.fn() as any,
        makeCommandClient() as any,
        otherUserJobsService as any,
        fakePrisma as any,
      );

      await expect(controller.getEventHistory('job-1', TEST_USER)).rejects.toThrow('Job job-1 not found');
    });
  });
});
