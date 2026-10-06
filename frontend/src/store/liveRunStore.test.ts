import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FLUSH_INTERVAL_MS, useLiveRunStore } from './liveRunStore';
import type { Heartbeat, LiveFrame, ProgressEvent } from '../api/liveTypes';

const progress = (seq: number, pct: number, extra: Partial<ProgressEvent> = {}): ProgressEvent => ({
  type: 'progress', seq, pct, stage: 'improve', unit: 'items', done: pct, total: 100, estimated: true,
  emittedAt: 'x', ...extra,
});
const frame = (seq: number, lane: number, kind: LiveFrame['kind'], extra: Partial<LiveFrame> = {}): LiveFrame => ({
  type: 'live', seq, lane, kind, emittedAt: 'x', ...extra,
});
const beat = (idleSeconds: number): Heartbeat => ({ type: 'heartbeat', at: 'x', idleSeconds, inFlight: [] });

const store = () => useLiveRunStore.getState();
const tick = () => vi.advanceTimersByTime(FLUSH_INTERVAL_MS);

describe('liveRunStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store().reset();
    store().begin('job-1');
  });
  afterEach(() => vi.useRealTimers());

  it('applies nothing until the batch interval passes, then everything together', () => {
    store().ingestProgress(progress(1, 10));
    store().ingestLive(frame(1, 0, 'working_on', { ref: 'r1', excerpt: 'text' }));
    expect(store().progress).toBeNull();
    expect(store().active).toBe(false);
    tick();
    expect(store().progress?.pct).toBe(10);
    expect(store().lanes[0]).toMatchObject({ kind: 'working_on', ref: 'r1', excerpt: 'text' });
    expect(store().active).toBe(true);
  });

  it('notifies subscribers at most four times a second however many events arrive', () => {
    const listener = vi.fn();
    const unsubscribe = useLiveRunStore.subscribe(listener);
    for (let i = 1; i <= 200; i++) store().ingestLive(frame(i, 0, 'working_on', { ref: `r${i}` }));
    tick();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store().lanes[0].ref).toBe('r200');
    unsubscribe();
  });

  it('drops a stale or replayed progress event but accepts a newer one', () => {
    store().ingestProgress(progress(5, 50));
    tick();
    store().ingestProgress(progress(4, 40));
    store().ingestProgress(progress(5, 50));
    tick();
    expect(store().progress?.seq).toBe(5);
    store().ingestProgress(progress(6, 55));
    tick();
    expect(store().progress?.pct).toBe(55);
  });

  it('drops a replayed frame older than what a lane already shows', () => {
    store().ingestLive(frame(10, 0, 'working_on', { ref: 'new' }));
    tick();
    store().ingestLive(frame(7, 0, 'working_on', { ref: 'old' }));
    store().ingestLive(frame(10, 0, 'working_on', { ref: 'dup' }));
    tick();
    expect(store().lanes[0].ref).toBe('new');
  });

  it('keeps lanes independent, so a concurrent chunk does not overwrite another', () => {
    store().ingestLive(frame(1, 0, 'working_on', { ref: 'a' }));
    store().ingestLive(frame(2, 1, 'writing', { ref: 'b' }));
    store().ingestLive(frame(3, 0, 'working_on', { ref: 'c' }));
    tick();
    expect(store().lanes[0].ref).toBe('c');
    expect(store().lanes[1]).toMatchObject({ kind: 'writing', ref: 'b' });
  });

  it('records finished items once, by ref, and counts them', () => {
    store().ingestLive(frame(1, 0, 'item', { ref: 'r1', title: 'Chassis size' }));
    store().ingestLive(frame(2, 0, 'item', { ref: 'r2', title: 'Ripple' }));
    store().ingestLive(frame(3, 1, 'item', { ref: 'r1', title: 'again' }));
    tick();
    expect(store().doneCount).toBe(2);
    expect(store().doneRefs.r1.title).toBe('Chassis size');
  });

  it('keeps the last few finished items, newest first', () => {
    for (let i = 1; i <= 6; i++) store().ingestLive(frame(i, 0, 'item', { ref: `r${i}`, title: `T${i}` }));
    tick();
    expect(store().recent.map((item) => item.ref)).toEqual(['r6', 'r5', 'r4', 'r3']);
  });

  it('clears a lane on reset but keeps finished items', () => {
    store().ingestLive(frame(1, 0, 'working_on', { ref: 'r1' }));
    store().ingestLive(frame(2, 0, 'item', { ref: 'r1', title: 'T' }));
    store().ingestLive(frame(3, 0, 'reset'));
    tick();
    expect(store().lanes[0]).toBeUndefined();
    expect(store().doneRefs.r1).toBeDefined();
  });

  it('keeps the latest comparison and the latest heartbeat', () => {
    const compare = { kind: 'conflict' as const, similarity: 0.9, a: { ref: 'a', text: '1' }, b: { ref: 'b', text: '2' } };
    store().ingestLive(frame(1, 0, 'compare', { compare }));
    store().ingestHeartbeat(beat(15));
    store().ingestHeartbeat(beat(30));
    tick();
    expect(store().compare?.payload).toEqual(compare);
    expect(store().heartbeat?.idleSeconds).toBe(30);
  });

  it('holds events while the tab is hidden and applies them when it returns', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    store().ingestProgress(progress(1, 20));
    tick();
    vi.advanceTimersByTime(5000);
    expect(store().progress).toBeNull();
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(store().progress?.pct).toBe(20);
    visibility.mockRestore();
  });

  it('bounds the queue while hidden and never drops a finished item to make room', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    store().ingestLive(frame(1, 0, 'item', { ref: 'keep-me', title: 'T' }));
    for (let i = 2; i < 2500; i++) store().ingestLive(frame(i, 1, 'working_on', { ref: `w${i}` }));
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(store().doneRefs['keep-me']).toBeDefined();
    expect(store().lanes[1].ref).toBe('w2499');
    visibility.mockRestore();
  });

  it('forgets everything when a different job begins, and ignores late events of the old one', () => {
    store().ingestProgress(progress(1, 10));
    tick();
    store().ingestProgress(progress(2, 20)); // queued, not yet applied
    store().begin('job-2');
    tick();
    expect(store().jobId).toBe('job-2');
    expect(store().progress).toBeNull();
    store().begin('job-2'); // same job again keeps state
    store().ingestProgress(progress(1, 5));
    tick();
    store().begin('job-2');
    expect(store().progress?.pct).toBe(5);
  });

  it('seeds items finished before the page connected, without overwriting what the stream said', () => {
    store().ingestLive(frame(5, 0, 'item', { ref: 'r1', title: 'From the stream' }));
    tick();
    store().seedDone(['r1', 'r2', 'r3']);
    expect(store().doneCount).toBe(3);
    expect(store().doneRefs.r1.title).toBe('From the stream');
    expect(store().doneRefs.r2.title).toBeNull();
    const before = store().doneRefs;
    store().seedDone(['r2']);
    expect(store().doneRefs).toBe(before); // nothing new, no new state object
    expect(store().active).toBe(true); // set by the stream frame, not by seeding
  });

  it('seeding alone does not claim the live feature is on', () => {
    store().seedDone(['r1']);
    expect(store().active).toBe(false);
  });

  it('stamps activity for progress and live frames but not for heartbeats', () => {
    store().ingestHeartbeat(beat(15));
    tick();
    expect(store().activityAt).toBeNull();
    expect(store().lastEventAt).not.toBeNull();
    store().ingestProgress(progress(1, 10));
    tick();
    expect(store().activityAt).not.toBeNull();
  });

  it('touch marks the connection alive and clears a recorded error', () => {
    store().markError();
    expect(store().errorAt).not.toBeNull();
    store().touch();
    expect(store().errorAt).toBeNull();
    expect(store().lastEventAt).not.toBeNull();
  });
});
