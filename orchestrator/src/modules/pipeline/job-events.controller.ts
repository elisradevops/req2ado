import { Controller, Get, Inject, NotFoundException, Param, Res } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { Response } from 'express';
import type Redis from 'ioredis';
import { JobsService } from './jobs.service';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';

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
  constructor(
    @Inject(REDIS_SUBSCRIBER_FACTORY) private readonly redisSubscriberFactory: () => Redis,
    private readonly jobsService: JobsService,
    private readonly prisma: PrismaClient,
  ) {}

  // Durable counterpart to the live SSE stream above: JobEventPersistenceService
  // writes every stage/narration event to JobEvent as it's published, so a
  // job's full processing trail survives past its own completion/failure and
  // past Redis's 1-hour narration-log TTL. A distinct path from `:id/events`
  // (the SSE route) rather than a query flag on it -- one is a long-lived
  // stream, the other a plain JSON fetch, different enough response
  // lifecycles to warrant separate routes.
  @Get(':id/event-history')
  async getEventHistory(@Param('id') id: string, @CurrentUser() user: SessionUser): Promise<unknown[]> {
    const job = await this.jobsService.getById(id);
    if (!job || job.userId !== user.userId) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    return this.prisma.jobEvent.findMany({ where: { jobId: id }, orderBy: { createdAt: 'asc' } });
  }

  @Get(':id/events')
  async streamEvents(
    @Param('id') id: string,
    @Res() res: Response,
    @CurrentUser() user: SessionUser,
  ): Promise<void> {
    // Ownership check BEFORE flushHeaders/opening a Redis connection (see
    // class doc comment on ordering) -- matches every other per-job route's
    // 404-not-403 convention, so a job id isn't enumerable by trying it and
    // reading the status code.
    const job = await this.jobsService.getById(id);
    if (!job || job.userId !== user.userId) {
      throw new NotFoundException(`Job ${id} not found`);
    }

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
    // Replays the WHOLE bounded history (LRANGE), not just the latest
    // entry -- previously a reconnecting client (page reload, dropped SSE
    // connection) only ever saw the single most recent narration event via
    // a SET-overwritten key, silently losing all prior activity-log history
    // client-side (JobDetail.tsx's own `narrations` state starts empty on
    // every mount) even though the job kept progressing server-side.
    const narrationLog = await subscriber.lrange(`job-events:${id}:narration-log`, 0, -1);
    for (const narration of narrationLog) {
      res.write(`event: narration\ndata: ${narration}\n\n`);
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

    const terminalStages = new Set(['diff_ready', 'failed', 'cancelled']);
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
