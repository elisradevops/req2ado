import { BadRequestException, ConflictException, Injectable, NotFoundException, type OnModuleDestroy } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { createHash } from 'crypto';
import type { McpClient } from './mcp.client';
import type { IngestionHttpClient } from './ingestion-http.client';
import type { IdempotencyService } from '../writeback/idempotency.service';
import type { DryRunDiffEntry } from '../writeback/dry-run.service';
import { mapWithConcurrency } from './map-with-concurrency';

export interface SubmitJobInput {
  areaPath: string;
  // The submitting user's stable ADO identity -- the Knowledge Base scope
  // key ingestion's /level uses for KB grounding, kept separate from
  // areaPath (ADO write-back destination + idempotency key only). Nullable:
  // KB grounding simply stays off for a job with no resolved identity.
  userId: string | null;
  customerId: string | null;
  mode: 'baseline' | 'survey';
  // True when this job ingests a follow-up document against requirements
  // already ingested under the same area path -- gates whether
  // pipeline.worker.ts runs the dedup-similarity check (see Job.followUp's
  // own schema.prisma doc comment). Defaults to false in submit() below,
  // matching pre-follow-up-mode behavior only insofar as dedup previously
  // ran unconditionally on every job -- see pipeline.worker.ts for the
  // actual behavior change.
  followUp?: boolean;
  fileBuffer: Buffer;
  filename: string;
  sourceHash: string;
  state?: string;
  iterationPath?: string | null;
  // Per-job LLM model override (SURVEY only). Not persisted on the Job row
  // -- passed straight through to the BullMQ payload like areaPath/mode,
  // since the pipeline worker never needs to look it up again after the
  // job finishes.
  model?: string;
}

export interface JobSummary {
  id: string;
  mode: string;
  status: string;
  areaPath: string;
  itemCount: number;
  createdAt: Date;
}

@Injectable()
export class JobsService implements OnModuleDestroy {
  private readonly queue: Queue;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly mcpClient: McpClient,
    private readonly idempotencyService: IdempotencyService,
    private readonly ingestionClient: IngestionHttpClient,
    redisUrl: string,
    private readonly initialState: string = 'Proposed',
    private readonly writeConcurrency: number = 8,
    private readonly customerIdFieldCandidates: string[] = [
      'Custom.CustomerId',
      'Custom.CustomerRequirementId',
      'Custom.CustomerID',
    ],
  ) {
    this.queue = new Queue('req2ado-pipeline', { connection: { url: redisUrl } as any });
  }

  /**
   * Previously nothing ever closed this.queue's underlying ioredis
   * connection -- its open socket kept the Node event loop alive
   * indefinitely, so app.enableShutdownHooks() called app.close() on
   * SIGTERM but the process itself never actually exited (found live:
   * still 'running' 10+ seconds after SIGTERM against a real container).
   */
  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }

  async submit(input: SubmitJobInput): Promise<{ jobId: string }> {
    const job = await this.prisma.job.create({
      data: {
        mode: input.mode,
        status: 'pending',
        sourceHash: input.sourceHash,
        areaPath: input.areaPath,
        userId: input.userId,
        followUp: input.followUp ?? false,
        state: input.state ?? this.initialState,
        iterationPath: input.iterationPath ?? null,
        customerId: input.customerId,
        originalFilename: input.filename,
      },
    });
    // BullMQ persists job data as JSON in Redis. JSON.stringify(Buffer)
    // produces {type:'Buffer', data:[...]}, which is NOT a Buffer instance
    // once read back on the worker side — base64-encoding here and decoding
    // in pipeline-worker.main.ts round-trips the exact bytes through JSON
    // safely. Found via the golden E2E script: every real upload was
    // silently producing an empty WorkItemTree with no error surfaced.
    await this.queue.add('ingest-and-level', {
      id: job.id,
      areaPath: input.areaPath,
      userId: input.userId,
      customerId: input.customerId,
      mode: input.mode,
      followUp: input.followUp ?? false,
      fileBufferBase64: input.fileBuffer.toString('base64'),
      filename: input.filename,
      ...(input.model ? { model: input.model } : {}),
    });
    await this.prisma.auditEntry.create({
      data: { jobId: job.id, message: `Job submitted: ${input.filename}, areaPath=${input.areaPath}` },
    });
    return { jobId: job.id };
  }

  async getAuditTrail(id: string): Promise<{ id: string; message: string; createdAt: Date }[]> {
    return this.prisma.auditEntry.findMany({ where: { jobId: id }, orderBy: { createdAt: 'asc' } });
  }

  async getDedupSkips(
    id: string,
  ): Promise<{ id: string; localId: string; similarity: number; existingAdoId: number; createdAt: Date }[]> {
    return this.prisma.dedupSkipAudit.findMany({ where: { jobId: id }, orderBy: { createdAt: 'asc' } });
  }

  // docs/architecture.md's "Customer ID Field Resolution": verified at
  // runtime against ado_discover_fields, never hardcoded to System.CustomerId
  // (System.* is ADO's reserved built-in namespace, not custom fields).
  // Candidate priority list is configurable (CUSTOMER_ID_FIELD_CANDIDATES),
  // defaulting to DocGen's real-world discovered naming conventions; each
  // candidate is verified present before use rather than trusted blind. If
  // none match on this work-item type, resolveCustomerIdField itself leaves
  // it off (traceability metadata, not a required field) -- but see the
  // System.Tags fallback in confirm()'s field assembly for the
  // non-type-gated backstop this enables (a type with no candidate field at
  // all, e.g. Epic/Feature in the tested org, still gets the customer ID
  // somewhere visible).
  private async resolveCustomerIdField(
    workItemType: string,
    credential?: { orgUrl: string; pat: string },
  ): Promise<string | null> {
    const availableFields = await this.mcpClient.discoverFields(workItemType, credential);
    return this.customerIdFieldCandidates.find((candidate) => availableFields.includes(candidate)) ?? null;
  }

  // Same runtime-verified resolution pattern as resolveCustomerIdField, for the
  // same reason: there is no persistent, addressable URL for an uploaded source
  // document in this system (no object storage / MinIO exists here), so an ADO
  // Hyperlink relation would point at a URL that doesn't resolve to anything.
  // Appending the reference into System.Description was also rejected -- that
  // would violate BASELINE's verbatim-fidelity contract (the description must
  // be exactly the source text, nothing appended). A dedicated field, set only
  // when the real org actually exposes one, is the only mechanism that is both
  // real and non-destructive. Left off (not a hard failure) when no candidate
  // field exists on that work-item type, exactly like Customer ID.
  private async resolveSourceRefField(
    workItemType: string,
    credential?: { orgUrl: string; pat: string },
  ): Promise<string | null> {
    const candidates = ['Custom.SourceReference', 'Custom.SourceDocument', 'Custom.TraceabilityRef'];
    const availableFields = await this.mcpClient.discoverFields(workItemType, credential);
    return candidates.find((candidate) => availableFields.includes(candidate)) ?? null;
  }

  private static formatSourceRef(sourceRef: {
    documentPath: string;
    startOffset: number;
    endOffset: number;
    page: number | null;
  }): string {
    const range = `${sourceRef.startOffset}-${sourceRef.endOffset}`;
    return sourceRef.page !== null
      ? `${sourceRef.documentPath}#page=${sourceRef.page}&offset=${range}`
      : `${sourceRef.documentPath}#offset=${range}`;
  }

  async getById(
    id: string,
  ): Promise<{
    id: string;
    status: string;
    mode: string;
    dryRunDiff: unknown;
    warnings: string[];
    kbCitations: unknown;
    createdAt: Date;
  } | null> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) return null;
    return {
      id: job.id,
      status: job.status,
      mode: job.mode,
      dryRunDiff: job.dryRunDiff,
      warnings: (job.warnings as string[] | null) ?? [],
      kbCitations: job.kbCitations,
      createdAt: job.createdAt,
    };
  }

  async list(): Promise<JobSummary[]> {
    const rows = await this.prisma.job.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, mode: true, status: true, areaPath: true, dryRunDiff: true, createdAt: true },
    });
    return rows.map((row) => ({
      id: row.id,
      mode: row.mode,
      status: row.status,
      areaPath: row.areaPath,
      itemCount: Array.isArray(row.dryRunDiff) ? row.dryRunDiff.length : 0,
      createdAt: row.createdAt,
    }));
  }

  async setDiffEntryExcluded(id: string, localId: string, excluded: boolean): Promise<DryRunDiffEntry[]> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    if (job.status !== 'diff_ready') {
      throw new ConflictException(`Job ${id} is not in a diff-editable state`);
    }
    const diff = (job.dryRunDiff as unknown as DryRunDiffEntry[]) ?? [];
    const index = diff.findIndex((entry) => entry.localId === localId);
    if (index === -1) throw new NotFoundException(`Diff entry ${localId} not found`);
    diff[index] = { ...diff[index], excluded };
    await this.prisma.job.update({ where: { id }, data: { dryRunDiff: diff as any } });
    return diff;
  }

  async editDiffEntry(id: string, localId: string, patch: { title?: string; description?: string }): Promise<DryRunDiffEntry[]> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    if (job.status !== 'diff_ready') {
      throw new ConflictException(`Job ${id} is not in a diff-editable state`);
    }
    const diff = (job.dryRunDiff as unknown as DryRunDiffEntry[]) ?? [];
    const index = diff.findIndex((entry) => entry.localId === localId);
    if (index === -1) throw new NotFoundException(`Diff entry ${localId} not found`);
    if (diff[index].action !== 'create') {
      throw new BadRequestException('only create entries can be edited');
    }
    // A patch key present with an explicit `undefined` value (as sent by the
    // controller for a caller who never mentioned that field) must not
    // overwrite the existing value — only apply keys the caller actually set.
    const definedPatch: { title?: string; description?: string } = {};
    if (patch.title !== undefined) definedPatch.title = patch.title;
    if (patch.description !== undefined) definedPatch.description = patch.description;
    diff[index] = { ...diff[index], ...definedPatch };
    await this.prisma.job.update({ where: { id }, data: { dryRunDiff: diff as any } });
    return diff;
  }

  async addDiffEntry(
    id: string,
    input: { parentLocalId: string; type: string; title: string; description: string },
  ): Promise<DryRunDiffEntry[]> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    if (job.status !== 'diff_ready') {
      throw new ConflictException(`Job ${id} is not in a diff-editable state`);
    }
    const diff = (job.dryRunDiff as unknown as DryRunDiffEntry[]) ?? [];
    const parentEntry = diff.find((entry) => entry.localId === input.parentLocalId);
    if (!parentEntry) throw new NotFoundException(`Diff entry ${input.parentLocalId} not found`);
    if (parentEntry.isManual) {
      throw new BadRequestException('cannot add a child under a manually-added entry');
    }
    if (job.mode === 'baseline') {
      if (input.type !== parentEntry.childType) {
        throw new BadRequestException(`type '${input.type}' does not match the required child type '${parentEntry.childType}'`);
      }
    } else {
      const validTypes = ['Epic', 'Feature', 'Requirement'];
      if (!validTypes.includes(input.type)) {
        throw new BadRequestException(`type must be one of ${validTypes.join(', ')}`);
      }
    }
    const sourceHash = createHash('sha256').update(input.description).digest('hex');
    const newEntry: DryRunDiffEntry = {
      localId: `manual-${diff.length}-${Date.now()}`,
      parentLocalId: input.parentLocalId,
      type: input.type,
      title: input.title,
      description: input.description,
      action: 'create',
      existingAdoId: null,
      similarity: null,
      sourceHash,
      customerId: null,
      tags: [],
      qualityScore: null,
      qualityIssues: [],
      childType: null,
      isManual: true,
    };
    const updated = [...diff, newEntry];
    await this.prisma.job.update({ where: { id }, data: { dryRunDiff: updated as any } });
    return updated;
  }

  // Mirrors frontend/src/pages/JobStatus.tsx's needsReview() thresholds --
  // duplicated (not imported) because frontend and orchestrator are separate
  // deployables with no shared package for these constants, same as that
  // file's own comment mirroring ingestion's llm_leveling thresholds.
  private static readonly LOW_GROUNDING_THRESHOLD = 0.2;
  private static readonly LOW_QUALITY_THRESHOLD = 50;

  private static isFlagged(entry: { groundingScore?: number | null; qualityScore?: number | null }): boolean {
    return (
      (entry.groundingScore != null && entry.groundingScore < JobsService.LOW_GROUNDING_THRESHOLD) ||
      (entry.qualityScore != null && entry.qualityScore < JobsService.LOW_QUALITY_THRESHOLD)
    );
  }

  async getSummary(id: string): Promise<{
    created: number;
    reused: number;
    dedupSkipped: number;
    flagged: number;
    warnings: string[];
  } | null> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) return null;
    const diff = (job.dryRunDiff as { action: string; groundingScore?: number | null; qualityScore?: number | null }[] | null) ?? [];
    return {
      created: diff.filter((e) => e.action === 'create').length,
      reused: diff.filter((e) => e.action === 'reuse').length,
      dedupSkipped: diff.filter((e) => e.action === 'dedup_skip').length,
      flagged: diff.filter((e) => JobsService.isFlagged(e)).length,
      warnings: (job.warnings as string[] | null) ?? [],
    };
  }

  // Post-write validation: reads back every work item this job actually
  // created (via CreatedItemMapping, the same P4b resume state confirm()
  // itself writes) and compares its real ADO fields/parent link against
  // what the dry-run diff expected. Closes a real gap: confirm() previously
  // wrote and moved on with zero verification that ADO's stored state
  // matches what was sent -- a silently-dropped/altered field (e.g. an ADO
  // field-length truncation, a picklist coercion) would never surface.
  // Read-only -- makes no ADO writes itself, only GETs via
  // getWorkItemsBatch.
  async validateCreatedTree(
    id: string,
    credential?: { orgUrl: string; pat: string },
  ): Promise<{
    valid: boolean;
    checkedCount: number;
    mismatches: { localId: string; adoWorkItemId: number; field: string; expected: string; actual: string }[];
  } | null> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) return null;

    const mappings = await this.prisma.createdItemMapping.findMany({ where: { jobId: id } });
    if (mappings.length === 0) {
      return { valid: true, checkedCount: 0, mismatches: [] };
    }

    const adoIdByLocalId = new Map(mappings.map((m) => [m.localId, m.adoWorkItemId]));
    const diff = (job.dryRunDiff as { localId: string; parentLocalId: string | null; title: string; description: string }[] | null) ?? [];
    const diffByLocalId = new Map(diff.map((entry) => [entry.localId, entry]));

    const items = await this.mcpClient.getWorkItemsBatch(
      mappings.map((m) => m.adoWorkItemId),
      credential,
    );
    const itemById = new Map(items.map((item) => [item.id, item]));

    const mismatches: { localId: string; adoWorkItemId: number; field: string; expected: string; actual: string }[] = [];
    for (const mapping of mappings) {
      const entry = diffByLocalId.get(mapping.localId);
      const item = itemById.get(mapping.adoWorkItemId);
      if (!entry) continue; // dryRunDiff no longer has this node -- nothing to compare against
      if (!item) {
        mismatches.push({
          localId: mapping.localId, adoWorkItemId: mapping.adoWorkItemId,
          field: 'existence', expected: 'work item exists in ADO', actual: 'not found',
        });
        continue;
      }
      if (item.fields['System.Title'] !== entry.title) {
        mismatches.push({
          localId: mapping.localId, adoWorkItemId: mapping.adoWorkItemId,
          field: 'System.Title', expected: entry.title, actual: item.fields['System.Title'] ?? '',
        });
      }
      if (item.fields['System.Description'] !== entry.description) {
        mismatches.push({
          localId: mapping.localId, adoWorkItemId: mapping.adoWorkItemId,
          field: 'System.Description', expected: entry.description, actual: item.fields['System.Description'] ?? '',
        });
      }
      const expectedParentAdoId = entry.parentLocalId !== null ? (adoIdByLocalId.get(entry.parentLocalId) ?? null) : null;
      if (expectedParentAdoId !== item.parentId) {
        mismatches.push({
          localId: mapping.localId, adoWorkItemId: mapping.adoWorkItemId,
          field: 'parentId', expected: String(expectedParentAdoId), actual: String(item.parentId),
        });
      }
    }

    return { valid: mismatches.length === 0, checkedCount: mappings.length, mismatches };
  }

  // Rejecting is only meaningful from 'diff_ready' -- once writing/succeeded,
  // real ADO writes may already exist and a reject can't undo those
  // (P4b's CreatedItemMapping enables safe RESUME of a failed confirm, not
  // rollback/deletion of a job that succeeded or is mid-write).
  async reject(id: string): Promise<{ status: string }> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job || job.status !== 'diff_ready') {
      throw new Error(`Job ${id} is not in a rejectable state`);
    }
    await this.prisma.job.update({ where: { id }, data: { status: 'rejected' } });
    await this.prisma.auditEntry.create({ data: { jobId: id, message: 'Job rejected: no work items written' } });
    return { status: 'rejected' };
  }

  async confirm(
    id: string,
    credential?: { orgUrl: string; pat: string },
    // Row-level deselect: when provided, only 'create' entries whose localId
    // is in this set are written -- everything else (reuse/dedup_skip
    // entries, which never trigger a create anyway) is unaffected. Omitted
    // entirely (not just empty) means "select all", matching the previous
    // all-or-nothing behavior byte-for-byte for every existing caller. This
    // is independent of, and additive with, the persistent `excluded` flag
    // set via setDiffEntryExcluded below -- either mechanism can drop a node.
    selectedLocalIds?: string[],
  ): Promise<{ status: string; createdCount: number }> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job || job.status !== 'diff_ready') {
      throw new Error(`Job ${id} is not in a confirmable state`);
    }
    await this.prisma.job.update({ where: { id }, data: { status: 'writing' } });

    // Each diff entry carries its own sourceHash/customerId (per-node content
    // hash), NOT job.sourceHash (a whole-file hash) — see DryRunDiffEntry's
    // doc comment for why recording at job-level granularity silently broke
    // re-run idempotency (found via the golden E2E script: job #2's re-run
    // always showed 'create' since the recorded key never matched the
    // per-node key diff() looks up by).
    const diff = job.dryRunDiff as {
      localId: string;
      parentLocalId: string | null;
      type: string;
      title: string;
      description: string;
      action: string;
      existingAdoId: number | null;
      sourceHash: string;
      customerId: string | null;
      // Carried through from ingestion (see DryRunDiffEntry). sourceRef is
      // written to ADO below (see resolveSourceRefField); tags feeds
      // System.Tags directly. Both optional/nullable: manually-added entries
      // (addDiffEntry) and older-shaped fixtures may omit either entirely.
      sourceRef?: { documentPath: string; startOffset: number; endOffset: number; page: number | null } | null;
      tags?: string[];
      excluded?: boolean;
      traceLinks?: {
        sourceLocalId: string;
        referenceName: string;
        targetKind: 'intraJob' | 'crossJob';
        targetLocalId?: string;
        targetCustomerId?: string;
        resolvedAdoId?: number;
        resolutionStatus: 'resolved' | 'unresolved' | 'pending';
      }[];
    }[];

    // Excluding an entry excludes its whole subtree too, even if a descendant
    // itself isn't marked excluded — walk parentLocalId ancestry to find out.
    const diffById = new Map(diff.map((entry) => [entry.localId, entry] as const));
    function isExcluded(entry: (typeof diff)[number]): boolean {
      let current: typeof entry | undefined = entry;
      while (current) {
        if (current.excluded) return true;
        current = current.parentLocalId ? diffById.get(current.parentLocalId) : undefined;
      }
      return false;
    }

    // Resume support (P4b, previously "not yet built" -- see this method's
    // old catch-block comment): a durable local-id -> ADO-id mapping,
    // written immediately after each create/link succeeds (not batched at
    // the end), so a failure partway through THIS call, or a prior call
    // that already got partway through, leaves correct state for a safe
    // retry. Loaded once up front; `resumedAdoIdByLocalId`/
    // `alreadyLinkedLocalIds` reflect what was already durably written
    // before this call started.
    const existingMappings = await this.prisma.createdItemMapping.findMany({ where: { jobId: id } });
    const resumedAdoIdByLocalId = new Map(existingMappings.map((m) => [m.localId, m.adoWorkItemId]));
    const alreadyLinkedLocalIds = new Set(existingMappings.filter((m) => m.linked).map((m) => m.localId));

    // Tree order from ingestion (parents appear before children — see
    // tree_builder.py's stack-based construction) means a single left-to-right
    // pass is sufficient: every entry's parentLocalId, if non-null, already
    // has its ADO id in this map by the time we reach the child.
    const adoIdByLocalId = new Map<string, number>(resumedAdoIdByLocalId);
    // Customer ID's real ref name is runtime-verified per work-item type, not
    // hardcoded (docs/architecture.md's "Customer ID Field Resolution") —
    // cached per type for this confirm() call so discoverFields is called at
    // most once per distinct type in the diff, not once per node.
    const customerIdFieldByType = new Map<string, string | null>();
    // Same runtime-verified, per-type, cached-once resolution for the source
    // traceability field (see resolveSourceRefField's doc comment).
    const sourceRefFieldByType = new Map<string, string | null>();
    let createdCount = 0;

    // A failure anywhere below previously left the job stuck in 'writing'
    // forever -- confirm()'s own guard requires 'diff_ready', so no retry
    // was ever possible again without a manual DB fix. Now that
    // CreatedItemMapping durably records every create/link as it happens
    // (see above), a retry is ALWAYS safe regardless of createdCount: the
    // toCreate/toLink filters below skip anything already durably recorded,
    // so reverting to 'diff_ready' can no longer re-create an already-
    // written item (see the catch block at the end of this method).
    // Collected during the create loop below, upserted into the dedup
    // vector store in ONE batched call after the loop finishes -- previously
    // each newly-created item triggered its own /dedup/upsert call (one
    // embed() round-trip per item) inline in the loop.
    const dedupUpsertItems: { itemId: string; text: string; areaPath: string }[] = [];

    try {
      // Split into 'already resolved' (reuse/dedup_skip, cheap+sync) vs
      // 'needs a real create' -- the two are handled by completely
      // different phases below.
      const toCreate: typeof diff = [];
      for (const entry of diff) {
        if (isExcluded(entry)) continue;
        // 'dedup_skip' is skipped the same as 'reuse': both already have a
        // real ADO id to point at, just with different certainty (exact-hash
        // fact vs embedding-similarity judgment) — see DryRunDiffEntry's doc
        // comment. Neither should trigger a create.
        if ((entry.action === 'reuse' || entry.action === 'dedup_skip') && entry.existingAdoId !== null) {
          adoIdByLocalId.set(entry.localId, entry.existingAdoId);
          continue;
        }
        // Deselected 'create' rows are dropped entirely here: not created,
        // and (since adoIdByLocalId never gets an entry for them) any child
        // whose parentLocalId points at a deselected node simply won't be
        // linked below -- the same "only link when both ends resolved"
        // guard the dedup_skip-as-child case already relies on.
        if (selectedLocalIds !== undefined && !selectedLocalIds.includes(entry.localId)) {
          continue;
        }
        // Resume: this localId was already created in a prior attempt at
        // this same job (adoIdByLocalId was seeded from resumedAdoIdByLocalId
        // above) -- do not create it again.
        if (resumedAdoIdByLocalId.has(entry.localId)) {
          continue;
        }
        toCreate.push(entry);
      }

      // Pre-resolve every distinct type's Customer ID field BEFORE the
      // concurrent create phase below -- discoverFields is idempotent, so a
      // race between concurrent creates of the same type would only be
      // wasteful (not incorrect), but resolving up front avoids that
      // entirely and keeps customerIdFieldByType's "at most once per type"
      // guarantee exact even under concurrency.
      for (const entry of toCreate) {
        if (entry.customerId != null && !customerIdFieldByType.has(entry.type)) {
          customerIdFieldByType.set(entry.type, await this.resolveCustomerIdField(entry.type, credential));
        }
        if (entry.sourceRef != null && !sourceRefFieldByType.has(entry.type)) {
          sourceRefFieldByType.set(entry.type, await this.resolveSourceRefField(entry.type, credential));
        }
      }

      // Every create is fully independent of every other create (fields
      // are self-contained; parent linking is a separate phase below that
      // only starts once ALL creates have finished) -- safe to run with
      // bounded concurrency instead of the previous one-ADO-round-trip-at-
      // a-time sequential loop. mapWithConcurrency preserves array order in
      // its results regardless of completion order.
      const createResults = await mapWithConcurrency(toCreate, this.writeConcurrency, async (entry) => {
        const fields: Record<string, string> = {
          'System.Title': entry.title,
          'System.Description': entry.description,
          'System.State': job.state,
          'System.AreaPath': job.areaPath,
        };
        if (job.iterationPath) {
          fields['System.IterationPath'] = job.iterationPath;
        }
        const tags = [...(entry.tags ?? [])];
        if (entry.customerId != null) {
          const customerIdField = customerIdFieldByType.get(entry.type);
          if (customerIdField !== null && customerIdField !== undefined) {
            fields[customerIdField] = entry.customerId;
          } else {
            // Non-type-gated fallback: this work-item type exposes no
            // Custom.CustomerId-style field at all (e.g. Epic/Feature in the
            // tested org, which only defines it on Requirement) -- rather
            // than silently dropping the customer ID for that type, stamp it
            // into System.Tags (a native field every type has) so it is at
            // least visible somewhere on the item, not lost entirely.
            tags.push(`CustomerId:${entry.customerId}`);
          }
        }
        if (entry.sourceRef != null) {
          const sourceRefField = sourceRefFieldByType.get(entry.type);
          if (sourceRefField !== null && sourceRefField !== undefined) {
            fields[sourceRefField] = JobsService.formatSourceRef(entry.sourceRef);
          } else {
            // Same non-type-gated fallback as Customer ID above: this org
            // exposes no Custom.SourceReference-style field at all for this
            // work-item type -- rather than silently dropping traceability
            // (the previous behavior), stamp it into System.Tags so it's at
            // least visible somewhere. NOT appended to System.Description --
            // that's rejected elsewhere in this file as violating BASELINE's
            // verbatim-fidelity guarantee (see resolveSourceRefField's own
            // doc comment).
            tags.push(`SourceRef:${JobsService.formatSourceRef(entry.sourceRef)}`);
          }
        }
        // System.Tags is a native ADO field on every work-item type (unlike
        // Custom.CustomerId/SourceRef, it needs no discoverFields gating).
        // Deliberately NOT also writing Microsoft.VSTS.CMMI.RequirementType:
        // that field is picklist-constrained by the org's process template,
        // and ado_discover_fields only returns field *names*, never the
        // allowed values for a field -- writing an unvalidated free-text tag
        // into a picklist field would 400 the entire create on any org whose
        // allowed values don't happen to match our 11-tag taxonomy verbatim.
        if (tags.length > 0) {
          fields['System.Tags'] = tags.join('; ');
        }
        const created = await this.mcpClient.createWorkItem(entry.type, fields, credential);
        await this.idempotencyService.record(entry.sourceHash, entry.customerId, job.areaPath, created.id);
        // Durable resume state (P4b): written immediately, not batched at
        // the end of the create loop, so a LATER item in this same
        // mapWithConcurrency batch failing doesn't lose the fact that THIS
        // one was already created -- the next confirm() retry will see this
        // row and skip re-creating it.
        await this.prisma.createdItemMapping.upsert({
          where: { jobId_localId: { jobId: id, localId: entry.localId } },
          create: { jobId: id, localId: entry.localId, adoWorkItemId: created.id },
          update: { adoWorkItemId: created.id },
        });
        return created;
      });

      let firstCreateError: unknown = null;
      for (let i = 0; i < toCreate.length; i++) {
        const result = createResults[i];
        const entry = toCreate[i];
        if (result.status === 'rejected') {
          firstCreateError ??= result.reason;
          continue;
        }
        adoIdByLocalId.set(entry.localId, result.value.id);
        // Backstop future dedup checks against this newly-real item --
        // collected here, actually upserted in one batched call below.
        dedupUpsertItems.push({ itemId: String(result.value.id), text: entry.description, areaPath: job.areaPath });
        createdCount += 1;
      }
      if (firstCreateError !== null) {
        throw firstCreateError;
      }

      // Best-effort, same as the per-item version it replaces: a batch
      // upsert failure must not fail writes that already succeeded in ADO —
      // it only means those items' future near-duplicates might not be
      // caught. Trade-off versus the old per-item try/catch: one failure now
      // loses the dedup backstop for the whole batch, not just one item —
      // acceptable, since the batch is one job's worth of creates, and a
      // dedup-service outage failing open for an entire job (not silently
      // for scattered individual items) is easier to notice and re-run.
      if (dedupUpsertItems.length > 0) {
        try {
          await this.ingestionClient.upsertDedupEntriesBatch(dedupUpsertItems);
        } catch (error) {
          // eslint-disable-next-line no-console -- operational visibility for a best-effort path, not app logging
          console.error(`Dedup batch upsert failed for ${dedupUpsertItems.length} newly-created item(s):`, error);
        }
      }

      // Every link is independent of every other link (each just PATCHes
      // one child work item's parent relation) -- safe to run with the same
      // bounded concurrency as the create phase, once ALL creates above
      // have finished (adoIdByLocalId is fully populated by this point).
      const toLink = diff.filter((entry) => {
        if (entry.parentLocalId === null) return false;
        if (isExcluded(entry)) return false;
        // Never re-parent an existing ADO item based on a probabilistic
        // dedup match — that would silently mutate real ADO hierarchy off a
        // similarity guess, not a certainty. A NEW child linking UP to a
        // dedup_skip parent is fine (parentAdoId lookup still resolves); only
        // the skip-node-as-a-CHILD case is suppressed here.
        if (entry.action === 'dedup_skip') return false;
        // Resume: this localId's link already succeeded in a prior attempt
        // at this same job -- do not PATCH the relation again.
        if (alreadyLinkedLocalIds.has(entry.localId)) return false;
        return adoIdByLocalId.has(entry.localId) && adoIdByLocalId.has(entry.parentLocalId as string);
      });
      const linkResults = await mapWithConcurrency(toLink, this.writeConcurrency, async (entry) => {
        await this.mcpClient.linkParentChild(
          adoIdByLocalId.get(entry.localId) as number,
          adoIdByLocalId.get(entry.parentLocalId as string) as number,
          credential,
        );
        // Durable resume state (P4b): written immediately per successful
        // link, same rationale as the create-phase upsert above.
        await this.prisma.createdItemMapping.update({
          where: { jobId_localId: { jobId: id, localId: entry.localId } },
          data: { linked: true },
        });
      });
      const firstLinkError = linkResults.find((r) => r.status === 'rejected');
      if (firstLinkError && firstLinkError.status === 'rejected') {
        throw firstLinkError.reason;
      }

      // Trace-link writes fire last, once every entry in this confirm() call
      // has a real ADO id in adoIdByLocalId — same ordering guarantee the
      // parent-child loop above relies on. Unresolved links (bad customer id,
      // or a targetLocalId that isn't in this diff — e.g. its subtree was
      // excluded) are skipped, never thrown: per the project's "never block"
      // philosophy, a broken trace link must not fail the whole confirm.
      for (const entry of diff) {
        if (isExcluded(entry)) continue;
        for (const link of entry.traceLinks ?? []) {
          const sourceAdoId = adoIdByLocalId.get(link.sourceLocalId);
          if (sourceAdoId === undefined) continue;
          let targetAdoId: number | undefined;
          if (link.targetKind === 'intraJob' && link.targetLocalId) {
            targetAdoId = adoIdByLocalId.get(link.targetLocalId);
          } else if (link.targetKind === 'crossJob' && link.resolutionStatus === 'resolved') {
            targetAdoId = link.resolvedAdoId;
          }
          if (targetAdoId === undefined) continue;
          // Best-effort: a trace-link write failure (rejected rel, deleted
          // crossJob target, transient network error) must not abort confirm()
          // after work items in this call have already been created/parented.
          try {
            await this.mcpClient.linkWorkItems(sourceAdoId, targetAdoId, link.referenceName, credential);
          } catch (error) {
            // eslint-disable-next-line no-console -- operational visibility for a best-effort path, not app logging
            console.error(`Trace-link write failed for ${sourceAdoId} -> ${targetAdoId}:`, error);
          }
        }
      }
    } catch (error) {
      // Always safe to retry now: CreatedItemMapping durably recorded every
      // create/link that succeeded before this failure, so the next
      // confirm() call will skip them rather than re-creating/re-linking --
      // unlike before P4b existed, a partial write here no longer needs to
      // be marked 'failed' to avoid duplicating already-written items.
      await this.prisma.job.update({ where: { id }, data: { status: 'diff_ready' } });
      await this.prisma.auditEntry.create({
        data: { jobId: id, message: `Confirm failed (safe to retry): ${(error as Error).message}` },
      });
      throw error;
    }

    await this.prisma.job.update({
      where: { id },
      data: { status: 'succeeded', confirmedAt: new Date(), completedAt: new Date() },
    });
    await this.prisma.auditEntry.create({
      data: { jobId: id, message: `Job confirmed: ${createdCount} work item(s) created` },
    });
    return { status: 'succeeded', createdCount };
  }
}
