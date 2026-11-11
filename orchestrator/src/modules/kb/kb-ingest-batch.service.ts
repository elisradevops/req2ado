import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

// The batch ledger behind "add these files to the knowledge base": what was asked for, what each file is doing, and the
// user-facing operations on it (cancel, retry the failures, resume). It decides nothing about HOW a file is ingested: that is
// KbIngestRunner's job, which advances the rows this service creates. Everything is scoped to the session user; another
// user's batch is indistinguishable from one that does not exist.

export const KB_INGEST_MAX_ITEMS = 200;
export const KB_INGEST_MAX_ACTIVE_BATCHES = 3;
// Mirrors ingestion's own per-file limit (url_security.MAX_FILE_SIZE_BYTES), so a file ingestion would refuse is refused here
// instead of being queued to fail.
export const KB_INGEST_MAX_FILE_BYTES = 50 * 1024 * 1024;

export type KbIngestBatchStatus = 'queued' | 'running' | 'paused' | 'completed' | 'completed_with_errors' | 'cancelled' | 'failed';
export type KbIngestItemState = 'queued' | 'running' | 'added' | 'unchanged' | 'failed' | 'skipped' | 'cancelled';
export type KbRetrievalMode = 'retrieve' | 'always_include';

export const ACTIVE_BATCH_STATUSES: KbIngestBatchStatus[] = ['queued', 'running', 'paused'];
const FINISHED_BATCH_STATUSES: KbIngestBatchStatus[] = ['completed', 'completed_with_errors', 'cancelled', 'failed'];
// A file in one of these states is still going to be (or being) ingested.
const LIVE_ITEM_STATES: KbIngestItemState[] = ['queued', 'running'];

export interface KbIngestItemView {
  id: string;
  ordinal: number;
  itemId: string;
  name: string;
  relativePath: string;
  sizeBytes: number;
  retrievalMode: KbRetrievalMode;
  state: KbIngestItemState;
  attempts: number;
  errorKind: string | null;
  reason: string | null;
  chunksStored: number | null;
  chunksInStore: number | null;
  ingestedDocumentId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface KbIngestCounts {
  total: number;
  queued: number;
  running: number;
  added: number;
  unchanged: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

export interface KbIngestBatchView {
  id: string;
  status: KbIngestBatchStatus;
  pauseReason: string | null;
  cancelRequested: boolean;
  driveId: string;
  folderItemId: string | null;
  folderPath: string;
  docType: string | null;
  // Bumped on every change, so a client can tell cheaply whether anything moved.
  version: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  counts: KbIngestCounts;
  // Present for a single batch (get/create), absent in a list.
  items?: KbIngestItemView[];
}

interface ValidItem {
  itemId: string;
  name: string;
  relativePath: string;
  sizeBytes: number;
  retrievalMode: KbRetrievalMode;
}

interface ValidBatchInput {
  driveId: string;
  folderItemId: string | null;
  folderPath: string;
  docType: string | null;
  items: ValidItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseItem(raw: unknown, index: number): ValidItem {
  if (!isRecord(raw)) throw new BadRequestException(`items[${index}] must be an object`);
  const { itemId, name, relativePath, sizeBytes, retrievalMode } = raw;
  if (!nonEmptyString(itemId)) throw new BadRequestException(`items[${index}].itemId is required`);
  if (!nonEmptyString(name)) throw new BadRequestException(`items[${index}].name is required`);
  if (!nonEmptyString(relativePath)) throw new BadRequestException(`items[${index}].relativePath is required`);
  if (typeof sizeBytes !== 'number' || !Number.isInteger(sizeBytes) || sizeBytes < 0) {
    throw new BadRequestException(`items[${index}].sizeBytes must be a whole number of bytes`);
  }
  if (retrievalMode !== 'retrieve' && retrievalMode !== 'always_include') {
    throw new BadRequestException(`items[${index}].retrievalMode must be 'retrieve' or 'always_include'`);
  }
  return { itemId, name, relativePath, sizeBytes, retrievalMode };
}

function parseBatchInput(raw: unknown): ValidBatchInput {
  if (!isRecord(raw)) throw new BadRequestException('body must be an object');
  const { driveId, folderItemId, folderPath, docType, items } = raw;
  if (!nonEmptyString(driveId)) throw new BadRequestException('driveId is required');
  if (typeof folderPath !== 'string') throw new BadRequestException('folderPath must be a string');
  if (!Array.isArray(items) || items.length === 0) throw new BadRequestException('items must list at least one file');
  if (items.length > KB_INGEST_MAX_ITEMS) throw new BadRequestException(`a batch holds at most ${KB_INGEST_MAX_ITEMS} files`);
  const parsed = items.map(parseItem);
  const oversized = parsed.filter((item) => item.sizeBytes > KB_INGEST_MAX_FILE_BYTES);
  if (oversized.length > 0) {
    const shown = oversized.slice(0, 5).map((item) => item.name).join(', ');
    const more = oversized.length > 5 ? ` and ${oversized.length - 5} more` : '';
    throw new BadRequestException(`${oversized.length} file(s) exceed the ${KB_INGEST_MAX_FILE_BYTES / (1024 * 1024)} MB limit: ${shown}${more}`);
  }
  // The same file listed twice is one file: the first entry wins.
  const seen = new Set<string>();
  const unique = parsed.filter((item) => (seen.has(item.itemId) ? false : (seen.add(item.itemId), true)));
  return {
    driveId,
    folderItemId: nonEmptyString(folderItemId) ? folderItemId : null,
    folderPath,
    docType: nonEmptyString(docType) ? docType : null,
    items: unique,
  };
}

type ItemRow = {
  id: string;
  ordinal: number;
  itemId: string;
  name: string;
  relativePath: string;
  sizeBytes: number;
  retrievalMode: string;
  state: string;
  attempts: number;
  errorKind: string | null;
  reason: string | null;
  chunksStored: number | null;
  chunksInStore: number | null;
  ingestedDocumentId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
};

type BatchRow = {
  id: string;
  status: string;
  pauseReason: string | null;
  cancelRequestedAt: Date | null;
  driveId: string;
  folderItemId: string | null;
  folderPath: string;
  docType: string | null;
  version: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

function toCounts(items: { state: string }[]): KbIngestCounts {
  const counts: KbIngestCounts = { total: items.length, queued: 0, running: 0, added: 0, unchanged: 0, failed: 0, skipped: 0, cancelled: 0 };
  for (const { state } of items) {
    if (state in counts && state !== 'total') counts[state as Exclude<keyof KbIngestCounts, 'total'>] += 1;
  }
  return counts;
}

function toItemView(row: ItemRow): KbIngestItemView {
  return {
    id: row.id,
    ordinal: row.ordinal,
    itemId: row.itemId,
    name: row.name,
    relativePath: row.relativePath,
    sizeBytes: row.sizeBytes,
    retrievalMode: row.retrievalMode as KbRetrievalMode,
    state: row.state as KbIngestItemState,
    attempts: row.attempts,
    errorKind: row.errorKind,
    reason: row.reason,
    chunksStored: row.chunksStored,
    chunksInStore: row.chunksInStore,
    ingestedDocumentId: row.ingestedDocumentId,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

function toBatchView(batch: BatchRow, items: ItemRow[], includeItems: boolean): KbIngestBatchView {
  return {
    id: batch.id,
    status: batch.status as KbIngestBatchStatus,
    pauseReason: batch.pauseReason,
    cancelRequested: batch.cancelRequestedAt !== null,
    driveId: batch.driveId,
    folderItemId: batch.folderItemId,
    folderPath: batch.folderPath,
    docType: batch.docType,
    version: batch.version,
    createdAt: batch.createdAt,
    startedAt: batch.startedAt,
    finishedAt: batch.finishedAt,
    counts: toCounts(items),
    ...(includeItems ? { items: [...items].sort((a, b) => a.ordinal - b.ordinal).map(toItemView) } : {}),
  };
}

@Injectable()
export class KbIngestBatchService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Queues a batch. A file over the size limit rejects the whole request (the page filters those out first, so this is the
   * backstop, not the usual path); a file already waiting in another of the user's active batches is created as `skipped`
   * instead of being ingested twice.
   */
  async create(userId: string, raw: unknown): Promise<KbIngestBatchView> {
    const input = parseBatchInput(raw);

    const activeBatches = await this.prisma.kbIngestBatch.findMany({ where: { userId, status: { in: ACTIVE_BATCH_STATUSES } }, select: { id: true } });
    if (activeBatches.length >= KB_INGEST_MAX_ACTIVE_BATCHES) {
      throw new ConflictException(`You already have ${KB_INGEST_MAX_ACTIVE_BATCHES} batches in progress. Wait for one to finish, or cancel it.`);
    }

    const alreadyLive = activeBatches.length
      ? await this.prisma.kbIngestBatchItem.findMany({
          where: { batchId: { in: activeBatches.map((b) => b.id) }, itemId: { in: input.items.map((i) => i.itemId) }, state: { in: LIVE_ITEM_STATES } },
          select: { itemId: true },
        })
      : [];
    const liveIds = new Set(alreadyLive.map((row) => row.itemId));

    const runnable = input.items.filter((item) => !liveIds.has(item.itemId));
    const now = new Date();
    const batchId = await this.prisma.$transaction(async (tx) => {
      const batch = await tx.kbIngestBatch.create({
        data: {
          userId,
          driveId: input.driveId,
          folderItemId: input.folderItemId,
          folderPath: input.folderPath,
          docType: input.docType,
          status: runnable.length === 0 ? 'completed' : 'queued',
          finishedAt: runnable.length === 0 ? now : null,
        },
      });
      await tx.kbIngestBatchItem.createMany({
        data: input.items.map((item, ordinal) => {
          const skipped = liveIds.has(item.itemId);
          return {
            batchId: batch.id,
            ordinal,
            driveId: input.driveId,
            itemId: item.itemId,
            name: item.name,
            relativePath: item.relativePath,
            sizeBytes: item.sizeBytes,
            retrievalMode: item.retrievalMode,
            state: skipped ? 'skipped' : 'queued',
            reason: skipped ? 'already queued in another batch' : null,
            finishedAt: skipped ? now : null,
          };
        }),
      });
      return batch.id;
    });
    return (await this.get(userId, batchId))!;
  }

  async get(userId: string, id: string): Promise<KbIngestBatchView | null> {
    const batch = await this.prisma.kbIngestBatch.findFirst({ where: { id, userId } });
    if (!batch) return null;
    const items = await this.prisma.kbIngestBatchItem.findMany({ where: { batchId: id }, orderBy: { ordinal: 'asc' } });
    return toBatchView(batch, items, true);
  }

  /**
   * Removes batches that finished before `cutoff`, with their files (the foreign key cascades). A batch still queued, running
   * or paused is never removed, however old: someone may still be waiting on it. The documents the files added are not
   * touched; this only forgets the record of the batch. Returns how many batches went.
   */
  async deleteFinishedBefore(cutoff: Date): Promise<number> {
    const removed = await this.prisma.kbIngestBatch.deleteMany({ where: { status: { in: FINISHED_BATCH_STATUSES }, finishedAt: { lt: cutoff } } });
    return removed.count;
  }

  /** The user's recent batches, newest first, with counts but without their files. */
  async list(userId: string, options: { active?: boolean; limit?: number }): Promise<KbIngestBatchView[]> {
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
    const batches = await this.prisma.kbIngestBatch.findMany({
      where: { userId, ...(options.active ? { status: { in: ACTIVE_BATCH_STATUSES } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    if (batches.length === 0) return [];
    const items = await this.prisma.kbIngestBatchItem.findMany({ where: { batchId: { in: batches.map((b) => b.id) } } });
    return batches.map((batch) =>
      toBatchView(
        batch,
        items.filter((item) => item.batchId === batch.id),
        false,
      ),
    );
  }

  /**
   * Stops the batch: the files still waiting are cancelled now, and the file being ingested finishes (its call cannot be
   * taken back, and the work it does is kept). The batch is `cancelled` once nothing is running; until then it stays
   * `running` with `cancelRequested` set, and the runner finishes it.
   */
  async cancel(userId: string, id: string): Promise<KbIngestBatchView | null> {
    const batch = await this.prisma.kbIngestBatch.findFirst({ where: { id, userId } });
    if (!batch) return null;
    if (FINISHED_BATCH_STATUSES.includes(batch.status as KbIngestBatchStatus)) return this.get(userId, id);

    const now = new Date();
    await this.prisma.kbIngestBatchItem.updateMany({ where: { batchId: id, state: 'queued' }, data: { state: 'cancelled', reason: 'cancelled', finishedAt: now } });
    const running = await this.prisma.kbIngestBatchItem.count({ where: { batchId: id, state: 'running' } });
    await this.prisma.kbIngestBatch.update({
      where: { id },
      data: {
        cancelRequestedAt: batch.cancelRequestedAt ?? now,
        version: { increment: 1 },
        ...(running === 0 ? { status: 'cancelled', pauseReason: null, finishedAt: now } : {}),
      },
    });
    return this.get(userId, id);
  }

  /** Puts the failed files of a finished (or paused) batch back in the queue with a fresh count of attempts. */
  async retryFailed(userId: string, id: string): Promise<KbIngestBatchView | null> {
    const batch = await this.prisma.kbIngestBatch.findFirst({ where: { id, userId } });
    if (!batch) return null;
    if (batch.status !== 'paused' && batch.status !== 'completed_with_errors' && batch.status !== 'failed') {
      throw new ConflictException('Only a finished or paused batch can have its failed files retried.');
    }
    const retried = await this.prisma.kbIngestBatchItem.updateMany({
      where: { batchId: id, state: 'failed' },
      data: { state: 'queued', attempts: 0, errorKind: null, reason: null, nextAttemptAt: null, leaseUntil: null, startedAt: null, finishedAt: null },
    });
    if (retried.count === 0) throw new ConflictException('There is nothing to retry: no file in this batch failed.');
    await this.prisma.kbIngestBatch.update({
      where: { id },
      // Built again at the end of the retry: what the retried files add is not in the rubric yet.
      data: { status: 'queued', pauseReason: null, finishedAt: null, profileScheduledAt: null, version: { increment: 1 } },
    });
    return this.get(userId, id);
  }

  /**
   * Continues every batch that paused for `reason` (whoever owns it), e.g. all that waited for a fresh SharePoint token once
   * someone replaced it: the token is shared, so one reconnect unblocks all of them. Returns how many it resumed.
   */
  async resumePausedBy(reason: string): Promise<number> {
    const paused = await this.prisma.kbIngestBatch.findMany({ where: { status: 'paused', pauseReason: reason }, select: { id: true } });
    if (paused.length === 0) return 0;
    const resumed = await this.prisma.kbIngestBatch.updateMany({
      where: { id: { in: paused.map((b) => b.id) }, status: 'paused' },
      data: { status: 'queued', pauseReason: null, version: { increment: 1 } },
    });
    return resumed.count;
  }

  /** Continues a paused batch (the runner also does this by itself once the reason, such as an expired token, is fixed). */
  async resume(userId: string, id: string): Promise<KbIngestBatchView | null> {
    const batch = await this.prisma.kbIngestBatch.findFirst({ where: { id, userId } });
    if (!batch) return null;
    if (batch.status !== 'paused') throw new ConflictException('Only a paused batch can be resumed.');
    await this.prisma.kbIngestBatch.update({ where: { id }, data: { status: 'queued', pauseReason: null, version: { increment: 1 } } });
    return this.get(userId, id);
  }
}
