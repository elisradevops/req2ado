import { describe, it, expect, vi, beforeEach } from 'vitest';
import { httpClient } from './httpClient';
import { submitBatch, getBatch, listBatches, cancelQueuedFiles } from './batches';

vi.mock('./httpClient');

describe('batches api', () => {
  // Several tests below each make exactly one httpClient.post/get call and
  // index mock.calls[0] -- reset between tests so that index means "this
  // test's own call," not "the first call across the whole file."
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submitBatch appends one "files" form entry per file, plus the scalar fields', async () => {
    (httpClient.post as any).mockResolvedValue({ data: { batchId: 'batch-1', filesAccepted: 2, filesRejected: 0 } });

    const result = await submitBatch({
      files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')],
      areaPath: 'Project\\Area1',
      mode: 'survey',
      state: 'Active',
      iterationPath: 'Sprint 1',
      model: 'qwen2.5:1.5b',
    });

    expect(httpClient.post).toHaveBeenCalledWith('/batches', expect.any(FormData));
    const form = (httpClient.post as any).mock.calls[0][1] as FormData;
    expect(form.getAll('files')).toHaveLength(2);
    expect(form.get('areaPath')).toBe('Project\\Area1');
    expect(form.get('mode')).toBe('survey');
    expect(form.get('state')).toBe('Active');
    expect(form.get('iterationPath')).toBe('Sprint 1');
    expect(form.get('model')).toBe('qwen2.5:1.5b');
    expect(result).toEqual({ batchId: 'batch-1', filesAccepted: 2, filesRejected: 0 });
  });

  it('submitBatch omits optional fields entirely when not provided', async () => {
    (httpClient.post as any).mockResolvedValue({ data: { batchId: 'batch-1', filesAccepted: 1, filesRejected: 0 } });

    await submitBatch({ files: [new File(['a'], 'a.txt')], areaPath: 'Project\\Area1', mode: 'baseline' });

    const form = (httpClient.post as any).mock.calls[0][1] as FormData;
    expect(form.get('state')).toBeNull();
    expect(form.get('iterationPath')).toBeNull();
    expect(form.get('model')).toBeNull();
  });

  it('getBatch GETs the batch detail route', async () => {
    (httpClient.get as any).mockResolvedValue({ data: { id: 'batch-1', files: [] } });
    const result = await getBatch('batch-1');
    expect(httpClient.get).toHaveBeenCalledWith('/batches/batch-1');
    expect(result).toEqual({ id: 'batch-1', files: [] });
  });

  it('listBatches GETs the batch list route', async () => {
    (httpClient.get as any).mockResolvedValue({ data: [{ id: 'batch-1' }] });
    const result = await listBatches();
    expect(httpClient.get).toHaveBeenCalledWith('/batches');
    expect(result).toEqual([{ id: 'batch-1' }]);
  });

  it('cancelQueuedFiles POSTs to the cancel-queued sub-route', async () => {
    (httpClient.post as any).mockResolvedValue({ data: { cancelled: 3 } });
    const result = await cancelQueuedFiles('batch-1');
    expect(httpClient.post).toHaveBeenCalledWith('/batches/batch-1/cancel-queued');
    expect(result).toEqual({ cancelled: 3 });
  });
});
