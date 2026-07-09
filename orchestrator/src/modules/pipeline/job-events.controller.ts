import { Controller, Get, Inject, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import type Redis from 'ioredis';

export const REDIS_SUBSCRIBER_FACTORY = 'REDIS_SUBSCRIBER_FACTORY';

// SSE relay: subscribes to the job-scoped Redis pub/sub channel that
// JobEventsPublisher (running in the separate pipeline-worker process)
// publishes to, and forwards each stage event to the HTTP client as an
// `event: stage` frame. A subscribed ioredis connection can't issue any
// other command, so each SSE connection gets its own dedicated client via
// the injected factory rather than sharing the module's other Redis/BullMQ
// connections.
@Controller('jobs')
export class JobEventsController {
  constructor(@Inject(REDIS_SUBSCRIBER_FACTORY) private readonly redisSubscriberFactory: () => Redis) {}

  @Get(':id/events')
  async streamEvents(@Param('id') id: string, @Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const subscriber = this.redisSubscriberFactory();
    // ioredis clients are plain EventEmitters — an 'error' event with zero
    // listeners throws synchronously and crashes the whole process. Attach
    // a no-op/log-only handler immediately after construction.
    subscriber.on('error', (err: Error) => {
      // eslint-disable-next-line no-console -- no structured logger in this module yet
      console.error(`Redis subscriber error for job ${id}:`, err);
    });

    try {
      await subscriber.subscribe(`job-events:${id}`);
    } catch (err) {
      // subscribe() rejected before res.on('close') was registered — the
      // just-created connection would otherwise leak, never .quit()'d.
      await subscriber.quit().catch(() => undefined);
      throw err;
    }

    // Both the terminal-stage branch below and res.on('close') can race to
    // clean up the same subscriber connection (res.end() triggers 'close'
    // after the response finishes). Guard so unsubscribe()/quit() each run
    // exactly once — a second .quit() on an already-closing ioredis client
    // can reject with an unhandled rejection and crash the process.
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      void subscriber.unsubscribe().catch(() => undefined);
      void subscriber.quit().catch(() => undefined);
    };

    const terminalStages = new Set(['diff_ready', 'failed']);
    subscriber.on('message', (_channel: string, message: string) => {
      const payload = JSON.parse(message) as { stage: string };
      res.write(`event: stage\ndata: ${JSON.stringify(payload)}\n\n`);
      if (terminalStages.has(payload.stage)) {
        cleanup();
        res.end();
      }
    });

    res.on('close', () => {
      cleanup();
    });
  }
}
