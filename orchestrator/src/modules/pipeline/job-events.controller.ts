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
    await subscriber.subscribe(`job-events:${id}`);

    const terminalStages = new Set(['diff_ready', 'failed']);
    subscriber.on('message', (_channel: string, message: string) => {
      const payload = JSON.parse(message) as { stage: string };
      res.write(`event: stage\ndata: ${JSON.stringify(payload)}\n\n`);
      if (terminalStages.has(payload.stage)) {
        void subscriber.unsubscribe();
        void subscriber.quit();
        res.end();
      }
    });

    res.on('close', () => {
      void subscriber.unsubscribe();
      void subscriber.quit();
    });
  }
}
