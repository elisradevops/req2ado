import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError } from 'axios';
import { useKbIngestStore } from './kbIngestStore';
import * as kbApi from '../api/kb';
import type { KbIngestBatch, KbIngestBatchStatus } from '../api/kb';

vi.mock('../api/kb');

function batch(overrides: Partial<KbIngestBatch> = {}): KbIngestBatch {
  return {
    id: 'b1',
    status: 'running',
    pauseReason: null,
    cancelRequested: false,
    driveId: 'drive-1',
    folderItemId: null,
    folderPath: '',
    docType: null,
    version: 1,
    createdAt: '2026-11-12T09:00:00Z',
    startedAt: null,
    finishedAt: null,
    counts: { total: 2, queued: 1, running: 1, added: 0, unchanged: 0, failed: 0, skipped: 0, cancelled: 0 },
    items: [],
    ...overrides,
  };
}

const withStatus = (status: KbIngestBatchStatus, version = 2) => batch({ status, version, finishedAt: ['running', 'queued', 'paused'].includes(status) ? null : '2026-11-12T09:05:00Z' });

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

const CREATE_INPUT = { driveId: 'drive-1', folderPath: '', items: [{ itemId: 'i1', name: 'a.pdf', relativePath: 'a.pdf', sizeBytes: 1, retrievalMode: 'retrieve' as const }] };

describe('kbIngestStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useKbIngestStore.getState().reset();
    setVisibility('visible');
  });
  afterEach(() => {
    useKbIngestStore.getState().stop();
    vi.useRealTimers();
  });

  describe('attach()', () => {
    it('picks up the batch the user already has running, so a reload does not lose it', async () => {
      vi.mocked(kbApi.listKbIngestBatches).mockResolvedValue([batch({ id: 'active', version: 4 })]);
      vi.mocked(kbApi.getKbIngestBatch).mockResolvedValue(batch({ id: 'active', version: 4 }));

      await useKbIngestStore.getState().attach('user-1');

      expect(kbApi.listKbIngestBatches).toHaveBeenCalledWith({ active: true, limit: 1 });
      expect(useKbIngestStore.getState().batch?.id).toBe('active');
    });

    it('fetches the batch with its files, since a list leaves them out', async () => {
      vi.mocked(kbApi.listKbIngestBatches).mockResolvedValue([batch({ id: 'active', items: undefined })]);
      vi.mocked(kbApi.getKbIngestBatch).mockResolvedValue(batch({ id: 'active', items: [{ id: 'x' } as any] }));

      await useKbIngestStore.getState().attach('user-1');

      expect(kbApi.getKbIngestBatch).toHaveBeenCalledWith('active');
      expect(useKbIngestStore.getState().batch?.items).toHaveLength(1);
    });

    it('shows nothing when nothing is running', async () => {
      vi.mocked(kbApi.listKbIngestBatches).mockResolvedValue([]);

      await useKbIngestStore.getState().attach('user-1');

      expect(useKbIngestStore.getState().batch).toBeNull();
    });

    it('keeps a finished batch the same user was looking at when they come back to the page', async () => {
      vi.mocked(kbApi.listKbIngestBatches).mockResolvedValue([]);
      useKbIngestStore.setState({ batch: withStatus('completed'), ownerId: 'user-1' });

      await useKbIngestStore.getState().attach('user-1');

      expect(useKbIngestStore.getState().batch?.status).toBe('completed');
    });

    it('never shows one user\'s batch to the next user who signs in', async () => {
      vi.mocked(kbApi.listKbIngestBatches).mockResolvedValue([]);
      useKbIngestStore.setState({ batch: withStatus('completed'), ownerId: 'user-1' });

      await useKbIngestStore.getState().attach('user-2');

      expect(useKbIngestStore.getState().batch).toBeNull();
    });

    it('a late answer does not replace a batch the user created while it was on its way', async () => {
      let answerList!: (value: KbIngestBatch[]) => void;
      vi.mocked(kbApi.listKbIngestBatches).mockReturnValue(new Promise((resolve) => (answerList = resolve)));
      vi.mocked(kbApi.getKbIngestBatch).mockResolvedValue(batch({ id: 'old' }));
      vi.mocked(kbApi.createKbIngestBatch).mockResolvedValue(batch({ id: 'new' }));

      const attaching = useKbIngestStore.getState().attach('user-1');
      await useKbIngestStore.getState().submit('user-1', CREATE_INPUT);
      answerList([batch({ id: 'old' })]);
      await attaching;

      expect(useKbIngestStore.getState().batch?.id).toBe('new');
    });

    it('a late answer does not bring back a batch the user dismissed while it was on its way', async () => {
      let answerList!: (value: KbIngestBatch[]) => void;
      vi.mocked(kbApi.listKbIngestBatches).mockReturnValue(new Promise((resolve) => (answerList = resolve)));
      vi.mocked(kbApi.getKbIngestBatch).mockResolvedValue(batch({ id: 'old' }));

      const attaching = useKbIngestStore.getState().attach('user-1');
      useKbIngestStore.getState().dismiss();
      answerList([batch({ id: 'old' })]);
      await attaching;

      expect(useKbIngestStore.getState().batch).toBeNull();
    });

    it('a failure to look is not an error the page has to handle: it just shows nothing', async () => {
      vi.mocked(kbApi.listKbIngestBatches).mockRejectedValue(new Error('network'));

      await expect(useKbIngestStore.getState().attach('user-1')).resolves.toBeUndefined();
    });
  });

  describe('submit()', () => {
    it('creates the batch, shows it, and follows it until it finishes', async () => {
      vi.mocked(kbApi.createKbIngestBatch).mockResolvedValue(batch({ status: 'queued', version: 0 }));
      vi.mocked(kbApi.getKbIngestBatch)
        .mockResolvedValueOnce(withStatus('running', 1))
        .mockResolvedValueOnce(withStatus('completed', 5));

      await useKbIngestStore.getState().submit('user-1', CREATE_INPUT);
      expect(useKbIngestStore.getState().batch?.status).toBe('queued');

      await vi.advanceTimersByTimeAsync(3_000);
      expect(useKbIngestStore.getState().batch?.status).toBe('running');
      await vi.advanceTimersByTimeAsync(3_000);
      expect(useKbIngestStore.getState().batch?.status).toBe('completed');
    });

    it('stops asking once the batch has finished', async () => {
      vi.mocked(kbApi.createKbIngestBatch).mockResolvedValue(batch({ status: 'queued' }));
      vi.mocked(kbApi.getKbIngestBatch).mockResolvedValue(withStatus('completed'));
      await useKbIngestStore.getState().submit('user-1', CREATE_INPUT);

      await vi.advanceTimersByTimeAsync(3_000);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(kbApi.getKbIngestBatch).toHaveBeenCalledTimes(1);
    });

    it.each<KbIngestBatchStatus>(['completed', 'completed_with_errors', 'failed', 'cancelled'])('treats %s as finished', async (status) => {
      vi.mocked(kbApi.createKbIngestBatch).mockResolvedValue(batch({ status: 'queued' }));
      vi.mocked(kbApi.getKbIngestBatch).mockResolvedValue(withStatus(status));
      await useKbIngestStore.getState().submit('user-1', CREATE_INPUT);

      await vi.advanceTimersByTimeAsync(9_000);

      expect(kbApi.getKbIngestBatch).toHaveBeenCalledTimes(1);
    });

    it('keeps asking while the batch is paused: it carries on by itself once the token is replaced', async () => {
      vi.mocked(kbApi.createKbIngestBatch).mockResolvedValue(batch({ status: 'queued' }));
      vi.mocked(kbApi.getKbIngestBatch).mockResolvedValue(withStatus('paused'));
      await useKbIngestStore.getState().submit('user-1', CREATE_INPUT);

      await vi.advanceTimersByTimeAsync(9_000);

      expect(kbApi.getKbIngestBatch).toHaveBeenCalledTimes(3);
    });

    it('lets the caller show a refusal (too many batches, a bad file) and leaves the state alone', async () => {
      vi.mocked(kbApi.createKbIngestBatch).mockRejectedValue(new Error('409'));

      await expect(useKbIngestStore.getState().submit('user-1', CREATE_INPUT)).rejects.toThrow('409');

      expect(useKbIngestStore.getState().batch).toBeNull();
      expect(useKbIngestStore.getState().busy).toBe(false);
    });
  });

  describe('polling', () => {
    beforeEach(() => {
      vi.mocked(kbApi.createKbIngestBatch).mockResolvedValue(batch({ status: 'queued' }));
      vi.mocked(kbApi.getKbIngestBatch).mockResolvedValue(withStatus('running'));
    });

    it('does not ask while the tab is hidden', async () => {
      await useKbIngestStore.getState().submit('user-1', CREATE_INPUT);
      setVisibility('hidden');

      await vi.advanceTimersByTimeAsync(12_000);

      expect(kbApi.getKbIngestBatch).not.toHaveBeenCalled();
    });

    it('asks at once when the tab comes back, then carries on', async () => {
      await useKbIngestStore.getState().submit('user-1', CREATE_INPUT);
      setVisibility('hidden');
      await vi.advanceTimersByTimeAsync(6_000);
      setVisibility('visible');

      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);

      expect(kbApi.getKbIngestBatch).toHaveBeenCalledTimes(1);
    });

    it('keeps the last batch and says so when a poll fails, and recovers on the next', async () => {
      await useKbIngestStore.getState().submit('user-1', CREATE_INPUT);
      vi.mocked(kbApi.getKbIngestBatch).mockRejectedValueOnce(new Error('network')).mockResolvedValue(withStatus('running', 9));

      await vi.advanceTimersByTimeAsync(3_000);
      expect(useKbIngestStore.getState().batch?.status).toBe('queued');
      expect(useKbIngestStore.getState().error).toMatch(/could not refresh/i);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(useKbIngestStore.getState().batch?.version).toBe(9);
      expect(useKbIngestStore.getState().error).toBeNull();
    });

    it('drops a batch that no longer exists (forgotten by retention)', async () => {
      await useKbIngestStore.getState().submit('user-1', CREATE_INPUT);
      const gone = new AxiosError('not found', '404');
      gone.response = { status: 404, data: {}, statusText: '', headers: {}, config: {} as never };
      vi.mocked(kbApi.getKbIngestBatch).mockRejectedValue(gone);

      await vi.advanceTimersByTimeAsync(3_000);

      expect(useKbIngestStore.getState().batch).toBeNull();
    });

    it('ignores an answer that arrives after the batch was dismissed', async () => {
      await useKbIngestStore.getState().submit('user-1', CREATE_INPUT);
      let release!: (value: KbIngestBatch) => void;
      vi.mocked(kbApi.getKbIngestBatch).mockReturnValue(new Promise((resolve) => (release = resolve)));
      await vi.advanceTimersByTimeAsync(3_000);

      useKbIngestStore.getState().dismiss();
      release(withStatus('running', 7));
      await vi.advanceTimersByTimeAsync(0);

      expect(useKbIngestStore.getState().batch).toBeNull();
    });

    it('stop() ends the polling', async () => {
      await useKbIngestStore.getState().submit('user-1', CREATE_INPUT);

      useKbIngestStore.getState().stop();
      await vi.advanceTimersByTimeAsync(12_000);

      expect(kbApi.getKbIngestBatch).not.toHaveBeenCalled();
    });
  });

  describe('actions on the batch', () => {
    async function running() {
      vi.mocked(kbApi.createKbIngestBatch).mockResolvedValue(batch({ status: 'running' }));
      vi.mocked(kbApi.getKbIngestBatch).mockResolvedValue(withStatus('running'));
      await useKbIngestStore.getState().submit('user-1', CREATE_INPUT);
    }

    it('cancel() asks the server and shows the result', async () => {
      await running();
      vi.mocked(kbApi.cancelKbIngestBatch).mockResolvedValue(batch({ status: 'running', cancelRequested: true, version: 8 }));

      await useKbIngestStore.getState().cancel();

      expect(kbApi.cancelKbIngestBatch).toHaveBeenCalledWith('b1');
      expect(useKbIngestStore.getState().batch).toMatchObject({ cancelRequested: true, version: 8 });
    });

    it('retryFailed() reopens a finished batch and the polling starts again', async () => {
      vi.mocked(kbApi.createKbIngestBatch).mockResolvedValue(withStatus('completed_with_errors'));
      await useKbIngestStore.getState().submit('user-1', CREATE_INPUT);
      vi.mocked(kbApi.retryFailedKbIngestBatch).mockResolvedValue(batch({ status: 'queued', version: 10 }));
      vi.mocked(kbApi.getKbIngestBatch).mockResolvedValue(withStatus('completed', 11));

      await useKbIngestStore.getState().retryFailed();
      expect(useKbIngestStore.getState().batch?.status).toBe('queued');
      await vi.advanceTimersByTimeAsync(3_000);

      expect(useKbIngestStore.getState().batch?.status).toBe('completed');
    });

    it('resume() continues a paused batch', async () => {
      vi.mocked(kbApi.createKbIngestBatch).mockResolvedValue(withStatus('paused'));
      await useKbIngestStore.getState().submit('user-1', CREATE_INPUT);
      vi.mocked(kbApi.resumeKbIngestBatch).mockResolvedValue(batch({ status: 'queued', version: 12 }));

      await useKbIngestStore.getState().resume();

      expect(kbApi.resumeKbIngestBatch).toHaveBeenCalledWith('b1');
      expect(useKbIngestStore.getState().batch?.status).toBe('queued');
    });

    it('an action the server refuses is reported and leaves the batch as it was', async () => {
      await running();
      vi.mocked(kbApi.retryFailedKbIngestBatch).mockRejectedValue(new Error('409'));

      await useKbIngestStore.getState().retryFailed();

      expect(useKbIngestStore.getState().batch?.status).toBe('running');
      expect(useKbIngestStore.getState().error).toMatch(/could not/i);
      expect(useKbIngestStore.getState().busy).toBe(false);
    });

    it('does nothing when there is no batch', async () => {
      await useKbIngestStore.getState().cancel();

      expect(kbApi.cancelKbIngestBatch).not.toHaveBeenCalled();
    });
  });

  it('a finished batch stays on show until it is dismissed', async () => {
    vi.mocked(kbApi.createKbIngestBatch).mockResolvedValue(withStatus('completed'));
    await useKbIngestStore.getState().submit('user-1', CREATE_INPUT);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(useKbIngestStore.getState().batch?.status).toBe('completed');

    useKbIngestStore.getState().dismiss();
    expect(useKbIngestStore.getState().batch).toBeNull();
  });
});
