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
}

export interface DryRunDiffEntry {
  localId: string;
  parentLocalId: string | null;
  type: string;
  title: string;
  description: string;
  action: 'create' | 'reuse';
  existingAdoId: number | null;
  // Carried forward from the source node so confirm() can record idempotency
  // at the correct (per-node) granularity — Job.sourceHash is a whole-file
  // hash and cannot be used here; each node's own content hash is what the
  // idempotency map is actually keyed on. Found via the golden E2E script:
  // without this, a re-run always showed 'create' since confirm() had no
  // way to record the mapping using the same key diff() looks it up by.
  sourceHash: string;
  customerId: string | null;
}

/**
 * Pure diff against the idempotency map — no MCP tool call, no ADO write.
 * Satisfies Phase 7's DoD "dry-run diff" and config.yaml's dry_run: true
 * default: a caller can show this diff to a user for confirmation before
 * performing any real write-back.
 */
@Injectable()
export class DryRunService {
  async diff(nodes: DryRunTreeNode[], idempotencyService: IdempotencyService): Promise<DryRunDiffEntry[]> {
    const results: DryRunDiffEntry[] = [];
    for (const node of nodes) {
      const existingAdoId = await idempotencyService.lookup(node.sourceHash, node.customerId, node.areaPath);
      results.push({
        localId: node.localId,
        parentLocalId: node.parentLocalId,
        type: node.type,
        title: node.title,
        description: node.description,
        action: existingAdoId === null ? 'create' : 'reuse',
        existingAdoId,
        sourceHash: node.sourceHash,
        customerId: node.customerId,
      });
    }
    return results;
  }
}
