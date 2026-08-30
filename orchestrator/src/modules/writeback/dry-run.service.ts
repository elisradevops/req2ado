import { Injectable } from '@nestjs/common';
import type { IdempotencyService } from './idempotency.service';
import { mapWithConcurrency } from '../pipeline/map-with-concurrency';
import { stripHtmlTags } from './backfill.service';

export interface DryRunSourceRef {
  documentPath: string;
  startOffset: number;
  endOffset: number;
  page: number | null;
  // Last page this node's folded content covers -- see ingestion's
  // WorkItemNode.source_ref.page_end docstring. Null means same as page, or
  // unknown -- never set without page also being set.
  pageEnd: number | null;
  // Null when page/pageEnd came from the file's own real pagination,
  // 'rendered'/'interpolated' otherwise -- see ingestion's own docstring for
  // the full distinction.
  pageProvenance: string | null;
  // Root-first heading/section labels this ref was parsed from, e.g.
  // ["3 Power", "3.2 Backplane"]. Empty when no heading ancestry applies.
  sectionPath: string[];
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

// Mirrors ingestion's quality_category_checklist (app.workitem.model) --
// per-category CITATION text backing a SUBSET of QualityCategoryScores'
// keys: the org's own ingested checklist document's stated definition for
// that category, when one was found. Not all-or-nothing like
// QualityCategoryScores -- a category absent from this map is a real,
// expected case (no KB standard at all, or the org's document states no
// separate definition for that one category), not a parse failure. See
// frontend QualityGauge.categoryDescription for how this renders.
export type QualityCategoryChecklist = Record<string, string>;

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
  // Per-Requirement, like customerId -- but NEVER auto-populated by
  // ingestion (always null coming from there). A manually-entered forward
  // reference to a Systems Engineering requirements-layer artifact this
  // Requirement is a basis for coverage of -- see ingestion's
  // WorkItemNode.se_coverage_ref's own docstring. Reviewer-editable via
  // editDiffEntry, same as customerId.
  seCoverageRef: string | null;
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
  qualityCategoryChecklist?: QualityCategoryChecklist | null;
  // Carried from ingestion's WorkItemNode (source_ref/child_type/trace_links)
  // so confirm() can eventually write a traceability link, classification
  // tags, and child-type-derived fields to ADO -- previously dropped at
  // pipeline.worker.ts and never reached this far.
  sourceRef?: DryRunSourceRef | null;
  childType?: string | null;
  traceLinks?: TraceLink[];
  // Carried from ingestion's WorkItemNode.figure_ids (SURVEY-only,
  // LLM-judged relevance) so confirm() knows which JobFigureFile rows to
  // attach to this created work item.
  figureIds?: string[];
  // Carried from ingestion's WorkItemNode.table_ids -- a non-empty list
  // means that table's HTML is already embedded into `description` (see
  // figureIds' doc comment for the same all-4-paths distinction). Not
  // consumed for attachment like figureIds -- table content has nothing to
  // attach separately, it's purely informational for the diff view.
  tableIds?: string[];
  // Carried from ingestion's WorkItemNode.uncaptioned_figure_ids -- figures
  // that folded into this node's span but produced no caption. Disjoint
  // from figureIds: a figure id appears in exactly one of the two lists.
  // Bytes for these are still retained by pipeline.worker.ts's prune step
  // (see its own doc comment) since an uncaptioned figure might still get
  // manually captioned/reviewed later.
  uncaptionedFigureIds?: string[];
  // SUBSET of uncaptionedFigureIds -- the figures among that list the vision
  // model judged insignificant/decorative rather than a genuine vision-call
  // failure (see ingestion's WorkItemNode.insignificant_figure_ids doc
  // comment). Carried through to DryRunDiffEntry at all 3 diffOneNode return
  // branches below, same requirement as uncaptionedFigureIds itself.
  insignificantFigureIds?: string[];
}

// Mirrors ingestion's IntegrityWarning (app.workitem.model) -- structured
// integrity signal replacing the old flat warning string. `severity` lets
// the frontend group by "already fixed" vs "needs your judgment" vs
// "something broke" instead of every warning reading as equally urgent
// prose. `raw` is the fully-formed human sentence -- always populated, so a
// client that doesn't recognize `kind` yet can still show something sane.
// `kind` is intentionally `string` (not a closed TS union) -- ingestion owns
// the closed vocabulary (WarningKind, app.workitem.model) and can add a kind
// without a matching orchestrator/frontend release; only severity's 3-value
// contract is enforced here.
export interface WarningRecord {
  kind: string;
  severity: 'auto_fixed' | 'needs_review' | 'pipeline_issue';
  nodeIds: string[];
  detail: Record<string, unknown>;
  raw: string;
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
  seCoverageRef: string | null;
  tags: string[];
  groundingScore?: number | null;
  qualityScore?: number | null;
  qualityIssues?: string[];
  qualityCategoryScores?: QualityCategoryScores | null;
  qualityCategoryChecklist?: QualityCategoryChecklist | null;
  sourceRef?: DryRunSourceRef | null;
  childType?: string | null;
  traceLinks?: TraceLink[];
  // Carried through from DryRunTreeNode.figureIds by diffOneNode below --
  // previously declared on DryRunTreeNode only and silently dropped at the
  // node -> diff-entry conversion (diffOneNode built each returned object
  // as an explicit literal, never including this field), which meant
  // jobs.service.ts's confirm()-time figure-attachment phase always iterated
  // an empty list: entry.figureIds was undefined on every persisted diff
  // entry, so no figure was EVER auto-attached to ADO regardless of what
  // ingestion captioned/stored. Real, confirmed bug -- see the fix at each
  // of diffOneNode's three return branches.
  figureIds?: string[];
  // Carried through from DryRunTreeNode.tableIds/uncaptionedFigureIds by
  // diffOneNode below, same all-3-branches requirement as figureIds above
  // -- see that field's own doc comment for the exact bug this guards
  // against.
  tableIds?: string[];
  uncaptionedFigureIds?: string[];
  insignificantFigureIds?: string[];
  excluded?: boolean;
  isManual?: boolean;
  // CR-7d rescore: set by JobsService.editDiffEntry whenever a patch
  // changes `description` on an entry that already carries a qualityScore
  // -- the score was judged against the PREVIOUS text and no longer
  // reflects the current one. Cleared (false) by JobsService.rescoreDiffEntry
  // once a fresh score for the CURRENT text is persisted. Never implies the
  // score itself was zeroed -- the last-known numbers are kept, only their
  // freshness is in question (see QualityGauge's Stale rendering).
  qualityStale?: boolean;
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
  // Real perf gap this closes: links sharing the same target customer-id
  // (a real, common case -- several requirements in one document can all
  // reference the same external item) each issued their own sequential
  // WIQL query. Dedupe the distinct target set first, then resolve all of
  // them concurrently -- same "collect the distinct set, one batched/
  // concurrent resolution pass" shape as this module's own existingAdoId
  // re-verification just below.
  const distinctCustomerIds = new Set<string>();
  for (const link of links) {
    if (link.targetKind === 'crossJob' && link.targetCustomerId !== undefined) {
      distinctCustomerIds.add(link.targetCustomerId);
    }
  }
  const idsByCustomerId = new Map<string, number[] | null>();
  await Promise.all(
    Array.from(distinctCustomerIds).map(async (customerId) => {
      try {
        idsByCustomerId.set(customerId, await queryByCustomerId(customerId));
      } catch {
        idsByCustomerId.set(customerId, null);
      }
    }),
  );
  return links.map((link) => {
    if (link.targetKind !== 'crossJob' || link.targetCustomerId === undefined) return link;
    const ids = idsByCustomerId.get(link.targetCustomerId);
    if (ids && ids.length === 1) {
      return { ...link, resolvedAdoId: ids[0], resolutionStatus: 'resolved' as const };
    }
    return { ...link, resolutionStatus: 'unresolved' as const };
  });
}

/**
 * Real gap this closes (confirmed live): a `reuse`/`dedup_skip` match is
 * recorded once (IdempotencyMapping at confirm-time, or the Chroma dedup
 * vector store at confirm/backfill-time) and trusted forever after, with
 * no re-check against ADO's CURRENT state -- an item genuinely created by
 * this app, then deleted directly in ADO by someone/something else,
 * silently kept matching every future job against a dead reference (the
 * diff view showed a "Near-duplicate of WI-533"/"Links to WI-533" chip
 * whose link opens a real, correctly-formed ADO URL that resolves to
 * nothing).
 *
 * Collects the distinct existingAdoId across every reuse/dedup_skip entry
 * (a small set relative to the full node list -- 43 on a real 554-node
 * job, not one extra API call per node) and verifies them in ONE batched
 * call. Any id NOT present in the result is downgraded to a fresh
 * 'create' entry -- same shape a node that never matched anything already
 * gets, so no new DryRunDiffEntry fields are needed. `getWorkItemsBatch`
 * is a callback (not a concrete McpClient import) for the same reason
 * resolveCrossJobTraceLinks above takes `queryByCustomerId` as a callback
 * -- this module stays independent of the pipeline module.
 *
 * Fail-open, same "never block the job over an optional verification"
 * convention as dryRunService.diff's own dedupCheck catch: any exception
 * from the batch call itself (ADO outage, expired credential) returns
 * `diff` completely untouched -- an unverified match is exactly today's
 * pre-existing behavior, not a regression.
 *
 * `onError` (optional): previously this catch was completely silent -- a
 * failed verification pass was indistinguishable from a successful one that
 * happened to confirm every match, both from logs (nothing printed either
 * way) and from the job's own persisted state (confirmed live: a stale
 * dedup_skip match survived to review with zero trace of whether existence
 * verification ever ran). The caller decides what to do with the message
 * (log it, surface it as a job warning) -- this function's own fail-open
 * behavior is unchanged either way.
 */
export async function verifyExistingAdoIdsStillExist(
  diff: DryRunDiffEntry[],
  getWorkItemsBatch: (ids: number[]) => Promise<{ id: number }[]>,
  onError?: (message: string) => void,
): Promise<DryRunDiffEntry[]> {
  const idsToVerify = [
    ...new Set(diff.filter((e) => e.existingAdoId !== null).map((e) => e.existingAdoId as number)),
  ];
  if (idsToVerify.length === 0) {
    return diff;
  }
  let stillExisting: Set<number>;
  try {
    const items = await getWorkItemsBatch(idsToVerify);
    stillExisting = new Set(items.map((item) => item.id));
  } catch (error) {
    onError?.(
      `Could not verify whether ${idsToVerify.length} matched ADO work item(s) still exist -- ` +
        `showing them unverified. (${error instanceof Error ? error.message : String(error)})`,
    );
    return diff;
  }
  return diff.map((entry) => {
    if (entry.existingAdoId === null || stillExisting.has(entry.existingAdoId)) {
      return entry;
    }
    return { ...entry, action: 'create' as const, existingAdoId: null, similarity: null };
  });
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
    dedupCheck?: (text: string, title: string, areaPath: string) => Promise<{ isDuplicate: boolean; matchedItemId: string | null; similarity: number | null }>,
    // Optional -- previously this burst (confirmed live: ~543 calls on a
    // real job) published NO progress signal at all, so the UI showed
    // nothing for however long it took. `completed`/`total` (not a
    // percentage) so a caller decides its own display format; called after
    // EVERY node rather than throttled, since the redis publish this
    // drives is trivial next to the per-node idempotency/embed/Chroma
    // round trips already happening. `currentTitle` is whichever node JUST
    // finished (not a "now starting" signal -- concurrency=8 means several
    // are in flight at once, there's no single "current" node to report
    // before completion) -- previously the dedup-check narration carried
    // only a bare N-of-M count with no way to tell which items were
    // actually involved.
    onProgress?: (completed: number, total: number, currentTitle: string) => void,
  ): Promise<DryRunDiffEntry[]> {
    let completedCount = 0;
    const settled = await mapWithConcurrency(nodes, this.concurrency, async (node) => {
      try {
        return await this.diffOneNode(node, idempotencyService, dedupCheck);
      } finally {
        completedCount += 1;
        onProgress?.(completedCount, nodes.length, node.title);
      }
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

  private async diffOneNode(
    node: DryRunTreeNode,
    idempotencyService: IdempotencyService,
    dedupCheck?: (text: string, title: string, areaPath: string) => Promise<{ isDuplicate: boolean; matchedItemId: string | null; similarity: number | null }>,
  ): Promise<DryRunDiffEntry> {
    {
      const existingAdoId = await idempotencyService.lookup(
        node.sourceHash,
        node.areaPath,
        node.legacySourceHash ?? undefined,
      );
      if (existingAdoId !== null) {
        return {
          localId: node.localId, parentLocalId: node.parentLocalId, type: node.type,
          title: node.title, description: node.description, action: 'reuse' as const,
          existingAdoId, similarity: null, sourceHash: node.sourceHash, customerId: node.customerId,
          seCoverageRef: node.seCoverageRef,
          tags: node.tags, groundingScore: node.groundingScore, qualityScore: node.qualityScore,
          qualityIssues: node.qualityIssues, qualityCategoryScores: node.qualityCategoryScores,
          qualityCategoryChecklist: node.qualityCategoryChecklist,
          sourceRef: node.sourceRef, childType: node.childType,
          traceLinks: node.traceLinks, figureIds: node.figureIds,
          tableIds: node.tableIds, uncaptionedFigureIds: node.uncaptionedFigureIds,
          insignificantFigureIds: node.insignificantFigureIds,
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
          // Strip HTML before the similarity check -- node.description is
          // req2ado's own generated rich-text HTML (plain prose today,
          // increasingly table-markup-heavy as table fidelity ships), while
          // backfill.service.ts's equivalent seeding call
          // (resolveBackfillableRealTypes's caller, backfillAreaPath)
          // already strips ADO's own System.Description HTML with this
          // SAME stripHtmlTags before embedding it. Confirmed real
          // asymmetry (see stripHtmlTags's own doc comment): comparing raw
          // HTML against backfill's stripped text cost ~2.5 similarity
          // points on plain prose alone, byte-identical content scoring
          // 0.975 instead of 1.0 -- a table-bearing description carries far
          // more markup per character of real content than a <p> wrapper
          // ever did, so the same asymmetry left unfixed here would widen
          // sharply and risk real duplicate ADO item creation for exactly
          // the requirements this feature touches.
          const dedupResult = await dedupCheck(stripHtmlTags(node.description), node.title, node.areaPath);
          const matchedAdoId = dedupResult.matchedItemId !== null ? Number(dedupResult.matchedItemId) : null;
          // A bad dedup-store record (matchedItemId not a real numeric ADO
          // id) must fall through to 'create' below, same "creating a
          // possible duplicate is always safer" philosophy as this whole
          // block -- Number.isFinite guards against Number(...) silently
          // producing NaN here and propagating into a PATCH .../workItems/NaN
          // call (confirm()'s adoIdByLocalId map) and a NaN audit-table write.
          if (dedupResult.isDuplicate && matchedAdoId !== null && Number.isFinite(matchedAdoId)) {
            return {
              localId: node.localId, parentLocalId: node.parentLocalId, type: node.type,
              title: node.title, description: node.description, action: 'dedup_skip' as const,
              existingAdoId: matchedAdoId, similarity: dedupResult.similarity,
              sourceHash: node.sourceHash, customerId: node.customerId, seCoverageRef: node.seCoverageRef, tags: node.tags,
              groundingScore: node.groundingScore, qualityScore: node.qualityScore, qualityIssues: node.qualityIssues,
              qualityCategoryScores: node.qualityCategoryScores, qualityCategoryChecklist: node.qualityCategoryChecklist,
              sourceRef: node.sourceRef, childType: node.childType, traceLinks: node.traceLinks,
              figureIds: node.figureIds,
              tableIds: node.tableIds, uncaptionedFigureIds: node.uncaptionedFigureIds,
              insignificantFigureIds: node.insignificantFigureIds,
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
        seCoverageRef: node.seCoverageRef,
        tags: node.tags, groundingScore: node.groundingScore, qualityScore: node.qualityScore,
        qualityIssues: node.qualityIssues, qualityCategoryScores: node.qualityCategoryScores,
        qualityCategoryChecklist: node.qualityCategoryChecklist,
        sourceRef: node.sourceRef, childType: node.childType,
        traceLinks: node.traceLinks, figureIds: node.figureIds,
        tableIds: node.tableIds, uncaptionedFigureIds: node.uncaptionedFigureIds,
        insignificantFigureIds: node.insignificantFigureIds,
      };
    }
  }
}
