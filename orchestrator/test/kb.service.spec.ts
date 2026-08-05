import { KbService } from '../src/modules/kb/kb.service';

const fakeCredentialVault = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), delete: jest.fn(), has: jest.fn() };

describe('KbService', () => {
  it('ingestUrl() calls the ingestion client and upserts an IngestedDocument, returning the ingest result', async () => {
    const ingestResult = {
      documentName: 'doc.pdf',
      driveitemId: 'drive-1',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      chunksStored: 3,
      skippedUnchanged: false,
    };
    const ingestionClient = { ingestUrl: jest.fn().mockResolvedValue(ingestResult) };
    const prisma = { ingestedDocument: { upsert: jest.fn().mockResolvedValue(undefined) } };
    const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

    const result = await service.ingestUrl('https://contoso.sharepoint.com/x', 'Project\\Area1', 'SRD');

    expect(ingestionClient.ingestUrl).toHaveBeenCalledWith('https://contoso.sharepoint.com/x', 'Project\\Area1', 'SRD', null, null);
    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith({
      where: { userId_driveItemId: { userId: 'Project\\Area1', driveItemId: 'drive-1' } },
      create: { userId: 'Project\\Area1', driveItemId: 'drive-1', name: 'doc.pdf', sizeBytes: 1024, mimeType: 'application/pdf', docType: 'SRD', retrievalMode: null },
      update: { name: 'doc.pdf', sizeBytes: 1024, mimeType: 'application/pdf', docType: 'SRD', retrievalMode: null, ingestedAt: expect.any(Date) },
    });
    expect(result).toEqual(ingestResult);
  });

  it('ingestUrl() forwards retrievalMode to the ingestion client and persists it', async () => {
    const ingestResult = {
      documentName: 'standards.docx',
      driveitemId: 'drive-2',
      mimeType: 'application/pdf',
      sizeBytes: 512,
      chunksStored: 1,
      skippedUnchanged: false,
    };
    const ingestionClient = { ingestUrl: jest.fn().mockResolvedValue(ingestResult) };
    const prisma = { ingestedDocument: { upsert: jest.fn().mockResolvedValue(undefined) } };
    const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

    await service.ingestUrl('https://contoso.sharepoint.com/x', 'Project\\Area1', null, 'always_include');

    expect(ingestionClient.ingestUrl).toHaveBeenCalledWith('https://contoso.sharepoint.com/x', 'Project\\Area1', null, null, 'always_include');
    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ retrievalMode: 'always_include' }),
        update: expect.objectContaining({ retrievalMode: 'always_include' }),
      }),
    );
  });

  it('listDocuments() filters by userId when provided', async () => {
    const prisma = { ingestedDocument: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new KbService(prisma as any, {} as any, fakeCredentialVault as any);

    await service.listDocuments('Project\\Area1');

    expect(prisma.ingestedDocument.findMany).toHaveBeenCalledWith({ where: { userId: 'Project\\Area1' }, orderBy: { ingestedAt: 'desc' } });
  });

  it('listDocuments() returns all documents ordered newest-first when userId is omitted', async () => {
    const prisma = { ingestedDocument: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new KbService(prisma as any, {} as any, fakeCredentialVault as any);

    await service.listDocuments();

    expect(prisma.ingestedDocument.findMany).toHaveBeenCalledWith({ where: {}, orderBy: { ingestedAt: 'desc' } });
  });

  it('ingestFolderUrl() persists a row per ingested/skipped file and skips failed ones', async () => {
    const folderResult = {
      files: [
        { file: 'a.docx', status: 'ingested', chunksStored: 2, driveitemId: 'drive-a', mimeType: 'application/a', sizeBytes: 100, reason: null },
        { file: 'b.docx', status: 'skipped_unchanged', chunksStored: 0, driveitemId: 'drive-b', mimeType: 'application/b', sizeBytes: 200, reason: null },
        { file: 'bad.docx', status: 'failed', chunksStored: 0, driveitemId: null, mimeType: null, sizeBytes: null, reason: 'corrupt' },
      ],
    };
    const ingestionClient = { ingestFolderUrl: jest.fn().mockResolvedValue(folderResult) };
    const prisma = { ingestedDocument: { upsert: jest.fn().mockResolvedValue(undefined) } };
    const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

    const result = await service.ingestFolderUrl('https://contoso.sharepoint.com/folder', 'Project\\Area1', 'SRD');

    expect(ingestionClient.ingestFolderUrl).toHaveBeenCalledWith('https://contoso.sharepoint.com/folder', 'Project\\Area1', 'SRD', false, null);
    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_driveItemId: { userId: 'Project\\Area1', driveItemId: 'drive-a' } } }),
    );
    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_driveItemId: { userId: 'Project\\Area1', driveItemId: 'drive-b' } } }),
    );
    expect(result).toEqual(folderResult);
  });

  it('ingestFolderUrl() forwards recursive to the ingestion client and persists relativePath as the document name', async () => {
    const folderResult = {
      files: [
        { file: 'nested.docx', status: 'ingested', chunksStored: 1, driveitemId: 'drive-n', mimeType: 'application/n', sizeBytes: 50, reason: null, relativePath: 'Sub/nested.docx' },
      ],
    };
    const ingestionClient = { ingestFolderUrl: jest.fn().mockResolvedValue(folderResult) };
    const prisma = { ingestedDocument: { upsert: jest.fn().mockResolvedValue(undefined) } };
    const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

    await service.ingestFolderUrl('https://contoso.sharepoint.com/folder', 'Project\\Area1', 'SRD', true);

    expect(ingestionClient.ingestFolderUrl).toHaveBeenCalledWith('https://contoso.sharepoint.com/folder', 'Project\\Area1', 'SRD', true, null);
    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ name: 'Sub/nested.docx' }) }),
    );
  });

  it("ingestFolderUrl() does not let one file's DB-persist rejection fail the whole batch", async () => {
    const folderResult = {
      files: [
        { file: 'a.docx', status: 'ingested', chunksStored: 2, driveitemId: 'drive-a', mimeType: 'application/a', sizeBytes: 100, reason: null },
        { file: 'b.docx', status: 'ingested', chunksStored: 1, driveitemId: 'drive-b', mimeType: 'application/b', sizeBytes: 200, reason: null },
      ],
    };
    const ingestionClient = { ingestFolderUrl: jest.fn().mockResolvedValue(folderResult) };
    const prisma = {
      ingestedDocument: {
        upsert: jest
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('db unavailable')),
      },
    };
    const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

    const result = await service.ingestFolderUrl('https://contoso.sharepoint.com/folder', 'Project\\Area1', 'SRD');

    expect(result.files.find((f) => f.file === 'a.docx')).toEqual(
      expect.objectContaining({ status: 'ingested' }),
    );
    expect(result.files.find((f) => f.file === 'b.docx')).toEqual(
      expect.objectContaining({ status: 'failed', reason: expect.stringContaining('db unavailable') }),
    );
  });

  it('getSharePointStatus() checks the vaulted override token when one has been rotated', async () => {
    const vaulted = JSON.stringify({ token: 'vaulted-tok', rotatedByUserId: 'user-1', rotatedAt: '2026-01-01T00:00:00.000Z' });
    const ingestionClient = { getSharePointStatus: jest.fn().mockResolvedValue({ status: 'valid', expiresInSeconds: 3600 }) };
    const credentialVault = { get: jest.fn().mockResolvedValue(vaulted) };
    const service = new KbService({} as any, ingestionClient as any, credentialVault as any);

    const result = await service.getSharePointStatus();

    expect(credentialVault.get).toHaveBeenCalledWith('shared', 'sharepoint_token');
    expect(ingestionClient.getSharePointStatus).toHaveBeenCalledWith('vaulted-tok');
    expect(result).toEqual({ status: 'valid', expiresInSeconds: 3600 });
  });

  it('getSharePointStatus() falls back to no override when nothing has been rotated yet', async () => {
    const ingestionClient = { getSharePointStatus: jest.fn().mockResolvedValue({ status: 'not_configured', expiresInSeconds: null }) };
    const credentialVault = { get: jest.fn().mockResolvedValue(null) };
    const service = new KbService({} as any, ingestionClient as any, credentialVault as any);

    await service.getSharePointStatus();

    expect(ingestionClient.getSharePointStatus).toHaveBeenCalledWith(null);
  });

  it('reconnectSharePointToken() validates before vaulting -- an invalid token is never stored', async () => {
    const ingestionClient = { getSharePointStatus: jest.fn().mockResolvedValue({ status: 'invalid', expiresInSeconds: null }) };
    const credentialVault = { get: jest.fn(), set: jest.fn() };
    const service = new KbService({} as any, ingestionClient as any, credentialVault as any);

    const result = await service.reconnectSharePointToken('bad-token', 'user-1');

    expect(ingestionClient.getSharePointStatus).toHaveBeenCalledWith('bad-token');
    expect(credentialVault.set).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'invalid', expiresInSeconds: null });
  });

  it('reconnectSharePointToken() vaults the token with rotation attribution when valid', async () => {
    const ingestionClient = { getSharePointStatus: jest.fn().mockResolvedValue({ status: 'valid', expiresInSeconds: 3600 }) };
    const credentialVault = { get: jest.fn(), set: jest.fn().mockResolvedValue(undefined) };
    const service = new KbService({} as any, ingestionClient as any, credentialVault as any);

    await service.reconnectSharePointToken('good-token', 'user-1');

    expect(credentialVault.set).toHaveBeenCalledWith(
      'shared',
      'sharepoint_token',
      expect.stringContaining('"token":"good-token"'),
    );
    expect(credentialVault.set).toHaveBeenCalledWith('shared', 'sharepoint_token', expect.stringContaining('"rotatedByUserId":"user-1"'));
  });
});
