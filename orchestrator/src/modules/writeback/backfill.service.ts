import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import type { McpClient, AdoRequestCredential } from '../pipeline/mcp.client';
import type { IngestionHttpClient } from '../pipeline/ingestion-http.client';
import type { IdempotencyService } from './idempotency.service';
import { mapWithConcurrency } from '../pipeline/map-with-concurrency';

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

// Only Epic/Feature/Requirement-CATEGORY items are ever created by req2ado's
// own taxonomy (WorkItemType in ingestion/app/workitem/model.py) --
// backfilling a Bug, Task, or any other real-world work item type from the
// same area path would seed false-positive matches against content req2ado
// would never have generated itself.
//
// Confirmed real bug (fixed here): this used to be a fixed
// Set(['Epic','Feature','Requirement']) checked directly against item.type,
// which is the REAL ADO System.WorkItemType name -- 'Requirement' is only
// the literal type name on the CMMI process template. Agile's
// Requirement-category type is 'User Story', Scrum's is 'Product Backlog
// Item', Basic's is 'Issue' -- on any non-CMMI project every pre-existing
// item was silently skipped ('unsupported type'), so the dedup store was
// never seeded from real ADO content. Resolved per-call via the same
// discoverWorkItemTypeCategories concept jobs.service.ts's confirm() and
// pipeline.worker.ts's crossJob resolution already use -- see those for the
// full category-vs-real-type-name explanation.
async function resolveBackfillableRealTypes(
  mcpClient: McpClient,
  project: string,
  credential: AdoRequestCredential | undefined,
): Promise<Set<string>> {
  // Fail OPEN, never closed: this used to be a pure/static Set with zero
  // network dependency -- discoverWorkItemTypeCategories throwing (custom
  // process template, transient ADO/network blip) must not abort the whole
  // backfill call, nor silently disable it forever via maybeBackfillAreaPath's
  // own catch (pipeline.worker.ts). Falls back to the exact pre-fix
  // CMMI-shaped set so a failure here degrades to old behavior, not zero
  // behavior.
  try {
    const categories = await mcpClient.discoverWorkItemTypeCategories(project, credential);
    return new Set(Object.values(categories));
  } catch (error) {
    // eslint-disable-next-line no-console -- operational visibility for a best-effort path, not app logging
    console.error(`Backfill: discoverWorkItemTypeCategories failed for project ${project}, falling back to CMMI-shaped defaults:`, error);
    return new Set(['Epic', 'Feature', 'Requirement']);
  }
}

// ADO's System.Description is rich-text HTML (e.g. "<p>...</p>\n"), unlike
// req2ado's own generated node descriptions (always plain text). Confirmed
// real gap: embedding raw HTML on this seed side against always-plain text
// on the check side silently cost ~2.5 similarity points on every
// comparison -- byte-identical text scored 0.975 instead of 1.0 cosine
// similarity. Stripped only for the dedup embedding text below -- the
// sourceHash a few lines down must stay on the untouched raw text, or
// every existing IdempotencyMapping row keyed on the old (HTML-included)
// hash would silently stop matching.
//
// Exported so dry-run.service.ts's diffOneNode can strip node.description
// with this SAME function before running its own dedup-similarity check --
// see that call site's own comment for the asymmetry this closes.
export function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// One item's outcome from the concurrent per-item worker below -- kept as
// a plain data record (not a direct shared-counter mutation) so the worker
// function has no shared-state side effects; the counts/skippedReasons/
// dedupUpsertItems accumulation happens afterward in one sequential pass
// over the settled (order-preserved) results.
type ItemOutcome =
  | { kind: 'skipped'; reason: string }
  | { kind: 'seeded'; itemId: string; text: string; title: string; areaPath: string };

@Injectable()
export class BackfillService {
  constructor(
    private readonly mcpClient: McpClient,
    private readonly ingestionClient: IngestionHttpClient,
    private readonly idempotencyService: IdempotencyService,
    // Same writeConcurrency-style default used elsewhere in this pipeline
    // (JobsService, DryRunService) -- lower priority here since backfill is
    // an occasional admin operation, not a hot path, but every item's
    // idempotency lookup is independent of every other item's, so there is
    // no reason to run them one at a time.
    private readonly concurrency: number = 8,
  ) {}

  async backfillAreaPath(areaPath: string, credential?: AdoRequestCredential): Promise<BackfillResult> {
    const project = areaPath.split('\\')[0];
    const ids = await this.mcpClient.queryIds({ 'System.AreaPath': areaPath }, project, credential);
    const result: BackfillResult = { scanned: 0, seeded: 0, skipped: 0, skippedReasons: {} };
    if (ids.length === 0) {
      return result;
    }

    const items = await this.mcpClient.getWorkItemsBatch(ids, credential);
    result.scanned = items.length;
    if (items.length === 0) {
      return result;
    }

    const backfillableRealTypes = await resolveBackfillableRealTypes(this.mcpClient, project, credential);

    const settled = await mapWithConcurrency(items, this.concurrency, async (item): Promise<ItemOutcome> => {
      if (!backfillableRealTypes.has(item.type)) {
        return { kind: 'skipped', reason: 'unsupported type' };
      }
      // Prefer Description (matches what confirm() actually writes as the
      // hashed/embedded content for a req2ado-created item); a manually
      // created item may have left Description blank, in which case Title
      // is the only real content available.
      const description = item.fields['System.Description'] || item.fields['System.Title'];
      if (!description) {
        return { kind: 'skipped', reason: 'no title or description' };
      }
      // Stripped once, reused for both the seeded text below and this
      // fallback -- title and text must contain the SAME text when Title
      // is blank, or the title/description blend mixes HTML-laden and
      // HTML-stripped embeddings of the same content (confirmed real bug:
      // that reintroduces the ~2.5-similarity-point HTML-noise penalty
      // stripHtmlTags exists to eliminate).
      const strippedDescription = stripHtmlTags(description);
      // Falls back to the (already-stripped) description itself in the
      // rare case Title is blank -- keeps the title/description blend a
      // no-op (same text both sides) rather than blending against an
      // empty string.
      const title = item.fields['System.Title'] || strippedDescription;

      // Confirmed real bug (fixed here): queryIds now matches the whole
      // area-path SUBTREE (WIQL UNDER, not exact match -- see realAdo.ts's
      // buildWiqlQuery), so `item` can legitimately live under a NESTED
      // area path (e.g. requested 'Project\Parent', item actually under
      // 'Project\Parent\Child'). Both the idempotency row and the dedup
      // vector-store entry are scoped by exact area-path string match
      // (IdempotencyMapping's compound key; ChromaVectorStore's per-area-
      // path collection), so seeding under the outer `areaPath` param
      // instead of the item's own real area path means a later job
      // submitted against 'Project\Parent\Child' never finds this entry --
      // the exact bug this backfill exists to prevent, just for any
      // subtree area path other than the one literally requested. Falls
      // back to the requested `areaPath` only if System.AreaPath is ever
      // missing (defensive; ADO always returns it for a real work item).
      const itemAreaPath = item.fields['System.AreaPath'] || areaPath;

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
      const existing = await this.idempotencyService.lookup(sourceHash, null, itemAreaPath);
      if (existing === null) {
        try {
          await this.idempotencyService.record(sourceHash, null, itemAreaPath, item.id);
        } catch (error) {
          // Two distinct manual items sharing byte-identical description
          // text (or a race against a concurrent backfill run) would
          // violate the (sourceHash, customerId, areaPath) unique
          // constraint -- never let one collision abort the whole batch.
          // eslint-disable-next-line no-console -- operational visibility for a best-effort path, not app logging
          console.error(`Backfill: idempotency record failed for item ${item.id}:`, error);
        }
      }

      return { kind: 'seeded', itemId: String(item.id), text: strippedDescription, title, areaPath: itemAreaPath };
    });

    // Preserve the exact pre-parallelization failure semantics: an
    // unguarded idempotencyService.lookup throwing previously propagated
    // straight out of the sequential loop, aborting the whole backfill call.
    // mapWithConcurrency instead captures a per-item exception into a
    // rejected result rather than letting it propagate on its own --
    // re-throw the first one here so a DB failure still fails the call
    // exactly as it did before, instead of silently dropping that item.
    const firstError = settled.find((r) => r.status === 'rejected');
    if (firstError && firstError.status === 'rejected') {
      throw firstError.reason;
    }

    const dedupUpsertItems: { itemId: string; text: string; title: string; areaPath: string }[] = [];
    for (const r of settled as { status: 'fulfilled'; value: ItemOutcome }[]) {
      const outcome = r.value;
      if (outcome.kind === 'skipped') {
        result.skipped += 1;
        result.skippedReasons[outcome.reason] = (result.skippedReasons[outcome.reason] ?? 0) + 1;
      } else {
        result.seeded += 1;
        dedupUpsertItems.push({ itemId: outcome.itemId, text: outcome.text, title: outcome.title, areaPath: outcome.areaPath });
      }
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
