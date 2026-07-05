import { describe, it, expect } from 'vitest';
import { MockAdoBackend } from '../src/backends/mockAdo';

/**
 * Simulates the orchestrator's write-back loop (Task 9's IdempotencyService
 * + DryRunService pattern) directly against MockAdoBackend, without needing
 * a NestJS test harness in this package. Proves the CONTRACT — check
 * before create, record after create, re-run finds and reuses — holds
 * against the real AdoBackend interface all backends implement.
 */
interface FakeIdempotencyMap {
  [key: string]: number;
}

function keyFor(sourceHash: string, customerId: string | null, areaPath: string): string {
  return `${sourceHash}::${customerId}::${areaPath}`;
}

async function ingestOnce(
  backend: MockAdoBackend,
  idempotencyMap: FakeIdempotencyMap,
  node: { sourceHash: string; customerId: string | null; areaPath: string; title: string },
): Promise<number> {
  const key = keyFor(node.sourceHash, node.customerId, node.areaPath);
  const existingId = idempotencyMap[key];
  if (existingId !== undefined) {
    return existingId; // reuse, no create call
  }
  const created = await backend.createWorkItem({ type: 'Requirement', fields: { 'System.Title': node.title } });
  idempotencyMap[key] = created.id;
  return created.id;
}

describe('Idempotent write-back (golden re-run)', () => {
  it('re-ingesting the same node produces zero new work items', async () => {
    const backend = new MockAdoBackend(':memory:');
    const idempotencyMap: FakeIdempotencyMap = {};
    const node = {
      sourceHash: 'abc123',
      customerId: 'CUST-1',
      areaPath: 'Project\\Area1',
      title: 'The receiver shall scan all channels.',
    };

    const firstRunId = await ingestOnce(backend, idempotencyMap, node);
    const secondRunId = await ingestOnce(backend, idempotencyMap, node);

    expect(firstRunId).toBe(secondRunId);

    const allIds = await backend.queryIds({ 'System.Title': node.title });
    expect(allIds).toHaveLength(1);
  });

  it('a DIFFERENT customerId for the same source content creates a separate item', async () => {
    const backend = new MockAdoBackend(':memory:');
    const idempotencyMap: FakeIdempotencyMap = {};
    const baseNode = { sourceHash: 'abc123', areaPath: 'Project\\Area1', title: 'Shared title text' };

    const idForCustomerA = await ingestOnce(backend, idempotencyMap, { ...baseNode, customerId: 'CUST-A' });
    const idForCustomerB = await ingestOnce(backend, idempotencyMap, { ...baseNode, customerId: 'CUST-B' });

    expect(idForCustomerA).not.toBe(idForCustomerB);
  });

  it('running three ingests of a two-node tree twice produces exactly two work items total', async () => {
    const backend = new MockAdoBackend(':memory:');
    const idempotencyMap: FakeIdempotencyMap = {};
    const nodes = [
      { sourceHash: 'hash-a', customerId: 'CUST-1', areaPath: 'Project\\Area1', title: 'Requirement A' },
      { sourceHash: 'hash-b', customerId: 'CUST-1', areaPath: 'Project\\Area1', title: 'Requirement B' },
    ];

    for (const node of nodes) await ingestOnce(backend, idempotencyMap, node);
    for (const node of nodes) await ingestOnce(backend, idempotencyMap, node); // re-run

    const idsA = await backend.queryIds({ 'System.Title': 'Requirement A' });
    const idsB = await backend.queryIds({ 'System.Title': 'Requirement B' });
    expect(idsA).toHaveLength(1);
    expect(idsB).toHaveLength(1);
  });
});
