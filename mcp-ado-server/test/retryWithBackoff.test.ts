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

  it('does NOT retry on a 400 (non-retryable client error)', async () => {
    const fn = vi.fn().mockRejectedValue({ response: { status: 400 } });
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
});
