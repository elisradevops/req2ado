import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  KB_INGEST_MAX_ACTIVE_BATCHES,
  KB_INGEST_MAX_FILE_BYTES,
  KB_INGEST_MAX_ITEMS,
  KbIngestBatchService,
} from '../src/modules/kb/kb-ingest-batch.service';
import { makeKbIngestPrismaFake, type KbIngestPrismaFake } from './helpers/kbIngestPrismaFake';

const USER = 'user-1';
const OTHER_USER = 'user-2';

function item(n: number, overrides: Record<string, unknown> = {}) {
  return { itemId: `item-${n}`, name: `file${n}.docx`, relativePath: `Sub/file${n}.docx`, sizeBytes: 1000 + n, retrievalMode: 'retrieve', ...overrides };
}

function body(items: unknown[], overrides: Record<string, unknown> = {}) {
  return { driveId: 'drive-1', folderItemId: 'folder-1', folderPath: 'Sub', docType: null, items, ...overrides };
}

describe('KbIngestBatchService', () => {
  let prisma: KbIngestPrismaFake;
  let service: KbIngestBatchService;

  beforeEach(() => {
    prisma = makeKbIngestPrismaFake();
    service = new KbIngestBatchService(prisma as any);
  });

  describe('create()', () => {
    it('stores the batch and every file as queued, in the order given', async () => {
      const view = await service.create(USER, body([item(1), item(2, { retrievalMode: 'always_include' }), item(3)]));

      expect(view.status).toBe('queued');
      expect(view.counts).toEqual({ total: 3, queued: 3, running: 0, added: 0, unchanged: 0, failed: 0, skipped: 0, cancelled: 0 });
      expect(view.items!.map((i) => [i.ordinal, i.name, i.state, i.retrievalMode])).toEqual([
        [0, 'file1.docx', 'queued', 'retrieve'],
        [1, 'file2.docx', 'queued', 'always_include'],
        [2, 'file3.docx', 'queued', 'retrieve'],
      ]);
      expect(prisma.batches()[0]).toMatchObject({ userId: USER, driveId: 'drive-1', folderItemId: 'folder-1', folderPath: 'Sub', status: 'queued' });
      expect(prisma.items().every((row) => row.driveId === 'drive-1')).toBe(true);
    });

    it('collapses a file listed twice in one request', async () => {
      const view = await service.create(USER, body([item(1), item(1, { retrievalMode: 'always_include' }), item(2)]));

      expect(view.counts.total).toBe(2);
      expect(view.items!.find((i) => i.itemId === 'item-1')!.retrievalMode).toBe('retrieve');
    });

    it.each([
      ['no files', body([])],
      ['a missing drive id', body([item(1)], { driveId: '' })],
      ['a file without an id', body([item(1, { itemId: '' })])],
      ['a file without a name', body([item(1, { name: '' })])],
      ['an unknown mode', body([item(1, { retrievalMode: 'everything' })])],
      ['a negative size', body([item(1, { sizeBytes: -1 })])],
      ['a non-numeric size', body([item(1, { sizeBytes: '10' })])],
      ['a body that is not an object', 'nope'],
      ['no items array', { driveId: 'd', folderPath: '' }],
    ])('rejects %s', async (_label, input) => {
      await expect(service.create(USER, input)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.batches()).toHaveLength(0);
    });

    it('rejects more files than one batch may hold', async () => {
      const tooMany = Array.from({ length: KB_INGEST_MAX_ITEMS + 1 }, (_, n) => item(n));

      await expect(service.create(USER, body(tooMany))).rejects.toThrow(/200/);
    });

    it('accepts exactly the maximum', async () => {
      const max = Array.from({ length: KB_INGEST_MAX_ITEMS }, (_, n) => item(n));

      const view = await service.create(USER, body(max));

      expect(view.counts.total).toBe(KB_INGEST_MAX_ITEMS);
    });

    it('rejects a file over the size limit up front, naming it, and queues nothing', async () => {
      const big = item(2, { name: 'huge.pdf', sizeBytes: KB_INGEST_MAX_FILE_BYTES + 1 });

      await expect(service.create(USER, body([item(1), big]))).rejects.toThrow(/huge\.pdf/);
      expect(prisma.batches()).toHaveLength(0);
    });

    it('accepts a file of exactly the size limit', async () => {
      const view = await service.create(USER, body([item(1, { sizeBytes: KB_INGEST_MAX_FILE_BYTES })]));

      expect(view.counts.queued).toBe(1);
    });

    it('allows a few active batches and refuses another', async () => {
      for (let n = 0; n < KB_INGEST_MAX_ACTIVE_BATCHES; n++) await service.create(USER, body([item(100 + n)]));

      await expect(service.create(USER, body([item(200)]))).rejects.toBeInstanceOf(ConflictException);
    });

    it('does not count finished batches, or another user\'s, against the limit', async () => {
      prisma = makeKbIngestPrismaFake({
        batches: [
          { id: 'b1', userId: USER, status: 'completed', driveId: 'd', folderPath: '' },
          { id: 'b2', userId: USER, status: 'cancelled', driveId: 'd', folderPath: '' },
          { id: 'b3', userId: OTHER_USER, status: 'running', driveId: 'd', folderPath: '' },
          { id: 'b4', userId: OTHER_USER, status: 'running', driveId: 'd', folderPath: '' },
          { id: 'b5', userId: OTHER_USER, status: 'running', driveId: 'd', folderPath: '' },
        ],
      });
      service = new KbIngestBatchService(prisma as any);

      const view = await service.create(USER, body([item(1)]));

      expect(view.status).toBe('queued');
    });

    it('creates a file already waiting in another of the user\'s batches as skipped, not twice', async () => {
      await service.create(USER, body([item(1)]));

      const second = await service.create(USER, body([item(1), item(2)]));

      expect(second.items!.find((i) => i.itemId === 'item-1')).toMatchObject({ state: 'skipped', reason: 'already queued in another batch' });
      expect(second.items!.find((i) => i.itemId === 'item-2')!.state).toBe('queued');
    });

    it('does not treat another user\'s queued file as a duplicate', async () => {
      await service.create(OTHER_USER, body([item(1)]));

      const view = await service.create(USER, body([item(1)]));

      expect(view.items![0].state).toBe('queued');
    });

    it('a file that finished in an earlier batch can be added again', async () => {
      prisma = makeKbIngestPrismaFake({
        batches: [{ id: 'old', userId: USER, status: 'completed', driveId: 'd', folderPath: '' }],
        items: [{ id: 'old-1', batchId: 'old', ordinal: 0, driveId: 'd', itemId: 'item-1', name: 'a', relativePath: 'a', sizeBytes: 1, retrievalMode: 'retrieve', state: 'added' }],
      });
      service = new KbIngestBatchService(prisma as any);

      const view = await service.create(USER, body([item(1)]));

      expect(view.items![0].state).toBe('queued');
    });

    it('a batch whose every file is skipped is finished at once', async () => {
      await service.create(USER, body([item(1)]));

      const second = await service.create(USER, body([item(1)]));

      expect(second.status).toBe('completed');
      expect(second.finishedAt).not.toBeNull();
    });
  });

  describe('get() and list()', () => {
    it('get() returns the batch with its files, only for its owner', async () => {
      const created = await service.create(USER, body([item(1), item(2)]));

      expect((await service.get(USER, created.id))!.items).toHaveLength(2);
      expect(await service.get(OTHER_USER, created.id)).toBeNull();
      expect(await service.get(USER, 'missing')).toBeNull();
    });

    it('list() returns the user\'s own batches, newest first, with counts and no file rows', async () => {
      const first = await service.create(USER, body([item(1)]));
      prisma.setNow(new Date('2026-11-12T10:00:00.000Z'));
      const second = await service.create(USER, body([item(2), item(3)]));
      await service.create(OTHER_USER, body([item(9)]));

      const batches = await service.list(USER, {});

      expect(batches.map((b) => b.id)).toEqual([second.id, first.id]);
      expect(batches[0].counts.total).toBe(2);
      expect(batches[0].items).toBeUndefined();
    });

    it('list({ active: true }) leaves out finished batches', async () => {
      await service.create(USER, body([item(1)]));
      const done = await service.create(USER, body([item(1)])); // all skipped -> completed
      expect(done.status).toBe('completed');

      const active = await service.list(USER, { active: true });

      expect(active).toHaveLength(1);
      expect(active[0].status).toBe('queued');
    });

    it('list() caps the number returned', async () => {
      for (let n = 0; n < 3; n++) await service.create(USER, body([item(n)]));

      expect(await service.list(USER, { limit: 2 })).toHaveLength(2);
    });
  });

  describe('cancel()', () => {
    it('cancels the waiting files at once and finishes a batch with nothing running', async () => {
      const created = await service.create(USER, body([item(1), item(2)]));

      const view = (await service.cancel(USER, created.id))!;

      expect(view.status).toBe('cancelled');
      expect(view.counts.cancelled).toBe(2);
      expect(view.finishedAt).not.toBeNull();
      expect(view.version).toBeGreaterThan(created.version);
    });

    it('lets the file in flight finish: the batch stays running until it does', async () => {
      const created = await service.create(USER, body([item(1), item(2)]));
      const [first] = prisma.items();
      await prisma.kbIngestBatchItem.update({ where: { id: first.id }, data: { state: 'running' } });
      await prisma.kbIngestBatch.update({ where: { id: created.id }, data: { status: 'running' } });

      const view = (await service.cancel(USER, created.id))!;

      expect(view.status).toBe('running');
      expect(view.cancelRequested).toBe(true);
      expect(view.counts).toMatchObject({ running: 1, cancelled: 1 });
    });

    it('is a no-op on a finished batch and for someone else\'s batch', async () => {
      const created = await service.create(USER, body([item(1)]));
      await service.cancel(USER, created.id);

      expect((await service.cancel(USER, created.id))!.status).toBe('cancelled');
      expect(await service.cancel(OTHER_USER, created.id)).toBeNull();
    });
  });

  describe('retryFailed()', () => {
    async function finishedWithFailure() {
      const created = await service.create(USER, body([item(1), item(2)]));
      const [first, second] = prisma.items();
      await prisma.kbIngestBatchItem.update({ where: { id: first.id }, data: { state: 'added' } });
      await prisma.kbIngestBatchItem.update({
        where: { id: second.id },
        data: { state: 'failed', attempts: 3, errorKind: 'transient', reason: 'timeout', finishedAt: new Date() },
      });
      await prisma.kbIngestBatch.update({ where: { id: created.id }, data: { status: 'completed_with_errors', finishedAt: new Date(), profileScheduledAt: new Date() } });
      return created.id;
    }

    it('puts failed files back in the queue with a fresh count of attempts, and reopens the batch', async () => {
      const id = await finishedWithFailure();

      const view = (await service.retryFailed(USER, id))!;

      expect(view.status).toBe('queued');
      expect(view.finishedAt).toBeNull();
      expect(view.counts).toMatchObject({ queued: 1, added: 1, failed: 0 });
      const retried = prisma.items().find((row) => row.itemId === 'item-2')!;
      expect(retried).toMatchObject({ state: 'queued', attempts: 0, errorKind: null, reason: null, finishedAt: null });
      // The profile is built again at the end of the retry.
      expect(prisma.batches()[0].profileScheduledAt).toBeNull();
    });

    it('refuses a batch that is still working', async () => {
      const created = await service.create(USER, body([item(1)]));

      await expect(service.retryFailed(USER, created.id)).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses when nothing failed', async () => {
      const created = await service.create(USER, body([item(1)]));
      await prisma.kbIngestBatch.update({ where: { id: created.id }, data: { status: 'paused', pauseReason: 'sharepoint_token' } });

      await expect(service.retryFailed(USER, created.id)).rejects.toThrow(/nothing to retry/i);
    });

    it('refuses a batch that finished without a failure', async () => {
      const created = await service.create(USER, body([item(1)]));
      await prisma.kbIngestBatchItem.updateMany({ where: {}, data: { state: 'added' } });
      await prisma.kbIngestBatch.update({ where: { id: created.id }, data: { status: 'completed' } });

      await expect(service.retryFailed(USER, created.id)).rejects.toBeInstanceOf(ConflictException);
    });

    it('is 404 for someone else\'s batch', async () => {
      const id = await finishedWithFailure();

      expect(await service.retryFailed(OTHER_USER, id)).toBeNull();
    });
  });

  describe('resumePausedBy()', () => {
    it('continues every batch paused for that reason, whoever owns it, and leaves the others', async () => {
      prisma = makeKbIngestPrismaFake({
        batches: [
          { id: 'a', userId: USER, status: 'paused', pauseReason: 'sharepoint_token', driveId: 'd', folderPath: '' },
          { id: 'b', userId: OTHER_USER, status: 'paused', pauseReason: 'sharepoint_token', driveId: 'd', folderPath: '' },
          { id: 'c', userId: USER, status: 'paused', pauseReason: 'something_else', driveId: 'd', folderPath: '' },
          { id: 'd', userId: USER, status: 'running', driveId: 'd', folderPath: '' },
        ],
      });
      service = new KbIngestBatchService(prisma as any);

      expect(await service.resumePausedBy('sharepoint_token')).toBe(2);

      const byId = Object.fromEntries(prisma.batches().map((row) => [row.id, row]));
      expect(byId.a).toMatchObject({ status: 'queued', pauseReason: null });
      expect(byId.b).toMatchObject({ status: 'queued', pauseReason: null });
      expect(byId.c).toMatchObject({ status: 'paused', pauseReason: 'something_else' });
      expect(byId.d.status).toBe('running');
      expect(byId.a.version).toBeGreaterThan(0);
    });

    it('returns 0 when nothing is paused for it', async () => {
      expect(await service.resumePausedBy('sharepoint_token')).toBe(0);
    });
  });

  describe('resume()', () => {
    it('continues a paused batch and clears why it paused', async () => {
      const created = await service.create(USER, body([item(1)]));
      await prisma.kbIngestBatch.update({ where: { id: created.id }, data: { status: 'paused', pauseReason: 'sharepoint_token' } });

      const view = (await service.resume(USER, created.id))!;

      expect(view.status).toBe('queued');
      expect(view.pauseReason).toBeNull();
    });

    it('refuses a batch that is not paused', async () => {
      const created = await service.create(USER, body([item(1)]));

      await expect(service.resume(USER, created.id)).rejects.toBeInstanceOf(ConflictException);
    });

    it('is 404 for someone else\'s batch', async () => {
      const created = await service.create(USER, body([item(1)]));
      await prisma.kbIngestBatch.update({ where: { id: created.id }, data: { status: 'paused' } });

      expect(await service.resume(OTHER_USER, created.id)).toBeNull();
    });
  });
});
