import { BadRequestException, Controller, Get, Headers, NotFoundException, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Body } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { createHash } from 'crypto';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  async submit(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('areaPath') areaPath: string | undefined,
    @Body('customerId') customerId: string | undefined,
  ): Promise<{ jobId: string }> {
    if (!file) {
      throw new BadRequestException('file is required');
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
