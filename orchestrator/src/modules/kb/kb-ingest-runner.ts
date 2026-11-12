import { Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { IngestionHttpError } from '../pipeline/ingestion-http.client';
import type { KbService } from './kb.service';
import type { KbRetrievalMode } from './kb-ingest-batch.service';

// Runs the knowledge-base batches: one file at a time, in the orchestrator process, with every bit of state in Postgres, so
// a closed tab or a restart loses nothing. (Not BullMQ: Redis keeps nothing across a restart here, so a queue would still
// need reconciling against these rows on every start.) The shape follows BatchService.pumpOnce(): an optimistic claim, a
// lease that lets a crashed attempt be taken back, and a timer kept separate (KbIngestRunnerTimer) so tests call pumpOnce()
// directly with no fake timers.
//
// One file at a time, across all users: ingestion is a single process, and the embedding, vision and LLM backends behind
// it are shared with running jobs and the profile build, so more parallelism mostly adds contention and timeouts. Users are
// served round-robin, so one user's big batch does not make everyone else wait for it.

const logger = new Logger('KbIngestRunner');

export interface KbIngestRunnerOptions {
  // How long one file may take before the attempt is given up on.
  itemTimeoutMs: number;
  // Attempts per file (the first included) before a transient failure becomes final.
  maxAttempts: number;
  // Wait before retry n (1-based attempts used); the last entry repeats.
  backoffMs: number[];
  now?: () => Date;
}

export const DEFAULT_BACKOFF_MS = [30_000, 120_000, 600_000];

type ErrorKind = 'transient' | 'permanent' | 'auth';

export interface ClassifiedError {
  kind: ErrorKind;
  reason: string;
}

const MAX_REASON_LENGTH = 300;

function shorten(message: string): string {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_REASON_LENGTH ? `${oneLine.slice(0, MAX_REASON_LENGTH - 1)}…` : oneLine;
}

/**
 * What a failed ingest call means for the file. An expired SharePoint token (401, or the 424 the controller maps it to) is
 * not the file's fault and stops the batch instead. A 429 or any 5xx, a timeout and a network failure are worth another try
 * later. Anything else the service refused (unsupported, too large, not found, no permission) will be refused again.
 */
export function classifyIngestError(error: unknown): ClassifiedError {
  if (error instanceof IngestionHttpError) {
    const { status } = error;
    if (status === 401 || status === 424) return { kind: 'auth', reason: 'SharePoint token expired or invalid' };
    if (status === 403) return { kind: 'permanent', reason: 'the SharePoint token lacks permission for this file' };
    if (status === 404) return { kind: 'permanent', reason: 'file not found (moved or deleted)' };
    if (status === 429 || status >= 500) return { kind: 'transient', reason: shorten(error.message) };
    return { kind: 'permanent', reason: shorten(error.message) };
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return { kind: 'transient', reason: 'timed out before the file was ingested' };
  return { kind: 'transient', reason: shorten(error instanceof Error ? error.message : String(error)) };
}

type BatchRow = { id: string; userId: string; status: string; docType: string | null; cancelRequestedAt: Date | null; profileScheduledAt: Date | null; createdAt: Date };
type ItemRow = {
  id: string;
  batchId: string;
  ordinal: number;
  driveId: string;
  itemId: string;
  relativePath: string;
  retrievalMode: string;
  state: string;
  attempts: number;
};

const FINISHED = ['completed', 'completed_with_errors', 'cancelled', 'failed'];

@Injectable()
export class KbIngestRunner {
  private busy = false;
  // Order in which users were last served, not a clock: ticks can share a timestamp.
  private serveSequence = 0;
  private readonly lastServed = new Map<string, number>();
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly kb: Pick<KbService, 'ingestDriveItem'>,
    private readonly profileScheduler: { schedule(userId: string): Promise<unknown> } | undefined,
    private readonly options: KbIngestRunnerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Ingests files until none is ready. Never throws: a failure here is logged and the next tick tries again. */
  async run(): Promise<void> {
    try {
      while (await this.pumpOnce()) {
        // keep going: the next file is ready now, no reason to wait for the next tick
      }
    } catch (error) {
      logger.error(`KB ingest pump failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Takes and ingests the next ready file. Resolves true when it handled one, false when there was nothing to do. */
  async pumpOnce(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      await this.reclaimExpiredLeases();
      await this.finishCancelledBatches();
      const claimed = await this.claimNext();
      if (!claimed) return false;
      await this.process(claimed.item, claimed.batch);
      return true;
    } finally {
      this.busy = false;
    }
  }

  /**
   * After a restart no file is really running any more: whatever was is put back in the queue (its attempt stays counted). One that
   * has already used all its attempts is failed instead: a file that crashes the process would otherwise be taken, crash it again
   * and be put back on every start, for ever.
   */
  async recoverOrphans(): Promise<void> {
    const running = await this.prisma.kbIngestBatchItem.findMany({ where: { state: 'running' } });
    const now = this.now();
    let requeued = 0;
    const touched = new Set<string>();
    for (const item of running) {
      if (item.attempts >= this.options.maxAttempts) {
        await this.prisma.kbIngestBatchItem.update({
          where: { id: item.id },
          data: { state: 'failed', leaseUntil: null, errorKind: 'transient', reason: 'interrupted by a restart on every attempt; giving up', finishedAt: now },
        });
      } else {
        await this.prisma.kbIngestBatchItem.update({
          where: { id: item.id },
          data: { state: 'queued', leaseUntil: null, startedAt: null, errorKind: 'transient', reason: 'interrupted by a restart; retrying' },
        });
        requeued += 1;
      }
      touched.add(item.batchId);
    }
    for (const batchId of touched) {
      await this.bumpVersion(batchId);
      await this.settleBatch(batchId);
    }
    if (requeued > 0) logger.warn(`Re-queued ${requeued} knowledge-base file(s) that were running when the process stopped`);
    if (touched.size > 0 && requeued < running.length) logger.warn(`Failed ${running.length - requeued} knowledge-base file(s) that were interrupted by a restart on every attempt`);
  }

  /** A file whose attempt outlived its lease is taken back, or failed when it has used all its attempts. */
  async reclaimExpiredLeases(): Promise<void> {
    const now = this.now();
    const expired = await this.prisma.kbIngestBatchItem.findMany({ where: { state: 'running', leaseUntil: { lt: now } } });
    for (const item of expired) {
      if (item.attempts >= this.options.maxAttempts) {
        await this.prisma.kbIngestBatchItem.update({
          where: { id: item.id },
          data: { state: 'failed', leaseUntil: null, errorKind: 'transient', reason: 'timed out: the file did not finish in time', finishedAt: now },
        });
      } else {
        await this.prisma.kbIngestBatchItem.update({
          where: { id: item.id },
          data: { state: 'queued', leaseUntil: null, startedAt: null, errorKind: 'transient', reason: 'the previous attempt did not finish; retrying' },
        });
      }
      await this.bumpVersion(item.batchId);
      await this.settleBatch(item.batchId);
    }
  }

  private async claimNext(): Promise<{ item: ItemRow; batch: BatchRow } | null> {
    const now = this.now();
    const batches = (await this.prisma.kbIngestBatch.findMany({ where: { status: { in: ['queued', 'running'] }, cancelRequestedAt: null } })) as BatchRow[];
    if (batches.length === 0) return null;
    const batchById = new Map(batches.map((b) => [b.id, b]));
    const ready = (await this.prisma.kbIngestBatchItem.findMany({
      where: { batchId: { in: batches.map((b) => b.id) }, state: 'queued', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    })) as ItemRow[];
    if (ready.length === 0) return null;

    // The user served least recently goes next; within a user, the oldest batch, then file order.
    const next = [...ready].sort((a, b) => {
      const batchA = batchById.get(a.batchId)!;
      const batchB = batchById.get(b.batchId)!;
      const served = (this.lastServed.get(batchA.userId) ?? 0) - (this.lastServed.get(batchB.userId) ?? 0);
      if (served !== 0) return served;
      const created = batchA.createdAt.getTime() - batchB.createdAt.getTime();
      if (created !== 0) return created;
      return a.batchId === b.batchId ? a.ordinal - b.ordinal : a.batchId.localeCompare(b.batchId);
    })[0];
    const batch = batchById.get(next.batchId)!;

    const claim = await this.prisma.kbIngestBatchItem.updateMany({
      where: { id: next.id, state: 'queued' },
      data: { state: 'running', leaseUntil: new Date(now.getTime() + this.options.itemTimeoutMs), startedAt: now, nextAttemptAt: null, attempts: { increment: 1 } },
    });
    if (claim.count === 0) return null; // someone else took it first
    this.lastServed.set(batch.userId, ++this.serveSequence);

    await this.prisma.kbIngestBatch.update({
      where: { id: batch.id },
      data: { version: { increment: 1 }, ...(batch.status === 'queued' ? { status: 'running', startedAt: now } : {}) },
    });
    return { item: { ...next, attempts: next.attempts + 1 }, batch };
  }

  private async process(item: ItemRow, batch: BatchRow): Promise<void> {
    try {
      const result = await this.kb.ingestDriveItem({
        userId: batch.userId,
        driveId: item.driveId,
        itemId: item.itemId,
        relativePath: item.relativePath,
        docType: batch.docType,
        retrievalMode: item.retrievalMode as KbRetrievalMode,
        scheduleProfile: false,
        signal: AbortSignal.timeout(this.options.itemTimeoutMs),
      });
      await this.prisma.kbIngestBatchItem.update({
        where: { id: item.id },
        data: {
          state: result.skippedUnchanged ? 'unchanged' : 'added',
          chunksStored: result.chunksStored,
          chunksInStore: result.chunksInStore,
          ingestedDocumentId: result.ingestedDocumentId,
          leaseUntil: null,
          nextAttemptAt: null,
          errorKind: null,
          // Stored, but nothing to ground a job with: the report warns about it.
          reason: result.chunksInStore === 0 ? 'no text could be stored (empty, or only images?)' : null,
          finishedAt: this.now(),
        },
      });
    } catch (error) {
      await this.recordFailure(item, batch, error);
    }
    // A cancel that arrived while this file was in flight swept the waiting files, but not this one: a retry it was just given
    // would never be taken up again.
    await this.cancelWaitingFiles(batch.id);
    await this.bumpVersion(batch.id);
    await this.settleBatch(batch.id);
  }

  /**
   * A cancelled batch is never dispatched from, so a file left waiting in one (put back for a retry, or put back by a restart,
   * after the cancel had swept the queue) would hold it open for ever. Cancels those files and lets the batch end.
   */
  private async finishCancelledBatches(): Promise<void> {
    const stuck = (await this.prisma.kbIngestBatch.findMany({ where: { status: { in: ['queued', 'running'] }, cancelRequestedAt: { not: null } } })) as BatchRow[];
    for (const batch of stuck) {
      await this.cancelWaitingFiles(batch.id);
      await this.settleBatch(batch.id);
    }
  }

  private async cancelWaitingFiles(batchId: string): Promise<void> {
    const batch = (await this.prisma.kbIngestBatch.findFirst({ where: { id: batchId } })) as BatchRow | null;
    if (!batch || batch.cancelRequestedAt === null || FINISHED.includes(batch.status)) return;
    await this.prisma.kbIngestBatchItem.updateMany({ where: { batchId, state: 'queued' }, data: { state: 'cancelled', reason: 'cancelled', nextAttemptAt: null, finishedAt: this.now() } });
  }

  private async recordFailure(item: ItemRow, batch: BatchRow, error: unknown): Promise<void> {
    const { kind, reason } = classifyIngestError(error);
    const now = this.now();
    if (kind === 'auth') {
      // Not the file's doing: give the attempt back and stop the batch until the token is replaced.
      await this.prisma.kbIngestBatchItem.update({
        where: { id: item.id },
        data: { state: 'queued', leaseUntil: null, startedAt: null, attempts: { increment: -1 }, errorKind: 'auth', reason },
      });
      await this.prisma.kbIngestBatch.update({ where: { id: batch.id }, data: { status: 'paused', pauseReason: 'sharepoint_token' } });
      logger.warn(`Batch ${batch.id} paused: SharePoint token expired or invalid`);
      return;
    }
    const retryable = kind === 'transient' && item.attempts < this.options.maxAttempts;
    if (retryable) {
      const wait = this.options.backoffMs[Math.min(item.attempts - 1, this.options.backoffMs.length - 1)];
      await this.prisma.kbIngestBatchItem.update({
        where: { id: item.id },
        data: { state: 'queued', leaseUntil: null, startedAt: null, errorKind: kind, reason, nextAttemptAt: new Date(now.getTime() + wait) },
      });
      return;
    }
    await this.prisma.kbIngestBatchItem.update({
      where: { id: item.id },
      data: { state: 'failed', leaseUntil: null, nextAttemptAt: null, errorKind: kind, reason, finishedAt: now },
    });
  }

  private async bumpVersion(batchId: string): Promise<void> {
    await this.prisma.kbIngestBatch.update({ where: { id: batchId }, data: { version: { increment: 1 } } });
  }

  /**
   * Ends a batch once no file is waiting or running: `cancelled` if the user asked, else `failed` when nothing got in,
   * `completed_with_errors` when some failed, `completed` otherwise. The profile is requested here, once, for the whole batch.
   */
  private async settleBatch(batchId: string): Promise<void> {
    const batch = (await this.prisma.kbIngestBatch.findFirst({ where: { id: batchId } })) as BatchRow | null;
    if (!batch || FINISHED.includes(batch.status)) return;
    const items = await this.prisma.kbIngestBatchItem.findMany({ where: { batchId } });
    if (items.some((i) => i.state === 'queued' || i.state === 'running')) return;

    const failed = items.filter((i) => i.state === 'failed').length;
    const succeeded = items.filter((i) => i.state === 'added' || i.state === 'unchanged').length;
    const status = batch.cancelRequestedAt ? 'cancelled' : failed === 0 ? 'completed' : succeeded === 0 ? 'failed' : 'completed_with_errors';
    await this.prisma.kbIngestBatch.update({
      where: { id: batchId },
      data: { status, pauseReason: null, finishedAt: this.now(), version: { increment: 1 } },
    });

    // What was added is not in the rubric yet. Once per batch: a build per file would start between files and compete with
    // the next one for the LLM. A failure to ask is not the batch's failure (the next job builds the profile if it must).
    if (batch.profileScheduledAt === null && items.some((i) => i.state === 'added')) {
      try {
        await this.profileScheduler?.schedule(batch.userId);
        await this.prisma.kbIngestBatch.update({ where: { id: batchId }, data: { profileScheduledAt: this.now(), version: { increment: 1 } } });
      } catch (error) {
        logger.warn(`Could not request the knowledge-base profile build for batch ${batchId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
