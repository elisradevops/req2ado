import { BadRequestException, Body, Controller, Get, Put } from '@nestjs/common';
import { SettingsService, type AppSettingsView } from './settings.service';
import { updateAppSettingsSchema } from './settings.dto';

// No @Public() -- every logged-in user can view/edit (matches this app's
// existing no-app-RBAC posture, ADO session identity is the only gate),
// but an anonymous caller still isn't allowed, same default as every other
// controller in this app.
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  async get(): Promise<AppSettingsView> {
    return this.settingsService.get();
  }

  @Put()
  async update(@Body() rawBody: unknown): Promise<AppSettingsView> {
    const parseResult = updateAppSettingsSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: dedupThreshold must be a number between 0 and 1');
    }
    return this.settingsService.update(parseResult.data.dedupThreshold);
  }
}
