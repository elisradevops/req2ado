import { IdempotencyService } from '../src/modules/writeback/idempotency.service';

describe('IdempotencyService', () => {
  const fakePrisma = {
    idempotencyMapping: {
      findFirst: jest.fn(),
      create: jest.fn(),
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
    const result = await service.lookup('hash1', 'CUST-1', 'Project\\Area1');
    expect(result).toBeNull();
  });

  it('lookup returns the ADO work item id when a record exists', async () => {
    fakePrisma.idempotencyMapping.findFirst.mockResolvedValue({ adoWorkItemId: 42 });
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    const result = await service.lookup('hash1', 'CUST-1', 'Project\\Area1');
    expect(result).toBe(42);
  });

  it('lookup queries on the exact compound key', async () => {
    fakePrisma.idempotencyMapping.findFirst.mockResolvedValue(null);
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    await service.lookup('hash1', 'CUST-1', 'Project\\Area1');
    expect(fakePrisma.idempotencyMapping.findFirst).toHaveBeenCalledWith({
      where: { sourceHash: 'hash1', customerId: 'CUST-1', areaPath: 'Project\\Area1' },
    });
  });

  it('record creates a new mapping row', async () => {
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    await service.record('hash1', 'CUST-1', 'Project\\Area1', 42);
    expect(fakePrisma.idempotencyMapping.create).toHaveBeenCalledWith({
      data: { sourceHash: 'hash1', customerId: 'CUST-1', areaPath: 'Project\\Area1', adoWorkItemId: 42 },
    });
  });

  it('deleteByAdoWorkItemId removes every mapping row referencing a since-deleted ADO item', async () => {
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    await service.deleteByAdoWorkItemId(533);
    expect(fakePrisma.idempotencyMapping.deleteMany).toHaveBeenCalledWith({ where: { adoWorkItemId: 533 } });
  });

  it('lookup and record both accept a null customerId', async () => {
    fakePrisma.idempotencyMapping.findFirst.mockResolvedValue(null);
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    await service.lookup('hash1', null, 'Project\\Area1');
    expect(fakePrisma.idempotencyMapping.findFirst).toHaveBeenCalledWith({
      where: { sourceHash: 'hash1', customerId: null, areaPath: 'Project\\Area1' },
    });
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
    const result = await service.lookup('new-identity-hash', 'CUST-1', 'Project\\Area1', 'legacy-fidelity-hash');

    expect(result).toBe(99);
    expect(fakePrisma.idempotencyMapping.findFirst).toHaveBeenNthCalledWith(1, {
      where: { sourceHash: 'new-identity-hash', customerId: 'CUST-1', areaPath: 'Project\\Area1' },
    });
    expect(fakePrisma.idempotencyMapping.findFirst).toHaveBeenNthCalledWith(2, {
      where: { sourceHash: 'legacy-fidelity-hash', customerId: 'CUST-1', areaPath: 'Project\\Area1' },
    });
  });

  it('lookup does not fall back to legacySourceHash when the new sourceHash already found a row', async () => {
    fakePrisma.idempotencyMapping.findFirst.mockResolvedValue({ adoWorkItemId: 42 });
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    const result = await service.lookup('new-identity-hash', 'CUST-1', 'Project\\Area1', 'legacy-fidelity-hash');

    expect(result).toBe(42);
    expect(fakePrisma.idempotencyMapping.findFirst).toHaveBeenCalledTimes(1);
  });

  it('lookup skips the fallback query entirely when legacySourceHash is undefined', async () => {
    fakePrisma.idempotencyMapping.findFirst.mockResolvedValue(null);
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    const result = await service.lookup('hash1', 'CUST-1', 'Project\\Area1');

    expect(result).toBeNull();
    expect(fakePrisma.idempotencyMapping.findFirst).toHaveBeenCalledTimes(1);
  });

  it('lookup skips the fallback query when legacySourceHash equals sourceHash (older/mocked caller)', async () => {
    fakePrisma.idempotencyMapping.findFirst.mockResolvedValue(null);
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    const result = await service.lookup('hash1', 'CUST-1', 'Project\\Area1', 'hash1');

    expect(result).toBeNull();
    expect(fakePrisma.idempotencyMapping.findFirst).toHaveBeenCalledTimes(1);
  });

  it('lookup returns null when neither the new nor the legacy hash finds a row', async () => {
    fakePrisma.idempotencyMapping.findFirst.mockResolvedValue(null);
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    const result = await service.lookup('new-identity-hash', 'CUST-1', 'Project\\Area1', 'legacy-fidelity-hash');

    expect(result).toBeNull();
    expect(fakePrisma.idempotencyMapping.findFirst).toHaveBeenCalledTimes(2);
  });

  it('record only ever writes the new sourceHash, never legacySourceHash', async () => {
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    await service.record('new-identity-hash', 'CUST-1', 'Project\\Area1', 42);
    expect(fakePrisma.idempotencyMapping.create).toHaveBeenCalledWith({
      data: { sourceHash: 'new-identity-hash', customerId: 'CUST-1', areaPath: 'Project\\Area1', adoWorkItemId: 42 },
    });
  });
});
