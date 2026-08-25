import { BadRequestException } from '@nestjs/common';
import { SettingsController } from '../src/modules/settings/settings.controller';

describe('SettingsController', () => {
  it('GET / returns the current settings', async () => {
    const settingsService = { get: jest.fn().mockResolvedValue({ dedupThreshold: 0.9 }) };
    const controller = new SettingsController(settingsService as any);

    await expect(controller.get()).resolves.toEqual({ dedupThreshold: 0.9 });
  });

  it('PUT / updates dedupThreshold when given a valid body', async () => {
    const settingsService = { update: jest.fn().mockResolvedValue({ dedupThreshold: 0.85 }) };
    const controller = new SettingsController(settingsService as any);

    await expect(controller.update({ dedupThreshold: 0.85 })).resolves.toEqual({ dedupThreshold: 0.85 });
    expect(settingsService.update).toHaveBeenCalledWith(0.85);
  });

  it('PUT / rejects a dedupThreshold above 1', async () => {
    const settingsService = { update: jest.fn() };
    const controller = new SettingsController(settingsService as any);

    await expect(controller.update({ dedupThreshold: 1.5 })).rejects.toThrow(BadRequestException);
    expect(settingsService.update).not.toHaveBeenCalled();
  });

  it('PUT / rejects a dedupThreshold below 0', async () => {
    const settingsService = { update: jest.fn() };
    const controller = new SettingsController(settingsService as any);

    await expect(controller.update({ dedupThreshold: -0.1 })).rejects.toThrow(BadRequestException);
    expect(settingsService.update).not.toHaveBeenCalled();
  });

  it('PUT / rejects a missing/non-numeric dedupThreshold', async () => {
    const settingsService = { update: jest.fn() };
    const controller = new SettingsController(settingsService as any);

    await expect(controller.update({})).rejects.toThrow(BadRequestException);
    await expect(controller.update({ dedupThreshold: 'high' })).rejects.toThrow(BadRequestException);
    expect(settingsService.update).not.toHaveBeenCalled();
  });
});
