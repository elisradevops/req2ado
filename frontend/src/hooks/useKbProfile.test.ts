import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useKbProfile, KB_PROFILE_POLL_MS, KB_PROFILE_GIVE_UP_MS } from './useKbProfile';
import * as kbApi from '../api/kb';
import type { KbProfile } from '../api/kb';

vi.mock('../api/kb');

const profile = (overrides: Partial<KbProfile> = {}): KbProfile => ({
  state: 'ready', builtAt: '2026-11-12T10:00:00Z', version: 'v1', builtWith: 'model', docsInKb: 2, docsContributing: 2, truncated: false, docs: [], conflicts: [], ...overrides,
});

// Lets the promise the hook is waiting on settle, then moves the clock.
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useKbProfile', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(kbApi.getKbProfile).mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('reads the profile once and stops when it is ready', async () => {
    vi.mocked(kbApi.getKbProfile).mockResolvedValue(profile());

    const { result } = renderHook(() => useKbProfile({ enabled: true }));
    await tick(0);

    expect(result.current.status).toBe('ready');
    expect(result.current.profile?.docsInKb).toBe(2);
    await tick(KB_PROFILE_POLL_MS * 3);
    expect(kbApi.getKbProfile).toHaveBeenCalledTimes(1);
  });

  it.each(['queued', 'building'] as const)('keeps asking while the rubric is %s, and stops once it is ready', async (state) => {
    vi.mocked(kbApi.getKbProfile).mockResolvedValueOnce(profile({ state })).mockResolvedValueOnce(profile({ state })).mockResolvedValue(profile());

    const { result } = renderHook(() => useKbProfile({ enabled: true }));
    await tick(0);
    expect(result.current.status).toBe('waiting');
    await tick(KB_PROFILE_POLL_MS);
    expect(result.current.status).toBe('waiting');
    await tick(KB_PROFILE_POLL_MS);
    expect(result.current.status).toBe('ready');
    await tick(KB_PROFILE_POLL_MS * 3);
    expect(kbApi.getKbProfile).toHaveBeenCalledTimes(3);
  });

  it('treats a profile built before the batch finished as not caught up yet, and waits for a newer one', async () => {
    vi.mocked(kbApi.getKbProfile)
      .mockResolvedValueOnce(profile({ builtAt: '2026-11-12T09:00:00Z' }))
      .mockResolvedValue(profile({ builtAt: '2026-11-12T10:30:00Z' }));

    const { result } = renderHook(() => useKbProfile({ enabled: true, since: '2026-11-12T10:00:00Z' }));
    await tick(0);
    expect(result.current.status).toBe('waiting');
    await tick(KB_PROFILE_POLL_MS);

    expect(result.current.status).toBe('ready');
  });

  it('stops asking, and says so, after waiting too long', async () => {
    vi.mocked(kbApi.getKbProfile).mockResolvedValue(profile({ state: 'building' }));

    const { result } = renderHook(() => useKbProfile({ enabled: true }));
    await tick(KB_PROFILE_GIVE_UP_MS + KB_PROFILE_POLL_MS);

    expect(result.current.status).toBe('timeout');
    const calls = vi.mocked(kbApi.getKbProfile).mock.calls.length;
    await tick(KB_PROFILE_POLL_MS * 5);
    expect(vi.mocked(kbApi.getKbProfile).mock.calls.length).toBe(calls);
  });

  it.each(['none', 'no_model'] as const)('does not wait for a rubric that is not coming (%s)', async (state) => {
    vi.mocked(kbApi.getKbProfile).mockResolvedValue(profile({ state, builtAt: null, docsInKb: 0 }));

    const { result } = renderHook(() => useKbProfile({ enabled: true }));
    await tick(0);

    expect(result.current.status).toBe(state);
    await tick(KB_PROFILE_POLL_MS * 3);
    expect(kbApi.getKbProfile).toHaveBeenCalledTimes(1);
  });

  it('keeps trying after a failed read, and says it could not read it meanwhile', async () => {
    vi.mocked(kbApi.getKbProfile).mockRejectedValueOnce(new Error('down')).mockResolvedValue(profile());

    const { result } = renderHook(() => useKbProfile({ enabled: true }));
    await tick(0);
    expect(result.current.status).toBe('error');
    await tick(KB_PROFILE_POLL_MS);

    expect(result.current.status).toBe('ready');
  });

  it('does nothing while disabled, and starts when enabled', async () => {
    vi.mocked(kbApi.getKbProfile).mockResolvedValue(profile());

    const { result, rerender } = renderHook(({ enabled }) => useKbProfile({ enabled }), { initialProps: { enabled: false } });
    await tick(KB_PROFILE_POLL_MS * 2);
    expect(kbApi.getKbProfile).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');

    rerender({ enabled: true });
    await tick(0);
    expect(result.current.status).toBe('ready');
  });

  it('stops asking when it goes away', async () => {
    vi.mocked(kbApi.getKbProfile).mockResolvedValue(profile({ state: 'building' }));

    const { unmount } = renderHook(() => useKbProfile({ enabled: true }));
    await tick(0);
    unmount();
    await tick(KB_PROFILE_POLL_MS * 4);

    expect(kbApi.getKbProfile).toHaveBeenCalledTimes(1);
  });

  it('can be asked again on demand', async () => {
    vi.mocked(kbApi.getKbProfile).mockResolvedValue(profile());

    const { result } = renderHook(() => useKbProfile({ enabled: true }));
    await tick(0);
    await act(async () => result.current.refresh());

    expect(kbApi.getKbProfile).toHaveBeenCalledTimes(2);
  });

  it('starts waiting again when a newer batch finishes after it had already settled', async () => {
    vi.mocked(kbApi.getKbProfile)
      .mockResolvedValueOnce(profile({ builtAt: '2026-11-12T10:00:00Z' }))
      .mockResolvedValueOnce(profile({ builtAt: '2026-11-12T10:00:00Z' }))
      .mockResolvedValue(profile({ builtAt: '2026-11-12T12:00:00Z' }));

    const { result, rerender } = renderHook(({ since }) => useKbProfile({ enabled: true, since }), { initialProps: { since: null as string | null } });
    await tick(0);
    expect(result.current.status).toBe('ready');

    rerender({ since: '2026-11-12T11:00:00Z' });
    await tick(0);
    expect(result.current.status).toBe('waiting');
    await tick(KB_PROFILE_POLL_MS);

    expect(result.current.status).toBe('ready');
  });

  it('keeps saying "waiting" rather than going back to "loading" when it restarts with a profile already in hand', async () => {
    vi.mocked(kbApi.getKbProfile).mockResolvedValue(profile({ builtAt: '2026-11-12T10:00:00Z' }));

    const { result, rerender } = renderHook(({ since }) => useKbProfile({ enabled: true, since }), { initialProps: { since: null as string | null } });
    await tick(0);
    expect(result.current.status).toBe('ready');

    rerender({ since: '2026-11-12T11:00:00Z' });

    expect(result.current.status).toBe('waiting');
  });
});
