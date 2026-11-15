import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startConnectionStatusPolling, useConnectionStatusStore } from './connectionStatusStore';
import * as adoApi from '../api/ado';
import * as kbApi from '../api/kb';
import * as llmApi from '../api/llm';

vi.mock('../api/ado');
vi.mock('../api/kb');
vi.mock('../api/llm');

const OK_ADO = { status: 'valid' } as const;
const OK_SP = { status: 'valid', expiresInSeconds: 3600 } as const;
const OK_LLM = { status: 'reachable', latencyMs: 120 } as const;

function mockAllOk(): void {
  vi.mocked(adoApi.getAdoStatus).mockResolvedValue(OK_ADO);
  vi.mocked(kbApi.getSharePointStatus).mockResolvedValue(OK_SP);
  vi.mocked(llmApi.getLlmStatus).mockResolvedValue(OK_LLM);
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

describe('connectionStatusStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T10:00:00Z'));
    vi.clearAllMocks();
    useConnectionStatusStore.getState().reset();
    setVisibility('visible');
    mockAllOk();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with nothing known and nothing in flight', () => {
    const { ado, sharePoint, llm } = useConnectionStatusStore.getState();
    for (const entry of [ado, sharePoint, llm]) {
      expect(entry).toEqual({ data: null, error: false, checkedAt: null, inFlight: false });
    }
  });

  it('refresh() checks all three integrations and records when', async () => {
    await useConnectionStatusStore.getState().refresh();

    const { ado, sharePoint, llm } = useConnectionStatusStore.getState();
    expect(ado.data).toEqual(OK_ADO);
    expect(sharePoint.data).toEqual(OK_SP);
    expect(llm.data).toEqual(OK_LLM);
    expect(ado.checkedAt).toBe(Date.now());
    expect(ado.inFlight).toBe(false);
  });

  it('refresh(kind) checks only that integration', async () => {
    await useConnectionStatusStore.getState().refresh('sharePoint');

    expect(kbApi.getSharePointStatus).toHaveBeenCalledTimes(1);
    expect(adoApi.getAdoStatus).not.toHaveBeenCalled();
    expect(llmApi.getLlmStatus).not.toHaveBeenCalled();
  });

  it('de-duplicates a refresh already in flight', async () => {
    let release!: (value: typeof OK_SP) => void;
    vi.mocked(kbApi.getSharePointStatus).mockReturnValue(new Promise((resolve) => (release = resolve)));

    const first = useConnectionStatusStore.getState().refresh('sharePoint');
    const second = useConnectionStatusStore.getState().refresh('sharePoint');
    expect(useConnectionStatusStore.getState().sharePoint.inFlight).toBe(true);
    release(OK_SP);
    await Promise.all([first, second]);

    expect(kbApi.getSharePointStatus).toHaveBeenCalledTimes(1);
    expect(useConnectionStatusStore.getState().sharePoint.inFlight).toBe(false);
  });

  it('records a failed check as an error and keeps the last good value', async () => {
    await useConnectionStatusStore.getState().refresh('sharePoint');
    vi.mocked(kbApi.getSharePointStatus).mockRejectedValue(new Error('network'));

    await useConnectionStatusStore.getState().refresh('sharePoint');

    const { sharePoint } = useConnectionStatusStore.getState();
    expect(sharePoint.error).toBe(true);
    expect(sharePoint.data).toEqual(OK_SP);
  });

  it('clears the error when a later check succeeds', async () => {
    vi.mocked(kbApi.getSharePointStatus).mockRejectedValueOnce(new Error('network'));
    await useConnectionStatusStore.getState().refresh('sharePoint');
    expect(useConnectionStatusStore.getState().sharePoint.error).toBe(true);

    await useConnectionStatusStore.getState().refresh('sharePoint');

    expect(useConnectionStatusStore.getState().sharePoint.error).toBe(false);
  });

  it('record() stores a status already known (a reconnect result) without another check', () => {
    useConnectionStatusStore.getState().record('sharePoint', OK_SP);

    const { sharePoint } = useConnectionStatusStore.getState();
    expect(sharePoint).toEqual({ data: OK_SP, error: false, checkedAt: Date.now(), inFlight: false });
    expect(kbApi.getSharePointStatus).not.toHaveBeenCalled();
  });

  it('record() clears an earlier error', async () => {
    vi.mocked(kbApi.getSharePointStatus).mockRejectedValueOnce(new Error('down'));
    await useConnectionStatusStore.getState().refresh('sharePoint');

    useConnectionStatusStore.getState().record('sharePoint', OK_SP);

    expect(useConnectionStatusStore.getState().sharePoint.error).toBe(false);
  });

  it('one integration failing does not block the others', async () => {
    vi.mocked(adoApi.getAdoStatus).mockRejectedValue(new Error('boom'));

    await useConnectionStatusStore.getState().refresh();

    const { ado, sharePoint, llm } = useConnectionStatusStore.getState();
    expect(ado.error).toBe(true);
    expect(sharePoint.data).toEqual(OK_SP);
    expect(llm.data).toEqual(OK_LLM);
  });
});

describe('startConnectionStatusPolling', () => {
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T10:00:00Z'));
    vi.clearAllMocks();
    useConnectionStatusStore.getState().reset();
    setVisibility('visible');
    mockAllOk();
  });

  afterEach(() => {
    stop?.();
    vi.useRealTimers();
  });

  it('checks immediately, then every 60 seconds while the tab is visible', async () => {
    stop = startConnectionStatusPolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(kbApi.getSharePointStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(kbApi.getSharePointStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(kbApi.getSharePointStatus).toHaveBeenCalledTimes(2);
  });

  it('does not check while the tab is hidden', async () => {
    stop = startConnectionStatusPolling();
    await vi.advanceTimersByTimeAsync(0);
    setVisibility('hidden');

    await vi.advanceTimersByTimeAsync(180_000);

    expect(kbApi.getSharePointStatus).toHaveBeenCalledTimes(1);
  });

  it('checks again when the tab becomes visible and the last check is stale', async () => {
    stop = startConnectionStatusPolling();
    await vi.advanceTimersByTimeAsync(0);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(30_000);
    setVisibility('visible');

    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);

    expect(kbApi.getSharePointStatus).toHaveBeenCalledTimes(2);
  });

  it('does not re-check on focus when the last check is recent', async () => {
    stop = startConnectionStatusPolling();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);

    expect(kbApi.getSharePointStatus).toHaveBeenCalledTimes(1);
  });

  it('backs off to 120 s, then 300 s, after failures, and recovers to 60 s', async () => {
    vi.mocked(kbApi.getSharePointStatus).mockRejectedValue(new Error('down'));
    stop = startConnectionStatusPolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(kbApi.getSharePointStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(119_000);
    expect(kbApi.getSharePointStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(kbApi.getSharePointStatus).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(299_000);
    expect(kbApi.getSharePointStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(kbApi.getSharePointStatus).toHaveBeenCalledTimes(3);

    vi.mocked(kbApi.getSharePointStatus).mockResolvedValue(OK_SP);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(kbApi.getSharePointStatus).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(kbApi.getSharePointStatus).toHaveBeenCalledTimes(5);
  });

  it('stops polling and removes its listeners when stopped', async () => {
    stop = startConnectionStatusPolling();
    await vi.advanceTimersByTimeAsync(0);
    stop();

    await vi.advanceTimersByTimeAsync(600_000);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);

    expect(kbApi.getSharePointStatus).toHaveBeenCalledTimes(1);
  });
});
