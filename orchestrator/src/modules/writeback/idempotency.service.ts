import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

/**
 * Backs docs/architecture.md's idempotency key: (source_hash, customer_id,
 * area_path) -> System.Id. A row existing means this exact source content,
 * for this customer, in this area path, already has a corresponding ADO
 * work item — re-running ingestion must reuse that id, never create a
 * duplicate.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaClient) {}

  async lookup(sourceHash: string, customerId: string | null, areaPath: string): Promise<number | null> {
    const record = await this.prisma.idempotencyMapping.findUnique({
      where: {
        // Prisma's generated compound-unique-key input type requires a
        // non-null `customerId` even though the column itself is nullable
        // (Prisma does not support `null` in @@unique compound key lookups
        // — see prisma/prisma#3197). Cast is required to compile; see
        // task-9 report for the runtime implication when customerId is
        // actually null against a real Prisma client/Postgres instance.
        sourceHash_customerId_areaPath: { sourceHash, customerId, areaPath } as {
          sourceHash: string;
          customerId: string;
          areaPath: string;
        },
      },
    });
    return record?.adoWorkItemId ?? null;
  }

  async record(sourceHash: string, customerId: string | null, areaPath: string, adoWorkItemId: number): Promise<void> {
    await this.prisma.idempotencyMapping.create({ data: { sourceHash, customerId, areaPath, adoWorkItemId } });
  }
}
