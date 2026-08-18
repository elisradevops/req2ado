import { describe, it, expect, vi } from 'vitest';
import { retryWithBackoff } from '../src/backends/retryWithBackoff';

describe('retryWithBackoff', () => {
  it('returns the result on the first successful call, no retry', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retryWithBackoff(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on a 429 response and eventually succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockResolvedValueOnce('ok');
    const result = await retryWithBackoff(fn, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on a 503 response', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce('ok');
    const result = await retryWithBackoff(fn, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on a 409 Conflict response (optimistic concurrency failure)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 409 } })
      .mockResolvedValueOnce('ok');
    const result = await retryWithBackoff(fn, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on a 400 (non-retryable client error)', async () => {
    const fn = vi.fn().mockRejectedValue({ response: { status: 400 } });
    await expect(retryWithBackoff(fn, { baseDelayMs: 1 })).rejects.toMatchObject({ response: { status: 400 } });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a 400 whose ADO error message starts with TF401349 (confirmed transient)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({
        response: { status: 400, data: { message: 'TF401349: An unexpected error has occurred, please verify your request and try again.' } },
      })
      .mockResolvedValueOnce('ok');
    const result = await retryWithBackoff(fn, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a different, genuinely permanent 400 error code', async () => {
    const fn = vi.fn().mockRejectedValue({ response: { status: 400, data: { message: 'TF401232: The field X is required.' } } });
    await expect(retryWithBackoff(fn, { baseDelayMs: 1 })).rejects.toMatchObject({ response: { status: 400 } });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws the last error after exhausting maxRetries', async () => {
    const fn = vi.fn().mockRejectedValue({ response: { status: 429 } });
    await expect(retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 1 })).rejects.toMatchObject({
      response: { status: 429 },
    });
    expect(fn).toHaveBeenCalledTimes(4); // initial attempt + 3 retries
  });

  it('retries a transient network error with no HTTP response at all (e.g. ECONNRESET)', async () => {
    // Regression: isRetryable previously required a numeric response.status,
    // so a genuine network failure (no response ever received) was never
    // retried -- more likely against a real on-prem network than a stable
    // cloud endpoint.
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ request: {}, code: 'ECONNRESET', message: 'socket hang up' })
      .mockResolvedValueOnce('ok');
    const result = await retryWithBackoff(fn, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a request-config error with neither a response nor a request', async () => {
    // e.g. a synchronous axios config error thrown before any request was
    // ever dispatched -- retrying it can never help.
    const fn = vi.fn().mockRejectedValue({ message: 'Invalid URL' });
    await expect(retryWithBackoff(fn, { baseDelayMs: 1 })).rejects.toMatchObject({ message: 'Invalid URL' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('honors a numeric Retry-After header instead of blind exponential backoff', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 429, headers: { 'retry-after': '0.01' } } })
      .mockResolvedValueOnce('ok');
    const start = Date.now();
    const result = await retryWithBackoff(fn, { baseDelayMs: 5000 }); // would be seconds under blind backoff
    expect(result).toBe('ok');
    expect(Date.now() - start).toBeLessThan(500); // proves the 10ms Retry-After won, not the 5s base delay
  });

  it('falls back to exponential backoff when Retry-After is absent', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 429, headers: {} } })
      .mockResolvedValueOnce('ok');
    const result = await retryWithBackoff(fn, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
