import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError } from 'axios';
import { getRunDone, getRunMap } from './runMap';
import { httpClient } from './httpClient';

vi.mock('./httpClient', () => ({ httpClient: { get: vi.fn() } }));
const get = vi.mocked(httpClient.get);

const failure = (status: number): AxiosError =>
  new AxiosError('failed', 'ERR', undefined, undefined, { status } as never);

describe('getRunMap', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation(() => Promise.reject(new Error('unexpected call')));
  });

  it('returns the map from the owner-scoped endpoint', async () => {
    get.mockResolvedValue({ data: { version: 1, totalItems: 3 } });
    await expect(getRunMap('job-1')).resolves.toEqual({ version: 1, totalItems: 3 });
    expect(get).toHaveBeenCalledWith('/jobs/job-1/run-map');
  });

  it('treats a 404 (feature off, not parsed yet, or not your job) as no map', async () => {
    get.mockImplementation(() => Promise.reject(failure(404)));
    await expect(getRunMap('job-1')).resolves.toBeNull();
  });

  it('still raises real failures', async () => {
    get.mockImplementation(() => Promise.reject(failure(500)));
    await expect(getRunMap('job-1')).rejects.toThrow();
    get.mockImplementation(() => Promise.reject(new Error('network')));
    await expect(getRunMap('job-1')).rejects.toThrow('network');
  });
});

describe('getRunDone', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation(() => Promise.reject(new Error('unexpected call')));
  });

  it('returns the finished refs', async () => {
    get.mockImplementation(() => Promise.resolve({ data: { refs: ['a', 'b'] } }));
    await expect(getRunDone('job-1')).resolves.toEqual(['a', 'b']);
    expect(get).toHaveBeenCalledWith('/jobs/job-1/run-done');
  });

  it('is null on a 404, for a malformed body, and still raises real failures', async () => {
    get.mockImplementation(() => Promise.reject(failure(404)));
    await expect(getRunDone('job-1')).resolves.toBeNull();
    get.mockImplementation(() => Promise.resolve({ data: { nope: true } }));
    await expect(getRunDone('job-1')).resolves.toBeNull();
    get.mockImplementation(() => Promise.reject(failure(500)));
    await expect(getRunDone('job-1')).rejects.toThrow();
  });
});
