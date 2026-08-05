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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Body } from '@nestjs/common';
import { JobsService, JobSummary } from './jobs.service';
import { IngestionHttpClient } from './ingestion-http.client';
import { WorkItemTypeCatalogService, type WorkItemTypeCatalogEntry } from './work-item-type-catalog.service';
import { createHash } from 'crypto';
import { OpenWebUiClient } from '../llm/openwebui.client';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { AdoCredentialResolver } from '../auth/ado-credential.resolver';

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

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobsService: JobsService,
    private readonly ingestionClient: IngestionHttpClient,
    private readonly llmClient: OpenWebUiClient,
    private readonly adoCredentialResolver: AdoCredentialResolver,
    private readonly workItemTypeCatalogService: WorkItemTypeCatalogService,
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
  ): Promise<{ blockCount: number; sectionCount: number; figureCount: number; depth: number; fileType: string }> {
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
    const doc = (await this.ingestionClient.ingest(file.buffer, file.originalname, true)) as {
      blocks?: { kind?: string; heading_level?: number | null }[];
      figures?: unknown[];
    };
    const blocks = doc.blocks ?? [];
    const headingLevels = blocks
      .filter((b) => b.kind === 'heading' && typeof b.heading_level === 'number')
      .map((b) => b.heading_level as number);
    const fileType = ext.slice(1).toLowerCase();
    return {
      blockCount: blocks.length,
      sectionCount: blocks.filter((b) => b.kind === 'heading').length,
      figureCount: doc.figures?.length ?? 0,
      depth: headingLevels.length > 0 ? Math.max(...headingLevels) : 0,
      fileType,
    };
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
    warnings: string[];
    kbCitations: unknown;
    figureDescriptions: { figureIndex: number; caption: string }[];
    createdAt: Date;
    areaPath: string;
    originalFilename: string;
    workItemTypeCatalog: Record<string, WorkItemTypeCatalogEntry>;
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
    if (job.dryRunDiff != null && job.areaPath) {
      try {
        const credential = await this.adoCredentialResolver.resolve(user.userId);
        if (credential) {
          const project = job.areaPath.split('\\')[0];
          workItemTypeCatalog = await this.workItemTypeCatalogService.resolve(project, credential);
        }
      } catch {
        // Best-effort enrichment -- never fail the whole job fetch over it.
      }
    }
    return { ...job, workItemTypeCatalog };
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

  @Post(':id/diff')
  async addDiffEntry(
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
    @Body('parentLocalId') parentLocalId: string | undefined,
    @Body('type') type: string | undefined,
    @Body('title') title: string | undefined,
    @Body('description') description: string | undefined,
  ): Promise<{ dryRunDiff: unknown }> {
    if (!parentLocalId || !type || !title || !description) {
      throw new BadRequestException('parentLocalId, type, title, and description are all required');
    }
    await this.ownedJob(id, user);
    const dryRunDiff = await this.jobsService.addDiffEntry(id, { parentLocalId, type, title, description });
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
  ): Promise<{ created: number; reused: number; dedupSkipped: number; flagged: number; warnings: string[] }> {
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
