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

    // Replay the last-known stage immediately, before subscribing -- a
    // client that (re)opens this stream mid-run (e.g. navigated away and
    // back) would otherwise see nothing until the NEXT stage event fires,
    // which can be minutes away during a real LLM call. Read BEFORE
    // subscribe(): once subscribed, this connection can't issue any other
    // command (see class doc comment).
    const current = await subscriber.get(`job-events:${id}:current`);
    if (current) {
      res.write(`event: stage\ndata: ${current}\n\n`);
    }
    // Same replay-on-reconnect pattern as the stage's :current key above,
    // for ingestion's narration events (see NarrationPublisher, Python
    // side) -- published to the SAME channel this controller subscribes to
    // below, distinguished only by `type: 'narration'` on the message.
    const currentNarration = await subscriber.get(`job-events:${id}:narration`);
    if (currentNarration) {
      res.write(`event: narration\ndata: ${currentNarration}\n\n`);
    }

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
      const payload = JSON.parse(message) as { type?: string; stage?: string };
      // Convention: ingestion only ever publishes `type: 'narration'` on
      // this channel; orchestrator's own JobEventsPublisher owns every
      // `stage` transition (no `type` field). Narration never ends the
      // stream -- only a terminal stage does.
      if (payload.type === 'narration') {
        res.write(`event: narration\ndata: ${message}\n\n`);
        return;
      }
      res.write(`event: stage\ndata: ${message}\n\n`);
      if (payload.stage && terminalStages.has(payload.stage)) {
        cleanup();
        res.end();
      }
    });

    res.on('close', () => {
      cleanup();
    });
  }
}
