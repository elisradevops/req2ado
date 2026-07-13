import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { KbService, KbSourceSummary, KbSyncResult } from './kb.service';

@Controller('kb/sources')
export class KbController {
  constructor(private readonly kbService: KbService) {}

  @Get()
  async list(): Promise<KbSourceSummary[]> {
    return this.kbService.list();
  }

  @Post()
  async create(
    @Body('areaPath') areaPath: string | undefined,
    @Body('siteUrl') siteUrl: string | undefined,
    @Body('library') library: string | undefined,
    @Body('folder') folder: string | undefined,
    @Body('displayName') displayName: string | undefined,
  ): Promise<KbSourceSummary> {
    if (!areaPath || !siteUrl || !library || !folder || !displayName) {
      throw new BadRequestException('areaPath, siteUrl, library, folder, and displayName are all required');
    }
    return this.kbService.create({ areaPath, siteUrl, library, folder, displayName });
  }

  @Post(':id/sync')
  async sync(@Param('id') id: string, @Body('bearerToken') bearerToken: string | undefined): Promise<KbSyncResult> {
    if (!bearerToken) {
      throw new BadRequestException('bearerToken is required');
    }
    const result = await this.kbService.sync(id, bearerToken);
    if (!result) {
      throw new NotFoundException(`KbSource ${id} not found`);
    }
    return result;
  }
}
