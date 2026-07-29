import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { useNow } from './useNow';

describe('useNow', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('advances after the interval elapses', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNow(1000));
    const initial = result.current;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBeGreaterThan(initial);
  });

  it('clears the interval on unmount', () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(global, 'clearInterval');
    const { unmount } = renderHook(() => useNow(1000));
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });

  it('never schedules an interval when intervalMs is null', () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(global, 'setInterval');
    renderHook(() => useNow(null));
    expect(setSpy).not.toHaveBeenCalled();
  });
});
