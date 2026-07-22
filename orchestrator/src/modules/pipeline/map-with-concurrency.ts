export type SettledResult<R> = { status: 'fulfilled'; value: R } | { status: 'rejected'; reason: unknown };

/**
 * Like Promise.allSettled(items.map(fn)), but caps how many `fn` calls are
 * in flight at once instead of firing all of them simultaneously -- used by
 * JobsService.confirm() to bound how many concurrent ADO write calls a
 * single confirm() makes (previously fully sequential, one at a time).
 *
 * Results are returned in the SAME order as `items`, regardless of
 * completion order -- callers can zip them back against the original
 * array safely. `concurrency <= 0` is treated as 1 (never zero workers).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<SettledResult<R>[]> {
  const results: SettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }

  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
