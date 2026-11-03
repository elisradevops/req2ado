import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';
import { closeWhenReady, logQueueErrors } from '../src/common/queue-errors';
import { JobsService } from '../src/modules/pipeline/jobs.service';

// BullMQ re-emits a connection failure (for example "Connection is closed" when the app closes while a queue is still connecting) as an 'error'
// event on the Queue. An EventEmitter with no 'error' listener throws that as an unhandled error, which in production would take the process down on a
// Redis blip and in the e2e specs failed whichever suite was closing (test/health.e2e-spec.ts, about half of the full runs).
describe('logQueueErrors', () => {
  it('returns the same queue and gives it an error listener', () => {
    const queue = new EventEmitter();
    expect(logQueueErrors(queue as any, 'x')).toBe(queue);
    expect(queue.listenerCount('error')).toBeGreaterThan(0);
  });

  it('turns an error event into a log line instead of an unhandled error', () => {
    const queue = new EventEmitter();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logQueueErrors(queue as any, 'pipeline');

    expect(() => queue.emit('error', new Error('Connection is closed'))).not.toThrow();

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('logs the queue name and the error type, never the message (it can carry hosts or credentials)', () => {
    const queue = new EventEmitter();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logQueueErrors(queue as any, 'pipeline');
    const error = Object.assign(new TypeError('connect ECONNREFUSED redis://user:secret@host:6379'), { code: 'ECONNREFUSED' });

    queue.emit('error', error);

    const line = String(warn.mock.calls[0][0]);
    expect(line).toBe('queue pipeline error: TypeError (ECONNREFUSED)');
    expect(line).not.toContain('secret');
    warn.mockRestore();
  });
});

describe('JobsService pipeline queue', () => {
  it('has an error listener, so a Redis failure cannot become an unhandled error', async () => {
    const service = new JobsService({} as any, {} as any, {} as any, {} as any, 'redis://127.0.0.1:1');
    const queue = (service as any).queue;
    expect(queue.listenerCount('error')).toBeGreaterThan(0);
    await queue.close().catch(() => undefined);
  });
});

// BullMQ's RedisConnection.close() removes its own listeners. Closing a queue or worker while its connection is still starting up (the e2e specs
// call app.close() right after boot) makes that pending start fail with "Connection is closed" on an emitter nobody listens to: an unhandled error
// that failed whichever e2e suite was closing (traced to a bare RedisConnection, redis-connection.js:87).
describe('closeWhenReady', () => {
  it('lets the connection finish starting before it closes', async () => {
    const order: string[] = [];
    const target = {
      waitUntilReady: jest.fn(async () => { order.push('ready'); }),
      close: jest.fn(async () => { order.push('close'); }),
    };
    await closeWhenReady(target);
    expect(order).toEqual(['ready', 'close']);
  });

  it('still closes when the connection never became ready (it failed)', async () => {
    const target = { waitUntilReady: jest.fn().mockRejectedValue(new Error('Connection is closed')), close: jest.fn().mockResolvedValue(undefined) };
    await closeWhenReady(target);
    expect(target.close).toHaveBeenCalledTimes(1);
  });

  it('still closes when it would wait forever, after the time limit', async () => {
    const target = { waitUntilReady: jest.fn(() => new Promise<void>(() => {})), close: jest.fn().mockResolvedValue(undefined) };
    await closeWhenReady(target, 20);
    expect(target.close).toHaveBeenCalledTimes(1);
  });

  it('closes an object that has no waitUntilReady (a test double)', async () => {
    const target = { close: jest.fn().mockResolvedValue(undefined) };
    await closeWhenReady(target);
    expect(target.close).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an absent target', async () => {
    await expect(closeWhenReady(undefined)).resolves.toBeUndefined();
  });
});
