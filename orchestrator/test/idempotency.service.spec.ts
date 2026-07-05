import { IdempotencyService } from '../src/modules/writeback/idempotency.service';

describe('IdempotencyService', () => {
  const fakePrisma = {
    idempotencyMapping: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('lookup returns null when no matching record exists', async () => {
    fakePrisma.idempotencyMapping.findUnique.mockResolvedValue(null);
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    const result = await service.lookup('hash1', 'CUST-1', 'Project\\Area1');
    expect(result).toBeNull();
  });

  it('lookup returns the ADO work item id when a record exists', async () => {
    fakePrisma.idempotencyMapping.findUnique.mockResolvedValue({ adoWorkItemId: 42 });
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    const result = await service.lookup('hash1', 'CUST-1', 'Project\\Area1');
    expect(result).toBe(42);
  });

  it('lookup queries on the exact compound key', async () => {
    fakePrisma.idempotencyMapping.findUnique.mockResolvedValue(null);
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    await service.lookup('hash1', 'CUST-1', 'Project\\Area1');
    expect(fakePrisma.idempotencyMapping.findUnique).toHaveBeenCalledWith({
      where: {
        sourceHash_customerId_areaPath: { sourceHash: 'hash1', customerId: 'CUST-1', areaPath: 'Project\\Area1' },
      },
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

  it('lookup and record both accept a null customerId', async () => {
    fakePrisma.idempotencyMapping.findUnique.mockResolvedValue(null);
    // @ts-expect-error -- fake Prisma client for the test
    const service = new IdempotencyService(fakePrisma);
    await service.lookup('hash1', null, 'Project\\Area1');
    expect(fakePrisma.idempotencyMapping.findUnique).toHaveBeenCalledWith({
      where: { sourceHash_customerId_areaPath: { sourceHash: 'hash1', customerId: null, areaPath: 'Project\\Area1' } },
    });
  });
});
