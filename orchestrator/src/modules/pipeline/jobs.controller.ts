import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  PayloadTooLargeException,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  Optional,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Body } from '@nestjs/common';
import type { Response } from 'express';
import { JobsService, JobSummary, type JobDetail } from './jobs.service';
import { IngestionHttpClient, type RewriteComparison } from './ingestion-http.client';
import { WorkItemTypeCatalogService, type WorkItemTypeCatalogEntry } from './work-item-type-catalog.service';
import { jobFigureFileUploadSchema } from './job-figure-file.dto';
import { etaEstimateQuerySchema } from './eta-estimate.dto';
import { jobsListQuerySchema } from './jobs-list.dto';
import { EtaService, type EtaEstimate } from './eta.service';
import { buildDocumentMap, type DocumentMapSection } from './document-map';
import { DocumentOverviewService } from './document-overview.service';
import { createHash } from 'crypto';
import { OpenWebUiClientFactory } from '../llm/openwebui-client.factory';
import { ModelHealthService } from '../llm/model-health.service';
import { LlmProxyBearerGuard } from '../llm/llm-proxy-bearer.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { AdoCredentialResolver } from '../auth/ado-credential.resolver';
import type { WarningRecord } from '../writeback/dry-run.service';
import { Public } from '../auth/public.decorator';
import { VALID_REQUIREMENT_TAGS } from '../../config/requirement-type-fields';

// A DELIBERATE SUBSET of ingestion/app/dispatch.py's own _SUPPORTED_EXTENSIONS
// (which also accepts .pptx/.csv/.rtf/images -- used by the KB ingest path,
// where a wider range of reference material is a reasonable, lower-risk
// feature since KB ingestion never writes back to ADO). Job creation is
// intentionally narrower, restricted to the formats this pipeline is
// actually tested/hardened for end to end. This used to claim (falsely) to
// "match ingestion's loaders" -- it never did; see
// allowed-extensions.drift-guard.spec.ts for the mechanical check that this
// subset relationship holds, so it can't silently drift further without a
// test failure. Not a security boundary against malicious file CONTENT
// (that's ingestion's own parsing robustness), only a cheap
// reject-obviously-wrong-format-early gate. Exported for reuse by
// BatchController/BatchService (NEW-05) -- a batch file must be validated
// against the exact same rules as a single-file submit(), not a second
// hand-maintained copy of them.
export const ALLOWED_EXTENSIONS = new Set(['.txt', '.md', '.docx', '.pdf', '.xlsx']);

// Customer ID (per-Requirement source reference, e.g. "1.1.2.2") stays a
// free-form identifier -- no format/regex is enforced since the source
// document's own numbering/ID scheme isn't known ahead of time. Only a
// generous length ceiling to catch an obviously-wrong paste.
export const MAX_CUSTOMER_ID_LENGTH = 128;
// One retry request's item cap -- below ingestion's own per-call limit (150), so a
// batch is always a single LLM call.
const MAX_RETRY_ENHANCEMENT_ITEMS = 100;
// A parent's request carries every descendant's text, so far fewer fit in one call (ingestion caps it at 25 too).
const MAX_RETRY_PARENT_SUMMARY_ITEMS = 25;

// Same free-form-identifier reasoning as MAX_CUSTOMER_ID_LENGTH above --
// see WorkItemNode.se_coverage_ref's own docstring (ingestion side) for
// what this field actually is.
export const MAX_SE_COVERAGE_REF_LENGTH = 128;

// Requirement classification tags, unlike Customer ID, ARE validated against
// a closed vocabulary -- see VALID_REQUIREMENT_TAGS's own doc comment for
// why that list (not one org's live ADO allowedValues) is the right thing
// to validate a PATCH against.

// Multer's own decorator-time limit must be evaluated BEFORE NestJS DI
// resolves anything (decorator arguments run at class-definition time), so
// it can't read the real MAX_UPLOAD_SIZE_MB config value. Set generously
// high here (500MB) so it never becomes the effective ceiling itself — the
// real, configurable enforcement is the `file.size > this.maxUploadSizeBytes`
// check below, which DOES see the DI-resolved value. Without this generous
// gap, raising MAX_UPLOAD_SIZE_MB above this literal would silently have no
// effect, since Multer would already have rejected the upload first.
const MULTER_SAFETY_CEILING_BYTES = 500 * 1024 * 1024;

// Per-figure cap, same reasoning as JobSourceFile's MAX_STORED_SOURCE_BYTES
// (jobs.service.ts) but sized for a single already-compressed line-diagram
// PNG (ingestion resizes to ~1600-2000px long edge + optimize=True before
// ever posting here) rather than a whole source document -- an oversized
// figure just doesn't get attachment capability, it never fails the job
// (see docs on _describe_figure_with_progress's caller).
const MAX_FIGURE_FILE_BYTES = 8 * 1024 * 1024;

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobsService: JobsService,
    private readonly ingestionClient: IngestionHttpClient,
    private readonly clientFactory: OpenWebUiClientFactory,
    private readonly adoCredentialResolver: AdoCredentialResolver,
    private readonly workItemTypeCatalogService: WorkItemTypeCatalogService,
    private readonly etaService: EtaService,
    @Inject('MAX_UPLOAD_SIZE_BYTES') private readonly maxUploadSizeBytes: number,
    private readonly documentOverviewService: DocumentOverviewService,
    @Optional() private readonly modelHealth?: ModelHealthService,
  ) {}

  @Get()
  async list(@CurrentUser() user: SessionUser, @Query() rawQuery: unknown): Promise<JobSummary[]> {
    const parseResult = jobsListQuerySchema.safeParse(rawQuery);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid query: skip must be a non-negative integer; take must be an integer between 1 and 200');
    }
    return this.jobsService.list(user.userId, parseResult.data);
  }

  // Shared by every per-job route below: fetches the job and throws 404
  // (not 403) unless it belongs to the caller -- a job id must not be
  // enumerable by trying it and reading the status code (404 for "doesn't
  // exist" and "exists but isn't yours" look identical to the caller).
  private async ownedJob(id: string, user: SessionUser): Promise<NonNullable<Awaited<ReturnType<JobsService['getById']>>>> {
    const job = await this.jobsService.getById(id);
    if (!job || job.userId !== user.userId) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    return job;
  }

  // Frontend-reachable model list for SURVEY mode's per-job model picker.
  // Deliberately separate from /llm/models (LlmController), which is
  // guarded by LlmProxyBearerGuard for service-to-service use only and
  // isn't reachable from a browser session.
  // Filtered through listSelectableModels() (base models only, see B2's own
  // doc comment on that method) but kept on the pre-existing {models:
  // string[]} wire shape -- this picker only ever needed model ids, and
  // changing the shape would require an unrelated frontend rewrite outside
  // this fix's scope.
  // A model hidden by LLM_MODEL_HIDE_PATTERNS (unusable entries, persona agents, retired aliases) is also refused
  // here, so an API caller or an old job that names one fails fast and clearly instead of breaking mid-run.
  private async assertModelAllowed(model: string | null | undefined): Promise<void> {
    if (!model) return;
    if (this.clientFactory.isModelHidden(model) || (await this.modelHealth?.isFailed(model))) {
      throw new BadRequestException(
        `Model "${model}" is not available for requirement extraction. Choose another model.`,
      );
    }
  }

  @Get('models')
  async listModels(@CurrentUser() user: SessionUser): Promise<{ models: string[] }> {
    const client = await this.clientFactory.getClientFor(user.userId);
    const models = await client.listSelectableModels();
    const visible = (await this.modelHealth?.filterVisible(user.userId, models)) ?? models;
    return { models: visible.map((m) => m.id) };
  }

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MULTER_SAFETY_CEILING_BYTES },
    }),
  )
  async submit(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: SessionUser,
    @Body('areaPath') areaPath: string | undefined,
    @Body('adoProject') adoProject: string | undefined,
    @Body('mode') mode: string | undefined,
    @Body('state') state: string | undefined,
    @Body('iterationPath') iterationPath: string | undefined,
    @Body('model') model: string | undefined,
    @Body('documentOverview') documentOverviewRaw: string | undefined,
  ): Promise<{ jobId: string }> {
    await this.assertModelAllowed(model);
    if (!file) {
      throw new BadRequestException('file is required');
    }
    if (file.size > this.maxUploadSizeBytes) {
      throw new PayloadTooLargeException(
        `file exceeds the ${Math.round(this.maxUploadSizeBytes / 1024 / 1024)}MB upload limit`,
      );
    }
    const ext = file.originalname.slice(file.originalname.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new BadRequestException(`unsupported file type: ${ext}`);
    }
    if (!areaPath) {
      throw new BadRequestException('areaPath is required');
    }
    // adoProject is optional at the wire level (a non-ADO-session mock
    // context can submit with neither set), but when BOTH are present they
    // must agree -- an area path's first segment is always its project
    // (confirmed convention in this deployment), so a mismatch means the
    // client sent something inconsistent rather than a value we should
    // silently prefer one side of.
    if (adoProject && adoProject !== areaPath.split('\\')[0]) {
      throw new BadRequestException(
        `adoProject ('${adoProject}') does not match areaPath's project segment ('${areaPath.split('\\')[0]}')`,
      );
    }
    if (mode !== undefined && mode !== 'baseline' && mode !== 'survey') {
      throw new BadRequestException(`mode must be 'baseline' or 'survey', got: ${mode}`);
    }
    const sourceHash = createHash('sha256').update(file.buffer).digest('hex');
    // Parsed defensively -- a malformed/unexpected shape must never fail
    // job creation, same fail-open contract DocumentOverviewService itself
    // already follows.
    let documentOverview: { synopsis: string; caveat: string | null } | null = null;
    if (documentOverviewRaw) {
      try {
        const parsed = JSON.parse(documentOverviewRaw);
        if (parsed && typeof parsed.synopsis === 'string') {
          documentOverview = { synopsis: parsed.synopsis, caveat: typeof parsed.caveat === 'string' ? parsed.caveat : null };
        }
      } catch {
        documentOverview = null;
      }
    }
    return this.jobsService.submit({
      areaPath,
      adoProject: adoProject ?? null,
      // The submitting user's stable ADO identity (see Job.userId's own doc
      // comment) -- the Knowledge Base scope key, kept separate from
      // areaPath (ADO write-back destination only). Now the session's own
      // identity (AuthGuard), never client-supplied -- a caller could
      // previously submit a job under any userId string it liked.
      userId: user.userId,
      mode: (mode as 'baseline' | 'survey' | undefined) ?? 'baseline',
      fileBuffer: file.buffer,
      filename: file.originalname,
      sourceHash,
      state,
      iterationPath: iterationPath ?? null,
      model,
      documentOverview,
    });
  }

  @Post('preview')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MULTER_SAFETY_CEILING_BYTES },
    }),
  )
  async preview(
    @UploadedFile() file: Express.Multer.File | undefined,
    // Optional -- DESIGN.md §11.2.3.d: NewJobWizard.tsx defaults `mode` to
    // 'baseline' before the user has chosen anything, so preview must be
    // told which mode's estimate to return rather than assuming one.
    // Unset mode/model fall back to the same defaults estimate()/EtaService
    // itself already applies (survey mode default handled by the caller;
    // an unset model resolves to the configured default inside EtaService).
    @Body('mode') mode: string | undefined,
    @Body('model') model: string | undefined,
  ): Promise<{
    blockCount: number;
    sectionCount: number;
    figureCount: number;
    depth: number;
    fileType: string;
    estimate: EtaEstimate;
    // DESIGN.md §11.1 -- the wizard step-1 document map ("what did it
    // read") and the "Worth knowing before you run it" card both need real,
    // derivable-from-the-parse data beyond the 4 aggregate stat tiles.
    tableCount: number;
    openTbdCount: number;
    documentMap: DocumentMapSection[];
  }> {
    await this.assertModelAllowed(model);
    if (!file) {
      throw new BadRequestException('file is required');
    }
    if (file.size > this.maxUploadSizeBytes) {
      throw new PayloadTooLargeException(
        `file exceeds the ${Math.round(this.maxUploadSizeBytes / 1024 / 1024)}MB upload limit`,
      );
    }
    const ext = file.originalname.slice(file.originalname.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new BadRequestException(`unsupported file type: ${ext}`);
    }
    if (mode !== undefined && mode !== 'baseline' && mode !== 'survey') {
      throw new BadRequestException(`mode must be 'baseline' or 'survey', got: ${mode}`);
    }
    // CanonicalDoc (ingestion/app/canonical/model.py) has no top-level
    // `sections` field — only `document`, `blocks`, `tables`, `figures`.
    // Each Block carries a `kind` (BlockKind str-enum) and, for headings,
    // a `heading_level` (1-based). Section count is derived as the number
    // of blocks whose kind is "heading"; figureCount/depth are cheap to
    // surface too -- both already present on this same /ingest response,
    // no separate call needed. depth is the document's own numbering
    // depth (max heading_level), NOT the eventual work-item tree depth --
    // that only exists after /level's (expensive, LLM-driven for SURVEY)
    // hierarchy inference, which preview deliberately never calls.
    const doc = await this.ingestionClient.ingest(file.buffer, file.originalname, true);
    const headingLevels = doc.blocks
      .filter((b) => b.kind === 'heading' && typeof b.heading_level === 'number')
      .map((b) => b.heading_level as number);
    const fileType = ext.slice(1).toLowerCase();
    const blockCount = doc.blocks.length;
    const figureCount = doc.figures.length;
    const tableCount = doc.tables.length;
    const cellCount = doc.tables.reduce((n, t) => n + t.cells.reduce((rn, row) => rn + row.length, 0), 0);
    const estimate = await this.etaService.estimate({
      mode: (mode as 'baseline' | 'survey' | undefined) ?? 'baseline',
      blockCount,
      figureCount,
      model,
      tableCount,
      cellCount,
    });
    return {
      blockCount,
      sectionCount: doc.blocks.filter((b) => b.kind === 'heading').length,
      figureCount,
      depth: headingLevels.length > 0 ? Math.max(...headingLevels) : 0,
      fileType,
      estimate,
      tableCount,
      // A bare "TBD"/open placeholder left in the source text -- a real,
      // pre-existing content gap worth flagging before the reviewer commits
      // to a mode, not something SURVEY/BASELINE processing introduces.
      openTbdCount: doc.blocks.filter((b) => b.kind === 'open_tbd').length,
      documentMap: buildDocumentMap(doc.blocks),
    };
  }

  // No file upload here -- consumes the heading/document-map data the
  // wizard's step-1 preview() call already returned, so this never
  // re-parses the document. SURVEY-only from the caller's side (the
  // wizard only calls this once SURVEY is selected); this endpoint itself
  // has no mode check since it does nothing mode-specific.
  @Post('preview/exposition')
  async previewExposition(
    @CurrentUser() user: SessionUser,
    @Body('documentMap') documentMap: DocumentMapSection[] | undefined,
    @Body('sectionCount') sectionCount: number | undefined,
    @Body('depth') depth: number | undefined,
  ): Promise<{ synopsis: string; caveat: string | null } | null> {
    if (!documentMap || !Array.isArray(documentMap) || typeof sectionCount !== 'number' || typeof depth !== 'number') {
      return null;
    }
    return this.documentOverviewService.generate({ documentMap, sectionCount, depth }, user.userId);
  }

  // Re-pricing without re-uploading: the reviewer changing mode/model on
  // step 2 needs a fresh estimate, and re-uploading a (potentially 40MB)
  // file just to change which number is shown would be absurd. Declared
  // BEFORE @Get(':id') below -- Nest matches routes in declaration order,
  // and after :id this would 404 as a job-lookup miss on the literal
  // string "estimate" instead of routing here at all (@Get('models')
  // above is the existing precedent for a literal route sitting above :id).
  @Get('estimate')
  async getEstimate(@Query() rawQuery: unknown): Promise<EtaEstimate> {
    const parseResult = etaEstimateQuerySchema.safeParse(rawQuery);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid query: blockCount, figureCount (non-negative integers), and mode are required');
    }
    return this.etaService.estimate(parseResult.data);
  }

  @Get(':id')
  async getById(
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
  ): Promise<
    Omit<JobDetail, 'userId'> & {
      workItemTypeCatalog: Record<string, WorkItemTypeCatalogEntry>;
      // Category ('Epic'/'Feature'/'Requirement') -> this project's real ADO
      // type name, for DISPLAY LABELS only (AddChildForm's type picker) --
      // see WorkItemTypeCatalogService.resolveCategoryLabels's own doc
      // comment. Defaults to the identity map when there's no diff yet.
      workItemTypeCategoryLabels: Record<'Epic' | 'Feature' | 'Requirement', string>;
      // The SAME field (and its real allowedValues) JobsService.confirm()
      // will actually write a Requirement's classification to -- lets the
      // review UI show which of a Requirement's tags is representable BEFORE
      // commit. null when there's no diff yet, no credential, or resolution
      // fails (best-effort, see WorkItemTypeCatalogService.
      // resolveRequirementClassificationField's own doc comment).
      requirementClassificationField: { referenceName: string; allowedValues: string[] } | null;
    }
  > {
    // userId is internal (ownership only) -- strip it before returning so
    // the response shape stays exactly what it was before ownership
    // scoping existed.
    const { userId: _userId, ...job } = await this.ownedJob(id, user);
    // Resolved and embedded HERE (server-side), not as a separate frontend
    // request the client would otherwise have to make once it had learned
    // the job's area path -- this endpoint already knows the area path
    // (job.areaPath) and can derive the team project from it itself
    // (its own first path segment, same convention every other
    // project-scoped ADO route already uses), so there's no reason to make
    // the browser round-trip a second time just to hand that same value
    // back. Only attempted once there's an actual diff to render types
    // for (dryRunDiff present) -- a still-running job's page never renders
    // DiffTree/WorkItemTypeBadge at all, so resolving this earlier would be
    // a wasted real ADO-backed call. Falls back to {} (no credential, no
    // area path, or the resolve itself failing) -- WorkItemTypeBadge
    // already has its own hardcoded color/icon fallback for exactly this
    // case, so a missing catalog is never a hard failure.
    let workItemTypeCatalog: Record<string, WorkItemTypeCatalogEntry> = {};
    let workItemTypeCategoryLabels: Record<'Epic' | 'Feature' | 'Requirement', string> = {
      Epic: 'Epic',
      Feature: 'Feature',
      Requirement: 'Requirement',
    };
    let requirementClassificationField: { referenceName: string; allowedValues: string[] } | null = null;
    if (job.dryRunDiff != null && job.areaPath) {
      try {
        const credential = await this.adoCredentialResolver.resolve(user.userId);
        if (credential) {
          // job.adoProject, falling back to the areaPath derivation only
          // for a historical row the backfill somehow missed -- this is a
          // best-effort read (caught below), never the write path, so a
          // fallback here is correct where a hard-fail would be wrong.
          const project = job.adoProject ?? job.areaPath.split('\\')[0];
          workItemTypeCatalog = await this.workItemTypeCatalogService.resolve(project, credential);
          workItemTypeCategoryLabels = await this.workItemTypeCatalogService.resolveCategoryLabels(project, credential);
          requirementClassificationField = await this.workItemTypeCatalogService.resolveRequirementClassificationField(project, credential);
        }
      } catch {
        // Best-effort enrichment -- never fail the whole job fetch over it.
      }
    }
    return { ...job, workItemTypeCatalog, workItemTypeCategoryLabels, requirementClassificationField };
  }

  // Re-runs a failed optional enhancement pass for some of the items its
  // warning lists. The client sends one batch at a time and loops, so no
  // request runs minutes of LLM work. `parent_summary` is retryable too: the
  // service builds each node's descendants' text from the job's own tree, so
  // its batches are smaller (every item carries that text).
  @Post(':id/warnings/retry-enhancement')
  async retryEnhancement(
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
    @Body('kind') kind: unknown,
    @Body('pass') pass: unknown,
    @Body('localIds') localIds: unknown,
  ): Promise<unknown> {
    if (kind !== 'enhancement_call_failed' && kind !== 'enhancement_response_incomplete') {
      throw new BadRequestException("kind must be 'enhancement_call_failed' or 'enhancement_response_incomplete'");
    }
    if (pass !== 'title_tag' && pass !== 'synthesis' && pass !== 'parent_summary') {
      throw new BadRequestException("pass must be 'title_tag', 'synthesis' or 'parent_summary'");
    }
    const maxItems = pass === 'parent_summary' ? MAX_RETRY_PARENT_SUMMARY_ITEMS : MAX_RETRY_ENHANCEMENT_ITEMS;
    if (
      !Array.isArray(localIds) ||
      localIds.length === 0 ||
      localIds.length > maxItems ||
      !localIds.every((v) => typeof v === 'string' && v.length > 0)
    ) {
      throw new BadRequestException(`localIds must be a non-empty array of at most ${maxItems} strings`);
    }
    await this.ownedJob(id, user);
    await this.assertModelAllowed(await this.jobsService.modelOf(id));
    return this.jobsService.retryEnhancement(id, { kind, pass, localIds: [...new Set(localIds as string[])] });
  }

  // Declared BEFORE ':id/diff/:localId' on purpose -- 'reviewed' is a static
  // segment that the parametric route below would otherwise swallow as a
  // localId.
  @Patch(':id/diff/reviewed')
  async setDiffEntriesReviewed(
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
    @Body('localIds') localIds: unknown,
    @Body('reviewed') reviewed: unknown,
  ): Promise<{ dryRunDiff: unknown }> {
    if (typeof reviewed !== 'boolean') {
      throw new BadRequestException('reviewed must be a boolean');
    }
    if (!Array.isArray(localIds) || localIds.length === 0 || !localIds.every((v) => typeof v === 'string' && v.length > 0)) {
      throw new BadRequestException('localIds must be a non-empty array of strings');
    }
    await this.ownedJob(id, user);
    const dryRunDiff = await this.jobsService.setDiffEntriesReviewed(id, localIds as string[], reviewed);
    return { dryRunDiff };
  }

  @Patch(':id/warnings/acknowledged')
  async setWarningsAcknowledged(
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
    @Body('kind') kind: unknown,
    @Body('raws') raws: unknown,
    @Body('acknowledged') acknowledged: unknown,
  ): Promise<{ warnings: unknown }> {
    if (typeof acknowledged !== 'boolean') {
      throw new BadRequestException('acknowledged must be a boolean');
    }
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new BadRequestException('kind must be a non-empty string');
    }
    if (raws !== undefined && (!Array.isArray(raws) || raws.length === 0 || !raws.every((v) => typeof v === 'string'))) {
      throw new BadRequestException('raws, when given, must be a non-empty array of strings');
    }
    await this.ownedJob(id, user);
    const warnings = await this.jobsService.setWarningsAcknowledged(id, {
      kind,
      raws: raws as string[] | undefined,
      acknowledged,
    });
    return { warnings };
  }

  @Patch(':id/diff/:localId')
  async editDiffEntry(
    @Param('id') id: string,
    @Param('localId') localId: string,
    @CurrentUser() user: SessionUser,
    @Body('title') title: string | undefined,
    @Body('description') description: string | undefined,
    @Body('customerId') customerId: string | undefined,
    @Body('tags') tags: string[] | undefined,
    @Body('seCoverageRef') seCoverageRef: string | undefined,
  ): Promise<{ dryRunDiff: unknown }> {
    await this.ownedJob(id, user);
    // Same trim-then-null-if-blank convention the wizard's own (now-removed)
    // job-level Customer ID field used -- undefined (field omitted) leaves
    // the entry's customerId untouched; a real service-layer type gate
    // (Requirement-only) is enforced in JobsService.editDiffEntry itself.
    let trimmedCustomerId: string | null | undefined;
    if (customerId !== undefined) {
      const trimmed = customerId.trim();
      if (trimmed.length > MAX_CUSTOMER_ID_LENGTH) {
        throw new BadRequestException(`customerId exceeds the ${MAX_CUSTOMER_ID_LENGTH}-character limit`);
      }
      trimmedCustomerId = trimmed.length > 0 ? trimmed : null;
    }
    // undefined (field omitted) leaves the entry's tags untouched, same
    // convention as customerId above; the Requirement-only type gate is
    // enforced in JobsService.editDiffEntry itself, same as customerId's.
    if (tags !== undefined) {
      if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) {
        throw new BadRequestException('tags must be an array of strings');
      }
      const unknownTags = tags.filter((tag) => !VALID_REQUIREMENT_TAGS.includes(tag));
      if (unknownTags.length > 0) {
        throw new BadRequestException(`Unknown classification tag(s): ${unknownTags.join(', ')}`);
      }
    }
    // Same trim-then-null-if-blank convention as customerId above.
    let trimmedSeCoverageRef: string | null | undefined;
    if (seCoverageRef !== undefined) {
      const trimmed = seCoverageRef.trim();
      if (trimmed.length > MAX_SE_COVERAGE_REF_LENGTH) {
        throw new BadRequestException(`seCoverageRef exceeds the ${MAX_SE_COVERAGE_REF_LENGTH}-character limit`);
      }
      trimmedSeCoverageRef = trimmed.length > 0 ? trimmed : null;
    }
    const dryRunDiff = await this.jobsService.editDiffEntry(id, localId, {
      title,
      description,
      customerId: trimmedCustomerId,
      tags,
      seCoverageRef: trimmedSeCoverageRef,
    });
    return { dryRunDiff };
  }

  @Patch(':id/diff/:localId/exclude')
  async setDiffEntryExcluded(
    @Param('id') id: string,
    @Param('localId') localId: string,
    @CurrentUser() user: SessionUser,
    @Body('excluded') excluded: boolean | undefined,
  ): Promise<{ dryRunDiff: unknown }> {
    if (typeof excluded !== 'boolean') {
      throw new BadRequestException('excluded must be a boolean');
    }
    await this.ownedJob(id, user);
    const dryRunDiff = await this.jobsService.setDiffEntryExcluded(id, localId, excluded);
    return { dryRunDiff };
  }

  @Patch(':id/diff/:localId/move')
  async moveDiffEntry(
    @Param('id') id: string,
    @Param('localId') localId: string,
    @CurrentUser() user: SessionUser,
    @Body('parentLocalId') parentLocalId: string | null | undefined,
    @Body('anchorLocalId') anchorLocalId: string | null | undefined,
    @Body('placement') placement: 'before' | 'after' | undefined,
  ): Promise<{ dryRunDiff: unknown }> {
    if (parentLocalId === undefined) {
      throw new BadRequestException('parentLocalId is required (null for the top level)');
    }
    if (placement !== undefined && placement !== 'before' && placement !== 'after') {
      throw new BadRequestException("placement must be 'before' or 'after'");
    }
    await this.ownedJob(id, user);
    const dryRunDiff = await this.jobsService.moveDiffEntry(id, localId, { parentLocalId, anchorLocalId, placement });
    return { dryRunDiff };
  }

  @Post(':id/diff')
  async addDiffEntry(
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
    // CR: reparent -- null is now a legitimate value (root placement for
    // the top category, or a Feature when no Epic exists), so it must be
    // distinguished from an omitted field the same way moveDiffEntry does.
    @Body('parentLocalId') parentLocalId: string | null | undefined,
    @Body('type') type: string | undefined,
    @Body('title') title: string | undefined,
    @Body('description') description: string | undefined,
  ): Promise<{ dryRunDiff: unknown }> {
    if (parentLocalId === undefined || !type || !title || !description) {
      throw new BadRequestException('parentLocalId (or null for the top level), type, title, and description are all required');
    }
    await this.ownedJob(id, user);
    const dryRunDiff = await this.jobsService.addDiffEntry(id, { parentLocalId, type, title, description });
    return { dryRunDiff };
  }

  @Post(':id/diff/:localId/rescore')
  async rescoreDiffEntry(
    @Param('id') id: string,
    @Param('localId') localId: string,
    @CurrentUser() user: SessionUser,
  ): Promise<{ dryRunDiff: unknown }> {
    await this.ownedJob(id, user);
    const dryRunDiff = await this.jobsService.rescoreDiffEntry(id, localId);
    return { dryRunDiff };
  }

  /**
   * Judges a proposed rewrite (typically a chat proposal) against the entry before it is applied: both texts scored together under
   * the entry's own categories, plus the deterministic warnings. Read-only: nothing in the job changes.
   */
  @Post(':id/diff/:localId/rewrite-check')
  async checkRewrite(
    @Param('id') id: string,
    @Param('localId') localId: string,
    @CurrentUser() user: SessionUser,
    @Body() body: { proposedTitle?: string | null; proposedDescription?: string; warningsOnly?: boolean },
  ): Promise<RewriteComparison> {
    await this.ownedJob(id, user);
    return this.jobsService.checkRewrite(id, localId, {
      proposedTitle: body?.proposedTitle ?? null,
      proposedDescription: typeof body?.proposedDescription === 'string' ? body.proposedDescription : '',
      ...(body?.warningsOnly === true ? { warningsOnly: true } : {}),
    });
  }

  @Post(':id/confirm')
  async confirm(
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
    @Body('selectedLocalIds') selectedLocalIds: string[] | undefined,
  ): Promise<{ status: string; createdCount: number }> {
    await this.ownedJob(id, user);
    const credential = await this.adoCredentialResolver.resolve(user.userId);
    return this.jobsService.confirm(id, credential, selectedLocalIds);
  }

  @Post(':id/reject')
  async reject(@Param('id') id: string, @CurrentUser() user: SessionUser): Promise<{ status: string }> {
    await this.ownedJob(id, user);
    return this.jobsService.reject(id);
  }

  @Post(':id/cancel')
  async cancel(@Param('id') id: string, @CurrentUser() user: SessionUser): Promise<{ status: string }> {
    await this.ownedJob(id, user);
    return this.jobsService.cancel(id);
  }

  @Delete(':id')
  async delete(@Param('id') id: string, @CurrentUser() user: SessionUser): Promise<{ deleted: true }> {
    await this.ownedJob(id, user);
    return this.jobsService.delete(id);
  }

  @Post(':id/resubmit')
  async resubmit(@Param('id') id: string, @CurrentUser() user: SessionUser): Promise<{ jobId: string }> {
    await this.ownedJob(id, user);
    await this.assertModelAllowed(await this.jobsService.modelOf(id));
    return this.jobsService.resubmit(id);
  }

  // Internal service-to-service route: ingestion posts each embedded
  // figure's already-compressed bytes here as soon as it captions it (see
  // _describe_figure_with_progress), before /level has even run -- relevance
  // (figure_ids) isn't known yet at ingest time, so every figure is stored
  // and pruned down later (pipeline.worker.ts, once the real WorkItemTree
  // is known). @Public() + LlmProxyBearerGuard: same bearer-guarded,
  // no-browser-session convention as LlmController's routes, not the
  // session-cookie CurrentUser() flow every other route on this controller
  // uses -- ownedJob() doesn't apply here, there is no session user.
  @Post(':id/figures/:figureId')
  @Public()
  @UseGuards(LlmProxyBearerGuard)
  async uploadFigureFile(
    @Param('id') id: string,
    @Param('figureId') figureId: string,
    @Body() rawBody: unknown,
  ): Promise<{ stored: true }> {
    const job = await this.jobsService.getById(id);
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    const parseResult = jobFigureFileUploadSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: bytes (base64) and mimeType are required');
    }
    const bytes = Buffer.from(parseResult.data.bytes, 'base64');
    if (bytes.length > MAX_FIGURE_FILE_BYTES) {
      throw new PayloadTooLargeException(`figure exceeds the ${Math.round(MAX_FIGURE_FILE_BYTES / 1024 / 1024)}MB per-figure limit`);
    }
    await this.jobsService.storeFigureFile(id, figureId, bytes, parseResult.data.mimeType);
    return { stored: true };
  }

  // Browser-facing counterpart to the internal upload route above -- lets
  // the review UI actually render a figure's image (FigureDescriptions,
  // NodeDetailPanel), not just the vision-model's text caption. Session-
  // cookie/ownedJob guarded like every other per-job GET route on this
  // controller (NOT the LlmProxyBearerGuard the upload route above uses --
  // that convention is for service-to-service calls with no session user
  // at all, which doesn't apply here). Streams the raw bytes directly via
  // the response object rather than returning them from the handler --
  // NestJS's default handling would JSON-serialize a Buffer, not send it as
  // a real image body. 404s (not a JSON `null`) when the figure was never
  // stored or has already been attached to ADO and deleted (see
  // JobsService.attachFigureToAdo/confirm()'s own attach phase) -- both are
  // normal, expected states for an <img> tag to handle, not server errors.
  @Get(':id/figures/:figureId')
  async getFigureFile(
    @Param('id') id: string,
    @Param('figureId') figureId: string,
    @CurrentUser() user: SessionUser,
    @Res() res: Response,
  ): Promise<void> {
    await this.ownedJob(id, user);
    const figureFile = await this.jobsService.getFigureFile(id, figureId);
    if (!figureFile) {
      throw new NotFoundException(`Figure ${figureId} not found for job ${id}`);
    }
    res.set('Content-Type', figureFile.mimeType);
    res.send(figureFile.bytes);
  }

  // Manual retry/backfill for confirm()'s best-effort automatic attach --
  // see JobsService.attachFigureToAdo's own doc comment for the two gaps
  // this closes (an already-'succeeded' job can never re-enter confirm(),
  // and a single silently-swallowed failure there had no retry path).
  // Session-cookie/ownedJob guarded and resolves a real ADO credential the
  // same way confirm()/validateCreatedTree do -- this performs a real ADO
  // write, not a read.
  @Post(':id/diff/:localId/figures/:figureId/attach')
  async attachFigureToAdo(
    @Param('id') id: string,
    @Param('localId') localId: string,
    @Param('figureId') figureId: string,
    @CurrentUser() user: SessionUser,
  ): Promise<{ attached: true; adoId: number }> {
    await this.ownedJob(id, user);
    const credential = await this.adoCredentialResolver.resolve(user.userId);
    return this.jobsService.attachFigureToAdo(id, localId, figureId, credential);
  }

  // Manual retry counterpart to confirm()'s best-effort trace-link write
  // phase -- see JobsService.retryTraceLinkWrite's own doc comment for the
  // two gaps this closes, mirroring attachFigureToAdo above. Session-cookie/
  // ownedJob guarded and resolves a real ADO credential the same way
  // confirm()/attachFigureToAdo do -- this performs a real ADO write, not a
  // read.
  @Post(':id/trace-links/:failureId/retry')
  async retryTraceLinkWrite(
    @Param('id') id: string,
    @Param('failureId') failureId: string,
    @CurrentUser() user: SessionUser,
  ): Promise<{ written: true; sourceAdoId: number; targetAdoId: number }> {
    await this.ownedJob(id, user);
    const credential = await this.adoCredentialResolver.resolve(user.userId);
    return this.jobsService.retryTraceLinkWrite(id, failureId, credential);
  }

  @Get(':id/audit')
  async getAudit(
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
  ): Promise<{ id: string; message: string; createdAt: Date }[]> {
    await this.ownedJob(id, user);
    return this.jobsService.getAuditTrail(id);
  }

  @Get(':id/debug')
  async getDebugCaptures(
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
  ): Promise<{ kind: string; identifier: string; content: string }[]> {
    await this.ownedJob(id, user);
    return this.jobsService.getDebugCaptures(id);
  }

  @Get(':id/dedup-skips')
  async getDedupSkips(
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
  ): Promise<{ id: string; localId: string; similarity: number; existingAdoId: number; createdAt: Date }[]> {
    await this.ownedJob(id, user);
    return this.jobsService.getDedupSkips(id);
  }

  @Get(':id/summary')
  async getSummary(
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
  ): Promise<{ created: number; reused: number; dedupSkipped: number; flagged: number; warnings: (WarningRecord | string)[] }> {
    await this.ownedJob(id, user);
    const summary = await this.jobsService.getSummary(id);
    if (!summary) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    return summary;
  }

  @Get(':id/validate')
  async validateCreatedTree(
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
  ): Promise<{
    valid: boolean;
    checkedCount: number;
    mismatches: { localId: string; adoWorkItemId: number; field: string; expected: string; actual: string }[];
  }> {
    await this.ownedJob(id, user);
    const credential = await this.adoCredentialResolver.resolve(user.userId);
    const result = await this.jobsService.validateCreatedTree(id, credential);
    if (!result) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    return result;
  }
}
