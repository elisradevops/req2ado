import { JobEventsPublisher } from '../src/modules/pipeline/job-events.publisher';

describe('JobEventsPublisher', () => {
  it('publishes a JSON stage payload to the job-scoped channel', async () => {
    const redis = { publish: jest.fn().mockResolvedValue(1) };
    const publisher = new JobEventsPublisher(redis as any);

    await publisher.publish('job-1', 'infer_hierarchy_start');

    expect(redis.publish).toHaveBeenCalledWith('job-events:job-1', JSON.stringify({ stage: 'infer_hierarchy_start' }));
  });
});
