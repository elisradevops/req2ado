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

  async lookup(
    sourceHash: string,
    customerId: string | null,
    areaPath: string,
    legacySourceHash?: string,
  ): Promise<number | null> {
    // findUnique's generated compound-unique-key input type rejects `null`
    // for any field at runtime, even though `customerId` is a nullable
    // column (Prisma does not support `null` in @@unique compound key
    // lookups — see prisma/prisma#3197). findFirst has no such restriction
    // and works correctly with null values in a plain `where` filter; the
    // (sourceHash, customerId, areaPath) unique constraint still guarantees
    // at most one matching row. See task-9 report for the empirical
    // verification against a real Prisma client/Postgres instance.
    const record = await this.prisma.idempotencyMapping.findFirst({
      where: { sourceHash, customerId, areaPath },
    });
    if (record) {
      return record.adoWorkItemId;
    }
    // Migration-safety fallback: every IdempotencyMapping row recorded
    // before ingestion's identity_hash existed was keyed on the OLD hash
    // (sha256(description) alone -- what legacySourceHash carries here, see
    // DryRunTreeNode's own doc comment). Without this fallback, re-ingesting
    // an already-ingested document would find no row under the new
    // identity_hash-based sourceHash and duplicate the entire tree in ADO.
    // Skipped entirely when the two hashes are equal (an older/mocked
    // caller that never populated identity_hash, so sourceHash already IS
    // the legacy hash) to avoid a pointless duplicate query.
    if (legacySourceHash === undefined || legacySourceHash === sourceHash) {
      return null;
    }
    const legacyRecord = await this.prisma.idempotencyMapping.findFirst({
      where: { sourceHash: legacySourceHash, customerId, areaPath },
    });
    return legacyRecord?.adoWorkItemId ?? null;
  }

  async record(sourceHash: string, customerId: string | null, areaPath: string, adoWorkItemId: number): Promise<void> {
    await this.prisma.idempotencyMapping.create({ data: { sourceHash, customerId, areaPath, adoWorkItemId } });
  }
}
