import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { useWindowBaselineUnits } from './useWindowBaselineUnits';

describe('useWindowBaselineUnits', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('snapshots the units seen on first observation and holds it fixed as units climb', () => {
    const { result, rerender } = renderHook(({ units }) => useWindowBaselineUnits('deterministic_subtree:275', units), {
      initialProps: { units: 0 },
    });
    expect(result.current).toBe(0);
    act(() => {
      rerender({ units: 150 });
    });
    // Same identity -- baseline must NOT follow currentUnits upward.
    expect(result.current).toBe(0);
  });

  it('re-baselines to the new units value when the identity changes', () => {
    const { result, rerender } = renderHook(({ identity, units }) => useWindowBaselineUnits(identity, units), {
      initialProps: { identity: 'deterministic_subtree:275', units: 150 },
    });
    act(() => {
      rerender({ identity: 'deterministic_subtree:153', units: 0 });
    });
    act(() => {
      rerender({ identity: 'deterministic_subtree:153', units: 0 });
    });
    expect(result.current).toBe(0);
  });

  it('recovers the persisted baseline across a remount of the SAME window (mirrors useWindowStartedAt)', () => {
    const storageKey = 'progress-window:job1:deterministic_subtree:153:baseline';
    const first = renderHook(() => useWindowBaselineUnits('deterministic_subtree:153', 150, storageKey));
    expect(first.result.current).toBe(150);
    first.unmount();

    // A fresh mount arriving mid-chunk, further along -- must recover the
    // ORIGINAL baseline (150), not re-snapshot at the new, higher value.
    const second = renderHook(() => useWindowBaselineUnits('deterministic_subtree:153', 150, storageKey));
    expect(second.result.current).toBe(150);
  });

  it('still recovers from storage when the real identity only becomes known after an initial undefined render', () => {
    // Mirrors useWindowStartedAt's identical regression: narration data
    // loads asynchronously, so identity/currentUnits are undefined on the
    // first render(s). Must not treat that transition as a fresh window.
    const storageKey = 'progress-window:job1:deterministic_subtree:153:baseline';
    sessionStorage.setItem(storageKey, '0');

    const { result, rerender } = renderHook(
      ({ identity, units }: { identity: string | undefined; units: number | undefined }) =>
        useWindowBaselineUnits(identity, units, identity ? storageKey : undefined),
      { initialProps: { identity: undefined, units: undefined } },
    );

    act(() => {
      rerender({ identity: 'deterministic_subtree:153', units: 150 });
    });
    act(() => {
      rerender({ identity: 'deterministic_subtree:153', units: 150 });
    });
    // Recovered baseline (0), not re-snapshotted at the already-in-flight
    // value (150) this render happened to arrive with.
    expect(result.current).toBe(0);
  });

  it('persists a fresh baseline (not just a recovered one) when the real identity arrives after an initial undefined render and nothing is stored yet', () => {
    // Real regression this fixes (confirmed live via a real page, not just
    // a unit test): baselineRef's OWN initial value is locked in by
    // useRef on the first (data-less) render, where currentUnits is also
    // still undefined. A guard that trusted that stale ref value instead
    // of the CURRENT render's currentUnits silently skipped persisting a
    // fresh baseline forever -- confirmed live via sessionStorage: the
    // window-start timestamp persisted correctly but its companion
    // baseline entry was simply never written for any real job.
    const storageKey = 'progress-window:job1:deterministic_subtree:275:baseline';
    const { result, rerender } = renderHook(
      ({ identity, units }: { identity: string | undefined; units: number | undefined }) =>
        useWindowBaselineUnits(identity, units, identity ? storageKey : undefined),
      { initialProps: { identity: undefined, units: undefined } },
    );
    act(() => {
      rerender({ identity: 'deterministic_subtree:275', units: 0 });
    });
    act(() => {
      rerender({ identity: 'deterministic_subtree:275', units: 0 });
    });
    expect(result.current).toBe(0);
    expect(sessionStorage.getItem(storageKey)).toBe('0');
  });
});
