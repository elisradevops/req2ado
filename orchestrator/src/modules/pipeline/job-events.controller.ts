import { Controller, Get, Inject, NotFoundException, Param, Res } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { Response } from 'express';
import type Redis from 'ioredis';
import { JobsService } from './jobs.service';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { mergeReplayBuffer, pushBoundedReplayBuffer } from './sse-replay-merge';

export const REDIS_SUBSCRIBER_FACTORY = 'REDIS_SUBSCRIBER_FACTORY';
// A single shared, never-subscribed connection for the replay reads. The
// per-connection subscriber above is now .subscribe()'d BEFORE the replay
// runs (see streamEvents for why), and an ioredis client in subscriber mode
// can't issue GET/LRANGE -- so the replay has to come off a different
// connection. Exactly the two-connection split JobEventPersistenceService
// already uses (`subscriber` + `commandClient`). Shared rather than
// per-request because it only ever issues one GET plus one LRANGE per SSE
// open, which ioredis pipelines fine over one connection across many
// concurrent callers -- and it must NEVER be `.quit()`'d or `.unsubscribe()`'d
// by a per-connection cleanup(), since doing so would kill replay for every
// other SSE client in the process.
export const REDIS_COMMAND_CLIENT = 'REDIS_COMMAND_CLIENT';

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
    @Inject(REDIS_COMMAND_CLIENT) private readonly redisCommandClient: Redis,
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
    let streamEnded = false;
    // Writes one already-serialized message onto the SSE stream, ending it
    // (and cleaning up) if it's a terminal stage. Shared by both the live
    // post-replay dispatch path below and the buffered-during-replay flush
    // in the try block further down, so the two can never diverge on what
    // counts as "ends the stream".
    const dispatch = (raw: string): void => {
      if (streamEnded) return;
      let payload: { type?: string; stage?: string };
      try {
        payload = JSON.parse(raw) as { type?: string; stage?: string };
      } catch {
        // Malformed payload must never crash this long-lived subscriber --
        // same fail-open convention JobEventPersistenceService.parsePayload
        // already follows for the identical shared channel.
        return;
      }
      // Convention: ingestion only ever publishes `type: 'narration'` on
      // this channel; orchestrator's own JobEventsPublisher owns every
      // `stage` transition (no `type` field). Narration never ends the
      // stream -- only a terminal stage does.
      if (payload.type === 'narration') {
        res.write(`event: narration\ndata: ${raw}\n\n`);
        return;
      }
      res.write(`event: stage\ndata: ${raw}\n\n`);
      if (payload.stage && terminalStages.has(payload.stage)) {
        streamEnded = true;
        cleanup();
        res.end();
      }
    };

    // SWEEP.md section 8a: subscribe() must run BEFORE the replay reads, not
    // after. The previous ordering read replay data first because a
    // .subscribe()'d ioredis connection can never issue GET/LRANGE again --
    // but that left a window between the reads and the subscribe call where
    // a published event reached nobody, and if it was a terminal stage the
    // client stalled on "running" until reload. The message handler is
    // attached BEFORE subscribe() so a message racing the subscribe round
    // trip itself is buffered, not dropped. While `replaying` is true, live
    // messages are buffered instead of dispatched -- flushed, deduped
    // against the replay snapshot (see sse-replay-merge.ts), once the reads
    // below complete.
    let replaying = true;
    const buffer: string[] = [];
    subscriber.on('message', (_channel: string, message: string) => {
      if (replaying) {
        pushBoundedReplayBuffer(buffer, message);
        return;
      }
      dispatch(message);
    });

    try {
      await subscriber.subscribe(`job-events:${id}`);
    } catch (err) {
      // subscribe() rejected before res.on('close') was registered — the
      // just-created connection would otherwise leak, never .quit()'d.
      await subscriber.quit().catch(() => undefined);
      throw err;
    }

    try {
      // Replay the last-known stage immediately -- a client that (re)opens
      // this stream mid-run (e.g. navigated away and back) would otherwise
      // see nothing until the NEXT stage event fires, which can be minutes
      // away during a real LLM call. Runs on the SHARED command client, not
      // the just-subscribed connection above -- once subscribed, that
      // connection can't issue any other command.
      const current = await this.redisCommandClient.get(`job-events:${id}:current`);
      const replayed: string[] = [];
      if (current) replayed.push(current);
      // Same replay-on-reconnect pattern as the stage's :current key above,
      // for ingestion's narration events (see NarrationPublisher, Python
      // side) -- published to the SAME channel this controller subscribes to,
      // distinguished only by `type: 'narration'` on the message. Replays the
      // WHOLE bounded history (LRANGE), not just the latest entry --
      // previously a reconnecting client (page reload, dropped SSE
      // connection) only ever saw the single most recent narration event via
      // a SET-overwritten key, silently losing all prior activity-log
      // history client-side even though the job kept progressing
      // server-side.
      const narrationLog = await this.redisCommandClient.lrange(`job-events:${id}:narration-log`, 0, -1);
      replayed.push(...narrationLog);

      for (const raw of replayed) dispatch(raw);

      // Deliver whatever arrived on the live channel while the two reads
      // above were in flight, minus whatever of it already appeared in the
      // snapshot just replayed (see sse-replay-merge.ts for why full-string
      // identity is the right dedup key here). Fully synchronous: no
      // `await` in this loop, or a further live message could interleave
      // between these buffered ones and break delivery order.
      const toFlush = mergeReplayBuffer(replayed, buffer);
      replaying = false;
      for (const raw of toFlush) {
        if (streamEnded) break;
        dispatch(raw);
      }
    } catch (err) {
      // The reads now run AFTER subscribe -- a rejection here would leak an
      // open, subscribed connection, since res.on('close') is not
      // registered until after this block. Same shape as the subscribe()
      // rejection handler above.
      cleanup();
      throw err;
    }

    res.on('close', () => {
      cleanup();
    });
  }
}
