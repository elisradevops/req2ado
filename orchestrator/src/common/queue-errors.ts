import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';

const logger = new Logger('Queue');

/**
 * BullMQ re-emits a Redis connection failure (for example "Connection is closed" when the app closes while a queue is still connecting) as an
 * 'error' event on the Queue, and an EventEmitter with no 'error' listener throws it as an unhandled error. Every Queue the app creates gets this
 * listener, so a Redis blip is logged instead of taking the process down. Only the queue name and the error type are logged: a message can carry
 * hosts or credentials.
 */
export function logQueueErrors<T extends Pick<Queue, 'on'>>(queue: T, name: string): T {
  queue.on('error', (error: Error) => {
    const code = (error as NodeJS.ErrnoException)?.code;
    logger.warn(`queue ${name} error: ${error?.name ?? typeof error}${code ? ` (${code})` : ''}`);
  });
  return queue;
}

const READY_WAIT_LIMIT_MS = 3000;

/**
 * Closes a BullMQ queue or worker after its connection has finished starting. BullMQ's RedisConnection.close() removes its own listeners, so a close
 * that lands while the connection is still starting makes the pending start fail with "Connection is closed" on an emitter nobody listens to: an
 * unhandled error. Waiting is bounded, and a failed start does not stop the close.
 */
export async function closeWhenReady(target: { waitUntilReady?: () => Promise<unknown>; close?: () => Promise<unknown> } | undefined, limitMs = READY_WAIT_LIMIT_MS): Promise<void> {
  if (!target) return;
  if (target.waitUntilReady) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, limitMs);
      timer.unref?.();
    });
    await Promise.race([target.waitUntilReady().then(() => undefined, () => undefined), limit]);
    if (timer) clearTimeout(timer);
  }
  await target.close?.();
}
