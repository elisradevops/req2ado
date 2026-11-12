import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { SessionUser } from '../src/modules/auth/session.service';
import { SettingsController } from '../src/modules/settings/settings.controller';

const USER: SessionUser = { userId: 'user-1', displayName: 'Jane Doe' };
const canEdit = (allowed = true) => jest.fn().mockReturnValue(allowed);

describe('SettingsController', () => {
  it('GET / returns the current settings', async () => {
    const settingsService = { get: jest.fn().mockResolvedValue({ dedupThreshold: 0.9 }), canEdit: canEdit() };
    const controller = new SettingsController(settingsService as any);

    await expect(controller.get(USER)).resolves.toEqual({ dedupThreshold: 0.9, canEditDedupThreshold: true });
  });

  it('PUT / updates dedupThreshold when given a valid body', async () => {
    const settingsService = { update: jest.fn().mockResolvedValue({ dedupThreshold: 0.85 }), canEdit: canEdit() };
    const controller = new SettingsController(settingsService as any);

    await expect(controller.update({ dedupThreshold: 0.85 }, USER)).resolves.toEqual({ dedupThreshold: 0.85 });
    expect(settingsService.update).toHaveBeenCalledWith(0.85);
  });

  it('PUT / rejects a dedupThreshold above 1', async () => {
    const settingsService = { update: jest.fn(), canEdit: canEdit() };
    const controller = new SettingsController(settingsService as any);

    await expect(controller.update({ dedupThreshold: 1.5 }, USER)).rejects.toThrow(BadRequestException);
    expect(settingsService.update).not.toHaveBeenCalled();
  });

  it('PUT / rejects a dedupThreshold below 0', async () => {
    const settingsService = { update: jest.fn(), canEdit: canEdit() };
    const controller = new SettingsController(settingsService as any);

    await expect(controller.update({ dedupThreshold: -0.1 }, USER)).rejects.toThrow(BadRequestException);
    expect(settingsService.update).not.toHaveBeenCalled();
  });

  it('PUT / rejects a missing/non-numeric dedupThreshold', async () => {
    const settingsService = { update: jest.fn(), canEdit: canEdit() };
    const controller = new SettingsController(settingsService as any);

    await expect(controller.update({}, USER)).rejects.toThrow(BadRequestException);
    await expect(controller.update({ dedupThreshold: 'high' }, USER)).rejects.toThrow(BadRequestException);
    expect(settingsService.update).not.toHaveBeenCalled();
  });

  describe('who may change the threshold', () => {
    it('GET / tells a user who may not edit, so the page can show it read-only', async () => {
      const settingsService = { get: jest.fn().mockResolvedValue({ dedupThreshold: 0.9 }), canEdit: canEdit(false) };
      const controller = new SettingsController(settingsService as any);

      await expect(controller.get(USER)).resolves.toEqual({ dedupThreshold: 0.9, canEditDedupThreshold: false });
      expect(settingsService.canEdit).toHaveBeenCalledWith('user-1');
    });

    it('PUT / is refused for a user who may not edit, and nothing is saved', async () => {
      const settingsService = { update: jest.fn(), canEdit: canEdit(false) };
      const controller = new SettingsController(settingsService as any);

      await expect(controller.update({ dedupThreshold: 0.8 }, USER)).rejects.toThrow(ForbiddenException);
      expect(settingsService.update).not.toHaveBeenCalled();
    });

    it('PUT / says why, in a code the page can read', async () => {
      const settingsService = { update: jest.fn(), canEdit: canEdit(false) };
      const controller = new SettingsController(settingsService as any);

      await expect(controller.update({ dedupThreshold: 0.8 }, USER)).rejects.toMatchObject({ response: { code: 'settings_forbidden' } });
    });
  });
});
