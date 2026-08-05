import { HttpException } from '@nestjs/common';
import { KbController } from '../src/modules/kb/kb.controller';
import { IngestionHttpError } from '../src/modules/pipeline/ingestion-http.client';
import type { SessionUser } from '../src/modules/auth/session.service';

const TEST_USER: SessionUser = { userId: 'Project\\Area1', displayName: 'Test User' };

describe('KbController', () => {
  it('ingestUrl() 400s when url is missing', async () => {
    const controller = new KbController({} as any);
    await expect(controller.ingestUrl(TEST_USER, undefined, undefined)).rejects.toThrow(/url/i);
  });

  it('ingestUrl() 400s on a bad host without calling the service', async () => {
    const kbService = { ingestUrl: jest.fn() };
    const controller = new KbController(kbService as any);

    await expect(controller.ingestUrl(TEST_USER, 'https://evil.com/x', undefined)).rejects.toThrow();
    expect(kbService.ingestUrl).not.toHaveBeenCalled();
  });

  it('ingestUrl() 400s on a lookalike host without calling the service', async () => {
    const kbService = { ingestUrl: jest.fn() };
    const controller = new KbController(kbService as any);

    await expect(controller.ingestUrl(TEST_USER, 'https://fakeonedrive.com/x', undefined)).rejects.toThrow();
    expect(kbService.ingestUrl).not.toHaveBeenCalled();
  });

  it('ingestUrl() delegates to the service on a valid sharepoint url, using the session userId', async () => {
    const ingestResult = { documentName: 'doc.pdf', driveitemId: 'drive-1', mimeType: null, sizeBytes: 10, chunksStored: 1, skippedUnchanged: false };
    const kbService = { ingestUrl: jest.fn().mockResolvedValue(ingestResult) };
    const controller = new KbController(kbService as any);

    const result = await controller.ingestUrl(TEST_USER, 'https://contoso.sharepoint.com/sites/s/doc.pdf', 'SRD');

    expect(kbService.ingestUrl).toHaveBeenCalledWith('https://contoso.sharepoint.com/sites/s/doc.pdf', TEST_USER.userId, 'SRD', null);
    expect(result).toBe(ingestResult);
  });

  it('ingestUrl() forwards retrievalMode to the service', async () => {
    const ingestResult = { documentName: 'standards.docx', driveitemId: 'drive-2', mimeType: null, sizeBytes: 10, chunksStored: 1, skippedUnchanged: false };
    const kbService = { ingestUrl: jest.fn().mockResolvedValue(ingestResult) };
    const controller = new KbController(kbService as any);

    await controller.ingestUrl(TEST_USER, 'https://contoso.sharepoint.com/sites/s/standards.docx', undefined, 'always_include');

    expect(kbService.ingestUrl).toHaveBeenCalledWith(
      'https://contoso.sharepoint.com/sites/s/standards.docx', TEST_USER.userId, null, 'always_include',
    );
  });

  it('ingestItem() forwards retrievalMode to the service', async () => {
    const ingestResult = { documentName: 'standards.docx', driveitemId: 'drive-3', mimeType: null, sizeBytes: 10, chunksStored: 1, skippedUnchanged: false, ingestedDocumentId: 'doc-1' };
    const kbService = { ingestItem: jest.fn().mockResolvedValue(ingestResult) };
    const controller = new KbController(kbService as any);

    await controller.ingestItem(TEST_USER, 'standards.docx', 'item-1', 'https://download.example/x', undefined, undefined, 'always_include');

    expect(kbService.ingestItem).toHaveBeenCalledWith(
      'standards.docx', 'item-1', 'https://download.example/x', 'standards.docx', TEST_USER.userId, null, 'always_include',
    );
  });

  it('ingestUrl() accepts a 1drv.ms short link', async () => {
    const ingestResult = { documentName: 'doc.pdf', driveitemId: 'drive-1', mimeType: null, sizeBytes: 10, chunksStored: 1, skippedUnchanged: false };
    const kbService = { ingestUrl: jest.fn().mockResolvedValue(ingestResult) };
    const controller = new KbController(kbService as any);

    const result = await controller.ingestUrl(TEST_USER, 'https://1drv.ms/w/s!AbCdEf', undefined);

    expect(kbService.ingestUrl).toHaveBeenCalledWith('https://1drv.ms/w/s!AbCdEf', TEST_USER.userId, null, null);
    expect(result).toBe(ingestResult);
  });

  it('ingestUrl() re-maps an IngestionHttpError from the service to an HttpException with the same status', async () => {
    const kbService = { ingestUrl: jest.fn().mockRejectedValue(new IngestionHttpError(404, 'not found')) };
    const controller = new KbController(kbService as any);

    await expect(controller.ingestUrl(TEST_USER, 'https://contoso.sharepoint.com/x', undefined)).rejects.toThrow(HttpException);
    try {
      await controller.ingestUrl(TEST_USER, 'https://contoso.sharepoint.com/x', undefined);
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(404);
    }
  });

  it('ingestFolderUrl() 400s on a bad host without calling the service', async () => {
    const kbService = { ingestFolderUrl: jest.fn() };
    const controller = new KbController(kbService as any);

    await expect(controller.ingestFolderUrl(TEST_USER, 'https://evil.com/folder', undefined)).rejects.toThrow();
    expect(kbService.ingestFolderUrl).not.toHaveBeenCalled();
  });

  it('ingestFolderUrl() delegates to the service on a valid sharepoint folder url', async () => {
    const folderResult = { files: [{ file: 'a.docx', status: 'ingested', chunksStored: 1, driveitemId: 'drive-a', mimeType: null, sizeBytes: 10, reason: null }] };
    const kbService = { ingestFolderUrl: jest.fn().mockResolvedValue(folderResult) };
    const controller = new KbController(kbService as any);

    const result = await controller.ingestFolderUrl(TEST_USER, 'https://contoso.sharepoint.com/sites/s/folder', 'SRD', undefined);

    expect(kbService.ingestFolderUrl).toHaveBeenCalledWith('https://contoso.sharepoint.com/sites/s/folder', TEST_USER.userId, 'SRD', false);
    expect(result).toBe(folderResult);
  });

  it('ingestFolderUrl() forwards the recursive flag to the service, defaulting to false', async () => {
    const kbService = { ingestFolderUrl: jest.fn().mockResolvedValue({ files: [] }) };
    const controller = new KbController(kbService as any);

    await controller.ingestFolderUrl(TEST_USER, 'https://contoso.sharepoint.com/folder', undefined, true);
    expect(kbService.ingestFolderUrl).toHaveBeenCalledWith('https://contoso.sharepoint.com/folder', TEST_USER.userId, null, true);

    await controller.ingestFolderUrl(TEST_USER, 'https://contoso.sharepoint.com/folder', undefined, undefined);
    expect(kbService.ingestFolderUrl).toHaveBeenCalledWith('https://contoso.sharepoint.com/folder', TEST_USER.userId, null, false);
  });

  it('ingestFolderUrl() re-maps an IngestionHttpError from the service to an HttpException with the same status', async () => {
    const kbService = { ingestFolderUrl: jest.fn().mockRejectedValue(new IngestionHttpError(403, 'forbidden')) };
    const controller = new KbController(kbService as any);

    try {
      await controller.ingestFolderUrl(TEST_USER, 'https://contoso.sharepoint.com/folder', undefined);
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(403);
    }
  });

  it('re-maps a downstream 401 (SharePoint/Graph token expired) to 424, never a bare 401', async () => {
    // Regression guard for a confirmed real bug (user-reported: "why am I
    // getting logged out when I try to access the Knowledge Base page?"):
    // a real, expected SharePoint-token expiry (~1h TTL) previously reached
    // the frontend as a bare 401 -- indistinguishable from the
    // orchestrator's OWN session guard rejecting the request, which
    // httpClient.ts's global interceptor treats as "log the user out of
    // the whole app." A 401 from THIS controller must always mean "a
    // downstream dependency's token expired," never "your session died" --
    // only the global AuthGuard's own 401 may mean that. Exercised across
    // every route that proxies a real SharePoint/Graph call.
    const routes: [string, any][] = [
      ['ingestUrl', { ingestUrl: jest.fn().mockRejectedValue(new IngestionHttpError(401, 'unauthorized')) }],
      ['ingestFolderUrl', { ingestFolderUrl: jest.fn().mockRejectedValue(new IngestionHttpError(401, 'unauthorized')) }],
      ['browseFolder', { browseFolder: jest.fn().mockRejectedValue(new IngestionHttpError(401, 'unauthorized')) }],
    ];
    for (const [method, kbService] of routes) {
      const controller = new KbController(kbService);
      try {
        if (method === 'ingestUrl') await controller.ingestUrl(TEST_USER, 'https://contoso.sharepoint.com/x', undefined);
        else if (method === 'ingestFolderUrl') await controller.ingestFolderUrl(TEST_USER, 'https://contoso.sharepoint.com/folder', undefined);
        else await controller.browseFolder(TEST_USER, 'https://contoso.sharepoint.com/folder', undefined);
        fail(`expected ${method} to throw`);
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(424);
      }
    }
  });

  it('listDocuments() delegates to the service using the session userId, never a client-supplied one', async () => {
    const documents = [{ id: 'doc-1' }];
    const kbService = { listDocuments: jest.fn().mockResolvedValue(documents) };
    const controller = new KbController(kbService as any);

    const result = await controller.listDocuments(TEST_USER);

    expect(kbService.listDocuments).toHaveBeenCalledWith(TEST_USER.userId);
    expect(result).toBe(documents);
  });

  it('sharePointStatus() delegates to the service', async () => {
    const status = { status: 'valid', expiresInSeconds: 2820 };
    const kbService = { getSharePointStatus: jest.fn().mockResolvedValue(status) };
    const controller = new KbController(kbService as any);

    const result = await controller.sharePointStatus();

    expect(kbService.getSharePointStatus).toHaveBeenCalled();
    expect(result).toBe(status);
  });

  it('reconnectSharePoint() 400s when token is missing', async () => {
    const controller = new KbController({} as any);
    await expect(controller.reconnectSharePoint(TEST_USER, undefined)).rejects.toThrow(/token/i);
  });

  it('reconnectSharePoint() delegates to the service with the pasted token and the session userId', async () => {
    const status = { status: 'valid', expiresInSeconds: 3600 };
    const kbService = { reconnectSharePointToken: jest.fn().mockResolvedValue(status) };
    const controller = new KbController(kbService as any);

    const result = await controller.reconnectSharePoint(TEST_USER, 'new-token');

    expect(kbService.reconnectSharePointToken).toHaveBeenCalledWith('new-token', TEST_USER.userId);
    expect(result).toBe(status);
  });
});
