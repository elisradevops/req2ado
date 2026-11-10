import { JobEventsPublisher } from '../src/modules/pipeline/job-events.publisher';

// Asserting on the parsed object (with emittedAt checked separately as "a
// real ISO timestamp", not a fixed string) rather than an exact
// JSON.stringify string match -- emittedAt's value is real wall-clock time
// and can never be pinned to a literal string in a test.
function parsePublishedPayload(mockFn: jest.Mock, callIndex = 0): Record<string, unknown> {
  return JSON.parse(mockFn.mock.calls[callIndex][mockFn.mock.calls[callIndex].length - 1] as string);
}

describe('JobEventsPublisher', () => {
  it('publishes a JSON stage payload to the job-scoped channel, with a real emittedAt timestamp', async () => {
    const redis = { publish: jest.fn().mockResolvedValue(1), set: jest.fn().mockResolvedValue('OK') };
    const publisher = new JobEventsPublisher(redis as any);

    await publisher.publish('job-1', 'infer_hierarchy_start');

    expect(redis.publish).toHaveBeenCalledWith('job-events:job-1', expect.any(String));
    const payload = parsePublishedPayload(redis.publish);
    expect(payload.stage).toBe('infer_hierarchy_start');
    expect(new Date(payload.emittedAt as string).toString()).not.toBe('Invalid Date');
  });

  it('persists the last-known stage with an expiry so a later reconnect can replay it', async () => {
    const redis = { publish: jest.fn().mockResolvedValue(1), set: jest.fn().mockResolvedValue('OK') };
    const publisher = new JobEventsPublisher(redis as any);

    await publisher.publish('job-1', 'diff_ready');

    expect(redis.set).toHaveBeenCalledWith('job-events:job-1:current', expect.any(String), 'EX', 3600);
    const payload = JSON.parse(redis.set.mock.calls[0][1] as string);
    expect(payload.stage).toBe('diff_ready');
  });

  it('publishNarration fills in the NarrationEvent-required defaults a caller does not supply', async () => {
    // Previously the dedup-check burst and Confirm/writing phase published
    // nothing at all -- this is the orchestrator-side counterpart to
    // ingestion's own narration events, and must match frontend
    // NarrationEvent's shape exactly (branchIndex/branchCount/kbGrounded/
    // kbCitations are declared REQUIRED there, not optional).
    const redis = {
      publish: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue('OK'),
      rpush: jest.fn().mockResolvedValue(1),
      ltrim: jest.fn().mockResolvedValue('OK'),
      expire: jest.fn().mockResolvedValue(1),
    };
    const publisher = new JobEventsPublisher(redis as any);

    await publisher.publishNarration('job-1', {
      phase: 'dedup_check',
      blocksDone: 3,
      blocksTotal: 543,
      message: 'Checking for existing/duplicate work items -- 3 of 543',
    });

    const expectedFields = {
      type: 'narration',
      branchIndex: null,
      branchCount: 0,
      kbGrounded: false,
      kbCitations: [],
      phase: 'dedup_check',
      blocksDone: 3,
      blocksTotal: 543,
      message: 'Checking for existing/duplicate work items -- 3 of 543',
    };
    const publishedPayload = parsePublishedPayload(redis.publish);
    expect(publishedPayload).toEqual(expect.objectContaining(expectedFields));
    expect(new Date(publishedPayload.emittedAt as string).toString()).not.toBe('Invalid Date');
    const rpushPayload = JSON.parse(redis.rpush.mock.calls[0][1] as string);
    expect(rpushPayload).toEqual(expect.objectContaining(expectedFields));
  });

  it('bounds and refreshes the expiry of the narration log so a reconnect can replay recent history', async () => {
    // Real gap this closes: previously a single SET-overwritten key meant a
    // reconnecting client could only ever replay the LATEST narration
    // event, losing all prior activity-log history on any page reload.
    const redis = {
      publish: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue('OK'),
      rpush: jest.fn().mockResolvedValue(1),
      ltrim: jest.fn().mockResolvedValue('OK'),
      expire: jest.fn().mockResolvedValue(1),
    };
    const publisher = new JobEventsPublisher(redis as any);

    await publisher.publishNarration('job-1', {
      phase: 'writing',
      blocksDone: 1,
      blocksTotal: 1,
      message: 'Writing work items to Azure DevOps',
    });

    expect(redis.ltrim).toHaveBeenCalledWith('job-events:job-1:narration-log', -50, -1);
    expect(redis.expire).toHaveBeenCalledWith('job-events:job-1:narration-log', 3600);
  });
});

describe('JobEventsPublisher: overview (primer) heartbeat lines', () => {
  const listRedis = () => {
    const list: string[] = [];
    return {
      list,
      redis: {
        rpush: jest.fn(async (_k: string, v: string) => list.push(v)),
        ltrim: jest.fn(async () => 'OK'),
        expire: jest.fn(async () => 1),
        publish: jest.fn(async () => 1),
        lindex: jest.fn(async (_k: string, i: number) => list.at(i) ?? null),
        lset: jest.fn(async (_k: string, i: number, v: string) => {
          list[list.length + i] = v;
          return 'OK';
        }),
      },
    };
  };
  const primer = (primerStep: string, elapsedSeconds: number) => ({
    phase: 'primer' as const, blocksDone: 0, blocksTotal: 0, message: `${primerStep} ${elapsedSeconds}`, primerStep: primerStep as any, elapsedSeconds,
  });

  it('keeps one entry per overview step in the replay list, the newest timer replacing the older one', async () => {
    const { list, redis } = listRedis();
    const publisher = new JobEventsPublisher(redis as any);
    for (const seconds of [0, 10, 20, 30]) await publisher.publishNarration('job-1', primer('reading', seconds));
    expect(list).toHaveLength(1);
    expect(JSON.parse(list[0]).elapsedSeconds).toBe(30);
  });

  it('still sends every line live, so the screen keeps ticking', async () => {
    const { redis } = listRedis();
    const publisher = new JobEventsPublisher(redis as any);
    for (const seconds of [0, 10, 20]) await publisher.publishNarration('job-1', primer('reading', seconds));
    expect(redis.publish).toHaveBeenCalledTimes(3);
  });

  it('adds a new entry when the step changes, and never merges anything but overview lines', async () => {
    const { list, redis } = listRedis();
    const publisher = new JobEventsPublisher(redis as any);
    await publisher.publishNarration('job-1', primer('uploading', 1));
    await publisher.publishNarration('job-1', primer('processing', 5));
    await publisher.publishNarration('job-1', primer('reading', 9));
    await publisher.publishNarration('job-1', { phase: 'dedup_check', blocksDone: 1, blocksTotal: 3, message: 'a' });
    await publisher.publishNarration('job-1', { phase: 'dedup_check', blocksDone: 2, blocksTotal: 3, message: 'b' });
    expect(list.map((l) => JSON.parse(l).phase)).toEqual(['primer', 'primer', 'primer', 'dedup_check', 'dedup_check']);
  });
});
