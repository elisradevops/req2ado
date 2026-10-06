import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// Real gap this closes: nothing in this system ever ages out old job
// records -- a long-running dev/prod instance accumulates every job's full
// history (JobEvent alone can be 50+ rows per job) forever, with no way to
// reclaim it short of a manual DB wipe (see docs/known-issues-live-review.md's
// 2026-08-09 account-reset entry, which did exactly that by hand after an
// ADO account migration).
//
// Only TERMINAL, no-longer-actionable jobs are eligible:
// succeeded/failed/rejected/cancelled. pending/running are always active;
// diff_ready is excluded even past the age threshold -- it's still awaiting
// a real confirm/reject decision, not something safe to silently discard.
// Age is measured from `createdAt` -- the only timestamp every job row
// reliably has (`completedAt` is only ever set on confirm(), i.e.
// succeeded-only -- see jobs.service.ts).
//
// Deliberately does NOT touch IdempotencyMapping or the dedup vector store
// (Chroma): both exist specifically to prevent duplicate ADO writes
// indefinitely, with no natural expiry -- age-pruning them would let the
// exact same content get recreated as a duplicate work item on a later
// resubmit, reintroducing the bug they exist to prevent. Deleting a Job
// row here has zero effect on either.
//
// Same deletion-order constraint as the manual reset this replaces: every
// FK from JobEvent/AuditEntry/DedupSkipAudit/CreatedItemMapping/
// JobSourceFile/JobFigureFile to Job is ON DELETE RESTRICT (see the relevant migrations),
// so children must be deleted before their parent Job row. ChatMessage has
// no FK at all (a bare jobId string) -- deleted alongside anyway so it
// doesn't accumulate as permanently-orphaned rows.
//
// Bootstrapped exactly once, same reasoning as StaleJobWatchdogService/
// JobEventPersistenceService: JobsModule only ever loads in the
// orchestrator HTTP process (pipeline-worker.main.ts is a standalone
// script, not a Nest application).
const _TERMINAL_RETENTION_STATUSES = ['succeeded', 'failed', 'rejected', 'cancelled'];

@Injectable()
export class JobRetentionService implements OnModuleInit, OnModuleDestroy {
  private intervalHandle?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly checkIntervalMs: number,
    private readonly maxAgeMs: number,
  ) {}

  onModuleInit(): void {
    this.intervalHandle = setInterval(() => {
      // Only the $transaction in sweep() is guarded -- the initial findMany
      // is not, so a transient Postgres failure would be an unhandled
      // rejection (process exit on Node 22). The next tick simply retries.
      this.sweep().catch((err) => {
        // eslint-disable-next-line no-console -- no structured logger in this module yet
        console.error('JobRetentionService sweep failed, will retry next interval:', err);
      });
    }, this.checkIntervalMs);
  }

  onModuleDestroy(): void {
    clearInterval(this.intervalHandle);
  }

  async sweep(): Promise<void> {
    const cutoff = new Date(Date.now() - this.maxAgeMs);
    const candidates = await this.prisma.job.findMany({
      where: { status: { in: _TERMINAL_RETENTION_STATUSES }, createdAt: { lt: cutoff } },
      select: { id: true },
    });
    if (candidates.length === 0) return;
    const jobIds = candidates.map((job) => job.id);

    // Best-effort, one transaction for the whole batch -- a partial sweep
    // (some old jobs reclaimed, the rest left for the next interval) is a
    // safe, natural retry; there is no partial-row state to reconcile.
    await this.prisma
      .$transaction([
        this.prisma.chatMessage.deleteMany({ where: { jobId: { in: jobIds } } }),
        this.prisma.jobEvent.deleteMany({ where: { jobId: { in: jobIds } } }),
        this.prisma.auditEntry.deleteMany({ where: { jobId: { in: jobIds } } }),
        this.prisma.dedupSkipAudit.deleteMany({ where: { jobId: { in: jobIds } } }),
        this.prisma.createdItemMapping.deleteMany({ where: { jobId: { in: jobIds } } }),
        this.prisma.jobSourceFile.deleteMany({ where: { jobId: { in: jobIds } } }),
        this.prisma.jobFigureFile.deleteMany({ where: { jobId: { in: jobIds } } }),
        this.prisma.job.deleteMany({ where: { id: { in: jobIds } } }),
      ])
      .catch(() => undefined);
  }
}
