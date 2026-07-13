import { BadRequestException, NotFoundException } from '@nestjs/common';
import { KbController } from '../src/modules/kb/kb.controller';

describe('KbController', () => {
  it('create() throws BadRequestException when any required field is missing', async () => {
    const controller = new KbController({} as any);
    await expect(controller.create(undefined, 'https://s', 'Lib', 'Folder', 'Docs')).rejects.toThrow(BadRequestException);
  });

  it('create() delegates to KbService.create when all fields are present', async () => {
    const created = { id: 'kb-1' };
    const kbService = { create: jest.fn().mockResolvedValue(created) };
    const controller = new KbController(kbService as any);

    const result = await controller.create('Project\\Area1', 'https://s', 'Lib', 'Folder', 'Docs');

    expect(kbService.create).toHaveBeenCalledWith({ areaPath: 'Project\\Area1', siteUrl: 'https://s', library: 'Lib', folder: 'Folder', displayName: 'Docs' });
    expect(result).toBe(created);
  });

  it('sync() throws BadRequestException when bearerToken is missing', async () => {
    const controller = new KbController({} as any);
    await expect(controller.sync('kb-1', undefined)).rejects.toThrow(BadRequestException);
  });

  it('sync() throws NotFoundException when KbService.sync returns null', async () => {
    const kbService = { sync: jest.fn().mockResolvedValue(null) };
    const controller = new KbController(kbService as any);
    await expect(controller.sync('missing-id', 'tok-1')).rejects.toThrow(NotFoundException);
  });

  it('sync() returns the result when KbService.sync succeeds', async () => {
    const syncResult = { filesProcessed: 1, filesSkipped: 0, filesFailed: [], chunksStored: 2 };
    const kbService = { sync: jest.fn().mockResolvedValue(syncResult) };
    const controller = new KbController(kbService as any);

    const result = await controller.sync('kb-1', 'tok-1');

    expect(kbService.sync).toHaveBeenCalledWith('kb-1', 'tok-1');
    expect(result).toBe(syncResult);
  });
});
