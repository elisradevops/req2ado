import { NotFoundException } from '@nestjs/common';
import { JobEventsController, runMapKey } from '../src/modules/pipeline/job-events.controller';
import { liveDoneKey } from '../src/modules/pipeline/live-channels';
import { progressChannel, progressLatestKey } from '../src/modules/pipeline/progress.service';
import { liveChannel, liveLatestKey } from '../src/modules/pipeline/live-channels';
import type { SessionUser } from '../src/modules/auth/session.service';

const OWNER: SessionUser = { userId: 'owner', displayName: 'Owner' };
const STRANGER: SessionUser = { userId: 'someone-else', displayName: 'Other' };
const fakeJobsService = { getById: jest.fn().mockResolvedValue({ userId: OWNER.userId }) };
const fakePrisma = { jobEvent: { findMany: jest.fn().mockResolvedValue([]) } };

const progressFrame = (seq: number, pct: number) => JSON.stringify({ type: 'progress', seq, pct, stage: 'draft' });

function makeRes(opts: { needDrain?: boolean } = {}) {
  const handlers: Record<string, (...args: any[]) => void> = {};
  return {
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    writableNeedDrain: opts.needDrain ?? false,
    on: jest.fn((event: string, handler: (...args: any[]) => void) => {
      handlers[event] = handler;
    }),
    __handlers: handlers,
  };
}

function makeSubscriber() {
  const handlers: Record<string, (...args: any[]) => void> = {};
  return {
    subscribe: jest.fn().mockResolvedValue(1),
    unsubscribe: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue(undefined),
    on: jest.fn((event: string, handler: (...args: any[]) => void) => {
      handlers[event] = handler;
    }),
    __handlers: handlers,
    fire: (channel: string, raw: string) => handlers.message?.(channel, raw),
  };
}

// Key-aware command client: the existing helper in job-events.controller.spec.ts
// returns the same value for every GET, which would hide key mix-ups here.
function makeCommandClient(
  values: Record<string, string> = {},
  onProgressGet?: () => void,
  hashes: Record<string, Record<string, string>> = {},
) {
  return {
    get: jest.fn(async (key: string) => {
      if (key.endsWith(':progress-latest')) onProgressGet?.();
      return values[key] ?? null;
    }),
    lrange: jest.fn().mockResolvedValue([]),
    hgetall: jest.fn(async (key: string) => hashes[key] ?? {}),
    disconnect: jest.fn(),
  };
}

function makeController(subscriber: unknown, command: unknown, liveProgress: boolean | undefined) {
  const factory = jest.fn().mockReturnValue(subscriber);
  const args: any[] = [factory, command, fakeJobsService, fakePrisma];
  if (liveProgress !== undefined) args.push(liveProgress);
  return new (JobEventsController as any)(...args) as JobEventsController;
}

describe('JobEventsController with LIVE_PROGRESS on', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('subscribes to the progress channel too and asks proxies not to buffer', async () => {
    const subscriber = makeSubscriber();
    const controller = makeController(subscriber, makeCommandClient(), true);
    const res = makeRes();
    await controller.streamEvents('job-1', res as any, OWNER);
    expect(subscriber.subscribe).toHaveBeenCalledWith('job-events:job-1', progressChannel('job-1'), liveChannel('job-1'));
    expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
  });

  it('forwards a progress message as an SSE progress frame, not a stage frame', async () => {
    const subscriber = makeSubscriber();
    const controller = makeController(subscriber, makeCommandClient(), true);
    const res = makeRes();
    await controller.streamEvents('job-1', res as any, OWNER);
    subscriber.fire(progressChannel('job-1'), progressFrame(1, 12));
    expect(res.write).toHaveBeenCalledWith(`event: progress\ndata: ${progressFrame(1, 12)}\n\n`);
    expect(res.write).not.toHaveBeenCalledWith(expect.stringContaining('event: stage'));
  });

  it('still forwards ordinary stage messages exactly as before', async () => {
    const subscriber = makeSubscriber();
    const controller = makeController(subscriber, makeCommandClient(), true);
    const res = makeRes();
    await controller.streamEvents('job-1', res as any, OWNER);
    subscriber.fire('job-events:job-1', JSON.stringify({ stage: 'parse' }));
    expect(res.write).toHaveBeenCalledWith('event: stage\ndata: {"stage":"parse"}\n\n');
  });

  it('replays the latest progress frame on connect', async () => {
    const subscriber = makeSubscriber();
    const latest = progressFrame(7, 31);
    const controller = makeController(subscriber, makeCommandClient({ [progressLatestKey('job-1')]: latest }), true);
    const res = makeRes();
    await controller.streamEvents('job-1', res as any, OWNER);
    expect(res.write).toHaveBeenCalledWith(`event: progress\ndata: ${latest}\n\n`);
  });

  it('delivers a progress frame that arrives while the replay is reading, once', async () => {
    const subscriber = makeSubscriber();
    const latest = progressFrame(7, 31);
    const newer = progressFrame(8, 33);
    const command = makeCommandClient({ [progressLatestKey('job-1')]: latest }, () => {
      subscriber.fire(progressChannel('job-1'), latest); // same frame published during the replay read
      subscriber.fire(progressChannel('job-1'), newer);
    });
    const controller = makeController(subscriber, command, true);
    const res = makeRes();
    await controller.streamEvents('job-1', res as any, OWNER);
    const progressWrites = res.write.mock.calls.map((c) => c[0] as string).filter((w) => w.startsWith('event: progress'));
    expect(progressWrites).toEqual([`event: progress\ndata: ${latest}\n\n`, `event: progress\ndata: ${newer}\n\n`]);
  });

  it('drops a progress frame instead of queueing it for a slow client', async () => {
    const subscriber = makeSubscriber();
    const controller = makeController(subscriber, makeCommandClient(), true);
    const res = makeRes({ needDrain: true });
    await controller.streamEvents('job-1', res as any, OWNER);
    subscriber.fire(progressChannel('job-1'), progressFrame(1, 12));
    expect(res.write).not.toHaveBeenCalled();
  });

  it('sends a keepalive comment every 15 seconds and stops after the client closes', async () => {
    jest.useFakeTimers();
    const subscriber = makeSubscriber();
    const controller = makeController(subscriber, makeCommandClient(), true);
    const res = makeRes();
    await controller.streamEvents('job-1', res as any, OWNER);
    jest.advanceTimersByTime(14_999);
    expect(res.write).not.toHaveBeenCalledWith(': keepalive\n\n');
    jest.advanceTimersByTime(1);
    expect(res.write).toHaveBeenCalledWith(': keepalive\n\n');
    res.__handlers.close();
    res.write.mockClear();
    jest.advanceTimersByTime(60_000);
    expect(res.write).not.toHaveBeenCalled();
  });

  describe('heartbeat (B11)', () => {
    const heartbeats = (res: ReturnType<typeof makeRes>) =>
      res.write.mock.calls
        .map((c) => c[0] as string)
        .filter((w) => w.startsWith('event: heartbeat'))
        .map((w) => JSON.parse(w.split('data: ')[1]));

    afterEach(() => jest.useRealTimers());

    it('sends a heartbeat with idle time and no work in flight on a quiet job', async () => {
      jest.useFakeTimers();
      const controller = makeController(makeSubscriber(), makeCommandClient(), true);
      const res = makeRes();
      await controller.streamEvents('job-1', res as any, OWNER);
      jest.advanceTimersByTime(15_000);
      const [beat] = heartbeats(res);
      expect(beat).toMatchObject({ type: 'heartbeat', idleSeconds: 15, inFlight: [] });
      expect(typeof beat.at).toBe('string');
      jest.advanceTimersByTime(15_000);
      expect(heartbeats(res)[1].idleSeconds).toBe(30);
    });

    it('lists the lanes still working and resets idle time when something is published', async () => {
      jest.useFakeTimers();
      const subscriber = makeSubscriber();
      const controller = makeController(subscriber, makeCommandClient(), true);
      const res = makeRes();
      await controller.streamEvents('job-1', res as any, OWNER);
      jest.advanceTimersByTime(10_000);
      subscriber.fire(liveChannel('job-1'), JSON.stringify({ type: 'live', seq: 1, lane: 1, kind: 'writing', ref: 'r2', title: 'Ripple' }));
      subscriber.fire(liveChannel('job-1'), JSON.stringify({ type: 'live', seq: 2, lane: 0, kind: 'working_on', ref: 'r1', title: 'Power' }));
      jest.advanceTimersByTime(5_000);
      const [beat] = heartbeats(res);
      expect(beat.idleSeconds).toBe(5);
      expect(beat.inFlight).toEqual([
        { lane: 0, kind: 'working_on', ref: 'r1', title: 'Power' },
        { lane: 1, kind: 'writing', ref: 'r2', title: 'Ripple' },
      ]);
    });

    it('drops a lane once its item is finished or its call is reset', async () => {
      jest.useFakeTimers();
      const subscriber = makeSubscriber();
      const controller = makeController(subscriber, makeCommandClient(), true);
      const res = makeRes();
      await controller.streamEvents('job-1', res as any, OWNER);
      const send = (seq: number, lane: number, kind: string) =>
        subscriber.fire(liveChannel('job-1'), JSON.stringify({ type: 'live', seq, lane, kind, ref: `r${lane}` }));
      send(1, 0, 'writing');
      send(2, 1, 'writing');
      send(3, 0, 'item');
      send(4, 1, 'reset');
      jest.advanceTimersByTime(15_000);
      expect(heartbeats(res)[0].inFlight).toEqual([]);
    });

    it('does not look idle to a client that reconnects mid-run, but does not hide a long silence', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-10-05T10:00:00.000Z'));
      const stale = JSON.stringify({ type: 'live', seq: 9, lane: 0, kind: 'writing', ref: 'r1', emittedAt: '2026-10-05T09:59:00.000Z' });
      const command = { ...makeCommandClient(), hgetall: jest.fn().mockResolvedValue({ '0': stale }) };
      const controller = makeController(makeSubscriber(), command as any, true);
      const res = makeRes();
      await controller.streamEvents('job-1', res as any, OWNER);
      jest.advanceTimersByTime(15_000);
      // Last published a minute before connecting: idle is the real gap, not 15.
      expect(heartbeats(res)[0].idleSeconds).toBe(75);
      expect(heartbeats(res)[0].inFlight).toHaveLength(1);
    });

    it('is not sent when live progress is off', async () => {
      jest.useFakeTimers();
      const controller = makeController(makeSubscriber(), makeCommandClient(), false);
      const res = makeRes();
      await controller.streamEvents('job-1', res as any, OWNER);
      jest.advanceTimersByTime(60_000);
      expect(heartbeats(res)).toEqual([]);
    });
  });

  it('stops the keepalive when the stream ends on a terminal stage', async () => {
    jest.useFakeTimers();
    const subscriber = makeSubscriber();
    const controller = makeController(subscriber, makeCommandClient(), true);
    const res = makeRes();
    await controller.streamEvents('job-1', res as any, OWNER);
    subscriber.fire('job-events:job-1', JSON.stringify({ stage: 'diff_ready' }));
    res.write.mockClear();
    jest.advanceTimersByTime(60_000);
    expect(res.write).not.toHaveBeenCalled();
  });
});

describe('JobEventsController live frames', () => {
  const liveFrame = (seq: number, lane: number, title = 't') =>
    JSON.stringify({ type: 'live', seq, lane, kind: 'writing', title });

  afterEach(() => jest.clearAllMocks());

  it('forwards a live message as an SSE live frame', async () => {
    const subscriber = makeSubscriber();
    const controller = makeController(subscriber, makeCommandClient(), true);
    const res = makeRes();
    await controller.streamEvents('job-1', res as any, OWNER);
    subscriber.fire(liveChannel('job-1'), liveFrame(1, 0));
    expect(res.write).toHaveBeenCalledWith(`event: live\ndata: ${liveFrame(1, 0)}\n\n`);
    expect(res.write).not.toHaveBeenCalledWith(expect.stringContaining('event: stage'));
  });

  it('replays the latest live frame of every lane on connect, oldest first', async () => {
    const subscriber = makeSubscriber();
    const hashes = { [liveLatestKey('job-1')]: { '1': liveFrame(9, 1), '0': liveFrame(5, 0) } };
    const controller = makeController(subscriber, makeCommandClient({}, undefined, hashes), true);
    const res = makeRes();
    await controller.streamEvents('job-1', res as any, OWNER);
    const live = res.write.mock.calls.map((c) => c[0] as string).filter((w) => w.startsWith('event: live'));
    expect(live).toEqual([`event: live\ndata: ${liveFrame(5, 0)}\n\n`, `event: live\ndata: ${liveFrame(9, 1)}\n\n`]);
  });

  it('does not repeat a live frame that was both replayed and buffered, and keeps newer ones', async () => {
    const subscriber = makeSubscriber();
    const replayed = liveFrame(5, 0);
    const newer = liveFrame(6, 0);
    const hashes = { [liveLatestKey('job-1')]: { '0': replayed } };
    const command = makeCommandClient({}, () => {
      subscriber.fire(liveChannel('job-1'), replayed);
      subscriber.fire(liveChannel('job-1'), newer);
    }, hashes);
    const controller = makeController(subscriber, command, true);
    const res = makeRes();
    await controller.streamEvents('job-1', res as any, OWNER);
    const live = res.write.mock.calls.map((c) => c[0] as string).filter((w) => w.startsWith('event: live'));
    expect(live).toEqual([`event: live\ndata: ${replayed}\n\n`, `event: live\ndata: ${newer}\n\n`]);
  });

  it('drops live frames for a slow client', async () => {
    const subscriber = makeSubscriber();
    const controller = makeController(subscriber, makeCommandClient(), true);
    const res = makeRes({ needDrain: true });
    await controller.streamEvents('job-1', res as any, OWNER);
    subscriber.fire(liveChannel('job-1'), liveFrame(1, 0));
    expect(res.write).not.toHaveBeenCalled();
  });

  it.each(['working_on', 'writing', 'ocr_page'])('drops a %s frame for a slow client: the next one replaces it', async (kind) => {
    const subscriber = makeSubscriber();
    const res = makeRes({ needDrain: true });
    await makeController(subscriber, makeCommandClient(), true).streamEvents('job-1', res as any, OWNER);
    subscriber.fire(liveChannel('job-1'), JSON.stringify({ type: 'live', seq: 1, lane: 0, kind }));
    expect(res.write).not.toHaveBeenCalled();
  });

  it.each(['item', 'compare', 'reset'])('still sends a %s frame to a slow client: nothing later recreates it', async (kind) => {
    const subscriber = makeSubscriber();
    const res = makeRes({ needDrain: true });
    await makeController(subscriber, makeCommandClient(), true).streamEvents('job-1', res as any, OWNER);
    const frame = JSON.stringify({ type: 'live', seq: 1, lane: 0, kind, ref: 'r1' });
    subscriber.fire(liveChannel('job-1'), frame);
    expect(res.write).toHaveBeenCalledWith(`event: live\ndata: ${frame}\n\n`);
  });

  it('delivers a burst of finished items to a slow client without losing one', async () => {
    const subscriber = makeSubscriber();
    const res = makeRes({ needDrain: true });
    await makeController(subscriber, makeCommandClient(), true).streamEvents('job-1', res as any, OWNER);
    for (let i = 1; i <= 300; i++) {
      subscriber.fire(liveChannel('job-1'), JSON.stringify({ type: 'live', seq: i, lane: 0, kind: 'item', ref: `r${i}` }));
    }
    expect(res.write.mock.calls.filter((c) => (c[0] as string).startsWith('event: live'))).toHaveLength(300);
  });

  it('survives a corrupt stored live frame when ordering the replay', async () => {
    const subscriber = makeSubscriber();
    const hashes = { [liveLatestKey('job-1')]: { '0': 'not json', '1': liveFrame(3, 1) } };
    const controller = makeController(subscriber, makeCommandClient({}, undefined, hashes), true);
    const res = makeRes();
    await expect(controller.streamEvents('job-1', res as any, OWNER)).resolves.toBeUndefined();
  });
});

describe('JobEventsController with LIVE_PROGRESS off', () => {
  it.each([false, undefined])('adds nothing new when the flag is %s', async (flag) => {
    jest.useFakeTimers();
    const subscriber = makeSubscriber();
    const command = makeCommandClient({ [progressLatestKey('job-1')]: progressFrame(1, 5) });
    const controller = makeController(subscriber, command, flag);
    const res = makeRes();
    await controller.streamEvents('job-1', res as any, OWNER);
    expect(subscriber.subscribe).toHaveBeenCalledWith('job-events:job-1');
    expect(res.setHeader).not.toHaveBeenCalledWith('X-Accel-Buffering', expect.anything());
    expect(command.get).not.toHaveBeenCalledWith(progressLatestKey('job-1'));
    jest.advanceTimersByTime(60_000);
    expect(res.write).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});

describe('JobEventsController.getRunMap', () => {
  const map = { version: 1, unit: 'headings', totalItems: 4 };

  it('returns the stored map to the job owner', async () => {
    const command = makeCommandClient({ [runMapKey('job-1')]: JSON.stringify(map) });
    const controller = makeController(makeSubscriber(), command, true);
    await expect(controller.getRunMap('job-1', OWNER)).resolves.toEqual(map);
  });

  it('is a 404 for anyone but the owner, without touching Redis', async () => {
    const command = makeCommandClient({ [runMapKey('job-1')]: JSON.stringify(map) });
    const controller = makeController(makeSubscriber(), command, true);
    await expect(controller.getRunMap('job-1', STRANGER)).rejects.toBeInstanceOf(NotFoundException);
    expect(command.get).not.toHaveBeenCalled();
  });

  it('is a 404 when the job does not exist', async () => {
    fakeJobsService.getById.mockResolvedValueOnce(null);
    const controller = makeController(makeSubscriber(), makeCommandClient(), true);
    await expect(controller.getRunMap('nope', OWNER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is a 404 when the feature is off', async () => {
    const command = makeCommandClient({ [runMapKey('job-1')]: JSON.stringify(map) });
    const controller = makeController(makeSubscriber(), command, false);
    await expect(controller.getRunMap('job-1', OWNER)).rejects.toBeInstanceOf(NotFoundException);
    expect(command.get).not.toHaveBeenCalled();
  });

  it('is a 404 when no map has been written yet', async () => {
    const controller = makeController(makeSubscriber(), makeCommandClient(), true);
    await expect(controller.getRunMap('job-1', OWNER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is a 404 when the stored value is not valid JSON', async () => {
    const command = makeCommandClient({ [runMapKey('job-1')]: '{not json' });
    const controller = makeController(makeSubscriber(), command, true);
    await expect(controller.getRunMap('job-1', OWNER)).rejects.toBeInstanceOf(NotFoundException);
  });
});


describe('JobEventsController.getRunDone', () => {
  const done = { det0_1_1: '1', det0_1_2: '1' };

  it('lists the finished refs to the job owner', async () => {
    const command = makeCommandClient({}, undefined, { [liveDoneKey('job-1')]: done });
    const controller = makeController(makeSubscriber(), command, true);
    const result = await controller.getRunDone('job-1', OWNER);
    expect([...result.refs].sort()).toEqual(['det0_1_1', 'det0_1_2']);
  });

  it('is an empty list, not an error, before anything has finished', async () => {
    const controller = makeController(makeSubscriber(), makeCommandClient(), true);
    await expect(controller.getRunDone('job-1', OWNER)).resolves.toEqual({ refs: [] });
  });

  it('is a 404 for anyone but the owner, without touching Redis', async () => {
    const command = makeCommandClient({}, undefined, { [liveDoneKey('job-1')]: done });
    const controller = makeController(makeSubscriber(), command, true);
    await expect(controller.getRunDone('job-1', STRANGER)).rejects.toBeInstanceOf(NotFoundException);
    expect(command.hgetall).not.toHaveBeenCalled();
  });

  it('is a 404 for a missing job and when the feature is off', async () => {
    fakeJobsService.getById.mockResolvedValueOnce(null);
    const missing = makeController(makeSubscriber(), makeCommandClient(), true);
    await expect(missing.getRunDone('nope', OWNER)).rejects.toBeInstanceOf(NotFoundException);
    const command = makeCommandClient({}, undefined, { [liveDoneKey('job-1')]: done });
    const off = makeController(makeSubscriber(), command, false);
    await expect(off.getRunDone('job-1', OWNER)).rejects.toBeInstanceOf(NotFoundException);
    expect(command.hgetall).not.toHaveBeenCalled();
  });
});
