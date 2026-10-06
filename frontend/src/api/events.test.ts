import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { subscribeToJobEvents } from './events';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  withCredentials: boolean;
  closed = false;
  listeners: Record<string, ((event: MessageEvent) => void)[]> = {};

  constructor(url: string, options?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = options?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: MessageEvent) => void): void {
    (this.listeners[type] ??= []).push(handler);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    for (const handler of this.listeners[type] ?? []) {
      handler({ data: JSON.stringify(data) } as MessageEvent);
    }
  }
}

describe('subscribeToJobEvents', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens an EventSource against the job events endpoint and forwards parsed stage payloads', () => {
    const onStage = vi.fn();
    subscribeToJobEvents('job-1', 'https://api.example', onStage);

    const source = FakeEventSource.instances[0];
    expect(source.url).toBe('https://api.example/jobs/job-1/events');
    // Real regression: without this, the session cookie AuthGuard requires
    // is never sent (EventSource defaults to no credentials on a
    // cross-origin request), the SSE connection 401s, and the job silently
    // looks stuck forever even though it's progressing server-side.
    expect(source.withCredentials).toBe(true);

    source.emit('stage', { stage: 'parse' });
    expect(onStage).toHaveBeenCalledWith('parse');
  });

  it('forwards parsed narration payloads to onNarration', () => {
    const onNarration = vi.fn();
    subscribeToJobEvents('job-1', 'https://api.example', vi.fn(), onNarration);

    const source = FakeEventSource.instances[0];
    const narration = {
      phase: 'infer_hierarchy',
      branchIndex: 0,
      branchCount: 3,
      blocksDone: 10,
      blocksTotal: 50,
      kbGrounded: false,
      kbCitations: [],
      message: 'Analyzing structure (section 1 of 3)',
    };
    source.emit('narration', narration);

    expect(onNarration).toHaveBeenCalledWith(narration);
  });

  it('does not throw when a narration event arrives and onNarration is omitted', () => {
    subscribeToJobEvents('job-1', 'https://api.example', vi.fn());
    const source = FakeEventSource.instances[0];

    expect(() => source.emit('narration', { phase: 'infer_hierarchy', message: 'x' })).not.toThrow();
  });

  it('skips (and logs) a malformed narration payload instead of forwarding undefined fields', () => {
    // Previously a blind `as NarrationEvent` cast -- a shape mismatch (a
    // renamed/dropped field on the backend) silently propagated `undefined`
    // into typed state with no signal at all.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onNarration = vi.fn();
    subscribeToJobEvents('job-1', 'https://api.example', vi.fn(), onNarration);
    const source = FakeEventSource.instances[0];

    source.emit('narration', { phase: 'infer_hierarchy', message: 'x' }); // missing branchCount/blocksDone/etc

    expect(onNarration).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('skips (and logs) a narration payload with an unrecognized phase', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onNarration = vi.fn();
    subscribeToJobEvents('job-1', 'https://api.example', vi.fn(), onNarration);
    const source = FakeEventSource.instances[0];

    source.emit('narration', {
      phase: 'some_future_phase_this_frontend_does_not_know_about',
      branchIndex: 0,
      branchCount: 3,
      blocksDone: 10,
      blocksTotal: 50,
      kbGrounded: false,
      kbCitations: [],
      message: 'x',
    });

    expect(onNarration).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('skips (and logs) a malformed stage payload instead of forwarding an unrecognized stage', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onStage = vi.fn();
    subscribeToJobEvents('job-1', 'https://api.example', onStage);
    const source = FakeEventSource.instances[0];

    source.emit('stage', { stage: 'some_future_stage_this_frontend_does_not_know_about' });

    expect(onStage).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('calls onError on the native error event (previously no handling at all -- a silent infinite reconnect loop)', () => {
    const onError = vi.fn();
    subscribeToJobEvents('job-1', 'https://api.example', vi.fn(), undefined, onError);
    const source = FakeEventSource.instances[0];

    source.emit('error', {});

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('does not throw when an error event arrives and onError is omitted', () => {
    subscribeToJobEvents('job-1', 'https://api.example', vi.fn());
    const source = FakeEventSource.instances[0];

    expect(() => source.emit('error', {})).not.toThrow();
  });

  it('returns a function that closes the underlying EventSource', () => {
    const unsubscribe = subscribeToJobEvents('job-1', 'https://api.example', vi.fn());
    const source = FakeEventSource.instances[0];

    expect(source.closed).toBe(false);
    unsubscribe();
    expect(source.closed).toBe(true);
  });
});


describe('subscribeToJobEvents live run events', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const progress = {
    type: 'progress', seq: 3, pct: 42, stage: 'improve', unit: 'items', done: 12, total: 36,
    estimated: true, emittedAt: 'x',
  };
  const frame = { type: 'live', seq: 4, lane: 0, kind: 'item', ref: 'r1', title: 'Chassis size', emittedAt: 'x' };
  const beat = { type: 'heartbeat', at: 'x', idleSeconds: 15, inFlight: [{ lane: 0, kind: 'writing', ref: 'r1' }] };

  it('registers no live listeners unless handlers are given, so an older page is unaffected', () => {
    subscribeToJobEvents('job-1', 'https://api.example', vi.fn());
    const source = FakeEventSource.instances[0];
    expect(Object.keys(source.listeners).sort()).toEqual(['error', 'narration', 'stage']);
  });

  it('forwards valid progress, live and heartbeat events', () => {
    const handlers = { onProgress: vi.fn(), onLive: vi.fn(), onHeartbeat: vi.fn() };
    subscribeToJobEvents('job-1', 'https://api.example', vi.fn(), undefined, undefined, handlers);
    const source = FakeEventSource.instances[0];
    source.emit('progress', progress);
    source.emit('live', frame);
    source.emit('heartbeat', beat);
    expect(handlers.onProgress).toHaveBeenCalledWith(progress);
    expect(handlers.onLive).toHaveBeenCalledWith(frame);
    expect(handlers.onHeartbeat).toHaveBeenCalledWith(beat);
  });

  it('drops an unknown frame kind, stage or unit quietly (a newer backend may send more)', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handlers = { onProgress: vi.fn(), onLive: vi.fn() };
    subscribeToJobEvents('job-1', 'https://api.example', vi.fn(), undefined, undefined, handlers);
    const source = FakeEventSource.instances[0];
    source.emit('live', { ...frame, kind: 'telepathy' });
    source.emit('progress', { ...progress, stage: 'brand_new_stage' });
    source.emit('progress', { ...progress, unit: 'parsecs' });
    expect(handlers.onLive).not.toHaveBeenCalled();
    expect(handlers.onProgress).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledTimes(2); // a progress event is a known type, so a bad shape is reported
  });

  it('rejects out-of-range or malformed payloads without throwing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handlers = { onProgress: vi.fn(), onLive: vi.fn(), onHeartbeat: vi.fn() };
    subscribeToJobEvents('job-1', 'https://api.example', vi.fn(), undefined, undefined, handlers);
    const source = FakeEventSource.instances[0];
    source.emit('progress', { ...progress, pct: 140 });
    source.emit('progress', { ...progress, seq: 'x' });
    source.emit('live', { ...frame, lane: 'a' });
    source.emit('live', { type: 'live', seq: 1, lane: 0, kind: 'compare', compare: { kind: 'conflict' } });
    source.emit('heartbeat', { ...beat, idleSeconds: 'soon' });
    source.emit('heartbeat', { ...beat, inFlight: [{ lane: 0, kind: 'item' }] });
    for (const listener of source.listeners.live ?? []) listener({ data: 'not json' } as MessageEvent);
    expect(handlers.onProgress).not.toHaveBeenCalled();
    expect(handlers.onLive).not.toHaveBeenCalled();
    expect(handlers.onHeartbeat).not.toHaveBeenCalled();
  });

  it('accepts a complete compare frame', () => {
    const onLive = vi.fn();
    subscribeToJobEvents('job-1', 'https://api.example', vi.fn(), undefined, undefined, { onLive });
    const compare = {
      kind: 'duplicate', similarity: 0.9, a: { ref: 'proposed', text: 'one' }, b: { ref: 'ado-1', text: 'two' },
    };
    FakeEventSource.instances[0].emit('live', { type: 'live', seq: 5, lane: 0, kind: 'compare', compare, emittedAt: 'x' });
    expect(onLive).toHaveBeenCalledTimes(1);
  });

  const notice = {
    type: 'notice', id: 'n1', kind: 'output_limit_reached', severity: 'warning', count: 1,
    facts: { step: 'write', lastRef: 'r1' }, emittedAt: 'x',
  };

  it('forwards a valid notice and drops an unknown kind, severity or shape quietly', () => {
    const handlers = { onNotice: vi.fn() };
    subscribeToJobEvents('job-1', 'https://api.example', vi.fn(), undefined, undefined, handlers);
    const source = FakeEventSource.instances[0];
    source.emit('notice', notice);
    source.emit('notice', { ...notice, kind: 'from_the_future' });
    source.emit('notice', { ...notice, severity: 'fatal' });
    source.emit('notice', { ...notice, facts: null });
    source.emit('notice', { ...notice, count: 'many' });
    expect(handlers.onNotice).toHaveBeenCalledTimes(1);
    expect(handlers.onNotice).toHaveBeenCalledWith(notice);
  });
});
