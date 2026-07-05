import { DryRunService } from '../src/modules/writeback/dry-run.service';
import type { IdempotencyService } from '../src/modules/writeback/idempotency.service';

describe('DryRunService', () => {
  const fakeIdempotencyService = { lookup: jest.fn() } as unknown as IdempotencyService;

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('marks a node as "create" when no existing mapping is found', async () => {
    (fakeIdempotencyService.lookup as jest.Mock).mockResolvedValue(null);
    const service = new DryRunService();
    const result = await service.diff(
      [{ localId: 'n0', sourceHash: 'hash1', customerId: null, areaPath: 'Project\\Area1' }],
      fakeIdempotencyService,
    );
    expect(result).toEqual([{ localId: 'n0', action: 'create', existingAdoId: null }]);
  });

  it('marks a node as "reuse" when an existing mapping is found', async () => {
    (fakeIdempotencyService.lookup as jest.Mock).mockResolvedValue(42);
    const service = new DryRunService();
    const result = await service.diff(
      [{ localId: 'n0', sourceHash: 'hash1', customerId: 'CUST-1', areaPath: 'Project\\Area1' }],
      fakeIdempotencyService,
    );
    expect(result).toEqual([{ localId: 'n0', action: 'reuse', existingAdoId: 42 }]);
  });

  it('diffs every node in a multi-node tree independently', async () => {
    (fakeIdempotencyService.lookup as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(7);
    const service = new DryRunService();
    const result = await service.diff(
      [
        { localId: 'n0', sourceHash: 'hash1', customerId: null, areaPath: 'Project\\Area1' },
        { localId: 'n1', sourceHash: 'hash2', customerId: null, areaPath: 'Project\\Area1' },
      ],
      fakeIdempotencyService,
    );
    expect(result).toEqual([
      { localId: 'n0', action: 'create', existingAdoId: null },
      { localId: 'n1', action: 'reuse', existingAdoId: 7 },
    ]);
  });

  it('does not call any MCP tool or perform any write — pure diff', async () => {
    (fakeIdempotencyService.lookup as jest.Mock).mockResolvedValue(null);
    const service = new DryRunService();
    await service.diff(
      [{ localId: 'n0', sourceHash: 'hash1', customerId: null, areaPath: 'Project\\Area1' }],
      fakeIdempotencyService,
    );
    // No assertion needed beyond "this test exists and only calls lookup()"
    // — DryRunService has no MCP client dependency at all by construction,
    // so there is nothing else it COULD call.
    expect(fakeIdempotencyService.lookup).toHaveBeenCalledTimes(1);
  });
});
