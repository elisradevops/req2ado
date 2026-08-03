import { JobEventsPublisher } from '../src/modules/pipeline/job-events.publisher';

describe('JobEventsPublisher', () => {
  it('publishes a JSON stage payload to the job-scoped channel', async () => {
    const redis = { publish: jest.fn().mockResolvedValue(1), set: jest.fn().mockResolvedValue('OK') };
    const publisher = new JobEventsPublisher(redis as any);

    await publisher.publish('job-1', 'infer_hierarchy_start');

    expect(redis.publish).toHaveBeenCalledWith('job-events:job-1', JSON.stringify({ stage: 'infer_hierarchy_start' }));
  });

  it('persists the last-known stage with an expiry so a later reconnect can replay it', async () => {
    const redis = { publish: jest.fn().mockResolvedValue(1), set: jest.fn().mockResolvedValue('OK') };
    const publisher = new JobEventsPublisher(redis as any);

    await publisher.publish('job-1', 'diff_ready');

    expect(redis.set).toHaveBeenCalledWith(
      'job-events:job-1:current',
      JSON.stringify({ stage: 'diff_ready' }),
      'EX',
      3600,
    );
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

    const expectedPayload = JSON.stringify({
      type: 'narration',
      branchIndex: null,
      branchCount: 0,
      kbGrounded: false,
      kbCitations: [],
      phase: 'dedup_check',
      blocksDone: 3,
      blocksTotal: 543,
      message: 'Checking for existing/duplicate work items -- 3 of 543',
    });
    expect(redis.publish).toHaveBeenCalledWith('job-events:job-1', expectedPayload);
    expect(redis.rpush).toHaveBeenCalledWith('job-events:job-1:narration-log', expectedPayload);
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
