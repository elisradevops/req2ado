import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';

interface ParsedEvent {
  phase: string;
  message: string;
  detail: object;
  severity: 'info' | 'error';
  createdAt: Date;
}

// Durable counterpart to the transient Redis narration-log (capped at 50
// entries, 1-hour TTL -- see JobEventsPublisher/NarrationPublisher's own doc
// comments). A single long-lived background subscriber, decoupled from
// JobEventsController's per-SSE-connection subscribers: this one exists for
// the lifetime of the process, psubscribe('job-events:*') matches every
// per-job channel (`job-events:{jobId}`, never the plain `:current`/
// `:narration-log` keys, which aren't pub/sub channels), and every message
// -- both orchestrator's own stage transitions and ingestion's narration
// events -- gets written to Postgres as it arrives. This is what lets a
// job's full processing trail be inspected after the job finishes (or after
// Redis's TTL expires), via GET /jobs/:id/event-history.
//
// Confirmed real gap this hardens against (live-caught): pub/sub delivery
// only reaches a subscriber connected AT THE MOMENT of publish -- if THIS
// service's own connection happens to be down (e.g. the orchestrator
// container was mid-restart for an unrelated deploy) exactly when an event
// publishes, that event is durably lost forever, even though the SAME
// payload also landed in Redis's own bounded narration-log LIST (written
// directly by the publisher, independent of whether anyone was subscribed)
// and the `:current` stage key. On startup, backfillMissedEvents() reads
// every job's narration-log LIST and `:current` key directly (via a
// SEPARATE plain connection -- a psubscribe'd connection can't issue any
// other command, same constraint REDIS_SUBSCRIBER_FACTORY already
// documents) and persists whatever isn't already in Postgres, closing the
// exact window this service's own downtime would otherwise blind it to.
//
// Bootstrapped exactly once: JobsModule is only ever loaded by the
// orchestrator HTTP process (pipeline-worker.main.ts is a standalone script,
// not a Nest application) -- a second instance of this subscriber would
// double-write every event.
@Injectable()
export class JobEventPersistenceService implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly subscriber: Redis,
    // A plain, never-subscribed connection -- `subscriber` above is
    // psubscribe'd for the lifetime of the process and can never issue
    // KEYS/LRANGE/GET again once that happens.
    private readonly commandClient: Redis,
    private readonly prisma: PrismaClient,
  ) {}

  // Guards the backfillMissedEvents() catch handler below against logging a
  // late rejection that only happened BECAUSE onModuleDestroy() already
  // disconnected the clients out from under an in-flight sweep -- confirmed
  // real (not hypothetical) in CI: a test that boots this service and tears
  // it down quickly leaves backfillMissedEvents() still mid-flight, and its
  // Redis/Postgres call then fails against an already-disconnected client,
  // logging "backfill sweep failed: Connection is closed" AFTER Jest
  // considers that test file finished ("Cannot log after tests are done"),
  // which flips jest's own exit code even though every assertion passed.
  private destroyed = false;

  onModuleInit(): void {
    // ioredis clients are plain EventEmitters -- an 'error' event with zero
    // listeners throws synchronously and crashes the process (same
    // convention as every other Redis client in this module).
    this.subscriber.on('error', (err: Error) => {
      // eslint-disable-next-line no-console -- no structured logger in this module yet
      console.error('JobEventPersistenceService Redis error:', err);
    });
    this.commandClient.on('error', (err: Error) => {
      // eslint-disable-next-line no-console -- no structured logger in this module yet
      console.error('JobEventPersistenceService command-client Redis error:', err);
    });
    this.subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
      void this.persist(channel, message);
    });
    void this.subscriber.psubscribe('job-events:*').catch((err) => {
      // eslint-disable-next-line no-console -- no structured logger in this module yet
      console.error('JobEventPersistenceService failed to psubscribe:', err);
    });
    // Runs once at startup, after the live subscription is already armed --
    // ordering doesn't matter for correctness (backfill dedupes against
    // whatever's already in Postgres regardless of what arrives live in the
    // meantime), only that neither path is skipped.
    void this.backfillMissedEvents().catch((err) => {
      // Skip logging when the module has already been torn down -- see the
      // `destroyed` field's own doc comment for the real CI failure this
      // guards against; a rejection caused by our OWN intentional
      // disconnect() is not a real error worth reporting.
      if (this.destroyed) return;
      // eslint-disable-next-line no-console -- no structured logger in this module yet
      console.error('JobEventPersistenceService backfill sweep failed:', err);
    });
  }

  // Neither client was ever closed -- a real, confirmed leak: both stayed
  // open past app.close() in every e2e-spec.ts that boots the full
  // AppModule, accumulating (2 connections x however many such spec files
  // run in the same process) with nothing to reclaim them once Jest's
  // worker-level force-exit safety net is bypassed by --runInBand (a single
  // worker, no per-worker process boundary) -- confirmed live as the root
  // cause of "Run pnpm test" hanging in CI, where maxWorkers legitimately
  // computes to 1 on a real 2-core runner. disconnect() (not quit()),
  // matching HealthController's own precedent: subscriber is psubscribe'd
  // and can't accept the QUIT command's own round trip; disconnect() closes
  // the raw socket immediately for both regardless of that.
  onModuleDestroy(): void {
    this.destroyed = true;
    this.subscriber.disconnect();
    this.commandClient.disconnect();
  }

  private parsePayload(message: string): ParsedEvent | null {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(message) as Record<string, unknown>;
    } catch {
      // Malformed payload must never crash this long-lived subscriber --
      // same fail-open convention every narration producer already follows.
      return null;
    }
    // Distinguishes a plain stage transition (orchestrator's own
    // JobEventsPublisher.publish, no `type` field, `{stage}` shape) from a
    // richer narration event (`type: 'narration'`, `{phase, message, ...}`)
    // -- same convention JobEventsController.streamEvents already relies on
    // to tell the two apart on this shared channel.
    const isNarration = payload.type === 'narration';
    // Typed notice (B12): stored as phase `notice` with the kind as its message,
    // the whole payload in `detail`, so the run summary can be built from history.
    const isNotice = payload.type === 'notice' && typeof payload.kind === 'string';
    const phase = (isNotice ? 'notice' : isNarration ? payload.phase : payload.stage) as string | undefined;
    if (!phase) return null;
    const message_ =
      (isNotice ? (payload.kind as string) : isNarration ? (payload.message as string | undefined) : undefined) ?? phase;
    // Real gap this closes: backfillMissedEvents() runs long after an event
    // actually happened, and Prisma's `createdAt @default(now())` would
    // otherwise stamp a backfilled row with the BACKFILL's own timestamp --
    // making a long-dead job look recently active to the stale-job
    // watchdog. `emittedAt` (set by the publisher at the moment it actually
    // published, both ingestion- and orchestrator-side) is the real origin
    // time; falls back to "now" only for an event published by an
    // old/rolling-deploy producer that predates this field.
    const emittedAt = typeof payload.emittedAt === 'string' ? new Date(payload.emittedAt) : null;
    const createdAt = emittedAt && !Number.isNaN(emittedAt.getTime()) ? emittedAt : new Date();
    return {
      phase,
      message: message_,
      detail: payload as object,
      severity: phase === 'job_failed' || phase === 'failed' ? 'error' : 'info',
      createdAt,
    };
  }

  private async persist(channel: string, message: string): Promise<void> {
    const jobId = channel.slice('job-events:'.length);
    if (!jobId) return;
    // The psubscribe pattern ('job-events:*') also matches every per-job
    // SUB-channel -- `job-events:<id>:units`, `:progress`, `:live` -- whose
    // payloads are live-progress ticks, not job events. Their "job id" here
    // would be `<id>:units` etc., which is no Job row, so every one used to
    // fail the JobEvent.jobId foreign key and flood the log with a Prisma
    // error per tick (real events for the same job persisted fine). A real
    // job id never contains ':'.
    if (jobId.includes(':')) return;
    const parsed = this.parsePayload(message);
    if (!parsed) return;
    try {
      await this.prisma.jobEvent.create({ data: { jobId, ...parsed } });
    } catch (err) {
      // A job may have been deleted (JobsService.delete) between publish and
      // persist, or the DB may be briefly unreachable -- never let this
      // background subscriber die over a single failed write.
      // eslint-disable-next-line no-console -- no structured logger in this module yet
      console.error(`JobEventPersistenceService failed to persist event for job ${jobId}:`, err);
    }
  }

  async backfillMissedEvents(): Promise<void> {
    const narrationLogKeys = await this.scanKeys('job-events:*:narration-log');
    for (const key of narrationLogKeys) {
      const jobId = key.slice('job-events:'.length, key.length - ':narration-log'.length);
      if (jobId) await this.backfillJobNarrationLog(jobId, key);
    }
    const currentKeys = await this.scanKeys('job-events:*:current');
    for (const key of currentKeys) {
      const jobId = key.slice('job-events:'.length, key.length - ':current'.length);
      if (jobId) await this.backfillJobCurrentStage(jobId, key);
    }
  }

  // KEYS blocks Redis's single command-processing thread for the duration
  // of a full keyspace scan (O(entire keyspace), not just matching keys) --
  // a real risk on a production instance shared with every other job's
  // live pub/sub traffic. SCAN (via ioredis's own cursor-based scanStream)
  // does the same match, incrementally, without blocking other clients.
  private scanKeys(pattern: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const keys: string[] = [];
      const stream = this.commandClient.scanStream({ match: pattern, count: 100 });
      stream.on('data', (batch: string[]) => keys.push(...batch));
      stream.on('end', () => resolve(keys));
      stream.on('error', reject);
    });
  }

  private async existingKeysFor(jobId: string): Promise<Set<string>> {
    // Well past the narration-log's own 50-entry cap -- comparing against
    // more history than Redis could possibly still hold means a genuinely
    // already-persisted entry is never mistaken for missing just because
    // Postgres has grown past what the bounded Redis list still shows.
    const existing = await this.prisma.jobEvent.findMany({
      where: { jobId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { phase: true, message: true },
    });
    return new Set(existing.map((e) => `${e.phase}|${e.message}`));
  }

  private async backfillJobNarrationLog(jobId: string, key: string): Promise<void> {
    const entries = await this.commandClient.lrange(key, 0, -1);
    if (entries.length === 0) return;
    const seen = await this.existingKeysFor(jobId);
    for (const raw of entries) {
      const parsed = this.parsePayload(raw);
      if (!parsed) continue;
      const dedupeKey = `${parsed.phase}|${parsed.message}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey); // a duplicate live figure caption, etc. within the SAME backfill pass must only insert once
      try {
        await this.prisma.jobEvent.create({ data: { jobId, ...parsed } });
      } catch (err) {
        // eslint-disable-next-line no-console -- no structured logger in this module yet
        console.error(`JobEventPersistenceService failed to backfill narration for job ${jobId}:`, err);
      }
    }
  }

  private async backfillJobCurrentStage(jobId: string, key: string): Promise<void> {
    const raw = await this.commandClient.get(key);
    if (!raw) return;
    const parsed = this.parsePayload(raw);
    if (!parsed) return;
    const seen = await this.existingKeysFor(jobId);
    if (seen.has(`${parsed.phase}|${parsed.message}`)) return;
    try {
      await this.prisma.jobEvent.create({ data: { jobId, ...parsed } });
    } catch (err) {
      // eslint-disable-next-line no-console -- no structured logger in this module yet
      console.error(`JobEventPersistenceService failed to backfill current stage for job ${jobId}:`, err);
    }
  }
}
