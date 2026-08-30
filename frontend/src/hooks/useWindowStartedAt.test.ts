import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { useWindowStartedAt } from './useWindowStartedAt';

describe('useWindowStartedAt', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds the same timestamp while the key stays the same', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { result, rerender } = renderHook(({ key }) => useWindowStartedAt(key, Date.now()), {
      initialProps: { key: 'deterministic_subtree:275' },
    });
    const initial = result.current;
    vi.setSystemTime(5_000);
    rerender({ key: 'deterministic_subtree:275' });
    expect(result.current).toBe(initial);
  });

  it('re-baselines to now when the key changes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { result, rerender } = renderHook(({ key }) => useWindowStartedAt(key, Date.now()), {
      initialProps: { key: 'deterministic_subtree:275' },
    });
    vi.setSystemTime(5_000);
    act(() => {
      rerender({ key: 'deterministic_subtree:153' });
    });
    // The ref write happens in an effect that fires AFTER this render
    // commits (same one-render lag useSecondsSinceLastUpdate's identical
    // ref+effect pattern has) -- in the real component this is invisible,
    // settled by the very next tick of ProgressBanner's own ticking clock.
    // One more render (same key) observes the settled value.
    act(() => {
      rerender({ key: 'deterministic_subtree:153' });
    });
    expect(result.current).toBe(5_000);
  });

  it('recovers the persisted start time across a remount of the SAME window (reload mid-chunk)', () => {
    // Real regression this fixes (confirmed live): reopening the same
    // running job in the same tab remounts this hook. Without storageKey,
    // the ref re-baselines to the reload moment even though the window
    // genuinely started minutes earlier server-side -- completedUnits
    // already reflects that prior work, so the rate calc built on a
    // reload-fresh "elapsed" produces a briefly wildly optimistic ETA.
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const first = renderHook(() => useWindowStartedAt('deterministic_subtree:275', Date.now(), 'progress-window:job1:deterministic_subtree:275'));
    expect(first.result.current).toBe(1_000);
    first.unmount();

    // Simulate a reload several minutes later -- a brand new mount, not a
    // rerender of the same hook instance.
    vi.setSystemTime(400_000);
    const second = renderHook(() => useWindowStartedAt('deterministic_subtree:275', Date.now(), 'progress-window:job1:deterministic_subtree:275'));
    expect(second.result.current).toBe(1_000);
  });

  it('does not leak one job\'s stored start time into a different job', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const first = renderHook(() => useWindowStartedAt('deterministic_subtree:275', Date.now(), 'progress-window:job1:deterministic_subtree:275'));
    first.unmount();

    vi.setSystemTime(400_000);
    const second = renderHook(() => useWindowStartedAt('deterministic_subtree:275', Date.now(), 'progress-window:job2:deterministic_subtree:275'));
    expect(second.result.current).toBe(400_000);
  });

  it('still recovers from storage when the real key only becomes known after an initial undefined render', () => {
    // Real regression this fixes (confirmed live, on every real page load,
    // not just a rare race): the caller's narration data loads
    // asynchronously, so `key` (and therefore storageKey) is undefined on
    // the first render or two and only becomes real once that fetch
    // resolves. Seeding prevIdentityRef from that first (undefined) render
    // made the LATER transition to the real key look like a genuine
    // window change -- forcing a reset-to-now and skipping storage
    // recovery entirely, on every load, not just a race.
    vi.useFakeTimers();
    // Distinct from both the mount time below AND the time the key
    // eventually arrives -- if the assertion below ever passed by
    // coincidentally matching either of those instead of a real recovery,
    // this value makes that impossible to miss.
    const storageKey = 'progress-window:job1:deterministic_subtree:275';
    sessionStorage.setItem(storageKey, '7_777'.replace('_', ''));

    vi.setSystemTime(1_000);
    const { result, rerender } = renderHook(
      ({ key }: { key: string | undefined }) =>
        useWindowStartedAt(key, Date.now(), key ? storageKey : undefined),
      { initialProps: { key: undefined } },
    );

    // Real time passes before the async narration fetch resolves.
    vi.setSystemTime(500_000);
    act(() => {
      rerender({ key: 'deterministic_subtree:275' });
    });
    act(() => {
      rerender({ key: 'deterministic_subtree:275' });
    });
    expect(result.current).toBe(7_777);
  });
});
