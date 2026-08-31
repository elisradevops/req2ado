import {
  MAX_REPLAY_BUFFER_ENTRIES,
  mergeReplayBuffer,
  pushBoundedReplayBuffer,
} from '../src/modules/pipeline/sse-replay-merge';

// Fixtures use the REAL wire shape both producers emit -- one JSON.stringify
// per event, `emittedAt` stamped at publish time (see sse-replay-merge.ts's
// own doc comment for why full-string identity is the dedup key). Building
// these through JSON.stringify rather than hand-writing the strings keeps the
// tests honest about what actually travels on the channel.
const narration = (overrides: Record<string, unknown>) =>
  JSON.stringify({ type: 'narration', phase: 'analyze_section', message: 'Analyzing section 1', emittedAt: '2026-08-31T09:00:00.000Z', ...overrides });
const stage = (overrides: Record<string, unknown>) =>
  JSON.stringify({ stage: 'infer_hierarchy_start', emittedAt: '2026-08-31T09:00:00.000Z', ...overrides });

describe('mergeReplayBuffer', () => {
  it('returns an empty array when nothing was buffered during the replay read', () => {
    expect(mergeReplayBuffer([stage({}), narration({})], [])).toEqual([]);
  });

  it('returns every buffered entry when the replay snapshot is empty -- a fresh job with no history', () => {
    const a = narration({ message: 'a' });
    const b = narration({ message: 'b' });
    expect(mergeReplayBuffer([], [a, b])).toEqual([a, b]);
  });

  it('drops a buffered entry byte-identical to a replayed one -- the exact double-delivery this fix must not introduce', () => {
    // The producer serializes ONCE and uses that same string for both the
    // RPUSH into the narration-log and the PUBLISH, so an event that lands
    // in the window arrives via LRANGE and via the live buffer as the
    // identical string.
    const duplicated = narration({ message: 'Analyzing section 3' });
    expect(mergeReplayBuffer([duplicated], [duplicated])).toEqual([]);
  });

  it('keeps a buffered entry that differs from a replayed one only in emittedAt -- two genuinely distinct publishes must not be collapsed', () => {
    const earlier = narration({ emittedAt: '2026-08-31T09:00:00.000Z' });
    const later = narration({ emittedAt: '2026-08-31T09:00:00.001Z' });
    expect(mergeReplayBuffer([earlier], [later])).toEqual([later]);
  });

  it('removes at most ONE buffered occurrence per replayed occurrence -- count-aware, not set-membership', () => {
    // Replay saw X once; the buffer holds X twice. Only one of the two is
    // the replay's duplicate -- the other is a genuine second publish and
    // must survive. A Set.has() implementation drops both and loses a real
    // event; this is the case that rules that implementation out.
    const x = narration({ message: 'Analyzing section 4' });
    expect(mergeReplayBuffer([x], [x, x])).toEqual([x]);
  });

  it('removes two buffered occurrences when the replay snapshot itself held two', () => {
    const x = narration({ message: 'Analyzing section 4' });
    expect(mergeReplayBuffer([x, x], [x, x])).toEqual([]);
  });

  it('preserves buffer order and only removes the duplicates', () => {
    const replayedStage = stage({});
    const dup = narration({ message: 'dup' });
    const fresh1 = narration({ message: 'fresh-1' });
    const fresh2 = narration({ message: 'fresh-2' });
    expect(mergeReplayBuffer([replayedStage, dup], [fresh1, dup, fresh2])).toEqual([fresh1, fresh2]);
  });

  it('does not dedupe a stage frame against a narration frame or vice versa', () => {
    const s = stage({});
    const n = narration({});
    expect(mergeReplayBuffer([s], [n])).toEqual([n]);
    expect(mergeReplayBuffer([n], [s])).toEqual([s]);
  });

  it('drops a terminal stage from the buffer when the replay GET already returned that exact payload', () => {
    // The stage :current key is SET with the same string that is published,
    // so a terminal stage landing in the window can appear in both places.
    // Delivering it twice would make the client run its terminal handling
    // twice; dropping it entirely would stall the client. Exactly once.
    const terminal = stage({ stage: 'diff_ready' });
    expect(mergeReplayBuffer([terminal], [terminal])).toEqual([]);
  });

  it('mutates neither input array', () => {
    const x = narration({});
    const replayed = [x];
    const buffered = [x, narration({ message: 'other' })];
    mergeReplayBuffer(replayed, buffered);
    expect(replayed).toHaveLength(1);
    expect(buffered).toHaveLength(2);
  });
});

describe('pushBoundedReplayBuffer', () => {
  it('appends while under the cap', () => {
    const buffer: string[] = [];
    pushBoundedReplayBuffer(buffer, 'a');
    pushBoundedReplayBuffer(buffer, 'b');
    expect(buffer).toEqual(['a', 'b']);
  });

  it('caps at MAX_REPLAY_BUFFER_ENTRIES, evicting the oldest', () => {
    const buffer: string[] = [];
    for (let i = 0; i < MAX_REPLAY_BUFFER_ENTRIES + 5; i += 1) pushBoundedReplayBuffer(buffer, `e${i}`);
    expect(buffer).toHaveLength(MAX_REPLAY_BUFFER_ENTRIES);
    expect(buffer[0]).toBe('e5');
    expect(buffer[buffer.length - 1]).toBe(`e${MAX_REPLAY_BUFFER_ENTRIES + 4}`);
  });

  it('keeps the NEWEST entries on overflow, so a terminal stage published during the window can never be the one evicted', () => {
    // Nothing is ever published after a terminal stage, so a terminal stage
    // can only be evicted by 50 further publishes that cannot exist. This
    // is why the eviction policy needs no terminal-message special case.
    const buffer: string[] = [];
    for (let i = 0; i < MAX_REPLAY_BUFFER_ENTRIES; i += 1) pushBoundedReplayBuffer(buffer, `filler-${i}`);
    pushBoundedReplayBuffer(buffer, 'terminal');
    expect(buffer).toContain('terminal');
    expect(buffer).not.toContain('filler-0');
  });

  it('matches the cap every other narration store in the system already uses', () => {
    // NARRATION_LOG_MAX_ENTRIES (job-events.publisher.ts),
    // _NARRATION_LOG_MAX_ENTRIES (narration_publisher.py) and
    // JobDetail.tsx's own `.slice(-50)` client-side history cap. A fourth,
    // different number here would be a new magic value for no gain.
    expect(MAX_REPLAY_BUFFER_ENTRIES).toBe(50);
  });
});
