import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { clearDocumentMapCache, MAX_ATTEMPTS_AFTER_LIVE, MAX_PAUSE_MS, RETRY_MS, useDocumentMap } from './useDocumentMap';
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

  it('keeps asking with a growing pause while the feature has not been seen, capped', async () => {
    mocked.mockResolvedValue(null);
    renderHook(() => useDocumentMap('job-1', false, true));
    await settle();
    expect(mocked).toHaveBeenCalledTimes(1);
    await settle(RETRY_MS);
    expect(mocked).toHaveBeenCalledTimes(2);
    await settle(RETRY_MS * 2);
    expect(mocked).toHaveBeenCalledTimes(3);
    await settle(MAX_PAUSE_MS * 10);
    // Bounded: far fewer than one ask per RETRY_MS.
    expect(mocked.mock.calls.length).toBeLessThan(15);
  });

  it('asks again at once when the live stream shows the feature is on, then gives up after a few tries', async () => {
    mocked.mockResolvedValue(null);
    const { result, rerender } = renderHook(({ live }) => useDocumentMap('job-1', live, true), {
      initialProps: { live: false },
    });
    await settle();
    const before = mocked.mock.calls.length;
    rerender({ live: true });
    await settle();
    expect(mocked.mock.calls.length).toBe(before + 1);
    await settle(RETRY_MS * (MAX_ATTEMPTS_AFTER_LIVE + 2));
    expect(mocked.mock.calls.length).toBe(before + MAX_ATTEMPTS_AFTER_LIVE);
    expect(result.current).toEqual({ map: null, state: 'off' });
  });

  it('finds the map when it appears after a miss', async () => {
    mocked.mockResolvedValueOnce(null).mockResolvedValue(MAP);
    const { result } = renderHook(() => useDocumentMap('job-1', false, true));
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
    const failing = renderHook(() => useDocumentMap('job-2', true, true));
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
    await settle(MAX_PAUSE_MS * 3);
    expect(mocked.mock.calls.length).toBe(calls);
  });
});
