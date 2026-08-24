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
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Body } from '@nestjs/common';
import type { Response } from 'express';
import { JobsService, JobSummary } from './jobs.service';
import { IngestionHttpClient } from './ingestion-http.client';
import { WorkItemTypeCatalogService, type WorkItemTypeCatalogEntry } from './work-item-type-catalog.service';
import { jobFigureFileUploadSchema } from './job-figure-file.dto';
import { etaEstimateQuerySchema } from './eta-estimate.dto';
import { EtaService, type EtaEstimate } from './eta.service';
import { buildDocumentMap, type DocumentMapSection } from './document-map';
import { createHash } from 'crypto';
import { OpenWebUiClient } from '../llm/openwebui.client';
import { LlmProxyBearerGuard } from '../llm/llm-proxy-bearer.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { AdoCredentialResolver } from '../auth/ado-credential.resolver';
import type { WarningRecord } from '../writeback/dry-run.service';
import { Public } from '../auth/public.decorator';

// Matches ingestion/app/loaders/*.py's actually-implemented loaders — txt,
// md, docx, pdf (incl. scanned/OCR, same extension), xlsx. Not a security
// boundary against malicious file CONTENT (that's ingestion's own parsing
// robustness), only a cheap reject-obviously-wrong-format-early gate.
const ALLOWED_EXTENSIONS = new Set(['.txt', '.md', '.docx', '.pdf', '.xlsx']);

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
    private readonly llmClient: OpenWebUiClient,
    private readonly adoCredentialResolver: AdoCredentialResolver,
    private readonly workItemTypeCatalogService: WorkItemTypeCatalogService,
    private readonly etaService: EtaService,
    @Inject('MAX_UPLOAD_SIZE_BYTES') private readonly maxUploadSizeBytes: number,
  ) {}

  @Get()
  async list(@CurrentUser() user: SessionUser): Promise<JobSummary[]> {
    return this.jobsService.list(user.userId);
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
  @Get('models')
  async listModels(): Promise<{ models: string[] }> {
    const models = await this.llmClient.listModels();
    return { models };
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
    @Body('customerId') customerId: string | undefined,
    @Body('mode') mode: string | undefined,
    @Body('state') state: string | undefined,
    @Body('iterationPath') iterationPath: string | undefined,
    @Body('model') model: string | undefined,
    @Body('followUp') followUp: string | boolean | undefined,
  ): Promise<{ jobId: string }> {
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
    if (mode !== undefined && mode !== 'baseline' && mode !== 'survey') {
      throw new BadRequestException(`mode must be 'baseline' or 'survey', got: ${mode}`);
    }
    const sourceHash = createHash('sha256').update(file.buffer).digest('hex');
    return this.jobsService.submit({
      areaPath,
      // The submitting user's stable ADO identity (see Job.userId's own doc
      // comment) -- the Knowledge Base scope key, kept separate from
      // areaPath (ADO write-back destination only). Now the session's own
      // identity (AuthGuard), never client-supplied -- a caller could
      // previously submit a job under any userId string it liked.
      userId: user.userId,
      customerId: customerId ?? null,
      mode: (mode as 'baseline' | 'survey' | undefined) ?? 'baseline',
      fileBuffer: file.buffer,
      filename: file.originalname,
      sourceHash,
      state,
      iterationPath: iterationPath ?? null,
      model,
      // Multipart form bodies send booleans as the strings "true"/"false"
      // (or omit the field entirely) -- coerce explicitly rather than
      // relying on JS truthiness, since the string "false" is truthy.
      followUp: followUp === true || followUp === 'true',
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
    const estimate = await this.etaService.estimate({
      mode: (mode as 'baseline' | 'survey' | undefined) ?? 'baseline',
      blockCount,
      figureCount,
      model,
    });
    return {
      blockCount,
      sectionCount: doc.blocks.filter((b) => b.kind === 'heading').length,
      figureCount,
      depth: headingLevels.length > 0 ? Math.max(...headingLevels) : 0,
      fileType,
      estimate,
      tableCount: doc.tables.length,
      // A bare "TBD"/open placeholder left in the source text -- a real,
      // pre-existing content gap worth flagging before the reviewer commits
      // to a mode, not something SURVEY/BASELINE processing introduces.
      openTbdCount: doc.blocks.filter((b) => b.kind === 'open_tbd').length,
      documentMap: buildDocumentMap(doc.blocks),
    };
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
  ): Promise<{
    id: string;
    status: string;
    mode: string;
    dryRunDiff: unknown;
    warnings: (WarningRecord | string)[];
    kbCitations: unknown;
    figureDescriptions: { figureIndex: number; figureId: string; name: string | null; caption: string | null }[];
    tableDescriptions: { tableId: string; caption: string }[];
    excludedFigureIds: string[];
    excludedTableIds: string[];
    createdAt: Date;
    areaPath: string;
    iterationPath: string | null;
    state: string;
    originalFilename: string;
    workItemTypeCatalog: Record<string, WorkItemTypeCatalogEntry>;
    // Category ('Epic'/'Feature'/'Requirement') -> this project's real ADO
    // type name, for DISPLAY LABELS only (AddChildForm's type picker) --
    // see WorkItemTypeCatalogService.resolveCategoryLabels's own doc
    // comment. Defaults to the identity map when there's no diff yet.
    workItemTypeCategoryLabels: Record<'Epic' | 'Feature' | 'Requirement', string>;
    // Task 4: see JobsService.getById's own doc comment.
    traceLinkFailures: { id: string; sourceLocalId: string; sourceAdoId: number; targetAdoId: number; referenceName: string }[];
  }> {
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
    if (job.dryRunDiff != null && job.areaPath) {
      try {
        const credential = await this.adoCredentialResolver.resolve(user.userId);
        if (credential) {
          const project = job.areaPath.split('\\')[0];
          workItemTypeCatalog = await this.workItemTypeCatalogService.resolve(project, credential);
          workItemTypeCategoryLabels = await this.workItemTypeCatalogService.resolveCategoryLabels(project, credential);
        }
      } catch {
        // Best-effort enrichment -- never fail the whole job fetch over it.
      }
    }
    return { ...job, workItemTypeCatalog, workItemTypeCategoryLabels };
  }

  @Patch(':id/diff/:localId')
  async editDiffEntry(
    @Param('id') id: string,
    @Param('localId') localId: string,
    @CurrentUser() user: SessionUser,
    @Body('title') title: string | undefined,
    @Body('description') description: string | undefined,
  ): Promise<{ dryRunDiff: unknown }> {
    await this.ownedJob(id, user);
    const dryRunDiff = await this.jobsService.editDiffEntry(id, localId, { title, description });
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
