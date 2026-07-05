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

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobsService: JobsService,
    @Inject('MAX_UPLOAD_SIZE_BYTES') private readonly maxUploadSizeBytes: number,
  ) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 25 * 1024 * 1024 }, // static upper bound; real configurable limit enforced below via DI
    }),
  )
  async submit(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('areaPath') areaPath: string | undefined,
    @Body('customerId') customerId: string | undefined,
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
    const sourceHash = createHash('sha256').update(file.buffer).digest('hex');
    return this.jobsService.submit({
      // NOTE: userId is hardcoded as a placeholder here because the
      // req2ado session-JWT auth guard (SessionService, built in the
      // auth-corrections round) is not yet wired as an @UseGuards() on
      // this or any non-/auth route — a documented, pre-existing gap from
      // that round, not introduced by this task. Replace with the
      // authenticated request's userId once that guard is applied.
      userId: 'placeholder-user-id',
      areaPath,
      customerId: customerId ?? null,
      fileBuffer: file.buffer,
      filename: file.originalname,
      sourceHash,
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
}
