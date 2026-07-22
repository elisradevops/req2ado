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
});
