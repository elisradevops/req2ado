import { KbIngestRunner } from '../src/modules/kb/kb-ingest-runner';
import { KbIngestBatchService } from '../src/modules/kb/kb-ingest-batch.service';
import { IngestionHttpError } from '../src/modules/pipeline/ingestion-http.client';
import { makeKbIngestPrismaFake, type KbIngestPrismaFake } from './helpers/kbIngestPrismaFake';

const T0 = new Date('2026-11-12T09:00:00.000Z');
const BACKOFF = [100, 200, 400];

function ingestResult(overrides: Record<string, unknown> = {}) {
  return { documentName: 'f', driveitemId: 'x', mimeType: null, sizeBytes: 1, chunksStored: 3, chunksInStore: 3, skippedUnchanged: false, ingestedDocumentId: 'doc-1', ...overrides };
}

function batchRow(id: string, userId: string, overrides: Record<string, unknown> = {}) {
  return { id, userId, driveId: 'drive-1', folderPath: 'Sub', status: 'queued', createdAt: T0, ...overrides };
}

function itemRow(batchId: string, ordinal: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `${batchId}-i${ordinal}`,
    batchId,
    ordinal,
    driveId: 'drive-1',
    itemId: `${batchId}-item${ordinal}`,
    name: `file${ordinal}.docx`,
    relativePath: `Sub/file${ordinal}.docx`,
    sizeBytes: 100,
    retrievalMode: 'retrieve',
    state: 'queued',
    ...overrides,
  };
}

describe('KbIngestRunner', () => {
  let prisma: KbIngestPrismaFake;
  let kb: { ingestDriveItem: jest.Mock };
  let scheduler: { schedule: jest.Mock };
  let clock: Date;
  let runner: KbIngestRunner;

  function build(initial: { batches?: any[]; items?: any[] }) {
    prisma = makeKbIngestPrismaFake(initial);
    kb = { ingestDriveItem: jest.fn().mockResolvedValue(ingestResult()) };
    scheduler = { schedule: jest.fn().mockResolvedValue(undefined) };
    clock = new Date(T0);
    runner = new KbIngestRunner(prisma as any, kb as any, scheduler as any, { itemTimeoutMs: 60_000, maxAttempts: 3, backoffMs: BACKOFF, now: () => clock });
  }

  const item = (id: string) => prisma.items().find((row) => row.id === id)!;
  const batch = (id: string) => prisma.batches().find((row) => row.id === id)!;
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };

  describe('the happy path', () => {
    it('ingests the next waiting file and records what happened', async () => {
      build({ batches: [batchRow('b1', 'u1', { docType: 'SRD' })], items: [itemRow('b1', 0, { retrievalMode: 'always_include' })] });
      kb.ingestDriveItem.mockResolvedValue(ingestResult({ chunksStored: 4, chunksInStore: 4, ingestedDocumentId: 'doc-9' }));

      expect(await runner.pumpOnce()).toBe(true);

      expect(kb.ingestDriveItem).toHaveBeenCalledWith({
        userId: 'u1',
        driveId: 'drive-1',
        itemId: 'b1-item0',
        relativePath: 'Sub/file0.docx',
        docType: 'SRD',
        retrievalMode: 'always_include',
        scheduleProfile: false,
        signal: expect.any(AbortSignal),
      });
      expect(item('b1-i0')).toMatchObject({ state: 'added', chunksStored: 4, chunksInStore: 4, ingestedDocumentId: 'doc-9', attempts: 1, leaseUntil: null, errorKind: null });
      expect(item('b1-i0').finishedAt).toEqual(clock);
    });

    it('does nothing when no file is waiting', async () => {
      build({ batches: [batchRow('b1', 'u1', { status: 'completed' })], items: [itemRow('b1', 0, { state: 'added' })] });

      expect(await runner.pumpOnce()).toBe(false);
      expect(kb.ingestDriveItem).not.toHaveBeenCalled();
    });

    it('takes the files of a batch in order, one per call, and finishes the batch after the last', async () => {
      build({ batches: [batchRow('b1', 'u1')], items: [itemRow('b1', 1), itemRow('b1', 0), itemRow('b1', 2)] });

      await runner.pumpOnce();
      expect(kb.ingestDriveItem.mock.calls.map((c) => c[0].itemId)).toEqual(['b1-item0']);
      expect(batch('b1')).toMatchObject({ status: 'running' });
      expect(batch('b1').startedAt).toEqual(clock);

      await runner.pumpOnce();
      await runner.pumpOnce();

      expect(kb.ingestDriveItem.mock.calls.map((c) => c[0].itemId)).toEqual(['b1-item0', 'b1-item1', 'b1-item2']);
      expect(batch('b1')).toMatchObject({ status: 'completed' });
      expect(batch('b1').finishedAt).toEqual(clock);
    });

    it('bumps the batch version as it moves, so a client can tell something changed', async () => {
      build({ batches: [batchRow('b1', 'u1')], items: [itemRow('b1', 0)] });

      await runner.pumpOnce();

      expect(batch('b1').version).toBeGreaterThan(0);
    });

    it('reports an unchanged file as unchanged', async () => {
      build({ batches: [batchRow('b1', 'u1')], items: [itemRow('b1', 0)] });
      kb.ingestDriveItem.mockResolvedValue(ingestResult({ skippedUnchanged: true, chunksStored: 0, chunksInStore: 7 }));

      await runner.pumpOnce();

      expect(item('b1-i0')).toMatchObject({ state: 'unchanged', chunksInStore: 7 });
    });

    it('keeps a file that stored no text as added, with the reason, so the report can warn about it', async () => {
      build({ batches: [batchRow('b1', 'u1')], items: [itemRow('b1', 0)] });
      kb.ingestDriveItem.mockResolvedValue(ingestResult({ chunksStored: 0, chunksInStore: 0 }));

      await runner.pumpOnce();

      expect(item('b1-i0')).toMatchObject({ state: 'added', reason: expect.stringMatching(/no text/i) });
    });
  });

  describe('the profile build', () => {
    it('is requested once, when the batch is done and something was added, not after every file', async () => {
      build({ batches: [batchRow('b1', 'u1')], items: [itemRow('b1', 0), itemRow('b1', 1)] });

      await runner.pumpOnce();
      expect(scheduler.schedule).not.toHaveBeenCalled();
      await runner.pumpOnce();

      expect(scheduler.schedule).toHaveBeenCalledTimes(1);
      expect(scheduler.schedule).toHaveBeenCalledWith('u1');
      expect(batch('b1').profileScheduledAt).toEqual(clock);
    });

    it('is not requested when nothing was added', async () => {
      build({ batches: [batchRow('b1', 'u1')], items: [itemRow('b1', 0)] });
      kb.ingestDriveItem.mockResolvedValue(ingestResult({ skippedUnchanged: true }));

      await runner.pumpOnce();

      expect(scheduler.schedule).not.toHaveBeenCalled();
    });

    it('failing to request it does not fail the batch', async () => {
      build({ batches: [batchRow('b1', 'u1')], items: [itemRow('b1', 0)] });
      scheduler.schedule.mockRejectedValue(new Error('redis down'));

      await runner.pumpOnce();

      expect(batch('b1').status).toBe('completed');
      expect(batch('b1').profileScheduledAt).toBeNull();
    });

    it('is requested again after a retry, because the service clears when it was last requested', async () => {
      build({ batches: [batchRow('b1', 'u1')], items: [itemRow('b1', 0)] });
      kb.ingestDriveItem.mockRejectedValueOnce(new IngestionHttpError(400, 'unsupported'));
      await runner.pumpOnce();
      expect(batch('b1').status).toBe('failed');

      await new KbIngestBatchService(prisma as any).retryFailed('u1', 'b1');
      await runner.pumpOnce();

      expect(scheduler.schedule).toHaveBeenCalledTimes(1);
    });
  });

  describe('failures', () => {
    it('one failed file does not stop the rest, and the batch ends with errors', async () => {
      build({ batches: [batchRow('b1', 'u1')], items: [itemRow('b1', 0), itemRow('b1', 1)] });
      kb.ingestDriveItem.mockRejectedValueOnce(new IngestionHttpError(400, 'unsupported file type')).mockResolvedValueOnce(ingestResult());

      await runner.pumpOnce();
      await runner.pumpOnce();

      expect(item('b1-i0')).toMatchObject({ state: 'failed', errorKind: 'permanent', reason: 'unsupported file type' });
      expect(item('b1-i1').state).toBe('added');
      expect(batch('b1').status).toBe('completed_with_errors');
    });

    it('a batch where every file failed is failed', async () => {
      build({ batches: [batchRow('b1', 'u1')], items: [itemRow('b1', 0)] });
      kb.ingestDriveItem.mockRejectedValue(new IngestionHttpError(404, 'gone'));

      await runner.pumpOnce();

      expect(batch('b1').status).toBe('failed');
    });

    it.each([
      [400, /unsupported/],
      [404, /not found|moved or deleted/i],
      [403, /permission/i],
      [418, /./],
    ])('a %s from ingestion fails the file at once, without a retry', async (status, reason) => {
      build({ batches: [batchRow('b1', 'u1')], items: [itemRow('b1', 0)] });
      kb.ingestDriveItem.mockRejectedValue(new IngestionHttpError(status, 'unsupported file type'));

      await runner.pumpOnce();

      expect(item('b1-i0')).toMatchObject({ state: 'failed', errorKind: 'permanent', attempts: 1 });
      expect(item('b1-i0').reason).toMatch(reason);
    });

    it.each([
      ['a 502', () => new IngestionHttpError(502, 'bad gateway')],
      ['a 500', () => new IngestionHttpError(500, 'boom')],
      ['a 429', () => new IngestionHttpError(429, 'slow down')],
      ['a network failure', () => new TypeError('fetch failed')],
      ['a timeout', () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })],
    ])('%s is retried later, not failed', async (_label, makeError) => {
      build({ batches: [batchRow('b1', 'u1')], items: [itemRow('b1', 0)] });
      kb.ingestDriveItem.mockRejectedValue(makeError());

      await runner.pumpOnce();

      expect(item('b1-i0')).toMatchObject({ state: 'queued', errorKind: 'transient', attempts: 1 });
      expect(item('b1-i0').nextAttemptAt).toEqual(new Date(T0.getTime() + BACKOFF[0]));
      expect(batch('b1').status).toBe('running');
    });

    it('does not retry a file before its backoff has passed, then does, with a longer wait each time', async () => {
      build({ batches: [batchRow('b1', 'u1')], items: [itemRow('b1', 0)] });
      kb.ingestDriveItem.mockRejectedValue(new IngestionHttpError(502, 'bad gateway'));

      await runner.pumpOnce(); // attempt 1 fails, retry in 100 ms
      expect(await runner.pumpOnce()).toBe(false);
      expect(kb.ingestDriveItem).toHaveBeenCalledTimes(1);

      advance(BACKOFF[0]);
      await runner.pumpOnce(); // attempt 2 fails, retry in 200 ms
      expect(item('b1-i0').nextAttemptAt).toEqual(new Date(clock.getTime() + BACKOFF[1]));
      advance(BACKOFF[1] - 1);
      expect(await runner.pumpOnce()).toBe(false);
      advance(1);
      await runner.pumpOnce(); // attempt 3 fails: out of attempts

      expect(kb.ingestDriveItem).toHaveBeenCalledTimes(3);
      expect(item('b1-i0')).toMatchObject({ state: 'failed', errorKind: 'transient', attempts: 3 });
      expect(batch('b1').status).toBe('failed');
    });

    it('a retry that succeeds ends the file as added and clears the error', async () => {
      build({ batches: [batchRow('b1', 'u1')], items: [itemRow('b1', 0)] });
      kb.ingestDriveItem.mockRejectedValueOnce(new IngestionHttpError(502, 'bad gateway')).mockResolvedValueOnce(ingestResult());

      await runner.pumpOnce();
      advance(BACKOFF[0]);
      await runner.pumpOnce();

      expect(item('b1-i0')).toMatchObject({ state: 'added', errorKind: null, reason: null, nextAttemptAt: null });
    });

    it('keeps an ingestion error message short and never stores more than a line of it', async () => {
      build({ batches: [batchRow('b1', 'u1')], items: [itemRow('b1', 0)] });
      kb.ingestDriveItem.mockRejectedValue(new IngestionHttpError(400, `bad ${'x'.repeat(2000)}`));

      await runner.pumpOnce();

      expect(item('b1-i0').reason.length).toBeLessThanOrEqual(300);
    });
  });

  describe('an expired SharePoint token', () => {
    it.each([401, 424])('a %s pauses the whole batch and puts the file back without using an attempt', async (status) => {
      build({ batches: [batchRow('b1', 'u1')], items: [itemRow('b1', 0), itemRow('b1', 1)] });
      kb.ingestDriveItem.mockRejectedValue(new IngestionHttpError(status, 'token expired'));

      await runner.pumpOnce();

      expect(batch('b1')).toMatchObject({ status: 'paused', pauseReason: 'sharepoint_token' });
      expect(item('b1-i0')).toMatchObject({ state: 'queued', attempts: 0 });
      expect(item('b1-i1').state).toBe('queued');
    });

    it('does nothing for a paused batch, and carries on when it is resumed', async () => {
      build({ batches: [batchRow('b1', 'u1')], items: [itemRow('b1', 0)] });
      kb.ingestDriveItem.mockRejectedValueOnce(new IngestionHttpError(401, 'token expired'));
      await runner.pumpOnce();

      expect(await runner.pumpOnce()).toBe(false);
      expect(kb.ingestDriveItem).toHaveBeenCalledTimes(1);

      await new KbIngestBatchService(prisma as any).resume('u1', 'b1');
      await runner.pumpOnce();

      expect(item('b1-i0').state).toBe('added');
      expect(batch('b1').status).toBe('completed');
    });

    it('only the batch whose file hit it is paused: another user\'s batch carries on (the token is read fresh for each file)', async () => {
      build({ batches: [batchRow('b1', 'u1'), batchRow('b2', 'u2', { createdAt: new Date(T0.getTime() + 1) })], items: [itemRow('b1', 0), itemRow('b2', 0)] });
      kb.ingestDriveItem.mockRejectedValueOnce(new IngestionHttpError(401, 'token expired')).mockResolvedValue(ingestResult());

      await runner.pumpOnce(); // u1's file: pauses b1
      await runner.pumpOnce(); // u2's file

      expect(batch('b1').status).toBe('paused');
      expect(item('b2-i0').state).toBe('added');
    });
  });

  describe('cancelling', () => {
    it('does not start a file of a batch whose cancellation was requested', async () => {
      build({ batches: [batchRow('b1', 'u1', { status: 'running', cancelRequestedAt: T0 })], items: [itemRow('b1', 0)] });

      expect(await runner.pumpOnce()).toBe(false);
      expect(kb.ingestDriveItem).not.toHaveBeenCalled();
    });

    it('finishes the batch as cancelled when the file that was running completes', async () => {
      build({ batches: [batchRow('b1', 'u1')], items: [itemRow('b1', 0), itemRow('b1', 1)] });
      let release!: (value: unknown) => void;
      kb.ingestDriveItem.mockReturnValue(new Promise((resolve) => (release = resolve)));

      const running = runner.pumpOnce();
      await new Promise((resolve) => setImmediate(resolve));
      await new KbIngestBatchService(prisma as any).cancel('u1', 'b1'); // the file in flight is left alone, the waiting one is cancelled
      release(ingestResult());
      await running;

      expect(item('b1-i0').state).toBe('added');
      expect(item('b1-i1').state).toBe('cancelled');
      expect(batch('b1').status).toBe('cancelled');
      expect(scheduler.schedule).toHaveBeenCalledWith('u1'); // what was added still counts
    });
  });

  describe('fairness and exclusion', () => {
    it('alternates between users instead of finishing one user\'s batch first', async () => {
      build({
        batches: [batchRow('b1', 'u1'), batchRow('b2', 'u2', { createdAt: new Date(T0.getTime() + 1) })],
        items: [itemRow('b1', 0), itemRow('b1', 1), itemRow('b2', 0), itemRow('b2', 1)],
      });

      for (let n = 0; n < 4; n++) await runner.pumpOnce();

      expect(kb.ingestDriveItem.mock.calls.map((c) => c[0].userId)).toEqual(['u1', 'u2', 'u1', 'u2']);
    });

    it('takes a user\'s older batch before their newer one', async () => {
      build({
        batches: [batchRow('newer', 'u1', { createdAt: new Date(T0.getTime() + 5000) }), batchRow('older', 'u1')],
        items: [itemRow('newer', 0), itemRow('older', 0)],
      });

      await runner.pumpOnce();

      expect(kb.ingestDriveItem.mock.calls[0][0].itemId).toBe('older-item0');
    });

    it('does not run a file when another runner claimed it first', async () => {
      build({ batches: [batchRow('b1', 'u1')], items: [itemRow('b1', 0)] });
      jest.spyOn(prisma.kbIngestBatchItem, 'updateMany').mockResolvedValueOnce({ count: 0 });

      await runner.pumpOnce();

      expect(kb.ingestDriveItem).not.toHaveBeenCalled();
    });

    it('never runs two files at once: a second call while one is in flight returns at once', async () => {
      build({ batches: [batchRow('b1', 'u1')], items: [itemRow('b1', 0), itemRow('b1', 1)] });
      let release!: (value: unknown) => void;
      kb.ingestDriveItem.mockReturnValue(new Promise((resolve) => (release = resolve)));

      const first = runner.pumpOnce();
      await new Promise((resolve) => setImmediate(resolve));
      const second = await runner.pumpOnce();
      release(ingestResult());
      await first;

      expect(second).toBe(false);
      expect(kb.ingestDriveItem).toHaveBeenCalledTimes(1);
    });
  });

  describe('recovery', () => {
    it('after a restart, puts a file that was running back in the queue', async () => {
      build({ batches: [batchRow('b1', 'u1', { status: 'running' })], items: [itemRow('b1', 0, { state: 'running', attempts: 1, leaseUntil: new Date(T0.getTime() + 60_000) })] });

      await runner.recoverOrphans();

      expect(item('b1-i0')).toMatchObject({ state: 'queued', leaseUntil: null, attempts: 1 });
      await runner.pumpOnce();
      expect(item('b1-i0').state).toBe('added');
    });

    it('takes back a file whose lease ran out, and fails it when it has used all its attempts', async () => {
      build({
        batches: [batchRow('b1', 'u1', { status: 'running' })],
        items: [
          itemRow('b1', 0, { state: 'running', attempts: 1, leaseUntil: new Date(T0.getTime() - 1) }),
          itemRow('b1', 1, { state: 'running', attempts: 3, leaseUntil: new Date(T0.getTime() - 1) }),
        ],
      });

      await runner.reclaimExpiredLeases();

      expect(item('b1-i0')).toMatchObject({ state: 'queued', leaseUntil: null });
      expect(item('b1-i1')).toMatchObject({ state: 'failed', errorKind: 'transient' });
      expect(item('b1-i1').reason).toMatch(/timed out|did not finish/i);
    });

    it('leaves a running file whose lease has not run out', async () => {
      build({ batches: [batchRow('b1', 'u1', { status: 'running' })], items: [itemRow('b1', 0, { state: 'running', attempts: 1, leaseUntil: new Date(T0.getTime() + 1000) })] });

      await runner.reclaimExpiredLeases();

      expect(item('b1-i0').state).toBe('running');
    });

    it('finishes a batch whose last file was reclaimed as failed', async () => {
      build({ batches: [batchRow('b1', 'u1', { status: 'running' })], items: [itemRow('b1', 0, { state: 'running', attempts: 3, leaseUntil: new Date(T0.getTime() - 1) })] });

      await runner.reclaimExpiredLeases();

      expect(batch('b1').status).toBe('failed');
    });
  });
});
