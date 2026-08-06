import { fetchWithRetry } from '../src/modules/llm/retryWithBackoff';

function response(status: number, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } as Headers,
  } as Response;
}

describe('fetchWithRetry', () => {
  it('returns the response immediately on success, no retry', async () => {
    const fn = jest.fn().mockResolvedValue(response(200));
    const result = await fetchWithRetry(fn, { baseDelayMs: 1 });
    expect(result.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a 503 then returns the successful response', async () => {
    const fn = jest
      .fn()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200));
    const result = await fetchWithRetry(fn, { baseDelayMs: 1 });
    expect(result.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-retryable status (e.g. 404) -- fails fast, not a transient error', async () => {
    const fn = jest.fn().mockResolvedValue(response(404));
    const result = await fetchWithRetry(fn, { baseDelayMs: 1 });
    expect(result.status).toBe(404);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries and returns the final failing response', async () => {
    const fn = jest.fn().mockResolvedValue(response(503));
    const result = await fetchWithRetry(fn, { maxRetries: 2, baseDelayMs: 1 });
    expect(result.status).toBe(503);
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('retries a thrown network failure (no Response at all) and eventually succeeds', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(response(200));
    const result = await fetchWithRetry(fn, { baseDelayMs: 1 });
    expect(result.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rethrows the last network error once retries are exhausted', async () => {
    const fn = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(fetchWithRetry(fn, { maxRetries: 1, baseDelayMs: 1 })).rejects.toThrow('fetch failed');
    expect(fn).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
  });

  it('honors a Retry-After header instead of blind backoff', async () => {
    const fn = jest
      .fn()
      .mockResolvedValueOnce(response(429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(response(200));
    const result = await fetchWithRetry(fn, { baseDelayMs: 5000 }); // would be slow if Retry-After were ignored
    expect(result.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
