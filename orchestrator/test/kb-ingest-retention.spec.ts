import { KbIngestRetentionService } from '../src/modules/kb/kb-ingest-retention.service';

describe('KbIngestRetentionService', () => {
  const DAY = 24 * 60 * 60_000;
  const NOW = new Date('2026-11-12T09:00:00.000Z');

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  it('sweeps finished batches older than the retention period', async () => {
    const batches = { deleteFinishedBefore: jest.fn().mockResolvedValue(3) };
    const service = new KbIngestRetentionService(batches as any, 6 * 60 * 60_000, 30 * DAY);

    await service.sweep();

    expect(batches.deleteFinishedBefore).toHaveBeenCalledWith(new Date(NOW.getTime() - 30 * DAY));
  });

  it('sweeps on every interval, and stops when destroyed', async () => {
    const batches = { deleteFinishedBefore: jest.fn().mockResolvedValue(0) };
    const service = new KbIngestRetentionService(batches as any, 1_000, 30 * DAY);
    service.onModuleInit();

    await jest.advanceTimersByTimeAsync(3_000);
    expect(batches.deleteFinishedBefore).toHaveBeenCalledTimes(3);

    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(batches.deleteFinishedBefore).toHaveBeenCalledTimes(3);
  });

  it('a failing sweep is retried on the next interval, never an unhandled rejection', async () => {
    const batches = { deleteFinishedBefore: jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(0) };
    const service = new KbIngestRetentionService(batches as any, 1_000, 30 * DAY);
    service.onModuleInit();

    await jest.advanceTimersByTimeAsync(2_000);

    expect(batches.deleteFinishedBefore).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });
});
