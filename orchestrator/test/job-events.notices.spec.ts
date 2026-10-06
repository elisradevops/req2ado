import { JobEventsController } from '../src/modules/pipeline/job-events.controller';
import type { SessionUser } from '../src/modules/auth/session.service';

const OWNER: SessionUser = { userId: 'owner', displayName: 'Owner' };
const fakeJobsService = { getById: jest.fn().mockResolvedValue({ userId: OWNER.userId }) };
const fakePrisma = { jobEvent: { findMany: jest.fn().mockResolvedValue([]) } };

const notice = (kind: string, count = 1) =>
  JSON.stringify({ type: 'notice', id: `${kind}-${count}`, kind, severity: 'warning', count, facts: {}, emittedAt: 'x' });

function makeRes() {
  return {
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    writableNeedDrain: false,
    on: jest.fn(),
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
    fire: (channel: string, raw: string) => handlers.message?.(channel, raw),
  };
}

function makeCommand(noticeLog: string[] = []) {
  return {
    get: jest.fn().mockResolvedValue(null),
    lrange: jest.fn(async (key: string) => (key.endsWith(':notices') ? noticeLog : [])),
    hgetall: jest.fn().mockResolvedValue({}),
    disconnect: jest.fn(),
  };
}

function makeController(subscriber: unknown, command: unknown, liveProgress: boolean) {
  const factory = jest.fn().mockReturnValue(subscriber);
  return new (JobEventsController as any)(factory, command, fakeJobsService, fakePrisma, liveProgress) as JobEventsController;
}

describe('typed notices on the job event stream', () => {
  afterEach(() => jest.clearAllMocks());

  it('relays a live notice as an SSE notice frame, never as a stage frame', async () => {
    const subscriber = makeSubscriber();
    const res = makeRes();
    await makeController(subscriber, makeCommand(), true).streamEvents('job-1', res as any, OWNER);
    subscriber.fire('job-events:job-1', notice('server_retry'));
    expect(res.write).toHaveBeenCalledWith(`event: notice\ndata: ${notice('server_retry')}\n\n`);
    expect(res.write).not.toHaveBeenCalledWith(expect.stringContaining('event: stage'));
    expect(res.end).not.toHaveBeenCalled();
  });

  it('replays the stored notices on connect when live progress is on', async () => {
    const stored = [notice('context_assumed'), notice('output_limit_reached')];
    const command = makeCommand(stored);
    const res = makeRes();
    await makeController(makeSubscriber(), command, true).streamEvents('job-1', res as any, OWNER);
    expect(command.lrange).toHaveBeenCalledWith('job-events:job-1:notices', 0, -1);
    const writes = res.write.mock.calls.map((c: unknown[]) => c[0]);
    expect(writes).toContain(`event: notice\ndata: ${stored[0]}\n\n`);
    expect(writes).toContain(`event: notice\ndata: ${stored[1]}\n\n`);
  });

  it('does not read the notice list with live progress off', async () => {
    const command = makeCommand([notice('server_retry')]);
    await makeController(makeSubscriber(), command, false).streamEvents('job-1', makeRes() as any, OWNER);
    expect(command.lrange).not.toHaveBeenCalledWith('job-events:job-1:notices', 0, -1);
  });

  it('delivers a notice that is both replayed and buffered during replay exactly once', async () => {
    const dup = notice('server_retry');
    const subscriber = makeSubscriber();
    const command = makeCommand([dup]);
    command.lrange.mockImplementation(async (key: string) => {
      if (key.endsWith(':notices')) subscriber.fire('job-events:job-1', dup);
      return key.endsWith(':notices') ? [dup] : [];
    });
    const res = makeRes();
    await makeController(subscriber, command, true).streamEvents('job-1', res as any, OWNER);
    const hits = res.write.mock.calls.filter((c: unknown[]) => c[0] === `event: notice\ndata: ${dup}\n\n`);
    expect(hits).toHaveLength(1);
  });
});
