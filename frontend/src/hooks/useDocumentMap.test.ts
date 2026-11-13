import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { clearDocumentMapCache, MAX_RETRY_MS, RETRY_MS, retryDelay, useDocumentMap } from './useDocumentMap';
import { getRunMap } from '../api/runMap';
import type { DocumentMap } from '../api/liveTypes';

vi.mock('../api/runMap', () => ({ getRunMap: vi.fn() }));
const mocked = vi.mocked(getRunMap);

const MAP: DocumentMap = {
  version: 1, unit: 'headings', truncated: false, totalItems: 1, groups: [], items: [],
  stats: { words: 5, blocks: 2, headings: 1, tables: 0, tableRows: 0, figures: 0, pages: 1 },
};

const settle = async (ms = 0): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('useDocumentMap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearDocumentMapCache();
    mocked.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('fetches once on mount and returns the map', async () => {
    mocked.mockResolvedValue(MAP);
    const { result } = renderHook(() => useDocumentMap('job-1', false, true));
    await settle();
    expect(result.current).toEqual({ map: MAP, state: 'ready' });
    await settle(RETRY_MS * 3);
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it('caches per job: a remount does not ask again', async () => {
    mocked.mockResolvedValue(MAP);
    const first = renderHook(() => useDocumentMap('job-1', false, true));
    await settle();
    first.unmount();
    const second = renderHook(() => useDocumentMap('job-1', false, true));
    await settle();
    expect(second.result.current.map).toEqual(MAP);
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it('asks once while the feature has not been seen, and not again until the live stream shows it', async () => {
    mocked.mockResolvedValue(null);
    const { result } = renderHook(() => useDocumentMap('job-1', false, true));
    await settle();
    expect(mocked).toHaveBeenCalledTimes(1);
    await settle(RETRY_MS * 20);
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ map: null, state: 'off' });
  });

  it('asks again at once when the live stream shows the feature is on, and then keeps asking with growing gaps while the run goes on', async () => {
    // A figure-heavy document can take many minutes to parse, and the map only exists after that. Giving up after a fixed
    // 48 s (the old rule) lost the outline for that page view, so the live run asks until the run ends, backing off.
    mocked.mockResolvedValue(null);
    const { result, rerender } = renderHook(({ live, running }) => useDocumentMap('job-1', live, running), {
      initialProps: { live: false, running: true },
    });
    await settle();
    const before = mocked.mock.calls.length;
    rerender({ live: true, running: true });
    await settle();
    expect(mocked.mock.calls.length).toBe(before + 1);

    await settle(10 * 60_000);
    const asked = mocked.mock.calls.length - before;
    expect(asked).toBeGreaterThan(8); // far past the old six tries
    expect(asked).toBeLessThan(30); // but backed off, not one every 8 s for ten minutes (that would be about 75)
    expect(result.current).toEqual({ map: null, state: 'loading' });

    rerender({ live: true, running: false });
    await settle();
    const stopped = mocked.mock.calls.length;
    await settle(5 * 60_000);
    expect(mocked.mock.calls.length).toBe(stopped);
    expect(result.current).toEqual({ map: null, state: 'off' });
  });

  it('backs off from 8 s to 30 s and no further', () => {
    expect(retryDelay(1)).toBe(RETRY_MS);
    expect(retryDelay(3)).toBe(RETRY_MS);
    expect(retryDelay(4)).toBeGreaterThan(RETRY_MS);
    expect(retryDelay(50)).toBe(MAX_RETRY_MS);
    for (let n = 2; n < 60; n += 1) expect(retryDelay(n)).toBeGreaterThanOrEqual(retryDelay(n - 1));
  });

  it('finds the map when it appears after a miss', async () => {
    mocked.mockResolvedValueOnce(null).mockResolvedValue(MAP);
    const { result } = renderHook(() => useDocumentMap('job-1', true, true));
    await settle();
    expect(result.current.state).toBe('loading');
    await settle(RETRY_MS);
    expect(result.current).toEqual({ map: MAP, state: 'ready' });
  });

  it('does not ask for a finished run, and treats a failed request like no map', async () => {
    const finished = renderHook(() => useDocumentMap('job-9', false, false));
    await settle();
    expect(mocked).not.toHaveBeenCalled();
    expect(finished.result.current).toEqual({ map: null, state: 'off' });

    mocked.mockRejectedValue(new Error('network'));
    const failing = renderHook(() => useDocumentMap('job-2', false, true));
    await settle(RETRY_MS * 10);
    expect(failing.result.current).toEqual({ map: null, state: 'off' });
  });

  it('switches job cleanly and stops asking on unmount', async () => {
    mocked.mockResolvedValue(null);
    const { rerender, unmount } = renderHook(({ id }) => useDocumentMap(id, false, true), { initialProps: { id: 'a' } });
    await settle();
    rerender({ id: 'b' });
    await settle();
    expect(mocked.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    unmount();
    const calls = mocked.mock.calls.length;
    await settle(RETRY_MS * 20);
    expect(mocked.mock.calls.length).toBe(calls);
  });
});
