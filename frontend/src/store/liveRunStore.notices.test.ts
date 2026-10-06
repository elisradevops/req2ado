import { describe, it, expect, beforeEach } from 'vitest';
import { mergeNotice, useLiveRunStore } from './liveRunStore';
import type { Notice } from '../api/liveTypes';

const make = (kind: Notice['kind'], id: string, count = 1): Notice => ({
  type: 'notice', id, kind, severity: 'info', count, facts: {}, emittedAt: 'x',
});

describe('notices in the live run store', () => {
  beforeEach(() => {
    useLiveRunStore.getState().reset();
    useLiveRunStore.getState().begin('job-1');
  });

  it('keeps one entry per kind, in the order first seen, with the highest count', () => {
    let list: Notice[] = [];
    list = mergeNotice(list, make('server_retry', 'a'));
    list = mergeNotice(list, make('context_assumed', 'b'));
    list = mergeNotice(list, make('server_retry', 'c', 3));
    list = mergeNotice(list, make('server_retry', 'd', 2)); // an older replay never lowers the count
    expect(list.map((n) => [n.kind, n.count])).toEqual([['server_retry', 3], ['context_assumed', 1]]);
  });

  it('ignores a replay of the same notice', () => {
    const first = [make('server_retry', 'a')];
    expect(mergeNotice(first, make('server_retry', 'a'))).toBe(first);
  });

  it('applies a notice at once and clears it when a different job begins', () => {
    useLiveRunStore.getState().ingestNotice(make('stream_fallback', 'a'));
    expect(useLiveRunStore.getState().notices).toHaveLength(1);
    useLiveRunStore.getState().begin('job-2');
    expect(useLiveRunStore.getState().notices).toEqual([]);
  });
});
