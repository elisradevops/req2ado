import { JobResultCache, hashCatalog, kbVersionFor, type ResultCacheStore } from '../src/modules/pipeline/result-cache';

const memoryStore = (): ResultCacheStore & { data: Map<string, string>; sets: number } => {
  const data = new Map<string, string>();
  const store = {
    data,
    sets: 0,
    get: async (key: string) => data.get(key) ?? null,
    set: async (key: string, value: string) => {
      data.set(key, value);
      store.sets += 1;
      return 'OK';
    },
  };
  return store;
};

const parts = { fileHash: 'f1', userId: 'u1', model: 'claude-opus-4-8', mode: 'survey', kbVersion: 'kb1', ingestionVersion: '0.3.15', profileVersion: 'p1' as string | null };
const result = { doc: { blocks: [] }, tree: { nodes: [{ local_id: 'n0' }] }, catalogHash: 'c1' };

describe('JobResultCache', () => {
  it('returns the stored result for the same file, user, model, mode, KB and code version', async () => {
    const cache = new JobResultCache(memoryStore(), 'code-1');
    await cache.save(cache.keyFor(parts), result);
    expect(await cache.lookup(cache.keyFor({ ...parts }))).toEqual(result);
  });

  it.each([
    ['another file', { fileHash: 'f2' }],
    ['another user (KB scope)', { userId: 'u2' }],
    ['another model', { model: 'OpenAI/gpt-5.6-terra' }],
    ['another mode', { mode: 'baseline' }],
    ['a changed KB', { kbVersion: 'kb2' }],
    ['another ingestion build (an ingestion-only release must not serve the old tree)', { ingestionVersion: '0.3.16' }],
    ['a rebuilt KB profile (results scored with the old categories)', { profileVersion: 'p2' }],
    ['no KB profile', { profileVersion: null }],
  ])('misses for %s', async (_label, change) => {
    const cache = new JobResultCache(memoryStore(), 'code-1');
    await cache.save(cache.keyFor(parts), result);
    expect(await cache.lookup(cache.keyFor({ ...parts, ...change }))).toBeUndefined();
  });

  it('misses after a new release: the code version is part of the key', async () => {
    const store = memoryStore();
    await new JobResultCache(store, 'code-1').save(new JobResultCache(store, 'code-1').keyFor(parts), result);
    const next = new JobResultCache(store, 'code-2');
    expect(await next.lookup(next.keyFor(parts))).toBeUndefined();
  });

  it('never breaks a job: a store error, a corrupt entry or a disabled cache all mean "no cached result"', async () => {
    const broken: ResultCacheStore = { get: async () => { throw new Error('redis down'); }, set: async () => { throw new Error('redis down'); } };
    const cache = new JobResultCache(broken, 'c');
    expect(await cache.lookup(cache.keyFor(parts))).toBeUndefined();
    await expect(cache.save(cache.keyFor(parts), result)).resolves.toBeUndefined();

    const store = memoryStore();
    const good = new JobResultCache(store, 'c');
    store.data.set(good.keyFor(parts), '{not json');
    expect(await good.lookup(good.keyFor(parts))).toBeUndefined();

    const off = new JobResultCache(memoryStore(), 'c', false);
    await off.save(off.keyFor(parts), result);
    expect(await off.lookup(off.keyFor(parts))).toBeUndefined();
  });

  it('stores the result compressed and reads it back identical', async () => {
    const store = memoryStore();
    const cache = new JobResultCache(store, 'c');
    const big = {
      doc: { blocks: Array.from({ length: 800 }, (_, i) => ({ id: `b${i}`, text: `Requirement ${i}: the system shall process request number ${i} within the agreed time and report the outcome.` })) },
      tree: { nodes: Array.from({ length: 560 }, (_, i) => ({ local_id: `n${i}`, title: `Item ${i}`, description: `The component shall support behaviour ${i} under the stated conditions.`, trace_links: [] })) },
      catalogHash: 'c1',
      sourceJobId: 'job-1',
    };
    await cache.save(cache.keyFor(parts), big);
    const stored = store.data.get(cache.keyFor(parts)) as string;
    expect(stored.length).toBeLessThan(JSON.stringify(big).length / 4);
    expect(await cache.lookup(cache.keyFor(parts))).toEqual(big);
  });

  it('still reads an entry stored plain by an earlier build', async () => {
    const store = memoryStore();
    const cache = new JobResultCache(store, 'c');
    store.data.set(cache.keyFor(parts), JSON.stringify(result));
    expect(await cache.lookup(cache.keyFor(parts))).toEqual(result);
  });

  it('treats a truncated compressed entry as a miss', async () => {
    const store = memoryStore();
    const cache = new JobResultCache(store, 'c');
    await cache.save(cache.keyFor(parts), result);
    const stored = store.data.get(cache.keyFor(parts)) as string;
    store.data.set(cache.keyFor(parts), stored.slice(0, stored.length - 12));
    expect(await cache.lookup(cache.keyFor(parts))).toBeUndefined();
  });

  it('does not store an enormous result', async () => {
    const store = memoryStore();
    const cache = new JobResultCache(store, 'c', true, 1000);
    await cache.save(cache.keyFor(parts), { ...result, doc: { blob: 'x'.repeat(5000) } });
    expect(store.sets).toBe(0);
  });
});

describe('helpers', () => {
  it('hashes a link-type catalog by content, not by order', () => {
    const a = [{ referenceName: 'A', name: 'a' }, { referenceName: 'B', name: 'b' }];
    expect(hashCatalog(a)).toBe(hashCatalog([...a].reverse()));
    expect(hashCatalog(a)).not.toBe(hashCatalog([a[0]]));
  });

  it('versions the KB by its documents and when they were ingested', async () => {
    const rows = [{ id: 'd2', ingestedAt: new Date('2026-10-02') }, { id: 'd1', ingestedAt: new Date('2026-10-01') }];
    const prisma = (r: typeof rows) => ({ ingestedDocument: { findMany: jest.fn().mockResolvedValue(r) } }) as never;
    const first = await kbVersionFor(prisma(rows), 'u1');
    expect(first).toBe(await kbVersionFor(prisma([...rows].reverse()), 'u1'));
    expect(first).not.toBe(await kbVersionFor(prisma([rows[0]]), 'u1'));
    expect(await kbVersionFor(prisma([]), 'u1')).toBe('no-kb');
    expect(await kbVersionFor({ ingestedDocument: { findMany: jest.fn().mockRejectedValue(new Error('db')) } } as never, 'u1')).toBeNull();
  });
});

import { releaseVersion } from '../src/modules/pipeline/result-cache';

describe('releaseVersion', () => {
  it('reads the version of the running release from its package.json (not from an npm variable a worker process may lack)', () => {
    expect(releaseVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
