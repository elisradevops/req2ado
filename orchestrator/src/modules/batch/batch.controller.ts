import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { BatchService, type BatchDetail, type BatchListEntry, type SubmitBatchResult } from './batch.service';

// Same generous decorator-time ceiling as JobsController.submit's own
// MULTER_SAFETY_CEILING_BYTES -- the real, configurable per-file size
// enforcement happens in BatchService.submitBatch (MAX_UPLOAD_SIZE_MB),
// which DOES see the DI-resolved value; this only guards against Multer
// itself rejecting a legitimately-sized batch before that check ever runs.
const MULTER_SAFETY_CEILING_BYTES = 500 * 1024 * 1024;

// Separate controller from JobsController, not more routes bolted onto it
// -- that controller's own comments document a real declaration-order
// hazard around its `@Get(':id')` catch-all, and a batch-scoped 'jobs'
// route would risk the same trap for no benefit.
@Controller('batches')
export class BatchController {
  constructor(
    private readonly batchService: BatchService,
    @Inject('MAX_BATCH_FILES') private readonly maxBatchFiles: number,
  ) {}

  @Get()
  async list(@CurrentUser() user: SessionUser): Promise<BatchListEntry[]> {
    return this.batchService.listBatches(user.userId);
  }

  // Same 404-not-403 ownership convention as JobsController.ownedJob -- a
  // batch id must not be enumerable by trying it and reading the status
  // code.
  private async ownedBatch(batchId: string, user: SessionUser): Promise<BatchDetail> {
    const batch = await this.batchService.getBatch(batchId);
    if (!batch || batch.userId !== user.userId) {
      throw new NotFoundException(`Batch ${batchId} not found`);
    }
    return batch;
  }

  @Get(':batchId')
  async getBatch(@Param('batchId') batchId: string, @CurrentUser() user: SessionUser): Promise<Omit<BatchDetail, 'userId'>> {
    // Strip userId before returning -- same convention as
    // JobsController.getById's own `userId: _userId` destructure.
    const { userId: _userId, ...rest } = await this.ownedBatch(batchId, user);
    return rest;
  }

  @Post()
  @UseInterceptors(FilesInterceptor('files', 100, { limits: { fileSize: MULTER_SAFETY_CEILING_BYTES } }))
  async submit(
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @CurrentUser() user: SessionUser,
    @Body('areaPath') areaPath: string | undefined,
    @Body('adoProject') adoProject: string | undefined,
    @Body('mode') mode: string | undefined,
    @Body('state') state: string | undefined,
    @Body('iterationPath') iterationPath: string | undefined,
    @Body('model') model: string | undefined,
  ): Promise<SubmitBatchResult> {
    if (!files || files.length === 0) {
      throw new BadRequestException('at least one file is required');
    }
    if (files.length > this.maxBatchFiles) {
      throw new BadRequestException(`batch exceeds the ${this.maxBatchFiles}-file limit`);
    }
    if (!areaPath) {
      throw new BadRequestException('areaPath is required');
    }
    // Same consistency check as JobsController.submit -- see its own
    // comment for why a mismatch is rejected rather than silently resolved.
    if (adoProject && adoProject !== areaPath.split('\\')[0]) {
      throw new BadRequestException(
        `adoProject ('${adoProject}') does not match areaPath's project segment ('${areaPath.split('\\')[0]}')`,
      );
    }
    if (mode !== undefined && mode !== 'baseline' && mode !== 'survey') {
      throw new BadRequestException(`mode must be 'baseline' or 'survey', got: ${mode}`);
    }
    // Per-file extension/size validation happens in BatchService.submitBatch
    // (a bad file there becomes status:'invalid', not a whole-request 400) --
    // this route only rejects conditions that make the WHOLE request
    // malformed.
    return this.batchService.submitBatch({
      userId: user.userId,
      areaPath,
      adoProject: adoProject ?? null,
      mode: (mode as 'baseline' | 'survey' | undefined) ?? 'baseline',
      state,
      iterationPath: iterationPath ?? null,
      model,
      files: files.map((file) => ({ buffer: file.buffer, filename: file.originalname })),
    });
  }

  @Post(':batchId/cancel-queued')
  async cancelQueued(@Param('batchId') batchId: string, @CurrentUser() user: SessionUser): Promise<{ cancelled: number }> {
    await this.ownedBatch(batchId, user); // 404s if not found/not owned before mutating anything
    return this.batchService.cancelQueued(batchId);
  }
}
