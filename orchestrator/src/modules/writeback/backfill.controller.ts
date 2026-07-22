import { BadRequestException, Body, Controller, Headers, Post } from '@nestjs/common';
import { BackfillService, type BackfillResult } from './backfill.service';

@Controller('backfill')
export class BackfillController {
  constructor(private readonly backfillService: BackfillService) {}

  @Post()
  async backfill(
    @Body('areaPath') areaPath: string | undefined,
    @Headers('x-ado-org-url') orgUrl: string | undefined,
    @Headers('x-ado-pat') pat: string | undefined,
  ): Promise<BackfillResult> {
    if (!areaPath) {
      throw new BadRequestException('areaPath is required');
    }
    const credential = orgUrl && pat ? { orgUrl, pat } : undefined;
    return this.backfillService.backfillAreaPath(areaPath, credential);
  }
}
