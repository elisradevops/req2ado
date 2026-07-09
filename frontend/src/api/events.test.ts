import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { subscribeToJobEvents } from './events';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  listeners: Record<string, ((event: MessageEvent) => void)[]> = {};

  constructor(url: string) {
    this.url = url;
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

    source.emit('stage', { stage: 'parse' });
    expect(onStage).toHaveBeenCalledWith('parse');
  });

  it('returns a function that closes the underlying EventSource', () => {
    const unsubscribe = subscribeToJobEvents('job-1', 'https://api.example', vi.fn());
    const source = FakeEventSource.instances[0];

    expect(source.closed).toBe(false);
    unsubscribe();
    expect(source.closed).toBe(true);
  });
});
