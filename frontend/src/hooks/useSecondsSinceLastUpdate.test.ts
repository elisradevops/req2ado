import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSecondsSinceLastUpdate } from './useSecondsSinceLastUpdate';

describe('useSecondsSinceLastUpdate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-07T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('counts from the moment the page saw the event when the event carries no time', () => {
    const event = { message: 'x' };
    const { result, rerender } = renderHook(({ now }) => useSecondsSinceLastUpdate(event, now), { initialProps: { now: Date.now() } });
    rerender({ now: Date.now() + 12_000 });
    expect(result.current).toBe(12);
  });

  it('counts from the time the server recorded the event, so a page opened late still knows how long the run was silent', () => {
    const event = { message: 'x', at: '2026-11-07T09:56:30.000Z' }; // 3m 30s before "now"
    const { result } = renderHook(() => useSecondsSinceLastUpdate(event, Date.now()));
    expect(result.current).toBe(210);
  });

  it('restarts from a new event, and never goes negative if the server clock is ahead', () => {
    const first = { message: 'a', at: '2026-11-07T09:59:00.000Z' };
    const { result, rerender } = renderHook(({ event, now }) => useSecondsSinceLastUpdate(event, now), { initialProps: { event: first as { message: string; at?: string }, now: Date.now() } });
    expect(result.current).toBe(60);
    const ahead = { message: 'b', at: '2026-11-07T10:05:00.000Z' }; // in the future: clock skew
    rerender({ event: ahead, now: Date.now() });
    rerender({ event: ahead, now: Date.now() }); // the ref moves in an effect; the page's one-second clock renders again
    expect(result.current).toBe(0);
  });
});
