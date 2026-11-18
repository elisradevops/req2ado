import { createHash } from 'node:crypto';
import { JobResultCache, ResultCacheProbe, fileHashOf, hashCatalog, kbVersionFor, type ResultCacheStore } from '../src/modules/pipeline/result-cache';

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
    del: async (...keys: string[]) => {
      keys.forEach((k) => data.delete(k));
      return keys.length;
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

// P5: the wizard asks, before anything runs, whether a SURVEY job of this file would be served from the cache. It must build the
// exact key the worker looks up (pipeline.worker.ts), from the same parts.
describe('ResultCacheProbe', () => {
  const scope = { ingestion: '0.3.15', profile: 'p1' as string | null };
  const setup = async (stored: Partial<typeof parts> = {}) => {
    const cache = new JobResultCache(memoryStore(), 'code-1');
    await cache.save(cache.keyFor({ ...parts, ...stored }), result);
    const kbVersion = jest.fn().mockResolvedValue('kb1');
    const cacheScope = jest.fn().mockResolvedValue(scope);
    return { probe: new ResultCacheProbe(cache, kbVersion, cacheScope), kbVersion, cacheScope };
  };
  const ask = { fileHash: 'f1', userId: 'u1', model: 'claude-opus-4-8', mode: 'survey' };

  it('finds the entry the worker stored for the same file, user, model, KB, ingestion build and profile', async () => {
    const { probe, kbVersion, cacheScope } = await setup();
    expect(await probe.has(ask)).toBe(true);
    expect(kbVersion).toHaveBeenCalledWith('u1');
    expect(cacheScope).toHaveBeenCalledWith('u1');
  });

  it.each([
    ['another file', { fileHash: 'f2' }],
    ['another user', { userId: 'u2' }],
    ['another model', { model: 'OpenAI/gpt-5.6-terra' }],
  ])('misses for %s', async (_label, change) => {
    const { probe } = await setup();
    expect(await probe.has({ ...ask, ...change })).toBe(false);
  });

  it('is false for BASELINE, which the worker never caches, without reading anything', async () => {
    const { probe, kbVersion } = await setup({ mode: 'baseline' });
    expect(await probe.has({ ...ask, mode: 'baseline' })).toBe(false);
    expect(kbVersion).not.toHaveBeenCalled();
  });

  it('is false when the KB version or the ingestion scope cannot be read (the worker then does not consult the cache either)', async () => {
    const cache = new JobResultCache(memoryStore(), 'code-1');
    await cache.save(cache.keyFor(parts), result);
    expect(await new ResultCacheProbe(cache, jest.fn().mockResolvedValue(null), jest.fn().mockResolvedValue(scope)).has(ask)).toBe(false);
    expect(await new ResultCacheProbe(cache, jest.fn().mockResolvedValue('kb1'), jest.fn().mockResolvedValue(null)).has(ask)).toBe(false);
  });
});

describe('fileHashOf', () => {
  it('is the sha256 of the file bytes alone: the file name is not part of it', () => {
    const bytes = Buffer.from('same bytes');
    expect(fileHashOf(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(fileHashOf(Buffer.from('same bytes'))).toBe(fileHashOf(bytes));
    expect(fileHashOf(Buffer.from('other bytes'))).not.toBe(fileHashOf(bytes));
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

describe('JobResultCache.forget', () => {
  it('removes the stored result and the overview a job created, and nothing another job created', async () => {
    const store = memoryStore();
    const cache = new JobResultCache(store, 'code-1');
    const mine = cache.keyFor(parts);
    const theirs = cache.keyFor({ ...parts, fileHash: 'f2' });
    await cache.save(mine, { ...result, sourceJobId: 'job-1' });
    await cache.save(theirs, { ...result, sourceJobId: 'job-2' });
    await cache.track('job-1', 'primer:model:abc');
    store.data.set('primer:model:abc', 'overview');

    await cache.forget('job-1');

    expect(await cache.lookup(mine)).toBeUndefined();
    expect(store.data.has('primer:model:abc')).toBe(false);
    expect(await cache.lookup(theirs)).toEqual({ ...result, sourceJobId: 'job-2' });
    expect([...store.data.keys()].some((k) => k.includes('job-1'))).toBe(false);
  });

  it('keeps every key when one job saves under two (the rubric changed mid-run)', async () => {
    const store = memoryStore();
    const cache = new JobResultCache(store, 'code-1');
    const first = cache.keyFor(parts);
    const second = cache.keyFor({ ...parts, profileVersion: 'p2' });
    await cache.save(first, { ...result, sourceJobId: 'job-1' });
    await cache.save(second, { ...result, sourceJobId: 'job-1' });
    await cache.forget('job-1');
    expect(await cache.lookup(first)).toBeUndefined();
    expect(await cache.lookup(second)).toBeUndefined();
  });

  it('indexes the overview even when the result cache is switched off', async () => {
    const store = memoryStore();
    const cache = new JobResultCache(store, 'code-1', false);
    await cache.track('job-1', 'primer:model:abc');
    store.data.set('primer:model:abc', 'overview');
    await cache.forget('job-1');
    expect(store.data.has('primer:model:abc')).toBe(false);
  });

  it('never throws: a store without delete, or one that fails, leaves the entries to expire', async () => {
    await expect(new JobResultCache({ get: async () => null, set: async () => 'OK' }, 'c').forget('job-1')).resolves.toBeUndefined();
    const broken: ResultCacheStore = { get: async () => { throw new Error('redis down'); }, set: async () => 'OK', del: async () => 0 };
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(new JobResultCache(broken, 'c').forget('job-1')).resolves.toBeUndefined();
  });
});
