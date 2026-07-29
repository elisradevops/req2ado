import { Injectable } from '@nestjs/common';
import type { IdempotencyService } from './idempotency.service';
import { mapWithConcurrency } from '../pipeline/map-with-concurrency';

export interface DryRunSourceRef {
  documentPath: string;
  startOffset: number;
  endOffset: number;
  page: number | null;
}

// Mirrors ingestion's quality_category_scores (app.workitem.model) --
// deliberately independent judgments per dimension, not derived from
// whether a quality-issue tag was flagged. See its own docstring for why a
// lone overall score + closed issue tags wasn't informative enough.
//
// A dynamic key->0-100-score map, NOT a fixed 5-field shape -- when an org
// has ingested its own quality-checklist standard into the Knowledge Base,
// the model derives category names FROM that document's own checklist
// (e.g. "Necessary"/"Unambiguous"/"Verifiable"/etc.) instead of the generic
// clarity/testability/atomicity/style/rationale fallback used when no KB
// standard is available. See orchestrator_llm_client.score_requirements_for_document.
export type QualityCategoryScores = Record<string, number>;

export interface TraceLink {
  sourceLocalId: string;
  referenceName: string;
  displayName: string;
  targetKind: 'intraJob' | 'crossJob';
  targetLocalId?: string;
  targetCustomerId?: string;
  resolvedAdoId?: number;
  resolutionStatus: 'resolved' | 'unresolved' | 'pending';
}

export interface DryRunTreeNode {
  localId: string;
  parentLocalId: string | null;
  type: string;
  title: string;
  description: string;
  sourceHash: string;
  // Migration-safety fallback ONLY (see IdempotencyService.lookup's own
  // doc comment): the pre-identity_hash idempotency key
  // (sha256(description) alone -- ingestion's fidelity_hash) that every
  // IdempotencyMapping row recorded before identity_hash existed is keyed
  // on. A dual lookup (identity_hash first, this as fallback) is what lets
  // re-ingesting an already-ingested document still resolve to 'reuse'
  // instead of duplicating the whole tree in ADO. Never written to by
  // record() -- only ever read as a fallback.
  legacySourceHash?: string | null;
  customerId: string | null;
  areaPath: string;
  tags: string[];
  // SURVEY-only signals (see ingestion's WorkItemNode) -- null/undefined for
  // BASELINE nodes and for any SURVEY node when scoring wasn't enabled.
  groundingScore?: number | null;
  qualityScore?: number | null;
  qualityIssues?: string[];
  // Per-dimension 0-100 breakdown backing qualityScore -- see ingestion's
  // QualityCategoryScores docstring. undefined/null for BASELINE, or any
  // SURVEY node whose scoring entry was missing/malformed (same
  // all-or-nothing tolerance as qualityScore itself).
  qualityCategoryScores?: QualityCategoryScores | null;
  // Carried from ingestion's WorkItemNode (source_ref/child_type/trace_links)
  // so confirm() can eventually write a traceability link, classification
  // tags, and child-type-derived fields to ADO -- previously dropped at
  // pipeline.worker.ts and never reached this far.
  sourceRef?: DryRunSourceRef | null;
  childType?: string | null;
  traceLinks?: TraceLink[];
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
  groundingScore?: number | null;
  qualityScore?: number | null;
  qualityIssues?: string[];
  qualityCategoryScores?: QualityCategoryScores | null;
  sourceRef?: DryRunSourceRef | null;
  childType?: string | null;
  traceLinks?: TraceLink[];
  excluded?: boolean;
  isManual?: boolean;
}

/**
 * Resolves crossJob trace links (targets outside the current job's tree) to
 * a real ADO id via an exact customer-ID field match, at dry-run build time
 * — so the diff view can show resolution status before the user ever
 * confirms. intraJob links are left untouched here; they resolve during
 * confirm() once their sibling gets a real ADO id (see jobs.service.ts).
 * Per the project's "never block" philosophy: no match, more than one
 * match, or the query itself failing all become 'unresolved', never a
 * thrown error — an unresolved link just doesn't get written later.
 */
export async function resolveCrossJobTraceLinks(
  links: TraceLink[],
  queryByCustomerId: (customerId: string) => Promise<number[]>,
): Promise<TraceLink[]> {
  const results: TraceLink[] = [];
  for (const link of links) {
    if (link.targetKind !== 'crossJob' || link.targetCustomerId === undefined) {
      results.push(link);
      continue;
    }
    try {
      const ids = await queryByCustomerId(link.targetCustomerId);
      if (ids.length === 1) {
        results.push({ ...link, resolvedAdoId: ids[0], resolutionStatus: 'resolved' });
      } else {
        results.push({ ...link, resolutionStatus: 'unresolved' });
      }
    } catch {
      results.push({ ...link, resolutionStatus: 'unresolved' });
    }
  }
  return results;
}

/**
 * Pure diff against the idempotency map — no MCP tool call, no ADO write.
 * Satisfies Phase 7's DoD "dry-run diff" and config.yaml's dry_run: true
 * default: a caller can show this diff to a user for confirmation before
 * performing any real write-back.
 */
@Injectable()
export class DryRunService {
  // Matches JobsService's writeConcurrency convention/default exactly --
  // every node's idempotency lookup (and, on a follow-up job, dedup check)
  // is independent of every other node's, so bounding concurrency instead
  // of running them one at a time cuts wall time roughly proportionally
  // for a document with hundreds of leveled nodes.
  constructor(private readonly concurrency: number = 8) {}

  async diff(
    nodes: DryRunTreeNode[],
    idempotencyService: IdempotencyService,
    dedupCheck?: (text: string, areaPath: string) => Promise<{ isDuplicate: boolean; matchedItemId: string | null; similarity: number | null }>,
  ): Promise<DryRunDiffEntry[]> {
    const settled = await mapWithConcurrency(nodes, this.concurrency, async (node) => {
      const existingAdoId = await idempotencyService.lookup(
        node.sourceHash,
        node.customerId,
        node.areaPath,
        node.legacySourceHash ?? undefined,
      );
      if (existingAdoId !== null) {
        return {
          localId: node.localId, parentLocalId: node.parentLocalId, type: node.type,
          title: node.title, description: node.description, action: 'reuse' as const,
          existingAdoId, similarity: null, sourceHash: node.sourceHash, customerId: node.customerId,
          tags: node.tags, groundingScore: node.groundingScore, qualityScore: node.qualityScore,
          qualityIssues: node.qualityIssues, qualityCategoryScores: node.qualityCategoryScores,
          sourceRef: node.sourceRef, childType: node.childType,
          traceLinks: node.traceLinks,
        };
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
            return {
              localId: node.localId, parentLocalId: node.parentLocalId, type: node.type,
              title: node.title, description: node.description, action: 'dedup_skip' as const,
              existingAdoId: Number(dedupResult.matchedItemId), similarity: dedupResult.similarity,
              sourceHash: node.sourceHash, customerId: node.customerId, tags: node.tags,
              groundingScore: node.groundingScore, qualityScore: node.qualityScore, qualityIssues: node.qualityIssues,
              qualityCategoryScores: node.qualityCategoryScores,
              sourceRef: node.sourceRef, childType: node.childType, traceLinks: node.traceLinks,
            };
          }
        } catch (error) {
          // eslint-disable-next-line no-console -- operational visibility for a fail-open path, not app logging
          console.error(`Dedup check failed for node ${node.localId}, falling through to 'create':`, error);
        }
      }
      return {
        localId: node.localId, parentLocalId: node.parentLocalId, type: node.type,
        title: node.title, description: node.description, action: 'create' as const,
        existingAdoId: null, similarity: null, sourceHash: node.sourceHash, customerId: node.customerId,
        tags: node.tags, groundingScore: node.groundingScore, qualityScore: node.qualityScore,
        qualityIssues: node.qualityIssues, qualityCategoryScores: node.qualityCategoryScores,
        sourceRef: node.sourceRef, childType: node.childType,
        traceLinks: node.traceLinks,
      };
    });

    // Preserve the exact pre-parallelization failure semantics: an
    // unguarded idempotencyService.lookup throwing previously propagated
    // straight out of this loop, aborting the whole diff() call (and the
    // pipeline job with it). mapWithConcurrency instead captures a
    // per-item exception into a rejected result rather than letting it
    // propagate on its own -- re-throw the first one here so a DB failure
    // still fails the job exactly as it did before, instead of silently
    // degrading into a partial/incomplete diff.
    const firstError = settled.find((r) => r.status === 'rejected');
    if (firstError && firstError.status === 'rejected') {
      throw firstError.reason;
    }
    return settled.map((r) => (r as { status: 'fulfilled'; value: DryRunDiffEntry }).value);
  }
}
