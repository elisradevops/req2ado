import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { BackfillService, type BackfillResult } from './backfill.service';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { AdoCredentialResolver } from '../auth/ado-credential.resolver';

@Controller('backfill')
export class BackfillController {
  constructor(
    private readonly backfillService: BackfillService,
    private readonly adoCredentialResolver: AdoCredentialResolver,
  ) {}

  @Post()
  async backfill(@Body('areaPath') areaPath: string | undefined, @CurrentUser() user: SessionUser): Promise<BackfillResult> {
    if (!areaPath) {
      throw new BadRequestException('areaPath is required');
    }
    const credential = await this.adoCredentialResolver.resolve(user.userId);
    return this.backfillService.backfillAreaPath(areaPath, credential);
  }
}
