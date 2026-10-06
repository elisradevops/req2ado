import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { JobsService } from './jobs.service';

// Real gap this closes (live-caught): a job stayed `status='running'` for
// 15+ hours because the host Mac slept -- Docker Desktop's VM (and every
// container in it: Postgres, Redis, ingestion, orchestrator) fully suspends
// with the host, then resumes exactly where it left off on wake. The job's
// own processing was genuinely fine once resumed; nothing in this system
// ever caps how long a job can sit with zero activity before something
// notices and fails it gracefully -- a truly hung/dead connection would look
// identical to that 15-hour gap from the UI's perspective.
//
// Periodically (checkIntervalMs) scans every pending/running job and
// compares `now()` against its most recent JobEvent (the durable narration
// trail -- see JobEventPersistenceService), falling back to the job's own
// createdAt when no event has landed yet. A gap past staleThresholdMs means
// no real progress signal has arrived in that long -- stale enough to
// auto-cancel rather than trust indefinitely.
//
// Reuses the ALREADY-EXISTING JobsService.cancel() rather than inventing a
// second termination path -- inherits that method's own already-honest,
// already-documented limitation (cancellation takes effect at the pipeline
// worker's NEXT checkpoint, not mid-call, since there is no cross-process
// abort channel for an in-flight LLM HTTP call) rather than pretending to
// forcibly kill a hung call. Only pending/running are scanned, matching
// cancel()'s own status guard exactly.
//
// Bootstrapped exactly once, same reasoning as JobEventPersistenceService:
// JobsModule only ever loads in the orchestrator HTTP process
// (pipeline-worker.main.ts is a standalone script, not a Nest application).
@Injectable()
export class StaleJobWatchdogService implements OnModuleInit, OnModuleDestroy {
  private intervalHandle?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly jobsService: JobsService,
    private readonly checkIntervalMs: number,
    private readonly staleThresholdMs: number,
  ) {}

  onModuleInit(): void {
    this.intervalHandle = setInterval(() => {
      // sweep()'s findMany/groupBy are unguarded -- a transient Postgres
      // failure would otherwise be an unhandled rejection, which Node 22
      // turns into a process exit (killing every in-flight job). The next
      // tick simply retries.
      this.sweep().catch((err) => {
        // eslint-disable-next-line no-console -- no structured logger in this module yet
        console.error('StaleJobWatchdogService sweep failed, will retry next interval:', err);
      });
    }, this.checkIntervalMs);
  }

  onModuleDestroy(): void {
    clearInterval(this.intervalHandle);
  }

  async sweep(): Promise<void> {
    const candidates = await this.prisma.job.findMany({
      where: { status: { in: ['pending', 'running'] } },
      // Only id/createdAt are ever read below -- selecting every column
      // pulled each in-flight job's full dryRunDiff JSON across the wire
      // on every tick just to compare a timestamp.
      select: { id: true, createdAt: true },
    });
    if (candidates.length === 0) return;
    // One groupBy for the whole batch, not one jobEvent.findFirst PER
    // candidate (N+1) -- uses JobEvent's existing @@index([jobId, createdAt]).
    // A jobId with zero JobEvent rows simply has no entry here, matching
    // findFirst's own "returns null / falls back to job.createdAt" behavior.
    const grouped = await this.prisma.jobEvent.groupBy({
      by: ['jobId'],
      where: { jobId: { in: candidates.map((job) => job.id) } },
      _max: { createdAt: true },
    });
    const lastEventByJobId = new Map<string, Date>();
    for (const row of grouped) {
      if (row._max.createdAt) lastEventByJobId.set(row.jobId, row._max.createdAt);
    }
    const staleMinutes = Math.round(this.staleThresholdMs / 60_000);
    for (const job of candidates) {
      const lastActivity = lastEventByJobId.get(job.id) ?? job.createdAt;
      if (Date.now() - lastActivity.getTime() <= this.staleThresholdMs) {
        continue;
      }
      // Best-effort, one job at a time -- a single cancel() failure (job
      // already transitioned by the time this runs, a transient DB error)
      // must never abort the sweep for every other candidate.
      await this.jobsService
        .cancel(
          job.id,
          `Automatically cancelled -- no activity detected for over ${staleMinutes} minutes. This can ` +
            'happen if the host machine was suspended/asleep, lost connectivity to the LLM backend, or a ' +
            'process hung. Resubmit to try again.',
        )
        .catch(() => undefined);
    }
  }
}
