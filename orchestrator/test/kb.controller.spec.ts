import { HttpException } from '@nestjs/common';
import { KbController } from '../src/modules/kb/kb.controller';
import { IngestionHttpError } from '../src/modules/pipeline/ingestion-http.client';

describe('KbController', () => {
  it('ingestUrl() 400s when url is missing', async () => {
    const controller = new KbController({} as any);
    await expect(controller.ingestUrl(undefined, 'Project\\Area1', undefined)).rejects.toThrow(/url/i);
  });

  it('ingestUrl() 400s when areaPath is missing', async () => {
    const controller = new KbController({} as any);
    await expect(controller.ingestUrl('https://contoso.sharepoint.com/x', undefined, undefined)).rejects.toThrow(/areaPath/i);
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

  it('listDocuments() delegates to the service with the areaPath query param', async () => {
    const documents = [{ id: 'doc-1' }];
    const kbService = { listDocuments: jest.fn().mockResolvedValue(documents) };
    const controller = new KbController(kbService as any);

    const result = await controller.listDocuments('Project\\Area1');

    expect(kbService.listDocuments).toHaveBeenCalledWith('Project\\Area1');
    expect(result).toBe(documents);
  });
});
