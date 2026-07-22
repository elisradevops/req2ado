import {
  BadRequestException,
  Controller,
  Get,
  Headers,
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
import { readAdoCredential } from './credential.util';
import { createHash } from 'crypto';
import { OpenWebUiClient } from '../llm/openwebui.client';

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
    @Inject('MAX_UPLOAD_SIZE_BYTES') private readonly maxUploadSizeBytes: number,
  ) {}

  @Get()
  async list(): Promise<JobSummary[]> {
    return this.jobsService.list();
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
    @Body('areaPath') areaPath: string | undefined,
    @Body('customerId') customerId: string | undefined,
    @Body('mode') mode: string | undefined,
    @Body('state') state: string | undefined,
    @Body('iterationPath') iterationPath: string | undefined,
    @Body('model') model: string | undefined,
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
      customerId: customerId ?? null,
      mode: (mode as 'baseline' | 'survey' | undefined) ?? 'baseline',
      fileBuffer: file.buffer,
      filename: file.originalname,
      sourceHash,
      state,
      iterationPath: iterationPath ?? null,
      model,
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
  ): Promise<{ blockCount: number; sectionCount: number; fileType: string }> {
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
    // Each Block carries a `kind` (BlockKind str-enum). Section count is
    // derived as the number of blocks whose kind is "heading".
    const doc = (await this.ingestionClient.ingest(file.buffer, file.originalname)) as {
      blocks?: { kind?: string }[];
    };
    const blocks = doc.blocks ?? [];
    const fileType = ext.slice(1).toLowerCase();
    return {
      blockCount: blocks.length,
      sectionCount: blocks.filter((b) => b.kind === 'heading').length,
      fileType,
    };
  }

  @Get(':id')
  async getById(
    @Param('id') id: string,
  ): Promise<{
    id: string;
    status: string;
    mode: string;
    dryRunDiff: unknown;
    warnings: string[];
    kbCitations: unknown;
    createdAt: Date;
  }> {
    const job = await this.jobsService.getById(id);
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    return job;
  }

  @Patch(':id/diff/:localId')
  async editDiffEntry(
    @Param('id') id: string,
    @Param('localId') localId: string,
    @Body('title') title: string | undefined,
    @Body('description') description: string | undefined,
  ): Promise<{ dryRunDiff: unknown }> {
    const dryRunDiff = await this.jobsService.editDiffEntry(id, localId, { title, description });
    return { dryRunDiff };
  }

  @Patch(':id/diff/:localId/exclude')
  async setDiffEntryExcluded(
    @Param('id') id: string,
    @Param('localId') localId: string,
    @Body('excluded') excluded: boolean | undefined,
  ): Promise<{ dryRunDiff: unknown }> {
    if (typeof excluded !== 'boolean') {
      throw new BadRequestException('excluded must be a boolean');
    }
    const dryRunDiff = await this.jobsService.setDiffEntryExcluded(id, localId, excluded);
    return { dryRunDiff };
  }

  @Post(':id/diff')
  async addDiffEntry(
    @Param('id') id: string,
    @Body('parentLocalId') parentLocalId: string | undefined,
    @Body('type') type: string | undefined,
    @Body('title') title: string | undefined,
    @Body('description') description: string | undefined,
  ): Promise<{ dryRunDiff: unknown }> {
    if (!parentLocalId || !type || !title || !description) {
      throw new BadRequestException('parentLocalId, type, title, and description are all required');
    }
    const dryRunDiff = await this.jobsService.addDiffEntry(id, { parentLocalId, type, title, description });
    return { dryRunDiff };
  }

  @Post(':id/confirm')
  async confirm(
    @Param('id') id: string,
    @Headers('x-ado-org-url') orgUrl: string | undefined,
    @Headers('x-ado-pat') pat: string | undefined,
    @Body('selectedLocalIds') selectedLocalIds: string[] | undefined,
  ): Promise<{ status: string; createdCount: number }> {
    const credential = readAdoCredential(orgUrl, pat);
    return this.jobsService.confirm(id, credential, selectedLocalIds);
  }

  @Post(':id/reject')
  async reject(@Param('id') id: string): Promise<{ status: string }> {
    return this.jobsService.reject(id);
  }

  @Get(':id/audit')
  async getAudit(@Param('id') id: string): Promise<{ id: string; message: string; createdAt: Date }[]> {
    return this.jobsService.getAuditTrail(id);
  }

  @Get(':id/dedup-skips')
  async getDedupSkips(
    @Param('id') id: string,
  ): Promise<{ id: string; localId: string; similarity: number; existingAdoId: number; createdAt: Date }[]> {
    return this.jobsService.getDedupSkips(id);
  }

  @Get(':id/summary')
  async getSummary(
    @Param('id') id: string,
  ): Promise<{ created: number; reused: number; dedupSkipped: number; flagged: number; warnings: string[] }> {
    const summary = await this.jobsService.getSummary(id);
    if (!summary) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    return summary;
  }

  @Get(':id/validate')
  async validateCreatedTree(
    @Param('id') id: string,
    @Headers('x-ado-org-url') orgUrl: string | undefined,
    @Headers('x-ado-pat') pat: string | undefined,
  ): Promise<{
    valid: boolean;
    checkedCount: number;
    mismatches: { localId: string; adoWorkItemId: number; field: string; expected: string; actual: string }[];
  }> {
    const credential = readAdoCredential(orgUrl, pat);
    const result = await this.jobsService.validateCreatedTree(id, credential);
    if (!result) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    return result;
  }
}
