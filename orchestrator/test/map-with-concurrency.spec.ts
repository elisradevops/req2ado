import { mapWithConcurrency } from '../src/modules/pipeline/map-with-concurrency';

describe('mapWithConcurrency', () => {
  it('returns results in the same order as the input items, regardless of completion order', async () => {
    const delays = [30, 10, 20];
    const results = await mapWithConcurrency(delays, 3, async (delay, i) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return i;
    });
    expect(results).toEqual([
      { status: 'fulfilled', value: 0 },
      { status: 'fulfilled', value: 1 },
      { status: 'fulfilled', value: 2 },
    ]);
  });

  it('never has more than `concurrency` calls in flight at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return item;
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('calls fn for every item even when some fail, and reports each outcome individually', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 3, async (item) => {
      if (item === 2) throw new Error('boom');
      return item * 10;
    });
    expect(results).toEqual([
      { status: 'fulfilled', value: 10 },
      { status: 'rejected', reason: new Error('boom') },
      { status: 'fulfilled', value: 30 },
    ]);
  });

  it('dispatches calls in item order when concurrency exceeds the item count', async () => {
    const callOrder: number[] = [];
    await mapWithConcurrency([1, 2, 3], 8, async (item) => {
      callOrder.push(item);
      return item;
    });
    expect(callOrder).toEqual([1, 2, 3]);
  });

  it('treats concurrency <= 0 as 1, never spawning zero workers', async () => {
    const results = await mapWithConcurrency([1, 2], 0, async (item) => item);
    expect(results).toEqual([
      { status: 'fulfilled', value: 1 },
      { status: 'fulfilled', value: 2 },
    ]);
  });

  it('returns an empty array for an empty input without calling fn', async () => {
    const fn = jest.fn();
    const results = await mapWithConcurrency([], 5, fn);
    expect(results).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});
