import { Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { KbIngestBatchService, type KbIngestBatchView } from './kb-ingest-batch.service';

// Batch ingest of knowledge-base files. Thin on purpose: the session user is the only identity (there is no user id in any
// request), and every rule lives in KbIngestBatchService. Another user's batch answers 404, same as one that does not exist.
@Controller('kb/ingest-batches')
export class KbIngestBatchController {
  constructor(private readonly batches: KbIngestBatchService) {}

  @Post()
  create(@CurrentUser() user: SessionUser, @Body() body: unknown): Promise<KbIngestBatchView> {
    return this.batches.create(user.userId, body);
  }

  // `active=true` is how the page finds a batch it should re-attach to after a reload.
  @Get()
  list(@CurrentUser() user: SessionUser, @Query('active') active?: string, @Query('limit') limit?: string): Promise<KbIngestBatchView[]> {
    const parsed = limit === undefined ? NaN : Number.parseInt(limit, 10);
    return this.batches.list(user.userId, { active: active === 'true', limit: Number.isFinite(parsed) ? parsed : undefined });
  }

  @Get(':id')
  async get(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<KbIngestBatchView> {
    return this.orNotFound(await this.batches.get(user.userId, id), id);
  }

  @Post(':id/cancel')
  async cancel(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<KbIngestBatchView> {
    return this.orNotFound(await this.batches.cancel(user.userId, id), id);
  }

  @Post(':id/retry-failed')
  async retryFailed(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<KbIngestBatchView> {
    return this.orNotFound(await this.batches.retryFailed(user.userId, id), id);
  }

  @Post(':id/resume')
  async resume(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<KbIngestBatchView> {
    return this.orNotFound(await this.batches.resume(user.userId, id), id);
  }

  private orNotFound(view: KbIngestBatchView | null, id: string): KbIngestBatchView {
    if (!view) throw new NotFoundException(`Batch ${id} not found`);
    return view;
  }
}
