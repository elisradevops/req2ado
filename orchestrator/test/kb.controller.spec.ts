import { HttpException } from '@nestjs/common';
import { KbController } from '../src/modules/kb/kb.controller';
import { IngestionHttpError } from '../src/modules/pipeline/ingestion-http.client';

describe('KbController', () => {
  it('ingestUrl() 400s when url is missing', async () => {
    const controller = new KbController({} as any);
    await expect(controller.ingestUrl(undefined, 'Project\\Area1', undefined)).rejects.toThrow(/url/i);
  });

  it('ingestUrl() 400s when userId is missing', async () => {
    const controller = new KbController({} as any);
    await expect(controller.ingestUrl('https://contoso.sharepoint.com/x', undefined, undefined)).rejects.toThrow(/userId/i);
  });

  it('ingestUrl() 400s on a bad host without calling the service', async () => {
    const kbService = { ingestUrl: jest.fn() };
    const controller = new KbController(kbService as any);

    await expect(controller.ingestUrl('https://evil.com/x', 'Project\\Area1', undefined)).rejects.toThrow();
    expect(kbService.ingestUrl).not.toHaveBeenCalled();
  });

  it('ingestUrl() 400s on a lookalike host without calling the service', async () => {
    const kbService = { ingestUrl: jest.fn() };
    const controller = new KbController(kbService as any);

    await expect(controller.ingestUrl('https://fakeonedrive.com/x', 'Project\\Area1', undefined)).rejects.toThrow();
    expect(kbService.ingestUrl).not.toHaveBeenCalled();
  });

  it('ingestUrl() delegates to the service on a valid sharepoint url', async () => {
    const ingestResult = { documentName: 'doc.pdf', driveitemId: 'drive-1', mimeType: null, sizeBytes: 10, chunksStored: 1, skippedUnchanged: false };
    const kbService = { ingestUrl: jest.fn().mockResolvedValue(ingestResult) };
    const controller = new KbController(kbService as any);

    const result = await controller.ingestUrl('https://contoso.sharepoint.com/sites/s/doc.pdf', 'Project\\Area1', 'SRD');

    expect(kbService.ingestUrl).toHaveBeenCalledWith('https://contoso.sharepoint.com/sites/s/doc.pdf', 'Project\\Area1', 'SRD');
    expect(result).toBe(ingestResult);
  });

  it('ingestUrl() accepts a 1drv.ms short link', async () => {
    const ingestResult = { documentName: 'doc.pdf', driveitemId: 'drive-1', mimeType: null, sizeBytes: 10, chunksStored: 1, skippedUnchanged: false };
    const kbService = { ingestUrl: jest.fn().mockResolvedValue(ingestResult) };
    const controller = new KbController(kbService as any);

    const result = await controller.ingestUrl('https://1drv.ms/w/s!AbCdEf', 'Project\\Area1', undefined);

    expect(kbService.ingestUrl).toHaveBeenCalledWith('https://1drv.ms/w/s!AbCdEf', 'Project\\Area1', null);
    expect(result).toBe(ingestResult);
  });

  it('ingestUrl() re-maps an IngestionHttpError from the service to an HttpException with the same status', async () => {
    const kbService = { ingestUrl: jest.fn().mockRejectedValue(new IngestionHttpError(404, 'not found')) };
    const controller = new KbController(kbService as any);

    await expect(controller.ingestUrl('https://contoso.sharepoint.com/x', 'Project\\Area1', undefined)).rejects.toThrow(HttpException);
    try {
      await controller.ingestUrl('https://contoso.sharepoint.com/x', 'Project\\Area1', undefined);
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(404);
    }
  });

  it('ingestFolderUrl() 400s on a bad host without calling the service', async () => {
    const kbService = { ingestFolderUrl: jest.fn() };
    const controller = new KbController(kbService as any);

    await expect(controller.ingestFolderUrl('https://evil.com/folder', 'Project\\Area1', undefined)).rejects.toThrow();
    expect(kbService.ingestFolderUrl).not.toHaveBeenCalled();
  });

  it('ingestFolderUrl() delegates to the service on a valid sharepoint folder url', async () => {
    const folderResult = { files: [{ file: 'a.docx', status: 'ingested', chunksStored: 1, driveitemId: 'drive-a', mimeType: null, sizeBytes: 10, reason: null }] };
    const kbService = { ingestFolderUrl: jest.fn().mockResolvedValue(folderResult) };
    const controller = new KbController(kbService as any);

    const result = await controller.ingestFolderUrl('https://contoso.sharepoint.com/sites/s/folder', 'Project\\Area1', 'SRD', undefined);

    expect(kbService.ingestFolderUrl).toHaveBeenCalledWith('https://contoso.sharepoint.com/sites/s/folder', 'Project\\Area1', 'SRD', false);
    expect(result).toBe(folderResult);
  });

  it('ingestFolderUrl() forwards the recursive flag to the service, defaulting to false', async () => {
    const kbService = { ingestFolderUrl: jest.fn().mockResolvedValue({ files: [] }) };
    const controller = new KbController(kbService as any);

    await controller.ingestFolderUrl('https://contoso.sharepoint.com/folder', 'Project\\Area1', undefined, true);
    expect(kbService.ingestFolderUrl).toHaveBeenCalledWith('https://contoso.sharepoint.com/folder', 'Project\\Area1', null, true);

    await controller.ingestFolderUrl('https://contoso.sharepoint.com/folder', 'Project\\Area1', undefined, undefined);
    expect(kbService.ingestFolderUrl).toHaveBeenCalledWith('https://contoso.sharepoint.com/folder', 'Project\\Area1', null, false);
  });

  it('ingestFolderUrl() re-maps an IngestionHttpError from the service to an HttpException with the same status', async () => {
    const kbService = { ingestFolderUrl: jest.fn().mockRejectedValue(new IngestionHttpError(403, 'forbidden')) };
    const controller = new KbController(kbService as any);

    try {
      await controller.ingestFolderUrl('https://contoso.sharepoint.com/folder', 'Project\\Area1', undefined);
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(403);
    }
  });

  it('listDocuments() delegates to the service with the areaPath query param', async () => {
    const documents = [{ id: 'doc-1' }];
    const kbService = { listDocuments: jest.fn().mockResolvedValue(documents) };
    const controller = new KbController(kbService as any);

    const result = await controller.listDocuments('Project\\Area1');

    expect(kbService.listDocuments).toHaveBeenCalledWith('Project\\Area1');
    expect(result).toBe(documents);
  });
});
