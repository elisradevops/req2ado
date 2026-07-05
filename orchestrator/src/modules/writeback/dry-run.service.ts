import { Injectable } from '@nestjs/common';
import type { IdempotencyService } from './idempotency.service';

export interface DryRunTreeNode {
  localId: string;
  sourceHash: string;
  customerId: string | null;
  areaPath: string;
}

export interface DryRunDiffEntry {
  localId: string;
  action: 'create' | 'reuse';
  existingAdoId: number | null;
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
        action: existingAdoId === null ? 'create' : 'reuse',
        existingAdoId,
      });
    }
    return results;
  }
}
