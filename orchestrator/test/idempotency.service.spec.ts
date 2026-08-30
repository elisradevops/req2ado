import { IdempotencyService, idempotencyMapKey } from '../src/modules/writeback/idempotency.service';

describe('IdempotencyService', () => {
  const fakePrisma = {
    idempotencyMapping: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('lookup returns null when no matching record exists', async () => {
    fakePrisma.idempotencyMapping.findFirst.mockResolvedValue(null);
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    const result = await service.lookup('hash1', 'Project\\Area1');
    expect(result).toBeNull();
  });

  it('lookup returns the ADO work item id when a record exists', async () => {
    fakePrisma.idempotencyMapping.findFirst.mockResolvedValue({ adoWorkItemId: 42 });
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    const result = await service.lookup('hash1', 'Project\\Area1');
    expect(result).toBe(42);
  });

  it('lookup queries on the exact compound key (sourceHash, areaPath) -- no customerId dimension', async () => {
    fakePrisma.idempotencyMapping.findFirst.mockResolvedValue(null);
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    await service.lookup('hash1', 'Project\\Area1');
    expect(fakePrisma.idempotencyMapping.findFirst).toHaveBeenCalledWith({
      where: { sourceHash: 'hash1', areaPath: 'Project\\Area1' },
    });
  });

  it('record upserts a new mapping row, keyed on the compound (sourceHash, areaPath) unique', async () => {
    // upsert, not create: a plain create would throw on a concurrent
    // resubmit racing another confirm() to record the same (sourceHash,
    // areaPath) pair -- see record()'s own doc comment for the orphaned
    // ADO item this closes.
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    await service.record('hash1', 'Project\\Area1', 42);
    expect(fakePrisma.idempotencyMapping.upsert).toHaveBeenCalledWith({
      where: { sourceHash_areaPath: { sourceHash: 'hash1', areaPath: 'Project\\Area1' } },
      create: { sourceHash: 'hash1', areaPath: 'Project\\Area1', adoWorkItemId: 42 },
      update: { adoWorkItemId: 42 },
    });
  });

  it('deleteByAdoWorkItemId removes every mapping row referencing a since-deleted ADO item', async () => {
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    await service.deleteByAdoWorkItemId(533);
    expect(fakePrisma.idempotencyMapping.deleteMany).toHaveBeenCalledWith({ where: { adoWorkItemId: 533 } });
  });

  // Migration-safety fallback: every IdempotencyMapping row recorded before
  // identity_hash existed is keyed on the OLD hash (fidelity_hash alone).
  // Without this fallback, re-ingesting an already-ingested document would
  // find no row under the new identity_hash-based sourceHash and duplicate
  // the whole tree in ADO.

  it('lookup falls back to legacySourceHash when the new sourceHash finds no row', async () => {
    fakePrisma.idempotencyMapping.findFirst
      .mockResolvedValueOnce(null) // new identity_hash-based lookup: nothing
      .mockResolvedValueOnce({ adoWorkItemId: 99 }); // legacy fidelity_hash-based lookup: found
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    const result = await service.lookup('new-identity-hash', 'Project\\Area1', 'legacy-fidelity-hash');

    expect(result).toBe(99);
    expect(fakePrisma.idempotencyMapping.findFirst).toHaveBeenNthCalledWith(1, {
      where: { sourceHash: 'new-identity-hash', areaPath: 'Project\\Area1' },
    });
    expect(fakePrisma.idempotencyMapping.findFirst).toHaveBeenNthCalledWith(2, {
      where: { sourceHash: 'legacy-fidelity-hash', areaPath: 'Project\\Area1' },
    });
  });

  it('lookup does not fall back to legacySourceHash when the new sourceHash already found a row', async () => {
    fakePrisma.idempotencyMapping.findFirst.mockResolvedValue({ adoWorkItemId: 42 });
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    const result = await service.lookup('new-identity-hash', 'Project\\Area1', 'legacy-fidelity-hash');

    expect(result).toBe(42);
    expect(fakePrisma.idempotencyMapping.findFirst).toHaveBeenCalledTimes(1);
  });

  it('lookup skips the fallback query entirely when legacySourceHash is undefined', async () => {
    fakePrisma.idempotencyMapping.findFirst.mockResolvedValue(null);
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    const result = await service.lookup('hash1', 'Project\\Area1');

    expect(result).toBeNull();
    expect(fakePrisma.idempotencyMapping.findFirst).toHaveBeenCalledTimes(1);
  });

  it('lookup skips the fallback query when legacySourceHash equals sourceHash (older/mocked caller)', async () => {
    fakePrisma.idempotencyMapping.findFirst.mockResolvedValue(null);
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    const result = await service.lookup('hash1', 'Project\\Area1', 'hash1');

    expect(result).toBeNull();
    expect(fakePrisma.idempotencyMapping.findFirst).toHaveBeenCalledTimes(1);
  });

  it('lookup returns null when neither the new nor the legacy hash finds a row', async () => {
    fakePrisma.idempotencyMapping.findFirst.mockResolvedValue(null);
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    const result = await service.lookup('new-identity-hash', 'Project\\Area1', 'legacy-fidelity-hash');

    expect(result).toBeNull();
    expect(fakePrisma.idempotencyMapping.findFirst).toHaveBeenCalledTimes(2);
  });

  it('record only ever writes the new sourceHash, never legacySourceHash', async () => {
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    await service.record('new-identity-hash', 'Project\\Area1', 42);
    expect(fakePrisma.idempotencyMapping.upsert).toHaveBeenCalledWith({
      where: { sourceHash_areaPath: { sourceHash: 'new-identity-hash', areaPath: 'Project\\Area1' } },
      create: { sourceHash: 'new-identity-hash', areaPath: 'Project\\Area1', adoWorkItemId: 42 },
      update: { adoWorkItemId: 42 },
    });
  });

  it('two jobs that previously had different customerId values now reuse the same mapping row (explicit product decision -- Customer ID has no job-level meaning)', async () => {
    fakePrisma.idempotencyMapping.findFirst.mockResolvedValue({ adoWorkItemId: 7 });
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    const first = await service.lookup('hash1', 'Project\\Area1');
    const second = await service.lookup('hash1', 'Project\\Area1');
    expect(first).toBe(7);
    expect(second).toBe(7);
  });

  describe('IdempotencyService.lookupMany', () => {
    it('returns an empty map without querying when given no keys', async () => {
      // @ts-expect-error -- fake Prisma client for the test
      const service = new IdempotencyService(fakePrisma);
      const result = await service.lookupMany([]);
      expect(result.size).toBe(0);
      expect(fakePrisma.idempotencyMapping.findMany).not.toHaveBeenCalled();
    });

    it('makes exactly one findMany query for the whole batch, keyed on the distinct sourceHash set', async () => {
      fakePrisma.idempotencyMapping.findMany = jest.fn().mockResolvedValue([]);
      // @ts-expect-error -- fake Prisma client for the test
      const service = new IdempotencyService(fakePrisma);
      await service.lookupMany([
        { sourceHash: 'hash1', areaPath: 'Project\\Area1' },
        { sourceHash: 'hash2', areaPath: 'Project\\Area1' },
        { sourceHash: 'hash1', areaPath: 'Project\\Area2' }, // same hash, different area -- still one distinct hash
      ]);
      expect(fakePrisma.idempotencyMapping.findMany).toHaveBeenCalledTimes(1);
      expect(fakePrisma.idempotencyMapping.findMany).toHaveBeenCalledWith({
        where: { sourceHash: { in: ['hash1', 'hash2'] } },
      });
    });

    it('builds a map keyed on the exact (sourceHash, areaPath) pair, not sourceHash alone', async () => {
      fakePrisma.idempotencyMapping.findMany = jest.fn().mockResolvedValue([
        { sourceHash: 'hash1', areaPath: 'Project\\Area1', adoWorkItemId: 42 },
        { sourceHash: 'hash1', areaPath: 'Project\\Area2', adoWorkItemId: 99 },
      ]);
      // @ts-expect-error -- fake Prisma client for the test
      const service = new IdempotencyService(fakePrisma);
      const result = await service.lookupMany([
        { sourceHash: 'hash1', areaPath: 'Project\\Area1' },
        { sourceHash: 'hash1', areaPath: 'Project\\Area2' },
      ]);
      expect(result.get(idempotencyMapKey('hash1', 'Project\\Area1'))).toBe(42);
      expect(result.get(idempotencyMapKey('hash1', 'Project\\Area2'))).toBe(99);
      expect(result.get(idempotencyMapKey('hash1', 'Project\\Area3'))).toBeUndefined();
    });
  });
});
