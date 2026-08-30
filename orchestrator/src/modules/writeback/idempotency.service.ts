import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

// Shared key format for lookupMany's result map -- exported so a caller
// (DryRunService today) builds identical keys when reading the map back.
// A plain template string, not a nested Map, keeps the call site a single
// .get() instead of a two-level lookup.
export function idempotencyMapKey(sourceHash: string, areaPath: string): string {
  return `${sourceHash}::${areaPath}`;
}

/**
 * Backs docs/architecture.md's idempotency key: (source_hash, area_path) ->
 * System.Id. A row existing means this exact source content, in this area
 * path, already has a corresponding ADO work item — re-running ingestion
 * must reuse that id, never create a duplicate.
 *
 * Previously a 3-part key including `customerId` -- that dimension was a
 * job/document-level "Customer ID" the product no longer has (Customer ID
 * is now a per-Requirement, document-derived attribute with no job-level
 * meaning at all). Dropping it was an explicit product decision, accepting
 * that two different customers submitting byte-identical content to the
 * same area path are now treated as the same prior ingestion.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaClient) {}

  async lookup(sourceHash: string, areaPath: string, legacySourceHash?: string): Promise<number | null> {
    const record = await this.prisma.idempotencyMapping.findFirst({
      where: { sourceHash, areaPath },
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
      where: { sourceHash: legacySourceHash, areaPath },
    });
    return legacyRecord?.adoWorkItemId ?? null;
  }

  // Batched form of lookup() -- one findMany for the WHOLE set of
  // (sourceHash, areaPath) pairs a caller needs, instead of one query per
  // pair. Filters on sourceHash alone at the DB level (areaPath is matched
  // in memory against the returned rows via idempotencyMapKey) -- correct
  // whether or not different pairs in the same batch share an areaPath,
  // and keeps the query itself simple (one IN clause, no OR-of-ANDs).
  async lookupMany(keys: { sourceHash: string; areaPath: string }[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (keys.length === 0) return result;
    const sourceHashes = [...new Set(keys.map((key) => key.sourceHash))];
    const rows = await this.prisma.idempotencyMapping.findMany({
      where: { sourceHash: { in: sourceHashes } },
    });
    for (const row of rows) {
      result.set(idempotencyMapKey(row.sourceHash, row.areaPath), row.adoWorkItemId);
    }
    return result;
  }

  // upsert, not create: a plain create raced a resubmit of the same
  // document confirming concurrently (both computing the same sourceHash
  // before either recorded it) and threw the @@unique([sourceHash, areaPath])
  // constraint AFTER the real ADO item was already created by
  // JobsService#confirm -- with CreatedItemMapping now written first (see
  // confirm()'s own comment), that failure left an orphaned ADO item with
  // no idempotency row, so every retry re-created it again, unbounded.
  async record(sourceHash: string, areaPath: string, adoWorkItemId: number): Promise<void> {
    await this.prisma.idempotencyMapping.upsert({
      where: { sourceHash_areaPath: { sourceHash, areaPath } },
      create: { sourceHash, areaPath, adoWorkItemId },
      update: { adoWorkItemId },
    });
  }

  // Called when DryRunService.verifyExistingAdoIdsStillExist proves a
  // 'reuse' match's ADO item was deleted after this row was recorded --
  // without this, the SAME stale row would keep matching every future job
  // against that area path forever (the row itself never expires or
  // re-validates on its own). deleteMany (not delete-by-unique-id) since
  // there is no unique constraint on adoWorkItemId alone -- matches
  // whatever row(s) reference it, correct either way since a deleted ADO
  // item can have at most the one row that originally recorded it.
  async deleteByAdoWorkItemId(adoWorkItemId: number): Promise<void> {
    await this.prisma.idempotencyMapping.deleteMany({ where: { adoWorkItemId } });
  }
}
