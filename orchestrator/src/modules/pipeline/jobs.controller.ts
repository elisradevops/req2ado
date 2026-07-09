import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Body } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { createHash } from 'crypto';

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
    @Inject('MAX_UPLOAD_SIZE_BYTES') private readonly maxUploadSizeBytes: number,
  ) {}

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
      state: state ?? 'Proposed',
      iterationPath: iterationPath ?? null,
    });
  }

  @Get(':id')
  async getById(@Param('id') id: string): Promise<{ id: string; status: string; dryRunDiff: unknown }> {
    const job = await this.jobsService.getById(id);
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    return job;
  }

  @Post(':id/confirm')
  async confirm(
    @Param('id') id: string,
    @Headers('x-ado-org-url') orgUrl: string | undefined,
    @Headers('x-ado-pat') pat: string | undefined,
  ): Promise<{ status: string; createdCount: number }> {
    const credential = orgUrl && pat ? { orgUrl, pat } : undefined;
    return this.jobsService.confirm(id, credential);
  }

  @Get(':id/audit')
  async getAudit(@Param('id') id: string): Promise<{ id: string; message: string; createdAt: Date }[]> {
    return this.jobsService.getAuditTrail(id);
  }
}
