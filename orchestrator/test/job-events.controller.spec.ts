import { JobEventsController } from '../src/modules/pipeline/job-events.controller';

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
    const controller = new JobEventsController(factory as any);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any);

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
    const controller = new JobEventsController(factory as any);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any);
    subscriber.__handlers.message('job-events:job-1', JSON.stringify({ stage: 'parse' }));

    expect(res.write).toHaveBeenCalledWith('event: stage\ndata: {"stage":"parse"}\n\n');
    expect(res.end).not.toHaveBeenCalled();
    expect(subscriber.quit).not.toHaveBeenCalled();
  });

  it('closes the stream and releases the subscriber on a terminal stage', async () => {
    const subscriber = makeSubscriber();
    const factory = jest.fn().mockReturnValue(subscriber);
    const controller = new JobEventsController(factory as any);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any);
    subscriber.__handlers.message('job-events:job-1', JSON.stringify({ stage: 'diff_ready' }));

    expect(res.end).toHaveBeenCalled();
    expect(subscriber.unsubscribe).toHaveBeenCalled();
    expect(subscriber.quit).toHaveBeenCalled();
  });

  it('releases the subscriber when the client closes the connection', async () => {
    const subscriber = makeSubscriber();
    const factory = jest.fn().mockReturnValue(subscriber);
    const controller = new JobEventsController(factory as any);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any);
    res.__handlers.close();

    expect(subscriber.unsubscribe).toHaveBeenCalled();
    expect(subscriber.quit).toHaveBeenCalled();
  });

  it('registers an error listener on the subscriber to avoid unhandled EventEmitter throws', async () => {
    const subscriber = makeSubscriber();
    const factory = jest.fn().mockReturnValue(subscriber);
    const controller = new JobEventsController(factory as any);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any);

    expect(subscriber.__handlers.error).toBeInstanceOf(Function);
    // Should not throw when invoked.
    expect(() => subscriber.__handlers.error(new Error('boom'))).not.toThrow();
  });

  it('runs cleanup exactly once even when the terminal-stage message and the close event both fire', async () => {
    const subscriber = makeSubscriber();
    const factory = jest.fn().mockReturnValue(subscriber);
    const controller = new JobEventsController(factory as any);
    const res = makeRes();

    await controller.streamEvents('job-1', res as any);
    // Terminal-stage branch fires cleanup + res.end(), which in a real
    // response triggers res.on('close') asynchronously afterwards — both
    // paths race to clean up the same subscriber connection.
    subscriber.__handlers.message('job-events:job-1', JSON.stringify({ stage: 'diff_ready' }));
    res.__handlers.close();

    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscriber.quit).toHaveBeenCalledTimes(1);
  });

  it('quits the leaked subscriber connection when subscribe() rejects', async () => {
    const subscriber = makeSubscriber();
    subscriber.subscribe.mockRejectedValue(new Error('connection refused'));
    const factory = jest.fn().mockReturnValue(subscriber);
    const controller = new JobEventsController(factory as any);
    const res = makeRes();

    await expect(controller.streamEvents('job-1', res as any)).rejects.toThrow('connection refused');

    expect(subscriber.quit).toHaveBeenCalledTimes(1);
    // res.on('close') should never have been registered — streamEvents
    // threw before reaching that point.
    expect(res.__handlers.close).toBeUndefined();
  });
});
