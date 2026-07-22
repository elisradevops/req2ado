import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import type { McpClient, AdoRequestCredential } from '../pipeline/mcp.client';
import type { IngestionHttpClient } from '../pipeline/ingestion-http.client';
import type { IdempotencyService } from './idempotency.service';

/**
 * Closes the "pre-existing work items not created by this app are
 * invisible to reuse/dedup" gap (docs/handoff.md's code-review §8): both
 * IdempotencyMapping and the Chroma dedup vector store were previously
 * populated ONLY inside JobsService.confirm(), right after THIS app
 * creates a work item — an item an engineer created manually in ADO before
 * ever running req2ado had no way to be recognized, and submitting a
 * document describing it would silently create a true duplicate.
 *
 * This service queries an area path's EXISTING work items directly from
 * ADO and seeds both mechanisms from their real content, so a subsequent
 * req2ado submission recognizes the overlap as `reuse` (exact-hash) or
 * `dedup_skip` (embedding similarity), exactly as if req2ado had created
 * those items itself.
 */
export interface BackfillResult {
  scanned: number;
  seeded: number;
  skipped: number;
  skippedReasons: Record<string, number>;
}

// Only these three types are ever created by req2ado's own taxonomy
// (WorkItemType in ingestion/app/workitem/model.py) -- backfilling a Bug,
// Task, or any other real-world work item type from the same area path
// would seed false-positive matches against content req2ado would never
// have generated itself.
const BACKFILLABLE_TYPES = new Set(['Epic', 'Feature', 'Requirement']);

@Injectable()
export class BackfillService {
  constructor(
    private readonly mcpClient: McpClient,
    private readonly ingestionClient: IngestionHttpClient,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  async backfillAreaPath(areaPath: string, credential?: AdoRequestCredential): Promise<BackfillResult> {
    const ids = await this.mcpClient.queryIds({ 'System.AreaPath': areaPath }, credential);
    const result: BackfillResult = { scanned: 0, seeded: 0, skipped: 0, skippedReasons: {} };
    if (ids.length === 0) {
      return result;
    }

    const items = await this.mcpClient.getWorkItemsBatch(ids, credential);
    result.scanned = items.length;

    const dedupUpsertItems: { itemId: string; text: string; areaPath: string }[] = [];

    for (const item of items) {
      if (!BACKFILLABLE_TYPES.has(item.type)) {
        result.skipped += 1;
        result.skippedReasons['unsupported type'] = (result.skippedReasons['unsupported type'] ?? 0) + 1;
        continue;
      }
      // Prefer Description (matches what confirm() actually writes as the
      // hashed/embedded content for a req2ado-created item); a manually
      // created item may have left Description blank, in which case Title
      // is the only real content available.
      const description = item.fields['System.Description'] || item.fields['System.Title'];
      if (!description) {
        result.skipped += 1;
        result.skippedReasons['no title or description'] = (result.skippedReasons['no title or description'] ?? 0) + 1;
        continue;
      }

      // Same scheme as ingestion's fidelity_hash (sha256 of the exact
      // description text) so a document whose content matches this
      // manually-created item verbatim resolves to 'reuse', not 'create'.
      // customerId is always null here -- a manually-created item's
      // Customer ID field value (if any) isn't reliably knowable without
      // per-type field discovery, and req2ado's own idempotency records
      // are ALSO customerId:null for any node whose source document never
      // supplied one, so this is consistent with the existing scheme, not
      // a new assumption.
      const sourceHash = createHash('sha256').update(description).digest('hex');
      const existing = await this.idempotencyService.lookup(sourceHash, null, areaPath);
      if (existing === null) {
        try {
          await this.idempotencyService.record(sourceHash, null, areaPath, item.id);
        } catch (error) {
          // Two distinct manual items sharing byte-identical description
          // text (or a race against a concurrent backfill run) would
          // violate the (sourceHash, customerId, areaPath) unique
          // constraint -- never let one collision abort the whole batch.
          // eslint-disable-next-line no-console -- operational visibility for a best-effort path, not app logging
          console.error(`Backfill: idempotency record failed for item ${item.id}:`, error);
        }
      }

      dedupUpsertItems.push({ itemId: String(item.id), text: description, areaPath });
      result.seeded += 1;
    }

    if (dedupUpsertItems.length > 0) {
      try {
        await this.ingestionClient.upsertDedupEntriesBatch(dedupUpsertItems);
      } catch (error) {
        // Same fail-open philosophy as confirm()'s own dedup upsert: a
        // batch failure here only means these items won't be caught by
        // FUTURE embedding-similarity dedup checks -- it must not fail the
        // exact-hash idempotency seeding above, which already succeeded.
        // eslint-disable-next-line no-console -- operational visibility for a best-effort path, not app logging
        console.error(`Backfill: dedup batch upsert failed for ${dedupUpsertItems.length} item(s):`, error);
      }
    }

    return result;
  }
}
