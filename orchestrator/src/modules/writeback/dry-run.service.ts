import { Injectable } from '@nestjs/common';
import type { IdempotencyService } from './idempotency.service';

export interface DryRunTreeNode {
  localId: string;
  parentLocalId: string | null;
  type: string;
  title: string;
  description: string;
  sourceHash: string;
  customerId: string | null;
  areaPath: string;
  tags: string[];
  qualityScore?: number | null;
  qualityIssues?: string[];
  childType?: string | null;
}

export interface DryRunDiffEntry {
  localId: string;
  parentLocalId: string | null;
  type: string;
  title: string;
  description: string;
  action: 'create' | 'reuse' | 'dedup_skip';
  existingAdoId: number | null;
  // Distinct from 'reuse': an exact-hash match (idempotency lookup) is a
  // certain fact, while a 'dedup_skip' match comes from the embedding
  // service's probabilistic similarity judgment. similarity is populated
  // only for 'dedup_skip' entries so a reviewer can tell which kind of
  // match they're looking at.
  similarity: number | null;
  // Carried forward from the source node so confirm() can record idempotency
  // at the correct (per-node) granularity — Job.sourceHash is a whole-file
  // hash and cannot be used here; each node's own content hash is what the
  // idempotency map is actually keyed on. Found via the golden E2E script:
  // without this, a re-run always showed 'create' since confirm() had no
  // way to record the mapping using the same key diff() looks it up by.
  sourceHash: string;
  customerId: string | null;
  tags: string[];
  qualityScore?: number | null;
  qualityIssues?: string[];
  childType?: string | null;
  excluded?: boolean;
  isManual?: boolean;
}

/**
 * Pure diff against the idempotency map — no MCP tool call, no ADO write.
 * Satisfies Phase 7's DoD "dry-run diff" and config.yaml's dry_run: true
 * default: a caller can show this diff to a user for confirmation before
 * performing any real write-back.
 */
@Injectable()
export class DryRunService {
  async diff(
    nodes: DryRunTreeNode[],
    idempotencyService: IdempotencyService,
    dedupCheck?: (text: string, areaPath: string) => Promise<{ isDuplicate: boolean; matchedItemId: string | null; similarity: number | null }>,
  ): Promise<DryRunDiffEntry[]> {
    const results: DryRunDiffEntry[] = [];
    for (const node of nodes) {
      const existingAdoId = await idempotencyService.lookup(node.sourceHash, node.customerId, node.areaPath);
      if (existingAdoId !== null) {
        results.push({
          localId: node.localId, parentLocalId: node.parentLocalId, type: node.type,
          title: node.title, description: node.description, action: 'reuse',
          existingAdoId, similarity: null, sourceHash: node.sourceHash, customerId: node.customerId,
          tags: node.tags, qualityScore: node.qualityScore, qualityIssues: node.qualityIssues,
          childType: node.childType,
        });
        continue;
      }
      if (dedupCheck) {
        // Fail OPEN, never closed: an embedding-service outage must not fail
        // BASELINE jobs, which had zero LLM/embed dependency before this
        // phase — that would be a straight regression introduced by an
        // unrelated feature. On any dedup-check error, log it and fall
        // through to the same 'create' path as if dedup were never enabled;
        // creating a possible duplicate is always safer than blocking every
        // submission on a dedup-service hiccup.
        try {
          const dedupResult = await dedupCheck(node.description, node.areaPath);
          if (dedupResult.isDuplicate && dedupResult.matchedItemId !== null) {
            results.push({
              localId: node.localId, parentLocalId: node.parentLocalId, type: node.type,
              title: node.title, description: node.description, action: 'dedup_skip',
              existingAdoId: Number(dedupResult.matchedItemId), similarity: dedupResult.similarity,
              sourceHash: node.sourceHash, customerId: node.customerId, tags: node.tags,
              qualityScore: node.qualityScore, qualityIssues: node.qualityIssues,
              childType: node.childType,
            });
            continue;
          }
        } catch (error) {
          // eslint-disable-next-line no-console -- operational visibility for a fail-open path, not app logging
          console.error(`Dedup check failed for node ${node.localId}, falling through to 'create':`, error);
        }
      }
      results.push({
        localId: node.localId, parentLocalId: node.parentLocalId, type: node.type,
        title: node.title, description: node.description, action: 'create',
        existingAdoId: null, similarity: null, sourceHash: node.sourceHash, customerId: node.customerId,
        tags: node.tags, qualityScore: node.qualityScore, qualityIssues: node.qualityIssues,
        childType: node.childType,
      });
    }
    return results;
  }
}
