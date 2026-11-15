import { BadRequestException, Body, Controller, ForbiddenException, Get, Put } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { SettingsService, type AppSettingsView } from './settings.service';
import { updateAppSettingsSchema } from './settings.dto';

// No @Public() -- every logged-in user can view settings; an anonymous caller
// isn't allowed, same default as every other controller in this app. Changing
// the threshold is open to everyone unless REQ2ADO_ADMIN_USER_IDS lists who may
// (the app has no roles, see SettingsService.canEdit); GET says which it is.
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  async get(@CurrentUser() user: SessionUser): Promise<AppSettingsView & { canEditDedupThreshold: boolean }> {
    return { ...(await this.settingsService.get()), canEditDedupThreshold: this.settingsService.canEdit(user.userId) };
  }

  @Put()
  async update(@Body() rawBody: unknown, @CurrentUser() user: SessionUser): Promise<AppSettingsView> {
    if (!this.settingsService.canEdit(user.userId)) {
      throw new ForbiddenException({ code: 'settings_forbidden', message: 'Only an administrator can change the duplicate threshold.' });
    }
    const parseResult = updateAppSettingsSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: dedupThreshold must be a number between 0 and 1');
    }
    return this.settingsService.update(parseResult.data.dedupThreshold);
  }
}
