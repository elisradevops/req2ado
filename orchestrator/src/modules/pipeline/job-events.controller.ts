import { Controller, Get, Inject, NotFoundException, Optional, Param, Res, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { Response } from 'express';
import type Redis from 'ioredis';
import { JobsService } from './jobs.service';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { mergeReplayBuffer, pushBoundedReplayBuffer } from './sse-replay-merge';
import { progressChannel, progressLatestKey } from './progress.service';
import { liveChannel, liveDoneKey, liveLatestKey } from './live-channels';

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

// Job transparency (docs/job-transparency-implementation-plan.md, B6). True
// only when LIVE_PROGRESS is on; absent (tests, older wiring) means false, so
// every behavior below is exactly what it was before the feature existed.
export const LIVE_PROGRESS_ENABLED = 'LIVE_PROGRESS_ENABLED';

// SSE comment lines keep proxies and load balancers from timing out an idle
// stream (a long model call can be silent for minutes).
const KEEPALIVE_INTERVAL_MS = 15_000;

function emittedAtMs(raw: string): number | undefined {
  try {
    const at = Date.parse((JSON.parse(raw) as { emittedAt?: string }).emittedAt ?? '');
    return Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

export const runMapKey = (jobId: string): string => `job-events:${jobId}:map`;

// SSE relay: subscribes to the job-scoped Redis pub/sub channel that
// JobEventsPublisher (running in the separate pipeline-worker process)
// publishes to, and forwards each stage event to the HTTP client as an
// `event: stage` frame. A subscribed ioredis connection can't issue any
// other command, so each SSE connection gets its own dedicated client via
// the injected factory rather than sharing the module's other Redis/BullMQ
// connections.
@Controller('jobs')
export class JobEventsController implements OnModuleDestroy {
  constructor(
    @Inject(REDIS_SUBSCRIBER_FACTORY) private readonly redisSubscriberFactory: () => Redis,
    @Inject(REDIS_COMMAND_CLIENT) private readonly redisCommandClient: Redis,
    private readonly jobsService: JobsService,
    private readonly prisma: PrismaClient,
    @Optional() @Inject(LIVE_PROGRESS_ENABLED) private readonly liveProgress: boolean = false,
  ) {}

  // redisCommandClient (REDIS_COMMAND_CLIENT above) is a raw ioredis
  // instance with no lifecycle hooks of its own -- confirmed real, the same
  // gap found in JobEventPersistenceService/ChatService/JobEventsPublisher:
  // never disconnected, stayed open past every e2e-spec.ts's app.close().
  // Per-connection subscribers (redisSubscriberFactory) are NOT touched
  // here -- each is already torn down on its own request/response
  // lifecycle inside streamEvents (see that method's own cleanup), and this
  // shared command client must never be closed from there (see
  // REDIS_COMMAND_CLIENT's own doc comment above).
  onModuleDestroy(): void {
    this.redisCommandClient.disconnect();
  }

  // Durable counterpart to the live SSE stream above: JobEventPersistenceService
  // writes every stage/narration event to JobEvent as it's published, so a
  // job's full processing trail survives past its own completion/failure and
  // past Redis's 1-hour narration-log TTL. A distinct path from `:id/events`
  // (the SSE route) rather than a query flag on it -- one is a long-lived
  // stream, the other a plain JSON fetch, different enough response
  // lifecycles to warrant separate routes.
  // Job transparency (B6): the static "what is in your document" description
  // ingestion writes before the first model call. Owner-scoped like every
  // other job route (404 for anyone else), and 404 when the feature is off or
  // no map exists yet. Named run-map to stay distinct from the wizard's
  // step-1 document map (document-map.ts).
  @Get(':id/run-map')
  async getRunMap(@Param('id') id: string, @CurrentUser() user: SessionUser): Promise<unknown> {
    const job = await this.jobsService.getById(id);
    if (!job || job.userId !== user.userId) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    if (!this.liveProgress) throw new NotFoundException('No document map for this job');
    const raw = await this.redisCommandClient.get(runMapKey(id));
    if (!raw) throw new NotFoundException('No document map for this job');
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new NotFoundException('No document map for this job');
    }
  }

  // Job transparency: the refs of items the run has finished. The event stream
  // replays only the latest frame per lane, so a page opened mid-run reads this
  // once to learn which outline items are already done. Same access rules as
  // run-map.
  @Get(':id/run-done')
  async getRunDone(@Param('id') id: string, @CurrentUser() user: SessionUser): Promise<{ refs: string[] }> {
    const job = await this.jobsService.getById(id);
    if (!job || job.userId !== user.userId) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    if (!this.liveProgress) throw new NotFoundException('No live progress for this job');
    const done = (await this.redisCommandClient.hgetall(liveDoneKey(id))) ?? {};
    return { refs: Object.keys(done) };
  }

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
    // Other proxies in front of the orchestrator (an ingress, for example) may
    // buffer by default; nginx for /api/ in this repo already does not.
    if (this.liveProgress) res.setHeader('X-Accel-Buffering', 'no');
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
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (keepalive) clearInterval(keepalive);
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
      // Job transparency (B12): a typed notice about a condition that changed the
      // run. Same channel as stage/narration, so it is stored with them.
      if (payload.type === 'notice') {
        res.write(`event: notice\ndata: ${raw}\n\n`);
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
    // Job transparency (B6, B8): progress and live frames come from their own
    // channels. They are small and rate-limited at the source, but a slow client
    // still gets them dropped rather than queued without limit (the next frame
    // supersedes the last).
    const sideBuffer: Array<{ event: 'progress' | 'live'; raw: string }> = [];
    // B11: what the heartbeat reports. `lastActivityMs` is the newest time
    // anything was published for this job (judged by the frames' own timestamps
    // where they have one); `inFlight` is the latest "working on / writing / page"
    // frame of each lane that has not finished or been reset.
    const connectedMs = Date.now();
    let lastActivityMs = 0;
    const inFlight = new Map<number, { lane: number; kind: string; ref?: string | null; title?: string | null }>();
    const noteActivity = (raw: string, atMs?: number): void => {
      lastActivityMs = Math.max(lastActivityMs, atMs ?? Date.now());
      try {
        const frame = JSON.parse(raw) as { type?: string; lane?: number; kind?: string; ref?: string | null; title?: string | null };
        if (frame.type !== 'live' || typeof frame.lane !== 'number') return;
        if (frame.kind === 'working_on' || frame.kind === 'writing' || frame.kind === 'ocr_page') {
          inFlight.set(frame.lane, { lane: frame.lane, kind: frame.kind, ref: frame.ref ?? null, title: frame.title ?? null });
        } else if (frame.kind === 'item' || frame.kind === 'reset') {
          inFlight.delete(frame.lane);
        }
      } catch {
        // Not a frame we understand; it still counted as activity.
      }
    };
    // A slow client drops what the next frame supersedes (progress, "working on"
    // and "writing" frames, page frames). It never drops what cannot be recreated
    // from a later frame: a finished item, a comparison, or a lane reset. A burst
    // of finished items is bounded (see live_emitter MAX_QUEUED_FRAMES).
    const isSupersededByNext = (event: 'progress' | 'live', raw: string): boolean => {
      if (event === 'progress') return true;
      try {
        const kind = (JSON.parse(raw) as { kind?: string }).kind;
        return kind === 'working_on' || kind === 'writing' || kind === 'ocr_page';
      } catch {
        return true;
      }
    };
    const writeSide = (event: 'progress' | 'live', raw: string): void => {
      if (streamEnded) return;
      if ((res as unknown as { writableNeedDrain?: boolean }).writableNeedDrain && isSupersededByNext(event, raw)) return;
      res.write(`event: ${event}\ndata: ${raw}\n\n`);
    };
    const sideEventFor = (channel: string): 'progress' | 'live' | null => {
      if (!this.liveProgress) return null;
      if (channel === progressChannel(id)) return 'progress';
      if (channel === liveChannel(id)) return 'live';
      return null;
    };
    subscriber.on('message', (channel: string, message: string) => {
      const sideEvent = sideEventFor(channel);
      if (this.liveProgress) noteActivity(message);
      if (sideEvent) {
        if (replaying) sideBuffer.push({ event: sideEvent, raw: message });
        else writeSide(sideEvent, message);
        return;
      }
      if (replaying) {
        pushBoundedReplayBuffer(buffer, message);
        return;
      }
      dispatch(message);
    });

    try {
      if (this.liveProgress) {
        await subscriber.subscribe(`job-events:${id}`, progressChannel(id), liveChannel(id));
      } else {
        await subscriber.subscribe(`job-events:${id}`);
      }
    } catch (err) {
      // subscribe() rejected before res.on('close') was registered — the
      // just-created connection would otherwise leak, never .quit()'d. The
      // message handler above is already attached (registered before
      // subscribe() is called), so mark cleanedUp before quitting to stop
      // any message that still lands on it from reaching dispatch()/
      // res.write() on a request whose subscribe attempt already failed.
      cleanedUp = true;
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
      // Replay writes go straight to res.write, NOT through dispatch() --
      // preserving this route's pre-existing behavior of never ending the
      // stream off a replayed stage, only a LIVE one. (A reconnect to an
      // already-terminal job leaves the stream open rather than closing it
      // immediately; that is unchanged by this fix and out of this item's
      // scope, which is the race window during subscribe, not replay-of-a-
      // finished-job semantics.) `replayed` still collects every raw string
      // written here, since the live buffer below must be deduped against
      // it regardless of how it was written.
      const replayed: string[] = [];
      if (current) {
        replayed.push(current);
        res.write(`event: stage\ndata: ${current}\n\n`);
      }
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
      for (const narration of narrationLog) {
        replayed.push(narration);
        res.write(`event: narration\ndata: ${narration}\n\n`);
      }

      // Typed notices (B12): the capped replay list, so a stream that connects
      // late or reconnects still shows what already happened.
      if (this.liveProgress) {
        const notices = await this.redisCommandClient.lrange(`job-events:${id}:notices`, 0, -1);
        for (const notice of notices ?? []) {
          replayed.push(notice);
          res.write(`event: notice\ndata: ${notice}\n\n`);
        }
      }

      // Deliver whatever arrived on the live channel while the two reads
      // above were in flight, minus whatever of it already appeared in the
      // snapshot just replayed (see sse-replay-merge.ts for why full-string
      // identity is the right dedup key here). Fully synchronous: no
      // `await` in this loop, or a further live message could interleave
      // between these buffered ones and break delivery order.
      const replayedSide = new Set<string>();
      if (this.liveProgress) {
        const latestProgress = await this.redisCommandClient.get(progressLatestKey(id));
        if (latestProgress) {
          replayedSide.add(latestProgress);
          writeSide('progress', latestProgress);
          noteActivity(latestProgress, emittedAtMs(latestProgress));
        }
        // The latest live frame of each lane, oldest first.
        const latestLive = Object.values((await this.redisCommandClient.hgetall(liveLatestKey(id))) ?? {});
        const seqOf = (raw: string): number => {
          try {
            return Number((JSON.parse(raw) as { seq?: number }).seq ?? 0);
          } catch {
            return 0;
          }
        };
        latestLive.sort((a, b) => seqOf(a) - seqOf(b));
        for (const raw of latestLive) {
          replayedSide.add(raw);
          writeSide('live', raw);
          noteActivity(raw, emittedAtMs(raw));
        }
      }

      // Nothing published yet (or no live progress): idle counts from connecting.
      if (lastActivityMs === 0) lastActivityMs = connectedMs;
      const toFlush = mergeReplayBuffer(replayed, buffer);
      replaying = false;
      for (const { event, raw } of sideBuffer) {
        if (!replayedSide.has(raw)) writeSide(event, raw);
      }
      sideBuffer.length = 0;
      for (const raw of toFlush) {
        if (streamEnded) break;
        dispatch(raw);
      }
      // One-time flush only -- nothing after this point ever reads `buffer`
      // again (the message handler's `replaying` check now always takes the
      // dispatch() branch), so drop the reference rather than holding it for
      // the SSE connection's remaining lifetime.
      buffer.length = 0;
    } catch (err) {
      // The reads now run AFTER subscribe -- a rejection here would leak an
      // open, subscribed connection, since res.on('close') is not
      // registered until after this block. Same shape as the subscribe()
      // rejection handler above.
      cleanup();
      throw err;
    }

    if (this.liveProgress && !cleanedUp) {
      keepalive = setInterval(() => {
        if (streamEnded) return;
        res.write(': keepalive\n\n');
        const heartbeat = {
          type: 'heartbeat',
          at: new Date().toISOString(),
          idleSeconds: Math.max(0, Math.round((Date.now() - lastActivityMs) / 1000)),
          inFlight: [...inFlight.values()].sort((a, b) => a.lane - b.lane).slice(0, 64),
        };
        res.write(`event: heartbeat\ndata: ${JSON.stringify(heartbeat)}\n\n`);
      }, KEEPALIVE_INTERVAL_MS);
      keepalive.unref?.();
    }

    res.on('close', () => {
      cleanup();
    });
  }
}
